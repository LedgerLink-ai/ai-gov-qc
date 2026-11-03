import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EvaluatedFinding, RunResult } from './types';

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const FINGERPRINT_KEY = 'qaFingerprint/v1';
export const BASELINE_FILE = '.qa/baseline.sarif';

function messageText(f: EvaluatedFinding): string {
  return f.fixHint ? `${f.message} Fix: ${f.fixHint}` : f.message;
}

/** SARIF 2.1.0: the one report format every caller reads (Technical Design 10.4). */
export function toSarif(result: RunResult): object {
  const ran = new Set(result.checkRuns.filter((r) => r.status !== 'skipped').map((r) => r.checkId));
  const rules = result.checkDefinitions
    .filter((d) => ran.has(d.id) || result.findings.some((f) => f.checkId === d.id))
    .map((d) => ({
      id: d.id,
      name: d.id,
      shortDescription: { text: d.title },
      properties: {
        controls: d.controls,
        rules: d.rules,
        stage: d.stage,
        scope: d.scope,
        ...(d.source ? { source: d.source } : {}),
      },
    }));

  const results = result.findings.map((f) => ({
    ruleId: f.checkId,
    level: f.level,
    message: { text: messageText(f) },
    locations: f.path
      ? [
          {
            physicalLocation: {
              artifactLocation: { uri: f.path },
              ...(f.line ? { region: { startLine: f.line, ...(f.column ? { startColumn: f.column } : {}) } } : {}),
            },
          },
        ]
      : [],
    partialFingerprints: { [FINGERPRINT_KEY]: f.fingerprint },
    baselineState: f.suppressedBy === 'baseline' ? 'unchanged' : 'new',
    ...(f.suppressedBy === 'exemption'
      ? { suppressions: [{ kind: 'external', status: 'accepted', justification: f.suppressionNote }] }
      : {}),
    properties: {
      subRule: f.ruleId,
      blocking: f.blocking,
      mode: f.effectiveMode,
      controls: f.controls,
      rules: f.rules,
      ...(f.suppressionNote ? { note: f.suppressionNote } : {}),
    },
  }));

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'ledgerlink-qa', version: result.engineVersion, rules } },
        automationDetails: { id: `qa/${result.repo}/${result.sha}` },
        invocations: [
          {
            executionSuccessful: result.engineErrors.length === 0,
            exitCode: result.exitCode,
            toolExecutionNotifications: result.checkRuns
              .filter((r) => r.status === 'skipped' || r.status === 'error')
              .map((r) => ({
                level: r.status === 'error' ? 'error' : 'note',
                message: { text: `${r.checkId}: ${r.status}${r.reason ? ` (${r.reason})` : ''}` },
              })),
          },
        ],
        results,
      },
    ],
  };
}

/** Run metadata for the evidence store; findings themselves live in SARIF. */
export function toEvidence(result: RunResult): object {
  return {
    schema: 'ledgerlink-qa/evidence/v1',
    engine_version: result.engineVersion,
    config_hashes: result.configHashes,
    repo: result.repo,
    sha: result.sha,
    actor: result.actor,
    mode: result.mode,
    as_of: result.asOf,
    started_at: result.startedAt,
    duration_ms: result.durationMs,
    tags: result.tags,
    files_checked: result.files.length,
    checks: result.checkRuns.map((r) => ({
      id: r.checkId,
      status: r.status,
      duration_ms: r.durationMs,
      findings: r.findings,
      ...(r.reason ? { reason: r.reason } : {}),
    })),
    summary: summarise(result),
    engine_errors: result.engineErrors,
    exit_code: result.exitCode,
    ai_calls: [],
  };
}

export function summarise(result: RunResult): Record<string, number> {
  return {
    findings: result.findings.length,
    blocking: result.findings.filter((f) => f.blocking).length,
    baselined: result.findings.filter((f) => f.suppressedBy === 'baseline').length,
    exempted: result.findings.filter((f) => f.suppressedBy === 'exemption').length,
  };
}

