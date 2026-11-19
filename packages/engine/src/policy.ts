import { createHash } from 'node:crypto';
import { globMatcher } from './tags';
import type { Exemption, Finding, Policy, PolicyMode } from './types';

/**
 * Today's date in UTC, as YYYY-MM-DD: every machine and CI agree on when a
 * block_from date or an exemption's expiry is reached, whatever their time zone.
 */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** True for YYYY-MM-DD naming a real calendar date (not 2026-02-31 or 9999-99-99). */
export function isCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** A check reports until its block_from date, then blocks (P9). */
export function effectiveMode(policy: Policy, checkId: string, asOf: string): PolicyMode {
  const entry = policy.checks[checkId];
  const mode = entry?.mode ?? policy.defaults.mode;
  if (mode === 'off') return 'off';
  if (entry?.block_from && asOf >= entry.block_from) return 'block';
  return mode;
}

export function findExemption(
  exemptions: Exemption[],
  repo: string,
  finding: Finding,
  asOf: string,
): { active?: Exemption; expired?: Exemption } {
  let expired: Exemption | undefined;
  for (const ex of exemptions) {
    if (ex.check !== finding.checkId) continue;
    // GitHub names are case-insensitive; the origin URL may spell one differently.
    if (ex.repo !== '*' && ex.repo.toLowerCase() !== repo.toLowerCase()) continue;
    if (!finding.path || !globMatcher([ex.path])(finding.path)) continue;
    if (ex.expires >= asOf) return { active: ex };
    expired = ex;
  }
  return { expired };
}

/**
 * Stable identity of a finding across runs: check, sub-rule, path and the
 * finding's own basis (normalised content), but not the line number, so a
 * baselined finding stays baselined when code above it moves.
 */
export function fingerprint(f: Finding): string {
  const basis = (f.fingerprintBasis ?? f.message).replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update([f.checkId, f.ruleId ?? '', f.path ?? '', basis].join('\0'))
    .digest('hex')
    .slice(0, 32);
}
