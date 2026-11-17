import { availableParallelism } from 'node:os';
import { NATIVE_CHECKS } from './checks';
import { TOOL_ADAPTERS } from './adapters/tools';
import { cacheKey, type ResultCache } from './cache';
import { DEFAULT_TOOL_TIMEOUT_MS, ToolTimeoutError } from './exec';
import { logger, type Logger } from './log';
import { effectiveMode, findExemption, fingerprint } from './policy';
import { redact } from './redact';
import { globMatcher, resolveTags } from './tags';
import { ENGINE_VERSION } from './version';
import {
  ToolUnavailableError,
  type Actor,
  type ChangedFile,
  type CheckDefinition,
  type CheckRun,
  type Config,
  type EvaluatedFinding,
  type FileSource,
  type Finding,
  type PrInfo,
  type RunContext,
  type RunMode,
  type RunResult,
  type Scope,
  type Tag,
} from './types';

export interface RunOptions {
  config: Config;
  repo: string;
  sha: string;
  root: string;
  actor: Actor;
  mode: RunMode;
  asOf: string;
  changedFiles: ChangedFile[];
  source: FileSource;
  commitMessage?: string;
  pr?: PrInfo;
  /** Fingerprints from the repository's dated baseline (.qa/baseline.sarif). */
  baseline?: Set<string>;
  /** Restrict the run to these scopes, e.g. only `commit` for a commit message. */
  scopes?: Scope[];
  /** Restrict the run to these stages (pre-commit runs 0 and 1, pre-push 2, pre-PR 0 to 3). */
  stages?: number[];
  /** Local time budget; defaults to policy.local.time_budget_ms. */
  timeBudgetMs?: number;
  /** Check ids the caller excludes; reported as skipped, never silently dropped. */
  exclude?: string[];
  /** Time limit for each scanner run; defaults to policy.yaml timeouts, else 5 minutes. */
  toolTimeoutMs?: number;
  /** Checks of one stage run at most this many at a time; defaults to policy.yaml, else min(4, CPUs). */
  parallelism?: number;
  /** Per-file cache for scanner results; off when undefined. */
  cache?: ResultCache;
  log?: Logger;
  now?: () => number;
}

function timeoutFor(opts: RunOptions, def: CheckDefinition): number {
  const t = opts.config.policy.timeouts;
  return opts.toolTimeoutMs ?? (def.tool ? t?.tools?.[def.tool] : undefined) ?? t?.tool_ms ?? DEFAULT_TOOL_TIMEOUT_MS;
}

function buildContext(opts: RunOptions): RunContext {
  const fileTags = resolveTags(
    opts.config.pathTags,
    opts.repo,
    opts.changedFiles.map((f) => f.path),
  );
  const tags = new Set<Tag>();
  for (const set of fileTags.values()) for (const t of set) tags.add(t);
  const extraMatchers = new Map<string, (p: string) => boolean>();

  return {
    repo: opts.repo,
    sha: opts.sha,
    root: opts.root,
    actor: opts.actor,
    mode: opts.mode,
    asOf: opts.asOf,
    config: opts.config,
    changedFiles: opts.changedFiles,
    fileTags,
    tags,
    source: opts.source,
    commitMessage: opts.commitMessage,
    pr: opts.pr,
    filesFor(def: CheckDefinition): ChangedFile[] {
      let extra = extraMatchers.get(def.id);
      if (!extra) {
        extra = globMatcher(def.extra_globs ?? []);
        extraMatchers.set(def.id, extra);
      }
      return opts.changedFiles.filter((f) => {
        if (f.status === 'D') return false;
        if (def.tags === 'all') return true;
        const own = fileTags.get(f.path);
        return def.tags.some((t) => own?.has(t)) || extra(f.path);
      });
    },
    timeoutFor: (def) => timeoutFor(opts, def),
  };
}

const STAGE_RUNS: Record<number, string> = {
  0: 'runs at pre-commit and in CI',
  1: 'runs at pre-commit and in CI',
  2: 'runs at pre-push and in CI',
  3: 'runs before opening a pull request ("qa prepr") and in CI',
};

/** Why a check does not apply to this run, or undefined when it does. */
function notApplicable(def: CheckDefinition, ctx: RunContext, opts: RunOptions): string | undefined {
  if (opts.scopes && !opts.scopes.includes(def.scope)) return `scope ${def.scope} is not part of this run`;
  if (opts.stages && !opts.stages.includes(def.stage)) return STAGE_RUNS[def.stage];
  switch (def.scope) {
    case 'commit':
      return ctx.commitMessage === undefined ? 'no commit message in this run' : undefined;
    case 'pr':
      return ctx.pr === undefined ? STAGE_RUNS[3] : undefined;
    case 'release':
      return `scope ${def.scope} runs in the gate or release job`;
    case 'file':
      if (ctx.filesFor(def).length > 0) return undefined;
      return def.tags === 'all' ? 'no changed files' : `no changed file carries ${def.tags.join(', ')}`;
  }
}