export function toJson(result: RunResult): object {
  return {
    engine_version: result.engineVersion,
    repo: result.repo,
    sha: result.sha,
    actor: result.actor,
    mode: result.mode,
    as_of: result.asOf,
    tags: result.tags,
    exit_code: result.exitCode,
    summary: summarise(result),
    findings: result.findings.map((f) => ({
      check: f.checkId,
      sub_rule: f.ruleId,
      level: f.level,
      blocking: f.blocking,
      mode: f.effectiveMode,
      path: f.path,
      line: f.line,
      column: f.column,
      message: f.message,
      fix: f.fixHint,
      controls: f.controls,
      rules: f.rules,
      fingerprint: f.fingerprint,
      suppressed_by: f.suppressedBy,
      note: f.suppressionNote,
    })),
    checks: result.checkRuns,
    engine_errors: result.engineErrors,
  };
}

export function toText(result: RunResult): string {
  const lines: string[] = [];
  lines.push(
    `qa ${result.engineVersion} | repo ${result.repo} | actor ${result.actor} | mode ${result.mode} | as of ${result.asOf}`,
  );
  lines.push(`tags: ${result.tags.length > 0 ? result.tags.join(', ') : '(none)'} | files: ${result.files.length}`);
  const order = (f: EvaluatedFinding): number =>
    f.blocking ? 0 : f.level === 'error' ? 1 : f.level === 'warning' ? 2 : 3;
  const scopeOf = new Map(result.checkDefinitions.map((d) => [d.id, d.scope]));
  for (const f of [...result.findings].sort((a, b) => order(a) - order(b))) {
    const label = f.blocking ? 'BLOCK ' : f.level === 'note' ? 'NOTE  ' : 'REPORT';
    const whole = scopeOf.get(f.checkId) === 'pr' ? '(pull request)' : '(commit)';
    const where = f.path ? `${f.path}${f.line ? `:${f.line}${f.column ? `:${f.column}` : ''}` : ''}` : whole;
    const ids = [...f.controls, ...f.rules].join(', ');
    lines.push(`  ${label} ${f.checkId}  ${where}  ${f.message}${ids ? ` [${ids}]` : ''}`);
    if (f.fixHint) lines.push(`         fix: ${f.fixHint}`);
    if (f.suppressionNote) lines.push(`         ${f.suppressionNote}`);
  }
  const count = (s: string): number => result.checkRuns.filter((r) => r.status === s).length;
  lines.push(
    `checks: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped, ${count('error')} errors`,
  );
  for (const r of result.checkRuns.filter((r) => r.status === 'skipped' || r.status === 'error')) {
    lines.push(`  ${r.status === 'error' ? 'ERROR ' : 'skip  '} ${r.checkId}: ${r.reason ?? ''}`);
  }
  const s = summarise(result);
  const verdict =
    result.exitCode === 2
      ? 'ENGINE ERROR (treated as a failure)'
      : result.exitCode === 1
        ? `BLOCKED (${s.blocking} blocking)`
        : 'PASS';
  lines.push(`result: ${verdict}`);
  return lines.join('\n');
}

/**
 * Whether a git hook should print anything. A clean run stays silent; a run
 * with findings, an engine error, or a check deferred to CI (tool missing,
 * time budget used) is shown, so the developer knows what CI will see.
 */
export function worthShowing(result: RunResult): boolean {
  return (
    result.findings.length > 0 ||
    result.exitCode !== 0 ||
    result.checkRuns.some((r) => r.status === 'error' || (r.status === 'skipped' && r.reason?.includes('; runs in CI')))
  );
}

export function writeOutputs(result: RunResult, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.sarif'), JSON.stringify(toSarif(result), null, 2));
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(toEvidence(result), null, 2));
}

export function readBaseline(root: string): Set<string> {
  const file = join(root, BASELINE_FILE);
  const set = new Set<string>();
  if (!existsSync(file)) return set;
  const log = JSON.parse(readFileSync(file, 'utf8')) as {
    runs?: Array<{ results?: Array<{ partialFingerprints?: Record<string, string> }> }>;
  };
  for (const r of log.runs ?? []) {
    for (const res of r.results ?? []) {
      const fp = res.partialFingerprints?.[FINGERPRINT_KEY];
      if (fp) set.add(fp);
    }
  }
  return set;
}

export function writeBaseline(root: string, result: RunResult): string {
  const file = join(root, BASELINE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(toSarif(result), null, 2) + '\n');
  return file;
}
