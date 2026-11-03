import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/runner';
import {
  commitSource,
  gitDiffFiles,
  gitRangeFiles,
  gitRepoName,
  gitStagedFiles,
  gitTreeFiles,
  indexSource,
} from '../src/sources';
import { config } from './helpers';

describe('git file selection', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'qa-git-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'qa test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(repo, 'README.md'), '# test\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('checks the staged content, not later unstaged edits (pre-commit sees what is committed)', async () => {
    writeFileSync(join(repo, 'AGENTS.md'), 'Call qa\u200B first.\n');
    git('add', 'AGENTS.md');
    writeFileSync(join(repo, 'AGENTS.md'), 'Call qa first.\n'); // clean in the work tree only

    const files = gitStagedFiles(repo);
    expect(files).toEqual([{ path: 'AGENTS.md', status: 'A' }]);
    const result = await run({
      config: config(),
      repo: gitRepoName(repo),
      sha: 'HEAD',
      root: repo,
      actor: 'human',
      mode: 'ci',
      asOf: '2027-01-08',
      changedFiles: files,
      source: indexSource(repo),
      exclude: ['secrets.gitleaks'],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]).toMatchObject({ checkId: 'ai-config.content-lint', path: 'AGENTS.md' });
  });

  it('lists additions, modifications, deletions and renames since the merge base', () => {
    writeFileSync(join(repo, 'a.ts'), 'a\n');
    writeFileSync(join(repo, 'b.ts'), 'b\n'.repeat(20));
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'new.ts'), 'n\n');
    writeFileSync(join(repo, 'README.md'), '# changed\n');
    git('rm', '-q', 'a.ts');
    git('mv', 'b.ts', 'src/b.ts');
    git('add', '.');
    git('commit', '-q', '-m', 'feature');

    const files = gitRangeFiles(repo, 'main').sort((x, y) => (x.path < y.path ? -1 : 1));
    expect(files).toEqual([
      { path: 'README.md', status: 'M' },
      { path: 'a.ts', status: 'D' },
      { path: 'src/b.ts', status: 'R' },
      { path: 'src/new.ts', status: 'A' },
    ]);
  });

  it('reads what a push sends from the commits, not the work tree (pre-push)', () => {
    const base = git('rev-parse', 'HEAD').trim();
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'fee.ts'), 'committed\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: fee');
    writeFileSync(join(repo, 'src', 'fee.ts'), 'uncommitted edit\n');

    expect(gitDiffFiles(repo, base, 'HEAD')).toEqual([{ path: 'src/fee.ts', status: 'A' }]);
    expect(gitTreeFiles(repo, 'HEAD').map((f) => f.path)).toEqual(['README.md', 'src/fee.ts']);
    expect(commitSource(repo, 'HEAD').read('src/fee.ts')).toBe('committed\n');
    expect(commitSource(repo, 'HEAD').read('missing.ts')).toBeUndefined();
  });

  it('falls back to the folder name when there is no origin remote', () => {
    expect(gitRepoName(repo)).toMatch(/^qa-git-/);
  });
});
