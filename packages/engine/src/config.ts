import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';
import { NATIVE_CHECKS } from './checks';
import { TOOL_ADAPTERS } from './adapters/tools';
import { ENGINE_VERSION } from './version';
import {
  ConfigError,
  type AiRegistry,
  type CheckDefinition,
  type Config,
  type Exemption,
  type PathTags,
  type RepositoryAllowlist,
  type Policy,
} from './types';

const FILES = {
  registry: 'registry/ai-registry.yaml',
  repositories: 'registry/repositories.yaml',
  pathTags: 'path-tags.yaml',
  checks: 'checks.yaml',
  policy: 'policy.yaml',
  exemptions: 'exemptions.yaml',
} as const;

const SCHEMAS: Record<keyof typeof FILES, string> = {
  registry: 'ai-registry.schema.json',
  repositories: 'repositories.schema.json',
  pathTags: 'path-tags.schema.json',
  checks: 'checks.schema.json',
  policy: 'policy.schema.json',
  exemptions: 'exemptions.schema.json',
};

export type ConfigOrigin = 'flag' | 'env' | 'bundled' | 'checkout';

/**
 * Where the registries live, in order: --config, QA_CONFIG_DIR, the snapshot
 * bundled in the published package, then the qc-workflows checkout this
 * package sits in. `origin` says which one was used, for the execution gate:
 * configuration named by a flag or the environment is refused when it sits
 * inside the repository being checked (gate.ts, configSourceProblem).
 */
export function locateConfig(explicit?: string): { dir: string; origin: ConfigOrigin } {
  const candidates: Array<[string | undefined, ConfigOrigin]> = [
    [explicit, 'flag'],
    [process.env.QA_CONFIG_DIR, 'env'],
    [resolve(__dirname, '..', 'config'), 'bundled'],
    [resolve(__dirname, '..', '..', '..'), 'checkout'],
  ];
  const tried: string[] = [];
  for (const [dir, origin] of candidates) {
    if (!dir) continue;
    tried.push(dir);
    if (existsSync(join(dir, FILES.policy)) && existsSync(join(dir, FILES.checks)))
      return { dir: resolve(dir), origin };
    // A directory the caller named that has no configuration is an error, not a reason to fall back.
    if (origin === 'flag' || origin === 'env')
      throw new ConfigError(
        `${dir} (from ${origin === 'flag' ? '--config' : 'QA_CONFIG_DIR'}) has no policy.yaml and checks.yaml`,
      );
  }
  throw new ConfigError(`No qa configuration found. Looked in: ${tried.join(', ')}`);
}

export function resolveConfigDir(explicit?: string): string {
  return locateConfig(explicit).dir;
}

