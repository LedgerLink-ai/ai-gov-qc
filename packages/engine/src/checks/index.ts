import type { CheckDefinition, Finding, RunContext } from '../types';
import { commitTrailer } from './commit-trailer';
import { contentLint } from './content-lint';
import { mcpAllowlist } from './mcp-allowlist';
import { prBranchName, prCommits, prDiffSize, testsCoverage } from './pr-rules';
import { protectedPaths } from './protected-paths';

export type NativeCheck = (ctx: RunContext, def: CheckDefinition) => Finding[] | Promise<Finding[]>;

/** Native checks by id. Every entry must be declared in checks.yaml, and vice versa. */
export const NATIVE_CHECKS: Record<string, NativeCheck> = {
  'ai-config.content-lint': contentLint,
  'ai-config.mcp-allowlist': mcpAllowlist,
  'paths.protected': protectedPaths,
  'commit.trailer': commitTrailer,
  'pr.branch-name': prBranchName,
  'pr.commits': prCommits,
  'pr.diff-size': prDiffSize,
  'tests.coverage': testsCoverage,
};
