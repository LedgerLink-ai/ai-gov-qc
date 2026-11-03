import { NATIVE_CHECKS } from './checks';
import { TOOL_ADAPTERS } from './adapters/tools';
import { effectiveMode, findExemption, fingerprint } from './policy';
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
  now?: () => number;
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

async function runOne(def: CheckDefinition, ctx: RunContext): Promise<Finding[]> {
  if (def.kind === 'native') return NATIVE_CHECKS[def.id](ctx, def);
  return TOOL_ADAPTERS[def.tool as string].run(ctx, def, ctx.filesFor(def));
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

export async function run(opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const ctx = buildContext(opts);
  const defs = [...opts.config.checks].sort((a, b) => a.stage - b.stage);
  const findings: EvaluatedFinding[] = [];
  const checkRuns: CheckRun[] = [];
  const engineErrors: string[] = [];
  const blockedStages = new Set<number>();

  for (const def of defs) {
    const skip = (reason: string): void => {
      checkRuns.push({ checkId: def.id, status: 'skipped', durationMs: 0, findings: 0, reason });
    };
    if (opts.exclude?.includes(def.id)) {
      skip('excluded by the caller');
      continue;
    }
    if (effectiveMode(opts.config.policy, def.id, opts.asOf) === 'off') {
      skip('switched off in policy.yaml');
      continue;
    }
    const reason = notApplicable(def, ctx, opts);
    if (reason) {
      skip(reason);
      continue;
    }
    if ([...blockedStages].some((s) => s < def.stage)) {
      skip('an earlier stage has blocking findings (P2)');
      continue;
    }
    if (opts.mode === 'local' && now() - started > (opts.timeBudgetMs ?? opts.config.policy.local.time_budget_ms)) {
      skip('local time budget used; runs in CI');
      continue;
    }

    const checkStart = now();
    try {
      const raw = await runOne(def, ctx);
      const evaluated = raw.map((f) => evaluate(f, def, opts));
      findings.push(...evaluated);
      const blocking = evaluated.some((f) => f.blocking);
      if (blocking) blockedStages.add(def.stage);
      checkRuns.push({
        checkId: def.id,
        status: blocking ? 'failed' : 'passed',
        durationMs: now() - checkStart,
        findings: evaluated.length,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof ToolUnavailableError && opts.mode === 'local') {
        checkRuns.push({
          checkId: def.id,
          status: 'skipped',
          durationMs: now() - checkStart,
          findings: 0,
          reason: `${message}; runs in CI`,
        });
        continue;
      }
      // Fail closed: a check that cannot run is never a pass.
      engineErrors.push(`${def.id}: ${message}`);
      checkRuns.push({
        checkId: def.id,
        status: 'error',
        durationMs: now() - checkStart,
        findings: 0,
        reason: message,
      });
    }
  }

  const exitCode = engineErrors.length > 0 ? 2 : findings.some((f) => f.blocking) ? 1 : 0;
  return {
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
    engineErrors,
    configHashes: opts.config.hashes,
    startedAt: new Date(started).toISOString(),
    durationMs: now() - started,
    exitCode,
  };
}
