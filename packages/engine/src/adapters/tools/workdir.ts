import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChangedFile, RunContext } from '../../types';

/**
 * Copies exactly the content being checked (from the index for pre-commit, a
 * commit for pre-push) into a private temporary directory, runs `fn` on it and
 * removes it, so a scanner never sees anything else in the working tree.
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
      const text = ctx.source.read(file.path);
      if (text === undefined) continue;
      const target = join(src, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
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
