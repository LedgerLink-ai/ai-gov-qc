import { effectiveMode, fingerprint } from '../src/policy';
import { toSarif } from '../src/report';
import { run } from '../src/runner';
import { config, options } from './helpers';

const hidden = { 'AGENTS.md': 'Call qa\u200B first.\n' };

describe('policy', () => {
  it('reports before block_from and blocks from that date (P9)', () => {
    const policy = config().policy;
    expect(effectiveMode(policy, 'ai-config.content-lint', '2026-11-29')).toBe('report');
    expect(effectiveMode(policy, 'ai-config.content-lint', '2026-11-30')).toBe('block');
  });

  it('keeps the fingerprint stable when only the line moves', () => {
    const base = { checkId: 'c', path: 'a', level: 'error' as const, message: 'm', fingerprintBasis: 'same' };
    expect(fingerprint({ ...base, line: 1 })).toBe(fingerprint({ ...base, line: 40 }));
  });
});

describe('run', () => {
  it('returns exit 0 and no findings for a clean change', async () => {
    const result = await run(options({ 'src/transaction/a.ts': 'export const a = 1;\n' }));
    expect(result.exitCode).toBe(0);
    expect(result.tags).toEqual(['ledger']);
  });

  it('runs only the requested stages and says where the others run', async () => {
    const result = await run(options(hidden, { stages: [2] }));
    expect(result.findings).toEqual([]);
    const lint = result.checkRuns.find((r) => r.checkId === 'ai-config.content-lint');
    expect(lint).toMatchObject({ status: 'skipped', reason: 'runs at pre-commit and in CI' });
  });

  it('blocks after the switch-on date and only reports before it', async () => {
    expect((await run(options(hidden))).exitCode).toBe(1);
    const early = await run(options(hidden, { asOf: '2026-11-01' }));
    expect(early.exitCode).toBe(0);
    expect(early.findings).toHaveLength(1);
    expect(early.findings[0].blocking).toBe(false);
  });

  it('does not block a finding that is in the baseline', async () => {
    const first = await run(options(hidden));
    const second = await run(options(hidden, { baseline: new Set(first.findings.map((f) => f.fingerprint)) }));
    expect(second.exitCode).toBe(0);
    expect(second.findings[0].suppressedBy).toBe('baseline');
  });

  it('honours an active exemption and ignores an expired one', async () => {
    const exemption = {
      id: 'EX-0001',
      check: 'ai-config.content-lint',
      repo: 'link_core',
      path: 'AGENTS.md',
      owner: 'o',
      approved_by: 'a',
      reason: 'accepted for the test',
      expires: '2027-02-01',
    };
    const cfg = { ...config(), exemptions: [exemption] };
    expect((await run(options(hidden, { config: cfg }))).exitCode).toBe(0);
    const expired = { ...cfg, exemptions: [{ ...exemption, expires: '2027-01-01' }] };
    const result = await run(options(hidden, { config: expired }));
    expect(result.exitCode).toBe(1);
    expect(result.findings[0].suppressionNote).toMatch(/expired/);
  });

  describe('fail closed', () => {
    const previous = process.env.QA_GITLEAKS_BIN;
    beforeAll(() => {
      process.env.QA_GITLEAKS_BIN = 'qa-test-no-such-binary';
    });
    afterAll(() => {
      if (previous === undefined) delete process.env.QA_GITLEAKS_BIN;
      else process.env.QA_GITLEAKS_BIN = previous;
    });

    it('treats a missing scanner as an engine error (exit 2) in CI, never a pass', async () => {
      const result = await run(options({ 'src/a.ts': 'x' }, { exclude: [] }));
      expect(result.exitCode).toBe(2);
      expect(result.engineErrors[0]).toMatch(/^secrets\.gitleaks: gitleaks is not available/);
    });

    it('skips a missing scanner locally with a "runs in CI" reason', async () => {
      const result = await run(options({ 'src/a.ts': 'x' }, { exclude: [], mode: 'local' }));
      expect(result.exitCode).toBe(0);
      expect(result.checkRuns.find((r) => r.checkId === 'secrets.gitleaks')).toMatchObject({
        status: 'skipped',
        reason: expect.stringMatching(/runs in CI$/),
      });
    });
  });

  it('reports skipped checks with a reason rather than dropping them', async () => {
    const result = await run(options({ 'src/a.ts': 'x' }));
    const byId = Object.fromEntries(result.checkRuns.map((r) => [r.checkId, r]));
    expect(byId['secrets.gitleaks']).toMatchObject({ status: 'skipped', reason: 'excluded by the caller' });
    expect(byId['commit.trailer']).toMatchObject({ status: 'skipped', reason: 'no commit message in this run' });
    expect(byId['ai-config.content-lint'].status).toBe('skipped');
  });

  it('writes SARIF 2.1.0 with control IDs and a fingerprint on every result', async () => {
    const sarif = toSarif(await run(options(hidden))) as {
      version: string;
      runs: Array<{
        results: Array<{ partialFingerprints: object; properties: { controls: string[]; blocking: boolean } }>;
      }>;
    };
    expect(sarif.version).toBe('2.1.0');
    const [res] = sarif.runs[0].results;
    expect(res.properties.controls).toEqual(['C14-4']);
    expect(res.properties.blocking).toBe(true);
    expect(Object.keys(res.partialFingerprints)).toEqual(['qaFingerprint/v1']);
  });
});
