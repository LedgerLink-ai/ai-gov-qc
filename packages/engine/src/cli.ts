import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { TOOL_ADAPTERS } from './adapters/tools';
import { versionIn } from './adapters/tools/workdir';
import { parseTrailerValue } from './checks/commit-trailer';
import { NO_DEFAULT, prepareMessage } from './prepare-message';
import { clearCache, cacheDir, openCache } from './cache';
import { loadAllowlist, loadConfig, locateConfig } from './config';
import { envMs } from './exec';
import { configSourceProblem, gate, isWithin } from './gate';
import { runConformance, unavailableTools } from './conform';
import { createLogger, logger, parseLogSettings, setLogger } from './log';
import { today } from './policy';
import { publishEvidence } from './publish';
import { redact } from './redact';
import {
  parseBaseline,
  readBaseline,
  summarise,
  toJson,
  toSarif,
  toText,
  worthShowing,
  writeBaseline,
  writeOutputs,
  BASELINE_FILE,
} from './report';
import { run, type RunOptions } from './runner';
import {
  assertRef,
  commitSource,
  defaultBase,
  directorySource,
  gitBranch,
  gitDiffFiles,
  gitHeadSha,
  gitRangeCommits,
  gitRangeDiffStat,
  gitRangeFiles,
  gitRepoName,
  gitRoot,
  gitStagedFiles,
  gitTreeFiles,
  gitMergeBase,
  indexSource,
  listFiles,
  readAtRef,
  readCoverageSummary,
  setGitTimeout,
  toPosix,
} from './sources';
import { setup } from './setup';
import { resolveTags } from './tags';
import { toolBinary } from './tools-home';
import {
  ConfigError,
  InputError,
  type Actor,
  type Config,
  type ChangedFile,
  type CoverageSummary,
  type FileSource,
  type RunMode,
} from './types';
import { ENGINE_VERSION } from './version';

const USAGE = `qa ${ENGINE_VERSION} - LedgerLink QA check engine

Usage:
  qa check      [selection] [options]   Run the checks on a set of changed files
  qa precommit  [options]               Stage 0-1 checks on the staged changes (the pre-commit hook)
  qa prepare-commit-msg <file> [<source>]
                                        Pre-fill the message (the prepare-commit-msg hook): the ticket key from
                                        the branch name, the Assisted-by default, AI Co-authored-by lines
                                        converted to Assisted-by. Never rejects a commit
  qa prepush    [options]               Stage 2 checks (fast Semgrep) on the commits being pushed (the pre-push hook)
  qa prepr      [--base <ref>] [--coverage <files>] [options]
                                        Stage 0-3 checks on everything the pull request contains, plus its
                                        branch name, commit messages, size and coverage (before opening a PR)
  qa setup      [setup options]         Install pre-commit, Semgrep and Gitleaks at the pinned versions and the
                                        git template, on Windows, macOS or Linux (once per machine)
  qa doctor     [--root <dir>]          Check this machine and repository are set up for the local hooks
  qa repo-tool  [--pr-files] <package>[:<bin>] [args...]
                                        Run a tool from the repository's node_modules, e.g. eslint, prettier,
                                        typescript:tsc (skipped until the repository's dependencies are installed);
                                        --pr-files adds the files the pull request changes as arguments
  qa repo-script [--cwd <dir>] [--advisory] <script> [args...]
                                        Run a package.json script with the repository's package manager
                                        (yarn, pnpm or npm; skipped until dependencies are installed);
                                        --advisory reports a failure without blocking
  qa baseline   [selection] [options]   Record current findings in .qa/baseline.sarif (they then report, not block)
  qa rules      <path>... [options]     Tags, checks, controls and approvals for these paths
  qa validate   [--config <dir>]        Validate the registries and their cross-references
  qa conform    [--config <dir>]        Run the conformance fixtures through the API and CLI paths
  qa cache      clear | path            Remove or show the local scanner result cache
  qa version

Selection (pick one):
  --staged              Staged changes (reads the index, i.e. exactly what will be committed)
  --base <ref>          Changes since the merge base with <ref> (what a pull request contains)
  --files <a,b,...>     These files under --root
  --all                 Every file under --root

Options:
  --root <dir>          Repository root (default: git top level, else the current directory)
  --repo <name>         Repository name for path tags (default: origin remote name, else folder name)
  --actor <who>         human | agent | ci  (default: $QA_ACTOR or human)
  --mode <mode>         local | ci  (default: ci when $CI is set, else local)
  --as-of <date>        Evaluate switch-on dates as of YYYY-MM-DD (default: $QA_AS_OF, else today)
  --commit-msg-file <f> Also run commit-message checks on this message
  --coverage <files>    qa prepr: comma-separated Istanbul json-summary files from the test run
                        (default: coverage/coverage-summary.json and */coverage/coverage-summary.json)
  --format <fmt>        text | json | sarif  (default: text)
  --quiet               Print nothing when there is nothing to report (used by the git hooks)
  --out <dir>           Also write results.sarif and evidence.json here (CI default: <root>/.qa/out)
  --exclude <ids>       Comma-separated check ids to skip (reported as skipped; used by conformance)
  --config <dir>        Registry directory (default: $QA_CONFIG_DIR, the bundled snapshot, or this checkout).
                        Never inside the repository being checked, and not accepted in GitHub Actions
  --timeout <ms>        Time limit for each scanner run (default: policy.yaml timeouts, $QA_TOOL_TIMEOUT_MS)
  --parallel <n>        Checks of one stage run at most n at a time (default: policy.yaml, $QA_PARALLELISM)
  --no-cache            Do not use the local scanner result cache (CI never uses it)
  --log-format <fmt>    text | json: json writes one structured event per line on stderr ($QA_LOG_FORMAT)
  --log-level <lvl>     debug | info | warn | error | silent ($QA_LOG_LEVEL)
  --report-url <url>    Also POST evidence.json to this https endpoint ($QA_REPORT_URL, token $QA_REPORT_TOKEN)

Version pin (before the command, as the repository hook configuration writes it):
  qa --require <version> <command> ...   Stop with install instructions unless the installed qa is
                                         compatible: the same major version (minor below 1.0), not older

Setup options:
  --home <dir>          Where the tools go (default: $QA_HOME, else ~/.ledgerlink-qa)
  --no-python           Do not install pre-commit and Semgrep
  --no-gitleaks         Do not install Gitleaks
  --no-git-template     Do not set up the git template
  --gitleaks-archive <f>  Install Gitleaks from this downloaded release archive (no network)
  --download-base <url> Download Gitleaks from this mirror: <url>/v<version>/<asset>

Execution gate: check, precommit, prepare-commit-msg, prepush, prepr, baseline, repo-tool and repo-script do
nothing (exit 0, no output) unless the repository's origin remote is owned by the organisation and the repository
is enabled in registry/repositories.yaml. In CI, an identity that cannot be verified is an error (exit 2), and
so is configuration from --config or QA_CONFIG_DIR. "qa doctor" shows whether QA is enabled for the current
repository. In CI the baseline is read from the pull request's base, so a pull request cannot baseline its own
findings.

Environment:
  QA_ACTOR              human | agent | ci, as --actor
  QA_AS_OF              as --as-of; set QA_AS_OF=2027-01-08 to try the hooks with every gate switched on
  QA_PR_BASE            qa prepr: the branch the pull request merges into (default: origin/HEAD)
  QA_ASSISTED_BY        "<tool>, <model>, <version>": the Assisted-by default when git config
                        ledgerlink.assistedBy is not set (git config --global ledgerlink.assistedBy "...")
  QA_HOME               Where "qa setup" installs the tools (default: ~/.ledgerlink-qa)
  QA_GITLEAKS_BIN, QA_SEMGREP_BIN, QA_PRE_COMMIT_BIN
                        Paths to the tools (default: the copies "qa setup" installed, else PATH)
  QA_TOOL_TIMEOUT_MS, QA_GIT_TIMEOUT_MS, QA_DOWNLOAD_TIMEOUT_MS
                        Time limits (default: policy.yaml timeouts)
  QA_PARALLELISM        As --parallel
  QA_NO_CACHE=1         As --no-cache; QA_CACHE_DIR moves the cache (default <QA_HOME>/cache)
  QA_LOG_FORMAT, QA_LOG_LEVEL   As --log-format, --log-level
  QA_REPORT_URL, QA_REPORT_TOKEN, QA_REPORT_REQUIRED=1
                        Central reporting; with QA_REPORT_REQUIRED=1 a failed upload is exit 2
  QA_PR_AUTHOR          In CI: the pull request author; an agent login from the AI registry runs the
                        agent rules (default actor), anyone else the human rules

Exit codes: 0 pass, 1 blocking findings, 2 the engine could not run (treat as a failure).`;

