import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { TOOL_ADAPTERS } from './adapters/tools';
import { schemaValidator } from './config';
import { today } from './policy';
import { run } from './runner';
import { commitSource, directorySource, gitRangeCommits, gitRangeDiffStat, gitRangeFiles, listFiles } from './sources';
import type { Actor, ChangedFile, Config, CoverageSummary, FileSource, PrInfo } from './types';

// Conformance (Technical Design 10.5): planted defects run through every entry
// point and must produce the expected findings, identically on each path.

export interface Fixture {
  id: string;
  title: string;
  repo: string;
  actor: Actor;
  as_of?: string;
  requires?: string[];
  pending?: string;
  commit_message?: string;
  /** The branch being committed to: runs branch.ticket, and commit.message against it. */
  branch?: string;
  baseline_from_self?: boolean;
  values?: Record<string, string[] | { codepoint: string }>;
  exact?: boolean;
  /**
   * File operations. With these (or pr), the fixture runs in a git repository:
   * tree/ is committed on main and the operations on a branch, so the engine
   * reads the change from git as "qa check --base" and "qa prepr" do (renames
   * and deletions included).
   */
  operations?: FileOperation[];
  /** A pull request: the checks run as "qa prepr" runs them, with the pull request rules. */
  pr?: FixturePr;
  expect: Array<{ check: string; path?: string; blocking: boolean }>;
}

export type FileOperation =
  | { rename: { from: string; to: string } }
  | { delete: string }
  | { write: { path: string; lines?: number; text?: string } };

export interface FixturePr {
  /** The pull request's branch (default feature/QA-1-conformance-fixture). */
  branch?: string;
  /** Its commits, oldest first; the first carries the operations, later ones are empty. */
  commits?: Array<{ message: string }>;
  /** Coverage summaries the test run before qa wrote (in the work tree, never committed). */
  coverage?: Array<{ file: string; lines_pct: number }>;
}

/** The comparable part of a finding: what must be identical across paths. */
export interface Observed {
  check: string;
  path?: string;
  level: string;
  blocking: boolean;
  fingerprint: string;
}

export interface FixtureResult {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skip' | 'pending';
  reasons: string[];
  paths: string[];
}

const TEMPLATE_SUFFIX = '.tmpl';
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

function renderValue(value: string[] | { codepoint: string }): string {
  return Array.isArray(value) ? value.join('') : String.fromCodePoint(parseInt(value.codepoint.slice(2), 16));
}

