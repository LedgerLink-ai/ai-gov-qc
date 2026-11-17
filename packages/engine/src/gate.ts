import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
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

/**
 * Owner and name from a git remote URL (https, ssh, scp-like, git://), or
 * undefined for anything that is not a plain host/owner/repo form: local
 * paths, extra path segments, empty or odd characters.
 */
export function parseRemoteUrl(url: string): RepoIdentity | undefined {
  const text = url.trim();
  let path: string | undefined;
  const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/)(.+)$/.exec(text);
  if (scp) path = scp[1];
  else {
    const m = /^(?:https?|ssh|git):\/\/(?:[^/@\s]+@)?[A-Za-z0-9.-]+(?::\d+)?\/(.+)$/.exec(text);
    if (m) path = m[1];
  }
  if (path === undefined) return undefined;
  const parts = path
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/');
  if (parts.length !== 2 || !parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..')) return undefined;
  return { owner: parts[0], name: parts[1] };
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
function isConformanceRoot(root: string, env: GateEnv): boolean {
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

/** Decide whether the engine may run for the repository at `root`. */
export function gate(allowlist: RepositoryAllowlist, root: string, env: GateEnv = process.env): GateDecision {
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
  const id = url ? parseRemoteUrl(url) : undefined;
  if (!id) {
    const reason = url
      ? 'the origin remote is not a recognised GitHub owner/repository URL'
      : 'no git origin remote to verify the repository against';
    return failClosed ? { run: false, failClosed: true, reason } : { run: false, reason };
  }
  const verdict = isAllowed(allowlist, id);
  return verdict.ok ? { run: true, repo: id } : { run: false, reason: verdict.reason, repo: id };
}
