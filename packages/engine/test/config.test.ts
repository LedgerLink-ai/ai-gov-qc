import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, crossValidate, loadConfig } from '../src/config';
import { resolveTags } from '../src/tags';
import { CONFIG_DIR, config } from './helpers';

describe('configuration', () => {
  it('loads the registries in this repository and they agree with each other', () => {
    const c = config();
    expect(crossValidate(c)).toEqual([]);
    expect(Object.keys(c.hashes).sort()).toEqual([
      'checks.yaml',
      'exemptions.yaml',
      'path-tags.yaml',
      'policy.yaml',
      'registry/ai-registry.yaml',
      'registry/repositories.yaml',
    ]);
  });

  it('every check cites a control or rule ID in the capability format, or names its source', () => {
    for (const def of config().checks) {
      expect(def.controls.length + def.rules.length + (def.source ? 1 : 0)).toBeGreaterThan(0);
      for (const id of def.controls) expect(id).toMatch(/^C\d{2}-\d+$/);
      for (const id of def.rules) expect(id).toMatch(/^R\d{2}-\d+$/);
    }
  });

  it('catches cross-file mistakes a schema cannot', () => {
    const c = config();
    const broken = {
      ...c,
      checks: [...c.checks, { ...c.checks[1], id: 'x.unknown', tags: ['no-such-tag'] }],
      policy: { ...c.policy, checks: { ...c.policy.checks, 'y.missing': { mode: 'block' as const } } },
    };
    const problems = crossValidate(broken).join('\n');
    expect(problems).toMatch(/x\.unknown uses unknown tag no-such-tag/);
    expect(problems).toMatch(/x\.unknown has no native implementation/);
    expect(problems).toMatch(/policy\.yaml: unknown check y\.missing/);
  });
});

describe('path tags', () => {
  const tags = (repo: string, files: string[]) =>
    Object.fromEntries([...resolveTags(config().pathTags, repo, files)].map(([f, t]) => [f, [...t].sort()]));

  it('resolves repository-specific and any-repository tags', () => {
    expect(
      tags('link_core', ['src/transaction/retry.ts', 'AGENTS.md', '.github/workflows/ci.yml', 'src/other.ts']),
    ).toEqual({
      'src/transaction/retry.ts': ['ledger'],
      'AGENTS.md': ['ai-config'],
      '.github/workflows/ci.yml': ['ci-config'],
      'src/other.ts': [],
    });
  });

  it('applies docs-only only to files with no other tag', () => {
    expect(tags('link_core', ['README.md', 'docs/guide.md', 'AGENTS.md'])).toEqual({
      'README.md': ['docs-only'],
      'docs/guide.md': ['docs-only'],
      'AGENTS.md': ['ai-config'],
    });
  });

  it('does not apply another repository’s paths', () => {
    expect(tags('link_router', ['src/transaction/retry.ts'])).toEqual({ 'src/transaction/retry.ts': [] });
  });
});

describe('configuration compatibility', () => {
  const copy = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-config-copy-'));
    for (const item of [
      'policy.yaml',
      'checks.yaml',
      'path-tags.yaml',
      'exemptions.yaml',
      'registry',
      'schemas',
      'config',
    ])
      cpSync(join(CONFIG_DIR, item), join(dir, item), { recursive: true });
    return dir;
  };

  it('refuses a configuration that needs a newer qa, with instructions', () => {
    const dir = copy();
    try {
      const policy = join(dir, 'policy.yaml');
      writeFileSync(
        policy,
        readFileSync(policy, 'utf8').replace(/^min_engine_version: .*$/m, "min_engine_version: '99.0.0'"),
      );
      expect(() => loadConfig(dir)).toThrow(/needs qa 99\.0\.0 or later; qa \d+\.\d+\.\d+ is installed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a configuration with keys this qa does not know, instead of ignoring them', () => {
    const dir = copy();
    try {
      writeFileSync(
        join(dir, 'policy.yaml'),
        `${readFileSync(join(dir, 'policy.yaml'), 'utf8')}\nfuture_setting: true\n`,
      );
      expect(() => loadConfig(dir)).toThrow(/policy\.yaml does not match its schema/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('0.2.2', '0.2.3')).toBe(-1);
  });

  it('names a --config directory without configuration instead of falling back silently', () => {
    expect(() => loadConfig(tmpdir())).toThrow(/has no policy\.yaml and checks\.yaml/);
  });
});
