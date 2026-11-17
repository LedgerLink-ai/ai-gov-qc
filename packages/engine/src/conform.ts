import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { TOOL_ADAPTERS } from './adapters/tools';
import { schemaValidator } from './config';
import { today } from './policy';
import { run } from './runner';
import { directorySource, listFiles } from './sources';
import type { Actor, Config, PrText } from './types';

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
  pr_title?: string;
  pr_body?: string;
  baseline_from_self?: boolean;
  values?: Record<string, string[] | { codepoint: string }>;
  exact?: boolean;
  expect: Array<{ check: string; path?: string; blocking: boolean }>;
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
const prBodyFile = (root: string): string => `${root}.PR_BODY.md`;

/** The fixture's pull request title and description, when it has either. */
const fixturePrText = (f: Fixture): PrText | undefined =>
  f.pr_title === undefined && f.pr_body === undefined ? undefined : { title: f.pr_title ?? '', body: f.pr_body ?? '' };

const key = (o: Observed): string => `${o.check}|${o.path ?? ''}|${o.level}|${o.blocking}|${o.fingerprint}`;

async function runApi(
  config: Config,
  fixture: Fixture,
  root: string,
  baseline?: Set<string>,
): Promise<{ observed: Observed[]; errors: string[] }> {
  const result = await run({
    config,
    repo: fixture.repo,
    sha: `fixture-${fixture.id}`,
    root,
    actor: fixture.actor,
    mode: 'ci',
    asOf: fixture.as_of ?? today(),
    changedFiles: listFiles(root).map((path) => ({ path, status: 'A' as const })),
    source: directorySource(root),
    commitMessage: fixture.commit_message,
    prText: fixturePrText(fixture),
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
const CONFORMANCE_ENV: NodeJS.ProcessEnv = { ...process.env, QA_CONFORMANCE: '1' };
// A fixture's pull request text comes from the fixture only, never from the
// GitHub event of the run that executes the fixtures.
for (const k of ['GITHUB_EVENT_PATH', 'QA_PR_TITLE', 'QA_PR_BODY_FILE']) delete CONFORMANCE_ENV[k];

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
  if (fixture.commit_message !== undefined) {
    const msgFile = commitMessageFile(root);
    writeFileSync(msgFile, fixture.commit_message);
    extra.push('--commit-msg-file', msgFile);
  }
  const prText = fixturePrText(fixture);
  if (prText) {
    writeFileSync(prBodyFile(root), prText.body);
    extra.push('--pr-title', prText.title, '--pr-body-file', prBodyFile(root));
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
  if (res.status === null || res.status > 2 || !res.stdout) {
    return { observed: [], errors: [`qa check exited ${res.status}: ${res.stderr.trim()}`] };
  }
  const json = JSON.parse(res.stdout) as {
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

  const root = materialise(fixtureDir, fixture);
  try {
    const reasons: string[] = [];
    let baseline: Set<string> | undefined;
    if (fixture.baseline_from_self) {
      const first = await runApi(config, fixture, root);
      baseline = new Set(first.observed.map((o) => o.fingerprint));
    }
    const api = await runApi(config, fixture, root, baseline);
    base.paths.push('api');
    reasons.push(...api.errors.map((e) => `api: engine error: ${e}`));
    reasons.push(...compare(fixture, api.observed).map((r) => `api: ${r}`));

    if (cliPath) {
      const cli = runCli(cliPath, config, fixture, root);
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
    rmSync(prBodyFile(root), { force: true });
  }
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
