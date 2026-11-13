import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { meaningful, normaliseHeading, parseSections } from '../src/checks/pr-text';
import { crossValidate } from '../src/config';
import { run } from '../src/runner';
import type { Config, Exemption, PrPolicy, PrText } from '../src/types';
import { CONFIG_DIR, config, options } from './helpers';

const TEMPLATE = readFileSync(join(CONFIG_DIR, 'templates', 'pull_request_template.md'), 'utf8');

const GOOD_BODY = `## Summary

Adds an idempotency key to POST /refunds so a retried request cannot issue
the same refund twice. Keys are stored for 24 hours, hashed with SHA-256.

## Ticket

LCORE-212

## Changes

- Idempotency key column and unique index
- Middleware that replays the stored response

## Testing

- Unit tests for the middleware
- Integration test for a retried refund

## Security Impact

None: no new inputs reach the ledger.

## Checklist

- [x] Coding conventions followed
- [x] Tests added or updated
- [ ] Documentation updated
- [x] No secrets committed
- [x] QA checks passed
`;

const GOOD: PrText = { title: 'LCORE-212: Add idempotency key to refund endpoint', body: GOOD_BODY };

/** The configuration with policy.yaml's pr section (and optionally check modes) changed. */
function withPolicy(pr: Partial<PrPolicy>, checks: Config['policy']['checks'] = {}): Config {
  const c = config();
  return {
    ...c,
    policy: {
      ...c.policy,
      pr: { ...(c.policy.pr as PrPolicy), ...pr },
      checks: { ...c.policy.checks, ...checks },
    },
  };
}

async function textFindings(prText: PrText, cfg: Config = config(), extra: { exemptions?: Exemption[] } = {}) {
  const c = extra.exemptions ? { ...cfg, exemptions: extra.exemptions } : cfg;
  const result = await run(options({}, { config: c, prText, stages: [3] }));
  return result.findings
    .filter((f) => f.checkId === 'pr.title' || f.checkId === 'pr.ticket' || f.checkId === 'pr.description')
    .map((f) => [f.checkId, f.ruleId, f.blocking]);
}

