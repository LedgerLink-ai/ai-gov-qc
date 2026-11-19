import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageLines, toolForAlias, useCommentString } from '../src/checks/commit-trailer';
import { hookScript, PASSTHROUGH_ENV, preCommitEnv, writeHookScripts } from '../src/hooks';
import { commentFor, prepareMessage } from '../src/prepare-message';
import { ENGINE_VERSION } from '../src/version';
import { cliEnv, describeBuilt, QA_BIN } from './cli-helpers';
import { config, CONFIG_DIR } from './helpers';

// Review findings on the hooks: replayed commits, core.commentChar, AI
// co-author aliases, the repository's own hooks when qa itself fails, qa's own
// problems never blocking a commit, the effective core.hooksPath, the qa
// launcher for pre-commit, and a pass-through script copied into .git/hooks.

const QA = { node: process.execPath, script: QA_BIN };
const DEFAULT = 'Cursor, gpt-5, 1.7.0';

describe('AI co-author aliases (L14)', () => {
  const registry = config().registry;
  const tool = (v: string): string | undefined => toolForAlias(registry, v)?.id;

  it('converts the real AI co-authors', () => {
    expect(tool('Cursor Agent <cursoragent@cursor.com>')).toBe('cursor');
    expect(tool('Copilot <175728472+Copilot@users.noreply.github.com>')).toBe('github-copilot');
    expect(tool('copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>')).toBe('github-copilot');
    expect(tool('Codex <codex@openai.com>')).toBe('openai-codex');
    expect(tool('Claude <noreply@anthropic.com>')).toBe('claude-code');
  });

  it('leaves people whose name or address only contains an alias alone', () => {
    expect(tool('Jane Codexter <jane@example.com>')).toBeUndefined();
    expect(tool('Bob <bob@copilotlabs.io>')).toBeUndefined();
    expect(tool('bob@copilotlabs.io')).toBeUndefined();
    expect(tool('Ann <ann.noreply@anthropic.com.evil.io>')).toBeUndefined();
    expect(tool('Copilotson <x@example.com>')).toBeUndefined();
  });
});

describe('core.commentChar (L12)', () => {
  afterEach(() => useCommentString(undefined));

  it('works out the prefix git uses, also for "auto"', () => {
    expect(commentFor(undefined, '')).toBe('#');
    expect(commentFor(';', '')).toBe(';');
    expect(commentFor('//', '')).toBe('//');
    expect(commentFor('auto', 'x\n;\n; Please enter the commit message\n')).toBe(';');
    expect(commentFor('auto', '#1 fix\n\n; ------------------------ >8 ------------------------\n')).toBe(';');
    expect(commentFor('auto', '#1 fix\n')).toBe(';');
    expect(commentFor('auto', 'fix\n')).toBe('#');
  });

  it('pre-fills an editor template commented with ";" without touching its comments', () => {
    const template = '\n; Please enter the commit message for your changes.\n;\n; On branch feature/LCORE-1-x\n';
    const out = prepareMessage({
      message: template,
      source: '',
      branch: 'feature/LCORE-1-x',
      assistedBy: DEFAULT,
      comment: ';',
    });
    const lines = out.message.split('\n');
    expect(lines[0]).toBe('feat(LCORE-1): ');
    expect(lines.filter((l) => l.startsWith(';'))).toEqual(template.split('\n').filter((l) => l.startsWith(';')));
    expect(messageLines(out.message, ';')).toContain(`Assisted-by: ${DEFAULT}`);
    // A '#' line is content when the comment prefix is ';'.
    expect(messageLines('#12 fix\n; comment', ';')).toEqual(['#12 fix']);
    useCommentString(';');
    expect(messageLines('#12 fix\n; comment')).toEqual(['#12 fix']);
  });

  it('leaves replayed commits exactly as they are (H8)', () => {
    const message = 'some teammate subject\n';
    expect(
      prepareMessage({
        message,
        source: 'message',
        branch: 'feature/LCORE-1-x',
        assistedBy: DEFAULT,
        replaying: 'CHERRY_PICK_HEAD in progress',
      }).message,
    ).toBe(message);
  });
});

describe('hook scripts', () => {
  it('guard the pass-through against running themselves (L10)', () => {
    const text = hookScript('post-checkout', QA);
    expect(text).toContain('[ "$own" -ef "$0" ]');
    expect(text).toContain(PASSTHROUGH_ENV);
  });

  it('put the qa launcher and node first on PATH for pre-commit (M4)', () => {
    const env = preCommitEnv('/shim', { PATH: '/usr/bin' });
    const parts = (env.PATH as string).split(process.platform === 'win32' ? ';' : ':');
    expect(parts[0]).toBe('/shim');
    expect(parts.at(-1)).toBe('/usr/bin');
  });
});