type Flags = Record<string, string | boolean>;

const VALUE_FLAGS = new Set([
  'root',
  'repo',
  'actor',
  'mode',
  'as-of',
  'commit-msg-file',
  'format',
  'out',
  'config',
  'base',
  'files',
  'fixtures',
  'exclude',
  'coverage',
  'home',
  'gitleaks-archive',
  'download-base',
  'timeout',
  'parallel',
  'log-format',
  'log-level',
  'report-url',
]);
const BOOLEAN_FLAGS = new Set([
  'staged',
  'all',
  'help',
  'quiet',
  'no-python',
  'no-gitleaks',
  'no-git-template',
  'no-cache',
]);

export function parseArgs(argv: string[]): { command: string; positionals: string[]; flags: Flags } {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? rest[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else throw new UsageError(`unknown option --${name}`);
  }
  return { command, positionals, flags };
}

class UsageError extends Error {}

const str = (flags: Flags, name: string): string | undefined =>
  typeof flags[name] === 'string' ? (flags[name] as string) : undefined;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value))
    throw new UsageError(`--${name} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function tryGitRoot(dir: string): string | undefined {
  try {
    return gitRoot(dir);
  } catch {
    return undefined;
  }
}

const rootOf = (flags: Flags): string => resolve(str(flags, 'root') ?? tryGitRoot(process.cwd()) ?? process.cwd());

interface Selection {
  root: string;
  inGit: boolean;
  files: ChangedFile[];
  source: FileSource;
  /** The branch a pull request merges into: in CI the baseline is read from there. */
  base?: string;
}

function select(flags: Flags, defaultSelection?: 'staged'): Selection {
  const root = rootOf(flags);
  const inGit = tryGitRoot(root) !== undefined && !flags.all && !flags.files;
  const chosen = ['staged', 'base', 'files', 'all'].filter((k) => flags[k] !== undefined);
  if (chosen.length > 1)
    throw new UsageError(`choose one of --staged, --base, --files, --all (got ${chosen.join(', ')})`);
  const mode = chosen[0] ?? defaultSelection;

  switch (mode) {
    case 'staged':
      return { root, inGit: true, files: gitStagedFiles(root), source: indexSource(root) };
    case 'base': {
      const base = assertRef(str(flags, 'base') as string, '--base');
      return {
        root,
        inGit: true,
        files: gitRangeFiles(root, base),
        source: directorySource(root, 'worktree'),
        base,
      };
    }
    case 'files': {
      const files = (str(flags, 'files') as string)
        .split(',')
        .map((f) => toPosix(f.trim()))
        .filter(Boolean)
        .map((path) => ({ path, status: existsSync(join(root, path)) ? ('M' as const) : ('D' as const) }));
      return { root, inGit, files, source: directorySource(root) };
    }
    case 'all':
      return {
        root,
        inGit,
        files: listFiles(root).map((path) => ({ path, status: 'A' as const })),
        source: directorySource(root),
      };
    default:
      throw new UsageError('choose what to check: --staged, --base <ref>, --files <list> or --all');
  }
}

const isZeroRef = (ref: string | undefined): boolean => !ref || /^0+$/.test(ref);

function upstreamOf(root: string): string | undefined {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', '@{upstream}'], { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/**
 * What a push sends, read from the commits rather than the work tree. The
 * pre-commit framework passes the range in PRE_COMMIT_FROM_REF/TO_REF; run by
 * hand or through husky, it is the change since the upstream branch, else (a
 * new branch's first push) since the default branch, else the whole commit.
 */
function pushSelection(flags: Flags): Selection {
  const root = rootOf(flags);
  const envTo = process.env.PRE_COMMIT_TO_REF;
  const to = isZeroRef(envTo) ? 'HEAD' : assertRef(envTo as string, 'PRE_COMMIT_TO_REF');
  const from = process.env.PRE_COMMIT_FROM_REF;
  if (!isZeroRef(from)) assertRef(from as string, 'PRE_COMMIT_FROM_REF');
  const base = str(flags, 'base') === undefined ? undefined : assertRef(str(flags, 'base') as string, '--base');
  let files: ChangedFile[];
  if (base) files = gitRangeFiles(root, base);
  else if (!isZeroRef(from)) files = gitDiffFiles(root, from as string, to);
  else {
    const upstream = upstreamOf(root);
    const fallback = upstream ? undefined : defaultBase(root);
    const mergeBase = fallback
      ? spawnSync('git', ['merge-base', fallback, to], { cwd: root, encoding: 'utf8' }).stdout.trim()
      : '';
    if (upstream) files = gitDiffFiles(root, upstream, to);
    else if (mergeBase) files = gitDiffFiles(root, mergeBase, to);
    else files = gitTreeFiles(root, to);
  }
  return { root, inGit: true, files, source: commitSource(root, to) };
}

/** A positive whole number from a flag, else an environment variable, else undefined. */
function positiveInt(flags: Flags, flag: string, envName: string): number | undefined {
  const raw = str(flags, flag) ?? process.env[envName];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${flag} (or ${envName}) must be a positive whole number`);
  return n;
}

