import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { withCheckedFiles, isScannerControlFile } from '../src/adapters/tools/workdir';
import { crossValidate, schemaValidator } from '../src/config';
import { isCredentialName, scrubbedEnv } from '../src/exec';
import { gate, parseRemoteUrl } from '../src/gate';
import { findExemption, isCalendarDate, today } from '../src/policy';
import { redact } from '../src/redact';
import { parseBaseline, readBaseline, sarifUri, toSarif, writeBaseline } from '../src/report';
import { run } from '../src/runner';
import { decodeText, directorySource, gitRangeFiles, gitStagedFiles, toPosix } from '../src/sources';
import { resolveTags } from '../src/tags';
import type { Config, Exemption, FileSource, RepositoryAllowlist, RunContext } from '../src/types';
import { allowlistedRepo, cliEnv, describeBuilt, HIDDEN, qa } from './cli-helpers';
import { CONFIG_DIR, config, options } from './helpers';

// Fixes from the review of the engine core: renames of protected paths,
// baselines and exemptions, unreadable files, scanner control files,
// repository names, the GitHub host check, overrides in GitHub Actions, the
// CI baseline, credential names, dates, --files, SARIF URIs, scopes and
// cross-file validation.

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const NO_SCANNERS = 'secrets.gitleaks,sast.semgrep';

/** A source over bytes, as the git and directory sources are: text when decodable, raw bytes always. */
function byteSource(files: Record<string, Buffer>): FileSource {
  return {
    kind: 'dir',
    root: '/memory',
    read: (p) => (files[p] === undefined ? undefined : decodeText(files[p])),
    readBytes: (p) => files[p],
  };
}

describe('H4: a rename keeps its old path, and moving a protected file away is flagged', () => {
  it('flags the protected old path of a rename for an agent, as moves/renames', async () => {
    const result = await run(
      options(
        {},
        {
          actor: 'agent',
          changedFiles: [{ path: 'y.yml', status: 'R', oldPath: '.github/workflows/x.yml' }],
          source: byteSource({ 'y.yml': Buffer.from('name: x\n') }),
        },
      ),
    );
    const f = result.findings.find((x) => x.checkId === 'paths.protected');
    expect(f).toMatchObject({ path: '.github/workflows/x.yml', level: 'error', blocking: true });
    expect(f?.message).toMatch(/moves\/renames a protected path \(tagged ci-config\) to y\.yml/);
  });

  it('notes it for a human (code-owner review), without blocking', async () => {
    const result = await run(
      options(
        {},
        {
          changedFiles: [{ path: 'y.yml', status: 'R', oldPath: '.github/workflows/x.yml' }],
          source: byteSource({ 'y.yml': Buffer.from('name: x\n') }),
        },
      ),
    );
    const f = result.findings.find((x) => x.checkId === 'paths.protected');
    expect(f).toMatchObject({ level: 'note', blocking: false });
    expect(f?.message).toMatch(/moves\/renames a protected path/);
  });

  it('matches protected globs ignoring case (M10)', async () => {
    const result = await run(
      options({ 'src/KEYS/signer.txt': 'x\n', 'deploy/PROD/app.yaml': 'x\n' }, { actor: 'agent' }),
    );
    const paths = result.findings.filter((f) => f.checkId === 'paths.protected').map((f) => f.path);
    expect(paths).toEqual(['deploy/PROD/app.yaml', 'src/KEYS/signer.txt']);
  });

  describe('from git', () => {
    let repo: ReturnType<typeof allowlistedRepo>;
    beforeAll(() => {
      repo = allowlistedRepo();
      dirs.push(repo.dir);
      mkdirSync(join(repo.dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(repo.dir, '.github', 'workflows', 'x.yml'), 'name: x\non: push\njobs: {}\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '--no-verify', '-m', 'workflow');
      repo.git('checkout', '-q', '-b', 'LCORE-1-move');
      repo.git('mv', '.github/workflows/x.yml', 'y.yml');
    });

    it('keeps the old path in staged and range selections', () => {
      expect(gitStagedFiles(repo.dir)).toEqual([{ path: 'y.yml', status: 'R', oldPath: '.github/workflows/x.yml' }]);
      repo.git('commit', '-q', '--no-verify', '-m', 'move');
      expect(gitRangeFiles(repo.dir, 'main')).toEqual([
        { path: 'y.yml', status: 'R', oldPath: '.github/workflows/x.yml' },
      ]);
      repo.git('reset', '-q', '--soft', 'HEAD~1');
    });

    (existsSync(join(__dirname, '..', 'dist', 'cli.js')) ? it : it.skip)(
      'blocks the agent in qa check --staged and --base',
      () => {
        const env = cliEnv({ QA_CONFIG_DIR: CONFIG_DIR, QA_AS_OF: '2027-01-08', QA_ACTOR: 'agent' });
        const args = ['--exclude', NO_SCANNERS, '--format', 'json'];
        const expectMove = (res: { status: number | null; stdout: string }): void => {
          expect(res.status).toBe(1);
          const json = JSON.parse(res.stdout) as { findings: Array<Record<string, unknown>> };
          expect(json.findings).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                check: 'paths.protected',
                path: '.github/workflows/x.yml',
                level: 'error',
                blocking: true,
              }),
            ]),
          );
        };
        expectMove(qa(['check', '--staged', ...args], { cwd: repo.dir, env }));
        repo.git('commit', '-q', '--no-verify', '-m', 'move');
        expectMove(qa(['check', '--base', 'main', ...args], { cwd: repo.dir, env }));
      },
    );
  });
});

