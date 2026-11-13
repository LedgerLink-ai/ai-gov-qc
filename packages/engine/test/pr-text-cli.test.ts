import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowlistedRepo, cliEnv, describeBuilt, qa } from './cli-helpers';

// The pull request title and description reach the pr-text checks from the
// command line (before a pull request is opened) and, in GitHub Actions, from
// the pull_request event payload (the PR gate). AIQC-86.

const SCANNERS = ['--exclude', 'secrets.gitleaks,sast.semgrep'];

interface JsonFinding {
  check: string;
  rule_id?: string;
  sub_rule?: string;
  blocking: boolean;
}

const prTextChecks = (stdout: string): string[] =>
  (JSON.parse(stdout).findings as JsonFinding[])
    .map((f) => f.check)
    .filter((c) => ['pr.title', 'pr.ticket', 'pr.description'].includes(c))
    .sort();

describeBuilt('pull request title and description from the CLI and the PR gate', () => {
  let dir: string;
  let git: (...args: string[]) => string;

  beforeEach(() => {
    ({ dir, git } = allowlistedRepo());
    git('switch', '-q', '-c', 'LCORE-212-refund-key');
    writeFileSync(join(dir, 'refund.ts'), 'export const key = 1;\n');
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'LCORE-212: Add refund key');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.event.json`, { force: true });
    rmSync(`${dir}.body.md`, { force: true });
  });

  it('qa prepr leaves the checks out without a title and description, and runs them with --pr-title and --pr-body-file', () => {
    const without = qa(['prepr', '--base', 'main', '--format', 'json', ...SCANNERS], { cwd: dir });
    expect(without.status).toBe(0);
    expect(prTextChecks(without.stdout)).toEqual([]);

    writeFileSync(`${dir}.body.md`, 'Fixed it.\n');
    const withText = qa(
      [
        'prepr',
        '--base',
        'main',
        '--format',
        'json',
        ...SCANNERS,
        '--pr-title',
        'fix',
        '--pr-body-file',
        `${dir}.body.md`,
      ],
      { cwd: dir },
    );
    expect(withText.status).toBe(0); // report mode: shown, not blocking
    expect(prTextChecks(withText.stdout)).toEqual(expect.arrayContaining(['pr.description', 'pr.ticket', 'pr.title']));
  });

  it('the PR gate reads the title and description from the GitHub event, not from the command line', () => {
    const event = {
      repository: { full_name: 'LedgerLink-ai/link_core', fork: false },
      pull_request: {
        title: 'Add refund key',
        body: null,
        head: { repo: { full_name: 'LedgerLink-ai/link_core', fork: false } },
      },
    };
    writeFileSync(`${dir}.event.json`, JSON.stringify(event));
    const env = cliEnv({
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'LedgerLink-ai/link_core',
      GITHUB_EVENT_PATH: `${dir}.event.json`,
    });
    const res = qa(['prepr', '--base', 'main', '--mode', 'ci', '--format', 'json', ...SCANNERS], { cwd: dir, env });
    expect(res.stderr).not.toMatch(/usage|error/i);
    expect(res.status).toBe(0);
    // No key in the title and no description: all three report.
    expect(prTextChecks(res.stdout)).toEqual(['pr.description', 'pr.ticket', 'pr.title']);
  });

  it('the PR gate fails closed on an event that has no pull request', () => {
    writeFileSync(`${dir}.event.json`, JSON.stringify({ repository: { full_name: 'LedgerLink-ai/link_core' } }));
    const env = cliEnv({
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'LedgerLink-ai/link_core',
      GITHUB_EVENT_PATH: `${dir}.event.json`,
    });
    const res = qa(['prepr', '--base', 'main', '--mode', 'ci', ...SCANNERS], { cwd: dir, env });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/pull_request events/);
  });
});
