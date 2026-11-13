import { createHash } from 'node:crypto';
import { globMatcher } from './tags';
import type { Exemption, Finding, Policy, PolicyMode } from './types';

/** Today's date in local time, as YYYY-MM-DD. */
export function today(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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
    if (ex.repo !== '*' && ex.repo !== repo) continue;
    // A finding on the pull request as a whole (title, description, size) has
    // no path; only an exemption whose path is "*" covers it.
    if (finding.path ? !globMatcher([ex.path])(finding.path) : ex.path !== '*') continue;
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