describe('H5: an expired exemption blocks again, whatever the baseline says', () => {
  const exemption: Exemption = {
    id: 'EX-0001',
    check: 'ai-config.content-lint',
    repo: 'link_core',
    path: 'AGENTS.md',
    owner: 'owner',
    approved_by: 'approver',
    reason: 'accepted until the file is rewritten',
    expires: '2026-12-31',
  };
  const cfg = (): Config => ({ ...config(), exemptions: [exemption] });

  it('leaves exempted findings out of a baseline', async () => {
    const root = tempDir('qa-baseline-');
    const active = await run(options({ 'AGENTS.md': HIDDEN }, { config: cfg(), asOf: '2026-12-15' }));
    expect(active.findings[0].suppressedBy).toBe('exemption');
    writeBaseline(root, active);
    expect(readBaseline(root).size).toBe(0);
  });

  it('ignores a baseline entry for a finding whose exemption expired', async () => {
    const before = await run(options({ 'AGENTS.md': HIDDEN }, { config: cfg(), asOf: '2026-12-15' }));
    // A baseline written by an older qa, which recorded exempted findings too.
    const old = new Set(before.findings.map((f) => f.fingerprint));
    const after = await run(options({ 'AGENTS.md': HIDDEN }, { config: cfg(), asOf: '2027-01-08', baseline: old }));
    expect(after.exitCode).toBe(1);
    expect(after.findings[0]).toMatchObject({ blocking: true });
    expect(after.findings[0].suppressedBy).toBeUndefined();
    expect(after.findings[0].suppressionNote).toMatch(/EX-0001 expired/);
  });

  it('still honours the baseline for findings no exemption names', async () => {
    const first = await run(options({ 'AGENTS.md': HIDDEN }));
    const second = await run(options({ 'AGENTS.md': HIDDEN }, { baseline: new Set([first.findings[0].fingerprint]) }));
    expect(second.exitCode).toBe(0);
    expect(second.findings[0].suppressedBy).toBe('baseline');
  });

  describeBuilt('qa baseline and qa check with --as-of', () => {
    it('blocks after the exemption expires even though the baseline was taken while it was active', () => {
      const configDir = tempDir('qa-config-');
      for (const entry of ['registry', 'schemas', 'config', 'path-tags.yaml', 'checks.yaml', 'policy.yaml'])
        cpSync(join(CONFIG_DIR, entry), join(configDir, entry), { recursive: true });
      writeFileSync(
        join(configDir, 'exemptions.yaml'),
        [
          'version: 1',
          'exemptions:',
          '  - id: EX-0001',
          '    check: ai-config.content-lint',
          '    repo: link_core',
          '    path: AGENTS.md',
          '    owner: owner',
          '    approved_by: approver',
          '    reason: accepted until the file is rewritten',
          '    expires: 2026-12-31',
          '',
        ].join('\n'),
      );
      const repo = allowlistedRepo();
      dirs.push(repo.dir);
      writeFileSync(join(repo.dir, 'AGENTS.md'), HIDDEN);
      const env = cliEnv({ QA_CONFIG_DIR: configDir });
      const args = ['--all', '--exclude', NO_SCANNERS];
      const base = qa(['baseline', ...args, '--as-of', '2026-12-15'], { cwd: repo.dir, env });
      expect(base.status).toBe(0);
      expect(base.stdout).toMatch(/Baselined 0 finding/);
      expect(qa(['check', ...args, '--as-of', '2026-12-15'], { cwd: repo.dir, env }).status).toBe(0);
      const expired = qa(['check', ...args, '--as-of', '2027-01-08'], { cwd: repo.dir, env });
      expect(expired.status).toBe(1);
      expect(expired.stdout).toMatch(/BLOCK +ai-config\.content-lint +AGENTS\.md/);
    });
  });
});

