import { createHash } from 'node:crypto';
import type { CheckDefinition, Finding, RunContext } from '../types';

// C14-4 / R14-8: AI instruction files must be plain visible text and must not
// tell agents to weaken controls.

interface HiddenClass {
  rule: string;
  label: string;
  test: (cp: number) => boolean;
}

const HIDDEN: HiddenClass[] = [
  {
    rule: 'bidi-control',
    label: 'bidirectional control',
    test: (cp) =>
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      cp === 0x200e ||
      cp === 0x200f ||
      cp === 0x061c,
  },
  {
    rule: 'zero-width',
    label: 'zero-width character',
    test: (cp) => (cp >= 0x200b && cp <= 0x200d) || cp === 0x2060 || cp === 0xfeff || cp === 0x180e,
  },
  {
    rule: 'invisible-character',
    label: 'invisible character',
    test: (cp) =>
      (cp >= 0x2061 && cp <= 0x2064) || // invisible mathematical operators
      cp === 0x3164 || // Hangul filler
      cp === 0x115f || // Hangul choseong filler
      cp === 0x1160 || // Hangul jungseong filler
      cp === 0xffa0 || // halfwidth Hangul filler
      cp === 0x034f || // combining grapheme joiner
      (cp >= 0x180b && cp <= 0x180f) || // Mongolian variation selectors (U+180E is matched above)
      (cp >= 0xfff9 && cp <= 0xfffb), // interlinear annotation
  },
  {
    rule: 'line-separator',
    label: 'Unicode line or paragraph separator',
    test: (cp) => cp === 0x2028 || cp === 0x2029,
  },
  { rule: 'tag-character', label: 'Unicode tag character', test: (cp) => cp >= 0xe0000 && cp <= 0xe007f },
  {
    rule: 'variation-selector',
    label: 'variation selector',
    test: (cp) => (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0xfe00 && cp <= 0xfe0f),
  },
  { rule: 'soft-hyphen', label: 'soft hyphen', test: (cp) => cp === 0x00ad },
];

