import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runHook, type HookDeps } from '../src/hooks';
import type { HookResult } from '../src/report';

// runHook decides whether a developer's commit or push goes through. These
// tests pin its contract directly, without pre-commit installed: qa's own
// problems let the commit through (fail open), the repository's own hook
// always runs and its exit code always counts, and a blocking result from
// the checks stops the commit with a summary naming the finding.
//
// pre-commit is faked: QA_PRE_COMMIT_BIN is node itself, and runHook starts
// "<bin> hook-impl --config ..." in the repository's top directory, so node
// runs the hook-impl script each test writes there.

const HAS_SH = spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true }).status === 0;
const withSh = HAS_SH ? it : it.skip;

const ENV_KEYS = ['QA_HOME', 'QA_PRE_COMMIT_BIN', 'QA_HOOK_OUTPUT', 'LEDGERLINK_QA_HOOK', 'FAKE_PC_LOG'];
let saved: Record<string, string | undefined>;
let root: string;
let repo: string;
let log: string;

// Jest gives each test file its own copy of process.env: a child process
// started without an explicit env gets the real one. So git here gets its
// environment explicitly (no init.templateDir or hooks from this machine's
// global config), and every repository sets a LOCAL core.hooksPath, which
// wins over a global one for the git calls inside runHook.
const git = (...args: string[]): string =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

/** The fake pre-commit: logs its argv and stdin, optionally leaves a hook result, prints, exits. */
function fakePreCommit(opts: { exit: number; print?: string; result?: HookResult }): void {
  const script = `
const fs = require('fs');
// Only pre-push gets input; other hooks inherit the caller's stdin, which may never close.
let stdin = '';
if (process.argv.includes('pre-push')) try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.writeFileSync(process.env.FAKE_PC_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, path: process.env.PATH }));
const result = ${JSON.stringify(opts.result ?? null)};
if (result && process.env.QA_HOOK_RESULT) fs.writeFileSync(process.env.QA_HOOK_RESULT, JSON.stringify(result));
process.stdout.write(${JSON.stringify(opts.print ?? '')});
process.exit(${opts.exit});
`;
  writeFileSync(join(repo, 'hook-impl'), script);
}

const preCommitRan = (): boolean => existsSync(log);
const preCommitCall = (): { argv: string[]; stdin: string; path: string } => JSON.parse(readFileSync(log, 'utf8'));

/** The repository's own hook in .git/hooks: records that it ran (and its stdin), exits with `exit`. */
function ownHook(hook: string, exit: number, body = ''): string {
  const file = join(repo, '.git', 'hooks', hook);
  writeFileSync(
    file,
    `#!/bin/sh\n${body}cat > "${join(root, 'own-ran').replace(/\\/g, '/')}" 2>/dev/null </dev/null\nexit ${exit}\n`,
  );
  chmodSync(file, 0o755);
  return file;
}
const ownRan = (): boolean => existsSync(join(root, 'own-ran'));

/** Runs the hook the way "qa hook" does, capturing what it warns and writes. */
function hook(
  name: string,
  gate: HookDeps['gateExit'],
  extra: Partial<HookDeps> = {},
): { status: number; warnings: string[]; out: string } {
  const warnings: string[] = [];
  let out = '';
  const status = runHook(name, [], {
    gateExit: gate,
    warn: (m) => warnings.push(m),
    cwd: repo,
    output: 'buffer',
    write: (t) => {
      out += t;
    },
    ...extra,
  });
  return { status, warnings, out };
}
const optedIn: HookDeps['gateExit'] = () => undefined;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), 'qa-run-hook-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  log = join(root, 'pre-commit.json');
  writeFileSync(join(root, 'gitconfig'), '');
  process.env.QA_HOME = join(root, 'qa-home');
  process.env.QA_PRE_COMMIT_BIN = process.execPath;
  process.env.FAKE_PC_LOG = log;
  delete process.env.QA_HOOK_OUTPUT;
  delete process.env.LEDGERLINK_QA_HOOK;
  git('init', '-q');
  // As after "qa setup": git runs the machine-wide hooks, not .git/hooks, so qa runs the own hook.
  git('config', 'core.hooksPath', join(root, 'global-hooks'));
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('runHook: input', () => {
  it('refuses a hook it does not run checks for', () => {
    expect(() => hook('post-commit', optedIn)).toThrow(/qa hook runs pre-commit, .*got "post-commit"/);
  });
});

