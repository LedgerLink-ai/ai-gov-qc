import { globMatcher, resolveTags } from '../tags';
import type { CheckDefinition, Finding, RunContext } from '../types';

// C15-4 / R11-6: agents must not change CI, CODEOWNERS, production or key
// paths. Humans may, and the change then needs code-owner review.
//
// A rename is checked at both ends: moving a protected file away removes it
// from its protected path, as deleting it would. Globs ignore case, so a
// change cannot avoid them by spelling a path differently (Windows and macOS
// file systems treat .GitHub/workflows and .github/workflows as one folder).

type Verb = 'changes' | 'deletes' | 'moves/renames';

export function protectedPaths(ctx: RunContext, def: CheckDefinition): Finding[] {
  const { tags, globs } = ctx.config.policy.protected;
  const matchGlob = globMatcher(globs, { nocase: true });
  const oldPaths = ctx.changedFiles.filter((f) => f.status === 'R' && f.oldPath).map((f) => f.oldPath as string);
  const oldTags = oldPaths.length > 0 ? resolveTags(ctx.config.pathTags, ctx.repo, oldPaths) : new Map();
  const findings: Finding[] = [];

  const why = (path: string, fileTags: Set<string>): string | undefined => {
    const byTag = tags.filter((t) => fileTags.has(t));
    if (byTag.length > 0) return `tagged ${byTag.join(', ')}`;
    return matchGlob(path) ? 'a key, secret or production path' : undefined;
  };

  const report = (path: string, verb: Verb, reason: string, detail = ''): void => {
    findings.push(
      ctx.actor === 'agent'
        ? {
            checkId: def.id,
            ruleId: 'agent-edit',
            level: 'error',
            path,
            message: `An agent ${verb} a protected path (${reason})${detail}.`,
            fixHint: 'Agents must not edit this path. Stop and ask the developer to make this change.',
            fingerprintBasis: `agent:${verb}`,
          }
        : {
            checkId: def.id,
            ruleId: 'needs-owner-review',
            level: 'note',
            path,
            message: `This change ${verb === 'changes' ? 'touches' : verb} a protected path (${reason})${detail}.`,
            fixHint: 'The pull request needs a code-owner approval for this path.',
            fingerprintBasis: `human:${verb}`,
          },
    );
  };

  for (const file of ctx.changedFiles) {
    const reason = why(file.path, ctx.fileTags.get(file.path) ?? new Set<string>());
    if (reason) report(file.path, file.status === 'D' ? 'deletes' : 'changes', reason);
    if (file.status === 'R' && file.oldPath) {
      const oldReason = why(file.oldPath, oldTags.get(file.oldPath) ?? new Set<string>());
      if (oldReason) report(file.oldPath, 'moves/renames', oldReason, ` to ${file.path}`);
    }
  }
  return findings;
}
