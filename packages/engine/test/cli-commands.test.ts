import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { allowlistedRepo, cliEnv, describeBuilt, qa } from './cli-helpers';
import { CONFIG_DIR } from './helpers';

// The CLI commands no other suite calls directly: their output, exit codes
// (0 pass, 1 blocked, 2 refused or broken) and the execution gate in front
// of each. The hooks call commit-msg, prepare-commit-msg and prepush; a wrong
// exit code there blocks, or silently lets through, every commit or push.

const ENGINE_VERSION = (
  JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
).version;

/** A copy of the configuration with the given checks in block mode. */
function configWith(block: string[], edit?: (policy: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa-cli-config-'));
  for (const entry of ['registry', 'schemas', 'config', 'checks.yaml', 'path-tags.yaml', 'exemptions.yaml'])
    cpSync(join(CONFIG_DIR, entry), join(dir, entry), { recursive: true });
  const policy = parse(readFileSync(join(CONFIG_DIR, 'policy.yaml'), 'utf8'));
  for (const id of block) policy.checks[id] = { mode: 'block' };
  edit?.(policy);
  writeFileSync(join(dir, 'policy.yaml'), stringify(policy));
  return dir;
}

describeBuilt('qa CLI commands', () => {
  let work: string;
  let env: NodeJS.ProcessEnv;
  const out = (r: { stdout: string; stderr: string }): string => `${r.stdout}${r.stderr}`;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'qa-cli-cmd-'));
    env = cliEnv({ QA_HOME: join(work, 'home'), QA_CONFIG_DIR: CONFIG_DIR });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  describe('version and help', () => {
    it.each(['version', '--version'])('%s prints the package version', (arg) => {
      const r = qa([arg], { cwd: work, env });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(ENGINE_VERSION);
    });

    it.each([['help'], ['--help'], ['check', '--help']])('%s prints the usage', (...args) => {
      const r = qa(args, { cwd: work, env });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/qa setup/);
      expect(r.stdout).toMatch(/--no-global-hooks/);
    });

    it('refuses an unknown command with exit 2 and points to help', () => {
      const r = qa(['frobnicate'], { cwd: work, env });
      expect(r.status).toBe(2);
      expect(out(r)).toContain('unknown command "frobnicate"');
      expect(out(r)).toContain('Run "qa help" for usage.');
    });
  });

  describe('cache', () => {
    it('path prints the cache folder under the qa home', () => {
      const r = qa(['cache', 'path'], { cwd: work, env });
      expect(r.status).toBe(0);
      expect(resolve(r.stdout.trim()).startsWith(resolve(work, 'home', 'cache'))).toBe(true);
    });

    it('clear empties the cache folder', () => {
      const dir = qa(['cache', 'path'], { cwd: work, env }).stdout.trim();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'entry.json'), '{}');
      const r = qa(['cache', 'clear'], { cwd: work, env });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Cleared');
      expect(existsSync(join(dir, 'entry.json'))).toBe(false);
    });

    it('refuses anything else with exit 2', () => {
      expect(qa(['cache'], { cwd: work, env }).status).toBe(2);
      expect(out(qa(['cache', 'drop'], { cwd: work, env }))).toContain('qa cache needs "clear" or "path"');
    });
  });

  describe('validate', () => {
    it('accepts the shipped configuration and counts what it holds', () => {
      const r = qa(['validate', '--config', CONFIG_DIR], { cwd: work, env });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Configuration valid');
      expect(r.stdout).toMatch(/policy\.yaml {2}sha256:[0-9a-f]{16}/);
      expect(r.stdout).toMatch(/\d+ checks, \d+ tags, \d+ AI tools, \d+ MCP servers, \d+ exemptions/);
    });

    it('refuses a policy that breaks the schema with exit 2', () => {
      const dir = configWith([], (p) => {
        (p as { checks: Record<string, unknown> }).checks['secrets.gitleaks'] = { mode: 'sometimes' };
      });
      try {
        const r = qa(['validate', '--config', dir], { cwd: work, env });
        expect(r.status).toBe(2);
        expect(out(r)).toMatch(/configuration error: .*policy/i);
        expect(r.stdout).not.toContain('Configuration valid');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('rules', () => {
    it('needs at least one path', () => {
      const r = qa(['rules'], { cwd: work, env });
      expect(r.status).toBe(2);
      expect(out(r)).toContain('qa rules needs at least one path');
    });

    it('lists the tags, approvals, owners and checks for an agent instruction file', () => {
      const r = qa(['rules', 'AGENTS.md', '--repo', 'link_core'], { cwd: work, env });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^AGENTS\.md {2}\[repo link_core\]/m);
      expect(r.stdout).toMatch(/tags: .*ai-config/);
      expect(r.stdout).toMatch(/- ai-config\.content-lint: /);
      expect(r.stdout).toMatch(/- secrets\.gitleaks: /);
    });

    it('as JSON: a file with no tags gets only the checks for every file, and one approval', () => {
      const r = qa(['rules', 'notes/todo.txt', 'AGENTS.md', '--repo', 'link_core', '--format', 'json'], {
        cwd: work,
        env,
      });
      expect(r.status).toBe(0);
      const json = JSON.parse(r.stdout) as {
        repo: string;
        paths: Array<{ path: string; tags: string[]; min_approvals: number; checks: Array<{ id: string }> }>;
      };
      expect(json.repo).toBe('link_core');
      const [plain, agents] = json.paths;
      expect(plain.tags).toEqual([]);
      expect(plain.min_approvals).toBe(1);
      expect(plain.checks.map((c) => c.id)).toContain('secrets.gitleaks');
      expect(plain.checks.map((c) => c.id)).not.toContain('ai-config.content-lint');
      expect(agents.checks.map((c) => c.id)).toContain('ai-config.content-lint');
    });
  });

  describe('commit-msg', () => {
    let repo: ReturnType<typeof allowlistedRepo>;
    let blocking: string;
    const msg = (text: string): string => {
      const f = join(work, 'COMMIT_EDITMSG');
      writeFileSync(f, text);
      return f;
    };
    beforeAll(() => {
      blocking = configWith(['commit.message']);
      repo = allowlistedRepo();
      repo.git('switch', '-q', '-c', 'feature/LCORE-212-retry');
    });
    afterAll(() => {
      rmSync(repo.dir, { recursive: true, force: true });
      rmSync(blocking, { recursive: true, force: true });
    });

    it('needs the message file, and refuses one that does not exist', () => {
      expect(out(qa(['commit-msg'], { cwd: repo.dir, env }))).toContain('needs the commit message file');
      const r = qa(['commit-msg', join(work, 'missing')], { cwd: repo.dir, env });
      expect(r.status).toBe(2);
      expect(out(r)).toContain('does not exist');
    });

    it('blocks (exit 1) a subject without the branch ticket key when the check blocks', () => {
      const r = qa(['commit-msg', msg('add bounded retry\n')], {
        cwd: repo.dir,
        env: { ...env, QA_CONFIG_DIR: blocking },
      });
      expect(r.status).toBe(1);
      expect(out(r)).toMatch(/BLOCK +commit\.message/);
    });

    it('passes (exit 0) a subject carrying the ticket key', () => {
      const r = qa(['commit-msg', msg('feat(LCORE-212): add bounded retry\n')], {
        cwd: repo.dir,
        env: { ...env, QA_CONFIG_DIR: blocking },
      });
      expect(r.status).toBe(0);
    });

    it('ignores comment lines git will drop', () => {
      const r = qa(
        ['commit-msg', msg('# Please enter the commit message\nfeat(LCORE-212): add bounded retry\n# On branch x\n')],
        {
          cwd: repo.dir,
          env: { ...env, QA_CONFIG_DIR: blocking },
        },
      );
      expect(r.status).toBe(0);
    });

    it('only reports (exit 0) with the shipped configuration, where the check is in report mode', () => {
      const r = qa(['commit-msg', msg('add bounded retry\n')], { cwd: repo.dir, env });
      expect(r.status).toBe(0);
    });

    it('does nothing in a repository that is not allowlisted', () => {
      const other = allowlistedRepo('someone-elses-repo');
      try {
        other.git('remote', 'set-url', 'origin', 'https://github.com/elsewhere/project.git');
        const r = qa(['commit-msg', msg('anything\n')], { cwd: other.dir, env: { ...env, QA_CONFIG_DIR: blocking } });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(other.dir, { recursive: true, force: true });
      }
    });

    it('stops (exit 2) when the repository pins an incompatible qa; prepare-commit-msg never does', () => {
      const file = msg('feat(LCORE-212): x\n');
      const pinned = qa(['--require', '99.0.0', 'commit-msg', file], { cwd: repo.dir, env });
      expect(pinned.status).toBe(2);
      expect(out(pinned)).toContain('this repository needs qa 99.0.0');
      expect(qa(['--require', '99.0.0', 'prepare-commit-msg', file], { cwd: repo.dir, env }).status).toBe(0);
    });
  });

  describe('a configuration qa cannot read', () => {
    let repo: ReturnType<typeof allowlistedRepo>;
    let file: string;
    beforeAll(() => {
      repo = allowlistedRepo();
    });
    afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));
    beforeEach(() => {
      file = join(work, 'MSG');
      writeFileSync(file, 'add notes\n');
    });
    const missing = (): string => {
      const dir = join(work, 'no-config');
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    const invalid = (): string =>
      configWith([], (p) => {
        (p as { checks: Record<string, unknown> }).checks['secrets.gitleaks'] = { mode: 'sometimes' };
      });

    // git refuses the commit when a message hook exits non-zero; qa's own problems never do that.
    it.each([
      ['prepare-commit-msg', 'missing'],
      ['commit-msg', 'missing'],
      ['prepare-commit-msg', 'schema-invalid'],
      ['commit-msg', 'schema-invalid'],
    ])('%s lets the commit through, with a warning, when the configuration is %s', (cmd, kind) => {
      const dir = kind === 'missing' ? missing() : invalid();
      try {
        const r = qa([cmd, file], { cwd: repo.dir, env: { ...env, QA_CONFIG_DIR: dir } });
        expect(r.status).toBe(0);
        if (cmd === 'commit-msg') expect(out(r)).toMatch(/configuration error: .*the commit-msg checks were skipped/);
      } finally {
        if (kind !== 'missing') rmSync(dir, { recursive: true, force: true });
      }
    });

    it('everything else still stops on it (exit 2): precommit, prepush, check, validate', () => {
      const dir = missing();
      for (const args of [['precommit'], ['prepush'], ['check', '--all'], ['validate']]) {
        const r = qa(args, { cwd: repo.dir, env: { ...env, QA_CONFIG_DIR: dir } });
        expect([args[0], r.status]).toEqual([args[0], 2]);
        expect(out(r)).toContain('configuration error');
      }
    });
  });

  describe('prepush', () => {
    let repo: ReturnType<typeof allowlistedRepo>;
    beforeAll(() => {
      repo = allowlistedRepo();
    });
    afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

    it.each([
      ['PRE_COMMIT_FROM_REF', 'main..evil'],
      ['PRE_COMMIT_FROM_REF', '--upload-pack=touch /tmp/x'],
      ['PRE_COMMIT_TO_REF', '@{-1}'],
    ])('refuses (exit 2) a %s that is not a plain revision: %s', (name, value) => {
      const r = qa(['prepush'], { cwd: repo.dir, env: { ...env, [name]: value } });
      expect(r.status).toBe(2);
      expect(out(r)).toContain('is not a plain git revision');
    });

    it('refuses a --base that is not a plain revision', () => {
      const r = qa(['prepush', '--base', 'a..b'], { cwd: repo.dir, env });
      expect(r.status).toBe(2);
    });

    it('passes (exit 0) a push with nothing for its stage to check', () => {
      const head = repo.git('rev-parse', 'HEAD').trim();
      const r = qa(['prepush'], {
        cwd: repo.dir,
        env: { ...env, PRE_COMMIT_FROM_REF: head, PRE_COMMIT_TO_REF: head },
      });
      expect(r.status).toBe(0);
    });

    it('does nothing in a repository that is not allowlisted', () => {
      const other = allowlistedRepo();
      try {
        other.git('remote', 'set-url', 'origin', 'https://github.com/elsewhere/project.git');
        const r = qa(['prepush', '--base', 'a..b'], { cwd: other.dir, env });
        // The gate decides first: a refused ref in someone else's repository is not qa's business.
        expect(r.status).toBe(0);
      } finally {
        rmSync(other.dir, { recursive: true, force: true });
      }
    });
  });
});