/** Writes the fixture tree to a temporary directory, filling placeholders. */
export function materialise(fixtureDir: string, fixture: Fixture): string {
  const tree = join(fixtureDir, 'tree');
  const out = mkdtempSync(join(tmpdir(), `qa-${fixture.id}-`));
  const files = existsSync(tree) ? listFiles(tree) : [];
  for (const rel of files) {
    if (!rel.endsWith(TEMPLATE_SUFFIX)) throw new Error(`${fixture.id}: ${rel} must end in ${TEMPLATE_SUFFIX}`);
    const text = readFileSync(join(tree, rel), 'utf8').replace(PLACEHOLDER, (_m, name: string) => {
      const value = fixture.values?.[name];
      if (!value) throw new Error(`${fixture.id}: placeholder {{${name}}} has no value`);
      return renderValue(value);
    });
    const target = join(out, rel.slice(0, -TEMPLATE_SUFFIX.length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return out;
}

export function loadFixture(config: Config, fixtureDir: string): Fixture {
  const data = parseYaml(readFileSync(join(fixtureDir, 'fixture.yaml'), 'utf8'));
  const validate = schemaValidator(config.dir, 'fixture.schema.json');
  if (!validate(data)) {
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new Error(`${fixtureDir}: fixture.yaml does not match its schema: ${errors}`);
  }
  return data as Fixture;
}

/** External tools named in checks.yaml that are not installed on this machine. */
export function unavailableTools(config: Config): string[] {
  const tools = new Set(config.checks.filter((c) => c.kind === 'tool').map((c) => c.tool as string));
  return [...tools].filter((t) => !TOOL_ADAPTERS[t]?.available()).sort();
}

/**
 * Checks whose tool is missing are excluded from fixture runs (and reported as
 * skipped), so a missing scanner does not mask what the other checks find.
 * Fixtures that need the tool are skipped instead.
 */
function excludedChecks(config: Config): string[] {
  const missing = new Set(unavailableTools(config));
  return config.checks.filter((c) => c.kind === 'tool' && missing.has(c.tool as string)).map((c) => c.id);
}

/** Kept beside the fixture tree, never inside it, so it is not a changed file. */
const commitMessageFile = (root: string): string => `${root}.COMMIT_EDITMSG`;

const key = (o: Observed): string => `${o.check}|${o.path ?? ''}|${o.level}|${o.blocking}|${o.fingerprint}`;

/** What the API path runs on: a loose folder (every file added), or a git range and pull request. */
interface ApiSelection {
  changedFiles: ChangedFile[];
  source: FileSource;
  pr?: PrInfo;
}

const folderSelection = (root: string): ApiSelection => ({
  changedFiles: listFiles(root).map((path) => ({ path, status: 'A' as const })),
  source: directorySource(root),
});

async function runApi(
  config: Config,
  fixture: Fixture,
  root: string,
  baseline?: Set<string>,
  sel: ApiSelection = folderSelection(root),
): Promise<{ observed: Observed[]; errors: string[] }> {
  const result = await run({
    config,
    repo: fixture.repo,
    sha: `fixture-${fixture.id}`,
    root,
    actor: fixture.actor,
    mode: 'ci',
    asOf: fixture.as_of ?? today(),
    changedFiles: sel.changedFiles,
    source: sel.source,
    pr: sel.pr,
    commitMessage: fixture.commit_message,
    branch: fixture.branch,
    baseline,
    exclude: excludedChecks(config),
  });
  return {
    observed: result.findings.map((f) => ({
      check: f.checkId,
      path: f.path,
      level: f.level,
      blocking: f.blocking,
      fingerprint: f.fingerprint,
    })),
    errors: result.engineErrors,
  };
}

/**
 * Fixtures are loose folders in the temp directory, not allowlisted
 * repositories. The execution gate honours this only for such a folder
 * (outside any git work tree), never for a real repository.
 */
const CONFORMANCE_ENV = { ...process.env, QA_CONFORMANCE: '1' };

function runCli(
  cliPath: string,
  config: Config,
  fixture: Fixture,
  root: string,
): { observed: Observed[]; errors: string[] } {
  const common = [
    '--config',
    config.dir,
    '--root',
    root,
    '--all',
    '--repo',
    fixture.repo,
    '--actor',
    fixture.actor,
    '--mode',
    'ci',
    '--as-of',
    fixture.as_of ?? today(),
  ];
  const excluded = excludedChecks(config);
  if (excluded.length > 0) common.push('--exclude', excluded.join(','));
  const extra: string[] = [];
  if (fixture.branch !== undefined) extra.push('--branch', fixture.branch);
  if (fixture.commit_message !== undefined) {
    const msgFile = commitMessageFile(root);
    writeFileSync(msgFile, fixture.commit_message);
    extra.push('--commit-msg-file', msgFile);
  }
  if (fixture.baseline_from_self) {
    const b = spawnSync(process.execPath, [cliPath, 'baseline', ...common, ...extra], {
      encoding: 'utf8',
      env: CONFORMANCE_ENV,
    });
    if (b.status !== 0) return { observed: [], errors: [`qa baseline exited ${b.status}: ${b.stderr.trim()}`] };
  }
  const res = spawnSync(process.execPath, [cliPath, 'check', ...common, ...extra, '--format', 'json'], {
    encoding: 'utf8',
    env: CONFORMANCE_ENV,
  });
  return parseCliJson(res, 'check');
}

function parseCliJson(
  res: { status: number | null; stdout: string | Buffer | null; stderr: string | Buffer | null },
  command: string,
): { observed: Observed[]; errors: string[] } {
  const stdout = String(res.stdout ?? '');
  if (res.status === null || res.status > 2 || !stdout) {
    return { observed: [], errors: [`qa ${command} exited ${res.status}: ${String(res.stderr ?? '').trim()}`] };
  }
  const json = JSON.parse(stdout) as {
    findings: Array<{ check: string; path?: string; level: string; blocking: boolean; fingerprint: string }>;
    engine_errors: string[];
  };
  return {
    observed: json.findings.map((f) => ({
      check: f.check,
      path: f.path ?? undefined,
      level: f.level,
      blocking: f.blocking,
      fingerprint: f.fingerprint,
    })),
    errors: json.engine_errors,
  };
}

// ---- Fixtures in a git repository: file operations and pull requests ----

const BASE_BRANCH = 'main';
const DEFAULT_PR_BRANCH = 'feature/QA-1-conformance-fixture';
const isGitFixture = (fixture: Fixture): boolean => fixture.operations !== undefined || fixture.pr !== undefined;
/** An empty git configuration beside the fixture: nothing from the machine (hooks, templates, signing). */
const emptyGitConfig = (root: string): string => `${root}.gitconfig`;

function gitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGitConfig(root),
    GIT_AUTHOR_NAME: 'qa conformance',
    GIT_AUTHOR_EMAIL: 'conformance@example.invalid',
    GIT_COMMITTER_NAME: 'qa conformance',
    GIT_COMMITTER_EMAIL: 'conformance@example.invalid',
  };
}

function insideFixture(fixture: Fixture, root: string, rel: string): string {
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..'))
    throw new Error(`${fixture.id}: ${rel} must be a relative path inside the fixture`);
  return join(root, rel);
}

/** Turns the materialised tree into a repository: tree/ on main, the operations on the pull request branch. */
function buildRepository(fixture: Fixture, root: string): void {
  writeFileSync(emptyGitConfig(root), '');
  const env = gitEnv(root);
  const hooks = mkdtempSync(join(tmpdir(), `qa-${fixture.id}-nohooks-`));
  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
      { cwd: root, env, stdio: 'pipe' },
    );
  };
  try {
    git('init', '-q', '--template=', '-b', BASE_BRANCH);
    git('remote', 'add', 'origin', `https://github.com/LedgerLink-ai/${fixture.repo}.git`);
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'chore(QA-1): base of the fixture');
    git('checkout', '-q', '-b', fixture.pr?.branch ?? DEFAULT_PR_BRANCH);
    for (const op of fixture.operations ?? []) {
      if ('rename' in op) {
        insideFixture(fixture, root, op.rename.from);
        mkdirSync(dirname(insideFixture(fixture, root, op.rename.to)), { recursive: true });
        git('mv', '--', op.rename.from, op.rename.to);
      } else if ('delete' in op) {
        insideFixture(fixture, root, op.delete);
        git('rm', '-q', '--', op.delete);
      } else {
        const target = insideFixture(fixture, root, op.write.path);
        mkdirSync(dirname(target), { recursive: true });
        const generated = Array.from({ length: op.write.lines ?? 1 }, (_v, i) => `export const n${i + 1} = ${i + 1};`);
        writeFileSync(target, op.write.text ?? `${generated.join('\n')}\n`);
        git('add', '--', op.write.path);
      }
    }
    const commits = fixture.pr?.commits ?? [{ message: 'chore(QA-1): the change' }];
    for (const c of commits) git('commit', '-q', '--allow-empty', '--no-verify', '--cleanup=verbatim', '-m', c.message);
    // Coverage the test run wrote: in the work tree, never committed.
    for (const c of fixture.pr?.coverage ?? []) {
      const target = insideFixture(fixture, root, c.file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        JSON.stringify({ total: { lines: { total: 100, covered: c.lines_pct, pct: c.lines_pct } } }),
      );
    }
  } finally {
    rmSync(hooks, { recursive: true, force: true });
  }
}

