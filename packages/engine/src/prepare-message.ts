import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_COMMENT,
  findTool,
  parseTrailerValue,
  scissorsLine,
  toolForAlias,
  TRAILER,
  TRAILER_FORM,
} from './checks/commit-trailer';
import {
  analyseBranch,
  DEFAULT_CONVENTIONS,
  parseSubject,
  subjectPrefix,
  templateHasType,
  type Conventions,
} from './conventions';
import type { AiRegistry } from './types';

// The prepare-commit-msg hook (Development Guideline Policy, "Local hooks";
// AI Code Review implementation, section 2; AIQC-87). It pre-fills the
// message and never rejects anything; the pre-commit and commit-msg hooks and
// the pull request check it.
//
//   - the subject prefix from the branch name (conventions.ts):
//     feature/LCORE-210-limit-invariants gives "feat(LCORE-210): ", so the
//     ticket key is never typed twice. A subject that already follows the
//     convention is left alone; "fix: x" gains the key ("fix(LCORE-210): x");
//     "LCORE-210: x" gains the type
//   - the developer's Assisted-by default (git config ledgerlink.assistedBy),
//     unless the message already has the trailer; "none" means no AI tools
//   - Co-authored-by trailers added by AI tools become Assisted-by
//
// When it adds nothing it says why (the branch has no valid ticket key, no
// default set), so a message left as it was is not mistaken for a hook that
// did not run.
//
// Messages git writes itself are left alone: merges, squashes, amends and
// -c/-C reuse (the hook's source argument), fixup!/squash!/amend! and
// Revert "..." subjects, and every commit replayed by a rebase, cherry-pick or
// revert (git passes source "message" for those, so replayState below tells
// them apart), including any commit made on a detached HEAD.

export interface PrepareInput {
  message: string;
  /** The hook's second argument: message, template, merge, squash, commit, or empty (editor). */
  source: string;
  branch: string;
  /** The developer's default, "<tool>, <model>, <version>". */
  assistedBy?: string;
  registry?: AiRegistry;
  /** The repository's branch and commit conventions; the defaults when absent. */
  conventions?: Conventions;
  /** git's comment prefix (core.commentChar or core.commentString); "#" when absent. */
  comment?: string;
  /** Set (replayState) while git replays existing commits: the message is left exactly as it is. */
  replaying?: string;
}

/** The characters core.commentChar=auto picks from, in git's order. */
const AUTO_COMMENT_CHARS = ['#', ';', '@', '!', '$', '%', '^', '&', '|', ':'];

/**
 * The comment prefix git uses for this message, from the configured value
 * (core.commentChar / core.commentString; undefined when neither is set).
 * For "auto", git picks the first of # ; @ ! $ % ^ & | : that starts no line
 * of the message and comments its template with it, so: the prefix of the
 * scissors line, else of a line that is only a comment prefix (git's template
 * has one), else git's own rule applied to the message.
 */
export function commentFor(configured: string | undefined, message: string): string {
  if (configured === undefined || configured === '') return DEFAULT_COMMENT;
  if (configured.toLowerCase() !== 'auto') return configured;
  const lines = message.split(/\r?\n/);
  for (const c of AUTO_COMMENT_CHARS) if (lines.some((l) => scissorsLine(c).test(l))) return c;
  for (const c of AUTO_COMMENT_CHARS) if (lines.some((l) => l === c)) return c;
  return AUTO_COMMENT_CHARS.find((c) => !lines.some((l) => l.startsWith(c))) ?? DEFAULT_COMMENT;
}

const gitOut = (cwd: string, args: string[]): string | undefined => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && !r.error ? r.stdout : undefined;
};

/**
 * The repository's comment prefix for this message. core.commentChar and
 * core.commentString are the same setting to git; the last one set wins.
 */
export function gitCommentString(cwd: string, message: string): string {
  const out = gitOut(cwd, ['config', '--get-regexp', '^core\\.comment(char|string)$']) ?? '';
  const values = out
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => l.replace(/^\S+ ?/, ''));
  return commentFor(values.at(-1), message);
}

/** git's markers for a rebase, cherry-pick, revert or sequence of them in progress. */
const REPLAY_MARKERS = ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer'];

