import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { ChangedFile, CoverageSummary, DiffStat, FileSource, PrCommit } from './types';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export const toPosix = (p: string): string => p.split(sep).join('/');

function decodeText(buf: Buffer): string | undefined {
  if (buf.length > MAX_TEXT_BYTES) return undefined;
  if (buf.subarray(0, 8000).includes(0)) return undefined;
  return buf.toString('utf8');
}

function git(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitText(cwd: string, args: string[]): string {
  return git(cwd, args).toString('utf8').trim();
}

export function gitRoot(cwd: string): string {
  return gitText(cwd, ['rev-parse', '--show-toplevel']);
}

export function gitHeadSha(root: string): string {
  try {
    return gitText(root, ['rev-parse', 'HEAD']);
  } catch {
    return 'UNBORN';
  }
}

/** Repository name from the origin remote, else the folder name. */
export function gitRepoName(root: string): string {
  try {
    const url = gitText(root, ['remote', 'get-url', 'origin']);
    const name = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
    if (name) return name.replace(/\.git$/, '');
  } catch {
    // no origin remote
  }
  return basename(root);
}

function parseNameStatus(out: Buffer): ChangedFile[] {
  const parts = out
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      i++; // old path
      files.push({ path: parts[i++], status: letter === 'R' ? 'R' : 'A' });
    } else {
      files.push({ path: parts[i++], status: letter === 'A' || letter === 'D' ? letter : 'M' });
    }
  }
  return files;
}

export function gitStagedFiles(root: string): ChangedFile[] {
  return parseNameStatus(git(root, ['diff', '--cached', '--name-status', '-z', '-M']));
}

/** Files changed between the merge base of `base` and HEAD (what a PR contains). */
export function gitRangeFiles(root: string, base: string): ChangedFile[] {
  return parseNameStatus(git(root, ['diff', '--name-status', '-z', '-M', `${base}...HEAD`]));
}

/** Files changed between two commits (what a push sends). */
export function gitDiffFiles(root: string, from: string, to: string): ChangedFile[] {
  return parseNameStatus(git(root, ['diff', '--name-status', '-z', '-M', from, to]));
}

/** Every file in a commit, as additions (a push with no remote ancestor). */
export function gitTreeFiles(root: string, ref: string): ChangedFile[] {
  return git(root, ['ls-tree', '-r', '-z', '--name-only', ref])
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0)
    .map((path) => ({ path, status: 'A' as const }));
}

/** Reads files as committed in `ref`, so pre-push checks what is pushed, not the work tree. */
export function commitSource(root: string, ref: string): FileSource {
  return {
    kind: 'commit',
    root,
    read(path) {
      try {
        return decodeText(git(root, ['show', `${ref}:${path}`]));
      } catch {
        return undefined;
      }
    },
  };
}

/** Reads staged content, so the check sees exactly what will be committed. */
export function indexSource(root: string): FileSource {
  return {
    kind: 'index',
    root,
    read(path) {
      try {
        return decodeText(git(root, ['show', `:${path}`]));
      } catch {
        return undefined;
      }
    },
  };
}

export function directorySource(root: string, kind: 'worktree' | 'dir' = 'dir'): FileSource {
  return {
    kind,
    root,
    read(path) {
      const full = join(root, path);
      if (!existsSync(full) || !statSync(full).isFile()) return undefined;
      return decodeText(readFileSync(full));
    },
  };
}

/** Every file under `root`, repository-relative with forward slashes. */
export function listFiles(root: string, skip: string[] = ['.git', 'node_modules', '.qa']): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(toPosix(relative(root, full)));
    }
  };
  walk(root);
  return out.sort();
}

/** Commits a pull request from HEAD would contain (merges excluded), oldest first. */
export function gitRangeCommits(root: string, base: string): PrCommit[] {
  return git(root, ['log', '--no-merges', '--reverse', '--format=%H%x00%B%x1e', `${base}..HEAD`])
    .toString('utf8')
    .split('\x1e')
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.includes('\0'))
    .map((r) => {
      const [sha, message] = r.split('\0');
      return { sha, message };
    });
}

/** Lines added and deleted per file since the merge base with `base`. */
export function gitRangeDiffStat(root: string, base: string): DiffStat[] {
  const parts = git(root, ['diff', '--numstat', '-z', '-M', `${base}...HEAD`])
    .toString('utf8')
    .split('\0');
  const stats: DiffStat[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    // A rename is written "added\tdeleted\t", then the old and the new path.
    const path = m[3] === '' ? parts[(i += 2)] : m[3];
    const binary = m[1] === '-';
    stats.push({ path, added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary });
  }
  return stats;
}

export function gitBranch(root: string): string {
  try {
    return gitText(root, ['symbolic-ref', '--short', 'HEAD']);
  } catch {
    return 'HEAD';
  }
}

const refExists = (root: string, ref: string): boolean => {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * The branch a pull request merges into: the remote's default branch
 * (origin/HEAD), else the first of origin/main, origin/master, origin/develop,
 * main, master that exists.
 */
export function defaultBase(root: string): string | undefined {
  try {
    const head = gitText(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head) return head;
  } catch {
    // origin/HEAD is not set
  }
  return ['origin/main', 'origin/master', 'origin/develop', 'main', 'master'].find((r) => refExists(root, r));
}

/** Line coverage from an Istanbul json-summary file, or undefined when it cannot be read. */
export function readCoverageSummary(file: string): CoverageSummary | undefined {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { total?: { lines?: { total?: unknown; pct?: unknown } } };
    const lines = data.total?.lines;
    if (typeof lines?.pct === 'number') return { file, linesPct: lines.pct };
    // A run that loaded no source files writes total 0 and pct "Unknown".
    return lines?.total === 0 ? { file } : undefined;
  } catch {
    return undefined;
  }
}