describe('H7: UTF-16, byte order marks, and files that cannot be read as text', () => {
  const utf16le = (s: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
  const utf16be = (s: string): Buffer => {
    const b = Buffer.from(s, 'utf16le');
    b.swap16();
    return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
  };

  it('decodes UTF-16 with a byte order mark and removes a UTF-8 one', () => {
    expect(decodeText(utf16le('héllo\n'))).toBe('héllo\n');
    expect(decodeText(utf16be('héllo\n'))).toBe('héllo\n');
    expect(decodeText(Buffer.from('\uFEFF{"a":1}', 'utf8'))).toBe('{"a":1}');
    expect(decodeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toBeUndefined();
    expect(decodeText(Buffer.alloc(3 * 1024 * 1024, 0x61))).toBeUndefined();
  });

  it('checks a UTF-16 instruction file, and a .mcp.json with a byte order mark parses', async () => {
    const files = {
      'AGENTS.md': utf16le(HIDDEN),
      '.mcp.json': Buffer.from('\uFEFF{"mcpServers": {}}\n', 'utf8'),
    };
    const result = await run(
      options(
        {},
        {
          changedFiles: Object.keys(files).map((path) => ({ path, status: 'A' as const })),
          source: byteSource(files),
        },
      ),
    );
    expect(
      result.findings.filter((f) => f.checkId === 'ai-config.content-lint' && f.ruleId !== 'unscannable'),
    ).not.toHaveLength(0);
    expect(result.findings.some((f) => f.ruleId === 'unparseable')).toBe(false);
    expect(result.findings.some((f) => f.ruleId === 'unscannable')).toBe(false);
  });

  it('reports a file a check could not read: an error in CI, a warning locally', async () => {
    const files = {
      'AGENTS.md': Buffer.from([0x00, 0x01, 0x02, 0x03]),
      'CLAUDE.md': Buffer.alloc(3 * 1024 * 1024, 0x61),
    };
    const opts = {
      changedFiles: Object.keys(files).map((path) => ({ path, status: 'A' as const })),
      source: byteSource(files),
    };
    const ci = await run(options({}, opts));
    const found = ci.findings.filter((f) => f.ruleId === 'unscannable');
    expect(found.map((f) => f.path)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(found[0]).toMatchObject({ checkId: 'ai-config.content-lint', level: 'error', blocking: true });
    const local = await run(options({}, { ...opts, mode: 'local' }));
    expect(local.findings.filter((f) => f.ruleId === 'unscannable').map((f) => f.level)).toEqual([
      'warning',
      'warning',
    ]);
    expect(local.exitCode).toBe(0);
  });

  it('does not report a deleted or missing file as unreadable', async () => {
    const result = await run(
      options({}, { changedFiles: [{ path: 'AGENTS.md', status: 'M' }], source: byteSource({}) }),
    );
    // AGENTS.md is a protected path, which only adds a code-owner note.
    expect(result.findings.filter((f) => f.ruleId === 'unscannable')).toEqual([]);
  });
});

describe('H2 and H7: what the scanner work directory receives', () => {
  const ctxWith = (files: Record<string, Buffer>): RunContext =>
    ({ source: byteSource(files) }) as unknown as RunContext;
  const listed = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else out.push(toPosix(relative(dir, join(d, e.name))));
      }
    };
    walk(dir);
    return out.sort();
  };

  it('never copies scanner configuration or ignore files a change brings', async () => {
    for (const p of [
      '.gitleaksignore',
      'sub/.gitleaksignore',
      '.GitleaksIgnore',
      '.semgrepignore',
      'a/.semgrepignore',
      '.gitleaks.toml',
      '.semgrep.yml',
      '.semgrep.yaml',
      '.semgrep/rules.yml',
      'x/.semgrep/r.yaml',
    ])
      expect(isScannerControlFile(p)).toBe(true);
    for (const p of ['src/a.ts', 'semgrep.yml', 'docs/gitleaksignore.md']) expect(isScannerControlFile(p)).toBe(false);

    const files = {
      'src/a.ts': Buffer.from('x\n'),
      '.gitleaksignore': Buffer.from('abc:src/a.ts:rule:1\n'),
      'pkg/.semgrepignore': Buffer.from('*\n'),
      '.semgrep/r.yml': Buffer.from('rules: []\n'),
    };
    const seen = await withCheckedFiles(
      ctxWith(files),
      'test',
      Object.keys(files).map((path) => ({ path, status: 'A' as const })),
      (_work, src) => listed(src),
    );
    expect(seen).toEqual(['src/a.ts']);
  });

  it('copies raw bytes for a file that is not text, and UTF-8 for UTF-16 text', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x41, 0x4b, 0x49, 0x41]);
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const files = {
      'bin.dat': binary,
      'big.txt': big,
      'u16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('token\n', 'utf16le')]),
    };
    const got = await withCheckedFiles(
      ctxWith(files),
      'test',
      Object.keys(files).map((path) => ({ path, status: 'A' as const })),
      (_work, src) => ({
        bin: readFileSync(join(src, 'bin.dat')),
        big: readFileSync(join(src, 'big.txt')).length,
        u16: readFileSync(join(src, 'u16.txt'), 'utf8'),
      }),
    );
    expect(got.bin.equals(binary)).toBe(true);
    expect(got.big).toBe(big.length);
    expect(got.u16).toBe('token\n');
  });
});

