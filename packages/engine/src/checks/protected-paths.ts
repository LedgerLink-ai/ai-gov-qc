import { globMatcher } from '../tags';
import type { CheckDefinition, Finding, RunContext } from '../types';

// C15-4 / R11-6: agents must not change CI, CODEOWNERS, production or key
// paths. Humans may, and the change then needs code-owner review.

export function protectedPaths(ctx: RunContext, def: CheckDefinition): Finding[] {
  const { tags, globs } = ctx.config.policy.protected;
  const matchGlob = globMatcher(globs);
  const findings: Finding[] = [];

  for (const file of ctx.changedFiles) {
    const fileTags = ctx.fileTags.get(file.path) ?? new Set<string>();
    const byTag = tags.filter((t) => fileTags.has(t));
    if (byTag.length === 0 && !matchGlob(file.path)) continue;
    const why = byTag.length > 0 ? `tagged ${byTag.join(', ')}` : 'a key, secret or production path';
    const verb = file.status === 'D' ? 'deletes' : 'changes';

    findings.push(
      ctx.actor === 'agent'
        ? {
            checkId: def.id,
            ruleId: 'agent-edit',
            level: 'error',
            path: file.path,
            message: `An agent ${verb} a protected path (${why}).`,
            fixHint: 'Agents must not edit this path. Stop and ask the developer to make this change.',
            fingerprintBasis: `agent:${verb}`,
          }
        : {
            checkId: def.id,
            ruleId: 'needs-owner-review',
            level: 'note',
            path: file.path,
            message: `This change ${verb === 'deletes' ? 'deletes' : 'touches'} a protected path (${why}).`,
            fixHint: 'The pull request needs a code-owner approval for this path.',
            fingerprintBasis: `human:${verb}`,
          },
    );
  }
  return findings;
}
