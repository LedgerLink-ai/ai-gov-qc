import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { isWindows, qaHome, toolBinary } from './tools-home';

// Machine-wide hooks (AIQC-85). "qa setup" writes one small script per git
// hook into <home>/hooks and points git's global core.hooksPath at it, so the
// QA hooks run in every clone on the machine, old and new, with nothing
// copied into any repository. Each script:
//
//   - for pre-commit, prepare-commit-msg, commit-msg and pre-push, hands over to
//     "qa hook <name>" (runHook below), which runs the repository's own
//     .git/hooks/<name> and, in an opted-in LedgerLink-ai repository, the QA
//     checks: from the repository's .pre-commit-config.yaml when it has one,
//     else from the default configuration that ships in this package;
//   - for every other hook, runs the repository's own .git/hooks/<name>, so
//     Git LFS and anything else installed there keep working (git ignores
//     .git/hooks once core.hooksPath is set).
//
// A repository that sets its own core.hooksPath (husky) overrides the global
// one; its hooks run as before and call "qa hook <name>" to add the checks.
// The scripts let commits through when anything is missing: a broken install
// must not stop work in every repository on the machine.

/** Set by a hook script before it runs the repository's own copy, so a copy of the script there stops. */
export const PASSTHROUGH_ENV = 'LEDGERLINK_QA_PASSTHROUGH';

/** First line after the shebang of every script qa writes; "qa setup" only replaces or removes files with it. */
export const MANAGED_MARKER = '# ledgerlink-qa managed hook v1';

/** The hooks that run QA checks. */
export const QA_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'pre-push'] as const;
export type QaHook = (typeof QA_HOOKS)[number];

/**
 * Every other client- and server-side hook git runs from the hooks directory,
 * passed through to the repository's own copy. Left out on purpose:
 * reference-transaction and post-index-change, which git runs on every ref
 * update and index write (a script there would slow every git command),
 * fsmonitor-watchman, which git only runs when core.fsMonitor names it, and
 * push-to-checkout, whose mere presence turns off git's own work-tree update
 * for receive.denyCurrentBranch=updateInstead.
 */
export const PASS_THROUGH_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-merge-commit',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
] as const;

export const globalHooksDir = (): string => join(qaHome(), 'hooks');

/** The qa that the scripts call: this node and this package's bin/qa.js. */
export interface QaCommand {
  node: string;
  script: string;
  /** The qa home "qa setup" installed into, so "qa hook" finds pre-commit there without QA_HOME set. */
  home?: string;
}

export const thisQa = (): QaCommand => ({
  node: process.execPath,
  script: resolve(__dirname, '..', 'bin', 'qa.js'),
  home: qaHome(),
});

const posix = (p: string): string => p.replace(/\\/g, '/');
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The default hook configuration: templates/pre-commit-config.yaml, shipped
 * in the package (next to dist/) and found in a checkout of this repository.
 */
