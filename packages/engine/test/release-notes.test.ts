import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// AIQC-90: every release's notes come from templates/release-notes.md, and the
// pull request list leaves out pull requests reverted before the release.

interface PullRequest {
  number: number;
  title: string;
  line: string;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const release = require('../../../scripts/release.js') as {
  parsePullRequests: (text: string) => PullRequest[];
  withoutReverted: (prs: PullRequest[]) => {
    included: PullRequest[];
    reverted: (PullRequest & { revertedBy: number })[];
  };
  pullRequestSection: (generated?: string) => string;
  renderNotes: (
    version: string,
    opts?: { repo?: string; sha256?: string; pullRequests?: string; template?: string },
  ) => string;
};

const ROOT = join(__dirname, '..', '..', '..');
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const SHA = 'ab'.repeat(32);

/** GitHub's generated notes (releases/generate-notes API) for the given pull requests. */
function generated(...prs: [number, string][]): string {
  return [
    "## What's Changed",
    ...prs.map(([n, t]) => `* ${t} by @dev-1 in https://github.com/LedgerLink-ai/ai-gov-qc/pull/${n}`),
    '',
    '',
    '**Full Changelog**: https://github.com/LedgerLink-ai/ai-gov-qc/compare/v0.2.2...v0.2.3',
  ].join('\n');
}

const numbers = (prs: { number: number }[]): number[] => prs.map((p) => p.number);

describe('the release notes', () => {
  it('have every section, filled in for the version', () => {
    const notes = release.renderNotes(VERSION, { sha256: SHA, pullRequests: generated([5, 'Docs']) });
    for (const heading of [
      '## Requirements',
      '## What `qa setup` installs',
      '## Where qa is installed',
      '## Install',
      '### Windows (PowerShell)',
      '### macOS (Terminal, zsh)',
      '### Linux (bash)',
      '## Check the installation',
      '## Upgrade',
      '## Uninstall',
      '## Roll back',
      `## What's new in ${VERSION}`,
      '## Pull requests in this release',
    ])
      expect(notes).toContain(`\n${heading}\n`);
    expect(notes).not.toMatch(/\{\{/);
    expect(notes).toContain(`\`${SHA}\``);
    expect(notes).toContain(`gh release download v${VERSION} --repo LedgerLink-ai/ai-gov-qc`);
    expect(notes).toContain(`npm install -g --ignore-scripts ./ledgerlink-qa-${VERSION}.tgz`);
    expect(notes).toContain(`(#whats-new-in-${VERSION.replace(/\./g, '')})`);
  });

  it('take the pinned tool versions and the changelog section from the repository', () => {
    const notes = release.renderNotes(VERSION);
    const policy = readFileSync(join(ROOT, 'policy.yaml'), 'utf8');
    const gitleaks = /^ {2}gitleaks: '([^']+)'/m.exec(policy)?.[1];
    expect(notes).toMatch(new RegExp(`\\| Gitleaks +\\| ${gitleaks} `));
    expect(notes).toMatch(/\| pre-commit +\| \d+\.\d+\.\d+ /);
    expect(notes).toMatch(/\| Semgrep +\| \d+\.\d+\.\d+ /);
    expect(notes).toContain(`attached below`); // no SHA-256 given
    expect(notes).toContain('Listed on the release page when the release is published.');
  });

  it('use the repository they are released from', () => {
    expect(release.renderNotes(VERSION, { repo: 'acme/qa-fork' })).toContain('--repo acme/qa-fork');
    expect(() => release.renderNotes(VERSION, { repo: 'acme/qa; rm -rf /' })).toThrow(/not <owner>\/<name>/);
  });

  it('refuse an unknown version, a malformed SHA-256 and an unfilled placeholder', () => {
    expect(() => release.renderNotes('9.9.9')).toThrow(/no section for "9\.9\.9"/);
    expect(() => release.renderNotes(VERSION, { sha256: 'xyz' })).toThrow(/not a SHA-256/);
    expect(() => release.renderNotes(VERSION, { template: '{{version}} {{nope}} {{ nope }}' })).toThrow(
      /\{\{nope\}\} has no value/,
    );
  });
});

describe('the pull request list', () => {
  it('reads the pull requests from GitHub generated notes, bots included', () => {
    const text = `${generated([5, 'Docs (#8)'])}\n* Bump x by @dependabot[bot] in https://github.com/o/r/pull/31`;
    expect(release.parsePullRequests(text)).toEqual([
      expect.objectContaining({ number: 5, title: 'Docs (#8)' }),
      expect.objectContaining({ number: 31, title: 'Bump x' }),
    ]);
  });

  it('leaves out pull requests reverted before the release, and their revert (v0.2.3)', () => {
    const text = generated(
      [5, 'Update README status now that the repository is on GitHub'],
      [17, 'Restrict the QA engine to allowlisted LedgerLink-ai repositories (#8)'],
      [20, 'AIQC-86: Enforce standardized pull request conventions'],
      [21, 'AIQC-87: Enforce ticket-based branch naming and automatic commit message generation'],
      [22, 'Revert AIQC-86 (#20) and AIQC-87 (#21) from dev'],
      [23, 'AIQC-87: Enforce ticket-based branch naming and automatic commit message generation'],
      [24, 'Release qa 0.2.3'],
    );
    const { included, reverted } = release.withoutReverted(release.parsePullRequests(text));
    expect(numbers(included)).toEqual([5, 17, 23, 24]);
    expect(reverted.map((p) => [p.number, p.revertedBy])).toEqual([
      [20, 22],
      [21, 22],
    ]);
    const section = release.pullRequestSection(text);
    expect(section).not.toMatch(/pull\/(20|21|22)\b/);
    expect(section).toContain('**Not in this release.**');
    expect(section).toContain('* AIQC-86: Enforce standardized pull request conventions (#20), reverted by #22');
    expect(section).toMatch(/\*\*Full Changelog\*\*: \S+v0\.2\.2\.\.\.v0\.2\.3$/);
  });

  it("matches GitHub's revert button by title, the latest pull request of that title", () => {
    const { included, reverted } = release.withoutReverted(
      release.parsePullRequests(generated([10, 'Add x'], [11, 'Add x'], [12, 'Revert "Add x"'])),
    );
    expect(numbers(included)).toEqual([10]);
    expect(numbers(reverted)).toEqual([11]);
  });

  it('keeps a revert of something released earlier: it changes this release', () => {
    const { included, reverted } = release.withoutReverted(
      release.parsePullRequests(generated([30, 'Revert "Feature from 0.2.2"'], [31, 'Revert the hardening (#15)'])),
    );
    expect(numbers(included)).toEqual([30, 31]);
    expect(reverted).toEqual([]);
  });

  it('keeps a revert that also undoes something released earlier, and drops the part in this release', () => {
    const { included, reverted } = release.withoutReverted(
      release.parsePullRequests(generated([40, 'New check'], [41, 'Revert #40 and #12'])),
    );
    expect(numbers(included)).toEqual([41]);
    expect(numbers(reverted)).toEqual([40]);
  });

  it('brings a pull request back when its revert is reverted', () => {
    const { included, reverted } = release.withoutReverted(
      release.parsePullRequests(
        generated([50, 'Feature'], [51, 'Revert "Feature"'], [52, 'Revert "Revert "Feature""']),
      ),
    );
    expect(numbers(included)).toEqual([50]);
    expect(numbers(reverted)).toEqual([51]);
  });

  it('says so when there is no list yet, or nothing is left in it', () => {
    expect(release.pullRequestSection()).toBe('Listed on the release page when the release is published.');
    expect(release.pullRequestSection(generated([60, 'X'], [61, 'Revert #60']))).toMatch(/^None\.\n\n\*\*Not in/);
  });
});