describe('runHook: a repository that is not opted in', () => {
  withSh('lets the commit through with the gate decision when the own hook passes', () => {
    ownHook('pre-commit', 0);
    fakePreCommit({ exit: 1 });
    const r = hook('pre-commit', () => 0);
    expect(r.status).toBe(0);
    expect(ownRan()).toBe(true);
    expect(preCommitRan()).toBe(false);
  });

  withSh('still runs the own hook, and its failure stops the commit', () => {
    ownHook('pre-commit', 3);
    const r = hook('pre-commit', () => 0);
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/^qa: commit blocked by this repository's own pre-commit hook\./);
  });

  withSh('passes on a non-zero gate decision when the own hook passes', () => {
    ownHook('pre-commit', 0);
    expect(hook('pre-commit', () => 2).status).toBe(2);
  });

  it('passes the hook name to the gate as the qa command it logs under', () => {
    const seen: string[] = [];
    const gate = (cmd: string): number => {
      seen.push(cmd);
      return 0;
    };
    for (const h of ['pre-commit', 'prepare-commit-msg', 'commit-msg']) hook(h, gate);
    hook('pre-push', gate, { stdin: () => Buffer.alloc(0) });
    expect(seen).toEqual(['precommit', 'prepare-commit-msg', 'commit-msg', 'prepush']);
  });
});

describe('runHook: fails open on qa problems', () => {
  withSh('lets the commit through when the gate cannot decide, and still runs the own hook', () => {
    ownHook('pre-commit', 0);
    fakePreCommit({ exit: 1 });
    const r = hook('pre-commit', () => {
      throw new Error('policy.yaml is broken');
    });
    expect(r.status).toBe(0);
    expect(ownRan()).toBe(true);
    expect(preCommitRan()).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/pre-commit checks could not run \(policy\.yaml is broken\); skipped/);
  });

  withSh('a failing own hook still stops the commit when the gate cannot decide', () => {
    ownHook('pre-commit', 4);
    const r = hook('pre-commit', () => {
      throw new Error('boom');
    });
    expect(r.status).toBe(4);
  });

  it('lets the commit through, with a warning, when pre-commit is not installed', () => {
    process.env.QA_PRE_COMMIT_BIN = join(root, 'no-such-pre-commit');
    const r = hook('pre-commit', optedIn);
    expect(r.status).toBe(0);
    expect(r.warnings.join('\n')).toMatch(/pre-commit was not found .*checks were skipped here; CI runs them/);
  });

  it('does nothing outside a git repository', () => {
    const outside = join(root, 'not-a-repo');
    mkdirSync(outside);
    let gateCalled = false;
    const r = hook('pre-commit', () => ((gateCalled = true), undefined), { cwd: outside });
    expect(r.status).toBe(0);
    expect(gateCalled).toBe(false);
  });
});

