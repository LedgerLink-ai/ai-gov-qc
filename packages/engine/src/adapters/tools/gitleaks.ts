import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ToolUnavailableError,
  type ChangedFile,
  type CheckDefinition,
  type Finding,
  type RunContext,
} from '../../types';
import type { ToolAdapter } from './index';
import { toolBinary } from '../../tools-home';
import { cachedVersion, versionIn, withCheckedFiles } from './workdir';

interface GitleaksResult {
  RuleID: string;
  Description?: string;
  File: string;
  StartLine?: number;
  StartColumn?: number;
}

const binary = (): string => toolBinary('gitleaks');

const version = cachedVersion(() => {
  const res = spawnSync(binary(), ['version'], { encoding: 'utf8' });
  return !res.error && res.status === 0 ? (versionIn(res.stdout) ?? res.stdout.trim()) : undefined;
}, binary);

/**
 * Scans exactly the changed files with LedgerLink's rules (config/gitleaks.toml:
 * the default rules plus private keys and BIP39 mnemonics), with redaction on.
 */
async function run(ctx: RunContext, def: CheckDefinition, files: ChangedFile[]): Promise<Finding[]> {
  if (!version())
    throw new ToolUnavailableError(
      'gitleaks',
      `"${binary()} version" did not run (run "qa setup", set QA_GITLEAKS_BIN or install gitleaks)`,
    );
  return withCheckedFiles(ctx, 'gitleaks', files, (work, src) => {
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
    const res = spawnSync(binary(), args, { cwd: src, encoding: 'utf8' });
    if (res.error || res.status !== 0) {
      throw new Error(
        `gitleaks failed (exit ${res.status}): ${(res.stderr || res.error?.message || '').trim().slice(0, 500)}`,
      );
    }
    const results = JSON.parse(readFileSync(report, 'utf8') || '[]') as GitleaksResult[];
    return results.map((r) => {
      const path = r.File.replace(/\\/g, '/').replace(/^\.\//, '');
      return {
        checkId: def.id,
        ruleId: r.RuleID,
        level: 'error' as const,
        path,
        line: r.StartLine,
        column: r.StartColumn,
        message: `Possible secret (${r.RuleID}${r.Description ? `: ${r.Description}` : ''}). The value is not shown.`,
        fixHint: 'Remove the value, rotate the credential (R22-10) and load it from the secrets manager.',
        fingerprintBasis: `${r.RuleID}:${r.StartLine ?? 0}`,
      };
    });
  });
}

export const gitleaks: ToolAdapter = { name: 'gitleaks', available: () => version() !== undefined, version, run };
