import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/runner';
import { gitBranch, gitRangeCommits, gitRangeDiffStat } from '../src/sources';
import type { PrInfo } from '../src/types';
import { options } from './helpers';

const GOOD = 'LD-480: Add refund key\n\nAssisted-by: Cursor, gpt-5, 1.7.0\n';

const pr = (overrides: Partial<PrInfo> = {}): PrInfo => ({
  base: 'origin/develop',
  branch: 'LD-480-refund-key',
  commits: [{ sha: 'a'.repeat(40), message: GOOD }],
  diff: [{ path: 'src/refund.ts', added: 20, deleted: 5, binary: false }],
  coverage: [],
  ...overrides,
});

async function prFindings(info: PrInfo) {
  const result = await run(options({}, { pr: info, stages: [3] }));
  return result.findings.filter((f) => f.level !== 'note').map((f) => [f.checkId, f.ruleId, f.blocking]);
}

describe('pull request checks (stage 3)', () => {
  it('pass a well-formed pull request', async () => {
    expect(await prFindings(pr())).toEqual([]);
    expect(await prFindings(pr({ branch: 'feature/LCORE-210-limit-invariants' }))).toEqual([]);
  });

  it('are skipped outside a pre-PR run', async () => {
    const result = await run(options({ 'a.ts': 'x\n' }, { stages: [3] }));
    const runs = result.checkRuns.filter((r) => ['pr.branch-name', 'pr.commits', 'pr.diff-size'].includes(r.checkId));
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === 'skipped' && /qa prepr/.test(r.reason ?? ''))).toBe(true);
  });

  it('report, without blocking, a branch with no ticket key or the base branch itself', async () => {
    expect(await prFindings(pr({ branch: 'chore/precommit-local-checks' }))).toEqual([
      ['pr.branch-name', 'no-ticket-key', false],
    ]);
    expect(await prFindings(pr({ branch: 'develop' }))).toEqual([['pr.branch-name', 'base-branch', false]]);
  });

  it('check only the Assisted-by form of every commit, and report without blocking', async () => {
    const commits = [
      { sha: '1'.repeat(40), message: GOOD },
      { sha: '2'.repeat(40), message: 'wip\n' },
      { sha: '3'.repeat(40), message: 'Fix retry\n\nAssisted-by: cursor/gpt-5\n' },
    ];
    const result = await run(options({}, { pr: pr({ commits }), stages: [3] }));
    const own = result.findings.filter((f) => f.checkId === 'pr.commits');
    expect(own.map((f) => [f.ruleId, f.blocking])).toEqual([['malformed', false]]);
    expect(own[0].message).toMatch(/^Commit 3333333: /);
    expect(result.exitCode).toBe(0);
  });

  it('report a large pull request, without counting lockfiles', async () => {
    const big = [{ path: 'src/a.ts', added: 900, deleted: 200, binary: false }];
    expect(await prFindings(pr({ diff: big }))).toEqual([['pr.diff-size', 'too-large', false]]);
    const lock = [
      { path: 'src/a.ts', added: 100, deleted: 0, binary: false },
      { path: 'yarn.lock', added: 5000, deleted: 3000, binary: false },
    ];
    expect(await prFindings(pr({ diff: lock }))).toEqual([]);
  });

  it('report coverage below the threshold, and say when it was not measured', async () => {
    const low = [{ file: 'server/coverage/coverage-summary.json', linesPct: 61.5 }];
    expect(await prFindings(pr({ coverage: low }))).toEqual([['tests.coverage', 'below-threshold', false]]);
    expect(await prFindings(pr({ coverage: [{ file: 'coverage/coverage-summary.json' }] }))).toEqual([
      ['tests.coverage', 'no-lines', false],
    ]);
    const result = await run(options({}, { pr: pr(), stages: [3] }));
    expect(result.findings.map((f) => [f.checkId, f.ruleId])).toEqual([['tests.coverage', 'not-measured']]);
  });
});

describe('pull request git sources', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'qa-pr-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'qa test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(repo, 'old.ts'), 'a\nb\nc\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('lists the branch commits oldest first, without merges, and the lines changed per file', () => {
    git('switch', '-q', '-c', 'LD-1-x');
    writeFileSync(join(repo, 'new.ts'), 'x\ny\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: one', '-m', 'Refs: LD-1');
    git('mv', 'old.ts', 'renamed.ts');
    git('commit', '-q', '-m', 'refactor: two');

    expect(gitBranch(repo)).toBe('LD-1-x');
    const commits = gitRangeCommits(repo, 'main');
    expect(commits.map((c) => c.message.split('\n')[0])).toEqual(['feat: one', 'refactor: two']);
    expect(commits[0].message).toContain('Refs: LD-1');
    expect(gitRangeDiffStat(repo, 'main')).toEqual(
      expect.arrayContaining([
        { path: 'new.ts', added: 2, deleted: 0, binary: false },
        { path: 'renamed.ts', added: 0, deleted: 0, binary: false },
      ]),
    );
  });
});
