import type { CheckDefinition, Finding, PrRepoOverride, PrSection, RunContext } from '../types';

// Checks on the pull request's own text (scope pr-text): its title, its ticket
// reference and its description. They run in the PR gate, where the title and
// description come from GitHub's event payload, and in "qa prepr" or "qa check"
// when they are passed with --pr-title and --pr-body-file. The conventions come
// from the `pr` section of policy.yaml, overridden per repository under
// `pr.repos.<name>` (AIQC-86).

/** A ticket key: a Jira project key, a hyphen, a number (LCORE-212). */
const TICKET_KEY = /\b([A-Z][A-Z0-9]+)-\d+\b/g;
/** A link to a ticket on any site: https://<site>/browse/LCORE-212. */
const TICKET_LINK = /https?:\/\/[^\s<>()[\]"']+?\/browse\/([A-Z][A-Z0-9]+-\d+)\b/g;
const MAX_QUOTED = 120;

export const DEFAULT_PR_SECTIONS: PrSection[] = [
  { name: 'Summary' },
  { name: 'Ticket', aliases: ['Linked ticket'] },
  { name: 'Changes' },
  { name: 'Testing', aliases: ['How it was tested'] },
  { name: 'Security Impact' },
  { name: 'Checklist', aliases: ['Security checklist'], checklist: true },
];

export interface PrTextPolicy {
  title_pattern: string;
  title_example: string;
  ticket_projects: string[];
  ticket_url?: string;
  description_sections: PrSection[];
}

const DEFAULTS: PrTextPolicy = {
  title_pattern: '^[A-Z][A-Z0-9]+-\\d+: \\S',
  title_example: '"<TICKET-123>: <short description>", e.g. "LCORE-212: Add idempotency key to refund endpoint"',
  ticket_projects: [],
  description_sections: DEFAULT_PR_SECTIONS,
};

const defined = (o: PrRepoOverride | undefined): PrRepoOverride =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as PrRepoOverride;

/** The conventions for this repository: the defaults, then policy.yaml `pr`, then `pr.repos.<repo>`. */
export function prTextPolicy(ctx: RunContext): PrTextPolicy {
  const pr = ctx.config.policy.pr;
  const global = defined({
    title_pattern: pr?.title_pattern,
    title_example: pr?.title_example,
    ticket_projects: pr?.ticket_projects,
    ticket_url: pr?.ticket_url,
    description_sections: pr?.description_sections,
  });
  return { ...DEFAULTS, ...global, ...defined(pr?.repos?.[ctx.repo]) };
}

const quote = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_QUOTED ? `${one.slice(0, MAX_QUOTED - 3)}...` : one;
};

function finding(def: CheckDefinition, ruleId: string, message: string, fixHint: string, basis: string): Finding {
  return { checkId: def.id, ruleId, level: 'error', message, fixHint, fingerprintBasis: `${ruleId}:${basis}` };
}

// ---- Title ----

/** The title follows the configured convention. */
export function prTitle(ctx: RunContext, def: CheckDefinition): Finding[] {
  if (!ctx.prText) return [];
  const policy = prTextPolicy(ctx);
  const title = ctx.prText.title.trim();
  if (!title)
    return [finding(def, 'missing', 'The pull request has no title.', `Use the form ${policy.title_example}.`, '')];
  if (new RegExp(policy.title_pattern).test(title)) return [];
  return [
    finding(
      def,
      'format',
      `The title "${quote(title)}" does not follow the pull request convention.`,
      `Edit the title to the form ${policy.title_example}.`,
      title,
    ),
  ];
}

// ---- Description ----