describe('M14: repository names ignore case', () => {
  it('tags and exemptions apply whatever case the origin URL uses', () => {
    expect([
      ...(resolveTags(config().pathTags, 'Link_Core', ['src/transaction/a.ts']).get('src/transaction/a.ts') ?? []),
    ]).toEqual(['ledger']);
    const ex: Exemption = {
      id: 'EX-0002',
      check: 'c',
      repo: 'link_core',
      path: 'a.ts',
      owner: 'o',
      approved_by: 'a',
      reason: 'a reason long enough',
      expires: '2030-01-01',
    };
    expect(
      findExemption([ex], 'LINK_CORE', { checkId: 'c', level: 'error', message: 'm', path: 'a.ts' }, '2027-01-01'),
    ).toEqual({ active: ex });
  });

  describeBuilt('qa check in a clone whose origin is LedgerLink-ai/Link_Core', () => {
    it("runs as the allowlist's link_core, with its path tags", () => {
      const repo = allowlistedRepo('Link_Core');
      dirs.push(repo.dir);
      mkdirSync(join(repo.dir, 'src', 'transaction'), { recursive: true });
      writeFileSync(join(repo.dir, 'src', 'transaction', 'a.ts'), 'export const a = 1;\n');
      const res = qa(['check', '--files', 'src/transaction/a.ts', '--exclude', NO_SCANNERS, '--format', 'json'], {
        cwd: repo.dir,
        env: cliEnv({ QA_CONFIG_DIR: CONFIG_DIR, QA_AS_OF: '2027-01-08' }),
      });
      expect(res.status).toBe(0);
      const json = JSON.parse(res.stdout) as { repo: string; tags: string[] };
      expect(json).toMatchObject({ repo: 'link_core', tags: ['ledger'] });
    });
  });
});

