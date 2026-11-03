import { globMatcher } from '../tags';
import type { CheckDefinition, Finding, PrPolicy, RunContext } from '../types';
import { checkConventional } from './commit-conventional';
import { checkTrailers } from './commit-trailer';

// Checks on the pull request as a whole (stage 3): run by "qa prepr" before a
// pull request is opened, and again by the PR gate. Limits come from the `pr`
// section of policy.yaml.

const DEFAULT_PR_POLICY: PrPolicy = {
  branch_pattern: '^(?:[A-Z][A-Z0-9]+-\\d+(?:[-_.][A-Za-z0-9._-]+)?|[a-z]+/[A-Za-z0-9._/-]+)$',
  diff_warn_lines: 400,
  diff_max_lines: 1000,
  diff_ignore: ['**/yarn.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/*.snap'],
  coverage_min_lines: 80,
};

export const prPolicy = (ctx: RunContext): PrPolicy => ({ ...DEFAULT_PR_POLICY, ...ctx.config.policy.pr });

/** The branch name: matches policy.pr.branch_pattern and is not the base branch itself. */
export function prBranchName(ctx: RunContext, def: CheckDefinition): Finding[] {
  if (!ctx.pr) return [];
  const { branch, base } = ctx.pr;
  const finding = (ruleId: string, message: string, fixHint: string): Finding => ({
    checkId: def.id,
    ruleId,
    level: 'error',
    message,
    fixHint,
    fingerprintBasis: `${ruleId}:${branch}`,
  });
  if (branch === 'HEAD')
    return [finding('detached-head', 'HEAD is detached; a pull request needs a branch.', 'git switch -c <branch>')];
  if (branch === base.replace(/^[^/]+\//, ''))
    return [
      finding(
        'base-branch',
        `You are on ${branch}, the branch the pull request merges into.`,
        'Move the commits to a feature branch: git switch -c <TICKET-123-short-description>',
      ),
    ];
  const pattern = prPolicy(ctx).branch_pattern;
  if (new RegExp(pattern).test(branch)) return [];
  return [
    finding(
      'branch-name',
      `Branch "${branch}" does not follow the naming rule.`,
      'Name it "<TICKET-123>-<short-description>" (LD-480-refund-key) or "<type>/<short-description>" (feat/refund-key), as policy.yaml pr.branch_pattern sets; rename with: git branch -m <new-name>',
    ),
  ];
}

/** Every commit in the pull request, with the same rules as the commit-msg hook. */
export function prCommits(ctx: RunContext, def: CheckDefinition): Finding[] {
  if (!ctx.pr) return [];
  if (ctx.pr.commits.length === 0)
    return [
      {
        checkId: def.id,
        ruleId: 'no-commits',
        level: 'error',
        message: `There are no commits between ${ctx.pr.base} and HEAD.`,
        fixHint: 'Commit the change first; uncommitted work is not part of a pull request.',
        fingerprintBasis: `no-commits:${ctx.pr.base}`,
      },
    ];
  const findings: Finding[] = [];
  for (const commit of ctx.pr.commits) {
    const short = commit.sha.slice(0, 7);
    const own = [
      ...checkConventional(def.id, commit.message),
      ...checkTrailers(def.id, commit.message, ctx.config.registry),
    ];
    for (const f of own)
      findings.push({
        ...f,
        message: `Commit ${short}: ${f.message}`,
        fixHint: `${f.fixHint ?? ''} Reword it with "git rebase -i ${ctx.pr.base}" (mark it "reword").`.trim(),
        fingerprintBasis: `${commit.sha}:${f.fingerprintBasis ?? f.ruleId}`,
      });
  }
  return findings;
}

/** Size of the change, without lockfiles and snapshots: big pull requests are hard to review. */
export function prDiffSize(ctx: RunContext, def: CheckDefinition): Finding[] {
  if (!ctx.pr) return [];
  const policy = prPolicy(ctx);
  const ignored = globMatcher(policy.diff_ignore);
  const counted = ctx.pr.diff.filter((d) => !ignored(d.path));
  const lines = counted.reduce((n, d) => n + d.added + d.deleted, 0);
  const summary = `${lines} changed lines in ${counted.length} files (lockfiles and snapshots not counted)`;
  const finding = (ruleId: string, level: Finding['level'], message: string): Finding => ({
    checkId: def.id,
    ruleId,
    level,
    message,
    fixHint: 'Split it into smaller pull requests that can be reviewed and reverted on their own.',
    fingerprintBasis: `${ruleId}:${ctx.pr?.branch}`,
  });
  if (lines > policy.diff_max_lines)
    return [finding('too-large', 'error', `The pull request has ${summary}; the limit is ${policy.diff_max_lines}.`)];
  if (lines > policy.diff_warn_lines)
    return [finding('large', 'warning', `The pull request has ${summary}; aim for under ${policy.diff_warn_lines}.`)];
  return [];
}

/** Line coverage of the test run that came before, from its json-summary files. */
export function testsCoverage(ctx: RunContext, def: CheckDefinition): Finding[] {
  if (!ctx.pr) return [];
  const min = prPolicy(ctx).coverage_min_lines;
  if (ctx.pr.coverage.length === 0)
    return [
      {
        checkId: def.id,
        ruleId: 'not-measured',
        level: 'note',
        message: 'No coverage summary was found, so coverage was not measured.',
        fixHint:
          'Run the tests with a json-summary coverage reporter (c8, nyc, Jest or Vitest) and pass the file with --coverage.',
        fingerprintBasis: 'not-measured',
      },
    ];
  const findings: Finding[] = [];
  for (const c of ctx.pr.coverage) {
    if (c.linesPct === undefined)
      findings.push({
        checkId: def.id,
        ruleId: 'no-lines',
        level: 'error',
        message: `${c.file} measured no lines: the tests did not load any source file.`,
        fixHint: "Check the coverage tool's include settings, and that the tests import the code they test.",
        path: c.file,
        fingerprintBasis: `no-lines:${c.file}`,
      });
    else if (c.linesPct < min)
      findings.push({
        checkId: def.id,
        ruleId: 'below-threshold',
        level: 'error',
        message: `Line coverage is ${c.linesPct}% in ${c.file}; the threshold is ${min}%.`,
        fixHint: 'Add tests for the changed code.',
        path: c.file,
        fingerprintBasis: `below-threshold:${c.file}`,
      });
  }
  return findings;
}
