import {
  analyseBranch,
  branchForm,
  conventionsFor,
  parseSubject,
  subjectForm,
  subjectPrefix,
  ticketProject,
  type BranchAnalysis,
  type Conventions,
} from '../conventions';
import type { CheckDefinition, Finding, RunContext } from '../types';
import { messageLines } from './commit-trailer';

// Ticket-based branch names and commit messages (AIQC-87): the checks.
//
//   branch.ticket        the current branch carries a valid ticket key (pre-commit)
//   commit.message       the subject follows the convention and names the
//                        branch's ticket (commit-msg)
//   pr.commit-messages   the same for every commit of a pull request (qa prepr
//                        and the PR gate, where local hooks cannot be skipped)
//
// The key is read from the branch, never trusted from the message.

const MAX_QUOTED = 120;
/** Subjects git writes itself: merges, fixups, reverts. */
const GIT_SUBJECT =
  /^(?:Merge (?:branch|remote-tracking branch|pull request|tag|commit) |(?:fixup|squash|amend)! |Revert ")/;

const quote = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_QUOTED ? `${one.slice(0, MAX_QUOTED - 3)}...` : one;
};

export const conventions = (ctx: RunContext): Conventions => conventionsFor(ctx.config.policy, ctx.repo);

/** Findings for a branch that does not follow the convention; none for a valid or exempt one. */
export function branchFindings(checkId: string, analysis: BranchAnalysis): Finding[] {
  if (analysis.ok || analysis.exempt) return [];
  return [
    {
      checkId,
      ruleId: analysis.ruleId,
      level: 'error',
      message: analysis.message,
      fixHint: analysis.fixHint,
      fingerprintBasis: `${analysis.ruleId}:${analysis.branch}`,
    },
  ];
}

/** The branch being committed to has a valid ticket key (the pre-commit hook). */
export function branchTicket(ctx: RunContext, def: CheckDefinition): Finding[] {
  if (ctx.branch === undefined) return [];
  if (ctx.branch === 'HEAD')
    return [
      {
        checkId: def.id,
        ruleId: 'detached-head',
        level: 'warning',
        message: 'HEAD is detached, so the ticket key cannot be read from a branch name.',
        fixHint: `Commit on a branch named ${branchForm(conventions(ctx))}: git switch -c <branch>`,
        fingerprintBasis: 'detached-head',
      },
    ];
  return branchFindings(def.id, analyseBranch(ctx.branch, conventions(ctx)));
}

/**
 * One commit message against the convention. With a valid branch, its subject
 * must carry that branch's ticket key; without one (a CI run given only the
 * message), the key's project is checked instead.
 */
export function checkCommitMessage(
  checkId: string,
  message: string,
  conv: Conventions,
  branch?: BranchAnalysis,
): Finding[] {
  const subject = messageLines(message).find((l) => l !== '');
  if (subject === undefined || GIT_SUBJECT.test(subject)) return [];
  const valid = branch?.ok ? branch : undefined;
  const expected = valid ? `${subjectPrefix(conv, valid.commitType, valid.ticket)}<description>` : subjectForm(conv);
  const finding = (ruleId: string, text: string, fixHint: string): Finding => ({
    checkId,
    ruleId,
    level: 'error',
    message: text,
    fixHint,
    fingerprintBasis: `${ruleId}:${subject}`,
  });
  const parsed = parseSubject(subject, conv);
  if (!parsed)
    return [
      finding(
        'format',
        `The commit subject "${quote(subject)}" does not follow the convention ${subjectForm(conv)} (types: ${conv.commitTypes.join(', ')}).`,
        `Write it as "${expected}"; the prepare-commit-msg hook fills in the prefix from the branch name.`,
      ),
    ];
  if (valid && parsed.ticket !== valid.ticket)
    return [
      finding(
        'ticket-mismatch',
        `The commit subject names ticket ${parsed.ticket}, but branch "${valid.branch}" is for ${valid.ticket}; the ticket key comes from the branch name.`,
        `Write "${expected}", or commit on the branch for ${parsed.ticket}.`,
      ),
    ];
  if (!valid && conv.ticketProjects.length > 0 && !conv.ticketProjects.includes(ticketProject(parsed.ticket)))
    return [
      finding(
        'unknown-project',
        `The commit subject names ticket ${parsed.ticket}, but ${ticketProject(parsed.ticket)} is not an accepted ticket project here (${conv.ticketProjects.join(', ')}).`,
        `Use a ticket from ${conv.ticketProjects.join(', ')}.`,
      ),
    ];
  return [];
}

/** The commit message being written (the commit-msg hook, or --commit-msg-file). */
export function commitMessage(ctx: RunContext, def: CheckDefinition): Finding[] {
  if (ctx.commitMessage === undefined) return [];
  const conv = conventions(ctx);
  const branch = ctx.branch && ctx.branch !== 'HEAD' ? analyseBranch(ctx.branch, conv) : undefined;
  const findings = checkCommitMessage(def.id, ctx.commitMessage, conv, branch);
  // In the hook, git keeps the refused message; say how to get it back.
  if (ctx.branch === undefined) return findings;
  return findings.map((f) => ({
    ...f,
    fixHint: `${f.fixHint} To edit the refused message: git commit -e -F "$(git rev-parse --git-path COMMIT_EDITMSG)"`,
  }));
}

/** Every commit of the pull request (scope pr). */
export function prCommitMessages(ctx: RunContext, def: CheckDefinition): Finding[] {
  if (!ctx.pr) return [];
  const conv = conventions(ctx);
  const branch = ctx.pr.branch !== 'HEAD' ? analyseBranch(ctx.pr.branch, conv) : undefined;
  const findings: Finding[] = [];
  for (const commit of ctx.pr.commits) {
    const short = commit.sha.slice(0, 7);
    for (const f of checkCommitMessage(def.id, commit.message, conv, branch))
      findings.push({
        ...f,
        message: `Commit ${short}: ${f.message}`,
        fixHint: `${f.fixHint} Fix it before pushing: git commit --amend for the last commit, else "git rebase -i ${ctx.pr.base}" and mark it "reword".`,
        fingerprintBasis: `${commit.sha}:${f.fingerprintBasis ?? f.ruleId}`,
      });
  }
  return findings;
}