describe('N1: the origin must be GitHub', () => {
  const toGitHub = (): string => 'github.com';
  const nowhere = (): undefined => undefined;

  it.each([
    'https://gitlab.com/LedgerLink-ai/link_core.git',
    'https://github.com.evil.example/LedgerLink-ai/link_core.git',
    'http://bitbucket.org/LedgerLink-ai/link_core',
    'git://gitlab.com/LedgerLink-ai/link_core.git',
  ])('refuses the web host in %s', (url) => {
    expect(parseRemoteUrl(url, toGitHub)).toBeUndefined();
  });

  it('accepts github.com and ssh.github.com without resolving anything', () => {
    for (const url of [
      'https://github.com/LedgerLink-ai/link_core.git',
      'git@github.com:LedgerLink-ai/link_core.git',
      'ssh://git@github.com/LedgerLink-ai/link_core.git',
      'ssh://git@ssh.github.com:443/LedgerLink-ai/link_core.git',
      'https://GitHub.com/LedgerLink-ai/link_core.git',
    ])
      expect(parseRemoteUrl(url, () => fail('resolved'))).toEqual({ owner: 'LedgerLink-ai', name: 'link_core' });
  });

  it('accepts an SSH host alias only when ssh resolves it to GitHub', () => {
    const url = 'git@github-ledgerlink:LedgerLink-ai/link_core.git';
    const asked: string[] = [];
    expect(
      parseRemoteUrl(url, (h) => {
        asked.push(h);
        return 'github.com';
      }),
    ).toEqual({ owner: 'LedgerLink-ai', name: 'link_core' });
    expect(asked).toEqual(['github-ledgerlink']);
    expect(parseRemoteUrl(url, () => 'ssh.github.com')).toBeDefined();
    expect(parseRemoteUrl(url, () => 'gitlab.com')).toBeUndefined();
    expect(parseRemoteUrl(url, nowhere)).toBeUndefined();
    expect(parseRemoteUrl('git@gitlab.com:LedgerLink-ai/link_core.git', () => 'gitlab.com')).toBeUndefined();
    expect(parseRemoteUrl('git@-oProxyCommand=x:LedgerLink-ai/link_core.git', toGitHub)).toBeUndefined();
  });

  describe('gate', () => {
    const allowlist: RepositoryAllowlist = {
      version: 1,
      org: 'LedgerLink-ai',
      repositories: [{ name: 'link_core', enabled: true }],
    };
    const clone = (origin: string): string => {
      const r = allowlistedRepo();
      dirs.push(r.dir);
      r.git('remote', 'set-url', 'origin', origin);
      return r.dir;
    };

    it('skips a GitLab origin locally and fails closed in CI', () => {
      const dir = clone('https://gitlab.com/LedgerLink-ai/link_core.git');
      expect(gate(allowlist, dir, {}, toGitHub)).toMatchObject({ run: false });
      expect(gate(allowlist, dir, { CI: 'true' }, toGitHub)).toMatchObject({ run: false, failClosed: true });
    });

    it('runs through an SSH alias for github.com, and not when it cannot be resolved', () => {
      const dir = clone('git@github-ledgerlink:LedgerLink-ai/link_core.git');
      expect(gate(allowlist, dir, {}, toGitHub)).toMatchObject({ run: true });
      expect(gate(allowlist, dir, {}, nowhere)).toMatchObject({ run: false });
      expect(gate(allowlist, dir, { CI: 'true' }, nowhere)).toMatchObject({ run: false, failClosed: true });
    });
  });
});