const truthy = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v !== 'false';

/**
 * Who made the change. --actor, else QA_ACTOR, else in CI the pull request
 * author (QA_PR_AUTHOR): an agent login from the AI registry runs the agent
 * rules. Default: human.
 */
function resolveActor(flags: Flags, config: Config): Actor {
  const explicit = str(flags, 'actor') ?? process.env.QA_ACTOR;
  if (explicit !== undefined) return oneOf<Actor>(explicit, ['human', 'agent', 'ci'], 'actor', 'human');
  const author = process.env.QA_PR_AUTHOR?.trim().toLowerCase();
  if (author && config.registry.agents.some((a) => a.login.toLowerCase() === author)) return 'agent';
  return 'human';
}

/**
 * The dated baseline. Locally it is the repository's .qa/baseline.sarif; in
 * CI, for a pull request, it is the one on the base branch, so a pull request
 * cannot add its own findings to the baseline and pass.
 */
function baselineFor(sel: Selection, mode: RunMode): Set<string> {
  if (mode === 'ci' && sel.base && sel.inGit) {
    const at = gitMergeBase(sel.root, sel.base) ?? sel.base;
    const text = readAtRef(sel.root, at, BASELINE_FILE);
    if (text === undefined) return new Set<string>();
    logger().info('baseline.source', { ref: at, file: BASELINE_FILE });
    return parseBaseline(text, `${BASELINE_FILE} at ${at.slice(0, 12)}`);
  }
  return readBaseline(sel.root);
}

function runOptions(flags: Flags, sel: Selection, extra: Partial<RunOptions> = {}): RunOptions {
  const config = loadConfig(str(flags, 'config'));
  const gitAvailable = tryGitRoot(sel.root) !== undefined;
  const msgFile = str(flags, 'commit-msg-file');
  const asOf = str(flags, 'as-of') ?? process.env.QA_AS_OF ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new UsageError('--as-of (or QA_AS_OF) must be YYYY-MM-DD');
  const mode = oneOf<RunMode>(str(flags, 'mode'), ['local', 'ci'], 'mode', process.env.CI ? 'ci' : 'local');
  setGitTimeout(envMs('QA_GIT_TIMEOUT_MS') ?? config.policy.timeouts?.git_ms ?? 120_000);
  // The cache is a local convenience; CI always scans afresh.
  const useCache =
    mode === 'local' &&
    !flags['no-cache'] &&
    !truthy(process.env.QA_NO_CACHE) &&
    config.policy.performance?.cache !== false;
  return {
    config,
    repo: str(flags, 'repo') ?? (gitAvailable ? gitRepoName(sel.root) : basename(sel.root)),
    sha: gitAvailable ? gitHeadSha(sel.root) : 'WORKTREE',
    root: sel.root,
    actor: resolveActor(flags, config),
    mode,
    asOf,
    changedFiles: sel.files,
    source: sel.source,
    commitMessage: msgFile ? readFileSync(msgFile, 'utf8') : undefined,
    baseline: baselineFor(sel, mode),
    exclude: str(flags, 'exclude')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    toolTimeoutMs: positiveInt(flags, 'timeout', 'QA_TOOL_TIMEOUT_MS'),
    parallelism: positiveInt(flags, 'parallel', 'QA_PARALLELISM'),
    cache: useCache ? openCache() : undefined,
    log: logger(),
    ...extra,
  };
}

