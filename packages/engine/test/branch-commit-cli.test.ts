import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { CONFIG_DIR } from './helpers';
import { allowlistedRepo, cliEnv, describeBuilt, QA_BIN } from './cli-helpers';

// Ticket-based branch names and commit messages (AIQC-87), end to end: a
// developer committing through the pre-commit, prepare-commit-msg and
// commit-msg hooks, with the checks in block mode as they will be once
// switched on, and in report mode as they ship.

const posix = (p: string): string => p.replace(/\\/g, '/');

function installHooks(dir: string): void {
  const node = posix(process.execPath);
  const bin = posix(QA_BIN);
  const hooks: Record<string, string> = {
    'pre-commit': `"${node}" "${bin}" precommit --quiet`,
    'prepare-commit-msg': `"${node}" "${bin}" prepare-commit-msg "$1" "$2"`,
    'commit-msg': `"${node}" "${bin}" commit-msg --quiet "$1"`,
  };
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  for (const [name, cmd] of Object.entries(hooks)) {
    const file = join(dir, '.git', 'hooks', name);
    writeFileSync(file, `#!/bin/sh\nexec ${cmd}\n`);
    chmodSync(file, 0o755);
  }
}

/** A copy of this repository's configuration with the AIQC-87 checks in block mode. */
function blockingConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa-config-'));
  for (const entry of ['registry', 'schemas', 'config', 'checks.yaml', 'path-tags.yaml', 'exemptions.yaml'])
    cpSync(join(CONFIG_DIR, entry), join(dir, entry), { recursive: true });
  const policy = parse(readFileSync(join(CONFIG_DIR, 'policy.yaml'), 'utf8'));
  for (const id of ['branch.ticket', 'commit.message']) policy.checks[id] = { mode: 'block' };
  // These tests are about the conventions, not the time budget: on a loaded
  // machine gitleaks alone can use the 10 s pre-commit budget, and the checks
  // after it are then deferred to CI ("LATER"), so nothing would block.
  policy.local.time_budget_ms = 600_000;
  writeFileSync(join(dir, 'policy.yaml'), stringify(policy));
  return dir;
}

