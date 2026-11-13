import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CONFIG_DIR } from './helpers';
import { allowlistedRepo, cliEnv, describeBuilt, HIDDEN, qa } from './cli-helpers';

// The CLI as developers, hooks and CI run it: exit codes, the execution gate,
// configuration trust, structured logs and the baseline in CI.

describeBuilt('qa CLI end to end', () => {
  let repo: ReturnType<typeof allowlistedRepo>;
  beforeEach(() => {
    repo = allowlistedRepo();
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  const env = (extra: Record<string, string | undefined> = {}) =>
    cliEnv({ QA_CONFIG_DIR: CONFIG_DIR, QA_AS_OF: '2027-01-08', ...extra });

  it('exits 0 for a clean change, 1 for a blocking finding (meaningful exit codes)', () => {
    writeFileSync(join(repo.dir, 'notes.md'), 'hello\n');
    repo.git('add', '.');
    expect(qa(['precommit', '--exclude', 'secrets.gitleaks'], { cwd: repo.dir, env: env() }).status).toBe(0);

    writeFileSync(join(repo.dir, 'AGENTS.md'), HIDDEN);
    repo.git('add', '.');
    const res = qa(['precommit', '--exclude', 'secrets.gitleaks'], { cwd: repo.dir, env: env() });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/BLOCK +ai-config\.content-lint +AGENTS\.md/);
    expect(res.stdout).toMatch(/result: BLOCKED/);
  });

  it('exits 2 when a check cannot run in CI (fail closed)', () => {
    writeFileSync(join(repo.dir, 'a.ts'), 'x\n');
    repo.git('add', '.');
    const res = qa(['precommit'], {
      cwd: repo.dir,
      env: env({ CI: 'true', QA_GITLEAKS_BIN: 'qa-test-no-such-binary' }),
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toMatch(/ENGINE ERROR/);
  });

  it('does nothing in a repository that is not allowlisted (negative authorization)', () => {
    repo.git('remote', 'set-url', 'origin', 'https://github.com/someone-else/link_core.git');
    writeFileSync(join(repo.dir, 'AGENTS.md'), HIDDEN);
    repo.git('add', '.');
    const res = qa(['precommit'], { cwd: repo.dir, env: env() });
    expect(res).toMatchObject({ status: 0, stdout: '' });
  });

  it('refuses configuration from inside the repository being checked', () => {
    const inside = join(repo.dir, 'qa-config');
    mkdirSync(inside);
    for (const f of ['policy.yaml', 'checks.yaml']) writeFileSync(join(inside, f), 'version: 1\n');
    writeFileSync(join(repo.dir, 'AGENTS.md'), HIDDEN);
    repo.git('add', '.');
    for (const run of [
      () => qa(['precommit', '--config', inside], { cwd: repo.dir, env: env({ QA_CONFIG_DIR: undefined }) }),
      () => qa(['precommit'], { cwd: repo.dir, env: env({ QA_CONFIG_DIR: inside }) }),
    ]) {
      const res = run();
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/points inside the repository being checked/);
    }
  });

  it('refuses unsafe input before running anything', () => {
    const res = qa(['check', '--base', '--output=/tmp/pwned'], { cwd: repo.dir, env: env() });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/not a plain git revision/);
    const tool = qa(['repo-tool', '../../evil'], { cwd: repo.dir, env: env() });
    expect(tool.status).toBe(2);
    expect(tool.stderr).toMatch(/not an npm package name/);
    const script = qa(['repo-script', '--cwd', '..', 'test'], { cwd: repo.dir, env: env() });
    expect(script.status).toBe(2);
    expect(script.stderr).toMatch(/outside the repository/);
  });

  it('writes structured JSON logs with the engine version, run id and gate decision', () => {
    writeFileSync(join(repo.dir, 'notes.md'), 'hello\n');
    repo.git('add', '.');
    const res = qa(['precommit', '--exclude', 'secrets.gitleaks', '--log-format', 'json'], {
      cwd: repo.dir,
      env: env(),
    });
    expect(res.status).toBe(0);
    const events = res.stderr
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const names = events.map((e) => e.event);
    expect(names).toEqual(
      expect.arrayContaining(['gate.allowed', 'run.start', 'check.finish', 'run.finish', 'run.summary']),
    );
    for (const e of events) expect(e).toMatchObject({ engine_version: expect.any(String), run_id: events[0].run_id });
  });

  it('in CI, reads the baseline from the base branch: a pull request cannot baseline its own findings', () => {
    repo.git('checkout', '-q', '-b', 'LCORE-1-feature');
    writeFileSync(join(repo.dir, 'AGENTS.md'), HIDDEN);
    repo.git('add', '.');
    repo.git('commit', '-q', '--no-verify', '-m', 'add agents file');
    // The pull request also adds a baseline that would hide its own finding.
    expect(qa(['baseline', '--all', '--exclude', 'secrets.gitleaks'], { cwd: repo.dir, env: env() }).status).toBe(0);
    repo.git('add', '.qa/baseline.sarif');
    repo.git('commit', '-q', '--no-verify', '-m', 'baseline');

    const args = ['check', '--base', 'main', '--exclude', 'secrets.gitleaks,sast.semgrep', '--format', 'json'];
    const local = qa([...args, '--mode', 'local'], { cwd: repo.dir, env: env() });
    expect(local.status).toBe(0); // locally the developer's own baseline applies
    const ci = qa([...args, '--mode', 'ci'], { cwd: repo.dir, env: env({ CI: 'true' }) });
    expect(ci.status).toBe(1);
    const json = JSON.parse(ci.stdout) as { findings: Array<{ check: string; blocking: boolean }> };
    expect(json.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: 'ai-config.content-lint', blocking: true })]),
    );
  });

  it('in CI, runs the agent rules for a pull request opened by a registered agent', () => {
    repo.git('checkout', '-q', '-b', 'agent-change');
    mkdirSync(join(repo.dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repo.dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '--no-verify', '-m', 'edit workflow');
    const args = [
      'check',
      '--base',
      'main',
      '--exclude',
      'secrets.gitleaks,sast.semgrep',
      '--format',
      'json',
      '--mode',
      'ci',
    ];
    const human = JSON.parse(qa(args, { cwd: repo.dir, env: env({ CI: 'true', QA_PR_AUTHOR: 'a-person' }) }).stdout);
    expect(human.findings.some((f: { sub_rule: string }) => f.sub_rule === 'agent-edit')).toBe(false);
    const registry = parseYaml(readFileSync(join(CONFIG_DIR, 'registry', 'ai-registry.yaml'), 'utf8')) as {
      agents: Array<{ login: string }>;
    };
    const agentLogin = registry.agents[0]?.login;
    if (!agentLogin) return; // no agent registered yet
    const agent = JSON.parse(qa(args, { cwd: repo.dir, env: env({ CI: 'true', QA_PR_AUTHOR: agentLogin }) }).stdout);
    expect(agent.findings.some((f: { sub_rule: string }) => f.sub_rule === 'agent-edit')).toBe(true);
  });
});