export function defaultHookConfig(): string {
  const candidates = [
    resolve(__dirname, '..', 'templates', 'pre-commit-config.yaml'),
    resolve(__dirname, '..', '..', '..', 'templates', 'pre-commit-config.yaml'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`the default hook configuration is missing (looked in ${candidates.join(', ')})`);
  return found;
}

/**
 * The default configuration, copied into the repository's git directory
 * (<git dir>/ledgerlink-qa/pre-commit-config.yaml) and rewritten only when the
 * installed qa ships a different one. pre-commit works out the configuration's
 * path relative to the repository, which fails on Windows when the two are on
 * different drives (qa installed on C:, the repository on D:). The git
 * directory is git's own metadata: nothing appears in the working tree, and
 * git never commits it.
 */
export function stageDefaultConfig(gitDir: string): string {
  const text = readFileSync(defaultHookConfig());
  const dest = join(gitDir, 'ledgerlink-qa', 'pre-commit-config.yaml');
  let current: Buffer | undefined;
  try {
    current = readFileSync(dest);
  } catch {
    current = undefined;
  }
  if (!current?.equals(text)) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  return dest;
}

/** The POSIX shell script for one hook. Git runs hooks with sh on every OS, Git for Windows included. */
export function hookScript(hook: string, qa: QaCommand): string {
  // A copy of this script in .git/hooks would exec itself for ever: it stops
  // when the own hook is this very file, or when the outer script already
  // handed this hook over to it.
  const passThrough = [
    'common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0',
    'own="$common/hooks/$hook"',
    `if [ "\${${PASSTHROUGH_ENV}:-}" = "$hook|$own" ] || [ "$own" -ef "$0" ]; then exit 0; fi`,
    `if [ -f "$own" ] && [ -x "$own" ]; then ${PASSTHROUGH_ENV}="$hook|$own"; export ${PASSTHROUGH_ENV}; exec "$own" "$@"; fi`,
    'exit 0',
  ];
  const head = [
    '#!/bin/sh',
    MANAGED_MARKER,
    '# Installed by "qa setup" (LedgerLink QA); remove with "qa setup --uninstall".',
    `hook=${shQuote(hook)}`,
  ];
  if (!(QA_HOOKS as readonly string[]).includes(hook)) {
    return [...head, "# Runs this repository's own .git/hooks copy, if it has one.", ...passThrough, ''].join('\n');
  }
  return [
    ...head,
    "# Hands over to qa, which runs the repository's own hook and, in opted-in",
    '# LedgerLink-ai repositories, the QA checks. Without qa, only the own hook runs.',
    ...(qa.home ? [`if [ -z "\${QA_HOME:-}" ]; then QA_HOME=${shQuote(posix(qa.home))}; export QA_HOME; fi`] : []),
    `QA_NODE=${shQuote(posix(qa.node))}`,
    `QA_JS=${shQuote(posix(qa.script))}`,
    // An install whose dist/ is missing cannot load: the own hook still runs, below.
    'if [ -f "$QA_NODE" ] && [ -f "$QA_JS" ] && [ -f "${QA_JS%/bin/qa.js}/dist/cli.js" ]; then exec "$QA_NODE" "$QA_JS" hook "$hook" "$@"; fi',
    'if command -v qa >/dev/null 2>&1; then exec qa hook "$hook" "$@"; fi',
    'echo "qa: the LedgerLink QA engine was not found, so its checks were skipped. Reinstall it, or remove these hooks: qa setup --uninstall" >&2',
    ...passThrough,
    '',
  ].join('\n');
}

const isManaged = (file: string): boolean => {
  try {
    return readFileSync(file, 'utf8').split('\n', 3).includes(MANAGED_MARKER);
  } catch {
    return false;
  }
};

/** Writes (or rewrites) every hook script into dir. Files there without the marker are left alone. */
export function writeHookScripts(dir: string, qa: QaCommand = thisQa()): void {
  mkdirSync(dir, { recursive: true });
  for (const hook of [...QA_HOOKS, ...PASS_THROUGH_HOOKS]) {
    const file = join(dir, hook);
    if (existsSync(file) && !isManaged(file)) continue;
    writeFileSync(file, hookScript(hook, qa));
    if (!isWindows) chmodSync(file, 0o755);
  }
}

/** The line every QA hook script hands over to qa with; a pass-through script lacks it. */
const HANDOVER = 'hook "$hook" "$@"';

/**
 * True when dir holds qa's scripts for every QA hook, each handing over to qa.
 * An install from an older qa, where commit-msg only passed through, is not.
 */
export function hookScriptsInstalled(dir: string): boolean {
  return QA_HOOKS.every((h) => {
    const file = join(dir, h);
    return isManaged(file) && readFileSync(file, 'utf8').includes(HANDOVER);
  });
}

/** Removes qa's scripts from dir, and dir itself when nothing else is left in it. */
export function removeHookScripts(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) if (isManaged(join(dir, name))) rmSync(join(dir, name), { force: true });
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}

