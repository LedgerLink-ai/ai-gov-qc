import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultHookConfig,
  hookScript,
  hookScriptsInstalled,
  MANAGED_MARKER,
  PASS_THROUGH_HOOKS,
  QA_HOOKS,
  removeHookScripts,
  sameDir,
  stageDefaultConfig,
  writeHookScripts,
} from '../src/hooks';
import { toolBinary } from '../src/tools-home';
import { cliEnv, describeBuilt, HIDDEN, qa, QA_BIN } from './cli-helpers';
import { CONFIG_DIR } from './helpers';

// AIQC-85: the hooks "qa setup" connects for every repository on the machine,
// with nothing copied into any repository. The end-to-end cases point a
// repository's core.hooksPath at the scripts, which is what the global
// setting does for every repository that has no core.hooksPath of its own.

const posix = (p: string): string => p.replace(/\\/g, '/');
const QA = { node: process.execPath, script: QA_BIN };

describe('hook scripts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-hooks-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('hands the QA hooks to "qa hook" and passes every other hook to the repository', () => {
    const pre = hookScript('pre-commit', QA);
    expect(pre.split('\n').slice(0, 2)).toEqual(['#!/bin/sh', MANAGED_MARKER]);
    expect(pre).toContain('hook "$hook" "$@"');
    expect(pre).toContain(`QA_JS='${posix(QA_BIN)}'`);
    const post = hookScript('post-checkout', QA);
    expect(post).not.toContain('qa hook');
    expect(post).toContain('exec "$own" "$@"');
  });

  it('writes a script for every hook, and never touches files that are not its own', () => {
    writeFileSync(join(dir, 'post-merge'), '#!/bin/sh\necho mine\n');
    writeHookScripts(dir, QA);
    expect(hookScriptsInstalled(dir)).toBe(true);
    for (const hook of [...QA_HOOKS, ...PASS_THROUGH_HOOKS].filter((h) => h !== 'post-merge'))
      expect(readFileSync(join(dir, hook), 'utf8')).toContain(MANAGED_MARKER);
    expect(readFileSync(join(dir, 'post-merge'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(existsSync(join(dir, 'reference-transaction'))).toBe(false);

    removeHookScripts(dir);
    expect(hookScriptsInstalled(dir)).toBe(false);
    expect(existsSync(join(dir, 'post-merge'))).toBe(true);
    rmSync(join(dir, 'post-merge'));
    removeHookScripts(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('compares directories whatever the slashes, trailing separators or a leading ~', () => {
    expect(sameDir('/home/dev/.ledgerlink-qa/hooks/', '/home/dev/.ledgerlink-qa/hooks')).toBe(true);
    expect(sameDir('~/.ledgerlink-qa/hooks', '/home/dev/.ledgerlink-qa/hooks', '/home/dev')).toBe(true);
    expect(sameDir('/home/dev/.husky/_', '/home/dev/.ledgerlink-qa/hooks')).toBe(false);
  });

  it('copies the default configuration into the git directory, so pre-commit finds it on the same drive', () => {
    const gitDir = join(dir, '.git');
    const staged = stageDefaultConfig(gitDir);
    expect(posix(staged)).toBe(posix(join(gitDir, 'ledgerlink-qa', 'pre-commit-config.yaml')));
    expect(readFileSync(staged, 'utf8')).toBe(readFileSync(defaultHookConfig(), 'utf8'));
    // A stale copy from an older qa is replaced.
    writeFileSync(staged, 'repos: []\n');
    stageDefaultConfig(gitDir);
    expect(readFileSync(staged, 'utf8')).toBe(readFileSync(defaultHookConfig(), 'utf8'));
  });

  it('ships the default configuration with the package', () => {
    const file = defaultHookConfig();
    expect(posix(file)).toMatch(/templates\/pre-commit-config\.yaml$/);
    expect(readFileSync(file, 'utf8')).toContain('qa --require');
  });
});

// pre-commit runs the checks; CI installs it with "qa setup" before the tests.
const PRE_COMMIT = toolBinary('pre-commit');
const HAS_PRE_COMMIT = spawnSync(PRE_COMMIT, ['--version'], { encoding: 'utf8' }).status === 0;
const describeHooks = HAS_PRE_COMMIT ? describeBuilt : describe.skip;

describeHooks('commits and pushes through the hooks for every repository', () => {
  let work: string;
  let hooksDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'qa-global-'));
    hooksDir = join(work, 'hooks');
    writeHookScripts(hooksDir, QA);
    // The hooks in a repository's configuration call "qa" from PATH, as on a developer's machine.
    const bin = join(work, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'qa'), `#!/usr/bin/env node\nrequire(${JSON.stringify(QA_BIN)});\n`);
    chmodSync(join(bin, 'qa'), 0o755);
    const path = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env = cliEnv({
      QA_CONFIG_DIR: CONFIG_DIR,
      QA_AS_OF: '2027-01-08',
      QA_PRE_COMMIT_BIN: PRE_COMMIT,
      [path]: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env[path] ?? ''}`,
    });
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  // The qa hooks alone, without the remote pre-commit-hooks and the
  // repository's Prettier and ESLint: what most cases need, and much faster
  // than the default configuration, which one case runs in full.
  const LIGHT_CONFIG = [
    'repos:',
    '  - repo: local',
    '    hooks:',
    ...[
      ['qa-precommit', 'qa precommit --quiet', 'pre-commit'],
      ['qa-prepare-commit-msg', 'qa prepare-commit-msg', 'prepare-commit-msg'],
      ['qa-prepush', 'qa prepush --quiet', 'pre-push'],
    ].flatMap(([id, entry, stage]) => [
      `      - id: ${id}`,
      `        name: ${id}`,
      `        entry: ${entry}`,
      '        language: system',
      ...(stage === 'prepare-commit-msg' ? [] : ['        pass_filenames: false', '        always_run: true']),
      `        stages: [${stage}]`,
    ]),
    '',
  ].join('\n');

  /** A clone of `origin` whose hooks are the machine-wide ones, with one commit (and LIGHT_CONFIG unless light is false). */
  function clone(
    origin: string,
    branch = 'main',
    light = true,
  ): { dir: string; git: (...a: string[]) => ReturnType<typeof spawnSync> } {
    const dir = mkdtempSync(join(work, 'repo-'));
    const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', timeout: 180_000 });
    execFileSync('git', ['init', '-q', '--template=', '-b', branch], { cwd: dir, env });
    for (const [k, v] of [
      ['user.email', 'test@example.invalid'],
      ['user.name', 'qa test'],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.hooksPath', posix(hooksDir)],
    ])
      execFileSync('git', ['config', k, v], { cwd: dir, env });
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir, env });
    writeFileSync(join(dir, 'README.md'), '# test\n');
    if (light) writeFileSync(join(dir, '.pre-commit-config.yaml'), LIGHT_CONFIG);
    execFileSync('git', ['add', '.'], { cwd: dir, env });
    execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'init'], { cwd: dir, env });
    return { dir, git };
  }
  const LEDGERLINK = 'https://github.com/LedgerLink-ai/link_core.git';
  const PERSONAL = 'https://github.com/someone/side-project.git';
  const out = (r: ReturnType<typeof spawnSync>): string => `${r.stdout ?? ''}${r.stderr ?? ''}`;

  /** A repository's own hook that records it ran (and what it read on stdin). */
  function ownHook(dir: string, hook: string, exit = 0, extra = ''): string {
    const marker = join(dir, '.git', `${hook}.ran`);
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const file = join(dir, '.git', 'hooks', hook);
    writeFileSync(
      file,
      `#!/bin/sh\n${extra}\ncat > "${posix(marker)}" 2>/dev/null || touch "${posix(marker)}"\nexit ${exit}\n`,
    );
    chmodSync(file, 0o755);
    return marker;
  }

  it('runs the default checks in an opted-in repository with no hook configuration of its own', () => {
    const repo = clone(LEDGERLINK, 'main', false);
    writeFileSync(join(repo.dir, 'notes.md'), 'hello\n');
    repo.git('add', '.');
    const ok = repo.git('commit', '-m', 'Add notes');
    expect(ok.status).toBe(0);
    expect(out(ok)).toContain('qa: secrets, agent instruction files');

    writeFileSync(join(repo.dir, 'AGENTS.md'), HIDDEN);
    repo.git('add', '.');
    const blocked = repo.git('commit', '-m', 'Add agent instructions');
    expect(blocked.status).not.toBe(0);
    expect(out(blocked)).toContain('ai-config.content-lint');
    expect(existsSync(join(repo.dir, '.pre-commit-config.yaml'))).toBe(false);
  }, 300_000);

  it("uses the repository's own .pre-commit-config.yaml when it has one", () => {
    const repo = clone(LEDGERLINK, 'main', false);
    writeFileSync(
      join(repo.dir, '.pre-commit-config.yaml'),
      [
        'repos:',
        '  - repo: local',
        '    hooks:',
        '      - id: own-config',
        '        name: the repository configuration ran',
        '        entry: qa precommit --quiet',
        '        language: system',
        '        pass_filenames: false',
        '        always_run: true',
        '',
      ].join('\n'),
    );
    repo.git('add', '.');
    const res = repo.git('commit', '-m', 'Add hook configuration');
    expect(res.status).toBe(0);
    expect(out(res)).toContain('the repository configuration ran');
    expect(out(res)).not.toContain('qa: secrets, agent instruction files');
  }, 300_000);

  it('does nothing in a personal repository except its own hooks', () => {
    const repo = clone(PERSONAL);
    const marker = ownHook(repo.dir, 'pre-commit');
    writeFileSync(join(repo.dir, 'AGENTS.md'), HIDDEN);
    repo.git('add', '.');
    const res = repo.git('commit', '-m', 'Add agent instructions');
    expect(res.status).toBe(0);
    expect(out(res)).not.toContain('content-lint');
    expect(existsSync(marker)).toBe(true);
  }, 120_000);

  it("runs the repository's own hook first, and its failure stops the commit", () => {
    const repo = clone(LEDGERLINK);
    const marker = ownHook(repo.dir, 'pre-commit');
    writeFileSync(join(repo.dir, 'a.md'), 'a\n');
    repo.git('add', '.');
    expect(repo.git('commit', '-m', 'Add a').status).toBe(0);
    expect(existsSync(marker)).toBe(true);

    ownHook(repo.dir, 'pre-commit', 1, 'echo "own hook says no" >&2');
    writeFileSync(join(repo.dir, 'b.md'), 'b\n');
    repo.git('add', '.');
    const res = repo.git('commit', '-m', 'Add b');
    expect(res.status).not.toBe(0);
    expect(out(res)).toContain('own hook says no');
  }, 300_000);

  it("skips pre-commit's own scripts in opted-in repositories, so the checks do not run twice", () => {
    const repo = clone(LEDGERLINK);
    const marker = ownHook(repo.dir, 'pre-commit', 0, '# File generated by pre-commit: https://pre-commit.com');
    writeFileSync(join(repo.dir, 'c.md'), 'c\n');
    repo.git('add', '.');
    expect(repo.git('commit', '-m', 'Add c').status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  }, 300_000);

  it('passes every other hook to the repository (Git LFS and the like keep working)', () => {
    const repo = clone(PERSONAL);
    const marker = ownHook(repo.dir, 'post-commit');
    writeFileSync(join(repo.dir, 'd.md'), 'd\n');
    repo.git('add', '.');
    expect(repo.git('commit', '-m', 'Add d').status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  }, 120_000);

  it("gives the repository's own pre-push hook the refs being pushed", () => {
    const repo = clone(LEDGERLINK);
    const marker = ownHook(repo.dir, 'pre-push');
    const remote = mkdtempSync(join(work, 'remote-'));
    execFileSync('git', ['init', '-q', '--bare', '--template=', remote], { env });
    repo.git('remote', 'add', 'backup', remote);
    const res = repo.git('push', '-q', 'backup', 'main');
    expect(res.status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toMatch(/^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main /);
  }, 300_000);

  it('pre-fills the ticket key from the branch name', () => {
    const repo = clone(LEDGERLINK, 'LCORE-212-refund-key');
    writeFileSync(join(repo.dir, 'e.md'), 'e\n');
    repo.git('add', '.');
    expect(repo.git('commit', '-m', 'Add refund key').status).toBe(0);
    expect(String(repo.git('log', '-1', '--format=%s').stdout).trim()).toBe('LCORE-212: Add refund key');
  }, 300_000);

  it('lets commits through, with a warning, when qa is no longer installed', () => {
    const gone = join(work, 'gone-hooks');
    writeHookScripts(gone, { node: join(work, 'no-such-node'), script: join(work, 'no-such-qa.js') });
    const repo = clone(LEDGERLINK);
    repo.git('config', 'core.hooksPath', posix(gone));
    const marker = ownHook(repo.dir, 'pre-commit');
    writeFileSync(join(repo.dir, 'AGENTS.md'), HIDDEN);
    repo.git('add', '.');
    // PATH without any qa on it.
    const noQa = { ...env };
    const path = Object.keys(noQa).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const sep = process.platform === 'win32' ? ';' : ':';
    noQa[path] = (noQa[path] ?? '')
      .split(sep)
      .filter((d) => d && !['qa', 'qa.cmd', 'qa.exe'].some((n) => existsSync(join(d, n))))
      .join(sep);
    const res = spawnSync('git', ['commit', '-m', 'Add agent instructions'], {
      cwd: repo.dir,
      env: noQa,
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(out(res)).toContain('the LedgerLink QA engine was not found');
    expect(existsSync(marker)).toBe(true);
  }, 120_000);
});

describeBuilt('qa setup and qa doctor with the hooks for every repository', () => {
  let work: string;
  let env: NodeJS.ProcessEnv;
  const globalFile = (): string => join(work, 'gitconfig');
  const globalGet = (key: string): string =>
    spawnSync('git', ['config', '--global', '--get', key], { env, encoding: 'utf8' }).stdout.trim();

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'qa-setup-hooks-'));
    writeFileSync(globalFile(), '');
    env = cliEnv({ QA_HOME: join(work, 'home'), GIT_CONFIG_GLOBAL: globalFile(), QA_CONFIG_DIR: CONFIG_DIR });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('connects every repository through core.hooksPath, and --uninstall removes it', () => {
    const setup = qa(['setup', '--no-python', '--no-gitleaks'], { cwd: work, env });
    expect(setup.stdout).toMatch(/ok\s+global hooks/);
    const hooks = join(work, 'home', 'hooks');
    expect(sameDir(globalGet('core.hooksPath'), hooks)).toBe(true);
    expect(hookScriptsInstalled(hooks)).toBe(true);

    const removed = qa(['setup', '--uninstall'], { cwd: work, env });
    expect(removed.status).toBe(0);
    expect(globalGet('core.hooksPath')).toBe('');
    expect(existsSync(hooks)).toBe(false);
  });

  it("leaves a core.hooksPath that is not qa's alone", () => {
    execFileSync('git', ['config', '--global', 'core.hooksPath', '/somewhere/else'], { env });
    const setup = qa(['setup', '--no-python', '--no-gitleaks'], { cwd: work, env });
    expect(setup.status).toBe(1);
    expect(setup.stdout).toMatch(/FAIL\s+global hooks\s+git's global core.hooksPath is already "\/somewhere\/else"/);
    expect(globalGet('core.hooksPath')).toBe('/somewhere/else');
    expect(qa(['setup', '--uninstall'], { cwd: work, env }).stdout).toContain("not qa's; left as it is");
    expect(globalGet('core.hooksPath')).toBe('/somewhere/else');
  });

  it('qa doctor: a repository without its own configuration is ready', () => {
    qa(['setup', '--no-python', '--no-gitleaks'], { cwd: work, env });
    const repo = join(work, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '--template=', '-b', 'main'], { cwd: repo, env });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/LedgerLink-ai/link_core.git'], {
      cwd: repo,
      env,
    });
    const doctor = qa(['doctor'], { cwd: repo, env });
    expect(doctor.stdout).toMatch(/ok\s+global hooks/);
    expect(doctor.stdout).toMatch(/ok\s+\.pre-commit-config\.yaml\s+not needed; the default configuration/);
    expect(doctor.stdout).toMatch(/ok\s+hooks\s+connected by the global hooks/);
  });
});