describe('runHook: an opted-in repository', () => {
  it('runs pre-commit with the shipped default configuration, staged in the git directory', () => {
    fakePreCommit({ exit: 0, print: 'gitleaks....Passed\n' });
    const r = hook('pre-commit', optedIn);
    expect(r.status).toBe(0);
    const call = preCommitCall();
    expect(call.argv.slice(0, 4)).toEqual(['--config', call.argv[1], '--hook-type', 'pre-commit']);
    expect(resolve(call.argv[1])).toBe(resolve(repo, '.git', 'ledgerlink-qa', 'pre-commit-config.yaml'));
    expect(existsSync(call.argv[1])).toBe(true);
    // The passing output is still shown, after the run.
    expect(r.out).toBe('gitleaks....Passed\n');
  });

  it("prefers the repository's own .pre-commit-config.yaml", () => {
    writeFileSync(join(repo, '.pre-commit-config.yaml'), 'repos: []\n');
    fakePreCommit({ exit: 0 });
    hook('pre-commit', optedIn);
    expect(resolve(preCommitCall().argv[1])).toBe(resolve(repo, '.pre-commit-config.yaml'));
  });

  it('puts the qa launcher first on PATH for pre-commit', () => {
    fakePreCommit({ exit: 0 });
    hook('pre-commit', optedIn);
    const first = preCommitCall().path.split(process.platform === 'win32' ? ';' : ':')[0];
    expect(resolve(first).startsWith(resolve(root, 'qa-home', 'shims'))).toBe(true);
  });

  it('stops the commit and names the first blocking finding, first and last in buffer mode', () => {
    fakePreCommit({
      exit: 1,
      print: 'qa: secrets....Failed\n',
      result: {
        exitCode: 1,
        blocking: [
          { check: 'secrets.gitleaks', path: 'src/aws.ts', line: 3, summary: 'Possible secret: AWS key.' },
          { check: 'secrets.gitleaks', path: 'src/b.ts', summary: 'Possible secret.' },
        ],
        errors: [],
      },
    });
    const r = hook('pre-commit', optedIn);
    expect(r.status).toBe(1);
    const lines = r.out.trimEnd().split('\n');
    const summary =
      'qa: commit blocked: possible secret: AWS key in src/aws.ts line 3 (and 1 more). Full details are in the git output.';
    expect(lines[0]).toBe(summary);
    expect(lines.at(-1)).toBe(summary);
    expect(r.out).toContain('qa: secrets....Failed');
    // The result file is cleaned up so the next commit does not read a stale one.
    expect(existsSync(join(repo, '.git', 'ledgerlink-qa', 'last-pre-commit.json'))).toBe(false);
  });

  it('names the failed pre-commit hooks when no qa result was left', () => {
    fakePreCommit({ exit: 1, print: 'eslint (repository version)........Failed\n' });
    const r = hook('pre-commit', optedIn);
    expect(r.status).toBe(1);
    expect(r.out.split('\n')[0]).toBe(
      'qa: commit blocked by eslint (repository version). Full details are in the git output.',
    );
  });

  it('does not read a stale result left by an earlier run', () => {
    const stale = join(repo, '.git', 'ledgerlink-qa', 'last-pre-commit.json');
    mkdirSync(join(repo, '.git', 'ledgerlink-qa'), { recursive: true });
    writeFileSync(
      stale,
      JSON.stringify({ exitCode: 1, blocking: [{ check: 'x', summary: 'Stale finding.' }], errors: [] }),
    );
    fakePreCommit({ exit: 1 });
    const r = hook('pre-commit', optedIn);
    expect(r.out).not.toMatch(/stale finding/i);
  });

  withSh('stops at a failing own hook without running the checks', () => {
    ownHook('pre-commit', 5);
    fakePreCommit({ exit: 0 });
    const r = hook('pre-commit', optedIn);
    expect(r.status).toBe(5);
    expect(preCommitRan()).toBe(false);
  });

  withSh('runs a passing own hook, then the checks, and the checks decide', () => {
    ownHook('pre-commit', 0);
    fakePreCommit({ exit: 1 });
    expect(hook('pre-commit', optedIn).status).toBe(1);
    expect(ownRan()).toBe(true);
    expect(preCommitRan()).toBe(true);
  });

  withSh('does not run an own hook that pre-commit itself generated (the checks would run twice)', () => {
    ownHook('pre-commit', 7, '# File generated by pre-commit: https://pre-commit.com\n');
    fakePreCommit({ exit: 0 });
    expect(hook('pre-commit', optedIn).status).toBe(0);
    expect(ownRan()).toBe(false);
  });

  withSh('hands the pushed refs on stdin to both the own hook and pre-commit', () => {
    const refs = 'refs/heads/x 1111 refs/heads/x 0000\n';
    const file = join(repo, '.git', 'hooks', 'pre-push');
    const seen = join(root, 'own-stdin').replace(/\\/g, '/');
    writeFileSync(file, `#!/bin/sh\ncat > "${seen}"\nexit 0\n`);
    chmodSync(file, 0o755);
    fakePreCommit({ exit: 0 });
    const r = hook('pre-push', optedIn, { stdin: () => Buffer.from(refs) });
    expect(r.status).toBe(0);
    expect(readFileSync(join(root, 'own-stdin'), 'utf8')).toBe(refs);
    expect(preCommitCall().stdin).toBe(refs);
  });
});

