export type Tag = string;
export type Level = 'error' | 'warning' | 'note';
export type Actor = 'human' | 'agent' | 'ci';
export type RunMode = 'local' | 'ci';
export type Scope = 'file' | 'commit' | 'pr' | 'release';
export type PolicyMode = 'off' | 'report' | 'block';
export type RegistryStatus = 'approved' | 'pending-inventory' | 'blocked' | 'retired';

// ---- Registries (shapes match schemas/*.schema.json) ----

export interface ToolEntry {
  id: string;
  name: string;
  vendor: string;
  status: RegistryStatus;
  tier: string;
  models: string[];
  owner: string;
  review_by: string;
  trailer_aliases?: string[];
  profile?: { mcp_config?: string; rule_file?: string; exclusion_file?: string };
}

export interface McpServerEntry {
  id: string;
  status: RegistryStatus;
  owner: string;
  match: { package?: string; versions?: string[]; url?: string; command?: string };
}

export interface AiRegistry {
  version: 1;
  updated: string;
  tools: ToolEntry[];
  agents: { login: string; tool: string }[];
  mcp_servers: McpServerEntry[];
}

export interface TagDefinition {
  description: string;
  owners: string[];
  min_approvals: number;
  only_if_untagged?: boolean;
  paths: Record<string, string[]>;
}

export interface PathTags {
  version: 1;
  tags: Record<Tag, TagDefinition>;
}

export interface CheckDefinition {
  id: string;
  title: string;
  kind: 'native' | 'tool';
  tool?: string;
  stage: 0 | 1 | 2 | 3;
  scope: Scope;
  tags: 'all' | Tag[];
  extra_globs?: string[];
  controls: string[];
  rules: string[];
  /** Where a check comes from when no capability control or rule covers it. */
  source?: string;
}

export interface Policy {
  version: 1;
  defaults: { mode: PolicyMode };
  local: { time_budget_ms: number; prepush_time_budget_ms?: number; prepr_time_budget_ms?: number };
  /** Limits for the pull request checks (stage 3: "qa prepr" and the PR gate). */
  pr?: PrPolicy;
  /** Exact versions of the tools every machine runs; `qa doctor` compares them. */
  tools?: Record<string, string>;
  protected: { tags: Tag[]; globs: string[] };
  checks: Record<string, { mode: PolicyMode; block_from?: string }>;
  /** Time limits; each can be overridden by an environment variable (see cli.ts). */
  timeouts?: TimeoutPolicy;
  /** Parallel checks and the local result cache. */
  performance?: { parallelism?: number; cache?: boolean };
  /** The oldest engine that understands this configuration. */
  min_engine_version?: string;
}

export interface TimeoutPolicy {
  /** Default limit for one scanner run. */
  tool_ms?: number;
  /** Per scanner, e.g. { semgrep: 600000 }. */
  tools?: Record<string, number>;
  /** Limit for one git command. */
  git_ms?: number;
  /** Limit for one download attempt in "qa setup" and for one report upload. */
  download_ms?: number;
  /** Attempts for a download or upload that fails for a network reason. */
  network_retries?: number;
}

export interface PrPolicy {
  /** Branch names a pull request may come from. */
  branch_pattern: string;
  /** Changed lines (added plus deleted) above which a warning is shown. */
  diff_warn_lines: number;
  /** Changed lines above which the pull request should be split. */
  diff_max_lines: number;
  /** Generated files left out of the line count (lockfiles, snapshots). */
  diff_ignore: string[];
  /** Minimum line coverage, in percent, from the test run's coverage summary. */
  coverage_min_lines: number;
}

export interface Exemption {
  id: string;
  check: string;
  repo: string;
  path: string;
  owner: string;
  approved_by: string;
  reason: string;
  expires: string;
}

export interface RepositoryEntry {
  name: string;
  enabled: boolean;
  owner?: string;
  approved_by?: string;
  onboarded?: string;
  note?: string;
}

/** Repositories permitted to run the engine (registry/repositories.yaml, issue #8). */
export interface RepositoryAllowlist {
  version: 1;
  org: string;
  repositories: RepositoryEntry[];
}

