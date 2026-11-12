import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isWindows, qaHome, toolBinary } from './tools-home';

// Machine-wide hooks (AIQC-85). "qa setup" writes one small script per git
// hook into <home>/hooks and points git's global core.hooksPath at it, so the
// QA hooks run in every clone on the machine, old and new, with nothing
// copied into any repository. Each script:
//
//   - for pre-commit, prepare-commit-msg and pre-push, hands over to
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

/** First line after the shebang of every script qa writes; "qa setup" only replaces or removes files with it. */
export const MANAGED_MARKER = '# ledgerlink-qa managed hook v1';

/** The hooks that run QA checks. */
export const QA_HOOKS = ['pre-commit', 'prepare-commit-msg', 'pre-push'] as const;
export type QaHook = (typeof QA_HOOKS)[number];

/**
 * Every other client- and server-side hook git runs from the hooks directory,
 * passed through to the repository's own copy. Left out on purpose:
 * reference-transaction and post-index-change, which git runs on every ref
 * update and index write (a script there would slow every git command), and
 * fsmonitor-watchman, which git only runs when core.fsMonitor names it.
 */
export const PASS_THROUGH_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-merge-commit',
  'commit-msg',
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
  'push-to-checkout',
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
}

export const thisQa = (): QaCommand => ({
  node: process.execPath,
  script: resolve(__dirname, '..', 'bin', 'qa.js'),
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

/** The POSIX shell script for one hook. Git runs hooks with sh on every OS, Git for Windows included. */
export function hookScript(hook: string, qa: QaCommand): string {
  const passThrough = [
    'common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0',
    'own="$common/hooks/$hook"',
    'if [ -f "$own" ] && [ -x "$own" ]; then exec "$own" "$@"; fi',
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
    `QA_NODE=${shQuote(posix(qa.node))}`,
    `QA_JS=${shQuote(posix(qa.script))}`,
    'if [ -f "$QA_NODE" ] && [ -f "$QA_JS" ]; then exec "$QA_NODE" "$QA_JS" hook "$hook" "$@"; fi',
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

/** True when dir holds qa's scripts for the three QA hooks. */
export function hookScriptsInstalled(dir: string): boolean {
  return QA_HOOKS.every((h) => isManaged(join(dir, h)));
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

/**
 * Runs one hook for the repository in deps.cwd: its own .git/hooks copy, then,
 * when the gate allows it, the QA checks through pre-commit. Returns the exit
 * code git sees. Never throws: anything unexpected is reported and lets the
 * commit or push through.
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
  const common = gitText(cwd, ['rev-parse', '--git-common-dir']);
  const own = common ? join(resolve(cwd, common), 'hooks', hook) : undefined;
  const ownExists = own !== undefined && existsSync(own);
  const ownIsPreCommit = ownExists && readFileSync(own, 'utf8').includes(PRE_COMMIT_SCRIPT);

  const runOwn = (): number => {
    if (!own || !ownExists) return 0;
    // Node cannot start a shebang script on Windows; Git for Windows puts its sh on the hook's PATH.
    const res = isWindows
      ? spawnSync('sh', [posix(own), ...args], {
          cwd,
          input,
          stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
        })
      : spawnSync(own, args, { cwd, input, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'] });
    if (res.error) {
      deps.warn(`could not run ${own} (${res.error.message}); skipped`);
      return 0;
    }
    return res.status ?? 1;
  };

  const top = gitText(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return runOwn(); // a bare repository: nothing to check
  const decision = deps.gateExit(GATE_COMMAND[hook as QaHook], top);
  if (decision !== undefined) return decision === 0 ? runOwn() : decision;

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
    config = existsSync(repoConfig) ? repoConfig : defaultHookConfig();
  } catch (err) {
    deps.warn(`${(err as Error).message}; the checks were skipped. Reinstall qa.`);
    return 0;
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
    { cwd: top, input, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'], windowsHide: true },
  );
  if (res.error) {
    deps.warn(
      `pre-commit was not found (${preCommit}), so the checks were skipped here; CI runs them. Run "qa setup".`,
    );
    return 0;
  }
  return res.status ?? 1;
}
