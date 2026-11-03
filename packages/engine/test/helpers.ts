import { resolve } from 'node:path';
import { loadConfig } from '../src/config';
import type { RunOptions } from '../src/runner';
import type { ChangedFile, Config, FileSource } from '../src/types';

export const CONFIG_DIR = resolve(__dirname, '..', '..', '..');

let cached: Config | undefined;
export function config(): Config {
  cached ??= loadConfig(CONFIG_DIR);
  return cached;
}

export function memorySource(files: Record<string, string>): FileSource {
  return { kind: 'dir', root: '/memory', read: (p) => files[p] };
}

export function options(files: Record<string, string>, overrides: Partial<RunOptions> = {}): RunOptions {
  const changedFiles: ChangedFile[] = Object.keys(files).map((path) => ({ path, status: 'A' }));
  return {
    config: config(),
    repo: 'link_core',
    sha: 'test',
    root: '/memory',
    actor: 'human',
    mode: 'ci',
    asOf: '2027-01-08',
    changedFiles,
    source: memorySource(files),
    exclude: ['secrets.gitleaks', 'sast.semgrep'],
    ...overrides,
  };
}