/**
 * Why git is replaying existing commits in the repository at cwd (a rebase,
 * cherry-pick or revert in progress, or a detached HEAD), else undefined.
 * Their messages are someone's finished work and are not pre-filled again.
 */
export function replayState(cwd: string): string | undefined {
  for (const marker of REPLAY_MARKERS) {
    const path = gitOut(cwd, ['rev-parse', '--git-path', marker])?.trim();
    if (path && existsSync(resolve(cwd, path))) return `${marker} in progress`;
  }
  const head = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true });
  if (head.status === 1) return 'HEAD is detached';
  return undefined;
}

export interface PrepareResult {
  message: string;
  /** One line per change, printed by the hook so a -m commit shows what was added. */
  notes: string[];
}

const LEAVE_SOURCES = new Set(['merge', 'squash', 'commit']);
/** The ledgerlink.assistedBy value for developers who do not use AI tools. */
export const NO_DEFAULT = 'none';
const GIT_SUBJECT = /^(?:(?:fixup|squash|amend)! |Revert ")/;
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s/;
const ASSISTED_LINE = /^Assisted-by:/i;
const CO_AUTHOR_LINE = /^Co-authored-by:\s*(.*)$/i;

/** The ticket key in a branch that follows the convention: feature/LCORE-210-x gives LCORE-210. */
export function ticketFromBranch(branch: string, conv: Conventions = DEFAULT_CONVENTIONS): string | undefined {
  const a = analyseBranch(branch, conv);
  return a.ok ? a.ticket : undefined;
}

/** A Conventional Commits subject without the ticket: "fix: x", "feat(api)!: x". */
const CONVENTIONAL = /^(?<type>[a-z][a-z0-9-]*)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<description>\S.*)$/;
/** A subject that starts with a bare ticket key: "LCORE-210: x" or "LCORE-210 x". */
const BARE_KEY = (conv: Conventions): RegExp =>
  new RegExp(`^(?<ticket>${conv.ticketPattern})(?::\\s*|\\s+)(?<description>\\S.*)$`);

export function prepareMessage(input: PrepareInput): PrepareResult {
  const notes: string[] = [];
  if (LEAVE_SOURCES.has(input.source) || input.replaying) return { message: input.message, notes };
  const comment = input.comment || DEFAULT_COMMENT;
  const scissors = scissorsLine(comment);

  const eol = input.message.includes('\r\n') ? '\r\n' : '\n';
  const lines = input.message.split(/\r?\n/);
  // Only the part git keeps is edited: comment lines and everything from the
  // scissors line down (git commit -v) stay exactly where they are.
  const cut = lines.findIndex((l) => scissors.test(l));
  const end = cut === -1 ? lines.length : cut;
  const isContent = (i: number): boolean => i < end && !lines[i].startsWith(comment);
  const contentIdx = lines.map((_, i) => i).filter(isContent);
  const subjectIdx = contentIdx.find((i) => lines[i].trim() !== '');
  if (subjectIdx !== undefined && GIT_SUBJECT.test(lines[subjectIdx].trim())) return { message: input.message, notes };

  // 1. Co-authored-by lines from AI tools become Assisted-by.
  const assistedBy = input.assistedBy?.trim();
  // "none": the developer does not use AI tools; no default and no reminder.
  const optedOut = assistedBy?.toLowerCase() === NO_DEFAULT;
  const defaultValue = assistedBy && parseTrailerValue(assistedBy) ? assistedBy : undefined;
  if (assistedBy && !optedOut && !defaultValue)
    notes.push(`ledgerlink.assistedBy "${assistedBy}" is not "${TRAILER_FORM}"; not used`);
  const converted: string[] = [];
  if (input.registry) {
    for (const i of contentIdx) {
      const who = CO_AUTHOR_LINE.exec(lines[i].trim())?.[1];
      const tool = who ? toolForAlias(input.registry, who) : undefined;
      if (!tool) continue;
      const fromDefault =
        defaultValue && findTool(input.registry, parseTrailerValue(defaultValue)?.tool ?? '')?.id === tool.id;
      const value = fromDefault ? defaultValue : `${tool.name}, <model>, <version>`;
      lines[i] = `${TRAILER}: ${value}`;
      converted.push(value);
      notes.push(
        fromDefault
          ? `converted the ${tool.name} Co-authored-by line to "${TRAILER}: ${value}"`
          : `converted the ${tool.name} Co-authored-by line to "${TRAILER}: ${value}"; fill in the model and version`,
      );
    }
  }

  // 2. The subject prefix from the branch name.
  const conv = input.conventions ?? DEFAULT_CONVENTIONS;
  const branch = input.branch === 'HEAD' ? undefined : analyseBranch(input.branch, conv);
  if (branch?.ok) {
    const prefix = subjectPrefix(conv, branch.commitType, branch.ticket);
    if (subjectIdx === undefined) {
      lines.splice(0, 0, prefix);
      notes.push(`added "${prefix}" from branch ${input.branch}`);
    } else {
      const subject = lines[subjectIdx].trim();
      const next = subjectFor(subject, conv, branch.commitType, branch.ticket);
      if (next !== undefined && next !== subject) {
        lines[subjectIdx] = next;
        notes.push(`added ticket ${branch.ticket} from branch ${input.branch}: "${next}"`);
      }
    }
  } else if (branch && !branch.ok && !branch.exempt) {
    // Said every time, so a message left as it was is not mistaken for a hook that did not run.
    notes.push(`no ticket key added: ${branch.message} ${branch.fixHint}`);
  }

  // 3. The developer's Assisted-by default, when the message has none.
  const keptEnd = lines.findIndex((l) => scissors.test(l));
  const hasAssisted = lines.some(
    (l, i) => (keptEnd === -1 || i < keptEnd) && !l.startsWith(comment) && ASSISTED_LINE.test(l.trim()),
  );
  if (defaultValue && !hasAssisted && converted.length === 0) {
    addTrailer(lines, `${TRAILER}: ${defaultValue}`, comment);
    notes.push(`added "${TRAILER}: ${defaultValue}"; delete it if no AI was used (git commit --amend)`);
  } else if (!assistedBy && !hasAssisted && converted.length === 0) {
    notes.push(
      `no ${TRAILER} added: no default set. Set it once: git config --global ledgerlink.assistedBy "<tool>, <model>, <version>" (or "${NO_DEFAULT}" if you do not use AI tools)`,
    );
  }

  return { message: lines.join(eol), notes };
}

