import { crossValidate } from '../src/config';
import {
  analyseBranch,
  conventionsFor,
  DEFAULT_CONVENTIONS,
  parseSubject,
  subjectRegex,
  templateProblems,
  type Conventions,
} from '../src/conventions';
import { run } from '../src/runner';
import type { Config, Policy, PrInfo } from '../src/types';
import { config, options } from './helpers';

// Ticket-based branch names and commit messages (AIQC-87).

const conv = (over: Partial<Conventions> = {}): Conventions => ({ ...DEFAULT_CONVENTIONS, ...over });

describe('branch names', () => {
  it('accepts <type>/<TICKET-123>-<description> and reads the type and key', () => {
    expect(analyseBranch('feature/LL-1234-user-authentication', conv())).toEqual({
      ok: true,
      branch: 'feature/LL-1234-user-authentication',
      type: 'feature',
      commitType: 'feat',
      ticket: 'LL-1234',
    });
    const types = (b: string) => {
      const a = analyseBranch(b, conv());
      return a.ok ? [a.commitType, a.ticket] : a;
    };
    expect(types('bugfix/LL-2345-fix-login-validation')).toEqual(['fix', 'LL-2345']);
    expect(types('hotfix/LL-3456-security-patch')).toEqual(['hotfix', 'LL-3456']);
    expect(types('feat/AIQC-87')).toEqual(['feat', 'AIQC-87']);
    expect(types('chore/LCORE2-9_tidy')).toEqual(['chore', 'LCORE2-9']);
  });

  it('refuses a branch without a ticket key, and says how to rename it', () => {
    for (const b of ['main', 'develop', 'feature/user-authentication', 'qa/quality-gates']) {
      const a = analyseBranch(b, conv());
      expect(a.ok).toBe(false);
      if (a.ok || a.exempt) continue;
      expect(a.ruleId).toBe('no-ticket');
      expect(a.message).toContain('feature/LCORE-1234-user-authentication');
      expect(a.fixHint).toMatch(/git branch -m feature\/<TICKET-123>-/);
      expect(a.fixHint).toContain('git switch -c feature/<TICKET-123>-<short-description>');
    }
  });

  it('refuses an incorrectly formatted ticket key, suggesting the right one', () => {
    // A rename that only changes case needs -M: on Windows and macOS, -m says the branch exists.
    for (const [b, suggestion, flag] of [
      ['feature/ll-1234-user-auth', 'feature/LL-1234-user-auth', '-M'],
      ['bugfix/LL1234-login', 'bugfix/LL-1234-login', '-m'],
      ['hotfix/LL_3456-patch', 'hotfix/LL-3456-patch', '-m'],
    ]) {
      const a = analyseBranch(b, conv());
      if (a.ok || a.exempt) throw new Error(`${b} accepted`);
      expect([a.ruleId, a.fixHint]).toEqual([
        'malformed-ticket',
        `Rename the branch: git branch ${flag} ${suggestion}`,
      ]);
    }
  });

  it('refuses a valid key without a known type, or not right after the type', () => {
    const cases: Array<[string, string, string]> = [
      ['LCORE-210-limit-invariants', 'it has no type', 'feature/LCORE-210-limit-invariants'],
      ['feature-LCORE-210-x', 'it has no type', 'feature/LCORE-210-x'],
      ['wip/LCORE-210-x', '"wip" is not a branch type', 'feature/LCORE-210-x'],
      ['bugfix/x-LCORE-210', 'the ticket key must come right after the type', 'bugfix/LCORE-210-short-description'],
    ];
    for (const [b, why, suggestion] of cases) {
      const a = analyseBranch(b, conv());
      if (a.ok || a.exempt) throw new Error(`${b} accepted`);
      expect(a.ruleId).toBe('format');
      expect(a.ticket).toBe('LCORE-210');
      expect(a.message).toContain(why);
      expect(a.fixHint).toBe(`Rename the branch: git branch -m ${suggestion}`);
    }
  });

  it('refuses a ticket from a project the repository does not accept', () => {
    const a = analyseBranch('feature/LWMNG-1-x', conv({ ticketProjects: ['LCORE'] }));
    expect(a.ok === false && !a.exempt && a.ruleId).toBe('unknown-project');
    expect(analyseBranch('feature/LCORE-1-x', conv({ ticketProjects: ['LCORE'] })).ok).toBe(true);
  });

  it('lets exempt branches through, and follows a configured ticket pattern and types', () => {
    expect(analyseBranch('release/2.0', conv({ exemptBranches: ['release/*'] }))).toEqual({
      ok: false,
      exempt: true,
      branch: 'release/2.0',
    });
    const github = conv({ ticketPattern: 'GH-\\d+', branchTypes: { story: 'feat' } });
    expect(analyseBranch('story/GH-12-dark-mode', github).ok).toBe(true);
    expect(analyseBranch('feature/GH-12-dark-mode', github).ok).toBe(false);
  });
});

