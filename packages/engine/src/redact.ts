import { isCredentialName } from './exec';

/**
 * Masks credentials in text before it is printed, logged, written to a report
 * or sent to the reporting endpoint. Checks never put secret values in their
 * messages; this is the second line of defence for text the engine does not
 * write itself: scanner error output, git errors, exception messages.
 */

const MASK = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // Private keys, PEM blocks of any kind.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // GitHub tokens (classic, fine-grained, OAuth, app, refresh).
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  // AWS access key ids and secret keys in key=value form.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g,
  /(aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{40}/gi,
  // Slack, npm, OpenAI/Anthropic-style and generic "sk-" keys.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Authorization headers.
  /(\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)?\s*)[^\s"',;]+/gi,
  /(\bbearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  // user:password@ in URLs.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+(@)/gi,
  // key=value where the key names a credential and the value looks like one:
  // 8+ characters with a digit, or 16+ characters (not an ordinary word).
  /(\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)(?:(?=[^\s"',;]*\d)[^\s"',;]{8,}|[^\s"',;]{16,})/gi,
];

const extraValues = new Set<string>();

/** Also mask this exact value wherever it appears (a token the engine itself was given). */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) extraValues.add(value);
}

function envSecrets(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && isCredentialName(name)) out.push(value);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `text` with every recognised credential replaced by [REDACTED]. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text;
  let out = text;
  // Exact values first, longest first, so a value containing another is masked whole.
  const values = [...new Set([...extraValues, ...envSecrets(env)])].sort((a, b) => b.length - a.length);
  for (const v of values) out = out.replace(new RegExp(escapeRegExp(v), 'g'), MASK);
  for (const p of PATTERNS) {
    out = out.replace(p, (_match: string, ...rest: unknown[]) => {
      // rest is the capture groups, then the offset and the whole input (no named groups here).
      const groups = rest.slice(0, -2) as Array<string | undefined>;
      // Patterns with a prefix group keep the prefix (and a trailing "@" group) and mask the rest.
      if (groups.length === 0) return MASK;
      return `${groups[0] ?? ''}${MASK}${groups[1] ?? ''}`;
    });
  }
  return out;
}

/** Redacts every string inside a JSON-compatible value. */
export function redactDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') return redact(value, env) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, env)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, env);
    return out as T;
  }
  return value;
}
