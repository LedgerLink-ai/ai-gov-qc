import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_ADAPTERS } from '../src/adapters/tools';
import { CONFIG_DIR } from './helpers';
import { allowlistedRepo, cliEnv, describeBuilt, HIDDEN, QA_BIN } from './cli-helpers';

// The git hook lifecycle as a developer meets it: hooks installed in a clone,
// then commit (pre-commit, prepare-commit-msg) and push (pre-push), the block,
// and --no-verify, the documented limitation of local hooks that the pull
// request gate (qa-pr.yml) closes.

const posix = (p: string): string => p.replace(/\\/g, '/');

function installHooks(dir: string): void {
  const node = posix(process.execPath);
  const bin = posix(QA_BIN);
  const hooks: Record<string, string> = {
    'pre-commit': `"${node}" "${bin}" precommit --quiet`,
    'prepare-commit-msg': `"${node}" "${bin}" prepare-commit-msg "$1" "$2"`,
    'pre-push': `"${node}" "${bin}" prepush --quiet`,
  };
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  for (const [name, cmd] of Object.entries(hooks)) {
    const file = join(dir, '.git', 'hooks', name);
    writeFileSync(file, `#!/bin/sh\nexec ${cmd}\n`);
    chmodSync(file, 0o755);
  }
}

describeBuilt('git hook lifecycle', () => {
  let repo: ReturnType<typeof allowlistedRepo>;
  let remote: string;
  const env = cliEnv({ QA_CONFIG_DIR: CONFIG_DIR, QA_AS_OF: '2027-01-08' });
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo.dir, env, encoding: 'utf8', timeout: 120_000 });

  beforeAll(() => {
    repo = allowlistedRepo();
    installHooks(repo.dir);
    remote = mkdtempSync(join(tmpdir(), 'qa-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    repo.git('remote', 'add', 'backup', remote);
  });
  afterAll(() => {
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it('pre-commit: a clean commit goes through silently', () => {
    writeFileSync(join(repo.dir, 'notes.md'), 'hello\n');
    git('add', '.');
    const res = git('commit', '-q', '-m', 'Add notes');
    expect(res.status).toBe(0);
  });

  it('prepare-commit-msg: the ticket key from the branch is added to the message', () => {
    expect(git('checkout', '-q', '-b', 'LCORE-212-bounded-retry').status).toBe(0);
    writeFileSync(join(repo.dir, 'more.md'), 'more\n');
    git('add', '.');
    expect(git('commit', '-q', '-m', 'Add bounded retry').status).toBe(0);
    expect(git('log', '-1', '--format=%s').stdout.trim()).toBe('LCORE-212: Add bounded retry');
  });

  it('pre-commit: a blocking finding stops the commit and says why', () => {
    writeFileSync(join(repo.dir, 'AGENTS.md'), HIDDEN);
    git('add', '.');
    const res = git('commit', '-m', 'Add agent instructions');
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/BLOCK +ai-config\.content-lint +AGENTS\.md/);
    expect(git('log', '-1', '--format=%s').stdout.trim()).toBe('LCORE-212: Add bounded retry');
  });

  it('--no-verify skips the local hook (documented limitation; the pull request gate runs it again)', () => {
    const res = git('commit', '-q', '--no-verify', '-m', 'Add agent instructions');
    expect(res.status).toBe(0);
    expect(git('log', '-1', '--format=%s').stdout.trim()).toMatch(/Add agent instructions$/);
  });

  it('pre-push: runs on what is pushed and lets a clean push through', () => {
    const res = git('push', '-q', 'backup', 'HEAD:refs/heads/feature');
    expect(res.status).toBe(0);
  });

  const withSemgrep = TOOL_ADAPTERS.semgrep.available() ? it : it.skip;
  withSemgrep(
    'pre-push: a blocking Semgrep finding stops the push',
    () => {
      mkdirSync(join(repo.dir, 'src', 'transaction'), { recursive: true });
      writeFileSync(
        join(repo.dir, 'src', 'transaction', 'fee.ts'),
        'export function fee(amount: string): string {\n  return (parseFloat(amount) * 0.015).toFixed(2);\n}\n',
      );
      git('add', '.');
      expect(git('commit', '-q', '-m', 'Add fee').status).toBe(0);
      const res = git('push', 'backup', 'HEAD:refs/heads/feature');
      expect(res.status).not.toBe(0);
      expect(`${res.stdout}${res.stderr}`).toMatch(/BLOCK +sast\.semgrep +src\/transaction\/fee\.ts/);
    },
    180_000,
  );
});