function gitSelection(fixture: Fixture, root: string): ApiSelection {
  const coverage: CoverageSummary[] = (fixture.pr?.coverage ?? []).map((c) => ({
    file: c.file,
    linesPct: c.lines_pct,
  }));
  return {
    changedFiles: gitRangeFiles(root, BASE_BRANCH),
    source: commitSource(root, 'HEAD'),
    pr: fixture.pr
      ? {
          base: BASE_BRANCH,
          branch: fixture.pr.branch ?? DEFAULT_PR_BRANCH,
          commits: gitRangeCommits(root, BASE_BRANCH),
          diff: gitRangeDiffStat(root, BASE_BRANCH),
          coverage,
        }
      : undefined,
  };
}

/**
 * The CLI path for a git fixture: "qa prepr" (or "qa check --base") in CI
 * mode, as on a CI server other than GitHub Actions; the repository's identity
 * is its origin, an allowlisted LedgerLink-ai repository.
 */
const TOOL_LOCATION = new Set(['QA_HOME', 'QA_GITLEAKS_BIN', 'QA_SEMGREP_BIN', 'QA_PRE_COMMIT_BIN']);

function runCliGit(
  cliPath: string,
  config: Config,
  fixture: Fixture,
  root: string,
): { observed: Observed[]; errors: string[] } {
  const env: NodeJS.ProcessEnv = {};
  // Drop everything that changes how qa decides, but keep where its tools are
  // installed, so the CLI path finds the same scanners as the API path.
  for (const [k, v] of Object.entries(process.env))
    if (TOOL_LOCATION.has(k) || !/^(GITHUB_|RUNNER_|ACTIONS_|QA_|PRE_COMMIT_)/.test(k)) env[k] = v;
  Object.assign(env, {
    CI: 'true',
    QA_NO_CACHE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGitConfig(root),
  });
  const command = fixture.pr ? 'prepr' : 'check';
  const args = [
    command,
    '--config',
    config.dir,
    '--root',
    root,
    '--base',
    BASE_BRANCH,
    '--repo',
    fixture.repo,
    '--actor',
    fixture.actor,
    '--mode',
    'ci',
    '--as-of',
    fixture.as_of ?? today(),
    '--format',
    'json',
    '--quiet',
  ];
  const excluded = excludedChecks(config);
  if (excluded.length > 0) args.push('--exclude', excluded.join(','));
  if (fixture.pr) env.QA_PR_BRANCH = fixture.pr.branch ?? DEFAULT_PR_BRANCH;
  else if (fixture.branch !== undefined) args.push('--branch', fixture.branch);
  if (fixture.commit_message !== undefined) {
    const msgFile = commitMessageFile(root);
    writeFileSync(msgFile, fixture.commit_message);
    args.push('--commit-msg-file', msgFile);
  }
  const res = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env, cwd: root });
  return parseCliJson(res, command);
}