describe('runHook: never runs itself twice', () => {
  it('returns at once when the outer qa hook is already running this hook', () => {
    process.env.LEDGERLINK_QA_HOOK = `pre-commit|${join(resolve(repo, '.git'), 'hooks', 'pre-commit')}`;
    let gateCalled = false;
    const r = hook('pre-commit', () => ((gateCalled = true), undefined));
    expect(r.status).toBe(0);
    expect(gateCalled).toBe(false);
  });

  withSh('does not run .git/hooks again when git itself already ran it (no core.hooksPath)', () => {
    // A local setting, not an unset: runHook's own git calls inherit the real
    // environment, so a machine-wide core.hooksPath would otherwise show through.
    git('config', 'core.hooksPath', '.git/hooks');
    ownHook('pre-commit', 9);
    fakePreCommit({ exit: 0 });
    const r = hook('pre-commit', optedIn);
    expect(r.status).toBe(0);
    expect(ownRan()).toBe(false);
  });
});

describe('runHook: the rarer ways qa itself can fail', () => {
  it('lets the commit through when the default configuration cannot be staged', () => {
    // <git dir>/ledgerlink-qa is a file, so the configuration cannot be written under it.
    writeFileSync(join(repo, '.git', 'ledgerlink-qa'), 'in the way');
    fakePreCommit({ exit: 1 });
    const r = hook('pre-commit', optedIn);
    expect(r.status).toBe(0);
    expect(r.warnings.join('\n')).toMatch(/the checks were skipped\. Reinstall qa\./);
    expect(preCommitRan()).toBe(false);
  });

  it('still runs the checks, with a warning, when the qa launcher cannot be written', () => {
    // The qa home is a file, so <home>/shims cannot be made.
    writeFileSync(join(root, 'home-file'), '');
    process.env.QA_HOME = join(root, 'home-file');
    fakePreCommit({ exit: 1 });
    const r = hook('pre-commit', optedIn);
    expect(r.warnings.join('\n')).toMatch(/could not write the qa launcher for pre-commit .*"qa" must be on PATH/);
    expect(preCommitRan()).toBe(true);
    expect(r.status).toBe(1);
  });

  it('lets the commit through when pre-commit exists but cannot be started', () => {
    const notAProgram = join(root, 'pre-commit.txt');
    writeFileSync(notAProgram, 'not a program');
    process.env.QA_PRE_COMMIT_BIN = notAProgram;
    const r = hook('pre-commit', optedIn);
    expect(r.status).toBe(0);
    expect(r.warnings.join('\n')).toMatch(/pre-commit could not run \(.+\), so the checks were skipped here/);
  });

  it('does not ask the gate in a bare repository', () => {
    const bare = join(root, 'bare.git');
    execFileSync('git', ['init', '-q', '--bare', bare], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
    });
    execFileSync('git', ['config', 'core.hooksPath', join(root, 'global-hooks')], { cwd: bare });
    let gateCalled = false;
    const r = hook('pre-push', () => ((gateCalled = true), undefined), { cwd: bare, stdin: () => Buffer.alloc(0) });
    expect(r.status).toBe(0);
    expect(gateCalled).toBe(false);
  });

  it('in a terminal (stream mode), puts the summary last, after the streamed output', () => {
    fakePreCommit({ exit: 1, print: 'eslint........Failed\n' });
    const r = hook('pre-commit', optedIn, { output: 'stream' });
    expect(r.status).toBe(1);
    // The output itself went straight to the terminal; only the summary is written.
    expect(r.out).toBe('\nqa: commit blocked. Details above.\n');
  });

  it('names pre-commit itself when it crashed before running any hook', () => {
    fakePreCommit({ exit: 3, print: 'An unexpected error has occurred: CalledProcessError: command failed\n' });
    const r = hook('pre-commit', optedIn);
    expect(r.status).toBe(3);
    expect(r.out.split('\n')[0]).toBe(
      'qa: commit blocked by pre-commit itself, which stopped with CalledProcessError. Full details are in the git output.',
    );
  });
});
