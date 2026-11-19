import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crossValidate } from '../src/config';
import { gate, isAllowed, parseRemoteUrl } from '../src/gate';
import type { RepositoryAllowlist } from '../src/types';
import { config } from './helpers';

const allowlist: RepositoryAllowlist = {
  version: 1,
  org: 'LedgerLink-ai',
  repositories: [
    { name: 'link_core', enabled: true },
    { name: 'link_quote', enabled: false },
  ],
};

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(origin?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gate-')));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

const local = {}; // an environment with no CI variables

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/LedgerLink-ai/link_core.git', 'LedgerLink-ai', 'link_core'],
    ['https://github.com/LedgerLink-ai/link_core', 'LedgerLink-ai', 'link_core'],
    ['https://user:token@github.com/LedgerLink-ai/link_core.git/', 'LedgerLink-ai', 'link_core'],
    ['git@github.com:LedgerLink-ai/link_core.git', 'LedgerLink-ai', 'link_core'],
    ['ssh://git@github.com/LedgerLink-ai/link_core.git', 'LedgerLink-ai', 'link_core'],
  ])('reads %s', (url, owner, name) => {
    expect(parseRemoteUrl(url)).toEqual({ owner, name });
  });

  it.each([
    '',
    '/home/dev/link_core',
    'C:\\work\\link_core',
    '../link_core',
    'https://github.com/LedgerLink-ai',
    'https://github.com/a/b/c',
    'https://github.com/LedgerLink-ai/../link_core',
    'git@github.com:/LedgerLink-ai/link_core.git',
    'file:///srv/LedgerLink-ai/link_core.git',
  ])('rejects %j', (url) => {
    expect(parseRemoteUrl(url)).toBeUndefined();
  });
});

describe('isAllowed', () => {
  it('allows an enabled repository of the organisation, ignoring case', () => {
    expect(isAllowed(allowlist, { owner: 'ledgerlink-AI', name: 'LINK_CORE' })).toEqual({ ok: true });
  });
  it('refuses other owners, even for a listed name', () => {
    const r = isAllowed(allowlist, { owner: 'someone', name: 'link_core' });
    expect(r.ok).toBe(false);
  });
  it('refuses an owner that only resembles the organisation', () => {
    expect(isAllowed(allowlist, { owner: 'LedgerLink-ai-evil', name: 'link_core' }).ok).toBe(false);
    expect(isAllowed(allowlist, { owner: 'LedgerLink', name: 'link_core' }).ok).toBe(false);
  });
  it('refuses an unregistered repository of the organisation', () => {
    const r = isAllowed(allowlist, { owner: 'LedgerLink-ai', name: 'other' });
    expect(r).toMatchObject({ ok: false });
  });
  it('refuses a repository that is disabled', () => {
    expect(isAllowed(allowlist, { owner: 'LedgerLink-ai', name: 'link_quote' }).ok).toBe(false);
  });
});

describe('gate, local clone (git origin)', () => {
  it('runs in an opted-in LedgerLink-ai repository', () => {
    const d = gate(allowlist, repo('git@github.com:LedgerLink-ai/link_core.git'), local);
    expect(d).toMatchObject({ run: true, repo: { owner: 'LedgerLink-ai', name: 'link_core' } });
  });
  it('does not run in a personal repository', () => {
    expect(gate(allowlist, repo('https://github.com/jdoe/link_core.git'), local)).toMatchObject({ run: false });
  });
  it("does not run in another organisation's repository", () => {
    expect(gate(allowlist, repo('https://github.com/OtherOrg/link_core.git'), local)).toMatchObject({ run: false });
  });
  it('does not run in a personal fork of an allowlisted repository', () => {
    expect(gate(allowlist, repo('https://github.com/jdoe/link_core'), local)).toMatchObject({ run: false });
  });
  it('does not run in an unregistered LedgerLink-ai repository', () => {
    expect(gate(allowlist, repo('https://github.com/LedgerLink-ai/unknown'), local)).toMatchObject({ run: false });
  });
  it('does not run where QA is disabled by an administrator', () => {
    expect(gate(allowlist, repo('https://github.com/LedgerLink-ai/link_quote'), local)).toMatchObject({ run: false });
  });
  it('ignores the folder name: a folder called link_core with no origin does not run', () => {
    const dir = repo();
    const named = join(dir, 'link_core');
    mkdirSync(named);
    execFileSync('git', ['init', '-q', named]);
    expect(gate(allowlist, named, local)).toMatchObject({ run: false });
  });
  it('does not run without an origin, or outside a git repository', () => {
    expect(gate(allowlist, repo(), local)).toMatchObject({ run: false });
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'qa-plain-')));
    dirs.push(plain);
    expect(gate(allowlist, plain, local)).toMatchObject({ run: false });
  });
  it('does not run for an origin that is a local path', () => {
    expect(gate(allowlist, repo('/srv/git/LedgerLink-ai/link_core.git'), local)).toMatchObject({ run: false });
  });
  it('skips silently locally but fails closed in CI when identity cannot be verified', () => {
    const dir = repo();
    expect(gate(allowlist, dir, local)).not.toHaveProperty('failClosed');
    expect(gate(allowlist, dir, { CI: 'true' })).toMatchObject({ run: false, failClosed: true });
  });
  it('treats a repository that is verifiably not allowlisted as a skip, not an error, in CI', () => {
    const d = gate(allowlist, repo('https://github.com/jdoe/link_core'), { CI: 'true' });
    expect(d).toMatchObject({ run: false });
    expect(d).not.toHaveProperty('failClosed');
  });
  it('cannot be switched on by --repo style names or QA_CONFORMANCE in a real repository', () => {
    expect(gate(allowlist, repo('https://github.com/jdoe/x'), { QA_CONFORMANCE: '1' })).toMatchObject({ run: false });
  });
  it('honours QA_CONFORMANCE only for a loose folder in the temp directory', () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'qa-fixture-')));
    dirs.push(plain);
    expect(gate(allowlist, plain, { QA_CONFORMANCE: '1' })).toMatchObject({ run: true });
    expect(gate(allowlist, plain, local)).toMatchObject({ run: false });
    expect(gate(allowlist, resolve(__dirname), { QA_CONFORMANCE: '1' })).toMatchObject({ run: false });
  });
});