const isBasicVs = (cp: number | undefined): boolean => cp !== undefined && cp >= 0xfe00 && cp <= 0xfe0f;
const EMOJI_BASE = /^(?:\p{Extended_Pictographic}|[0-9#*])$/u;

/**
 * One text- or emoji-presentation selector (U+FE0E, U+FE0F) right after an
 * emoji or a keycap digit is how ordinary emoji are written (a heart, a keycap one).
 * A run of selectors, or one anywhere else, can carry hidden data.
 */
function isEmojiPresentation(chars: string[], j: number): boolean {
  const cp = chars[j].codePointAt(0) as number;
  if (cp !== 0xfe0e && cp !== 0xfe0f) return false;
  const prev = chars[j - 1];
  if (prev === undefined || !EMOJI_BASE.test(prev)) return false;
  return !isBasicVs(chars[j + 1]?.codePointAt(0));
}

/** Imperative phrases that tell an agent to weaken a control. */
const PHRASES: Array<{ rule: string; pattern: RegExp }> = [
  // git accepts unambiguous abbreviations of long options: --no-veri, --no-verif.
  { rule: 'bypass-hooks', pattern: /--no-veri(?:fy?)?\b/i },
  // git commit -n (or -an, -nm ...) is --no-verify.
  { rule: 'bypass-hooks', pattern: /\bgit\s+(?:-c\s+\S+\s+)*commit\b[^\n]*?\s-[a-mo-zA-Z]*n[a-zA-Z]*\b/ },
  // pre-commit's SKIP=<hook,...> and husky's HUSKY=0 / HUSKY_SKIP_HOOKS=1.
  { rule: 'bypass-hooks', pattern: /\bSKIP=[\w,.-]+/ },
  { rule: 'bypass-hooks', pattern: /\bHUSKY=(?:0|false)\b|\bHUSKY_SKIP_HOOKS=(?:1|true)\b/i },
  { rule: 'bypass-hooks', pattern: /\bcore\.hooksPath\s*[= ]\s*(?:\/dev\/null|NUL\b|""|'')/i },
  {
    rule: 'disable-controls',
    pattern:
      /\b(?:skip|bypass|disable|turn off|comment out|deactivate|uninstall|circumvent|get around)\s+(?:the\s+|all\s+|any\s+|every\s+)?(?:(?:pre-commit|pre-push|commit-msg|git|husky|qa|ci|security|unit|failing)\s+)?(?:tests?|lint(?:ing|ers?)?|checks?|hooks?|scans?|scanners?|reviews?|ci)\b/i,
  },
  { rule: 'disable-controls', pattern: /\bignore\s+(?:the\s+|all\s+)?(?:lint|tests?|checks?|findings?|warnings?)\b/i },
  {
    rule: 'override-instructions',
    pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions\b/i,
  },
];

const NEGATION = /\b(?:never|not|don't|do not|must not|mustn't|no|cannot|can't)\b/i;
/** Where a clause starts: punctuation, or a conjunction that starts a new instruction. */
const CLAUSE_BREAK = /[.!?;:,\u2014\u2013]|\b(?:so|then|but|instead|otherwise|therefore)\b/gi;
const ENCODED_BLOB = /[A-Za-z0-9+/]{120,}={0,2}/;

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);

/** The clause the phrase at `index` sits in, up to the phrase. */
function clauseBefore(line: string, index: number): string {
  const before = line.slice(0, index);
  let start = 0;
  for (const m of before.matchAll(CLAUSE_BREAK)) start = (m.index ?? 0) + m[0].length;
  return before.slice(start);
}

/**
 * True when the phrase's own clause forbids it ("Never use --no-verify"). A
 * negation in an earlier clause does not count: "You do not need to wait for
 * CI, so skip the tests" is an instruction to skip them.
 */
function isNegated(line: string, index: number): boolean {
  return NEGATION.test(clauseBefore(line, index));
}

/** READMEs are documentation for people, linted with lower confidence than agent instruction files. */
export const isDocumentation = (path: string): boolean => /(?:^|\/)README(?:\.[^/]*)?\.md$/i.test(path);

export function lintText(checkId: string, path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const doc = isDocumentation(path);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const seen = new Set<string>();
    const chars = [...line];
    chars.forEach((ch, j) => {
      const column = j + 1;
      const cp = ch.codePointAt(0) as number;
      if (cp === 0xfeff && i === 0 && j === 0) return; // byte-order mark
      const cls = HIDDEN.find((h) => h.test(cp));
      if (!cls || seen.has(cls.rule)) return;
      if (cls.rule === 'variation-selector' && isEmojiPresentation(chars, j)) return;
      seen.add(cls.rule);
      findings.push({
        checkId,
        ruleId: cls.rule,
        level: 'error',
        path,
        line: lineNo,
        column,
        message: `Hidden ${cls.label} ${hex(cp)}. It can hide or reorder instructions so reviewers do not see what agents read.`,
        fixHint: 'Remove the character. Instruction files must be plain, visible text.',
        fingerprintBasis: `${cls.rule}:${hex(cp)}:${line.replace(/[^\x20-\x7e]/g, '')}`,
      });
    });

    for (const { rule, pattern } of PHRASES) {
      const m = pattern.exec(line);
      if (!m || isNegated(line, m.index)) continue;
      // In a README, "To skip the tests during a quick build, ..." describes; it does not instruct.
      if (doc && /\bto\s*$/i.test(clauseBefore(line, m.index))) continue;
      findings.push({
        checkId,
        ruleId: rule,
        level: doc ? 'warning' : 'error',
        path,
        line: lineNo,
        column: m.index + 1,
        message: `${doc ? 'Documentation' : 'Instruction'} text tells agents to weaken a control: "${m[0]}".`,
        fixHint: 'Remove the instruction. Agents must run every check and must not bypass hooks (R14-8).',
        fingerprintBasis: `${rule}:${m[0].toLowerCase()}`,
      });
    }

    const blob = ENCODED_BLOB.exec(line);
    if (blob) {
      findings.push({
        checkId,
        ruleId: 'encoded-blob',
        level: 'warning',
        path,
        line: lineNo,
        column: blob.index + 1,
        message: 'Long encoded blob in an instruction file. Its content cannot be reviewed by reading it.',
        fixHint: 'Replace it with plain text, or move it out of the instruction file.',
        fingerprintBasis: `encoded-blob:${sha(blob[0])}`,
      });
    }
  });
  return findings;
}

export function contentLint(ctx: RunContext, def: CheckDefinition): Finding[] {
  const findings: Finding[] = [];
  for (const file of ctx.filesFor(def)) {
    const text = ctx.source.read(file.path);
    if (text !== undefined) findings.push(...lintText(def.id, file.path, text));
  }
  return findings;
}