describe('commit subjects', () => {
  it('match the template with a known type and a ticket key', () => {
    expect(parseSubject('feat(LL-1234): implement user authentication', conv())).toEqual({
      type: 'feat',
      ticket: 'LL-1234',
      description: 'implement user authentication',
    });
    for (const s of [
      'implement user authentication',
      'feat: implement user authentication',
      'feat(LL-1234):implement',
      'feat(LL-1234): ',
      'feature(LL-1234): x',
      'feat(ll-1234): x',
      'LL-1234: x',
    ])
      expect(parseSubject(s, conv())).toBeUndefined();
  });

  it('follow a repository template', () => {
    const c = conv({ commitTemplate: '{ticket}: ' });
    expect(parseSubject('LL-1234: Add retry', c)).toEqual({ ticket: 'LL-1234', description: 'Add retry' });
    expect(subjectRegex(c).test('feat(LL-1234): Add retry')).toBe(false);
  });

  it('templates name the ticket once', () => {
    expect(templateProblems('{type}({ticket}): ')).toEqual([]);
    expect(templateProblems('{type}: ')).toEqual(['must contain {ticket} exactly once']);
    expect(templateProblems('{type}{type}({ticket}) ')).toEqual(['may contain {type} at most once']);
  });
});

describe('configuration', () => {
  it('reads the defaults, policy.yaml and per-repository overrides, ticket projects included', () => {
    const policy = {
      ...config().policy,
      conventions: {
        commit_template: '{ticket}: ',
        ticket_projects: ['LCORE'],
        repos: { link_core: { exempt_branches: ['release/*'] }, Link_Verify: { ticket_projects: ['LVER'] } },
      },
    } as Policy;
    const c = conventionsFor(policy, 'link_core');
    expect([c.commitTemplate, c.exemptBranches, c.ticketProjects]).toEqual(['{ticket}: ', ['release/*'], ['LCORE']]);
    expect(conventionsFor(policy, 'link_verify').exemptBranches).toEqual([]);
    // Repository names compare without case, as qa validate does.
    expect(conventionsFor(policy, 'link_verify').ticketProjects).toEqual(['LVER']);
  });

  it('"qa validate" refuses a broken pattern, template or type mapping, and unknown repositories', () => {
    const base = config();
    const problems = (conventions: Policy['conventions']): string[] =>
      crossValidate({ ...(base as Omit<Config, 'hashes' | 'dir'>), policy: { ...base.policy, conventions } });
    expect(problems({ ticket_pattern: '[A-Z' })[0]).toMatch(/conventions.ticket_pattern is not a valid regular/);
    expect(problems({ ticket_pattern: '([A-Z]+)-\\d+' })).toEqual([
      'policy.yaml: conventions.ticket_pattern must not contain capturing groups; use (?:...)',
    ]);
    expect(problems({ ticket_pattern: '(?:[A-Z]+)-\\d+' })).toEqual([]);
    expect(problems({ commit_template: '{type}: ' })).toEqual([
      'policy.yaml: conventions.commit_template must contain {ticket} exactly once',
    ]);
    expect(problems({ branch_types: { story: 'story' } })).toEqual([
      'policy.yaml: conventions.branch_types.story is "story", which is not one of the commit_types',
    ]);
    // The default branch types (hotfix -> hotfix, ...) must fit a repository's own commit_types too.
    expect(problems({ repos: { link_core: { commit_types: ['feat', 'fix'] } } })).toEqual(
      expect.arrayContaining([
        'policy.yaml: conventions.repos.link_core.branch_types.hotfix is "hotfix", which is not one of the commit_types',
      ]),
    );
    expect(problems({ repos: { nowhere: {} } })).toEqual([
      'policy.yaml: conventions.repos.nowhere is not a repository in repositories.yaml',
    ]);
  });
});