describeBuilt('ticket-based branch names and commit messages through the git hooks', () => {
  let repo: ReturnType<typeof allowlistedRepo>;
  let configDir: string;
  let env: NodeJS.ProcessEnv;
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo.dir, env, encoding: 'utf8', timeout: 120_000 });
  const out = (r: ReturnType<typeof git>): string => `${r.stdout}${r.stderr}`;
  const subject = (): string => git('log', '-1', '--format=%s').stdout.trim();
  let n = 0;
  const change = (): void => {
    writeFileSync(join(repo.dir, `file-${++n}.md`), `${n}\n`);
    git('add', '.');
  };

  beforeAll(() => {
    configDir = blockingConfig();
    env = cliEnv({ QA_CONFIG_DIR: configDir, QA_AS_OF: '2027-01-08' });
    repo = allowlistedRepo();
    installHooks(repo.dir);
  });
  afterAll(() => {
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('blocks a commit on a branch without a ticket key, and explains how to fix the branch', () => {
    change();
    const res = git('commit', '-m', 'add notes');
    expect(res.status).not.toBe(0);
    expect(out(res)).toMatch(/BLOCK +branch\.ticket/);
    expect(out(res)).toContain('Branch "main" has no ticket key');
    expect(out(res)).toContain('git switch -c feature/<TICKET-123>-<short-description>');
    expect(subject()).toBe('init');
  });

  it('blocks a commit on a branch with an incorrectly formatted ticket key', () => {
    expect(git('switch', '-q', '-c', 'feature/lcore-212-bounded-retry').status).toBe(0);
    const res = git('commit', '-m', 'add bounded retry');
    expect(res.status).not.toBe(0);
    expect(out(res)).toContain('is not a valid ticket key');
    expect(out(res)).toContain('git branch -M feature/LCORE-212-bounded-retry');
    expect(subject()).toBe('init');
    // The suggested command works, also on a case-insensitive file system.
    expect(git('branch', '-M', 'feature/LCORE-212-bounded-retry').status).toBe(0);
    expect(git('branch', '--show-current').stdout.trim()).toBe('feature/LCORE-212-bounded-retry');
  });

  it('allows a commit on a valid ticket branch and writes the ticket key into the message', () => {
    expect(git('branch', '-m', 'feature/LCORE-212-retry').status).toBe(0);
    const res = git('commit', '-m', 'add bounded retry');
    expect(res.status).toBe(0);
    expect(subject()).toBe('feat(LCORE-212): add bounded retry');
    expect(out(res)).toContain('added ticket LCORE-212 from branch feature/LCORE-212-retry');
  });

  it("keeps the developer's commit type and adds the branch's key", () => {
    change();
    expect(git('commit', '-q', '-m', 'fix: off-by-one in the poller').status).toBe(0);
    expect(subject()).toBe('fix(LCORE-212): off-by-one in the poller');
  });

  it('blocks a subject that names another ticket than the branch, and one off the convention', () => {
    change();
    const other = git('commit', '-m', 'feat(LCORE-999): borrow another ticket');
    expect(other.status).not.toBe(0);
    expect(out(other)).toMatch(/BLOCK +commit\.message/);
    expect(out(other)).toContain('the ticket key comes from the branch name');
    const scoped = git('commit', '-m', 'feat(payments): add key');
    expect(scoped.status).not.toBe(0);
    expect(out(scoped)).toContain('Write it as "feat(LCORE-212): <description>"');
    expect(subject()).toBe('fix(LCORE-212): off-by-one in the poller');
  });

  it('a rebase does not rewrite the subjects of the commits it replays', () => {
    expect(git('switch', '-q', '-c', 'feature/LCORE-212-replay').status).toBe(0);
    writeFileSync(join(repo.dir, 'replay.md'), 'r\n');
    git('add', '.');
    // As a teammate without the hooks committed it (--no-verify still runs prepare-commit-msg).
    expect(git('-c', 'core.hooksPath=no-hooks-here', 'commit', '-q', '-m', 'wip from a teammate').status).toBe(0);
    expect(subject()).toBe('wip from a teammate');
    expect(git('rebase', '-q', '--force-rebase', 'HEAD~1').status).toBe(0);
    expect(subject()).toBe('wip from a teammate');
  });

  it('reads the branch being rebased while HEAD is detached', () => {
    // A reword during a rebase runs the message hooks with HEAD detached.
    const res = spawnSync(process.execPath, [QA_BIN, 'commit-msg', '--quiet', join(repo.dir, 'msg.txt')], {
      cwd: repo.dir,
      env,
      encoding: 'utf8',
    });
    expect(res.status).toBe(2); // no such file: a usage error
    writeFileSync(join(repo.dir, '.git', 'msg.txt'), 'feat(LCORE-212): reworded\n');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    mkdirSync(join(repo.dir, '.git', 'rebase-merge'), { recursive: true });
    writeFileSync(join(repo.dir, '.git', 'rebase-merge', 'head-name'), 'refs/heads/feature/LCORE-212-retry\n');
    expect(git('checkout', '-q', '--detach', head).status).toBe(0);
    try {
      const ok = spawnSync(process.execPath, [QA_BIN, 'commit-msg', join(repo.dir, '.git', 'msg.txt')], {
        cwd: repo.dir,
        env,
        encoding: 'utf8',
      });
      expect(ok.status).toBe(0);
      writeFileSync(join(repo.dir, '.git', 'msg.txt'), 'feat(LCORE-1): reworded\n');
      const mismatch = spawnSync(process.execPath, [QA_BIN, 'commit-msg', join(repo.dir, '.git', 'msg.txt')], {
        cwd: repo.dir,
        env,
        encoding: 'utf8',
      });
      expect(mismatch.status).toBe(1);
      expect(mismatch.stdout).toContain('branch "feature/LCORE-212-retry" is for LCORE-212');
    } finally {
      rmSync(join(repo.dir, '.git', 'rebase-merge'), { recursive: true, force: true });
      git('checkout', '-q', 'feature/LCORE-212-retry');
    }
  });

  it('in report mode, as shipped, shows the branch finding without blocking', () => {
    const shipped = cliEnv({ QA_CONFIG_DIR: CONFIG_DIR, QA_AS_OF: '2027-01-08' });
    expect(git('switch', '-q', 'main').status).toBe(0);
    change();
    const res = spawnSync('git', ['commit', '-m', 'add notes'], {
      cwd: repo.dir,
      env: shipped,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/branch\.ticket/);
  });
});
