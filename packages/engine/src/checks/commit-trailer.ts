import type { AiRegistry, CheckDefinition, Finding, RunContext, ToolEntry } from '../types';

// C11-2 / R11-8: an AI-assisted commit names its tool, model and version in an
// Assisted-by trailer (AI Code Review implementation, section 2), and the tool
// and model are in the registry (R14-6). No trailer is not a finding: a commit
// without one is declared as written without AI assistance (P10), and the
// weekly reconciliation is the real check.

export const TRAILER = 'Assisted-by';
export const TRAILER_FORM = `${TRAILER}: <tool>, <model>, <version>`;
const TRAILER_LINE = /^Assisted-by:\s*(.*)$/i;
const CO_AUTHOR_LINE = /^Co-authored-by:\s*(.*)$/i;
const VERSION = /^v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/;
// `git commit -v` appends the diff below this line; git removes it, so do we.
const SCISSORS = /^# -+ >8 -+$/;

export interface TrailerValue {
  tool: string;
  model: string;
  version: string;
}

/** Message lines as git will store them: no comment lines, nothing below the scissors. */
export function messageLines(message: string): string[] {
  const lines: string[] = [];
  for (const raw of message.split(/\r?\n/)) {
    if (SCISSORS.test(raw)) break;
    if (!raw.startsWith('#')) lines.push(raw.trim());
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

export function toolForAlias(registry: AiRegistry, value: string): ToolEntry | undefined {
  const lower = value.toLowerCase();
  return registry.tools.find((t) => (t.trailer_aliases ?? []).some((a) => lower.includes(a.toLowerCase())));
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
    const parsed = parseTrailerValue(value);
    if (!parsed) {
      findings.push(
        error(
          'malformed',
          `"${TRAILER}: ${value}" is not in the form "${TRAILER_FORM}".`,
          `Write "${TRAILER_FORM}", e.g. "${TRAILER}: Cursor, gpt-5, 1.7.0".`,
          value,
        ),
      );
      continue;
    }
    const tool = findTool(registry, parsed.tool);
    if (!tool) {
      findings.push(
        error(
          'unregistered-tool',
          `AI tool "${parsed.tool}" is not in the AI registry.`,
          'Use an approved tool, or propose this one in registry/ai-registry.yaml (R14-6).',
          value,
        ),
      );
    } else if (tool.status === 'blocked' || tool.status === 'retired') {
      findings.push(
        error(
          'tool-not-approved',
          `AI tool "${tool.name}" is ${tool.status} in the AI registry.`,
          'Use an approved tool.',
          value,
        ),
      );
    } else if (!tool.models.includes('*') && !tool.models.some((m) => m.toLowerCase() === parsed.model.toLowerCase())) {
      findings.push(
        error(
          'model-not-approved',
          `Model "${parsed.model}" is not approved for ${tool.name}.`,
          `Approved models: ${tool.models.join(', ')}.`,
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
        fixHint: `Add "${TRAILER}: ${tool.name}, <model>, <version>"; set QA_ASSISTED_BY and the commit-msg hook adds it.`,
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
