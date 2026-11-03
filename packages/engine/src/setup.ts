import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { versionIn } from './adapters/tools/workdir';
import { binDir, isWindows, qaHome, toolBinary, venvDir, venvProgram } from './tools-home';
import type { Config } from './types';

// "qa setup": installs the tools the local hooks need, at the versions pinned
// in policy.yaml, into the qa home (see tools-home.ts). The same steps on
// Windows, macOS and Linux; needs Node 20+, git and Python 3.9 to 3.14.
//
//   pre-commit, semgrep  pip, into a private Python environment
//   gitleaks             the release archive for this OS and CPU, checked
//                        against config/gitleaks_<version>_checksums.txt
//   git template         connects the hooks in every new clone (only when
//                        init.templateDir is not set yet)

export interface SetupOptions {
  python: boolean;
  gitleaks: boolean;
  gitTemplate: boolean;
  /** A gitleaks release archive already downloaded (no network). */
  gitleaksArchive?: string;
  /** Where gitleaks releases are downloaded from (a mirror); <base>/v<version>/<asset>. */
  downloadBase?: string;
}

const GITLEAKS_RELEASES = 'https://github.com/gitleaks/gitleaks/releases/download';
const HOOK_TYPES = ['pre-commit', 'prepare-commit-msg', 'pre-push'];

type Row = (status: 'ok' | 'WARN' | 'FAIL', name: string, detail: string) => void;