describe('checks', () => {
  const blockAll: Policy = {
    ...config().policy,
    checks: {
      ...config().policy.checks,
      'branch.ticket': { mode: 'block' },
      'commit.message': { mode: 'block' },
      'pr.branch-name': { mode: 'block' },
      'pr.commit-messages': { mode: 'block' },
    },
  };
  const blocking = { ...config(), policy: blockAll };
  const findings = async (over: Parameters<typeof options>[1]) => {
    const result = await run(options({}, { config: blocking, stages: [0, 1, 3], ...over }));
    return {
      exitCode: result.exitCode,
      found: result.findings.map((f) => [f.checkId, f.ruleId, f.blocking]),
      result,
    };
  };

  it('branch.ticket: a valid ticket branch allows the commit', async () => {
    expect(await findings({ branch: 'feature/LCORE-1234-user-authentication' })).toMatchObject({
      exitCode: 0,
      found: [],
    });
  });

  it('branch.ticket: no key, or a malformed one, blocks the commit (block mode)', async () => {
    expect(await findings({ branch: 'main' })).toMatchObject({
      exitCode: 1,
      found: [['branch.ticket', 'no-ticket', true]],
    });
    expect(await findings({ branch: 'feature/lcore-1234-auth' })).toMatchObject({
      exitCode: 1,
      found: [['branch.ticket', 'malformed-ticket', true]],
    });
  });

  it('branch.ticket: report mode (the default) shows the finding without blocking', async () => {
    const result = await run(options({}, { branch: 'main', stages: [0, 1] }));
    expect(result.findings.map((f) => [f.checkId, f.blocking])).toEqual([['branch.ticket', false]]);
    expect(result.exitCode).toBe(0);
  });

  it('branch.ticket: a detached HEAD is a warning; without a branch the check is skipped', async () => {
    expect((await findings({ branch: 'HEAD' })).found).toEqual([['branch.ticket', 'detached-head', false]]);
    const result = await run(options({}, { config: blocking, stages: [0, 1] }));
    expect(result.checkRuns.find((r) => r.checkId === 'branch.ticket')).toMatchObject({
      status: 'skipped',
      reason: 'runs in the pre-commit hook, on the branch being committed to',
    });
  });

  it("commit.message: the subject follows the convention with the branch's ticket", async () => {
    const branch = 'bugfix/LCORE-2345-fix-login-validation';
    const ok = await findings({ branch, commitMessage: 'fix(LCORE-2345): resolve login validation issue\n' });
    expect(ok.found).toEqual([]);
    const off = await findings({ branch, commitMessage: 'resolve login validation issue\n' });
    expect(off.found).toEqual([['commit.message', 'format', true]]);
    expect(off.result.findings[0].fixHint).toContain('Write it as "fix(LCORE-2345): <description>"');
    const other = await findings({ branch, commitMessage: 'fix(LCORE-9): resolve it\n' });
    expect(other.found).toEqual([['commit.message', 'ticket-mismatch', true]]);
    expect(other.result.findings[0].message).toContain('the ticket key comes from the branch name');
  });

  it('commit.message: merges, fixups and genuine reverts are left to git', async () => {
    for (const commitMessage of [
      "Merge branch 'develop' into feature/LCORE-1-x\n",
      'fixup! feat(LCORE-1): x\n',
      'Revert "feat(LCORE-1): x"\n\nThis reverts commit 1234567890abcdef1234567890abcdef12345678.\n',
    ])
      expect((await findings({ branch: 'feature/LCORE-1-x', commitMessage })).found).toEqual([]);
  });

  it('commit.message: a hand-typed "Revert" without git\'s trailer is not exempt', async () => {
    const commitMessage = 'Revert "feat(LCORE-1): x"\n';
    expect((await findings({ branch: 'feature/LCORE-1-x', commitMessage })).found).toEqual([
      ['commit.message', 'format', true],
    ]);
  });

  it('commit.message: a hand-typed "Merge ..." subject that is not git\'s exact shape is not exempt', async () => {
    const commitMessage = "Merge branch 'main': actually add a backdoor\n";
    expect((await findings({ branch: 'feature/LCORE-1-x', commitMessage })).found).toEqual([
      ['commit.message', 'format', true],
    ]);
  });

  it('commit.message: without a branch (CI, --commit-msg-file) only the form and project are checked', async () => {
    expect((await findings({ commitMessage: 'feat(LWMNG-1): x\n' })).found).toEqual([]);
    expect((await findings({ commitMessage: 'x\n' })).found).toEqual([['commit.message', 'format', true]]);
  });

  const pr = (over: Partial<PrInfo>): PrInfo => ({
    base: 'origin/develop',
    branch: 'feature/LCORE-1-refund-key',
    commits: [],
    diff: [],
    coverage: [],
    ...over,
  });

  it('pr.branch-name and pr.commit-messages: every commit of the pull request, against its branch', async () => {
    const commits = [
      { sha: '1'.repeat(40), message: 'feat(LCORE-1): add key\n' },
      { sha: '2'.repeat(40), message: 'wip\n' },
      { sha: '3'.repeat(40), message: 'feat(LCORE-2): other ticket\n' },
    ];
    const { found, result } = await findings({ pr: pr({ commits }), stages: [3] });
    expect(found.filter(([c]) => String(c).startsWith('pr.branch') || c === 'pr.commit-messages')).toEqual([
      ['pr.commit-messages', 'format', true],
      ['pr.commit-messages', 'ticket-mismatch', true],
    ]);
    expect(
      result.findings.filter((f) => f.checkId === 'pr.commit-messages').map((f) => f.message.slice(0, 15)),
    ).toEqual(['Commit 2222222:', 'Commit 3333333:']);
    const badBranch = await findings({
      pr: pr({ branch: 'LCORE-1-refund-key', commits: [commits[0]] }),
      stages: [3],
    });
    expect(badBranch.found.filter(([c]) => c === 'pr.branch-name')).toEqual([['pr.branch-name', 'format', true]]);
  });
});