interface Outcome {
  findings: Finding[];
  toolVersion?: string;
  cachedFiles?: number;
}

/**
 * A scanner check. With the cache on, files whose exact content was scanned
 * before (same check, scanner version and rules) are answered from the cache
 * and only the rest go to the scanner.
 */
async function runTool(def: CheckDefinition, ctx: RunContext, cache?: ResultCache): Promise<Outcome> {
  const adapter = TOOL_ADAPTERS[def.tool as string];
  const files = ctx.filesFor(def);
  const toolVersion = adapter.available() ? adapter.version() : undefined;
  if (!cache || !toolVersion) return { findings: await adapter.run(ctx, def, files), toolVersion };

  const rulesHash = adapter.rulesHash(ctx);
  const hits: Finding[] = [];
  const misses: ChangedFile[] = [];
  const keys = new Map<string, string>();
  for (const file of files) {
    const content = ctx.source.read(file.path);
    if (content === undefined) {
      misses.push(file);
      continue;
    }
    const key = cacheKey({ checkId: def.id, tool: adapter.name, toolVersion, rulesHash, path: file.path, content });
    const cached = cache.get(key);
    if (cached) hits.push(...cached);
    else {
      misses.push(file);
      keys.set(file.path, key);
    }
  }
  const fresh = misses.length > 0 ? await adapter.run(ctx, def, misses) : [];
  const byPath = new Map<string, Finding[]>();
  for (const f of fresh) if (f.path) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
  for (const [path, key] of keys) cache.set(key, byPath.get(path) ?? []);
  return { findings: [...hits, ...fresh], toolVersion, cachedFiles: files.length - misses.length };
}

async function runOne(def: CheckDefinition, ctx: RunContext, cache?: ResultCache): Promise<Outcome> {
  if (def.kind === 'native') return { findings: await NATIVE_CHECKS[def.id](ctx, def) };
  return runTool(def, ctx, cache);
}

function evaluate(finding: Finding, def: CheckDefinition, opts: RunOptions): EvaluatedFinding {
  const fp = fingerprint(finding);
  const mode = effectiveMode(opts.config.policy, def.id, opts.asOf);
  const evaluated: EvaluatedFinding = {
    ...finding,
    controls: def.controls,
    rules: def.rules,
    fingerprint: fp,
    effectiveMode: mode,
    blocking: false,
  };
  if (opts.baseline?.has(fp)) {
    evaluated.suppressedBy = 'baseline';
    evaluated.suppressionNote = 'Present in the dated baseline; reported, not blocking (P9).';
  } else {
    const { active, expired } = findExemption(opts.config.exemptions, opts.repo, finding, opts.asOf);
    if (active) {
      evaluated.suppressedBy = 'exemption';
      evaluated.suppressionNote = `Exemption ${active.id} (owner ${active.owner}) until ${active.expires}.`;
    } else if (expired) {
      evaluated.suppressionNote = `Exemption ${expired.id} expired on ${expired.expires}.`;
    }
  }
  evaluated.blocking = finding.level === 'error' && mode === 'block' && !evaluated.suppressedBy;
  return evaluated;
}

