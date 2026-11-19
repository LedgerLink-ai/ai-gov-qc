import picomatch from 'picomatch';
import type { PathTags, Tag } from './types';

const MATCH_OPTIONS = { dot: true } as const;

export type Matcher = (path: string) => boolean;

/**
 * A matcher for any of `globs`. `nocase` ignores case, for paths whose
 * protection must not depend on how a file system or a change spells them
 * (protected paths: .GitHub/Workflows/x.yml on Windows and macOS is the same
 * file as .github/workflows/x.yml).
 */
export function globMatcher(globs: string[], opts: { nocase?: boolean } = {}): Matcher {
  if (globs.length === 0) return () => false;
  return picomatch(globs, opts.nocase ? { ...MATCH_OPTIONS, nocase: true } : MATCH_OPTIONS);
}

/** The globs path-tags.yaml lists for `repo`, matching the name ignoring case as GitHub does. */
function reposGlobs(paths: Record<string, string[]>, repo: string): string[] {
  const key = repo.toLowerCase();
  return Object.entries(paths)
    .filter(([name]) => name !== '*' && name.toLowerCase() === key)
    .flatMap(([, globs]) => globs);
}

/**
 * Tags for one repository: each tag combines its `*` globs and the globs listed
 * under this repository's name.
 */
export function tagMatchers(
  pathTags: PathTags,
  repo: string,
): Array<{ tag: Tag; onlyIfUntagged: boolean; match: Matcher }> {
  return Object.entries(pathTags.tags).map(([tag, def]) => ({
    tag,
    onlyIfUntagged: def.only_if_untagged === true,
    match: globMatcher([...(def.paths['*'] ?? []), ...reposGlobs(def.paths, repo)]),
  }));
}

export function resolveTags(pathTags: PathTags, repo: string, files: string[]): Map<string, Set<Tag>> {
  const matchers = tagMatchers(pathTags, repo);
  const result = new Map<string, Set<Tag>>();
  for (const file of files) {
    const tags = new Set<Tag>();
    for (const m of matchers) if (!m.onlyIfUntagged && m.match(file)) tags.add(m.tag);
    if (tags.size === 0) for (const m of matchers) if (m.onlyIfUntagged && m.match(file)) tags.add(m.tag);
    result.set(file, tags);
  }
  return result;
}