function print(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function runAndReport(opts: RunOptions, flags: Flags): Promise<number> {
  const format = oneOf(str(flags, 'format'), ['text', 'json', 'sarif'] as const, 'format', 'text');
  const result = await run(opts);
  const log = logger();
  if (format === 'json') print(JSON.stringify(toJson(result), null, 2));
  else if (format === 'sarif') print(JSON.stringify(toSarif(result), null, 2));
  else if (!flags.quiet || worthShowing(result)) print(toText(result));
  const out =
    str(flags, 'out') ?? (opts.mode === 'ci' && format === 'text' ? join(opts.root, '.qa', 'out') : undefined);
  if (out) {
    writeOutputs(result, resolve(out), { runId: log.runId });
    log.info('report.written', { dir: resolve(out) });
  }
  log.info('run.summary', { exit_code: result.exitCode, ...summarise(result) });

  let exitCode: number = result.exitCode;
  const reportUrl = str(flags, 'report-url') ?? process.env.QA_REPORT_URL;
  if (reportUrl) {
    const t = opts.config.policy.timeouts;
    try {
      await publishEvidence(result, {
        url: reportUrl,
        token: process.env.QA_REPORT_TOKEN,
        timeoutMs: envMs('QA_DOWNLOAD_TIMEOUT_MS') ?? t?.download_ms ?? 120_000,
        retries: t?.network_retries ?? 3,
        runId: log.runId,
      });
      log.info('report.sent', { url: new URL(reportUrl).host });
    } catch (err) {
      const required = truthy(process.env.QA_REPORT_REQUIRED);
      log[required ? 'error' : 'warn']('report.failed', { error: (err as Error).message }, (err as Error).message);
      if (required && exitCode === 0) exitCode = 2;
    }
  }
  return exitCode;
}

async function check(flags: Flags, defaultSelection?: 'staged', extra: Partial<RunOptions> = {}): Promise<number> {
  return runAndReport(runOptions(flags, select(flags, defaultSelection), extra), flags);
}

async function prepush(flags: Flags): Promise<number> {
  const opts = runOptions(flags, pushSelection(flags), { stages: [2] });
  opts.timeBudgetMs = opts.config.policy.local.prepush_time_budget_ms;
  return runAndReport(opts, flags);
}

/** Coverage summaries named by --coverage, else the usual places in the root and one folder down. */
function coverageFiles(root: string, flags: Flags): CoverageSummary[] {
  const named = str(flags, 'coverage')
    ?.split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  const candidates = named
    ? named.map((f) => resolve(root, f))
    : [
        join(root, 'coverage', 'coverage-summary.json'),
        ...readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
          .map((d) => join(root, d.name, 'coverage', 'coverage-summary.json')),
      ];
  const found: CoverageSummary[] = [];
  for (const file of candidates) {
    if (!existsSync(file)) {
      if (named) throw new UsageError(`--coverage: ${file} does not exist`);
      continue;
    }
    const summary = readCoverageSummary(file);
    if (!summary) throw new UsageError(`${file} is not an Istanbul json-summary file`);
    found.push({ ...summary, file: toPosix(relative(root, file)) });
  }
  return found;
}

/**
 * Before a pull request is opened: every check, stages 0 to 3, on what the
 * pull request will contain (base...HEAD, read from the commits), plus the
 * pull request rules on its branch, commits, size and coverage.
 */
async function prepr(flags: Flags): Promise<number> {
  const root = rootOf(flags);
  const named = str(flags, 'base') ?? process.env.QA_PR_BASE;
  const base = named !== undefined ? assertRef(named, '--base (or QA_PR_BASE)') : defaultBase(root);
  if (!base) throw new UsageError('no base branch found; pass --base <ref>, e.g. --base origin/develop');
  const sel: Selection = {
    root,
    inGit: true,
    files: gitRangeFiles(root, base),
    source: commitSource(root, 'HEAD'),
    base,
  };
  const pr = {
    base,
    // In CI the checkout is a detached commit; the workflow passes the branch name.
    branch: process.env.QA_PR_BRANCH?.trim() || gitBranch(root),
    commits: gitRangeCommits(root, base),
    diff: gitRangeDiffStat(root, base),
    coverage: coverageFiles(root, flags),
  };
  const opts = runOptions(flags, sel, { stages: [0, 1, 2, 3], pr });
  opts.timeBudgetMs = opts.config.policy.local.prepr_time_budget_ms;
  if (!flags.quiet) {
    print(`qa prepr: ${pr.branch} into ${base}, ${pr.commits.length} commit(s), ${sel.files.length} file(s)`);
    const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
    if (dirty.stdout.trim()) print('note: uncommitted changes are not part of the pull request and were not checked');
  }
  return runAndReport(opts, flags);
}

/** The developer's Assisted-by default: git config ledgerlink.assistedBy, else $QA_ASSISTED_BY. */
function assistedByDefault(root: string): string | undefined {
  const res = spawnSync('git', ['config', '--get', 'ledgerlink.assistedBy'], { cwd: root, encoding: 'utf8' });
  const fromGit = res.status === 0 ? res.stdout.trim() : '';
  return fromGit || process.env.QA_ASSISTED_BY?.trim() || undefined;
}

/**
 * The prepare-commit-msg hook: pre-fills the ticket key and the Assisted-by
 * trailer (prepare-message.ts). It never rejects a commit: anything that goes
 * wrong is reported and the message is left as it was.
 *
 * git passes <file> [<source> [<sha>]]; pre-commit passes the file and puts
 * the source in $PRE_COMMIT_COMMIT_MSG_SOURCE.
 */
function prepareCommitMsg(positionals: string[], flags: Flags): number {
  const [file, sourceArg] = positionals;
  if (!file) throw new UsageError('qa prepare-commit-msg needs the commit message file');
  try {
    const root = rootOf(flags);
    let registry;
    try {
      registry = loadConfig(str(flags, 'config')).registry;
    } catch {
      registry = undefined; // the ticket key and the default still work without the registry
    }
    const message = readFileSync(file, 'utf8');
    const result = prepareMessage({
      message,
      source: sourceArg ?? process.env.PRE_COMMIT_COMMIT_MSG_SOURCE ?? '',
      branch: gitBranch(root),
      assistedBy: assistedByDefault(root),
      registry,
    });
    if (result.message !== message) writeFileSync(file, result.message);
    for (const note of result.notes) print(`qa: ${note}`);
  } catch (err) {
    print(`qa: could not pre-fill the commit message (${(err as Error).message}); left as it was.`);
  }
  return 0;
}

async function baseline(flags: Flags): Promise<number> {
  const opts = runOptions(flags, select(flags));
  const result = await run({ ...opts, baseline: undefined });
  if (result.exitCode === 2) {
    print(toText(result));
    return 2;
  }
  const file = writeBaseline(opts.root, result);
  print(`Baselined ${result.findings.length} finding(s) as of ${opts.asOf} in ${file}`);
  return 0;
}

function rules(positionals: string[], flags: Flags): number {
  if (positionals.length === 0) throw new UsageError('qa rules needs at least one path');
  const config = loadConfig(str(flags, 'config'));
  const root = rootOf(flags);
  const repo = str(flags, 'repo') ?? (tryGitRoot(root) ? gitRepoName(root) : basename(root));
  const paths = positionals.map(toPosix);
  const tags = resolveTags(config.pathTags, repo, paths);
  const report = paths.map((path) => {
    const own = [...(tags.get(path) ?? [])];
    const checks = config.checks
      .filter((c) => c.tags === 'all' || c.tags.some((t) => own.includes(t)))
      .map((c) => ({ id: c.id, title: c.title, controls: c.controls, rules: c.rules }));
    const approvals = Math.max(1, ...own.map((t) => config.pathTags.tags[t].min_approvals));
    const owners = [...new Set(own.flatMap((t) => config.pathTags.tags[t].owners))];
    return { path, tags: own, min_approvals: approvals, owners, checks };
  });
  if (str(flags, 'format') === 'json') {
    print(JSON.stringify({ repo, paths: report }, null, 2));
    return 0;
  }
  for (const r of report) {
    print(`${r.path}  [repo ${repo}]`);
    print(
      `  tags: ${r.tags.join(', ') || '(none)'} | approvals needed: ${r.min_approvals} | owners: ${r.owners.join(', ') || '(none)'}`,
    );
    for (const c of r.checks) print(`  - ${c.id}: ${c.title} [${[...c.controls, ...c.rules].join(', ')}]`);
  }
  return 0;
}

function validate(flags: Flags): number {
  const config = loadConfig(str(flags, 'config'));
  print(`Configuration valid: ${config.dir}`);
  for (const [file, hash] of Object.entries(config.hashes)) print(`  ${file}  sha256:${hash.slice(0, 16)}`);
  print(
    `  ${config.checks.length} checks, ${Object.keys(config.pathTags.tags).length} tags, ${config.registry.tools.length} AI tools, ${config.registry.mcp_servers.length} MCP servers, ${config.exemptions.length} exemptions`,
  );
  return 0;
}

function commandVersion(cmd: string, args: string[]): string | undefined {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return !res.error && res.status === 0 ? versionIn(`${res.stdout} ${res.stderr}`) : undefined;
}

const HOOK_TYPES = ['pre-commit', 'prepare-commit-msg', 'pre-push'] as const;

const HUSKY_PATH = /(^|[\\/])\.husky([\\/]_)?[\\/]?$/;

/**
 * Is this machine and repository ready for the local hooks? Compares installed
 * tools with the versions pinned in policy.yaml and checks that the
 * repository's .pre-commit-config.yaml is connected: by "pre-commit install"
 * in .git/hooks, or, in a repository that uses husky, by .husky/<hook> calling
 * "pre-commit run --hook-stage <hook>".
 */
function doctor(flags: Flags): number {
  const config = loadConfig(str(flags, 'config'));
  const pins = config.policy.tools ?? {};
  let problems = 0;
  let warnings = 0;
  const row = (status: 'ok' | 'WARN' | 'FAIL', name: string, detail: string): void => {
    if (status === 'FAIL') problems++;
    if (status === 'WARN') warnings++;
    print(`  ${status.padEnd(4)}  ${name.padEnd(24)} ${detail}`);
  };
  const tool = (name: string, installed: string | undefined, required: boolean, purpose: string): void => {
    const pin = pins[name];
    if (!installed)
      row(required ? 'FAIL' : 'WARN', name, `not found (${purpose}); run "qa setup"${pin ? ` (installs ${pin})` : ''}`);
    else if (pin && installed !== pin) row('WARN', name, `${installed} installed, ${pin} pinned`);
    else row('ok', name, `${installed}${pin ? ' (pinned)' : ''}`);
  };

  print(`qa ${ENGINE_VERSION} doctor`);
  {
    const located = locateConfig(str(flags, 'config'));
    print(`Configuration ${located.dir} (${located.origin})`);
  }
  print('Tools');
  const node = process.versions.node;
  row(Number(node.split('.')[0]) >= 20 ? 'ok' : 'FAIL', 'node', `${node} (needs 20 or later)`);
  tool('git', commandVersion('git', ['--version']), true, 'needed by every hook');
  tool('pre-commit', commandVersion(toolBinary('pre-commit'), ['--version']), true, 'runs the hooks');
  tool(
    'gitleaks',
    TOOL_ADAPTERS.gitleaks.version(),
    true,
    'secret scan at pre-commit; without it the scan runs only in CI',
  );
  tool('semgrep', TOOL_ADAPTERS.semgrep.version(), false, 'fast rule set at pre-push; optional locally, always in CI');

  // A git template with pre-commit's hooks connects them in every new clone,
  // so "pre-commit install" is not needed per repository.
  const tpl = spawnSync('git', ['config', '--global', '--get', 'init.templateDir'], { encoding: 'utf8' });
  const tplDir = tpl.status === 0 ? tpl.stdout.trim().replace(/^~(?=[\\/])/, homedir()) : '';
  const tplHooks = HOOK_TYPES.filter((h) => {
    const file = join(tplDir, 'hooks', h);
    return tplDir !== '' && existsSync(file) && readFileSync(file, 'utf8').includes('pre-commit');
  });
  if (tplHooks.length === HOOK_TYPES.length) row('ok', 'git template', `${tplDir} connects the hooks in new clones`);
  else if (tplHooks.length > 0)
    row(
      'WARN',
      'git template',
      `${tplDir} lacks ${HOOK_TYPES.filter((h) => !tplHooks.includes(h)).join(', ')}; run "qa setup" to update it`,
    );
  else
    row(
      'WARN',
      'git template',
      'not set up; each clone needs "pre-commit install" (see docs/PRECOMMIT.md, once per machine)',
    );

  const root = rootOf(flags);
  // The prepare-commit-msg hook adds this to commit messages.
  const assisted = assistedByDefault(root);
  if (!assisted)
    row(
      'WARN',
      'Assisted-by default',
      `not set; set it once: git config --global ledgerlink.assistedBy "<tool>, <model>, <version>" ("${NO_DEFAULT}" without AI tools)`,
    );
  else if (assisted.toLowerCase() === NO_DEFAULT) row('ok', 'Assisted-by default', `"${NO_DEFAULT}": no AI tools`);
  else if (parseTrailerValue(assisted)) row('ok', 'Assisted-by default', assisted);
  else row('WARN', 'Assisted-by default', `"${assisted}" is not "<tool>, <model>, <version>"; the hook ignores it`);

  const repoRoot = tryGitRoot(root);
  print(`Repository ${repoRoot ?? root}`);
  {
    const d = gate(loadAllowlist(str(flags, 'config')), root);
    if (d.run) row('ok', 'QA enabled', `${d.repo.owner}/${d.repo.name} is in the allowlist`);
    else row('WARN', 'QA enabled', `no: ${d.reason}; the hooks do nothing here`);
  }
  if (!repoRoot) {
    row('FAIL', 'git repository', 'not a git repository');
  } else {
    const res = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repoRoot, encoding: 'utf8' });
    const hooksPath = res.status === 0 ? res.stdout.trim() : '';
    const huskyDir = join(repoRoot, '.husky');
    row(
      existsSync(join(repoRoot, '.pre-commit-config.yaml')) ? 'ok' : 'FAIL',
      '.pre-commit-config.yaml',
      existsSync(join(repoRoot, '.pre-commit-config.yaml'))
        ? 'present'
        : 'missing; copy templates/pre-commit-config.yaml',
    );
    const configText = existsSync(join(repoRoot, '.pre-commit-config.yaml'))
      ? readFileSync(join(repoRoot, '.pre-commit-config.yaml'), 'utf8')
      : '';
    const required = /qa --require[ =](\d+\.\d+\.\d+)/.exec(configText)?.[1];
    if (required)
      row(
        satisfies(ENGINE_VERSION, required) ? 'ok' : 'FAIL',
        'qa version',
        satisfies(ENGINE_VERSION, required)
          ? `${ENGINE_VERSION} installed; the repository requires ${required}`
          : `${ENGINE_VERSION} installed; the repository requires ${required}: npm install -g @ledgerlink/qa@${required}`,
      );

    if (HUSKY_PATH.test(hooksPath)) {
      // husky owns core.hooksPath; its .husky/<hook> scripts call pre-commit.
      row('ok', 'husky', `hooks run from ${hooksPath}`);
      for (const hook of HOOK_TYPES) {
        const script = join(huskyDir, hook);
        const text = existsSync(script) ? readFileSync(script, 'utf8') : '';
        if (!text.includes(`pre-commit run --hook-stage ${hook}`))
          row('FAIL', `${hook} hook`, `.husky/${hook} does not call "pre-commit run --hook-stage ${hook}"`);
        else if (!existsSync(resolve(repoRoot, hooksPath, hook)))
          row('FAIL', `${hook} hook`, `husky has not generated ${hooksPath}/${hook}; run "yarn install"`);
        else row('ok', `${hook} hook`, `installed through husky (.husky/${hook})`);
      }
    } else {
      if (hooksPath)
        row('FAIL', 'core.hooksPath', `set to "${hooksPath}"; pre-commit will not install. Unset it first.`);
      // git runs .git/hooks, connected by "pre-commit install".
      const direct = HOOK_TYPES.map((hook) => {
        const path = execFileSync('git', ['rev-parse', '--git-path', `hooks/${hook}`], { cwd: repoRoot })
          .toString('utf8')
          .trim();
        const full = resolve(repoRoot, path);
        return { hook, installed: existsSync(full) && readFileSync(full, 'utf8').includes('pre-commit') };
      });
      if (existsSync(huskyDir)) {
        // A husky repository whose dependencies are not installed yet can be
        // connected directly for testing; husky takes over on "yarn install".
        if (direct.every((d) => d.installed))
          row(
            'WARN',
            'husky',
            'not set up yet; hooks are connected directly by "pre-commit install" until "yarn install"',
          );
        else row('FAIL', 'husky', 'not set up; run "yarn install", or "pre-commit install" to test before then');
      }
      for (const { hook, installed } of direct)
        row(
          installed ? 'ok' : 'FAIL',
          `${hook} hook`,
          installed ? 'installed (pre-commit install)' : 'not installed; run "pre-commit install"',
        );
    }
  }
  print(
    problems > 0
      ? `result: NOT READY (${problems} problem(s), ${warnings} warning(s))`
      : `result: READY${warnings > 0 ? ` (${warnings} warning(s))` : ''}`,
  );
  return problems > 0 ? 1 : 0;
}

