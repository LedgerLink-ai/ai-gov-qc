import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scrubbedEnv } from './exec';
import type { RepositoryAllowlist } from './types';

/**
 * Execution gate (issue #8). The engine runs only in a repository that
 * belongs to the organisation and is listed, enabled, in
 * registry/repositories.yaml. Anything else is skipped silently, except in CI
 * where an identity that cannot be verified is an engine error (fail closed).
 *
 * Trust: locally the identity is the `origin` remote, which a developer
 * controls, so the local gate keeps the hooks out of personal and other
 * organisations' repositories but cannot stop a determined bypass. In GitHub
 * Actions the identity comes from the runner's own metadata (GITHUB_REPOSITORY
 * and the event payload), which the repository's files cannot change. The
 * allowlist itself ships inside the released package, never from the checkout.
 */

export interface RepoIdentity {
  owner: string;
  name: string;
}

export type GateDecision =
  | { run: true; repo: RepoIdentity }
  | { run: false; reason: string; repo?: RepoIdentity }
  | { run: false; failClosed: true; reason: string };

export interface GateEnv {
  [key: string]: string | undefined;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** A remote URL taken apart: the host it names and how it is reached. */
export interface RemoteInfo extends RepoIdentity {
  host: string;
  /** https, http and git:// name the host directly; ssh and scp-like may name an ~/.ssh/config alias. */
  transport: 'http' | 'ssh';
}

/**
 * Host, owner and name from a git remote URL (https, ssh, scp-like, git://),
 * or undefined for anything that is not a plain host/owner/repo form: local
 * paths, extra path segments, empty or odd characters. Says nothing about
 * whether the host is GitHub; see parseRemoteUrl.
 */
export function parseRemote(url: string): RemoteInfo | undefined {
  const text = url.trim();
  let path: string | undefined;
  let host: string | undefined;
  let transport: RemoteInfo['transport'] = 'ssh';
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(text);
  if (scp) [, host, path] = scp;
  else {
    const m = /^(https?|ssh|git):\/\/(?:[^/@\s]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/(.+)$/.exec(text);
    if (m) {
      [, , host, path] = m;
      transport = m[1] === 'ssh' ? 'ssh' : 'http';
    }
  }
  if (path === undefined || host === undefined || host.startsWith('-') || host.startsWith('.')) return undefined;
  const parts = path
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/');
  if (parts.length !== 2 || !parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..')) return undefined;
  return { owner: parts[0], name: parts[1], host: host.toLowerCase(), transport };
}

/** Hosts that are GitHub: github.com, and for SSH also ssh.github.com (SSH over port 443). */
const GITHUB_HOSTS = { http: ['github.com'], ssh: ['github.com', 'ssh.github.com'] } as const;

/** The real host name an SSH host (possibly an ~/.ssh/config alias) connects to, or undefined. */
export type SshHostResolver = (host: string) => string | undefined;

const SSH_RESOLVE_TIMEOUT_MS = 5_000;
const sshResolved = new Map<string, string | undefined>();

/**
 * Resolves an SSH host alias with "ssh -G <host>" (prints the configuration
 * ssh would use, without connecting): the "hostname" line. Run without a
 * shell, with a short time limit and no credential variables. Undefined when
 * ssh is missing, fails or prints no host name: the caller then treats the
 * origin as not verified (fail closed).
 */
export function sshHostname(host: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) return undefined;
  if (sshResolved.has(host)) return sshResolved.get(host);
  let resolved: string | undefined;
  try {
    const res = spawnSync('ssh', ['-G', '--', host], {
      encoding: 'utf8',
      timeout: SSH_RESOLVE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: scrubbedEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (!res.error && res.status === 0)
      resolved = /^hostname[ \t]+(\S+)[ \t]*\r?$/im.exec(res.stdout ?? '')?.[1]?.toLowerCase();
  } catch {
    resolved = undefined;
  }
  sshResolved.set(host, resolved);
  return resolved;
}

/**
 * Owner and name from a git remote URL that points at GitHub, else undefined.
 *
 * - https/http/git:// URLs must name github.com itself.
 * - ssh:// and scp-like URLs may name github.com or ssh.github.com, or an SSH
 *   host alias (git@github-ledgerlink:LedgerLink-ai/link_core.git, where
 *   ~/.ssh/config maps github-ledgerlink to github.com). An alias counts only
 *   when "ssh -G" resolves it to github.com or ssh.github.com; one that cannot
 *   be resolved is not GitHub (fail closed: skipped locally, exit 2 in CI).
 */
export function parseRemoteUrl(url: string, resolveSshHost: SshHostResolver = sshHostname): RepoIdentity | undefined {
  const remote = parseRemote(url);
  if (!remote) return undefined;
  const hosts: readonly string[] = GITHUB_HOSTS[remote.transport];
  let host = remote.host;
  if (!hosts.includes(host) && remote.transport === 'ssh') host = resolveSshHost(host)?.toLowerCase() ?? '';
  if (!hosts.includes(host)) return undefined;
  return { owner: remote.owner, name: remote.name };
}

/** Case-insensitive, as GitHub treats owner and repository names. */
export function isAllowed(
  allowlist: RepositoryAllowlist,
  id: RepoIdentity,
): { ok: true } | { ok: false; reason: string } {
  if (id.owner.toLowerCase() !== allowlist.org.toLowerCase())
    return { ok: false, reason: `${id.owner}/${id.name} is not owned by ${allowlist.org}` };
  const entry = allowlist.repositories.find((r) => r.name.toLowerCase() === id.name.toLowerCase());
  if (!entry) return { ok: false, reason: `${id.owner}/${id.name} is not in the QA repository allowlist` };
  if (!entry.enabled) return { ok: false, reason: `${id.owner}/${id.name} has QA disabled in the allowlist` };
  return { ok: true };
}

function git(root: string, args: string[]): string | undefined {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

function insideGitWorkTree(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** Conformance fixtures are loose folders in the temp directory, never a git work tree. */
export function isConformanceRoot(root: string, env: GateEnv): boolean {
  if (env.QA_CONFORMANCE !== '1') return false;
  // Compare real paths: on macOS the temp directory is /var/..., a link to /private/var/...;
  // on Windows it can be an 8.3 short name.
  let rel: string;
  try {
    rel = relative(realpathSync.native(tmpdir()), realpathSync.native(root));
  } catch {
    return false;
  }
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return !insideGitWorkTree(root);
}

function githubActionsIdentity(env: GateEnv): GateDecision | RepoIdentity {
  const repository = env.GITHUB_REPOSITORY ?? '';
  const parts = repository.split('/');
  if (parts.length !== 2 || !parts.every((p) => SEGMENT.test(p)))
    return { run: false, failClosed: true, reason: 'GITHUB_REPOSITORY is missing or malformed' };
  const id = { owner: parts[0], name: parts[1] };
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf8')) as {
        repository?: { fork?: boolean; full_name?: string };
        pull_request?: { head?: { repo?: { full_name?: string; fork?: boolean } | null } };
      };
      const eventRepo = event.repository?.full_name;
      if (eventRepo && eventRepo.toLowerCase() !== repository.toLowerCase())
        return { run: false, failClosed: true, reason: 'GITHUB_REPOSITORY disagrees with the event payload' };
      // A pull request from a fork runs in the base repository's context.
      const head = event.pull_request?.head?.repo;
      if (event.pull_request && !head)
        return { run: false, failClosed: true, reason: 'the pull request head repository cannot be determined' };
      if (head?.fork === true || (head?.full_name && head.full_name.toLowerCase() !== repository.toLowerCase()))
        return { run: false, reason: `${repository}: pull requests from forks do not run QA`, repo: id };
      if (event.repository?.fork === true) return { run: false, reason: `${repository} is a fork`, repo: id };
    } catch {
      return { run: false, failClosed: true, reason: 'the GitHub event payload cannot be read' };
    }
  }
  return id;
}

/**
 * The real path of `p`. For a path that does not exist (yet), the real path
 * of its nearest existing ancestor plus the rest, so /var/x/new on macOS
 * (/var is a link to /private/var) and C:\Users\RUNNER~1\new on Windows (an
 * 8.3 short name) compare equal to their resolved spellings.
 */
export function realOrResolved(p: string): string {
  let current = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/** True when `inner` is `outer` or a folder below it (real paths, case-insensitive on Windows). */
export function isWithin(inner: string, outer: string): boolean {
  const norm = (p: string): string =>
    process.platform === 'win32' ? realOrResolved(p).toLowerCase() : realOrResolved(p);
  const rel = relative(norm(outer), norm(inner));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Configuration trust (issue #15): the policies, allowlist and rules come
 * from the installed qa package, never from the repository being checked.
 * Returns why a configuration directory may not be used for `root`, or
 * undefined when it may.
 *
 * - A directory named by --config or QA_CONFIG_DIR inside the repository is
 *   refused everywhere: a pull request could otherwise switch checks off.
 * - In GitHub Actions, --config and QA_CONFIG_DIR are refused altogether: CI
 *   validates with the configuration released with qa, independently of
 *   anything the repository or its workflow says.
 * Conformance fixtures (loose folders in the temp directory) are exempt.
 */
export function configSourceProblem(
  config: { dir: string; origin: 'flag' | 'env' | 'bundled' | 'checkout' },
  root: string,
  env: GateEnv = process.env,
): string | undefined {
  if (config.origin !== 'flag' && config.origin !== 'env') return undefined;
  if (isConformanceRoot(root, env)) return undefined;
  const named = config.origin === 'flag' ? '--config' : 'QA_CONFIG_DIR';
  if (isWithin(config.dir, root))
    return `${named} points inside the repository being checked (${config.dir}); qa uses the configuration released with it`;
  if (env.GITHUB_ACTIONS === 'true')
    return `${named} is not accepted in GitHub Actions; CI checks with the configuration released with qa`;
  return undefined;
}

/** Decide whether the engine may run for the repository at `root`. */
export function gate(
  allowlist: RepositoryAllowlist,
  root: string,
  env: GateEnv = process.env,
  resolveSshHost: SshHostResolver = sshHostname,
): GateDecision {
  // Conformance fixtures run in CI too (GitHub Actions included), so this comes first.
  if (isConformanceRoot(root, env)) return { run: true, repo: { owner: allowlist.org, name: 'conformance' } };

  if (env.GITHUB_ACTIONS === 'true') {
    const id = githubActionsIdentity(env);
    if ('run' in id) return id;
    const verdict = isAllowed(allowlist, id);
    return verdict.ok ? { run: true, repo: id } : { run: false, reason: verdict.reason, repo: id };
  }

  const failClosed = env.CI !== undefined && env.CI !== '' && env.CI !== 'false' && env.CI !== '0';
  const url = insideGitWorkTree(root) ? git(root, ['remote', 'get-url', 'origin']) : undefined;
  const id = url ? parseRemoteUrl(url, resolveSshHost) : undefined;
  if (!id) {
    const reason = url
      ? 'the origin remote is not a recognised GitHub owner/repository URL (github.com, or an SSH host alias for it)'
      : 'no git origin remote to verify the repository against';
    return failClosed ? { run: false, failClosed: true, reason } : { run: false, reason };
  }
  const verdict = isAllowed(allowlist, id);
  return verdict.ok ? { run: true, repo: id } : { run: false, reason: verdict.reason, repo: id };
}
