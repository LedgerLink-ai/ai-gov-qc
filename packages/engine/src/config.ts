import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';
import { NATIVE_CHECKS } from './checks';
import { TOOL_ADAPTERS } from './adapters/tools';
import {
  ConfigError,
  type AiRegistry,
  type CheckDefinition,
  type Config,
  type Exemption,
  type PathTags,
  type Policy,
} from './types';

const FILES = {
  registry: 'registry/ai-registry.yaml',
  pathTags: 'path-tags.yaml',
  checks: 'checks.yaml',
  policy: 'policy.yaml',
  exemptions: 'exemptions.yaml',
} as const;

const SCHEMAS: Record<keyof typeof FILES, string> = {
  registry: 'ai-registry.schema.json',
  pathTags: 'path-tags.schema.json',
  checks: 'checks.schema.json',
  policy: 'policy.schema.json',
  exemptions: 'exemptions.schema.json',
};

/**
 * Where the registries live, in order: --config, QA_CONFIG_DIR, the snapshot
 * bundled in the published package, then the qc-workflows checkout this
 * package sits in.
 */
export function resolveConfigDir(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.QA_CONFIG_DIR,
    resolve(__dirname, '..', 'config'),
    resolve(__dirname, '..', '..', '..'),
  ].filter((c): c is string => Boolean(c));
  for (const dir of candidates) {
    if (existsSync(join(dir, FILES.policy)) && existsSync(join(dir, FILES.checks))) return resolve(dir);
  }
  throw new ConfigError(`No qa configuration found. Looked in: ${candidates.join(', ')}`);
}

let ajv: Ajv | undefined;
const validators = new Map<string, ValidateFunction>();

export function schemaValidator(configDir: string, schemaFile: string): ValidateFunction {
  const schemaPath = join(configDir, 'schemas', schemaFile);
  const cached = validators.get(schemaPath);
  if (cached) return cached;
  if (!existsSync(schemaPath)) throw new ConfigError(`Schema not found: ${schemaPath}`);
  ajv ??= new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
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
  const exemptionIds = new Set<string>();
  for (const ex of config.exemptions) {
    if (exemptionIds.has(ex.id)) problems.push(`exemptions.yaml: duplicate id ${ex.id}`);
    exemptionIds.add(ex.id);
    if (!checkIds.has(ex.check)) problems.push(`exemptions.yaml: ${ex.id} names unknown check ${ex.check}`);
  }
  return problems;
}

export function loadConfig(explicitDir?: string): Config {
  const dir = resolveConfigDir(explicitDir);
  const hashes: Record<string, string> = {};
  const registry = loadYaml<AiRegistry>(dir, 'registry', hashes);
  const pathTags = loadYaml<PathTags>(dir, 'pathTags', hashes);
  const checks = loadYaml<{ checks: CheckDefinition[] }>(dir, 'checks', hashes).checks;
  const policy = loadYaml<Policy>(dir, 'policy', hashes);
  const exemptions = loadYaml<{ exemptions: Exemption[] }>(dir, 'exemptions', hashes).exemptions;

  const problems = crossValidate({ registry, pathTags, checks, policy, exemptions });
  if (problems.length > 0) throw new ConfigError(`Configuration is inconsistent:\n  - ${problems.join('\n  - ')}`);

  const gitleaksConfig = join(dir, 'config', 'gitleaks.toml');
  const semgrepConfig = join(dir, 'config', 'semgrep');
  return {
    dir,
    registry,
    pathTags,
    checks,
    policy,
    exemptions,
    hashes,
    gitleaksConfig: existsSync(gitleaksConfig) ? gitleaksConfig : undefined,
    semgrepConfig: existsSync(semgrepConfig) ? semgrepConfig : undefined,
  };
}
