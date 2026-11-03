import type { CheckDefinition, Finding, RunContext } from '../types';
import { messageLines } from './commit-trailer';

// The commit message format of the AI Code Review implementation (section 2,
// commit-msg hook):
//
//   feat(payments): add idempotency key to refund endpoint
//
//   Refs: LL-1423
//   Assisted-by: <tool>, <model>, <version>    (AI-assisted commits only)
//
// This check covers the Conventional Commits header, the blank line after it
// and the Refs ticket line; commit.trailer covers Assisted-by. Messages git
// writes itself (merges, reverts, fixup!/squash!) are accepted as they are.

export const CONVENTIONAL_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];
const HEADER = /^([A-Za-z]+)(\([^()\s][^()]*\))?(!)?: (\S.*)$/;
const GENERATED = [
  /^Merge (?:branch|branches|pull request|remote-tracking branch|tag|commit) /,
  /^Revert "/,
  /^(?:fixup|squash|amend)! /,
];
const REFS_LINE = /^Refs:\s*(.*)$/i;
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;
const MAX_HEADER = 100;
const EXAMPLE = 'feat(payments): add idempotency key to refund endpoint';
export const FORMAT = `"<type>(<scope>): <summary>", a blank line, then "Refs: <TICKET-123>"`;

export function checkConventional(checkId: string, message: string): Finding[] {
  const lines = messageLines(message);
  const start = lines.findIndex((l) => l.length > 0);
  if (start === -1) return [];
  const header = lines[start];
  if (GENERATED.some((g) => g.test(header))) return [];
  const finding = (ruleId: string, level: Finding['level'], msg: string, fixHint: string): Finding => ({
    checkId,
    ruleId,
    level,
    message: msg,
    fixHint,
    fingerprintBasis: `${ruleId}:${header}`,
  });

  const findings: Finding[] = [];
  const m = HEADER.exec(header);
  if (!m) {
    findings.push(
      finding(
        'not-conventional',
        'error',
        `Commit header "${header}" is not in Conventional Commits form.`,
        `Write ${FORMAT}, e.g. "${EXAMPLE}". Types: ${CONVENTIONAL_TYPES.join(', ')}.`,
      ),
    );
  } else if (!CONVENTIONAL_TYPES.includes(m[1])) {
    findings.push(
      finding(
        'unknown-type',
        'error',
        `Commit type "${m[1]}" is not a Conventional Commits type.`,
        `Use one of: ${CONVENTIONAL_TYPES.join(', ')} (lower case).`,
      ),
    );
  }
  if (header.length > MAX_HEADER) {
    findings.push(
      finding(
        'header-too-long',
        'warning',
        `Commit header is ${header.length} characters; keep it to ${MAX_HEADER}.`,
        'Move the detail into the commit body.',
      ),
    );
  }

  const rest = lines.slice(start + 1);
  if (rest.length > 0 && rest[0] !== '') {
    findings.push(
      finding(
        'no-blank-line',
        'error',
        'The commit header is not followed by a blank line.',
        'Leave one empty line between the header and the body or the Refs line.',
      ),
    );
  }

  const refs = rest.map((l) => REFS_LINE.exec(l)?.[1]?.trim()).filter((v): v is string => v !== undefined);
  if (refs.length === 0) {
    findings.push(
      finding(
        'missing-ticket',
        'error',
        'The commit message has no "Refs: <TICKET-123>" line.',
        `Add a line "Refs: <ticket>" after a blank line, e.g. "Refs: LD-480". Format: ${FORMAT}.`,
      ),
    );
  }
  for (const value of refs) {
    const tickets = value.split(',').map((t) => t.trim());
    if (tickets.some((t) => !TICKET.test(t))) {
      findings.push(
        finding(
          'malformed-ticket',
          'error',
          `"Refs: ${value}" does not name tickets like LD-480.`,
          'Write "Refs: <PROJECT>-<number>", several separated by commas, e.g. "Refs: LD-480, LD-481".',
        ),
      );
    }
  }
  return findings;
}

export function commitConventional(ctx: RunContext, def: CheckDefinition): Finding[] {
  return ctx.commitMessage === undefined ? [] : checkConventional(def.id, ctx.commitMessage);
}
