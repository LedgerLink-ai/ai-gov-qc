import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ChangedFile, RunContext } from '../../types';

/** Time limit for asking a tool its version. */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * Scanner configuration and ignore files a change must not bring into the
 * scan: Gitleaks and Semgrep read them from the directory they scan, so a
 * change could otherwise suppress its own findings. Compared ignoring case
 * (Windows and macOS file systems do).
 */
const SCANNER_CONTROL_FILES = new Set([
  '.gitleaksignore',
  '.gitleaks.toml',
  '.semgrepignore',
  '.semgrep.yml',
  '.semgrep.yaml',
]);

/** True for a path the scanner work directory must never contain (see SCANNER_CONTROL_FILES). */
export function isScannerControlFile(path: string): boolean {
  const segments = path.toLowerCase().split(/[\\/]/);
  return SCANNER_CONTROL_FILES.has(segments[segments.length - 1]) || segments.slice(0, -1).includes('.semgrep');
}

/**
 * Copies exactly the content being checked (from the index for pre-commit, a
 * commit for pre-push) into a private temporary directory, runs `fn` on it and
 * removes it, so a scanner never sees anything else in the working tree and
 * never writes into it.
 *
 * Text is written as UTF-8 (a UTF-16 file decoded); a file that is not text
 * (binary, larger than the text limit) is copied as its raw bytes, so the
 * scanner still sees it. Scanner configuration and ignore files are never
 * copied (isScannerControlFile).
 */
export async function withCheckedFiles<T>(
  ctx: RunContext,
  prefix: string,
  files: ChangedFile[],
  fn: (work: string, src: string) => T | Promise<T>,
): Promise<T> {
  const work = mkdtempSync(join(tmpdir(), `qa-${prefix}-`));
  try {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    for (const file of files) {
      if (isScannerControlFile(file.path)) continue;
      const content: string | Buffer | undefined = ctx.source.read(file.path) ?? ctx.source.readBytes?.(file.path);
      if (content === undefined) continue;
      const target = resolve(src, file.path);
      // A path from git cannot climb out, but never write outside the work directory.
      if (relative(src, target).startsWith('..') || !target.startsWith(src + sep)) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return await fn(work, src);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** First x.y.z in a tool's version output, e.g. "v8.30.1" or "pre-commit 4.7.0". */
export function versionIn(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/**
 * The installed version of a tool, asked once per process and per binary:
 * starting some scanners (Semgrep is Python) takes seconds.
 */
export function cachedVersion(probe: () => string | undefined, key: () => string): () => string | undefined {
  const seen = new Map<string, string | undefined>();
  return () => {
    const k = key();
    if (!seen.has(k)) seen.set(k, probe());
    return seen.get(k);
  };
}

/** Every file under a rules directory (or the file itself), sorted. */
export function listRuleFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  };
  walk(path);
  return out.sort();
}

/** sha256 over the names and contents of `files`. */
export function hashFiles(files: string[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort()) {
    h.update(f.split(sep).pop() ?? f);
    h.update('\0');
    h.update(existsSync(f) ? readFileSync(f) : Buffer.alloc(0));
    h.update('\0');
  }
  return h.digest('hex');
}