describeBuilt('L1: overrides are refused in GitHub Actions', () => {
  let repo: ReturnType<typeof allowlistedRepo>;
  beforeAll(() => {
    repo = allowlistedRepo();
    dirs.push(repo.dir);
    repo.git('checkout', '-q', '-b', 'LCORE-1-feature');
    writeFileSync(join(repo.dir, 'notes.md'), 'hello\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '--no-verify', '-m', 'notes');
  });
  // No QA_CONFIG_DIR: Actions refuses it; the configuration of this checkout is used.
  const actions = (extra: Record<string, string> = {}) =>
    cliEnv({ GITHUB_ACTIONS: 'true', CI: 'true', GITHUB_REPOSITORY: 'LedgerLink-ai/link_core', ...extra });

  it.each([
    [['--as-of', '2027-01-08'], {}, '--as-of'],
    [['--exclude', 'secrets.gitleaks'], {}, '--exclude'],
    [['--mode', 'local'], {}, '--mode local'],
    [['--actor', 'human'], {}, '--actor'],
    [['--repo', 'link_quote'], {}, '--repo'],
    [[], { QA_ACTOR: 'human' }, 'QA_ACTOR'],
    [[], { QA_AS_OF: '2020-01-01' }, 'QA_AS_OF'],
  ])('refuses %j %j', (args, env, name) => {
    const res = qa(['check', '--base', 'main', ...args], { cwd: repo.dir, env: actions(env) });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(`${name} not accepted in GitHub Actions`);
  });

  it('runs the shipped workflow command: qa prepr --base --mode ci, actor from QA_PR_AUTHOR', () => {
    const res = qa(['prepr', '--base', 'main', '--mode', 'ci', '--format', 'json', '--quiet'], {
      cwd: repo.dir,
      env: actions({ QA_PR_AUTHOR: 'copilot-swe-agent[bot]', QA_PR_BRANCH: 'LCORE-1-feature' }),
    });
    expect(res.stderr).not.toMatch(/not accepted in GitHub Actions/);
    const json = JSON.parse(res.stdout) as { mode: string; actor: string; repo: string };
    expect(json).toMatchObject({ mode: 'ci', actor: 'agent', repo: 'link_core' });
  });
});

describeBuilt('L2: in CI without a base, the working tree baseline is ignored', () => {
  it('blocks a finding the change itself baselined', () => {
    const repo = allowlistedRepo();
    dirs.push(repo.dir);
    writeFileSync(join(repo.dir, 'AGENTS.md'), HIDDEN);
    const env = (extra: Record<string, string> = {}) =>
      cliEnv({ QA_CONFIG_DIR: CONFIG_DIR, QA_AS_OF: '2027-01-08', ...extra });
    const args = ['--all', '--exclude', NO_SCANNERS];
    expect(qa(['baseline', ...args], { cwd: repo.dir, env: env() }).status).toBe(0);
    expect(qa(['check', ...args, '--mode', 'local'], { cwd: repo.dir, env: env() }).status).toBe(0);
    expect(qa(['check', ...args, '--mode', 'ci'], { cwd: repo.dir, env: env({ CI: 'true' }) }).status).toBe(1);
  });
});

describe('L3: credential variable names', () => {
  it('treats keys, passwords, mnemonics, seeds and private values as credentials', () => {
    for (const name of [
      'STRIPE_KEY',
      'OPENAI_KEY',
      'SSH_KEY',
      'KEY_FILE',
      'SIGNING_KEY_ID',
      'DB_PASS',
      'DB_PASSWD',
      'WALLET_MNEMONIC',
      'HD_SEED',
      'SEED_PHRASE',
      'MY_PRIVATE_VALUE',
    ])
      expect([name, isCredentialName(name)]).toEqual([name, true]);
  });

  it('keeps what git, ssh and the scanners need', () => {
    for (const name of [
      'PATH',
      'HOME',
      'USERPROFILE',
      'SystemRoot',
      'TEMP',
      'SSH_AUTH_SOCK',
      'PYTHONHASHSEED',
      'GIT_ASKPASS',
      'GIT_AUTHOR_NAME',
      'GIT_DIR',
      'KEYBOARD_LAYOUT',
      'QA_PR_AUTHOR',
    ])
      expect([name, isCredentialName(name)]).toEqual([name, false]);
    expect(isCredentialName('GIT_TOKEN')).toBe(true);
    expect(scrubbedEnv({ PATH: '/bin', STRIPE_KEY: 'sk', WALLET_MNEMONIC: 'm' })).toEqual({ PATH: '/bin' });
  });

  it('masks their values in output', () => {
    expect(redact('db said: hunter2hunter2', { DB_PASS: 'hunter2hunter2' })).toBe('db said: [REDACTED]');
  });
});

describe('L4: dates', () => {
  it('takes today from UTC', () => {
    expect(today(new Date('2026-11-18T23:30:00-05:00'))).toBe('2026-11-19');
    expect(today(new Date('2026-11-19T00:30:00+05:00'))).toBe('2026-11-18');
  });

  it('accepts only real calendar dates', () => {
    for (const ok of ['2026-02-28', '2028-02-29', '2026-12-31']) expect(isCalendarDate(ok)).toBe(true);
    for (const bad of ['2026-02-31', '2027-02-29', '9999-99-99', '2026-13-01', '2026-00-10', '2026-1-1', ''])
      expect(isCalendarDate(bad)).toBe(false);
  });

  it('refuses impossible expiry and block_from dates, and mode block with block_from', () => {
    const base = config();
    const problems = crossValidate({
      ...base,
      exemptions: [
        {
          id: 'EX-0003',
          check: 'ai-config.content-lint',
          repo: '*',
          path: 'a',
          owner: 'o',
          approved_by: 'a',
          reason: 'a reason long enough',
          expires: '2026-02-31',
        },
      ],
      policy: {
        ...base.policy,
        checks: {
          ...base.policy.checks,
          'pr.commits': { mode: 'report', block_from: '9999-99-99' },
          'pr.diff-size': { mode: 'block', block_from: '2030-01-01' },
        },
      },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/EX-0003 expires on 2026-02-31, which is not a calendar date/),
        expect.stringMatching(/checks\.pr\.commits\.block_from 9999-99-99 is not a calendar date/),
        expect.stringMatching(/checks\.pr\.diff-size has mode block and a block_from date/),
      ]),
    );
  });
});