export interface Config {
  dir: string;
  registry: AiRegistry;
  repositories: RepositoryAllowlist;
  pathTags: PathTags;
  checks: CheckDefinition[];
  policy: Policy;
  exemptions: Exemption[];
  /** sha256 of each registry file, recorded in evidence.json. */
  hashes: Record<string, string>;
  gitleaksConfig?: string;
  /** Directory of Semgrep rule files for sast.semgrep. */
  semgrepConfig?: string;
}

// ---- Run ----

export interface ChangedFile {
  /** Repository-relative, forward slashes. */
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
}

export interface FileSource {
  readonly kind: 'index' | 'worktree' | 'dir' | 'commit';
  readonly root: string;
  /** Text content, or undefined for deleted, missing or binary files. */
  read(path: string): string | undefined;
}

export interface RunContext {
  repo: string;
  sha: string;
  root: string;
  actor: Actor;
  mode: RunMode;
  asOf: string;
  config: Config;
  changedFiles: ChangedFile[];
  fileTags: Map<string, Set<Tag>>;
  tags: Set<Tag>;
  source: FileSource;
  commitMessage?: string;
  /** The pull request being prepared; only in a "qa prepr" run or the PR gate. */
  pr?: PrInfo;
  /** Files this check should look at (by its tags and extra globs), excluding deletions. */
  filesFor(def: CheckDefinition): ChangedFile[];
  /** Time limit for one run of this check's scanner, in milliseconds. */
  timeoutFor(def: CheckDefinition): number;
}

export interface PrCommit {
  sha: string;
  message: string;
}

export interface DiffStat {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

/** Coverage totals from an Istanbul json-summary file (c8, nyc, Jest, Vitest). */
export interface CoverageSummary {
  file: string;
  /** Undefined when the test run measured no lines at all. */
  linesPct?: number;
}

export interface PrInfo {
  /** The ref the pull request will merge into, e.g. origin/develop. */
  base: string;
  branch: string;
  /** Commits in base...HEAD, merges excluded, oldest first. */
  commits: PrCommit[];
  diff: DiffStat[];
  coverage: CoverageSummary[];
}

/** What a check returns. Messages are plain text and never contain secret values. */
export interface Finding {
  checkId: string;
  /** Sub-rule within the check, e.g. "bidi-control". */
  ruleId?: string;
  level: Level;
  message: string;
  fixHint?: string;
  path?: string;
  line?: number;
  column?: number;
  /** Stable content used for the fingerprint. Never written to any output. */
  fingerprintBasis?: string;
}

export type Suppression = 'baseline' | 'exemption';

export interface EvaluatedFinding extends Finding {
  controls: string[];
  rules: string[];
  fingerprint: string;
  effectiveMode: PolicyMode;
  blocking: boolean;
  suppressedBy?: Suppression;
  suppressionNote?: string;
}

export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface CheckRun {
  checkId: string;
  status: CheckStatus;
  durationMs: number;
  findings: number;
  reason?: string;
  /** The policy mode the check ran in. */
  mode?: PolicyMode;
  /** Scanner checks: the scanner's version. */
  toolVersion?: string;
  /** Scanner checks: files answered from the local result cache. */
  cachedFiles?: number;
}

export interface RunResult {
  engineVersion: string;
  repo: string;
  sha: string;
  actor: Actor;
  mode: RunMode;
  asOf: string;
  tags: Tag[];
  files: string[];
  findings: EvaluatedFinding[];
  checkRuns: CheckRun[];
  checkDefinitions: CheckDefinition[];
  engineErrors: string[];
  configHashes: Record<string, string>;
  startedAt: string;
  durationMs: number;
  exitCode: 0 | 1 | 2;
  /** Which stages the run covered (pre-commit 0-1, pre-push 2, pre-PR 0-3, all when undefined). */
  stages?: number[];
  /** Local result cache use, when the cache was on. */
  cache?: { hits: number; misses: number; writes: number };
}

export class ToolUnavailableError extends Error {
  constructor(
    public readonly tool: string,
    detail: string,
  ) {
    super(`${tool} is not available: ${detail}`);
    this.name = 'ToolUnavailableError';
  }
}

/** A command-line value that is refused before anything runs (unsafe or malformed). */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