/** Same directory, whatever the slashes, case on Windows, or a leading ~. */
export function sameDir(a: string, b: string, home = process.env.USERPROFILE ?? process.env.HOME ?? '~'): boolean {
  const norm = (p: string): string => {
    const r = resolve(p.replace(/^~(?=[\\/]|$)/, home)).replace(/[\\/]+$/, '');
    return isWindows ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

// ---- qa hook <name> -------------------------------------------------------

/** The qa command that each hook's gate decision is logged under. */
const GATE_COMMAND: Record<QaHook, string> = {
  'pre-commit': 'precommit',
  'prepare-commit-msg': 'prepare-commit-msg',
  'commit-msg': 'commit-msg',
  'pre-push': 'prepush',
};

export interface HookDeps {
  /** The execution gate: undefined to run, else the exit code to stop with (0: skip quietly). */
  gateExit: (command: string, root: string) => number | undefined;
  warn: (message: string) => void;
  cwd?: string;
  stdin?: () => Buffer;
}

const gitText = (cwd: string, args: string[]): string | undefined => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && !r.error ? r.stdout.trim() : undefined;
};

/** pre-commit's own scripts, written by "pre-commit install" or a pre-commit git template. */
const PRE_COMMIT_SCRIPT = 'File generated by pre-commit';

/** Set for the repository's own hook while "qa hook" runs it: "<hook>|<git common dir>". */
const ACTIVE_ENV = 'LEDGERLINK_QA_HOOK';

/**
 * A directory with a "qa" launcher (sh, and qa.cmd for Windows) for the qa
 * that is running now, under <home>/shims. The default configuration's hooks
 * are "language: system" with entry "qa ...", which pre-commit looks up on
 * PATH; a GUI git client often starts hooks without npm's global bin on PATH,
 * so runHook puts this directory first for pre-commit.
 */
export function qaShimDir(qa: QaCommand = thisQa()): string {
  const id = createHash('sha256').update(`${qa.node}\n${qa.script}`).digest('hex').slice(0, 12);
  const dir = join(qa.home ?? qaHome(), 'shims', id);
  const files: Record<string, string> = {
    qa: `#!/bin/sh\n${MANAGED_MARKER}\nexec ${shQuote(posix(qa.node))} ${shQuote(posix(qa.script))} "$@"\n`,
    'qa.cmd': `@"${qa.node}" "${qa.script}" %*\r\n`,
  };
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name);
    let current: string | undefined;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== text) {
      // Written aside and renamed, so a hook running at the same time never sees half a file.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      if (!isWindows && name === 'qa') chmodSync(tmp, 0o755);
      renameSync(tmp, file);
    }
  }
  return dir;
}

/** The environment for pre-commit: PATH starts with the running qa's launcher and node. */
export function preCommitEnv(shimDir: string | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const first = [shimDir, dirname(process.execPath)].filter((d): d is string => Boolean(d));
  return { ...env, [key]: [...first, env[key] ?? ''].filter((p) => p !== '').join(delimiter) };
}

/**
 * Runs one hook for the repository in deps.cwd: its own .git/hooks copy, then,
 * when the gate allows it, the QA checks through pre-commit. Returns the exit
 * code git sees. Never throws once the hook name is valid. qa's own problems
 * (a broken configuration, a gate that cannot decide, a missing tool) are
 * reported and let the commit or push through, but the repository's own hook
 * (Git LFS and the like) always runs, gets the same stdin, and its exit code
 * still counts.
 */
