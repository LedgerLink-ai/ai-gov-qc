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
    test: (cp) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069),
  },
  {
    rule: 'zero-width',
    label: 'zero-width character',
    test: (cp) => (cp >= 0x200b && cp <= 0x200d) || cp === 0x2060 || cp === 0xfeff || cp === 0x180e,
  },
  { rule: 'tag-character', label: 'Unicode tag character', test: (cp) => cp >= 0xe0000 && cp <= 0xe007f },
  { rule: 'soft-hyphen', label: 'soft hyphen', test: (cp) => cp === 0x00ad },
];

const PHRASES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: 'bypass-hooks', pattern: /--no-verify\b/i },
  {
    rule: 'disable-controls',
    pattern:
      /\b(?:skip|bypass|disable|turn off|comment out)\s+(?:the\s+|all\s+)?(?:tests?|lint(?:ing)?|checks?|hooks?|scans?|reviews?)\b/i,
  },
  { rule: 'disable-controls', pattern: /\bignore\s+(?:the\s+|all\s+)?(?:lint|tests?|checks?|findings?|warnings?)\b/i },
  {
    rule: 'override-instructions',
    pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions\b/i,
  },
];

const NEGATION = /\b(?:never|not|don't|do not|must not|mustn't|no)\b/i;
const ENCODED_BLOB = /[A-Za-z0-9+/]{120,}={0,2}/;

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** True when the phrase sits in a sentence that forbids it ("Never use --no-verify"). */
function isNegated(line: string, index: number): boolean {
  const before = line.slice(0, index);
  const sentence = before.split(/[.!?;]/).pop() ?? before;
  return NEGATION.test(sentence);
}

export function lintText(checkId: string, path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const seen = new Set<string>();
    let column = 0;
    for (const ch of line) {
      column++;
      const cp = ch.codePointAt(0) as number;
      if (cp === 0xfeff && i === 0 && column === 1) continue; // byte-order mark
      const cls = HIDDEN.find((h) => h.test(cp));
      if (!cls || seen.has(cls.rule)) continue;
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
    }

    for (const { rule, pattern } of PHRASES) {
      const m = pattern.exec(line);
      if (!m || isNegated(line, m.index)) continue;
      findings.push({
        checkId,
        ruleId: rule,
        level: 'error',
        path,
        line: lineNo,
        column: m.index + 1,
        message: `Instruction text tells agents to weaken a control: "${m[0]}".`,
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
        fingerprintBasis: `encoded-blob:${blob[0].length}`,
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
