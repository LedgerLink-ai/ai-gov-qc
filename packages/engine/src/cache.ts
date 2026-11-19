import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { qaHome } from './tools-home';
import type { Finding } from './types';
import { ENGINE_VERSION } from './version';

/**
 * Per-file results of scanner checks, so an unchanged file is not scanned
 * again on the next commit or push. The key covers everything that can change
 * a result: engine version, check, scanner and its version, the scanner's rule
 * files, the file's path and its exact content. A damaged or unreadable entry
 * is a miss, never an error. Used locally only: CI always scans afresh.
 *
 *   QA_CACHE_DIR    where entries live (default <qa home>/cache)
 *   QA_NO_CACHE=1   switch it off (or --no-cache)
 */

const LAYOUT = 'v1';

export interface ResultCache {
  readonly dir: string;
  get(key: string): Finding[] | undefined;
  set(key: string, findings: Finding[]): void;
  stats: { hits: number; misses: number; writes: number };
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.QA_CACHE_DIR || join(qaHome(), 'cache'), LAYOUT);
}

export function cacheKey(parts: {
  checkId: string;
  tool: string;
  toolVersion: string;
  rulesHash: string;
  path: string;
  content: string;
}): string {
  return createHash('sha256')
    .update(
      [ENGINE_VERSION, parts.checkId, parts.tool, parts.toolVersion, parts.rulesHash, parts.path, parts.content].join(
        '\0',
      ),
    )
    .digest('hex');
}

function isFinding(x: unknown): x is Finding {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  return typeof f.checkId === 'string' && typeof f.message === 'string' && typeof f.level === 'string';
}

export function openCache(dir: string = cacheDir()): ResultCache {
  const file = (key: string): string => join(dir, key.slice(0, 2), `${key}.json`);
  const stats = { hits: 0, misses: 0, writes: 0 };
  return {
    dir,
    stats,
    get(key) {
      try {
        const data = JSON.parse(readFileSync(file(key), 'utf8')) as { key?: string; findings?: unknown };
        if (data.key !== key || !Array.isArray(data.findings) || !data.findings.every(isFinding)) throw new Error();
        stats.hits++;
        return data.findings;
      } catch {
        stats.misses++;
        return undefined;
      }
    },
    set(key, findings) {
      try {
        const target = file(key);
        mkdirSync(dirname(target), { recursive: true });
        // Write then rename, so a concurrent reader never sees half a file.
        const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
        writeFileSync(tmp, JSON.stringify({ key, findings }));
        renameSync(tmp, target);
        stats.writes++;
      } catch {
        // A cache that cannot be written only costs time.
      }
    },
  };
}

/** Removes every cached result. */
export function clearCache(dir: string = cacheDir()): void {
  rmSync(dir, { recursive: true, force: true });
}
