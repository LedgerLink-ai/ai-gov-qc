import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The built CLI. End-to-end tests run it as developers and CI do (npm run build first). */
export const QA_BIN = resolve(__dirname, '..', 'bin', 'qa.js');
export const BUILT = existsSync(resolve(__dirname, '..', 'dist', 'cli.js'));

/** Runs the end-to-end suites only when the CLI is built; CI always builds before testing. */
export const describeBuilt = BUILT ? describe : describe.skip;

/**
 * The environment for a CLI run outside any CI: no GitHub Actions or CI
 * variables (the gate would read the test runner's own identity), a private
 * qa home and no cache, unless `extra` says otherwise.
 */
export function cliEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GITHUB_|RUNNER_|ACTIONS_)/.test(k) || k === 'CI' || k.startsWith('QA_') || k.startsWith('PRE_COMMIT_'))
      continue;
    env[k] = v;
  }
  env.QA_NO_CACHE = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export function qa(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [QA_BIN, ...args], {
    cwd: opts.cwd,
    env: opts.env ?? cliEnv(),
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * A git repository in the temp directory whose origin is an allowlisted
 * LedgerLink-ai repository (link_core), with one commit on main.
 */
export function allowlistedRepo(name = 'link_core'): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'qa-e2e-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: cliEnv() }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'qa test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.hooksPath', '.git/hooks');
  git('remote', 'add', 'origin', `https://github.com/LedgerLink-ai/${name}.git`);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git('add', '.');
  git('commit', '-q', '--no-verify', '-m', 'init');
  return { dir, git };
}

/** A string containing a zero-width space, which ai-config.content-lint blocks in agent files. */
export const HIDDEN = 'Call qa​ first.\n';
