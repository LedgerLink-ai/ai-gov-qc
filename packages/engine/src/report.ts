import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { redact, redactDeep } from './redact';
import { ConfigError, type EvaluatedFinding, type RunResult } from './types';

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const FINGERPRINT_KEY = 'qaFingerprint/v1';
export const BASELINE_FILE = '.qa/baseline.sarif';

function messageText(f: EvaluatedFinding): string {
  return redact(f.fixHint ? `${f.message} Fix: ${f.fixHint}` : f.message);
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
                message: { text: redact(`${r.checkId}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`) },
              })),
          },
        ],
        results,
      },
    ],
  };
}

/**
 * Run metadata for the evidence store and central reporting; findings
 * themselves live in SARIF. Schema v1 fields are unchanged; later fields are
 * additions only, so v1 readers keep working.
 */
export function toEvidence(result: RunResult, extra: { runId?: string } = {}): object {
  return redactDeep({
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
      ...(r.mode ? { mode: r.mode } : {}),
      ...(r.toolVersion ? { tool_version: r.toolVersion } : {}),
      ...(r.cachedFiles !== undefined ? { cached_files: r.cachedFiles } : {}),
    })),
    summary: summarise(result),
    engine_errors: result.engineErrors,
    exit_code: result.exitCode,
    ai_calls: [],
    // Additions (issue #15).
    ...(extra.runId ? { run_id: extra.runId } : {}),
    profiles: profiles(result),
    failed_validations: failedValidations(result),
    host: { os: platform(), arch: arch(), node: process.versions.node },
    ...(result.cache ? { cache: result.cache } : {}),
  });
}

/**
 * The profiles a run had on: the technology and risk tags of the changed
 * files (path-tags.yaml), the stages it covered, and every check that was
 * switched on, with the mode it ran in.
 */
export function profiles(result: RunResult): object {
  return {
    tags: result.tags,
    stages: result.stages ?? [0, 1, 2, 3],
    enabled_checks: result.checkRuns
      .filter((r) => r.mode !== 'off')
      .map((r) => ({ id: r.checkId, mode: r.mode ?? 'report', ran: r.status !== 'skipped' })),
  };
}

/** What failed: blocking findings, and checks that could not run. */
export function failedValidations(result: RunResult): object[] {
  return [
    ...result.findings
      .filter((f) => f.blocking)
      .map((f) => ({
        kind: 'finding',
        check: f.checkId,
        sub_rule: f.ruleId,
        path: f.path,
        line: f.line,
        fingerprint: f.fingerprint,
        controls: f.controls,
        rules: f.rules,
      })),
    ...result.checkRuns
      .filter((r) => r.status === 'error')
      .map((r) => ({ kind: 'engine-error', check: r.checkId, reason: r.reason })),
  ];
}

export function summarise(result: RunResult): Record<string, number> {
  const count = (s: string): number => result.checkRuns.filter((r) => r.status === s).length;
  return {
    findings: result.findings.length,
    blocking: result.findings.filter((f) => f.blocking).length,
    baselined: result.findings.filter((f) => f.suppressedBy === 'baseline').length,
    exempted: result.findings.filter((f) => f.suppressedBy === 'exemption').length,
    checks_passed: count('passed'),
    checks_failed: count('failed'),
    checks_skipped: count('skipped'),
    checks_errored: count('error'),
  };
}

export function toJson(result: RunResult): object {
  return redactDeep({
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
    profiles: profiles(result),
  });
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
  return redact(lines.join('\n'));
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

export function writeOutputs(result: RunResult, outDir: string, extra: { runId?: string } = {}): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.sarif'), JSON.stringify(toSarif(result), null, 2));
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(toEvidence(result, extra), null, 2));
}

const MAX_BASELINE_BYTES = 20 * 1024 * 1024;

/**
 * Fingerprints from baseline text (SARIF written by "qa baseline"). A file
 * that is not such SARIF is a configuration error, never silently ignored:
 * a damaged baseline must not change what blocks.
 */
export function parseBaseline(text: string, where = BASELINE_FILE): Set<string> {
  if (text.length > MAX_BASELINE_BYTES) throw new ConfigError(`${where} is larger than 20 MB`);
  let log: { version?: unknown; runs?: unknown };
  try {
    log = JSON.parse(text) as typeof log;
  } catch {
    throw new ConfigError(`${where} is not valid JSON; regenerate it with "qa baseline"`);
  }
  if (!log || log.version !== '2.1.0' || !Array.isArray(log.runs))
    throw new ConfigError(`${where} is not a SARIF 2.1.0 file written by "qa baseline"`);
  const set = new Set<string>();
  for (const r of log.runs as Array<{ results?: unknown }>) {
    if (!Array.isArray(r?.results)) continue;
    for (const res of r.results as Array<{ partialFingerprints?: Record<string, unknown> }>) {
      const fp = res?.partialFingerprints?.[FINGERPRINT_KEY];
      if (typeof fp !== 'string' || !/^[0-9a-f]{32}$/.test(fp))
        throw new ConfigError(`${where} has a result without a valid ${FINGERPRINT_KEY} fingerprint`);
      set.add(fp);
    }
  }
  return set;
}

export function readBaseline(root: string): Set<string> {
  const file = join(root, BASELINE_FILE);
  if (!existsSync(file)) return new Set<string>();
  if (statSync(file).size > MAX_BASELINE_BYTES) throw new ConfigError(`${BASELINE_FILE} is larger than 20 MB`);
  return parseBaseline(readFileSync(file, 'utf8'));
}

export function writeBaseline(root: string, result: RunResult): string {
  const file = join(root, BASELINE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(toSarif(result), null, 2) + '\n');
  return file;
}