function compare(fixture: Fixture, observed: Observed[]): string[] {
  const reasons: string[] = [];
  for (const exp of fixture.expect) {
    const hit = observed.find(
      (o) => o.check === exp.check && (exp.path === undefined || o.path === exp.path) && o.blocking === exp.blocking,
    );
    if (!hit) reasons.push(`expected ${exp.check}${exp.path ? ` on ${exp.path}` : ''} with blocking=${exp.blocking}`);
  }
  if (fixture.exact) {
    for (const o of observed.filter((x) => x.level === 'error' || x.blocking)) {
      const expected = fixture.expect.some((e) => e.check === o.check && (e.path === undefined || e.path === o.path));
      if (!expected)
        reasons.push(
          `unexpected ${o.check}${o.path ? ` on ${o.path}` : ''} (${o.level}${o.blocking ? ', blocking' : ''})`,
        );
    }
  }
  return reasons;
}

export async function runFixture(config: Config, fixtureDir: string, cliPath?: string): Promise<FixtureResult> {
  const fixture = loadFixture(config, fixtureDir);
  const base: Omit<FixtureResult, 'status' | 'reasons'> = { id: fixture.id, title: fixture.title, paths: [] };
  if (fixture.pending) return { ...base, status: 'pending', reasons: [fixture.pending] };
  const missing = (fixture.requires ?? []).filter((t) => !TOOL_ADAPTERS[t]?.available());
  if (missing.length > 0)
    return { ...base, status: 'skip', reasons: [`requires ${missing.join(', ')}, not installed`] };

  const git = isGitFixture(fixture);
  if (git && fixture.baseline_from_self)
    return { ...base, status: 'fail', reasons: ['baseline_from_self cannot be combined with operations or pr'] };
  const root = materialise(fixtureDir, fixture);
  try {
    if (git) buildRepository(fixture, root);
    const reasons: string[] = [];
    let baseline: Set<string> | undefined;
    if (fixture.baseline_from_self) {
      const first = await runApi(config, fixture, root);
      baseline = new Set(first.observed.map((o) => o.fingerprint));
    }
    const api = await runApi(config, fixture, root, baseline, git ? gitSelection(fixture, root) : undefined);
    base.paths.push('api');
    reasons.push(...api.errors.map((e) => `api: engine error: ${e}`));
    reasons.push(...compare(fixture, api.observed).map((r) => `api: ${r}`));

    if (cliPath) {
      const cli = git ? runCliGit(cliPath, config, fixture, root) : runCli(cliPath, config, fixture, root);
      base.paths.push('cli');
      reasons.push(...cli.errors.map((e) => `cli: engine error: ${e}`));
      const a = api.observed.map(key).sort().join('\n');
      const c = cli.observed.map(key).sort().join('\n');
      if (a !== c) reasons.push('cli: findings differ from the api path');
    }
    return { ...base, status: reasons.length === 0 ? 'pass' : 'fail', reasons };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(commitMessageFile(root), { force: true });
    rmSync(emptyGitConfig(root), { force: true });
  }
}

/**
 * The exit code of "qa conform": 1 when a fixture fails, and with requireAll
 * (CI, where qa setup installed every scanner) also when one is skipped or
 * pending, so a missing scanner cannot pass the conformance run.
 */
export function conformExitCode(results: FixtureResult[], requireAll = false): number {
  const notRun = results.some((r) => r.status === 'skip' || r.status === 'pending');
  return results.some((r) => r.status === 'fail') || (requireAll && notRun) ? 1 : 0;
}

export async function runConformance(config: Config, fixturesDir: string, cliPath?: string): Promise<FixtureResult[]> {
  const dirs = readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(fixturesDir, d.name, 'fixture.yaml')))
    .map((d) => join(fixturesDir, d.name))
    .sort();
  const results: FixtureResult[] = [];
  for (const dir of dirs) {
    try {
      results.push(await runFixture(config, dir, cliPath));
    } catch (err) {
      results.push({ id: dir, title: dir, status: 'fail', reasons: [(err as Error).message], paths: [] });
    }
  }
  return results;
}
