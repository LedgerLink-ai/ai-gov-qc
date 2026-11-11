import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assertPackageName, windowsCommandLine } from '../src/cli';
import { configSourceProblem, isWithin } from '../src/gate';
import { assertSafeUrl } from '../src/net';
import { parseBaseline } from '../src/report';
import { requirementProblems } from '../src/setup';
import { assertRef } from '../src/sources';
import { CONFIG_DIR, config } from './helpers';

describe('configuration trust (never the repository being checked)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'qa-trust-'));
  const outside = mkdtempSync(join(tmpdir(), 'qa-trust-config-'));
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses --config or QA_CONFIG_DIR inside the repository', () => {
    mkdirSync(join(repo, '.qa-config'), { recursive: true });
    expect(configSourceProblem({ dir: join(repo, '.qa-config'), origin: 'flag' }, repo, {})).toMatch(
      /--config points inside the repository/,
    );
    expect(configSourceProblem({ dir: repo, origin: 'env' }, repo, {})).toMatch(/QA_CONFIG_DIR points inside/);
  });

  it('refuses any --config or QA_CONFIG_DIR in GitHub Actions', () => {
    expect(configSourceProblem({ dir: outside, origin: 'flag' }, repo, { GITHUB_ACTIONS: 'true' })).toMatch(
      /not accepted in GitHub Actions/,
    );
  });

  it('accepts the configuration released with qa, and an outside directory locally', () => {
    expect(configSourceProblem({ dir: outside, origin: 'bundled' }, repo, { GITHUB_ACTIONS: 'true' })).toBeUndefined();
    expect(configSourceProblem({ dir: outside, origin: 'flag' }, repo, {})).toBeUndefined();
  });

  it('compares real paths, so a different spelling of the same folder is still inside', () => {
    expect(isWithin(join(repo, 'a', '..', 'b'), repo)).toBe(true);
    expect(isWithin(outside, repo)).toBe(false);
  });
});

describe('command injection', () => {
  it('accepts plain git revisions and refuses option-like or odd ones', () => {
    for (const ok of ['main', 'origin/main', 'v1.2.3', 'HEAD~2', 'HEAD^', '@{upstream}', 'a'.repeat(40)])
      expect(assertRef(ok)).toBe(ok);
    for (const bad of ['--output=/tmp/x', '-c', 'main..evil', 'a b', 'main;rm', 'x\ny', '$(id)', ''])
      expect(() => assertRef(bad)).toThrow(/not a plain git revision/);
  });

  it('refuses package and executable names that could be paths or options', () => {
    expect(() => assertPackageName('eslint', 'eslint')).not.toThrow();
    expect(() => assertPackageName('@scope/pkg', 'tsc')).not.toThrow();
    for (const [pkg, bin] of [
      ['../../evil', 'x'],
      ['--require=evil', 'x'],
      ['eslint', '../x'],
      ['/abs/path', 'x'],
    ])
      expect(() => assertPackageName(pkg, bin)).toThrow();
  });

  it('builds cmd.exe command lines that cannot run anything else', () => {
    expect(windowsCommandLine(['npm', 'run', 'test', '--', '--watch=false'])).toBe('npm run test -- --watch=false');
    expect(windowsCommandLine(['yarn', 'run', 'a & calc'])).toBe('yarn run "a & calc"');
    expect(windowsCommandLine(['npm', 'run', 'x|y>z'])).toBe('npm run "x|y>z"');
    for (const bad of ['%PATH%', '!x!', 'a"b', 'a\nb'])
      expect(() => windowsCommandLine(['npm', bad])).toThrow(/cmd.exe/);
  });
});

describe('downloads and reporting endpoints', () => {
  it('use https only, or http to this machine, and never carry credentials in the URL', () => {
    expect(assertSafeUrl('https://github.com/x', 'u')).toBe('https://github.com/x');
    expect(assertSafeUrl('http://127.0.0.1:8080/r', 'u')).toBe('http://127.0.0.1:8080/r');
    expect(() => assertSafeUrl('http://mirror.example.com/x', 'u')).toThrow(/https/);
    expect(() => assertSafeUrl('file:///etc/passwd', 'u')).toThrow(/https/);
    expect(() => assertSafeUrl('https://user:pw@example.com/x', 'u')).toThrow(/user name or password/);
  });
});

