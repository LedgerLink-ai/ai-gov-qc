import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_ADAPTERS, type ToolAdapter } from '../src/adapters/tools';
import { openCache } from '../src/cache';
import { run } from '../src/runner';
import type { CheckDefinition, Config } from '../src/types';
import { config, options } from './helpers';

// Performance guards (docs/PERFORMANCE.md has the measured numbers). The
// limits are generous so a slow CI runner does not flake; they catch an
// accidental quadratic loop or a cache that stopped working.

function many(n: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    if (i % 10 === 9) files[`packages/p${i}/AGENTS.md`] = 'Run the tests before committing.\n'.repeat(5);
    else files[`src/transaction/m${i}.ts`] = `export const v${i} = ${i}n;\n`.repeat(40);
  }
  return files;
}

// QA_PERF_BUDGET_MS: the absolute cap for one run (default 30 s, generous for
// a loaded machine). It catches a runaway, not drift.
const budgetMs = Number(process.env.QA_PERF_BUDGET_MS) || 30_000;

describe('performance', () => {
  it(
    'runs the native checks on 2,000 changed files within the budget',
    async () => {
      const started = Date.now();
      const result = await run(options(many(2000)));
      expect(result.exitCode).toBe(0);
      expect(Date.now() - started).toBeLessThan(budgetMs);
    },
    3 * budgetMs,
  );

  // Wall-clock limits flake on a loaded machine (a warm re-run took 4.5 to 6.4 s
  // under load against a fixed 1.5 s), so the cache is judged by what it saves:
  // the scanner is not called again, and the warm run saves at least half of
  // the scanner's time against the cold run. Both runs pay the same machine
  // overhead, so this holds however loaded the machine is, and fails when the
  // cache stops working. The absolute cap (budgetMs) only catches a
  // runaway.
  it(
    'answers an unchanged re-run of a slow scanner from the cache',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qa-perf-cache-'));
      const scannerMs = 4000;
      let calls = 0;
      const slow: ToolAdapter = {
        name: 'fake-slow',
        available: () => true,
        version: () => '1.0.0',
        rulesHash: () => 'r',
        run: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, scannerMs));
          return [];
        },
      };
      TOOL_ADAPTERS['fake-slow'] = slow;
      try {
        const def: CheckDefinition = {
          id: 't.slow',
          title: 'slow',
          kind: 'tool',
          tool: 'fake-slow',
          stage: 1,
          scope: 'file',
          tags: 'all',
          controls: ['C14-4'],
          rules: [],
        };
        const cfg: Config = { ...config(), checks: [def] };
        const files = many(200);
        let started = Date.now();
        await run(options(files, { config: cfg, exclude: [], mode: 'local', cache: openCache(dir) }));
        const coldMs = Date.now() - started;
        started = Date.now();
        const warm = await run(options(files, { config: cfg, exclude: [], mode: 'local', cache: openCache(dir) }));
        const warmMs = Date.now() - started;
        expect(calls).toBe(1);
        expect(warm.checkRuns[0].cachedFiles).toBe(200);
        expect({ warmMs, coldMs, saved: coldMs - warmMs >= scannerMs / 2 }).toEqual({ warmMs, coldMs, saved: true });
        expect(warmMs).toBeLessThan(budgetMs);
      } finally {
        delete TOOL_ADAPTERS['fake-slow'];
        rmSync(dir, { recursive: true, force: true });
      }
    },
    3 * budgetMs + 60_000,
  );
});
