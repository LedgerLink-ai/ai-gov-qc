import { spawnSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { declaredTrailers, messageLines, toolForAlias } from './checks/commit-trailer';
import { NO_DEFAULT } from './prepare-message';
import { toPosix } from './sources';
import type { AiRegistry, CoverageSummary, PrCommit } from './types';

// Decisions "qa prepr" makes about the pull request as a whole, before the
// checks run: who made it, and which coverage summaries count.

const CO_AUTHOR = /^Co-authored-by:\s*(.*)$/i;

/**
 * Whether a commit message declares AI assistance: an Assisted-by trailer
 * (other than "none"), or a Co-authored-by line naming an AI tool of the
 * registry (by its trailer aliases, as commit.trailer recognises them).
 */
export function declaresAi(message: string, registry: AiRegistry): boolean {
  if (declaredTrailers(message).some((v) => v.trim().toLowerCase() !== NO_DEFAULT)) return true;
  return messageLines(message).some((line) => {
    const value = CO_AUTHOR.exec(line)?.[1];
    return value !== undefined && toolForAlias(registry, value) !== undefined;
  });
}

/** The commits of the pull request that declare AI assistance. */
export const aiDeclaredCommits = (commits: PrCommit[], registry: AiRegistry): PrCommit[] =>
  commits.filter((c) => declaresAi(c.message, registry));

/** Whether git tracks `file` (absolute, or relative to `root`) in the repository at `root`. */
export function trackedInGit(root: string, file: string): boolean {
  const rel = isAbsolute(file) ? toPosix(relative(root, file)) : file;
  const res = spawnSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: root, encoding: 'utf8' });
  return res.status === 0;
}

/**
 * In CI, coverage must come from the test run before qa, never from the pull
 * request: a coverage summary committed to the repository could claim any
 * number. Returns the summaries to use and the committed ones left out.
 */
export function ciCoverage(
  root: string,
  coverage: CoverageSummary[],
): { use: CoverageSummary[]; ignored: CoverageSummary[] } {
  const use: CoverageSummary[] = [];
  const ignored: CoverageSummary[] = [];
  for (const c of coverage) (trackedInGit(root, c.file) ? ignored : use).push(c);
  return { use, ignored };
}