describe('the baseline', () => {
  it('must be SARIF written by qa baseline; anything else is an error, not an empty baseline', () => {
    expect(() => parseBaseline('not json')).toThrow(/not valid JSON/);
    expect(() => parseBaseline('{"version":"2.1.0"}')).toThrow(/SARIF 2.1.0/);
    expect(() =>
      parseBaseline(JSON.stringify({ version: '2.1.0', runs: [{ results: [{ partialFingerprints: {} }] }] })),
    ).toThrow(/fingerprint/);
    const fp = 'a'.repeat(32);
    expect(
      parseBaseline(
        JSON.stringify({
          version: '2.1.0',
          runs: [{ results: [{ partialFingerprints: { 'qaFingerprint/v1': fp } }] }],
        }),
      ),
    ).toEqual(new Set([fp]));
  });

  it('is a protected path, like the hook configuration', () => {
    const globs = config().policy.protected.globs;
    for (const p of ['.qa/baseline.sarif', '.pre-commit-config.yaml', '.husky/**']) expect(globs).toContain(p);
  });
});

describe('pinned dependencies and hook versions', () => {
  const workflowsDir = join(CONFIG_DIR, '.github', 'workflows');

  it('every GitHub Action is pinned to a full commit SHA', () => {
    for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
      const text = readFileSync(join(workflowsDir, file), 'utf8');
      for (const m of text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
        const ref = m[1];
        if (ref.startsWith('./')) continue;
        expect({ file, ref, pinned: /@[0-9a-f]{40}$/.test(ref) }).toEqual({ file, ref, pinned: true });
      }
    }
  });

  it('workflows default to read-only tokens and parse as YAML', () => {
    for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
      const wf = parseYaml(readFileSync(join(workflowsDir, file), 'utf8')) as { permissions?: unknown };
      expect({ file, permissions: wf.permissions }).toEqual({
        file,
        permissions: expect.anything(),
      });
      expect(JSON.stringify(wf.permissions)).not.toMatch(/write-all/);
    }
  });

  it('the hook template pins every hook repository by commit SHA', () => {
    const template = readFileSync(join(CONFIG_DIR, 'templates', 'pre-commit-config.yaml'), 'utf8');
    const revs = [...template.matchAll(/^\s*rev:\s*(\S+)/gm)].map((m) => m[1]);
    expect(revs.length).toBeGreaterThan(0);
    for (const rev of revs) expect(rev).toMatch(/^[0-9a-f]{40}$/);
  });

  it('every Python dependency qa setup installs is pinned and hashed, at the versions in policy.yaml', () => {
    const lock = readFileSync(join(CONFIG_DIR, 'config', 'python-requirements.txt'), 'utf8');
    expect(requirementProblems(lock, config().policy.tools ?? {})).toEqual([]);
    expect(requirementProblems(lock, { semgrep: '0.0.1' })).toEqual([
      'semgrep is 1.183.0 in python-requirements.txt, 0.0.1 in policy.yaml',
    ]);
    expect(requirementProblems('requests==1.0.0\n', {})).toEqual(['requests has no --hash']);
  });

  it('the Gitleaks download is checked against a checksum file kept in this repository', () => {
    const pin = config().policy.tools?.gitleaks as string;
    const sums = readFileSync(join(CONFIG_DIR, 'config', `gitleaks_${pin}_checksums.txt`), 'utf8');
    expect(sums).toMatch(/^[0-9a-f]{64}\s+gitleaks_/m);
  });
});

describe('the release check', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const release = require('../../../scripts/release.js') as {
    checkVersions: (v?: string) => string;
    changelogSection: (v: string, text?: string) => string | undefined;
  };

  it('passes for this repository: versions, template pins, workflow defaults and changelog agree', () => {
    const version = (JSON.parse(readFileSync(join(CONFIG_DIR, 'package.json'), 'utf8')) as { version: string }).version;
    expect(release.checkVersions()).toBe(version);
    expect(release.changelogSection(version)).toBeTruthy();
  });

  it('reads one changelog section', () => {
    const text = '# Changelog\n\n## 1.1.0\n\n- b\n\n## 1.0.0\n\n- a\n';
    expect(release.changelogSection('1.1.0', text)).toBe('- b');
    expect(release.changelogSection('1.0.0', text)).toBe('- a');
    expect(release.changelogSection('2.0.0', text)).toBeUndefined();
  });

  it('the repository never commits run output', () => {
    expect(readFileSync(join(CONFIG_DIR, '.gitignore'), 'utf8')).toMatch(/^\.qa\/out\/$/m);
  });
});
