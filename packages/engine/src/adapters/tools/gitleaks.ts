import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, scrubbedEnv, ToolTimeoutError } from '../../exec';
import { redact } from '../../redact';
import {
  ToolUnavailableError,
  type ChangedFile,
  type CheckDefinition,
  type Finding,
  type RunContext,
} from '../../types';
import type { ToolAdapter } from './index';
import { toolBinary } from '../../tools-home';
import { cachedVersion, hashFiles, versionIn, withCheckedFiles, PROBE_TIMEOUT_MS } from './workdir';

interface GitleaksResult {
  RuleID: string;
  Description?: string;
  File: string;
  StartLine?: number;
  StartColumn?: number;
}

const binary = (): string => toolBinary('gitleaks');

/**
 * The kind of secret in plain words, from Gitleaks' rule description
 * ("Uncovered a GitHub Personal Access Token, potentially leading to ..." gives
 * "GitHub Personal Access Token"); the rule id when there is no description.
 */
export function secretKind(r: Pick<GitleaksResult, 'RuleID' | 'Description'>): string {
  const kind = (r.Description ?? '')
    .replace(/^(?:uncovered|detected|discovered|identified|found|identifies|detects)\s+(?:an?\s+|the\s+)?/i, '')
    .split(/,|\s+(?:potentially|which|that could|allowing|that may|exposing)\s/i)[0]
    .replace(/[.\s]+$/, '')
    .trim();
  return kind || r.RuleID;
}

const version = cachedVersion(() => {
  const res = spawnSync(binary(), ['version'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    env: scrubbedEnv(),
    windowsHide: true,
  });
  return !res.error && res.status === 0 ? (versionIn(res.stdout) ?? res.stdout.trim()) : undefined;
}, binary);

/**
 * Scans exactly the changed files with LedgerLink's rules (config/gitleaks.toml:
 * the default rules plus private keys, BIP39 mnemonics and credentials in any
 * file), with redaction on. One finding per line: where several rules match
 * the same line, the most specific one is kept.
 */
async function run(ctx: RunContext, def: CheckDefinition, files: ChangedFile[]): Promise<Finding[]> {
  if (!version())
    throw new ToolUnavailableError(
      'gitleaks',
      `"${binary()} version" did not run (run "qa setup", set QA_GITLEAKS_BIN or install gitleaks)`,
    );
  return withCheckedFiles(ctx, 'gitleaks', files, async (work, src) => {
    const report = join(work, 'report.json');
    const args = [
      'dir',
      '.',
      '--report-format',
      'json',
      '--report-path',
      report,
      '--redact',
      '--no-banner',
      '--exit-code',
      '0',
    ];
    if (ctx.config.gitleaksConfig) args.push('--config', ctx.config.gitleaksConfig);
    const timeoutMs = ctx.timeoutFor(def);
    const res = await runProcess(binary(), args, { cwd: src, env: scrubbedEnv(), timeoutMs });
    if (res.timedOut) throw new ToolTimeoutError('gitleaks', timeoutMs);
    if (res.error || res.status !== 0) {
      throw new Error(
        `gitleaks failed (exit ${res.status}): ${redact((res.stderr || res.error?.message || '').trim()).slice(0, 500)}`,
      );
    }
    const results = onePerLine(JSON.parse(readFileSync(report, 'utf8') || '[]') as GitleaksResult[]);
    return results.map((r) => {
      const path = r.File.replace(/\\/g, '/').replace(/^\.\//, '');
      return {
        checkId: def.id,
        ruleId: r.RuleID,
        level: 'error' as const,
        path,
        line: r.StartLine,
        column: r.StartColumn,
        message: `Possible secret: ${secretKind(r)} (${r.RuleID}). The value is not shown.`,
        fixHint: 'Remove the value, rotate the credential (R22-10) and load it from the secrets manager.',
        fingerprintBasis: `${r.RuleID}:${r.StartLine ?? 0}`,
      };
    });
  });
}

/**
 * Rules that match any credential-shaped value. A line they report together
 * with a rule for a known kind of secret (aws-codeartifact-token, github-pat,
 * ...) is reported once, under that rule.
 */
const GENERAL_RULES = /^(?:generic-api-key|credential-.*|jwe-token)$/;

/**
 * Keeps one result per file and line: a specific rule over a general one, then
 * the first rule id in alphabetical order. Gitleaks reports in no fixed order,
 * and the choice must not depend on it (the rule id is part of the fingerprint).
 */
export function onePerLine<T extends { RuleID: string; File: string; StartLine?: number }>(results: T[]): T[] {
  const rank = (r: T): string => `${GENERAL_RULES.test(r.RuleID) ? 1 : 0}:${r.RuleID}`;
  const kept = new Map<string, T>();
  for (const r of results) {
    const key = `${r.File}:${r.StartLine ?? 0}`;
    const prev = kept.get(key);
    if (!prev || rank(r) < rank(prev)) kept.set(key, r);
  }
  return [...kept.values()].sort((a, b) =>
    a.File === b.File ? (a.StartLine ?? 0) - (b.StartLine ?? 0) : a.File < b.File ? -1 : 1,
  );
}

export const gitleaks: ToolAdapter = {
  name: 'gitleaks',
  available: () => version() !== undefined,
  version,
  rulesHash: (ctx) => hashFiles(ctx.config.gitleaksConfig ? [ctx.config.gitleaksConfig] : []),
  run,
};
