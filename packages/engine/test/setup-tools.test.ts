import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gitleaksAsset, runCommand, setupGitleaks, setupPython, type Runner, type RunnerResult } from '../src/setup';
import { binDir, isWindows, venvDir, venvProgram } from '../src/tools-home';
import type { Config } from '../src/types';
import { config, CONFIG_DIR } from './helpers';

// The tool installs "qa setup" does, with every program it runs (Python,
// pip, tar, the installed tools) replaced by a scripted runner: no Python,
// network or real gitleaks needed. What is pinned here is what keeps a
// developer's machine safe: pip only ever installs hash-checked, listed
// packages; gitleaks is only installed when its SHA-256 matches.

const PINS = { 'pre-commit': '4.7.0', semgrep: '1.183.0' };

type Rule = [
  match: (cmd: string, args: string[]) => boolean,
  result: RunnerResult | ((args: string[]) => RunnerResult),
];
const ok = (raw = ''): RunnerResult => ({ ok: true, out: raw, raw });
const fail = (raw = 'failed'): RunnerResult => ({ ok: false, out: raw, raw });

/** A runner that answers by rule, first match wins, and records every call. */
function scripted(rules: Rule[]): Runner & { calls: Array<{ cmd: string; args: string[]; show?: boolean }> } {
  const calls: Array<{ cmd: string; args: string[]; show?: boolean }> = [];
  const runner = (async (cmd: string, args: string[], opts?: { show?: boolean }) => {
    calls.push({ cmd, args, show: opts?.show });
    for (const [match, result] of rules)
      if (match(cmd, args)) return typeof result === 'function' ? result(args) : result;
    return fail(`not scripted: ${cmd} ${args.join(' ')}`);
  }) as Runner & { calls: typeof calls };
  runner.calls = calls;
  return runner;
}

const is = (path: string) => (cmd: string) => cmd === path;
const named = (name: string) => (cmd: string) => basename(cmd).replace(/\.exe$/, '') === name;
const pythonVersion = (args: string[]) => args.includes('-c');

let saved: string | undefined;
let home: string;
let rows: Array<[string, string, string]>;
const row = (status: 'ok' | 'WARN' | 'FAIL', name: string, detail: string): void => {
  rows.push([status, name, detail]);
};
const rowFor = (name: string) => rows.filter((r) => r[1] === name);

