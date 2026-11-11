import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_ADAPTERS, type ToolAdapter } from '../src/adapters/tools';
import { openCache } from '../src/cache';
import { ToolTimeoutError } from '../src/exec';
import { failedValidations, profiles, toEvidence } from '../src/report';
import { run } from '../src/runner';
import type { CheckDefinition, Config, Finding } from '../src/types';
import { ToolUnavailableError } from '../src/types';
import { config, options } from './helpers';

// A scanner double: returns one error finding per file containing "BAD", after a delay.
let calls: string[][] = [];
function fakeAdapter(
  name: string,
  opts: { delayMs?: number; behaviour?: 'ok' | 'timeout' | 'missing' } = {},
): ToolAdapter {
  return {
    name,
    available: () => opts.behaviour !== 'missing',
    version: () => (opts.behaviour === 'missing' ? undefined : '1.0.0'),
    rulesHash: () => 'rules-v1',
    async run(ctx, def, files): Promise<Finding[]> {
      if (opts.behaviour === 'missing') throw new ToolUnavailableError(name, 'not installed');
      if (opts.behaviour === 'timeout') throw new ToolTimeoutError(name, ctx.timeoutFor(def));
      calls.push(files.map((f) => f.path));
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
      return files
        .filter((f) => ctx.source.read(f.path)?.includes('BAD'))
        .map((f) => ({
          checkId: def.id,
          ruleId: 'bad',
          level: 'error' as const,
          path: f.path,
          line: 1,
          message: 'bad',
        }));
    },
  };
}

function toolDef(id: string, tool: string, stage: 0 | 1 | 2 | 3 = 1): CheckDefinition {
  return { id, title: id, kind: 'tool', tool, stage, scope: 'file', tags: 'all', controls: ['C14-4'], rules: [] };
}

function withChecks(defs: CheckDefinition[]): Config {
  const base = config();
  const checks: Config['policy']['checks'] = {};
  for (const d of defs) checks[d.id] = { mode: 'block' };
  return { ...base, checks: defs, policy: { ...base.policy, checks } };
}

beforeEach(() => {
  calls = [];
  delete TOOL_ADAPTERS['fake-a'];
  delete TOOL_ADAPTERS['fake-b'];
});
afterAll(() => {
  delete TOOL_ADAPTERS['fake-a'];
  delete TOOL_ADAPTERS['fake-b'];
});

const files = { 'src/a.ts': 'BAD\n', 'src/b.ts': 'fine\n', 'src/c.ts': 'BAD again\n' };

describe('time limits', () => {
  it('defers a scanner that timed out to CI locally', async () => {
    TOOL_ADAPTERS['fake-a'] = fakeAdapter('fake-a', { behaviour: 'timeout' });
    const result = await run(
      options(files, { config: withChecks([toolDef('t.a', 'fake-a')]), mode: 'local', exclude: [] }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.checkRuns[0]).toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/did not finish.*runs in CI$/),
    });
  });

  it('fails closed in CI: a scanner that timed out is an engine error, never a pass', async () => {
    TOOL_ADAPTERS['fake-a'] = fakeAdapter('fake-a', { behaviour: 'timeout' });
    const result = await run(options(files, { config: withChecks([toolDef('t.a', 'fake-a')]), exclude: [] }));
    expect(result.exitCode).toBe(2);
    expect(result.engineErrors[0]).toMatch(/^t\.a: fake-a did not finish within/);
  });

  it('takes the limit from the caller, then policy.yaml per tool, then the default', () => {
    const cfg = withChecks([toolDef('t.a', 'fake-a')]);
    cfg.policy = { ...cfg.policy, timeouts: { tool_ms: 1000, tools: { 'fake-a': 2000 } } };
    let seen: number[] = [];
    TOOL_ADAPTERS['fake-a'] = {
      ...fakeAdapter('fake-a'),
      run: (ctx, def) => {
        seen.push(ctx.timeoutFor(def));
        return [];
      },
    };
    return run(options(files, { config: cfg, exclude: [] }))
      .then(() => run(options(files, { config: cfg, exclude: [], toolTimeoutMs: 3000 })))
      .then(() => {
        expect(seen).toEqual([2000, 3000]);
        seen = [];
      });
  });
});

