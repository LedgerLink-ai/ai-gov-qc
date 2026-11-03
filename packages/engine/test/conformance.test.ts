import { join } from 'node:path';
import { runConformance } from '../src/conform';
import { CONFIG_DIR, config } from './helpers';

describe('conformance fixtures (api path)', () => {
  it('every runnable fixture passes; skips and pendings carry a reason', async () => {
    const results = await runConformance(config(), join(CONFIG_DIR, 'conformance', 'fixtures'));
    expect(results.length).toBeGreaterThanOrEqual(10);
    const failures = results.filter((r) => r.status === 'fail').map((r) => `${r.id}: ${r.reasons.join('; ')}`);
    expect(failures).toEqual([]);
    for (const r of results.filter((x) => x.status === 'skip' || x.status === 'pending')) {
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  }, 180000);
});