async function conform(flags: Flags): Promise<number> {
  const config = loadConfig(str(flags, 'config'));
  const fixtures = resolve(str(flags, 'fixtures') ?? join(config.dir, 'conformance', 'fixtures'));
  const bin = resolve(__dirname, '..', 'bin', 'qa.js');
  const cliPath = __filename.endsWith('.js') && existsSync(bin) ? bin : undefined;
  const results = await runConformance(config, fixtures, cliPath);
  for (const tool of unavailableTools(config)) {
    print(
      `note: ${tool} is not installed, so checks that use it are excluded and fixtures that require it are skipped.`,
    );
  }
  for (const r of results) {
    print(
      `${r.status.toUpperCase().padEnd(7)} ${r.id.padEnd(5)} ${r.title}${r.paths.length ? `  (paths: ${r.paths.join(', ')})` : ''}`,
    );
    for (const reason of r.reasons) print(`        ${reason}`);
  }
  const count = (s: string): number => results.filter((r) => r.status === s).length;
  print(
    `conformance: ${count('pass')} pass, ${count('fail')} fail, ${count('skip')} skipped, ${count('pending')} pending`,
  );
  return count('fail') > 0 ? 1 : 0;
}

/**
 * Runs a tool from the repository's own node_modules, so its version comes
 * from the repository's lockfile, with the arguments and files pre-commit
 * passes. In a clone whose dependencies are not installed yet it says so and
 * passes: local checks may be skipped, and CI runs them.
 */