/** Appends a trailer to the message's trailer block, or starts one after a blank line. */
function addTrailer(lines: string[], trailer: string, comment: string): void {
  const scissors = scissorsLine(comment);
  const cut = lines.findIndex((l) => scissors.test(l));
  const end = cut === -1 ? lines.length : cut;
  let last = -1;
  for (let i = 0; i < end; i++) if (!lines[i].startsWith(comment) && lines[i].trim() !== '') last = i;
  if (last === -1) {
    lines.splice(0, 0, '', trailer);
    return;
  }
  let first = last;
  while (first > 0 && !lines[first - 1].startsWith(comment) && lines[first - 1].trim() !== '') first--;
  const block = lines.slice(first, last + 1);
  const inTrailerBlock = first > 0 && block.every((l) => TRAILER_LINE.test(l.trim()));
  lines.splice(last + 1, 0, ...(inTrailerBlock ? [trailer] : ['', trailer]));
}

/**
 * The subject with the branch's type and ticket, or undefined to leave it as
 * the developer wrote it: it already follows the convention (with any key; the
 * commit-msg hook compares that key with the branch), or it names another
 * ticket or a scope of its own, which only the developer can resolve.
 */
function subjectFor(subject: string, conv: Conventions, type: string, ticket: string): string | undefined {
  if (parseSubject(subject, conv)) return undefined;
  // Only a prefix, with no description yet ("feat(LCORE-210):"): adding another would double it.
  if (parseSubject(`${subject.trimEnd()} x`, conv)?.description === 'x') return undefined;
  const conventional = templateHasType(conv) ? CONVENTIONAL.exec(subject)?.groups : undefined;
  if (conventional && conv.commitTypes.includes(conventional.type)) {
    if (conventional.scope !== undefined || conventional.bang) return undefined;
    return `${subjectPrefix(conv, conventional.type, ticket)}${conventional.description}`;
  }
  const bare = BARE_KEY(conv).exec(subject)?.groups;
  if (bare) return bare.ticket === ticket ? `${subjectPrefix(conv, type, ticket)}${bare.description}` : undefined;
  return `${subjectPrefix(conv, type, ticket)}${subject}`;
}
