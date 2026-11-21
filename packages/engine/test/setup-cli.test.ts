import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookScriptsInstalled, sameDir } from '../src/hooks';
import { cliEnv, describeBuilt, qa } from './cli-helpers';
import { CONFIG_DIR } from './helpers';

// "qa setup" changes git's global configuration on a developer's machine.
// These run the built CLI against a private global git config and qa home,
// and pin what it must never do: install a gitleaks it could not verify,
// download over plain http, overwrite or remove what is not qa's, or report
// the hooks connected when they are not.

const posix = (p: string): string => p.replace(/\\/g, '/');

describeBuilt('qa setup', () => {
  let work: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  const gitconfig = (): string => join(work, 'gitconfig');
  const globalGet = (key: string): string =>
    spawnSync('git', ['config', '--global', '--get', key], { env, encoding: 'utf8' }).stdout.trim();
  const globalSet = (key: string, value: string): void => {
    execFileSync('git', ['config', '--global', key, value], { env });
  };
  const setup = (...args: string[]): { status: number | null; stdout: string } => {
    const r = qa(['setup', '--no-python', ...args], { cwd: work, env });
    return { status: r.status, stdout: r.stdout + r.stderr };
  };

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'qa-setup-cli-'));
    home = join(work, 'home');
    writeFileSync(gitconfig(), '');
    env = cliEnv({ QA_HOME: home, GIT_CONFIG_GLOBAL: gitconfig(), QA_CONFIG_DIR: CONFIG_DIR });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  describe('gitleaks', () => {
    const gitleaksBin = (): string => join(home, 'bin', process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');

    it('refuses an archive whose SHA-256 is not the published one, and installs nothing', () => {
      const archive = join(work, 'gitleaks.zip');
      writeFileSync(archive, 'not the real gitleaks release');
      const r = setup('--no-global-hooks', '--no-git-template', '--gitleaks-archive', archive);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/FAIL\s+gitleaks\s+\S+ has SHA-256 [0-9a-f]{64}, expected [0-9a-f]{64}; not installed/);
      expect(r.stdout).toMatch(/result: NOT DONE \(1 problem\(s\)\)/);
      expect(existsSync(gitleaksBin())).toBe(false);
    });

    it('refuses a plain-http download mirror before any network request', () => {
      const r = setup(
        '--no-global-hooks',
        '--no-git-template',
        '--download-base',
        'http://mirror.example.com/gitleaks',
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/FAIL\s+gitleaks\s+download failed \(the Gitleaks download URL must use https:\/\//);
      expect(r.stdout).not.toMatch(/Downloading /);
      expect(existsSync(gitleaksBin())).toBe(false);
    });

    it('refuses a mirror URL with credentials in it', () => {
      const r = setup(
        '--no-global-hooks',
        '--no-git-template',
        '--download-base',
        'https://u:secret@mirror.example.com',
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/must not contain a user name or password/);
      expect(r.stdout).not.toContain('secret@');
    });

    it('still connects the hooks after a tool failure, and says the checks will not run until it is fixed', () => {
      const archive = join(work, 'gitleaks.zip');
      writeFileSync(archive, 'tampered');
      const r = setup('--gitleaks-archive', archive);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/ok\s+global hooks/);
      expect(r.stdout).toMatch(
        /WARN\s+hooks\s+installed, but the checks that need a tool marked FAIL above will not run/,
      );
    });
  });

  describe('global hooks', () => {
    const hooksDir = (): string => join(home, 'hooks');

    it('can be run again: a second setup finds its own core.hooksPath and succeeds', () => {
      expect(setup('--no-gitleaks').status).toBe(0);
      const second = setup('--no-gitleaks');
      expect(second.status).toBe(0);
      expect(second.stdout).toMatch(/ok\s+global hooks/);
      expect(sameDir(globalGet('core.hooksPath'), hooksDir())).toBe(true);
      expect(hookScriptsInstalled(hooksDir())).toBe(true);
    });

    it('recognises its own core.hooksPath written with other slashes', () => {
      // qa writes forward slashes; a hand-written value may use backslashes (Windows) or a trailing slash.
      globalSet('core.hooksPath', process.platform === 'win32' ? hooksDir().toUpperCase() : `${hooksDir()}/`);
      expect(setup('--no-gitleaks').status).toBe(0);
      const removed = qa(['setup', '--uninstall'], { cwd: work, env });
      expect(removed.stdout).toContain('core.hooksPath unset');
      expect(globalGet('core.hooksPath')).toBe('');
    });

    it('names an included config file that sets another core.hooksPath, and leaves it alone', () => {
      const included = join(work, 'team.gitconfig');
      writeFileSync(included, '[core]\n\thooksPath = /team/hooks\n');
      writeFileSync(gitconfig(), `[include]\n\tpath = ${posix(included)}\n`);
      const r = setup('--no-gitleaks');
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(
        /FAIL\s+global hooks\s+git's global core.hooksPath is already "\/team\/hooks" \(global, file:.*team\.gitconfig\)/,
      );
      expect(readFileSync(included, 'utf8')).toContain('hooksPath = /team/hooks');
      expect(readFileSync(gitconfig(), 'utf8')).not.toMatch(/hooksPath/);
    });

    it('a core.hooksPath given on the command line (GIT_CONFIG_*) also counts as foreign', () => {
      const r = qa(['setup', '--no-python', '--no-gitleaks'], {
        cwd: work,
        env: { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/ci/hooks' },
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/command core.hooksPath is already "\/ci\/hooks"/);
      expect(globalGet('core.hooksPath')).toBe('');
    });

    it("keeps a developer's own script in the hooks folder, and does not report the hooks connected", () => {
      mkdirSync(hooksDir(), { recursive: true });
      const mine = join(hooksDir(), 'pre-commit');
      writeFileSync(mine, '#!/bin/sh\necho mine\n');
      const r = setup('--no-gitleaks');
      expect(readFileSync(mine, 'utf8')).toBe('#!/bin/sh\necho mine\n');
      // qa's checks would never run on commit: setup must not claim success.
      expect(hookScriptsInstalled(hooksDir())).toBe(false);
      expect(r.stdout).not.toMatch(/ok\s+global hooks/);
      expect(r.stdout).toMatch(/FAIL\s+global hooks\s+.*pre-commit is not qa's; left as it is/);
      expect(r.status).toBe(1);
      // Nor is git pointed at a folder whose pre-commit would replace every repository's own.
      expect(globalGet('core.hooksPath')).toBe('');
    });

    it("uninstall removes qa's scripts but keeps a developer's own file and the folder", () => {
      expect(setup('--no-gitleaks').status).toBe(0);
      const mine = join(hooksDir(), 'my-notes.txt');
      writeFileSync(mine, 'keep me');
      expect(qa(['setup', '--uninstall'], { cwd: work, env }).status).toBe(0);
      expect(readFileSync(mine, 'utf8')).toBe('keep me');
      expect(existsSync(join(hooksDir(), 'pre-commit'))).toBe(false);
    });

    it('uninstall with nothing installed is a quiet success', () => {
      const r = qa(['setup', '--uninstall'], { cwd: work, env });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/ok\s+global hooks\s+not set/);
    });

    it('removes the git template an earlier qa setup made', () => {
      const tpl = join(home, 'git-template');
      mkdirSync(join(tpl, 'hooks'), { recursive: true });
      globalSet('init.templateDir', posix(tpl));
      const r = setup('--no-gitleaks');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/ok\s+git template\s+removed .*the global hooks replace it/);
      expect(globalGet('init.templateDir')).toBe('');
      expect(existsSync(tpl)).toBe(false);
    });

    it("warns about, but keeps, someone else's pre-commit template; ignores any other template", () => {
      const tpl = join(work, 'their-template');
      mkdirSync(join(tpl, 'hooks'), { recursive: true });
      writeFileSync(join(tpl, 'hooks', 'pre-commit'), '#!/bin/sh\n# File generated by pre-commit\n');
      globalSet('init.templateDir', posix(tpl));
      const r = setup('--no-gitleaks');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/WARN\s+git template\s+init.templateDir is .*copies pre-commit's hooks/);
      expect(globalGet('init.templateDir')).toBe(posix(tpl));
      expect(existsSync(tpl)).toBe(true);

      writeFileSync(join(tpl, 'hooks', 'pre-commit'), '#!/bin/sh\necho lint\n');
      const again = setup('--no-gitleaks');
      expect(again.stdout).not.toMatch(/git template/);
      expect(globalGet('init.templateDir')).toBe(posix(tpl));
    });
  });

  describe('the git template (--no-global-hooks)', () => {
    // pre-commit is faked: QA_PRE_COMMIT_BIN is node, and setup runs
    // "<bin> init-templatedir -t <hook>... <dir>" from its working directory,
    // so node runs the init-templatedir script written there.
    const fake = (): NodeJS.ProcessEnv => {
      writeFileSync(
        join(work, 'init-templatedir'),
        `const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), dir = args.at(-1);
const types = args.filter((a, i) => args[i - 1] === '-t');
fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
for (const t of types) fs.writeFileSync(path.join(dir, 'hooks', t), '#!/bin/sh\\n# File generated by pre-commit\\n');
fs.appendFileSync(path.join(${JSON.stringify(work)}, 'calls.log'), args.join(' ') + '\\n');
`,
      );
      return { ...env, QA_PRE_COMMIT_BIN: process.execPath };
    };
    const calls = (): string =>
      existsSync(join(work, 'calls.log')) ? readFileSync(join(work, 'calls.log'), 'utf8') : '';
    const tplSetup = (e: NodeJS.ProcessEnv) =>
      qa(['setup', '--no-python', '--no-gitleaks', '--no-global-hooks'], { cwd: work, env: e });

    it('creates the template with all four hooks and points init.templateDir at it', () => {
      const r = tplSetup(fake());
      expect(r.status).toBe(0);
      const tpl = join(home, 'git-template');
      expect(r.stdout).toMatch(/ok\s+git template\s+.*new clones connect the hooks/);
      expect(sameDir(globalGet('init.templateDir'), tpl)).toBe(true);
      for (const h of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'pre-push'])
        expect(existsSync(join(tpl, 'hooks', h))).toBe(true);
      expect(globalGet('core.hooksPath')).toBe('');
    });

    it('is a no-op the second time', () => {
      const e = fake();
      tplSetup(e);
      const r = tplSetup(e);
      expect(r.stdout).toMatch(/ok\s+git template\s+.*\(already set up\)/);
      expect(calls().trim().split('\n')).toHaveLength(1);
    });

    it('brings an older pre-commit template (pre-commit hook only) up to all four hooks', () => {
      const tpl = join(work, 'old-template');
      mkdirSync(join(tpl, 'hooks'), { recursive: true });
      writeFileSync(join(tpl, 'hooks', 'pre-commit'), '#!/bin/sh\n# File generated by pre-commit\n');
      globalSet('init.templateDir', posix(tpl));
      const r = tplSetup(fake());
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/updated to pre-commit, prepare-commit-msg, commit-msg, pre-push/);
      expect(existsSync(join(tpl, 'hooks', 'commit-msg'))).toBe(true);
    });

    it("leaves someone else's template alone, with the command to use it", () => {
      const tpl = join(work, 'their-template');
      mkdirSync(tpl);
      globalSet('init.templateDir', posix(tpl));
      const r = tplSetup(fake());
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/WARN\s+git template\s+init.templateDir is already .*left as it is/);
      expect(globalGet('init.templateDir')).toBe(posix(tpl));
      expect(calls()).toBe('');
    });

    it('fails, and sets nothing, when pre-commit is missing', () => {
      const r = tplSetup({ ...env, QA_PRE_COMMIT_BIN: join(work, 'no-such-pre-commit') });
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/FAIL\s+git template\s+pre-commit init-templatedir failed/);
      expect(globalGet('init.templateDir')).toBe('');
    });
  });
});