function run(cmd: string, args: string[], show = false): { ok: boolean; out: string } {
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: show ? 'inherit' : 'pipe' });
  return { ok: !res.error && res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

const versionOf = (cmd: string, args: string[]): string | undefined => {
  const r = run(cmd, args);
  return r.ok ? versionIn(r.out) : undefined;
};

// The Python 3 minor versions the pinned tools install on. The newest is
// capped because Semgrep 1.183.0 requires pywin32==311 on Windows, which has
// no build for Python 3.15.
export const PYTHON_MINORS = { min: 9, max: 14 };

/**
 * Launcher arguments for every Python the Windows "py" launcher lists, newest
 * first: "-V:3.14 *" (current launchers) and "-3.12-64" (older ones) give -3.14, -3.12.
 */
export function pyLauncherVersions(listing: string): string[] {
  const minors = [...listing.matchAll(/-(?:V:)?3\.(\d+)/g)].map((m) => Number(m[1]));
  return [...new Set(minors)].sort((a, b) => b - a).map((minor) => `-3.${minor}`);
}

/**
 * A Python to create the private environment with: the newest one the pinned
 * tools support, else (with supported: false) the newest 3.9 or later.
 */
function findPython(): { cmd: string; args: string[]; version: string; supported: boolean } | undefined {
  const candidates: Array<[string, string[]]> = [];
  if (isWindows) {
    const listed = run('py', ['--list']);
    if (listed.ok) for (const v of pyLauncherVersions(listed.out)) candidates.push(['py', [v]]);
    candidates.push(['python', []], ['python3', []]);
  } else candidates.push(['python3', []], ['python', []]);
  let newer: { cmd: string; args: string[]; version: string; supported: boolean } | undefined;
  for (const [cmd, args] of candidates) {
    const r = run(cmd, [...args, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])']);
    const v = r.ok ? versionIn(r.out) : undefined;
    if (!v) continue;
    const [major, minor] = v.split('.').map(Number);
    if (major !== 3 || minor < PYTHON_MINORS.min) continue;
    if (minor <= PYTHON_MINORS.max) return { cmd, args, version: v, supported: true };
    newer ??= { cmd, args, version: v, supported: false };
  }
  return newer;
}

/** Launchers in <home>/bin, so "pre-commit" and "semgrep" work from any shell once it is on PATH. */
function writeLaunchers(names: string[]): void {
  mkdirSync(binDir(), { recursive: true });
  for (const name of names) {
    const sh = join(binDir(), name);
    const target = isWindows ? `venv/Scripts/${name}.exe` : `venv/bin/${name}`;
    writeFileSync(sh, `#!/bin/sh\nexec "$(dirname "$0")/../${target}" "$@"\n`);
    if (isWindows) writeFileSync(`${sh}.cmd`, `@"%~dp0..\\venv\\Scripts\\${name}.exe" %*\r\n`);
    else chmodSync(sh, 0o755);
  }
}

function setupPython(pins: Record<string, string>, row: Row): boolean {
  const wanted = ['pre-commit', 'semgrep'].filter((t) => pins[t]);
  const current = (t: string): string | undefined => versionOf(venvProgram(t), ['--version']);
  if (wanted.every((t) => current(t) === pins[t])) {
    for (const t of wanted) row('ok', t, `${pins[t]} (${venvDir()})`);
    writeLaunchers(wanted);
    return true;
  }
  const python = findPython();
  const range = `3.${PYTHON_MINORS.min} to 3.${PYTHON_MINORS.max}`;
  if (!python) {
    row('FAIL', 'python', `Python ${range} not found; install it from python.org, then run "qa setup" again`);
    return false;
  }
  row(
    python.supported ? 'ok' : 'WARN',
    'python',
    `${python.version} (${[python.cmd, ...python.args].join(' ')})${python.supported ? '' : `; the pinned tools support ${range}, so pip may fail`}`,
  );
  // An environment left by an earlier run on an unsupported Python (for
  // example 3.15, where Semgrep's pywin32 pin has no build) is made again.
  const venvMinor = Number(versionOf(venvProgram('python'), ['--version'])?.split('.')[1]);
  if (venvMinor > PYTHON_MINORS.max || venvMinor < PYTHON_MINORS.min)
    rmSync(venvDir(), { recursive: true, force: true });
  if (!existsSync(venvProgram('python'))) {
    const r = run(python.cmd, [...python.args, '-m', 'venv', venvDir()]);
    if (!r.ok) {
      row('FAIL', 'python venv', `could not create ${venvDir()}: ${r.out.slice(0, 300)}`);
      return false;
    }
  }
  const specs = wanted.map((t) => `${t}==${pins[t]}`);
  process.stdout.write(`Installing ${specs.join(', ')} into ${venvDir()} (a few minutes the first time)\n`);
  const pip = run(venvProgram('python'), ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', ...specs], true);
  if (!pip.ok) {
    row(
      'FAIL',
      'pip install',
      `${specs.join(' ')} failed; see the pip output above${python.supported ? '' : `. Install Python ${range} and run "qa setup" again`}`,
    );
    return false;
  }
  let ok = true;
  for (const t of wanted) {
    const v = current(t);
    row(v === pins[t] ? 'ok' : 'FAIL', t, v ? `${v} (${venvDir()})` : 'not installed');
    ok &&= v === pins[t];
  }
  writeLaunchers(wanted);
  return ok;
}

/** The release asset for this OS and CPU, e.g. gitleaks_8.30.1_windows_x64.zip. */
export function gitleaksAsset(version: string, platform = process.platform, arch = process.arch): string | undefined {
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform as string];
  const cpu = { x64: 'x64', arm64: 'arm64', ia32: 'x32', arm: 'armv7' }[arch as string];
  if (!os || !cpu) return undefined;
  return `gitleaks_${version}_${os}_${cpu}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
}

/** The expected SHA-256 of an asset, from the release's own checksums file. */
export function expectedChecksum(checksums: string, asset: string): string | undefined {
  for (const line of checksums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === asset && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  return undefined;
}

async function setupGitleaks(config: Config, pin: string, opts: SetupOptions, row: Row): Promise<boolean> {
  const target = join(binDir(), isWindows ? 'gitleaks.exe' : 'gitleaks');
  if (versionOf(target, ['version']) === pin) {
    row('ok', 'gitleaks', `${pin} (${target})`);
    return true;
  }
  const asset = gitleaksAsset(pin);
  if (!asset) {
    row('FAIL', 'gitleaks', `no gitleaks ${pin} build for ${process.platform}/${process.arch}`);
    return false;
  }
  const sumsFile = join(config.dir, 'config', `gitleaks_${pin}_checksums.txt`);
  const expected = existsSync(sumsFile) ? expectedChecksum(readFileSync(sumsFile, 'utf8'), asset) : undefined;
  if (!expected) {
    row('FAIL', 'gitleaks', `no checksum for ${asset} in ${sumsFile}`);
    return false;
  }

  let archive: Buffer;
  if (opts.gitleaksArchive) {
    archive = readFileSync(resolve(opts.gitleaksArchive));
  } else {
    const base = (opts.downloadBase ?? process.env.QA_GITLEAKS_DOWNLOAD_BASE ?? GITLEAKS_RELEASES).replace(/\/+$/, '');
    const url = `${base}/v${pin}/${asset}`;
    process.stdout.write(`Downloading ${url}\n`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      archive = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      row(
        'FAIL',
        'gitleaks',
        `download failed (${(err as Error).message}); download ${asset} yourself and run "qa setup --gitleaks-archive <file>"`,
      );
      return false;
    }
  }
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) {
    row('FAIL', 'gitleaks', `${asset} has SHA-256 ${actual}, expected ${expected}; not installed`);
    return false;
  }

  const work = mkdtempSync(join(tmpdir(), 'qa-gitleaks-'));
  try {
    const file = join(work, asset);
    writeFileSync(file, archive);
    // tar reads .tar.gz, and Windows' own tar (10 and later) also .zip. On
    // Windows, name it: Git Bash puts GNU tar first on PATH, which reads
    // "C:\..." as a remote host and cannot open zip files.
    const tar = isWindows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const r = run(tar, ['-xf', file, '-C', work]);
    const exe = join(work, isWindows ? 'gitleaks.exe' : 'gitleaks');
    if (!r.ok || !existsSync(exe)) {
      row('FAIL', 'gitleaks', `could not unpack ${asset}: ${r.out.slice(0, 300)}`);
      return false;
    }
    mkdirSync(binDir(), { recursive: true });
    copyFileSync(exe, target);
    if (!isWindows) chmodSync(target, 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const v = versionOf(target, ['version']);
  row(v === pin ? 'ok' : 'FAIL', 'gitleaks', v ? `${v} (${target}, SHA-256 checked)` : 'installed but does not run');
  return v === pin;
}

function setupGitTemplate(row: Row): boolean {
  const current = run('git', ['config', '--global', '--get', 'init.templateDir']);
  const preCommit = toolBinary('pre-commit');
  if (current.ok && current.out) {
    const dir = current.out.replace(/^~(?=[\\/])/, process.env.USERPROFILE ?? process.env.HOME ?? '~');
    const byPreCommit = (h: string): boolean => {
      const f = join(dir, 'hooks', h);
      return existsSync(f) && readFileSync(f, 'utf8').includes('pre-commit');
    };
    if (HOOK_TYPES.every(byPreCommit)) row('ok', 'git template', `${current.out} (already set up)`);
    else if (byPreCommit('pre-commit')) {
      // A template pre-commit made earlier, with an older hook list (commit-msg
      // before prepare-commit-msg): bring it up to date.
      const init = run(preCommit, ['init-templatedir', ...HOOK_TYPES.flatMap((h) => ['-t', h]), dir]);
      row(
        init.ok ? 'ok' : 'FAIL',
        'git template',
        init.ok ? `${current.out}: updated to ${HOOK_TYPES.join(', ')}` : init.out.slice(0, 300),
      );
    } else
      row(
        'WARN',
        'git template',
        `init.templateDir is already ${current.out}; left as it is. To use it: pre-commit init-templatedir -t pre-commit -t prepare-commit-msg -t pre-push "${current.out}"`,
      );
    return true;
  }
  const dir = join(qaHome(), 'git-template');
  const init = run(preCommit, ['init-templatedir', ...HOOK_TYPES.flatMap((h) => ['-t', h]), dir]);
  if (!init.ok) {
    row('FAIL', 'git template', `pre-commit init-templatedir failed: ${init.out.slice(0, 300)}`);
    return false;
  }
  const set = run('git', ['config', '--global', 'init.templateDir', dir.split('\\').join('/')]);
  row(set.ok ? 'ok' : 'FAIL', 'git template', set.ok ? `${dir}: new clones connect the hooks` : set.out);
  return set.ok;
}

function pathAdvice(row: Row): void {
  const dir = binDir();
  const onPath = (process.env.PATH ?? '')
    .split(delimiter)
    .some((p) => resolve(p).toLowerCase() === resolve(dir).toLowerCase());
  if (onPath) {
    row('ok', 'PATH', `${dir} is on PATH`);
    return;
  }
  const how = isWindows
    ? `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${dir}', 'User')   (PowerShell, then open a new terminal)`
    : `echo 'export PATH="${dir}:$PATH"' >> ${process.platform === 'darwin' ? '~/.zshrc' : '~/.bashrc'}   (then open a new terminal)`;
  row('WARN', 'PATH', `add ${dir} to PATH so husky and your shell find pre-commit, semgrep and gitleaks: ${how}`);
}

export async function setup(config: Config, opts: SetupOptions, print: (s: string) => void): Promise<number> {
  const pins = config.policy.tools ?? {};
  let problems = 0;
  const row: Row = (status, name, detail) => {
    if (status === 'FAIL') problems++;
    print(`  ${status.padEnd(4)}  ${name.padEnd(14)} ${detail}`);
  };
  print(`qa setup: tools into ${qaHome()}`);
  const node = process.versions.node;
  row(Number(node.split('.')[0]) >= 20 ? 'ok' : 'FAIL', 'node', node);
  const git = versionOf('git', ['--version']);
  row(git ? 'ok' : 'FAIL', 'git', git ?? 'not found; install git first');

  const pythonOk = opts.python ? setupPython(pins, row) : true;
  if (opts.gitleaks && pins.gitleaks) await setupGitleaks(config, pins.gitleaks, opts, row);
  if (opts.gitTemplate && pythonOk) setupGitTemplate(row);
  pathAdvice(row);
  print(
    problems > 0 ? `result: NOT DONE (${problems} problem(s))` : 'result: DONE. Check a repository with: qa doctor',
  );
  return problems > 0 ? 1 : 0;
}
