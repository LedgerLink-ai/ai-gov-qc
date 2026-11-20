import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assertPackageName, windowsCommandLine } from '../src/cli';
import { configSourceProblem, isWithin, realOrResolved } from '../src/gate';
import { windowsPathProgram } from '../src/tools-home';
import { assertSafeUrl } from '../src/net';
import { parseBaseline } from '../src/report';
import { requirementProblems } from '../src/setup';
import { removeIgnoreFiles as removeGitleaksIgnores } from '../src/adapters/tools/gitleaks';
import { removeIgnoreFiles as removeSemgrepIgnores } from '../src/adapters/tools/semgrep';
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

  it('resolves a path that does not exist yet through its nearest existing folder', () => {
    // macOS: tmpdir() is under /var, a link to /private/var; Windows runners: an 8.3 short name.
    const real = realOrResolved(repo);
    expect(realOrResolved(join(repo, 'not', 'yet'))).toBe(join(real, 'not', 'yet'));
    expect(isWithin(join(repo, 'not', 'yet'), realpathSync.native(repo))).toBe(true);
    expect(isWithin(join(outside, 'not', 'yet'), repo)).toBe(false);
  });
});

describe('finding tools on PATH on Windows', () => {
  const home = mkdtempSync(join(tmpdir(), 'qa-home-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('runs the program a "qa setup" launcher points to, since .cmd files need a shell', () => {
    mkdirSync(join(home, 'bin'), { recursive: true });
    mkdirSync(join(home, 'venv', 'Scripts'), { recursive: true });
    writeFileSync(join(home, 'bin', 'semgrep.cmd'), '@echo off\r\n');
    writeFileSync(join(home, 'venv', 'Scripts', 'semgrep.exe'), '');
    writeFileSync(join(home, 'bin', 'gitleaks.exe'), '');
    const path = [join(home, 'nothing-here'), join(home, 'bin')].join(delimiter);
    expect(windowsPathProgram('semgrep', path)).toBe(join(home, 'venv', 'Scripts', 'semgrep.exe'));
    expect(windowsPathProgram('gitleaks', path)).toBe(join(home, 'bin', 'gitleaks.exe'));
    expect(windowsPathProgram('pre-commit', path)).toBeUndefined();
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

  it('doubles a trailing backslash so a quoted path is not read past its closing quote', () => {
    // Without doubling, `"C:\repo dir\"` reads as an escaped literal quote,
    // not the argument's end, and the next argument gets swallowed into it.
    expect(windowsCommandLine(['npm', '--cwd', 'C:\\repo dir\\', 'test'])).toBe('npm --cwd "C:\\repo dir\\\\" test');
    expect(windowsCommandLine(['npm', 'a b\\\\'])).toBe('npm "a b\\\\\\\\"');
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
  const templatesDir = join(CONFIG_DIR, 'templates');
  // The workflows of this repository, and the workflow templates other repositories copy.
  const workflowFiles = (): string[] => [
    ...readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.yml'))
      .map((f) => join(workflowsDir, f)),
    ...readdirSync(templatesDir)
      .filter((f) => f.endsWith('.yml'))
      .map((f) => join(templatesDir, f)),
  ];

  it('every GitHub Action and reusable workflow is pinned to a full commit SHA, templates included', () => {
    const files = workflowFiles();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
        const ref = m[1];
        if (ref.startsWith('./')) continue;
        expect({ file, ref, pinned: /@[0-9a-f]{40}$/.test(ref) }).toEqual({ file, ref, pinned: true });
      }
    }
  });

  it('workflows default to read-only tokens and parse as YAML', () => {
    for (const file of workflowFiles()) {
      const wf = parseYaml(readFileSync(file, 'utf8')) as { permissions?: unknown };
      expect({ file, permissions: wf.permissions }).toEqual({
        file,
        permissions: expect.anything(),
      });
      expect(JSON.stringify(wf.permissions)).not.toMatch(/write-all/);
    }
  });

  // GitHub rejects the whole workflow file when a context is used where it is
  // not available; job-level env and if accept github, needs, strategy, matrix,
  // vars, secrets and inputs only (not runner, steps, job or env).
  it('workflows use only the contexts GitHub allows in job-level env and if', () => {
    for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
      const wf = parseYaml(readFileSync(join(workflowsDir, file), 'utf8')) as {
        jobs?: Record<string, { env?: Record<string, unknown>; if?: unknown }>;
      };
      for (const [id, job] of Object.entries(wf.jobs ?? {})) {
        const text = JSON.stringify({ env: job.env ?? {}, if: job.if ?? '' });
        expect({ file, job: id, bad: text.match(/\b(runner|steps|job|env)\.[A-Za-z_]/g) ?? [] }).toEqual({
          file,
          job: id,
          bad: [],
        });
      }
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

  it('a hash only in a comment, or not exactly 64 hex characters, is no hash', () => {
    const h = 'a'.repeat(64);
    expect(requirementProblems(`requests==1.0.0 \\\n    --hash=sha256:${h}\n`, {})).toEqual([]);
    expect(requirementProblems(`requests==1.0.0\n    # --hash=sha256:${h}\n`, {})).toEqual(['requests has no --hash']);
    expect(requirementProblems(`requests==1.0.0  # --hash=sha256:${h}\n`, {})).toEqual(['requests has no --hash']);
    expect(requirementProblems(`requests==1.0.0 \\\n    --hash=sha256:${h}0\n`, {})).toEqual([
      'requests has no --hash',
    ]);
    expect(requirementProblems(`requests==1.0.0 \\\n    --hash=sha256:${'A'.repeat(64)}\n`, {})).toEqual([
      'requests has no --hash',
    ]);
  });

  it('the Gitleaks download is checked against a checksum file kept in this repository', () => {
    const pin = config().policy.tools?.gitleaks as string;
    const sums = readFileSync(join(CONFIG_DIR, 'config', `gitleaks_${pin}_checksums.txt`), 'utf8');
    expect(sums).toMatch(/^[0-9a-f]{64}\s+gitleaks_/m);
  });
});

describe('the rulesets in config/github', () => {
  const dir = join(CONFIG_DIR, 'config', 'github');
  interface Ruleset {
    target: string;
    conditions: { ref_name: { include: string[] } };
    rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  }
  const rulesets = (): Array<[string, Ruleset]> =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f, JSON.parse(readFileSync(join(dir, f), 'utf8')) as Ruleset]);

  it('every branch ruleset requires an approving code-owner review and dismisses stale approvals', () => {
    const branches = rulesets().filter(([, r]) => r.target === 'branch');
    expect(branches.map(([f]) => f)).toEqual(
      expect.arrayContaining(['repo-ruleset-main.json', 'repo-ruleset-dev.json']),
    );
    for (const [file, r] of branches) {
      const pr = r.rules.find((x) => x.type === 'pull_request')?.parameters ?? {};
      expect({ file, approvals: (pr.required_approving_review_count as number) >= 1 }).toEqual({
        file,
        approvals: true,
      });
      expect({ file, codeOwners: pr.require_code_owner_review, stale: pr.dismiss_stale_reviews_on_push }).toEqual({
        file,
        codeOwners: true,
        stale: true,
      });
      for (const rule of ['deletion', 'non_fast_forward']) expect(r.rules.map((x) => x.type)).toContain(rule);
    }
  });

  it('main takes merge commits only (dev is merged into it), and release tags cannot be created, moved or deleted by hand', () => {
    const byFile = new Map(rulesets());
    const main = byFile.get('repo-ruleset-main.json');
    expect(main?.rules.find((x) => x.type === 'pull_request')?.parameters?.allowed_merge_methods).toEqual(['merge']);
    const tags = byFile.get('repo-ruleset-release-tags.json');
    expect(tags?.target).toBe('tag');
    expect(tags?.conditions.ref_name.include).toEqual(['refs/tags/v*']);
    expect(tags?.rules.map((x) => x.type).sort()).toEqual(['creation', 'deletion', 'non_fast_forward', 'update']);
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

describe('scanner ignore files among the copied files', () => {
  // isScannerControlFile already keeps these out of the copy; removing them
  // from the copy is the second line: a repository must never take its own
  // files out of the scan.
  it.each([
    ['gitleaks', removeGitleaksIgnores, '.gitleaksignore'],
    ['semgrep', removeSemgrepIgnores, '.semgrepignore'],
  ])('%s: removes every %s at any depth and in any case, and nothing else', (_tool, remove, name) => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-ignores-'));
    try {
      mkdirSync(join(dir, 'a', 'b'), { recursive: true });
      for (const f of [name, join('a', name.toUpperCase()), join('a', 'b', name), join('a', 'keep.ts'), 'notes.md'])
        writeFileSync(join(dir, f), 'x');
      remove(dir);
      const left: string[] = [];
      const walk = (d: string, rel = ''): void => {
        for (const e of readdirSync(join(d, rel), { withFileTypes: true }))
          if (e.isDirectory()) walk(d, join(rel, e.name));
          else left.push(join(rel, e.name));
      };
      walk(dir);
      expect(left.sort()).toEqual([join('a', 'keep.ts'), 'notes.md'].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