beforeEach(() => {
  saved = process.env.QA_HOME;
  home = mkdtempSync(join(tmpdir(), 'qa-setup-tools-'));
  process.env.QA_HOME = home;
  rows = [];
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  jest.restoreAllMocks();
  if (saved === undefined) delete process.env.QA_HOME;
  else process.env.QA_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

/** A Python on the machine: every candidate command reports `version`. */
const anyPython = (version: string): Rule => [
  (cmd, args) => ['py', 'python', 'python3'].includes(cmd) && pythonVersion(args),
  ok(version),
];

describe('qa setup: the Python tools', () => {
  it('does nothing but the launchers when the pinned versions are already installed', async () => {
    const run = scripted([
      [is(venvProgram('pre-commit')), ok('pre-commit 4.7.0')],
      [is(venvProgram('semgrep')), ok('1.183.0')],
    ]);
    expect(await setupPython(config(), PINS, row, run)).toBe(true);
    expect(rows.map((r) => r[0])).toEqual(['ok', 'ok']);
    expect(run.calls.some((c) => c.args.includes('pip'))).toBe(false);
    expect(existsSync(join(binDir(), 'pre-commit'))).toBe(true);
    if (isWindows) expect(readFileSync(join(binDir(), 'semgrep.cmd'), 'utf8')).toContain('venv\\Scripts\\semgrep.exe');
  });

  it('fails, naming the supported range, when no Python 3.11 or later is found', async () => {
    const run = scripted([anyPython('3.9.7')]);
    expect(await setupPython(config(), PINS, row, run)).toBe(false);
    expect(rowFor('python')).toEqual([['FAIL', 'python', expect.stringMatching(/Python 3\.11 to 3\.14 not found/)]]);
  });

  it('installs with pip hash checking on, nothing unlisted, from the pinned requirements file', async () => {
    let installed = false;
    const run = scripted([
      [is(venvProgram('pre-commit')), () => (installed ? ok('pre-commit 4.7.0') : fail())],
      [is(venvProgram('semgrep')), () => (installed ? ok('1.183.0') : fail())],
      [
        (cmd, args) => cmd === venvProgram('python') && args.includes('pip'),
        () => {
          installed = true;
          return ok();
        },
      ],
      [(cmd, args) => cmd === venvProgram('python') && args[0] === '--version', fail()],
      anyPython('3.12.4'),
      [
        (_cmd, args) => args.includes('venv'),
        () => {
          mkdirSync(join(venvProgram('python'), '..'), { recursive: true });
          writeFileSync(venvProgram('python'), '');
          return ok();
        },
      ],
    ]);
    expect(await setupPython(config(), PINS, row, run)).toBe(true);
    const pip = run.calls.find((c) => c.args.includes('pip'));
    expect(pip?.args).toEqual(
      expect.arrayContaining([
        '--require-hashes',
        '--no-deps',
        '-r',
        join(CONFIG_DIR, 'config', 'python-requirements.txt'),
      ]),
    );
    // pip's own output is shown: a first install takes minutes.
    expect(pip?.show).toBe(true);
    expect(rowFor('pre-commit')).toEqual([['ok', 'pre-commit', expect.stringContaining('4.7.0')]]);
    expect(rowFor('semgrep')).toEqual([['ok', 'semgrep', expect.stringContaining('1.183.0')]]);
  });

  it('prefers a supported Python, and only warns when the newest one is too new', async () => {
    const tooNew = scripted([anyPython('3.15.0'), [(_c, a) => a.includes('venv'), fail('no venv')]]);
    expect(await setupPython(config(), PINS, row, tooNew)).toBe(false);
    expect(rowFor('python')).toEqual([['WARN', 'python', expect.stringMatching(/3\.15\.0 .*so pip may fail/)]]);
  });

  it('on Windows, asks the py launcher and picks the newest supported version', async () => {
    if (!isWindows) return;
    const run = scripted([
      [(cmd, args) => cmd === 'py' && args[0] === '--list', ok(' -V:3.15 *\n -V:3.13\n -V:3.12\n')],
      [(cmd, args) => cmd === 'py' && args[0] === '-3.15' && pythonVersion(args), ok('3.15.0')],
      [(cmd, args) => cmd === 'py' && args[0] === '-3.13' && pythonVersion(args), ok('3.13.2')],
      [(_c, a) => a.includes('venv'), fail('stop here')],
    ]);
    await setupPython(config(), PINS, row, run);
    expect(rowFor('python')[0]).toEqual(['ok', 'python', '3.13.2 (py -3.13)']);
  });

  it('makes the environment again when an earlier run left one on an unsupported Python', async () => {
    mkdirSync(join(venvProgram('python'), '..'), { recursive: true });
    writeFileSync(venvProgram('python'), '');
    writeFileSync(join(venvDir(), 'marker'), 'old');
    const run = scripted([
      [(cmd, args) => cmd === venvProgram('python') && args[0] === '--version', ok('Python 3.15.0')],
      anyPython('3.12.4'),
      [(_c, a) => a.includes('venv'), fail('stop here')],
    ]);
    expect(await setupPython(config(), PINS, row, run)).toBe(false);
    expect(existsSync(join(venvDir(), 'marker'))).toBe(false);
    expect(rowFor('python venv')).toEqual([['FAIL', 'python venv', expect.stringContaining('could not create')]]);
  });

  it('refuses to run pip when the requirements file is missing or does not match policy.yaml', async () => {
    const venvReady = (): void => {
      mkdirSync(join(venvProgram('python'), '..'), { recursive: true });
      writeFileSync(venvProgram('python'), '');
    };
    venvReady();
    const run = scripted([
      [(cmd, args) => cmd === venvProgram('python') && args[0] === '--version', ok('Python 3.12.4')],
      anyPython('3.12.4'),
    ]);
    const noLock = mkdtempSync(join(tmpdir(), 'qa-no-lock-'));
    try {
      expect(await setupPython({ ...config(), dir: noLock } as Config, PINS, row, run)).toBe(false);
      expect(rowFor('pip install')[0][2]).toMatch(/python-requirements\.txt is missing/);

      rows = [];
      expect(await setupPython(config(), { ...PINS, semgrep: '0.0.1' }, row, run)).toBe(false);
      expect(rowFor('pip install')[0][2]).toMatch(/does not match policy\.yaml: semgrep is 1\.183\.0/);
      expect(run.calls.some((c) => c.args.includes('pip'))).toBe(false);
    } finally {
      rmSync(noLock, { recursive: true, force: true });
    }
  });

  it('fails when pip fails, and when pip leaves the wrong version behind', async () => {
    mkdirSync(join(venvProgram('python'), '..'), { recursive: true });
    writeFileSync(venvProgram('python'), '');
    const base: Rule[] = [
      [(cmd, args) => cmd === venvProgram('python') && args[0] === '--version', ok('Python 3.12.4')],
      anyPython('3.12.4'),
    ];
    const pipFails = scripted([[(_c, a) => a.includes('pip'), fail('hash mismatch')], ...base]);
    expect(await setupPython(config(), PINS, row, pipFails)).toBe(false);
    expect(rowFor('pip install')[0]).toEqual([
      'FAIL',
      'pip install',
      expect.stringMatching(/failed; see the pip output above$/),
    ]);

    rows = [];
    const wrong = scripted([
      [(_c, a) => a.includes('pip'), ok()],
      [is(venvProgram('pre-commit')), ok('pre-commit 4.6.0')],
      [is(venvProgram('semgrep')), ok('1.183.0')],
      ...base,
    ]);
    expect(await setupPython(config(), PINS, row, wrong)).toBe(false);
    expect(rowFor('pre-commit').at(-1)).toEqual(['FAIL', 'pre-commit', expect.stringContaining('4.6.0')]);
  });
});

describe('qa setup: installing gitleaks', () => {
  const pin = config().policy.tools?.gitleaks as string;
  const asset = gitleaksAsset(pin) as string;
  const target = (): string => join(binDir(), isWindows ? 'gitleaks.exe' : 'gitleaks');
  const archive = Buffer.from('a stand-in gitleaks release archive');
  let configDir: string;

  /** A configuration whose checksums file lists the stand-in archive's SHA-256. */
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'qa-gl-config-'));
    cpSync(join(CONFIG_DIR, 'config'), join(configDir, 'config'), { recursive: true });
    const sha = createHash('sha256').update(archive).digest('hex');
    writeFileSync(join(configDir, 'config', `gitleaks_${pin}_checksums.txt`), `${sha}  ${asset}\n`);
  });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));
  const cfg = (): Config => ({ ...config(), dir: configDir }) as Config;

  /** tar "unpacks" by writing the binary; the installed binary reports `version`. */
  const tools = (version = pin): ReturnType<typeof scripted> =>
    scripted([
      [
        (cmd) => named('tar')(cmd),
        (args) => {
          writeFileSync(join(args[args.indexOf('-C') + 1], isWindows ? 'gitleaks.exe' : 'gitleaks'), 'binary');
          return ok();
        },
      ],
      [(cmd) => cmd === target(), () => (existsSync(target()) ? ok(version) : fail())],
    ]);

  it('installs from a downloaded archive whose SHA-256 matches', async () => {
    const file = join(home, asset);
    writeFileSync(file, archive);
    const run = tools();
    expect(
      await setupGitleaks(
        cfg(),
        pin,
        { python: false, gitleaks: true, gitTemplate: false, gitleaksArchive: file },
        row,
        run,
      ),
    ).toBe(true);
    expect(readFileSync(target(), 'utf8')).toBe('binary');
    expect(rowFor('gitleaks')).toEqual([['ok', 'gitleaks', expect.stringContaining('SHA-256 checked')]]);
    if (isWindows) {
      // Windows' own tar, named in full: Git Bash's GNU tar first on PATH cannot read zip files.
      expect(run.calls.find((c) => named('tar')(c.cmd))?.cmd).toMatch(/System32[\\/]tar\.exe$/i);
    }
  });

  it('downloads from a mirror, and installs only when the download matches', async () => {
    const requests: string[] = [];
    let body = archive;
    const server: Server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mirror`;
    try {
      const opts = { python: false, gitleaks: true, gitTemplate: false, downloadBase: `${base}/` };
      expect(await setupGitleaks(cfg(), pin, opts, row, tools())).toBe(true);
      expect(requests).toEqual([`/mirror/v${pin}/${asset}`]);

      rmSync(target());
      rows = [];
      body = Buffer.from('tampered on the way');
      expect(await setupGitleaks(cfg(), pin, opts, row, tools())).toBe(false);
      expect(rowFor('gitleaks')[0][2]).toMatch(/has SHA-256 [0-9a-f]{64}, expected [0-9a-f]{64}; not installed/);
      expect(existsSync(target())).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('does nothing when the pinned version is already installed', async () => {
    mkdirSync(binDir(), { recursive: true });
    writeFileSync(target(), 'binary');
    const run = tools();
    expect(await setupGitleaks(cfg(), pin, { python: false, gitleaks: true, gitTemplate: false }, row, run)).toBe(true);
    expect(run.calls.some((c) => named('tar')(c.cmd))).toBe(false);
  });

  it('fails when the archive does not unpack to a gitleaks binary', async () => {
    const file = join(home, asset);
    writeFileSync(file, archive);
    const run = scripted([[(cmd) => named('tar')(cmd), fail('tar: not a zip')]]);
    expect(
      await setupGitleaks(
        cfg(),
        pin,
        { python: false, gitleaks: true, gitTemplate: false, gitleaksArchive: file },
        row,
        run,
      ),
    ).toBe(false);
    expect(rowFor('gitleaks')[0][2]).toMatch(/could not unpack .*tar: not a zip/);
    expect(existsSync(target())).toBe(false);
  });

  it('fails when the installed binary reports another version', async () => {
    const file = join(home, asset);
    writeFileSync(file, archive);
    expect(
      await setupGitleaks(
        cfg(),
        pin,
        { python: false, gitleaks: true, gitTemplate: false, gitleaksArchive: file },
        row,
        tools('8.0.0'),
      ),
    ).toBe(false);
    expect(rowFor('gitleaks').at(-1)?.[0]).toBe('FAIL');
  });

  it('fails without a checksum for this platform', async () => {
    writeFileSync(join(configDir, 'config', `gitleaks_${pin}_checksums.txt`), '');
    expect(await setupGitleaks(cfg(), pin, { python: false, gitleaks: true, gitTemplate: false }, row, tools())).toBe(
      false,
    );
    expect(rowFor('gitleaks')[0][2]).toMatch(/no checksum for/);
  });
});

describe('qa setup: running programs', () => {
  it('stops a program that runs past its time limit, and says so', async () => {
    const started = Date.now();
    const r = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 500 });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/did not finish within 1 s/);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('redacts the output for messages but keeps it as it is for values', async () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
    const r = await runCommand(process.execPath, ['-e', `console.log(${JSON.stringify(token)})`]);
    expect(r.ok).toBe(true);
    expect(r.raw).toBe(token);
    expect(r.out).not.toContain(token);
  });

  it('a program that cannot start or exits non-zero is not ok', async () => {
    expect((await runCommand(join(tmpdir(), 'no-such-program-qa'), [])).ok).toBe(false);
    expect((await runCommand(process.execPath, ['-e', 'process.exit(3)'])).ok).toBe(false);
  });
});