/** Runs `fn` on every item, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export function defaultParallelism(config: Config): number {
  return Math.max(1, config.policy.performance?.parallelism ?? Math.min(4, availableParallelism()));
}

const cmp = (a: string | number | undefined, b: string | number | undefined): number =>
  a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;

export async function run(opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? logger();
  const started = now();
  const ctx = buildContext(opts);
  // Stable: checks of one stage keep their checks.yaml order.
  const defs = [...opts.config.checks].sort((a, b) => a.stage - b.stage);
  const order = new Map(defs.map((d, i) => [d.id, i]));
  const runs = new Map<string, CheckRun>();
  const found = new Map<string, EvaluatedFinding[]>();
  const engineErrors = new Map<string, string>();
  const blockedStages = new Set<number>();
  const parallelism = opts.parallelism ?? defaultParallelism(opts.config);
  const budget = opts.timeBudgetMs ?? opts.config.policy.local.time_budget_ms;

  log.info('run.start', {
    repo: opts.repo,
    sha: opts.sha,
    mode: opts.mode,
    actor: opts.actor,
    as_of: opts.asOf,
    files: opts.changedFiles.length,
    tags: [...ctx.tags].sort(),
    stages: opts.stages ?? 'all',
    parallelism,
    cache: opts.cache ? 'on' : 'off',
  });

  for (const stage of [...new Set(defs.map((d) => d.stage))]) {
    const runnable: CheckDefinition[] = [];
    for (const def of defs.filter((d) => d.stage === stage)) {
      const mode = effectiveMode(opts.config.policy, def.id, opts.asOf);
      const skip = (reason: string): void => {
        runs.set(def.id, { checkId: def.id, status: 'skipped', durationMs: 0, findings: 0, reason, mode });
      };
      if (opts.exclude?.includes(def.id)) skip('excluded by the caller');
      else if (mode === 'off') skip('switched off in policy.yaml');
      else {
        const reason = notApplicable(def, ctx, opts);
        if (reason) skip(reason);
        else if ([...blockedStages].some((s) => s < def.stage)) skip('an earlier stage has blocking findings (P2)');
        else runnable.push(def);
      }
    }

    await pool(runnable, parallelism, async (def) => {
      const mode = effectiveMode(opts.config.policy, def.id, opts.asOf);
      if (opts.mode === 'local' && now() - started > budget) {
        runs.set(def.id, {
          checkId: def.id,
          status: 'skipped',
          durationMs: 0,
          findings: 0,
          reason: 'local time budget used; runs in CI',
          mode,
        });
        return;
      }
      const checkStart = now();
      log.debug('check.start', { check: def.id, stage: def.stage });
      try {
        const outcome = await runOne(def, ctx, opts.cache);
        const evaluated = outcome.findings.map((f) => evaluate(f, def, opts));
        found.set(def.id, evaluated);
        const blocking = evaluated.some((f) => f.blocking);
        const record: CheckRun = {
          checkId: def.id,
          status: blocking ? 'failed' : 'passed',
          durationMs: now() - checkStart,
          findings: evaluated.length,
          mode,
          ...(outcome.toolVersion ? { toolVersion: outcome.toolVersion } : {}),
          ...(outcome.cachedFiles !== undefined ? { cachedFiles: outcome.cachedFiles } : {}),
        };
        runs.set(def.id, record);
        log.info('check.finish', {
          check: def.id,
          status: record.status,
          duration_ms: record.durationMs,
          findings: record.findings,
          blocking: evaluated.filter((f) => f.blocking).length,
          ...(record.cachedFiles !== undefined ? { cached_files: record.cachedFiles } : {}),
        });
      } catch (err) {
        const message = redact((err as Error).message);
        const deferrable = err instanceof ToolUnavailableError || err instanceof ToolTimeoutError;
        if (deferrable && opts.mode === 'local') {
          runs.set(def.id, {
            checkId: def.id,
            status: 'skipped',
            durationMs: now() - checkStart,
            findings: 0,
            reason: `${message}; runs in CI`,
            mode,
          });
          log.warn('check.deferred', { check: def.id, reason: message });
          return;
        }
        // Fail closed: a check that cannot run is never a pass.
        engineErrors.set(def.id, `${def.id}: ${message}`);
        runs.set(def.id, {
          checkId: def.id,
          status: 'error',
          durationMs: now() - checkStart,
          findings: 0,
          reason: message,
          mode,
        });
        log.error('check.error', { check: def.id, error: message });
      }
    });

    if (runnable.some((d) => found.get(d.id)?.some((f) => f.blocking))) blockedStages.add(stage);
  }

  // Deterministic output: checks in checks.yaml order (by stage), findings by
  // check, then path, line, column, sub-rule and fingerprint, whatever order
  // parallel checks finished in.
  const checkRuns = defs.map((d) => runs.get(d.id) as CheckRun);
  const findings = defs
    .flatMap((d) => found.get(d.id) ?? [])
    .sort(
      (a, b) =>
        (order.get(a.checkId) ?? 0) - (order.get(b.checkId) ?? 0) ||
        cmp(a.path, b.path) ||
        cmp(a.line, b.line) ||
        cmp(a.column, b.column) ||
        cmp(a.ruleId, b.ruleId) ||
        cmp(a.fingerprint, b.fingerprint),
    );
  const errors = defs.map((d) => engineErrors.get(d.id)).filter((e): e is string => e !== undefined);
  const exitCode = errors.length > 0 ? 2 : findings.some((f) => f.blocking) ? 1 : 0;
  const result: RunResult = {
    engineVersion: ENGINE_VERSION,
    repo: opts.repo,
    sha: opts.sha,
    actor: opts.actor,
    mode: opts.mode,
    asOf: opts.asOf,
    tags: [...ctx.tags].sort(),
    files: opts.changedFiles.map((f) => f.path),
    findings,
    checkRuns,
    checkDefinitions: defs,
    engineErrors: errors,
    configHashes: opts.config.hashes,
    startedAt: new Date(started).toISOString(),
    durationMs: now() - started,
    exitCode,
    ...(opts.stages ? { stages: [...opts.stages] } : {}),
    ...(opts.cache ? { cache: { ...opts.cache.stats } } : {}),
  };
  log.info('run.finish', {
    exit_code: exitCode,
    duration_ms: result.durationMs,
    findings: findings.length,
    blocking: findings.filter((f) => f.blocking).length,
    failed_checks: checkRuns.filter((r) => r.status === 'failed').map((r) => r.checkId),
    errors: errors.length,
  });
  return result;
}
