import { spawnSync } from 'node:child_process';
import {
  ToolUnavailableError,
  type ChangedFile,
  type CheckDefinition,
  type Finding,
  type Level,
  type RunContext,
} from '../../types';
import type { ToolAdapter } from './index';
import { toolBinary } from '../../tools-home';
import { cachedVersion, versionIn, withCheckedFiles } from './workdir';

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  extra: { message: string; severity: string; lines?: string };
}

interface SemgrepOutput {
  results: SemgrepResult[];
  errors: Array<{ level?: string; message?: string; long_msg?: string; type?: string }>;
}

const binary = (): string => toolBinary('semgrep');

const LEVELS: Record<string, Level> = { ERROR: 'error', WARNING: 'warning', INFO: 'note' };

const version = cachedVersion(() => {
  const res = spawnSync(binary(), ['--version'], { encoding: 'utf8' });
  return !res.error && res.status === 0 ? (versionIn(res.stdout) ?? res.stdout.trim()) : undefined;
}, binary);

/**
 * The fast rule set (config/semgrep), run at pre-push and in CI. Rules are
 * local files, so the run needs no network, login or metrics.
 */
async function run(ctx: RunContext, def: CheckDefinition, files: ChangedFile[]): Promise<Finding[]> {
  if (!version())
    throw new ToolUnavailableError(
      'semgrep',
      `"${binary()} --version" did not run (run "qa setup", set QA_SEMGREP_BIN or install semgrep)`,
    );
  if (!ctx.config.semgrepConfig) throw new Error('config/semgrep is missing from the qa configuration');
  const rules = ctx.config.semgrepConfig;
  return withCheckedFiles(ctx, 'semgrep', files, (_work, src) => {
    const res = spawnSync(
      binary(),
      ['scan', '--config', rules, '--json', '--metrics=off', '--disable-version-check', '--quiet', '.'],
      { cwd: src, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SEMGREP_SEND_METRICS: 'off' } },
    );
    let out: SemgrepOutput | undefined;
    try {
      out = JSON.parse(res.stdout) as SemgrepOutput;
    } catch {
      out = undefined;
    }
    const fatal = out?.errors.filter((e) => e.level === 'error') ?? [];
    if (res.error || !out || res.status !== 0 || fatal.length > 0) {
      const detail = fatal.map((e) => e.long_msg ?? e.message ?? e.type).join('; ') || res.stderr || res.error?.message;
      throw new Error(`semgrep failed (exit ${res.status}): ${(detail ?? '').trim().slice(0, 500)}`);
    }
    return out.results.map((r) => {
      const ruleId = r.check_id.split('.').pop() as string;
      return {
        checkId: def.id,
        ruleId,
        level: LEVELS[r.extra.severity] ?? 'warning',
        path: r.path.replace(/\\/g, '/').replace(/^\.\//, ''),
        line: r.start.line,
        column: r.start.col,
        message: r.extra.message.trim(),
        fingerprintBasis: `${ruleId}:${(r.extra.lines ?? String(r.start.line)).replace(/\s+/g, ' ').trim()}`,
      };
    });
  });
}

export const semgrep: ToolAdapter = { name: 'semgrep', available: () => version() !== undefined, version, run };