describe('L5: --files stays inside the repository', () => {
  it('reads nothing outside the root', () => {
    const outer = tempDir('qa-files-');
    mkdirSync(join(outer, 'repo'));
    writeFileSync(join(outer, 'secret.txt'), 'outside\n');
    writeFileSync(join(outer, 'repo', 'a.txt'), 'inside\n');
    const source = directorySource(join(outer, 'repo'));
    expect(source.read('a.txt')).toBe('inside\n');
    expect(source.read('../secret.txt')).toBeUndefined();
    expect(source.read(join(outer, 'secret.txt'))).toBeUndefined();
  });

  describeBuilt('qa check --files', () => {
    it('refuses absolute paths and paths that climb out', () => {
      const repo = allowlistedRepo();
      dirs.push(repo.dir);
      const env = cliEnv({ QA_CONFIG_DIR: CONFIG_DIR });
      for (const f of ['../x.md', 'a/../../x.md', '/etc/passwd', 'C:/Windows/win.ini']) {
        const res = qa(['check', '--files', f], { cwd: repo.dir, env });
        expect([f, res.status]).toEqual([f, 2]);
        expect(res.stderr).toMatch(/refusing the unexpected path/);
      }
    });
  });
});

describe('L6: SARIF URIs are percent-encoded', () => {
  it('encodes each segment and keeps the slashes', async () => {
    expect(sarifUri('src/a b/c#1%.ts')).toBe('src/a%20b/c%231%25.ts');
    const result = await run(options({ 'docs/my AGENTS.md': 'x\n' }, { actor: 'agent' }));
    const sarif = toSarif({
      ...result,
      findings: [{ ...result.findings[0], path: 'dir name/AGENTS #1.md' }].filter((f) => f.checkId),
    }) as {
      runs: Array<{
        results: Array<{ locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }>;
      }>;
    };
    if (sarif.runs[0].results.length > 0)
      expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
        'dir%20name/AGENTS%20%231.md',
      );
    // A baseline stays readable: fingerprints, not URIs, identify findings.
    expect(parseBaseline(JSON.stringify(sarif)).size).toBe(sarif.runs[0].results.length);
  });
});

describe('L7: no scope "release"', () => {
  it('is refused by the checks schema', () => {
    const validate = schemaValidator(CONFIG_DIR, 'checks.schema.json');
    const def = { id: 'x.y', title: 't', kind: 'native', stage: 0, tags: 'all', controls: ['C14-1'], rules: [] };
    expect(validate({ version: 1, checks: [{ ...def, scope: 'file' }] })).toBe(true);
    expect(validate({ version: 1, checks: [{ ...def, scope: 'release' }] })).toBe(false);
  });
});

describe('L9: path tags and exemptions name allowlisted repositories', () => {
  it('refuses unknown repository names and accepts any case of a listed one', () => {
    const base = config();
    const ex = (repo: string, id: string): Exemption => ({
      id,
      check: 'ai-config.content-lint',
      repo,
      path: 'a',
      owner: 'o',
      approved_by: 'a',
      reason: 'a reason long enough',
      expires: '2030-01-01',
    });
    const problems = crossValidate({
      ...base,
      exemptions: [ex('nope', 'EX-0004'), ex('LINK_CORE', 'EX-0005'), ex('*', 'EX-0006')],
      pathTags: {
        ...base.pathTags,
        tags: {
          ...base.pathTags.tags,
          ledger: {
            ...base.pathTags.tags.ledger,
            paths: { ...base.pathTags.tags.ledger.paths, 'link-core-typo': ['x/**'], Link_Quote: ['y/**'] },
          },
        },
      },
    });
    expect(problems).toEqual([
      'exemptions.yaml: EX-0004 names repository nope, which is not in repositories.yaml',
      'path-tags.yaml: ledger names repository link-core-typo, which is not in repositories.yaml',
    ]);
  });
});