describe('parallel checks', () => {
  it('give the same, ordered result whatever order checks finish in', async () => {
    TOOL_ADAPTERS['fake-a'] = fakeAdapter('fake-a', { delayMs: 150 });
    TOOL_ADAPTERS['fake-b'] = fakeAdapter('fake-b', { delayMs: 0 });
    const cfg = withChecks([toolDef('t.a', 'fake-a'), toolDef('t.b', 'fake-b')]);
    const serial = await run(options(files, { config: cfg, exclude: [], parallelism: 1 }));
    const parallel = await run(options(files, { config: cfg, exclude: [], parallelism: 4 }));
    const view = (r: typeof serial) => ({
      checks: r.checkRuns.map((c) => [c.checkId, c.status, c.findings]),
      findings: r.findings.map((f) => [f.checkId, f.path, f.fingerprint]),
      exit: r.exitCode,
    });
    expect(view(parallel)).toEqual(view(serial));
    expect(parallel.checkRuns.map((c) => c.checkId)).toEqual(['t.a', 't.b']);
    expect(parallel.findings.map((f) => `${f.checkId} ${f.path}`)).toEqual([
      't.a src/a.ts',
      't.a src/c.ts',
      't.b src/a.ts',
      't.b src/c.ts',
    ]);
  });

  it('run the checks of one stage at the same time', async () => {
    TOOL_ADAPTERS['fake-a'] = fakeAdapter('fake-a', { delayMs: 800 });
    TOOL_ADAPTERS['fake-b'] = fakeAdapter('fake-b', { delayMs: 800 });
    const cfg = withChecks([toolDef('t.a', 'fake-a'), toolDef('t.b', 'fake-b')]);
    const started = Date.now();
    await run(options(files, { config: cfg, exclude: [], parallelism: 2 }));
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('still stop at a stage with blocking findings (P2)', async () => {
    TOOL_ADAPTERS['fake-a'] = fakeAdapter('fake-a');
    TOOL_ADAPTERS['fake-b'] = fakeAdapter('fake-b');
    const cfg = withChecks([toolDef('t.a', 'fake-a', 1), toolDef('t.b', 'fake-b', 2)]);
    const result = await run(options(files, { config: cfg, exclude: [], parallelism: 4 }));
    expect(result.checkRuns[1]).toMatchObject({
      checkId: 't.b',
      status: 'skipped',
      reason: expect.stringMatching(/P2/),
    });
  });
});

describe('result cache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-cache-test-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('scans only changed content again, with identical results', async () => {
    TOOL_ADAPTERS['fake-a'] = fakeAdapter('fake-a');
    const cfg = withChecks([toolDef('t.a', 'fake-a')]);
    const first = await run(options(files, { config: cfg, exclude: [], mode: 'local', cache: openCache(dir) }));
    const second = await run(options(files, { config: cfg, exclude: [], mode: 'local', cache: openCache(dir) }));
    expect(calls).toEqual([['src/a.ts', 'src/b.ts', 'src/c.ts']]);
    expect(second.checkRuns[0].cachedFiles).toBe(3);
    expect(second.findings.map((f) => f.fingerprint)).toEqual(first.findings.map((f) => f.fingerprint));
    expect(second.exitCode).toBe(first.exitCode);

    const edited = { ...files, 'src/b.ts': 'now BAD\n' };
    const third = await run(options(edited, { config: cfg, exclude: [], mode: 'local', cache: openCache(dir) }));
    expect(calls[1]).toEqual(['src/b.ts']);
    expect(third.findings).toHaveLength(3);
  });

  it('misses when the scanner version or rules change', async () => {
    TOOL_ADAPTERS['fake-a'] = fakeAdapter('fake-a');
    const cfg = withChecks([toolDef('t.a', 'fake-a')]);
    await run(options(files, { config: cfg, exclude: [], mode: 'local', cache: openCache(dir) }));
    TOOL_ADAPTERS['fake-a'] = { ...fakeAdapter('fake-a'), rulesHash: () => 'rules-v2' };
    await run(options(files, { config: cfg, exclude: [], mode: 'local', cache: openCache(dir) }));
    expect(calls).toHaveLength(2);
  });
});

describe('evidence', () => {
  it('records the engine version, profiles, check modes and failed validations', async () => {
    TOOL_ADAPTERS['fake-a'] = fakeAdapter('fake-a');
    const result = await run(options(files, { config: withChecks([toolDef('t.a', 'fake-a')]), exclude: [] }));
    const evidence = toEvidence(result, { runId: 'r-1' }) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      schema: 'ledgerlink-qa/evidence/v1',
      engine_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      run_id: 'r-1',
      exit_code: 1,
      summary: { blocking: 2, checks_failed: 1 },
      checks: [{ id: 't.a', status: 'failed', mode: 'block', tool_version: '1.0.0' }],
    });
    expect(profiles(result)).toEqual({
      tags: result.tags,
      stages: [0, 1, 2, 3],
      enabled_checks: [{ id: 't.a', mode: 'block', ran: true }],
    });
    expect(failedValidations(result)).toEqual([
      expect.objectContaining({ kind: 'finding', check: 't.a', path: 'src/a.ts' }),
      expect.objectContaining({ kind: 'finding', check: 't.a', path: 'src/c.ts' }),
    ]);
  });

  it('records a check that could not run as a failed validation', async () => {
    TOOL_ADAPTERS['fake-a'] = fakeAdapter('fake-a', { behaviour: 'missing' });
    const result = await run(options(files, { config: withChecks([toolDef('t.a', 'fake-a')]), exclude: [] }));
    expect(failedValidations(result)).toEqual([
      { kind: 'engine-error', check: 't.a', reason: expect.stringMatching(/not available/) },
    ]);
  });
});
