import { join } from 'node:path';
import { conformExitCode, runConformance, type FixtureResult } from '../src/conform';
import { CONFIG_DIR, config } from './helpers';

describe('conformance fixtures (api path)', () => {
  it('every runnable fixture passes; skips and pendings carry a reason, and none are skipped in CI', async () => {
    const results = await runConformance(config(), join(CONFIG_DIR, 'conformance', 'fixtures'));
    expect(results.length).toBeGreaterThanOrEqual(25);
    const failures = results.filter((r) => r.status === 'fail').map((r) => `${r.id}: ${r.reasons.join('; ')}`);
    expect(failures).toEqual([]);
    const notRun = results.filter((x) => x.status === 'skip' || x.status === 'pending');
    for (const r of notRun) expect(r.reasons.length).toBeGreaterThan(0);
    // CI installs every scanner (qa setup) before the tests, so nothing may be skipped there.
    if (process.env.CI) expect(notRun.map((r) => `${r.id}: ${r.reasons.join('; ')}`)).toEqual([]);
  }, 600000);
});

describe('qa conform exit code', () => {
  const result = (status: FixtureResult['status']): FixtureResult => ({
    id: 'F99',
    title: 't',
    status,
    reasons: status === 'pass' ? [] : ['why'],
    paths: [],
  });

  it('fails on a failed fixture; with --require-all also on a skipped or pending one', () => {
    expect(conformExitCode([result('pass')])).toBe(0);
    expect(conformExitCode([result('pass'), result('fail')])).toBe(1);
    expect(conformExitCode([result('pass'), result('skip'), result('pending')])).toBe(0);
    expect(conformExitCode([result('pass'), result('skip')], true)).toBe(1);
    expect(conformExitCode([result('pass'), result('pending')], true)).toBe(1);
    expect(conformExitCode([result('pass')], true)).toBe(0);
  });
});
