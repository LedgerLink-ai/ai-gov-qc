import { analyseBranch } from '../conventions';
import { globMatcher } from '../tags';
import type { CheckDefinition, Finding, PrPolicy, RunContext } from '../types';
import { checkTrailers } from './commit-trailer';
import { branchFindings, conventions } from './conventions';

// Checks on the pull request as a whole (stage 3): run by "qa prepr" before a
// pull request is opened. Limits come from the `pr` section of policy.yaml.

const DEFAULT_PR_POLICY: PrPolicy = {
  diff_warn_lines: 1000,
  diff_ignore: ['**/yarn.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/*.snap'],
  coverage_min_lines: 80,
};

export const prPolicy = (ctx: RunContext): PrPolicy => ({ ...DEFAULT_PR_POLICY, ...ctx.config.policy.pr });

/** The branch name follows the branch convention (conventions.ts) and is not the base branch itself. */
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
        'Move the commits to a feature branch: git switch -c feature/<TICKET-123>-<short-description>',
      ),
    ];
  return branchFindings(def.id, analyseBranch(branch, conventions(ctx)));
}

/**
 * The Assisted-by trailer of every commit in the pull request, for its form
 * only. The subject is checked by pr.commit-messages. The pull request's
 * pr-rules job is what blocks.
 */
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
    for (const f of checkTrailers(def.id, commit.message, ctx.config.registry))
      findings.push({
        ...f,
        message: `Commit ${short}: ${f.message}`,
        fixHint:
          `${f.fixHint ?? ''} Fix it before pushing: git commit --amend for the last commit, else "git rebase -i ${ctx.pr.base}" and mark it "reword".`.trim(),
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
  // Size is advice, never a reason to block: a large pull request only gets a
  // warning, whatever the check's mode.
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
