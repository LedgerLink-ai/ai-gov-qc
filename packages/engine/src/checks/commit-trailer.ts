import type { AiRegistry, CheckDefinition, Finding, RunContext, ToolEntry } from '../types';

// C11-2 / R11-8: an AI-assisted commit names its tool, model and version in an
// Assisted-by trailer (AI Code Review implementation, section 2). Only the
// form is checked, as the pull request's pr-rules job does; whether the tool
// is approved is not a commit-message rule. No trailer is not a finding: a
// commit without one is declared as written without AI assistance (P10), and
// the weekly reconciliation is the real check.

export const TRAILER = 'Assisted-by';
export const TRAILER_FORM = `${TRAILER}: <tool>, <model>, <version>`;
const TRAILER_LINE = /^Assisted-by:\s*(.*)$/i;
const CO_AUTHOR_LINE = /^Co-authored-by:\s*(.*)$/i;
const VERSION = /^v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/;

/** git's default comment prefix (core.commentChar, core.commentString). */
export const DEFAULT_COMMENT = '#';
let commentPrefix = DEFAULT_COMMENT;

/**
 * The comment prefix messageLines uses when none is given. The commit-msg
 * hook sets it from the repository's core.commentChar before the message
 * checks run; everything else reads messages git already cleaned up.
 */
export function useCommentString(comment: string | undefined): void {
  commentPrefix = comment && comment.length > 0 ? comment : DEFAULT_COMMENT;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `git commit -v` appends the diff below this line ("# ---- >8 ----"); git removes it, so do we. */
export function scissorsLine(comment: string = DEFAULT_COMMENT): RegExp {
  return new RegExp(`^${escapeRe(comment)} -+ >8 -+$`);
}

export interface TrailerValue {
  tool: string;
  model: string;
  version: string;
}

/** Message lines as git will store them: no comment lines, nothing below the scissors. */
export function messageLines(message: string, comment: string = commentPrefix): string[] {
  const lines: string[] = [];
  const scissors = scissorsLine(comment);
  for (const raw of message.split(/\r?\n/)) {
    if (scissors.test(raw)) break;
    if (!raw.startsWith(comment)) lines.push(raw.trim());
  }
  return lines;
}

/** "<tool>, <model>, <version>", or undefined when the value is not in that form. */
export function parseTrailerValue(value: string): TrailerValue | undefined {
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => p.length === 0) || !VERSION.test(parts[2])) return undefined;
  const [tool, model, version] = parts;
  return { tool, model, version };
}

export function declaredTrailers(message: string): string[] {
  return messageLines(message)
    .map((l) => TRAILER_LINE.exec(l)?.[1]?.trim())
    .filter((v): v is string => v !== undefined);
}

/** A registry tool by id or display name, ignoring case ("claude-code", "Claude Code"). */
export function findTool(registry: AiRegistry, name: string): ToolEntry | undefined {
  const wanted = name.toLowerCase().replace(/\s+/g, '-');
  return registry.tools.find((t) => t.id === wanted || t.name.toLowerCase().replace(/\s+/g, '-') === wanted);
}

/**
 * The AI tool a Co-authored-by value ("Name <email>") names, by the tool's
 * trailer_aliases in the AI registry. An alias with an @ is an email address
 * and must equal the co-author's address. Any other alias is a bot or tool
 * name and must be a whole word of the co-author's name ("Copilot",
 * "copilot-swe-agent[bot]") or the login of a GitHub no-reply address
 * (123+Copilot@users.noreply.github.com). Part of a word never matches, so
 * "Jane Codexter" and bob@copilotlabs.io stay human co-authors.
 */
export function toolForAlias(registry: AiRegistry, value: string): ToolEntry | undefined {
  const text = value.trim();
  const angle = /^(.*?)\s*<([^<>]*)>$/.exec(text);
  const bareEmail = !angle && /^\S+@\S+$/.test(text);
  const name = (angle ? angle[1] : bareEmail ? '' : text).trim().toLowerCase();
  const email = (angle ? angle[2] : bareEmail ? text : '').trim().toLowerCase();
  const login = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/.exec(email)?.[1]?.replace(/\[bot\]$/, '');
  const matches = (raw: string): boolean => {
    const alias = raw.trim().toLowerCase();
    if (alias === '') return false;
    if (alias.includes('@')) return email === alias;
    if (login === alias) return true;
    return new RegExp(`(?:^|[^a-z0-9])${escapeRe(alias)}(?:$|[^a-z0-9])`).test(name);
  };
  return registry.tools.find((t) => (t.trailer_aliases ?? []).some(matches));
}

export function checkTrailers(checkId: string, message: string, registry: AiRegistry): Finding[] {
  const findings: Finding[] = [];
  const declared = declaredTrailers(message);
  const error = (ruleId: string, msg: string, fixHint: string, basis: string): Finding => ({
    checkId,
    ruleId,
    level: 'error',
    message: msg,
    fixHint,
    fingerprintBasis: basis,
  });

  for (const value of declared) {
    if (!parseTrailerValue(value)) {
      findings.push(
        error(
          'malformed',
          `"${TRAILER}: ${value}" is not in the form "${TRAILER_FORM}".`,
          `Write "${TRAILER_FORM}", e.g. "${TRAILER}: Cursor, gpt-5, 1.7.0".`,
          value,
        ),
      );
    }
  }

  if (declared.length === 0) {
    for (const line of messageLines(message)) {
      const co = CO_AUTHOR_LINE.exec(line)?.[1];
      const tool = co ? toolForAlias(registry, co) : undefined;
      if (!tool) continue;
      findings.push({
        checkId,
        ruleId: 'co-author-only',
        level: 'note',
        message: `AI use is declared through a Co-authored-by line (${tool.name}) but not through ${TRAILER}.`,
        fixHint: `Add "${TRAILER}: ${tool.name}, <model>, <version>". The prepare-commit-msg hook converts these lines; set your default with: git config --global ledgerlink.assistedBy "<tool>, <model>, <version>".`,
        fingerprintBasis: `co-author:${tool.id}`,
      });
      break;
    }
  }
  return findings;
}

export function commitTrailer(ctx: RunContext, def: CheckDefinition): Finding[] {
  return ctx.commitMessage === undefined ? [] : checkTrailers(def.id, ctx.commitMessage, ctx.config.registry);
}