export interface Section {
  heading: string;
  level: number;
  content: string;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;

/** The description without HTML comments, which templates use for guidance. */
export const withoutComments = (body: string): string => body.replace(/<!--[\s\S]*?(?:-->|$)/g, '');

/** A heading compared without case, emphasis, trailing colons or extra spaces. */
export const normaliseHeading = (heading: string): string =>
  heading
    .replace(/[*_`]/g, '')
    .replace(/[\s:.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * The Markdown sections of a description, by ATX heading (## Summary). A
 * section runs to the next heading of the same or a higher level, so it
 * includes its own sub-headings. Headings inside code fences are text.
 */
export function parseSections(body: string): Section[] {
  const sections: Array<{ heading: string; level: number; lines: string[] }> = [];
  const open: typeof sections = [];
  let inFence = false;
  for (const line of withoutComments(body).replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const m = inFence ? null : HEADING.exec(line);
    if (m) {
      const section = { heading: m[2], level: m[1].length, lines: [] as string[] };
      while (open.length > 0 && open[open.length - 1].level >= section.level) open.pop();
      for (const parent of open) parent.lines.push(line);
      open.push(section);
      sections.push(section);
    } else {
      for (const s of open) s.lines.push(line);
    }
  }
  return sections.map((s) => ({ heading: s.heading, level: s.level, content: s.lines.join('\n') }));
}

/** Text a person wrote: without empty list items, unticked empty boxes, rules and blank lines. */
export function meaningful(content: string): string {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !/^([-*+]|\d+[.)])?\s*(\[[ xX]\])?\s*$/.test(l) && !/^([-*_]\s*){3,}$/.test(l))
    .join('\n')
    .trim();
}

const TASK_ITEM = /^\s*([-*+]|\d+[.)])\s+\[[ xX]\]\s+\S/m;

/** The section named `want` (or one of its aliases), first match. */
function findSection(sections: Section[], want: PrSection): Section | undefined {
  const names = [want.name, ...(want.aliases ?? [])].map(normaliseHeading);
  return sections.find((s) => names.includes(normaliseHeading(s.heading)));
}

const accepted = (s: PrSection): string => [s.name, ...(s.aliases ?? [])].map((n) => `"## ${n}"`).join(' or ');

/** The description follows the template: every required section present and filled in. */
export function prDescription(ctx: RunContext, def: CheckDefinition): Finding[] {
  if (!ctx.prText) return [];
  const policy = prTextPolicy(ctx);
  const template = 'Copy the repository pull request template (templates/pull_request_template.md in ai-gov-qc)';
  if (!meaningful(withoutComments(ctx.prText.body)))
    return [
      finding(
        def,
        'empty',
        'The pull request has no description.',
        `${template} into the description and fill in every section.`,
        '',
      ),
    ];
  const sections = parseSections(ctx.prText.body);
  const findings: Finding[] = [];
  for (const want of policy.description_sections) {
    const found = findSection(sections, want);
    if (!found) {
      findings.push(
        finding(
          def,
          'missing-section',
          `The description has no "${want.name}" section.`,
          `Add a heading ${accepted(want)} and fill it in. ${template}.`,
          want.name,
        ),
      );
      continue;
    }
    const text = meaningful(found.content);
    if (!text) {
      findings.push(
        finding(
          def,
          'empty-section',
          `The "${want.name}" section of the description is empty.`,
          `Write the ${want.name.toLowerCase()} under its heading; the template's comments are not counted.`,
          want.name,
        ),
      );
      continue;
    }
    if (want.checklist && !TASK_ITEM.test(found.content))
      findings.push(
        finding(
          def,
          'no-checklist',
          `The "${want.name}" section has no checklist items.`,
          'Keep the template checklist ("- [ ] ..." items) in this section, and do not delete or reword the items.',
          want.name,
        ),
      );
  }
  return findings;
}

// ---- Ticket reference ----

const projectOf = (key: string): string => key.slice(0, key.lastIndexOf('-'));

/**
 * A valid ticket reference: a key in the title or in the Ticket section of the
 * description (a key or a link to it), from an accepted project. Ticket links
 * anywhere in the description must point to the configured ticket site.
 */
export function prTicket(ctx: RunContext, def: CheckDefinition): Finding[] {
  if (!ctx.prText) return [];
  const policy = prTextPolicy(ctx);
  const { title, body } = ctx.prText;
  const ticketSpec = policy.description_sections.find((s) => normaliseHeading(s.name) === 'ticket') ?? {
    name: 'Ticket',
    aliases: ['Linked ticket'],
  };
  const ticketSection = findSection(parseSections(body), ticketSpec);
  const projects = new Set(policy.ticket_projects);
  const findings: Finding[] = [];

  // Links first: every ticket link in the description must point at the ticket site.
  const text = withoutComments(body);
  if (policy.ticket_url) {
    const site = policy.ticket_url.toLowerCase();
    const seen = new Set<string>();
    for (const m of text.matchAll(TICKET_LINK)) {
      const url = m[0];
      if (url.toLowerCase().startsWith(site) || seen.has(url)) continue;
      seen.add(url);
      findings.push(
        finding(
          def,
          'link-site',
          `The ticket link ${quote(url)} does not point to the ticket site ${policy.ticket_url}.`,
          `Link the ticket as ${policy.ticket_url}${m[1]}, or write just the key ${m[1]}.`,
          url,
        ),
      );
    }
  }

  // Keys: in the title and in the Ticket section (keys elsewhere, such as SHA-256, are not tickets).
  const sources = [title, ticketSection ? ticketSection.content : ''];
  const keys = new Set<string>();
  for (const s of sources) for (const m of s.matchAll(TICKET_KEY)) keys.add(m[0]);
  for (const m of text.matchAll(TICKET_LINK)) keys.add(m[1]);

  const valid = [...keys].filter((k) => projects.size === 0 || projects.has(projectOf(k)));
  if (valid.length > 0) return findings;

  const allowed = projects.size > 0 ? ` from ${[...projects].sort().join(', ')}` : '';
  if (keys.size > 0) {
    const found = [...keys].sort().join(', ');
    findings.push(
      finding(
        def,
        'unknown-project',
        `The ticket reference ${found} is not from an accepted project${allowed}.`,
        `Reference the ticket this change belongs to: a key${allowed}, in the title and in the "${ticketSpec.name}" section.`,
        found,
      ),
    );
    return findings;
  }
  findings.push(
    finding(
      def,
      'missing',
      'The pull request does not reference a ticket.',
      `Put the ticket key${allowed} (e.g. LCORE-212) at the start of the title and in the "${ticketSpec.name}" section of the description.`,
      '',
    ),
  );
  return findings;
}
