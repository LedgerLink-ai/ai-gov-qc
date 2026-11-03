import picomatch from 'picomatch';
import type { PathTags, Tag } from './types';

const MATCH_OPTIONS = { dot: true } as const;

export type Matcher = (path: string) => boolean;

export function globMatcher(globs: string[]): Matcher {
  if (globs.length === 0) return () => false;
  return picomatch(globs, MATCH_OPTIONS);
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
    match: globMatcher([...(def.paths['*'] ?? []), ...(def.paths[repo] ?? [])]),
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