// ---- End to end, in temp repositories with a private git configuration ----

describeBuilt('hooks end to end', () => {
  let work: string;
  let hooksDir: string;
  let baseEnv: NodeJS.ProcessEnv;
  let n = 0;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'qa-review-hooks-'));
    hooksDir = join(work, 'qa-hooks');
    writeHookScripts(hooksDir, QA);
    writeFileSync(join(work, 'gitconfig'), '');
    mkdirSync(join(work, 'home'));
    baseEnv = cliEnv({
      GIT_CONFIG_GLOBAL: join(work, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: join(work, 'home'),
      USERPROFILE: join(work, 'home'),
      QA_HOME: join(work, 'qa-home'),
      QA_CONFIG_DIR: CONFIG_DIR,
      // No pre-commit: the checks themselves are not what these cases test.
      QA_PRE_COMMIT_BIN: join(work, 'no-pre-commit'),
    });
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  function repo(origin: string | undefined = 'https://github.com/LedgerLink-ai/link_core.git') {
    const dir = join(work, `repo${++n}`);
    mkdirSync(dir);
    const run = (args: string[], env: NodeJS.ProcessEnv = baseEnv, input?: string) =>
      spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', input, timeout: 60_000 });
    const git = (...args: string[]): string => {
      const r = run(args);
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'dev@example.invalid');
    git('config', 'user.name', 'dev');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    if (origin) git('remote', 'add', 'origin', origin);
    writeFileSync(join(dir, 'README.md'), '# test\n');
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'init');
    const ownHook = (name: string, body: string): void => {
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(dir, '.git', 'hooks', name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, '.git', 'hooks', name), 0o755);
    };
    return { dir, git, run, ownHook };
  }

  /** A repository whose prepare-commit-msg runs "qa prepare-commit-msg" directly. */
  function messageRepo() {
    const r = repo();
    const dir = join(r.dir, '.msg-hooks');
    mkdirSync(dir);
    const posix = (p: string): string => p.replace(/\\/g, '/');
    writeFileSync(
      join(dir, 'prepare-commit-msg'),
      `#!/bin/sh\nexec "${posix(process.execPath)}" "${posix(QA_BIN)}" prepare-commit-msg "$@"\n`,
    );
    chmodSync(join(dir, 'prepare-commit-msg'), 0o755);
    r.git('config', 'core.hooksPath', '.msg-hooks');
    r.git('config', 'ledgerlink.assistedBy', DEFAULT);
    writeFileSync(join(r.dir, '.git', 'info', 'exclude'), '.msg-hooks/\n');
    return r;
  }

  const commitFile = (r: ReturnType<typeof repo>, file: string, message: string, verify = true): void => {
    writeFileSync(join(r.dir, file), `${file}\n`);
    r.git('add', file);
    // --no-verify does not skip prepare-commit-msg: a teammate's commit is made without these hooks.
    r.git(...(verify ? [] : ['-c', 'core.hooksPath=.no-hooks']), 'commit', '-q', '-m', message);
  };

  it('H8: a cherry-picked commit keeps its message; a new one is pre-filled', () => {
    const r = messageRepo();
    r.git('checkout', '-q', '-b', 'feature/LCORE-2-other');
    commitFile(r, 'other.txt', 'teammate change', false);
    const picked = r.git('rev-parse', 'HEAD').trim();
    r.git('checkout', '-q', '-b', 'feature/LCORE-1-mine', 'main');
    commitFile(r, 'mine.txt', 'Add mine');
    expect(r.git('log', '-1', '--format=%B').trim()).toBe(`feat(LCORE-1): Add mine\n\nAssisted-by: ${DEFAULT}`);
    r.git('cherry-pick', picked);
    expect(r.git('log', '-1', '--format=%B').trim()).toBe('teammate change');
  });

  it('H8: a rebase replays every commit message unchanged', () => {
    const r = messageRepo();
    r.git('checkout', '-q', '-b', 'feature/LCORE-3-x');
    commitFile(r, 'a.txt', 'first teammate commit', false);
    commitFile(r, 'b.txt', 'second teammate commit', false);
    r.git('checkout', '-q', 'main');
    commitFile(r, 'm.txt', 'main moved', false);
    r.git('checkout', '-q', 'feature/LCORE-3-x');
    r.git('rebase', '-q', 'main');
    expect(r.git('log', '-2', '--format=%B').trim().split(/\n+/)).toEqual([
      'second teammate commit',
      'first teammate commit',
    ]);
  });

  it('L12: with core.commentChar ";" the editor template is pre-filled, not its comments', () => {
    const r = messageRepo();
    r.git('config', 'core.commentChar', ';');
    r.git('checkout', '-q', '-b', 'feature/LCORE-4-x');
    writeFileSync(join(r.dir, 'c.txt'), 'c\n');
    r.git('add', 'c.txt');
    const res = r.run(['commit', '-q'], { ...baseEnv, GIT_EDITOR: 'true' });
    expect(res.status).toBe(0);
    expect(r.git('log', '-1', '--format=%B').trim()).toBe(`feat(LCORE-4):\n\nAssisted-by: ${DEFAULT}`);
  });

  function globalHooksRepo(origin?: string) {
    const r = repo(origin);
    r.git('config', 'core.hooksPath', hooksDir.replace(/\\/g, '/'));
    return r;
  }

  it("M1: the repository's own pre-commit and pre-push still run and block when qa cannot load its configuration", () => {
    const r = globalHooksRepo();
    const env = { ...baseEnv, QA_CONFIG_DIR: join(work, 'nonexistent') };
    r.ownHook('pre-commit', 'echo own-pre-commit-ran >&2; exit 1');
    writeFileSync(join(r.dir, 'x.txt'), 'x\n');
    r.git('add', 'x.txt');
    const commit = r.run(['commit', '-q', '-m', 'x'], env);
    expect(commit.status).not.toBe(0);
    expect(commit.stderr).toContain('own-pre-commit-ran');

    rmSync(join(r.dir, '.git', 'hooks', 'pre-commit'));
    expect(r.run(['commit', '-q', '-m', 'x'], env).status).toBe(0);
    const remote = join(work, `remote${n}.git`);
    execFileSync('git', ['init', '-q', '--bare', remote], { env: baseEnv });
    r.git('remote', 'add', 'backup', remote);
    const seen = join(work, `stdin${n}.txt`).replace(/\\/g, '/');
    r.ownHook('pre-push', `cat > '${seen}'; echo own-pre-push-ran >&2; exit 3`);
    const push = r.run(['push', 'backup', 'HEAD:refs/heads/main'], env);
    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain('own-pre-push-ran');
    expect(readFileSync(seen, 'utf8')).toMatch(/^\S+ [0-9a-f]{40} refs\/heads\/main [0-9a-f]{40}/);
  });

  it('M2: a bad QA_LOG_LEVEL or CI in the shell does not block a commit; the own hook still runs', () => {
    const r = globalHooksRepo(undefined);
    r.ownHook('pre-commit', 'echo own-ran >&2');
    writeFileSync(join(r.dir, 'y.txt'), 'y\n');
    r.git('add', 'y.txt');
    const res = r.run(['commit', '-q', '-m', 'y'], { ...baseEnv, CI: 'true', QA_LOG_LEVEL: 'loud' });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('own-ran');
    expect(res.stderr).toContain('using the default logging');
    // Run explicitly, check still fails closed in CI.
    const check = spawnSync(process.execPath, [QA_BIN, 'check'], {
      cwd: r.dir,
      env: { ...baseEnv, CI: 'true' },
      encoding: 'utf8',
    });
    expect(check.status).toBe(2);
  });

  it('L13: an incompatible --require never blocks prepare-commit-msg, also through "qa hook"', () => {
    const r = repo();
    const msg = join(r.dir, '.git', 'MSG');
    writeFileSync(msg, 'x\n');
    const qa = (...args: string[]) =>
      spawnSync(process.execPath, [QA_BIN, ...args], { cwd: r.dir, env: baseEnv, encoding: 'utf8' });
    expect(qa('--require', '99.0.0', 'hook', 'prepare-commit-msg', msg).status).toBe(0);
    expect(qa('--require=99.0.0', 'prepare-commit-msg', msg).status).toBe(0);
    expect(qa('--require', '99.0.0', 'hook', 'pre-commit').status).toBe(2);
  });

  it('M2: bin/qa.js without its dist/ lets a hook through and fails other commands clearly', () => {
    const pkg = join(work, 'broken-package');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    copyFileSync(QA_BIN, join(pkg, 'bin', 'qa.js'));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [join(pkg, 'bin', 'qa.js'), ...args], { env: baseEnv, encoding: 'utf8' });
    const hook = run('--require', '0.2.3', 'hook', 'pre-commit');
    expect(hook.status).toBe(0);
    expect(hook.stderr).toContain('checks were skipped');
    const other = run('check');
    expect(other.status).toBe(2);
    expect(other.stderr).toContain('could not load');
  });

  it('M4: pre-commit finds the running qa on PATH, also without qa installed anywhere', () => {
    const r = globalHooksRepo();
    const out = join(work, `which${n}.txt`).replace(/\\/g, '/');
    // A stand-in for pre-commit: sh runs ./hook-impl, which reports the qa it finds.
    writeFileSync(join(r.dir, 'hook-impl'), `command -v qa > '${out}'\nqa version >> '${out}'\n`);
    writeFileSync(join(r.dir, '.git', 'info', 'exclude'), 'hook-impl\n');
    writeFileSync(join(r.dir, 'z.txt'), 'z\n');
    r.git('add', 'z.txt');
    const res = r.run(['commit', '-q', '-m', 'z'], { ...baseEnv, QA_PRE_COMMIT_BIN: 'sh', GIT_EDITOR: 'true' });
    expect(res.status).toBe(0);
    const [path, version] = readFileSync(out, 'utf8').trim().split(/\r?\n/);
    expect(path.replace(/\\/g, '/')).toContain('/qa-home/shims/');
    expect(version).toBe(ENGINE_VERSION);
  });

  it('L10: a copy of a pass-through script in .git/hooks does not loop', () => {
    const r = globalHooksRepo();
    r.ownHook('post-checkout', readFileSync(join(hooksDir, 'post-checkout'), 'utf8').replace(/^#!\/bin\/sh\n/, ''));
    const viaGlobal = r.run(['checkout', '-q', '-b', 'loop-1']);
    expect(viaGlobal.error).toBeUndefined();
    expect(viaGlobal.status).toBe(0);
    // git running .git/hooks itself (no core.hooksPath): the script is its own hook.
    r.git('config', '--unset', 'core.hooksPath');
    const direct = r.run(['checkout', '-q', '-b', 'loop-2']);
    expect(direct.error).toBeUndefined();
    expect(direct.status).toBe(0);
  }, 90_000);

  describe('M3: the core.hooksPath git actually uses', () => {
    const setupIn = (name: string, globalText: string, system?: string) => {
      const dir = join(work, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'gitconfig'), globalText);
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
        QA_HOME: join(dir, 'home'),
      };
      if (system !== undefined) {
        writeFileSync(join(dir, 'system'), system);
        delete env.GIT_CONFIG_NOSYSTEM;
        env.GIT_CONFIG_SYSTEM = join(dir, 'system');
      }
      const qa = (...args: string[]) =>
        spawnSync(process.execPath, [QA_BIN, ...args], { cwd: tmpdir(), env, encoding: 'utf8', timeout: 120_000 });
      return { dir, env, qa, global: () => readFileSync(join(dir, 'gitconfig'), 'utf8') };
    };
    const SETUP = ['setup', '--no-python', '--no-gitleaks'];

    it('refuses when an included file sets core.hooksPath, and leaves the global file alone', () => {
      const s = setupIn('m3-include', '[include]\n\tpath = inc.gitconfig\n');
      writeFileSync(join(s.dir, 'inc.gitconfig'), '[core]\n\thooksPath = /somewhere/else\n');
      const res = s.qa(...SETUP);
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/FAIL\s+global hooks\s+git's core\.hooksPath is already set to "\/somewhere\/else"/);
      expect(s.global()).not.toContain('hooksPath');
    });

    it('refuses when the system configuration sets core.hooksPath', () => {
      const s = setupIn('m3-system', '', '[core]\n\thooksPath = /system/hooks\n');
      const res = s.qa(...SETUP);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('"/system/hooks" (system');
    });

    it('connects the hooks, and doctor fails once an include overrides them', () => {
      const s = setupIn('m3-ok', '');
      const res = s.qa(...SETUP);
      expect(res.stdout).toMatch(/ok\s+global hooks/);
      expect(s.global()).toContain('hooksPath');
      expect(s.qa('doctor').stdout).toMatch(/ok\s+global hooks\s+.*\(global, file:/);
      // An include after qa's value wins in git; setup and doctor must see that.
      writeFileSync(join(s.dir, 'inc.gitconfig'), '[core]\n\thooksPath = /later/hooks\n');
      writeFileSync(join(s.dir, 'gitconfig'), `${s.global()}[include]\n\tpath = inc.gitconfig\n`);
      const doctor = s.qa('doctor');
      expect(doctor.status).toBe(1);
      expect(doctor.stdout).toMatch(/FAIL\s+global hooks\s+git uses core\.hooksPath "\/later\/hooks"/);
      expect(s.qa(...SETUP).status).toBe(1);
    });
  });
});