export function runHook(hook: string, args: string[], deps: HookDeps): number {
  if (!(QA_HOOKS as readonly string[]).includes(hook))
    throw new Error(`qa hook runs ${QA_HOOKS.join(', ')}; got "${hook}"`);
  const cwd = deps.cwd ?? process.cwd();
  // pre-push gets the refs being pushed on stdin; both the own hook and pre-commit read them.
  let input: Buffer | undefined;
  if (hook === 'pre-push') {
    try {
      input = (deps.stdin ?? (() => readFileSync(0)))();
    } catch {
      input = Buffer.alloc(0);
    }
  }

  let own: string | undefined;
  let ownExists = false;
  let active = '';
  let ownStatus: number | undefined;
  /** The repository's own hook, run at most once; its exit code. */
  const runOwn = (): number => {
    if (ownStatus !== undefined) return ownStatus;
    ownStatus = 0;
    if (!own || !ownExists) return ownStatus;
    const options = {
      cwd,
      input,
      stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'] as ['pipe' | 'inherit', 'inherit', 'inherit'],
      env: { ...process.env, [ACTIVE_ENV]: active },
    };
    // Node cannot start a shebang script on Windows. Git for Windows puts its sh
    // on the hook's PATH, and sh's exec follows the #! line as git does, so a
    // hook in Python or Node runs with its own interpreter.
    const res = isWindows
      ? spawnSync('sh', ['-c', 'exec "$0" "$@"', posix(own), ...args], options)
      : spawnSync(own, args, options);
    if (res.error) {
      deps.warn(`could not run ${own} (${res.error.message}); skipped`);
      return ownStatus;
    }
    ownStatus = res.status ?? 1;
    return ownStatus;
  };
  const skipped = (err: unknown): string =>
    `the ${hook} checks could not run (${(err as Error).message}); skipped. "qa doctor" shows what is wrong.`;

  try {
    const common = gitText(cwd, ['rev-parse', '--git-common-dir']);
    own = common ? join(resolve(cwd, common), 'hooks', hook) : undefined;
    // The repository's own hook called "qa hook" again (a copy of qa's script in
    // .git/hooks): the outer run does the work, so this one stops here.
    active = `${hook}|${own ?? cwd}`;
    if (process.env[ACTIVE_ENV] === active) return 0;
    // When git itself runs .git/hooks (a local core.hooksPath=.git/hooks, or no
    // core.hooksPath at all), the own hook is what called "qa hook": running it
    // again would never end.
    const hooksPath = gitText(cwd, ['rev-parse', '--git-path', 'hooks']);
    const gitRanOwn = own !== undefined && hooksPath !== undefined && sameDir(resolve(cwd, hooksPath), dirname(own));
    ownExists = own !== undefined && !gitRanOwn && existsSync(own);
    const ownIsPreCommit = ownExists && readFileSync(own as string, 'utf8').includes(PRE_COMMIT_SCRIPT);

    const top = gitText(cwd, ['rev-parse', '--show-toplevel']);
    if (!top) return runOwn(); // a bare repository: nothing to check
    let decision: number | undefined;
    try {
      decision = deps.gateExit(GATE_COMMAND[hook as QaHook], top);
    } catch (err) {
      deps.warn(skipped(err));
      return runOwn();
    }
    if (decision !== undefined) {
      const status = runOwn();
      return status !== 0 ? status : decision;
    }

    // An opted-in repository. pre-commit's own scripts would run the same
    // checks a second time, so only other hooks (Git LFS and the like) run first.
    if (!ownIsPreCommit) {
      const status = runOwn();
      if (status !== 0) return status;
    }
    // The repository's own configuration wins; without one, the default that ships with qa.
    let config: string;
    try {
      const repoConfig = join(top, '.pre-commit-config.yaml');
      config = existsSync(repoConfig) ? repoConfig : stageDefaultConfig(resolve(cwd, common as string));
    } catch (err) {
      deps.warn(`${(err as Error).message}; the checks were skipped. Reinstall qa.`);
      return 0;
    }
    let shim: string | undefined;
    try {
      shim = qaShimDir();
    } catch (err) {
      deps.warn(`could not write the qa launcher for pre-commit (${(err as Error).message}); "qa" must be on PATH`);
    }
    const preCommit = toolBinary('pre-commit');
    const res = spawnSync(
      preCommit,
      [
        'hook-impl',
        '--config',
        config,
        '--hook-type',
        hook,
        '--hook-dir',
        own ? dirname(own) : join(top, '.git', 'hooks'),
        '--',
        ...args,
      ],
      {
        cwd: top,
        input,
        stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
        env: preCommitEnv(shim),
        windowsHide: true,
      },
    );
    if (res.error) {
      deps.warn(
        `pre-commit was not found (${preCommit}), so the checks were skipped here; CI runs them. Run "qa setup".`,
      );
      return 0;
    }
    return res.status ?? 1;
  } catch (err) {
    deps.warn(skipped(err));
    return runOwn();
  }
}
