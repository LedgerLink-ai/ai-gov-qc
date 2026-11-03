import { findTool, parseTrailerValue, toolForAlias, TRAILER, TRAILER_FORM } from './checks/commit-trailer';
import type { AiRegistry } from './types';

// The prepare-commit-msg hook (Development Guideline Policy, "Local hooks";
// AI Code Review implementation, section 2). It pre-fills the message and
// never rejects anything; the pull request checks the Assisted-by trailer.
//
//   - the ticket key from the branch name (LCORE-210-limit-invariants gives
//     "LCORE-210: "), unless the subject already starts with a key
//   - the developer's Assisted-by default (git config ledgerlink.assistedBy),
//     unless the message already has the trailer
//   - Co-authored-by trailers added by AI tools become Assisted-by
//
// Messages git writes itself are left alone: merges, squashes, amends and
// -c/-C reuse (the hook's source argument), and fixup!/squash!/amend! and
// Revert "..." subjects.

export interface PrepareInput {
  message: string;
  /** The hook's second argument: message, template, merge, squash, commit, or empty (editor). */
  source: string;
  branch: string;
  /** The developer's default, "<tool>, <model>, <version>". */
  assistedBy?: string;
  registry?: AiRegistry;
}

export interface PrepareResult {
  message: string;
  /** One line per change, printed by the hook so a -m commit shows what was added. */
  notes: string[];
}

const LEAVE_SOURCES = new Set(['merge', 'squash', 'commit']);
const GIT_SUBJECT = /^(?:(?:fixup|squash|amend)! |Revert ")/;
const KEY_IN_BRANCH = /(?:^|\/)([A-Z][A-Z0-9]+-\d+)(?=$|[-_./])/;
const KEY_AT_START = /^[A-Z][A-Z0-9]+-\d+\b/;
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s/;
const ASSISTED_LINE = /^Assisted-by:/i;
const CO_AUTHOR_LINE = /^Co-authored-by:\s*(.*)$/i;
const SCISSORS = /^# -+ >8 -+$/;

/** The ticket key in a branch name: LCORE-210-limit-invariants and feature/LCORE-210-x give LCORE-210. */
export function ticketFromBranch(branch: string): string | undefined {
  return KEY_IN_BRANCH.exec(branch)?.[1];
}

export function prepareMessage(input: PrepareInput): PrepareResult {
  const notes: string[] = [];
  if (LEAVE_SOURCES.has(input.source)) return { message: input.message, notes };

  const eol = input.message.includes('\r\n') ? '\r\n' : '\n';
  const lines = input.message.split(/\r?\n/);
  // Only the part git keeps is edited: comment lines and everything from the
  // scissors line down (git commit -v) stay exactly where they are.
  const cut = lines.findIndex((l) => SCISSORS.test(l));
  const end = cut === -1 ? lines.length : cut;
  const isContent = (i: number): boolean => i < end && !lines[i].startsWith('#');
  const contentIdx = lines.map((_, i) => i).filter(isContent);
  const subjectIdx = contentIdx.find((i) => lines[i].trim() !== '');
  if (subjectIdx !== undefined && GIT_SUBJECT.test(lines[subjectIdx].trim())) return { message: input.message, notes };

  // 1. Co-authored-by lines from AI tools become Assisted-by.
  const assistedBy = input.assistedBy?.trim();
  const defaultValue = assistedBy && parseTrailerValue(assistedBy) ? assistedBy : undefined;
  if (assistedBy && !defaultValue)
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

  // 2. The ticket key from the branch name.
  const key = ticketFromBranch(input.branch);
  if (key) {
    if (subjectIdx === undefined) {
      lines.splice(0, 0, `${key}: `);
      notes.push(`added "${key}: " from branch ${input.branch}`);
    } else if (!KEY_AT_START.test(lines[subjectIdx].trim())) {
      lines[subjectIdx] = `${key}: ${lines[subjectIdx].trim()}`;
      notes.push(`added "${key}: " from branch ${input.branch}`);
    }
  }

  // 3. The developer's Assisted-by default, when the message has none.
  const keptEnd = lines.findIndex((l) => SCISSORS.test(l));
  const hasAssisted = lines.some(
    (l, i) => (keptEnd === -1 || i < keptEnd) && !l.startsWith('#') && ASSISTED_LINE.test(l.trim()),
  );
  if (defaultValue && !hasAssisted && converted.length === 0) {
    addTrailer(lines, `${TRAILER}: ${defaultValue}`);
    notes.push(`added "${TRAILER}: ${defaultValue}"; delete it if no AI was used (git commit --amend)`);
  }

  return { message: lines.join(eol), notes };
}

/** Appends a trailer to the message's trailer block, or starts one after a blank line. */
function addTrailer(lines: string[], trailer: string): void {
  const cut = lines.findIndex((l) => SCISSORS.test(l));
  const end = cut === -1 ? lines.length : cut;
  let last = -1;
  for (let i = 0; i < end; i++) if (!lines[i].startsWith('#') && lines[i].trim() !== '') last = i;
  if (last === -1) {
    lines.splice(0, 0, '', trailer);
    return;
  }
  let first = last;
  while (first > 0 && !lines[first - 1].startsWith('#') && lines[first - 1].trim() !== '') first--;
  const block = lines.slice(first, last + 1);
  const inTrailerBlock = first > 0 && block.every((l) => TRAILER_LINE.test(l.trim()));
  lines.splice(last + 1, 0, ...(inTrailerBlock ? [trailer] : ['', trailer]));
}
