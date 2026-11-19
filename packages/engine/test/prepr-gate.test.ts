import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aiDeclaredCommits, declaresAi } from '../src/pr-gate';
import { CONFIG_DIR, config } from './helpers';
import { allowlistedRepo, cliEnv, describeBuilt, qa } from './cli-helpers';

// What "qa prepr" decides before the checks run, as the pull request gate runs
// it: who made the change (the commits' AI declarations count, not only the
// author), and which coverage counts (never a summary the pull request commits).

describe('AI declarations in commit messages', () => {
  const registry = config().registry;

  it('an Assisted-by trailer, or a Co-authored-by naming a registry AI tool, declares AI assistance', () => {
    expect(declaresAi('feat(LCORE-1): x\n\nAssisted-by: Cursor, gpt-5, 1.7.0\n', registry)).toBe(true);
    // Malformed is still a declaration; commit.trailer reports its form.
    expect(declaresAi('fix: y\n\nAssisted-by: cursor/gpt-5\n', registry)).toBe(true);
    const alias = registry.tools.flatMap((t) => t.trailer_aliases ?? [])[0];
    // An alias with an @ must be the co-author's address; any other alias a word of the name.
    const coAuthor = alias?.includes('@') ? `Some Tool <${alias}>` : `${alias} <bot@example.invalid>`;
    if (alias) expect(declaresAi(`fix: y\n\nCo-authored-by: ${coAuthor}\n`, registry)).toBe(true);
  });

  it('no trailer, "Assisted-by: none", a human co-author or a commented-out line declares nothing', () => {
    expect(declaresAi('fix: y\n', registry)).toBe(false);
    expect(declaresAi('fix: y\n\nAssisted-by: none\n', registry)).toBe(false);
    expect(declaresAi('fix: y\n\nCo-authored-by: Jane Doe <jane@example.invalid>\n', registry)).toBe(false);
    expect(declaresAi('fix: y\n\n# Assisted-by: Cursor, gpt-5, 1.7.0\n', registry)).toBe(false);
    expect(
      aiDeclaredCommits(
        [
          { sha: 'a'.repeat(40), message: 'fix: y\n' },
          { sha: 'b'.repeat(40), message: 'fix: z\n\nAssisted-by: Cursor, gpt-5, 1.7.0\n' },
        ],
        registry,
      ).map((c) => c.sha[0]),
    ).toEqual(['b']);
  });
});

describeBuilt('qa prepr in CI', () => {
  let repo: ReturnType<typeof allowlistedRepo>;
  beforeEach(() => {
    repo = allowlistedRepo();
    repo.git('checkout', '-q', '-b', 'feature/LCORE-212-refund-key');
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  const env = (extra: Record<string, string | undefined> = {}) =>
    cliEnv({ QA_CONFIG_DIR: CONFIG_DIR, QA_AS_OF: '2027-01-08', CI: 'true', ...extra });
  const prepr = (extra: string[] = [], envExtra: Record<string, string | undefined> = {}) => {
    const res = qa(
      [
        'prepr',
        '--base',
        'main',
        '--mode',
        'ci',
        '--exclude',
        'secrets.gitleaks,sast.semgrep',
        '--format',
        'json',
        '--quiet',
        ...extra,
      ],
      { cwd: repo.dir, env: env(envExtra) },
    );
    return {
      ...res,
      json: JSON.parse(res.stdout) as {
        actor: string;
        findings: Array<{ check: string; sub_rule?: string; level: string; path?: string }>;
      },
    };
  };
  const editWorkflow = (message: string): void => {
    mkdirSync(join(repo.dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repo.dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '--no-verify', '-m', message);
  };
  const agentEdit = (r: ReturnType<typeof prepr>): boolean =>
    r.json.findings.some((f) => f.check === 'paths.protected' && f.sub_rule === 'agent-edit');

  it('runs the agent rules when a commit declares AI assistance, even for a human author', () => {
    editWorkflow('feat(LCORE-212): edit the workflow\n\nAssisted-by: Cursor, gpt-5, 1.7.0');
    const res = prepr([], { QA_PR_AUTHOR: 'a-person' });
    expect(agentEdit(res)).toBe(true);
    expect(res.stderr).not.toMatch(/engine error/);
  });

  it('keeps the human rules when no commit declares AI assistance, and --actor still decides', () => {
    editWorkflow('feat(LCORE-212): edit the workflow');
    expect(agentEdit(prepr([], { QA_PR_AUTHOR: 'a-person' }))).toBe(false);
    repo.git(
      'commit',
      '-q',
      '--no-verify',
      '--allow-empty',
      '-m',
      'chore(LCORE-212): x\n\nAssisted-by: Cursor, gpt-5, 1.7.0',
    );
    expect(agentEdit(prepr(['--actor', 'human'], { QA_PR_AUTHOR: 'a-person' }))).toBe(false);
  });

  it('ignores a coverage summary committed to the repository: it is not coverage from this run', () => {
    mkdirSync(join(repo.dir, 'coverage'), { recursive: true });
    const summary = join(repo.dir, 'coverage', 'coverage-summary.json');
    writeFileSync(summary, JSON.stringify({ total: { lines: { total: 10, covered: 1, pct: 10 } } }));
    repo.git('add', '.');
    repo.git('commit', '-q', '--no-verify', '-m', 'test(LCORE-212): add coverage');
    const res = prepr();
    const coverage = res.json.findings.filter((f) => f.check === 'tests.coverage');
    expect(coverage.map((f) => f.sub_rule)).toEqual(['not-measured']);
    expect(res.stderr).toMatch(
      /coverage-summary\.json is committed to the repository, so it is not coverage produced in this run/,
    );
  });

  it('uses a coverage summary the test run produced (not committed)', () => {
    repo.git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'test(LCORE-212): x');
    mkdirSync(join(repo.dir, 'coverage'), { recursive: true });
    writeFileSync(
      join(repo.dir, 'coverage', 'coverage-summary.json'),
      JSON.stringify({ total: { lines: { total: 10, covered: 1, pct: 10 } } }),
    );
    const coverage = prepr().json.findings.filter((f) => f.check === 'tests.coverage');
    expect(coverage.map((f) => f.sub_rule)).toEqual(['below-threshold']);
  });
});
