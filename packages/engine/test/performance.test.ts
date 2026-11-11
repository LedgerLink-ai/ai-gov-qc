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

describe('performance', () => {
  it('runs the native checks on 2,000 changed files within 10 seconds', async () => {
    const started = Date.now();
    const result = await run(options(many(2000)));
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('answers an unchanged re-run of a slow scanner from the cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-perf-cache-'));
    const slow: ToolAdapter = {
      name: 'fake-slow',
      available: () => true,
      version: () => '1.0.0',
      rulesHash: () => 'r',
      run: async () => {
        await new Promise((r) => setTimeout(r, 1500));
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
      await run(options(files, { config: cfg, exclude: [], mode: 'local', cache: openCache(dir) }));
      const started = Date.now();
      const warm = await run(options(files, { config: cfg, exclude: [], mode: 'local', cache: openCache(dir) }));
      expect(Date.now() - started).toBeLessThan(1500);
      expect(warm.checkRuns[0].cachedFiles).toBe(200);
    } finally {
      delete TOOL_ADAPTERS['fake-slow'];
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