function repoTool(args: string[]): number {
  // --pr-files: run on the files the pull request changes instead, so files
  // that were already out of line before it do not block it.
  const prFiles = args[0] === '--pr-files';
  const [spec, ...rest] = prFiles ? args.slice(1) : args;
  if (!spec || spec.startsWith('-'))
    throw new UsageError('qa repo-tool needs a package name, e.g. "qa repo-tool eslint"');
  const [pkg, binName = pkg] = spec.split(':');
  assertPackageName(pkg, binName);
  const root = rootOf({});
  if (prFiles) {
    const base =
      process.env.QA_PR_BASE !== undefined ? assertRef(process.env.QA_PR_BASE, 'QA_PR_BASE') : defaultBase(root);
    if (!base) throw new UsageError('no base branch found; set QA_PR_BASE, e.g. QA_PR_BASE=origin/develop');
    const files = gitRangeFiles(root, base)
      .filter((f) => f.status !== 'D')
      .map((f) => f.path);
    if (files.length === 0) {
      print(`qa: no files changed since ${base}; ${pkg} skipped.`);
      return 0;
    }
    rest.push(...files);
  }
  const manifest = join(root, 'node_modules', pkg, 'package.json');
  if (!existsSync(manifest)) {
    print(`qa: ${pkg} is not installed in this repository yet (run its package install); skipped here, CI runs it.`);
    return 0;
  }
  const meta = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> };
  const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[binName];
  if (!bin) throw new Error(`${pkg} has no "${binName}" executable in its package.json`);
  const script = resolve(dirname(manifest), bin);
  // The executable must be a file of that package, not a path that climbs out of it.
  if (!isWithin(script, dirname(manifest)) || !existsSync(script))
    throw new InputError(`${pkg}'s "${binName}" executable (${bin}) is not a file inside the package`);
  const res = spawnSync(process.execPath, [script, ...rest], { cwd: root, stdio: 'inherit' });
  if (res.error) throw res.error;
  return res.status ?? 2;
}

