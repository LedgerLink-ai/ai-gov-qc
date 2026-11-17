import { globMatcher } from './tags';
import type { ConventionsPolicy, Policy } from './types';

// Ticket-based branch names and commit messages (AIQC-87, GitHub issue 10).
//
// A branch is named <type>/<TICKET-123>-<short-description>, e.g.
// feature/LCORE-1234-user-authentication. The ticket key and the commit type
// come from the branch, never from the commit message: the prepare-commit-msg
// hook writes them into the subject ("feat(LCORE-1234): "), the pre-commit
// hook refuses a branch without a valid key, and the commit-msg hook checks
// that the subject carries the branch's key. Everything is configured in the
// `conventions` section of policy.yaml, per repository under
// `conventions.repos.<name>`, accepted ticket projects included
// (`ticket_projects`).

export interface Conventions {
  /** A ticket key, without anchors. */
  ticketPattern: string;
  /** Accepted ticket projects (the key without its number); empty accepts any. */
  ticketProjects: string[];
  /** Branch type to commit type, e.g. bugfix -> fix. */
  branchTypes: Record<string, string>;
  commitTypes: string[];
  /** Subject prefix with {type} and {ticket}. */
  commitTemplate: string;
  exemptBranches: string[];
}

export const DEFAULT_CONVENTIONS: Conventions = {
  ticketPattern: '[A-Z][A-Z0-9]+-\\d+',
  ticketProjects: [],
  branchTypes: {
    feature: 'feat',
    feat: 'feat',
    bugfix: 'fix',
    fix: 'fix',
    hotfix: 'hotfix',
    chore: 'chore',
    docs: 'docs',
    refactor: 'refactor',
    test: 'test',
    ci: 'ci',
    perf: 'perf',
    build: 'build',
  },
  commitTypes: ['feat', 'fix', 'hotfix', 'chore', 'docs', 'refactor', 'test', 'ci', 'perf', 'build', 'style', 'revert'],
  commitTemplate: '{type}({ticket}): ',
  exemptBranches: [],
};

const fromPolicy = (c: Omit<ConventionsPolicy, 'repos'> | undefined): Partial<Conventions> => {
  const out: Partial<Conventions> = {};
  if (c?.ticket_pattern !== undefined) out.ticketPattern = c.ticket_pattern;
  if (c?.ticket_projects !== undefined) out.ticketProjects = c.ticket_projects;
  if (c?.branch_types !== undefined) out.branchTypes = c.branch_types;
  if (c?.commit_types !== undefined) out.commitTypes = c.commit_types;
  if (c?.commit_template !== undefined) out.commitTemplate = c.commit_template;
  if (c?.exempt_branches !== undefined) out.exemptBranches = c.exempt_branches;
  return out;
};

/** The override for a repository; names compare without case, as GitHub's do (and qa validate's). */
export function byRepo<T>(repos: Record<string, T> | undefined, repo: string): T | undefined {
  return Object.entries(repos ?? {}).find(([name]) => name.toLowerCase() === repo.toLowerCase())?.[1];
}