describe('pull request title, ticket and description (pr-text)', () => {
  it('pass a pull request that follows the conventions', async () => {
    expect(await textFindings(GOOD)).toEqual([]);
  });

  it('are skipped when the run has no title or description, saying how to give them', async () => {
    const result = await run(options({}, { stages: [3] }));
    const runs = result.checkRuns.filter((r) => ['pr.title', 'pr.ticket', 'pr.description'].includes(r.checkId));
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === 'skipped' && /--pr-title/.test(r.reason ?? ''))).toBe(true);
  });

  it('report, without blocking in report mode, a title that is empty or off-convention', async () => {
    expect(await textFindings({ ...GOOD, title: '  ' })).toEqual([['pr.title', 'missing', false]]);
    expect(await textFindings({ ...GOOD, title: 'Add idempotency key (LCORE-212)' })).toEqual([
      ['pr.title', 'format', false],
    ]);
    expect(await textFindings({ ...GOOD, title: 'lcore-212: lower-case key' })).toEqual([
      ['pr.title', 'format', false],
    ]);
  });

  it('block once the check is in block mode', async () => {
    const cfg = withPolicy({}, { 'pr.title': { mode: 'block' } });
    expect(await textFindings({ ...GOOD, title: 'fix stuff' }, cfg)).toEqual([['pr.title', 'format', true]]);
  });

  it('find the ticket in the title or in the Ticket section, as a key or a link', async () => {
    const noTitleKey = { ...GOOD, title: 'Add idempotency key' };
    expect(await textFindings(noTitleKey)).toEqual([['pr.title', 'format', false]]);
    const linked = GOOD_BODY.replace('LCORE-212', 'https://ledgerlink.atlassian.net/browse/LCORE-212');
    expect(await textFindings({ title: 'Add idempotency key', body: linked })).toEqual([['pr.title', 'format', false]]);
  });

  it('do not take keys elsewhere in the description, such as SHA-256, for a ticket', async () => {
    const body = GOOD_BODY.replace('LCORE-212', 'n/a');
    expect(await textFindings({ title: 'Add idempotency key', body })).toEqual([
      ['pr.title', 'format', false],
      ['pr.ticket', 'missing', false],
    ]);
  });

  it('accept only the configured projects, per repository', async () => {
    const onlyLwmng = withPolicy({ repos: { link_core: { ticket_projects: ['LWMNG'] } } });
    expect(await textFindings(GOOD, onlyLwmng)).toEqual([['pr.ticket', 'unknown-project', false]]);
    const lcore = withPolicy({ ticket_projects: ['LWMNG'], repos: { link_core: { ticket_projects: ['LCORE'] } } });
    expect(await textFindings(GOOD, lcore)).toEqual([]);
  });

  it('report ticket links that do not point to the ticket site', async () => {
    const body = GOOD_BODY.replace(
      '## Changes',
      'See https://other.atlassian.net/browse/LCORE-212 for the discussion.\n\n## Changes',
    );
    expect(await textFindings({ ...GOOD, body })).toEqual([['pr.ticket', 'link-site', false]]);
  });

  it('use a repository title convention over the default', async () => {
    const cfg = withPolicy({ repos: { link_core: { title_pattern: '^\\[[A-Z]+-\\d+\\] \\S' } } });
    expect(await textFindings({ ...GOOD, title: '[LCORE-212] Add idempotency key' }, cfg)).toEqual([]);
    expect(await textFindings(GOOD, cfg)).toEqual([['pr.title', 'format', false]]);
  });

  it('report an empty description once, not once per section', async () => {
    expect(await textFindings({ ...GOOD, body: '' })).toEqual([['pr.description', 'empty', false]]);
    expect(await textFindings({ ...GOOD, body: '<!-- only a comment -->\n\n' })).toEqual([
      ['pr.description', 'empty', false],
    ]);
  });

  it('report every section the untouched template leaves empty, but not its checklist', async () => {
    const findings = await textFindings({ ...GOOD, body: TEMPLATE });
    expect(findings.filter((f) => f[0] === 'pr.description')).toEqual([
      ['pr.description', 'empty-section', false],
      ['pr.description', 'empty-section', false],
      ['pr.description', 'empty-section', false],
      ['pr.description', 'empty-section', false],
      ['pr.description', 'empty-section', false],
    ]);
  });

  it('name each missing section', async () => {
    const body = GOOD_BODY.replace(/## Security Impact[\s\S]*?(?=## Checklist)/, '');
    const result = await run(options({}, { prText: { ...GOOD, body }, stages: [3] }));
    const own = result.findings.filter((f) => f.checkId === 'pr.description');
    expect(own.map((f) => f.ruleId)).toEqual(['missing-section']);
    expect(own[0].message).toMatch(/"Security Impact"/);
  });

  it('accept the developer rules headings as aliases, in any case and level, with a colon', async () => {
    const body = GOOD_BODY.replace('## Ticket', '### linked ticket:')
      .replace('## Testing', '## **How it was tested**')
      .replace('## Checklist', '## Security checklist');
    expect(await textFindings({ ...GOOD, body })).toEqual([]);
  });

  it('require checklist items in the Checklist section', async () => {
    const body = GOOD_BODY.replace(/## Checklist[\s\S]*$/, '## Checklist\n\nAll done.\n');
    expect(await textFindings({ ...GOOD, body })).toEqual([['pr.description', 'no-checklist', false]]);
  });

  it('let an unexpired exemption with path "*" cover a pull request finding, and not an expired one', async () => {
    const exemption = (expires: string): Exemption => ({
      id: 'EX-0001',
      check: 'pr.title',
      repo: 'link_core',
      path: '*',
      owner: 'owner',
      approved_by: 'approver',
      reason: 'Release pull requests are titled by the release job',
      expires,
    });
    const cfg = withPolicy({}, { 'pr.title': { mode: 'block' } });
    const bad = { ...GOOD, title: 'Release 1.4.0' };
    const active = await run(
      options({}, { config: { ...cfg, exemptions: [exemption('2027-12-31')] }, prText: bad, stages: [3] }),
    );
    expect(active.findings.filter((f) => f.checkId === 'pr.title').map((f) => [f.suppressedBy, f.blocking])).toEqual([
      ['exemption', false],
    ]);
    expect(active.exitCode).toBe(0);
    expect(await textFindings(bad, cfg, { exemptions: [exemption('2026-12-31')] })).toEqual([
      ['pr.title', 'format', true],
    ]);
  });
});

describe('pull request description parsing', () => {
  it('splits sections by heading, keeps sub-headings inside, and ignores headings in code fences', () => {
    const body = '## Summary\ntext\n### Detail\nmore\n```\n## Not a heading\n```\n## Ticket\nLCORE-1\n';
    const sections = parseSections(body);
    expect(sections.map((s) => s.heading)).toEqual(['Summary', 'Detail', 'Ticket']);
    expect(sections[0].content).toContain('more');
    expect(sections[0].content).toContain('## Not a heading');
    expect(sections[2].content.trim()).toBe('LCORE-1');
  });

  it('counts only text a person wrote', () => {
    expect(meaningful('<!-- x -->'.replace(/<!--[\s\S]*?-->/g, ''))).toBe('');
    expect(meaningful('-\n- [ ]\n1.\n---\n')).toBe('');
    expect(meaningful('- [ ] Tests added')).toBe('- [ ] Tests added');
    expect(normaliseHeading(' **Security Impact**: ')).toBe('security impact');
  });
});

describe('pull request conventions configuration', () => {
  it('rejects a title pattern that does not compile and an override for an unknown repository', () => {
    const c = withPolicy({ title_pattern: '([unclosed', repos: { not_a_repo: { ticket_projects: ['ABC'] } } });
    const problems = crossValidate(c).join('\n');
    expect(problems).toMatch(/pr\.title_pattern is not a valid regular expression/);
    expect(problems).toMatch(/pr\.repos\.not_a_repo is not a repository/);
  });
});