/**
 * Runs a package.json script (tests, type check, build) with the package
 * manager the repository's lockfile names. Like repo-tool, it passes with a
 * notice where dependencies are not installed yet, and also where the
 * repository has no such script, so one template fits every repository.
 */
function repoScript(args: string[]): number {
  const root = rootOf({});
  let cwd = root;
  let advisory = false;
  for (;;) {
    if (args[0] === '--cwd') {
      if (!args[1]) throw new UsageError('--cwd needs a directory');
      cwd = resolve(root, args[1]);
      if (!isWithin(cwd, root)) throw new InputError(`--cwd ${args[1]} is outside the repository`);
      args = args.slice(2);
    } else if (args[0] === '--advisory') {
      advisory = true;
      args = args.slice(1);
    } else break;
  }
  const [script, ...rest] = args;
  if (!script || script.startsWith('-'))
    throw new UsageError('qa repo-script needs a script name, e.g. "qa repo-script test"');
  if (!/^[A-Za-z0-9][\w:.@/-]*$/.test(script)) throw new InputError(`"${script.slice(0, 60)}" is not a script name`);
  const where = toPosix(relative(root, cwd)) || '.';
  const manifest = join(cwd, 'package.json');
  const scripts = existsSync(manifest)
    ? ((JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {})
    : {};
  if (!scripts[script]) {
    print(`qa: ${where}/package.json has no "${script}" script; skipped.`);
    return 0;
  }
  // An install that failed (for example a private registry without a login)
  // can leave node_modules empty, so look for installed packages, not the folder.
  const installed =
    existsSync(join(cwd, 'node_modules')) && readdirSync(join(cwd, 'node_modules')).some((n) => !n.startsWith('.'));
  if (!installed) {
    print(
      `qa: dependencies are not installed in ${where} yet (run its package install); "${script}" skipped here, CI runs it.`,
    );
    return 0;
  }
  const lockIn = (name: string): boolean => existsSync(join(cwd, name)) || existsSync(join(root, name));
  const pm = lockIn('yarn.lock') ? 'yarn' : lockIn('pnpm-lock.yaml') ? 'pnpm' : 'npm';
  const runArgs = ['run', script, ...(rest.length > 0 && pm === 'npm' ? ['--'] : []), ...rest];
  // Package managers are .cmd shims on Windows, which only a shell can start;
  // the shell takes one command line, built so cmd.exe reads every argument literally.
  const res =
    process.platform === 'win32'
      ? spawnSync(windowsCommandLine([pm, ...runArgs]), { cwd, stdio: 'inherit', shell: true })
      : spawnSync(pm, runArgs, { cwd, stdio: 'inherit' });
  if (res.error) throw res.error;
  if (advisory && res.status !== 0) {
    print(`qa: "${script}" failed (exit ${res.status}); advisory here, not blocking. CI enforces it.`);
    return 0;
  }
  return res.status ?? 2;
}

/** npm package and executable names: nothing that could be a path or an option. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

export function assertPackageName(pkg: string, bin: string): void {
  if (!NPM_NAME.test(pkg)) throw new InputError(`"${pkg.slice(0, 60)}" is not an npm package name`);
  if (!/^[A-Za-z0-9][\w.-]*$/.test(bin)) throw new InputError(`"${bin.slice(0, 60)}" is not an executable name`);
}

/**
 * One cmd.exe command line from an argument list. Plain arguments pass as they
 * are; anything else is double-quoted, inside which cmd.exe treats & | < > ( )
 * and ^ literally. Characters cmd.exe still interprets inside quotes are
 * refused: % (variable expansion), ! (delayed expansion), " and line breaks.
 */
export function windowsCommandLine(args: string[]): string {
  return args
    .map((a) => {
      if (/^[\w@+=:,./\\-]+$/.test(a)) return a;
      if (/["%!\r\n\0]/.test(a))
        throw new InputError(`refusing the argument ${JSON.stringify(a.slice(0, 60))}: cmd.exe would interpret it`);
      return `"${a}"`;
    })
    .join(' ');
}

/**
 * Is the installed engine compatible with the version a repository requires?
 * The same major version (the same minor below 1.0), and not older.
 */
export function satisfies(installed: string, required: string): boolean {
  const parse = (v: string): number[] => v.split('.').map(Number);
  const [a, b] = [parse(installed), parse(required)];
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(Number.isNaN)) return false;
  if (a[0] !== b[0] || (b[0] === 0 && a[1] !== b[1])) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** Commands that act on the repository they run in; the rest are diagnostics or work on this package. */
const GATED = new Set(['check', 'precommit', 'prepare-commit-msg', 'prepush', 'prepr', 'baseline']);

/**
 * The execution gate (issue #8). Returns an exit code when the command must
 * not run here, else undefined. A repository that is not allowlisted is
 * skipped silently; an identity that cannot be verified in CI is an error.
 */
function gateExit(command: string, root: string, configDir?: string): number | undefined {
  const log = logger();
  // The message hook never blocks a commit.
  const refused = command === 'prepare-commit-msg' ? 0 : 2;
  const located = locateConfig(configDir);
  const problem = configSourceProblem(located, root);
  if (problem) {
    log.error('gate.config-refused', { command, reason: problem }, `refusing to run: ${problem}`);
    return refused;
  }
  const decision = gate(loadAllowlist(located.dir), root);
  if (decision.run) {
    log.info('gate.allowed', { command, repo: `${decision.repo.owner}/${decision.repo.name}`, config: located.origin });
    return undefined;
  }
  if ('failClosed' in decision) {
    log.error(
      'gate.unverified',
      { command, reason: decision.reason },
      `cannot verify this repository, so QA did not run: ${decision.reason}`,
    );
    return refused;
  }
  log.info('gate.skipped', { command, reason: decision.reason });
  return 0;
}

function cacheCommand(positionals: string[]): number {
  const [action] = positionals;
  if (action === 'clear') {
    clearCache();
    print(`Cleared ${cacheDir()}`);
    return 0;
  }
  if (action === 'path') {
    print(cacheDir());
    return 0;
  }
  throw new UsageError('qa cache needs "clear" or "path"');
}

/** Logging from --log-format/--log-level anywhere in argv, else the environment. */
function configureLogging(argv: string[]): void {
  const value = (name: string): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${name}`) return argv[i + 1];
      if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
    }
    return undefined;
  };
  setLogger(createLogger(parseLogSettings(value('log-format'), value('log-level'))));
}

export async function main(argv: string[]): Promise<number> {
  try {
    configureLogging(argv[0] === 'repo-tool' || argv[0] === 'repo-script' ? [] : argv);
  } catch (err) {
    process.stderr.write(`qa: ${(err as Error).message}\n`);
    return 2;
  }
  try {
    // A repository's hooks call "qa --require <version> <command>", so a
    // machine with an incompatible qa stops with instructions instead of
    // checking against other rules.
    const pin = /^--require(?:=(.+))?$/.exec(argv[0] ?? '');
    if (pin) {
      const required = pin[1] ?? argv[1];
      argv = argv.slice(pin[1] ? 1 : 2);
      if (!required || !/^\d+\.\d+\.\d+$/.test(required)) throw new UsageError('--require needs a version, e.g. 0.1.0');
      if (!satisfies(ENGINE_VERSION, required)) {
        process.stderr.write(
          `qa: this repository needs qa ${required} (compatible versions); ${ENGINE_VERSION} is installed.\n` +
            `Install it: npm install -g @ledgerlink/qa@${required}  (or the .tgz from your team's release)\n`,
        );
        // The message hook never blocks a commit, not even for this.
        return argv[0] === 'prepare-commit-msg' ? 0 : 2;
      }
    }
    // Everything after the package name belongs to the tool, not to qa.
    if (argv[0] === 'repo-tool' || argv[0] === 'repo-script') {
      const skipped = gateExit(argv[0], rootOf({}));
      if (skipped !== undefined) return skipped;
      return argv[0] === 'repo-tool' ? repoTool(argv.slice(1)) : repoScript(argv.slice(1));
    }
    const { command, positionals, flags } = parseArgs(argv);
    if (flags.help) {
      print(USAGE);
      return 0;
    }
    if (GATED.has(command)) {
      const skipped = gateExit(command, rootOf(flags), str(flags, 'config'));
      if (skipped !== undefined) return skipped;
    }
    switch (command) {
      case 'check':
        return await check(flags);
      case 'precommit':
        return await check(flags, 'staged', { stages: [0, 1] });
      case 'prepare-commit-msg':
        return prepareCommitMsg(positionals, flags);
      case 'prepush':
        return await prepush(flags);
      case 'prepr':
        return await prepr(flags);
      case 'setup': {
        const home = str(flags, 'home');
        if (home) process.env.QA_HOME = resolve(home);
        return await setup(
          loadConfig(str(flags, 'config')),
          {
            python: !flags['no-python'],
            gitleaks: !flags['no-gitleaks'],
            gitTemplate: !flags['no-git-template'],
            gitleaksArchive: str(flags, 'gitleaks-archive'),
            downloadBase: str(flags, 'download-base'),
          },
          print,
        );
      }
      case 'doctor':
        return doctor(flags);
      case 'baseline':
        return await baseline(flags);
      case 'rules':
        return rules(positionals, flags);
      case 'validate':
        return validate(flags);
      case 'conform':
        return await conform(flags);
      case 'cache':
        return cacheCommand(positionals);
      case 'version':
      case '--version':
        print(ENGINE_VERSION);
        return 0;
      case 'help':
      case '--help':
        print(USAGE);
        return 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    const log = logger();
    const message = redact((err as Error).message);
    if (err instanceof UsageError) log.error('usage.error', { error: message }, `${message}\nRun "qa help" for usage.`);
    else if (err instanceof InputError) log.error('input.refused', { error: message }, `refused: ${message}`);
    else if (err instanceof ConfigError)
      log.error('config.error', { error: message }, `configuration error: ${message}`);
    else log.error('engine.error', { error: message }, `engine error: ${message}`);
    return 2;
  }
}
