import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onePerLine } from '../src/adapters/tools/gitleaks';
import { materialise, type Fixture } from '../src/conform';

// AIQC-89: credentials in any file. The rules themselves are exercised by
// conformance fixtures F17 (must be reported) and F18 (must not).

describe('one Gitleaks finding per line', () => {
  const r = (RuleID: string, StartLine = 1, File = 'a.env') => ({ RuleID, File, StartLine });

  it('keeps the specific rule over the general ones, whatever order Gitleaks reports in', () => {
    const results = [r('jwe-token'), r('aws-codeartifact-token'), r('credential-assignment-config')];
    for (const order of [results, [...results].reverse(), [results[2], results[0], results[1]]])
      expect(onePerLine(order).map((x) => x.RuleID)).toEqual(['aws-codeartifact-token']);
  });

  it('chooses among general rules the same way every time', () => {
    const results = [r('credential-in-connection-string'), r('credential-export'), r('generic-api-key')];
    expect(onePerLine(results).map((x) => x.RuleID)).toEqual(['credential-export']);
    expect(onePerLine([...results].reverse()).map((x) => x.RuleID)).toEqual(['credential-export']);
  });

  it('keeps findings on other lines and in other files, in a fixed order', () => {
    const out = onePerLine([r('generic-api-key', 3), r('credential-file', 0), r('github-pat', 1, 'b.ts')]);
    expect(out.map((x) => `${x.File}:${x.StartLine}:${x.RuleID}`)).toEqual([
      'a.env:0:credential-file',
      'a.env:3:generic-api-key',
      'b.ts:1:github-pat',
    ]);
  });
});

describe('generated fixture values', () => {
  let dir: string;
  let out: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-values-'));
    mkdirSync(join(dir, 'tree'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (out) rmSync(out, { recursive: true, force: true });
  });

  const render = (values: Fixture['values'], text: string): string => {
    writeFileSync(join(dir, 'tree', 'f.txt.tmpl'), text);
    out = materialise(dir, { id: 'T', title: 't', repo: 'r', actor: 'human', values, expect: [] } as Fixture);
    return readFileSync(join(out, 'f.txt'), 'utf8');
  };

  it('are new on every run, with the requested shape', () => {
    const spec = {
      P: { random: 'password' as const, length: 16 },
      L: { random: 'letters' as const, length: 20 },
      J: { random: 'base64url' as const, prefix: 'eyJ', parts: [10, 0, 5] },
      H: { random: 'hex' as const, length: 64 },
    };
    const [p, j, h, l] = render(spec, '{{P}} {{J}} {{H}} {{L}}').split(' ');
    expect(l).toMatch(/^[B-DF-HJ-NP-TV-Zb-df-hj-np-tv-z]{20}$/);
    expect(p).toMatch(/^[0-9A-Za-z]{14}[!#%*~^][0-9]$/);
    expect(p).not.toMatch(/[aeiouxAEIOUX]/); // never spells test, fake, xxxx, ...
    expect(j).toMatch(/^eyJ[\w-]{10}\.\.[\w-]{5}$/);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(render(spec, '{{H}}')).not.toBe(h);
  });
});