/** The conventions for this repository: the defaults, then policy.yaml `conventions`, then `conventions.repos.<repo>`. */
export function conventionsFor(policy: Policy, repo: string): Conventions {
  const c = policy.conventions;
  return {
    ...DEFAULT_CONVENTIONS,
    ...fromPolicy(c),
    ...fromPolicy(byRepo(c?.repos, repo)),
  };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const typeAlternation = (types: string[]): string =>
  [...types]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');

/** The project of a ticket key: LCORE-1234 gives LCORE. */
export const ticketProject = (key: string): string => key.replace(/-\d+$/, '');

/** A branch name that is a plain word, for suggested names: "Fix the Login!" gives fix-the-login. */
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export type BranchAnalysis =
  | { ok: true; branch: string; type: string; commitType: string; ticket: string }
  | { ok: false; exempt: true; branch: string }
  | {
      ok: false;
      exempt?: false;
      branch: string;
      ruleId: 'no-ticket' | 'malformed-ticket' | 'unknown-project' | 'format';
      message: string;
      fixHint: string;
      /** A valid key found in a branch that is otherwise off-convention. */
      ticket?: string;
    };

/** The expected branch form, in words, with an example. */
export function branchForm(conv: Conventions): string {
  const types = Object.keys(conv.branchTypes);
  const first = types.includes('feature') ? 'feature' : (types[0] ?? 'feature');
  return `<type>/<TICKET-123>-<short-description>, e.g. ${first}/LCORE-1234-user-authentication (types: ${types.join(', ')})`;
}

/**
 * Reads the type and ticket key from a branch name, or says what is wrong
 * with it. "HEAD" (detached) is reported by the caller; it never gets here.
 */
export function analyseBranch(branch: string, conv: Conventions): BranchAnalysis {
  if (conv.exemptBranches.length > 0 && globMatcher(conv.exemptBranches)(branch))
    return { ok: false, exempt: true, branch };
  const types = Object.keys(conv.branchTypes);
  const key = `(?:${conv.ticketPattern})`;
  const fail = (
    ruleId: 'no-ticket' | 'malformed-ticket' | 'unknown-project' | 'format',
    message: string,
    fixHint: string,
    ticket?: string,
  ): BranchAnalysis => ({ ok: false, branch, ruleId, message, fixHint, ...(ticket ? { ticket } : {}) });
  // A rename that only changes case needs -M on a case-insensitive file system
  // (Windows, macOS), where -m says the branch already exists.
  const rename = (name: string): string =>
    `Rename the branch: git branch ${name.toLowerCase() === branch.toLowerCase() ? '-M' : '-m'} ${name}`;
  const defaultType = types.includes('feature') ? 'feature' : (types[0] ?? 'feature');

  const m = new RegExp(`^(${typeAlternation(types)})/(${key})(?:[-_.](.*))?$`).exec(branch);
  if (m) {
    const [, type, ticket] = m;
    if (conv.ticketProjects.length > 0 && !conv.ticketProjects.includes(ticketProject(ticket)))
      return fail(
        'unknown-project',
        `Branch "${branch}" names ticket ${ticket}, but ${ticketProject(ticket)} is not an accepted ticket project here (${conv.ticketProjects.join(', ')}).`,
        `Use a ticket from ${conv.ticketProjects.join(', ')}. ${rename(`${type}/<TICKET-123>-<short-description>`)}`,
        ticket,
      );
    return { ok: true, branch, type, commitType: conv.branchTypes[type], ticket };
  }

  // What is wrong with it, so the message can say how to fix it.
  const slash = branch.indexOf('/');
  const prefix = slash === -1 ? undefined : branch.slice(0, slash);
  const typeForName = prefix && types.includes(prefix) ? prefix : defaultType;
  const rest = slash === -1 ? branch : branch.slice(slash + 1);

  const valid = new RegExp(`(?:^|[/_.-])(${key})(?=$|[-_./])`).exec(branch);
  if (valid) {
    const ticket = valid[1];
    const description = slugify(branch.slice(valid.index + valid[0].length)) || 'short-description';
    const suggestion = `${typeForName}/${ticket}-${description}`;
    const why =
      prefix && !types.includes(prefix)
        ? `"${prefix}" is not a branch type`
        : prefix
          ? 'the ticket key must come right after the type'
          : 'it has no type';
    return fail(
      'format',
      `Branch "${branch}" carries ticket ${ticket} but is not named ${branchForm(conv)}: ${why}.`,
      rename(suggestion),
      ticket,
    );
  }

  // Something that looks like a ticket key but is not one: ll-1234, LL1234, LL_1234.
  const loose = /^([A-Za-z][A-Za-z0-9]*?)[-_]?(\d+)(?=$|[-_.])/.exec(rest);
  if (loose) {
    const candidate = `${loose[1].toUpperCase()}-${loose[2]}`;
    if (new RegExp(`^${key}$`).test(candidate)) {
      const description = slugify(rest.slice(loose[0].length)) || 'short-description';
      return fail(
        'malformed-ticket',
        `"${loose[0]}" in branch "${branch}" is not a valid ticket key: a key is the project key in capitals, a hyphen and the number, e.g. ${candidate}.`,
        rename(`${typeForName}/${candidate}-${description}`),
      );
    }
  }

  return fail(
    'no-ticket',
    `Branch "${branch}" has no ticket key. Commits need a branch named ${branchForm(conv)}.`,
    `${rename(`${typeForName}/<TICKET-123>-${slugify(rest) || 'short-description'}`)}, or, on a shared branch such as main, start one for the work (staged changes come along): git switch -c ${typeForName}/<TICKET-123>-<short-description>`,
  );
}

// ---- Commit subjects ----

/** The subject prefix for this type and ticket: "feat(LCORE-1234): ". */
export const subjectPrefix = (conv: Conventions, type: string, ticket: string): string =>
  conv.commitTemplate.replace('{type}', type).replace('{ticket}', ticket);

/** The convention in words: "<type>(<TICKET-123>): <description>". */
export const subjectForm = (conv: Conventions): string =>
  `${subjectPrefix(conv, '<type>', '<TICKET-123>')}<description>`;

export const templateHasType = (conv: Conventions): boolean => conv.commitTemplate.includes('{type}');

/** The regular expression a subject must match, from the template. */
export function subjectRegex(conv: Conventions): RegExp {
  const parts = conv.commitTemplate.split(/(\{type\}|\{ticket\})/);
  const body = parts
    .map((p) =>
      p === '{type}'
        ? `(?<type>${typeAlternation(conv.commitTypes)})`
        : p === '{ticket}'
          ? `(?<ticket>${conv.ticketPattern})`
          : escapeRe(p),
    )
    .join('');
  return new RegExp(`^${body}(?<description>\\S.*)$`);
}

export interface ParsedSubject {
  type?: string;
  ticket: string;
  description: string;
}

export function parseSubject(subject: string, conv: Conventions): ParsedSubject | undefined {
  const g = subjectRegex(conv).exec(subject.trim())?.groups;
  if (!g) return undefined;
  return { ...(g.type ? { type: g.type } : {}), ticket: g.ticket, description: g.description };
}

/** Problems with a commit_template, for "qa validate". */
export function templateProblems(template: string): string[] {
  const problems: string[] = [];
  const count = (p: string): number => template.split(p).length - 1;
  if (count('{ticket}') !== 1) problems.push('must contain {ticket} exactly once');
  if (count('{type}') > 1) problems.push('may contain {type} at most once');
  return problems;
}