/** -1, 0 or 1 as version a is older than, equal to or newer than b (MAJOR.MINOR.PATCH). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// One schema compiler per configuration directory: schemas carry a fixed $id,
// so two directories (the bundled configuration and a --config one, or two
// versions in one process) must not share a compiler.
const compilers = new Map<string, Ajv>();
const validators = new Map<string, ValidateFunction>();

export function schemaValidator(configDir: string, schemaFile: string): ValidateFunction {
  const schemaPath = join(configDir, 'schemas', schemaFile);
  const cached = validators.get(schemaPath);
  if (cached) return cached;
  if (!existsSync(schemaPath)) throw new ConfigError(`Schema not found: ${schemaPath}`);
  const key = resolve(configDir);
  let ajv = compilers.get(key);
  if (!ajv) {
    ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
    compilers.set(key, ajv);
  }
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  } catch (err) {
    throw new ConfigError(`Schema ${schemaFile} is invalid: ${(err as Error).message}`);
  }
  validators.set(schemaPath, validate);
  return validate;
}

function loadYaml<T>(configDir: string, key: keyof typeof FILES, hashes: Record<string, string>): T {
  const file = join(configDir, FILES[key]);
  if (!existsSync(file)) throw new ConfigError(`Missing ${FILES[key]} in ${configDir}`);
  const text = readFileSync(file, 'utf8');
  hashes[FILES[key]] = createHash('sha256').update(text).digest('hex');
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${FILES[key]} is not valid YAML: ${(err as Error).message}`);
  }
  const validate = schemaValidator(configDir, SCHEMAS[key]);
  if (!validate(data)) {
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new ConfigError(`${FILES[key]} does not match its schema: ${errors}`);
  }
  return data as T;
}

/** Cross-file rules that a JSON schema cannot express. */
export function crossValidate(config: Omit<Config, 'hashes' | 'dir'>): string[] {
  const problems: string[] = [];
  const tagNames = new Set(Object.keys(config.pathTags.tags));
  const checkIds = new Set<string>();

  for (const def of config.checks) {
    if (checkIds.has(def.id)) problems.push(`checks.yaml: duplicate check id ${def.id}`);
    checkIds.add(def.id);
    if (def.controls.length === 0 && def.rules.length === 0 && !def.source) {
      problems.push(`checks.yaml: ${def.id} cites no control or rule ID and no source`);
    }
    if (def.tags !== 'all') {
      for (const tag of def.tags)
        if (!tagNames.has(tag)) problems.push(`checks.yaml: ${def.id} uses unknown tag ${tag}`);
    }
    if (def.kind === 'native' && !NATIVE_CHECKS[def.id])
      problems.push(`checks.yaml: ${def.id} has no native implementation`);
    if (def.kind === 'tool' && !TOOL_ADAPTERS[def.tool ?? ''])
      problems.push(`checks.yaml: ${def.id} uses unknown tool ${def.tool}`);
  }
  for (const id of Object.keys(NATIVE_CHECKS)) {
    if (!checkIds.has(id)) problems.push(`native check ${id} is implemented but not declared in checks.yaml`);
  }
  for (const id of Object.keys(config.policy.checks)) {
    if (!checkIds.has(id)) problems.push(`policy.yaml: unknown check ${id}`);
  }
  for (const tag of config.policy.protected.tags) {
    if (!tagNames.has(tag)) problems.push(`policy.yaml: protected tag ${tag} is not defined in path-tags.yaml`);
  }
  const toolIds = new Set(config.registry.tools.map((t) => t.id));
  for (const agent of config.registry.agents) {
    if (!toolIds.has(agent.tool))
      problems.push(`ai-registry.yaml: agent ${agent.login} names unknown tool ${agent.tool}`);
  }
  const repoNames = new Set<string>();
  for (const r of config.repositories.repositories) {
    const key = r.name.toLowerCase();
    if (repoNames.has(key)) problems.push(`repositories.yaml: duplicate repository ${r.name}`);
    repoNames.add(key);
  }
  // Pull request conventions: every pattern compiles, and per-repository
  // overrides name repositories in the allowlist.
  const pr = config.policy.pr;
  const patterns: Array<[string, string | undefined]> = [
    ['pr.branch_pattern', pr?.branch_pattern],
    ['pr.title_pattern', pr?.title_pattern],
    ...Object.entries(pr?.repos ?? {}).map(([name, o]): [string, string | undefined] => [
      `pr.repos.${name}.title_pattern`,
      o.title_pattern,
    ]),
  ];
  for (const [where, pattern] of patterns) {
    if (pattern === undefined) continue;
    try {
      new RegExp(pattern);
    } catch (err) {
      problems.push(`policy.yaml: ${where} is not a valid regular expression (${(err as Error).message})`);
    }
  }
  for (const name of Object.keys(pr?.repos ?? {})) {
    if (!repoNames.has(name.toLowerCase()))
      problems.push(`policy.yaml: pr.repos.${name} is not a repository in repositories.yaml`);
  }
  const exemptionIds = new Set<string>();
  for (const [tool, pin] of Object.entries(config.policy.tools ?? {})) {
    if (!/^\d+\.\d+\.\d+$/.test(pin)) problems.push(`policy.yaml: tools.${tool} is not an exact version`);
  }
  for (const ex of config.exemptions) {
    if (exemptionIds.has(ex.id)) problems.push(`exemptions.yaml: duplicate id ${ex.id}`);
    exemptionIds.add(ex.id);
    if (!checkIds.has(ex.check)) problems.push(`exemptions.yaml: ${ex.id} names unknown check ${ex.check}`);
  }
  return problems;
}

/** Only the repository allowlist, for the execution gate that runs before anything else loads. */
export function loadAllowlist(explicitDir?: string): RepositoryAllowlist {
  return loadYaml<RepositoryAllowlist>(resolveConfigDir(explicitDir), 'repositories', {});
}

export function loadConfig(explicitDir?: string): Config {
  const dir = resolveConfigDir(explicitDir);
  const hashes: Record<string, string> = {};
  const registry = loadYaml<AiRegistry>(dir, 'registry', hashes);
  const repositories = loadYaml<RepositoryAllowlist>(dir, 'repositories', hashes);
  const pathTags = loadYaml<PathTags>(dir, 'pathTags', hashes);
  const checks = loadYaml<{ checks: CheckDefinition[] }>(dir, 'checks', hashes).checks;
  const policy = loadYaml<Policy>(dir, 'policy', hashes);
  const exemptions = loadYaml<{ exemptions: Exemption[] }>(dir, 'exemptions', hashes).exemptions;

  if (policy.min_engine_version && compareVersions(ENGINE_VERSION, policy.min_engine_version) < 0)
    throw new ConfigError(
      `this configuration (${dir}) needs qa ${policy.min_engine_version} or later; qa ${ENGINE_VERSION} is installed. ` +
        `Install a newer qa, or use the configuration bundled with this one (omit --config and QA_CONFIG_DIR).`,
    );
  const problems = crossValidate({ registry, repositories, pathTags, checks, policy, exemptions });
  if (problems.length > 0) throw new ConfigError(`Configuration is inconsistent:\n  - ${problems.join('\n  - ')}`);

  const gitleaksConfig = join(dir, 'config', 'gitleaks.toml');
  const semgrepConfig = join(dir, 'config', 'semgrep');
  return {
    dir,
    registry,
    repositories,
    pathTags,
    checks,
    policy,
    exemptions,
    hashes,
    gitleaksConfig: existsSync(gitleaksConfig) ? gitleaksConfig : undefined,
    semgrepConfig: existsSync(semgrepConfig) ? semgrepConfig : undefined,
  };
}