describe('gate, GitHub Actions (runner metadata)', () => {
  function event(payload: unknown): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-event-')));
    dirs.push(dir);
    const file = join(dir, 'event.json');
    writeFileSync(file, JSON.stringify(payload));
    return file;
  }
  const actions = (repository: string | undefined, eventPath?: string) => ({
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_PATH: eventPath,
  });
  // A checkout whose origin says LedgerLink-ai must not matter in Actions.
  const lying = () => repo('https://github.com/LedgerLink-ai/link_core');

  it('runs for an allowlisted repository', () => {
    const e = event({ repository: { full_name: 'LedgerLink-ai/link_core', fork: false } });
    expect(gate(allowlist, repo(), actions('LedgerLink-ai/link_core', e))).toMatchObject({ run: true });
  });
  it('takes identity from GITHUB_REPOSITORY, not from the checkout', () => {
    expect(gate(allowlist, lying(), actions('jdoe/link_core'))).toMatchObject({ run: false });
  });
  it('fails closed when GITHUB_REPOSITORY is missing or malformed', () => {
    expect(gate(allowlist, lying(), actions(undefined))).toMatchObject({ run: false, failClosed: true });
    expect(gate(allowlist, lying(), actions('link_core'))).toMatchObject({ run: false, failClosed: true });
    expect(gate(allowlist, lying(), actions('a/b/c'))).toMatchObject({ run: false, failClosed: true });
  });
  it('fails closed when the event payload is unreadable or disagrees', () => {
    expect(gate(allowlist, repo(), actions('LedgerLink-ai/link_core', '/nonexistent/event.json'))).toMatchObject({
      run: false,
      failClosed: true,
    });
    const e = event({ repository: { full_name: 'jdoe/link_core' } });
    expect(gate(allowlist, repo(), actions('LedgerLink-ai/link_core', e))).toMatchObject({
      run: false,
      failClosed: true,
    });
  });
  it('does not run for a fork repository', () => {
    const e = event({ repository: { full_name: 'LedgerLink-ai/link_core', fork: true } });
    expect(gate(allowlist, repo(), actions('LedgerLink-ai/link_core', e))).toMatchObject({ run: false });
  });
  it('does not run for a pull request from a fork', () => {
    const e = event({
      repository: { full_name: 'LedgerLink-ai/link_core', fork: false },
      pull_request: { head: { repo: { full_name: 'jdoe/link_core', fork: true } } },
    });
    expect(gate(allowlist, repo(), actions('LedgerLink-ai/link_core', e))).toMatchObject({ run: false });
  });
  it('runs for a pull request from a branch of the same repository', () => {
    const e = event({
      repository: { full_name: 'LedgerLink-ai/link_core', fork: false },
      pull_request: { head: { repo: { full_name: 'LedgerLink-ai/link_core', fork: false } } },
    });
    expect(gate(allowlist, repo(), actions('LedgerLink-ai/link_core', e))).toMatchObject({ run: true });
  });
  it('fails closed for a pull request whose head repository is gone', () => {
    const e = event({ repository: { full_name: 'LedgerLink-ai/link_core' }, pull_request: { head: { repo: null } } });
    expect(gate(allowlist, repo(), actions('LedgerLink-ai/link_core', e))).toMatchObject({
      run: false,
      failClosed: true,
    });
  });
  it('does not run for another organisation or an unregistered repository', () => {
    expect(gate(allowlist, repo(), actions('OtherOrg/link_core'))).toMatchObject({ run: false });
    expect(gate(allowlist, repo(), actions('LedgerLink-ai/unknown'))).toMatchObject({ run: false });
  });
});

describe('the shipped allowlist', () => {
  it('is consistent and names no duplicate repository', () => {
    expect(crossValidate(config())).toEqual([]);
    expect(config().repositories.org).toBe('LedgerLink-ai');
  });
  it('lists every repository that path-tags.yaml covers', () => {
    const listed = new Set(config().repositories.repositories.map((r) => r.name));
    const tagged = new Set<string>();
    for (const tag of Object.values(config().pathTags.tags))
      for (const name of Object.keys(tag.paths)) if (name !== '*') tagged.add(name);
    for (const name of tagged) expect(listed).toContain(name);
  });
});

describe('qa CLI end to end', () => {
  const cli = resolve(__dirname, '..', 'bin', 'qa.js');
  const built = spawnSync(process.execPath, [cli, 'version'], { encoding: 'utf8' }).status === 0;
  const run = (dir: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, 'precommit', '--root', dir, '--config', resolve(__dirname, '..', '..', '..')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });

  (built ? it : it.skip)('does nothing, silently, in a personal repository', () => {
    const r = run(repo('https://github.com/jdoe/link_core'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });
  (built ? it : it.skip)('exits 2 in CI when the repository cannot be identified', () => {
    const r = run(repo(), { CI: 'true' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot verify this repository/);
  });
});
