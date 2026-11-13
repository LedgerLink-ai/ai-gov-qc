import { spawn, spawnSync } from 'node:child_process';

/**
 * Running external programs (scanners, git, pip): always with an argument
 * array (no shell), a time limit and an environment without credentials.
 */

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started (not found, not executable). */
  error?: Error;
  /** True when the program was stopped because it ran past its time limit. */
  timedOut: boolean;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Milliseconds before the program (and its children) is killed; 0 or undefined: no limit. */
  timeoutMs?: number;
  /** Bytes kept from each of stdout and stderr; the rest is dropped. */
  maxBuffer?: number;
}

/** A program that ran past its time limit. */
export class ToolTimeoutError extends Error {
  constructor(
    public readonly tool: string,
    public readonly timeoutMs: number,
  ) {
    super(`${tool} did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`);
    this.name = 'ToolTimeoutError';
  }
}

// Environment variable names that carry credentials. Scanners never need
// them, so they are removed before a scanner starts: a compromised or
// misbehaving tool cannot read or leak what it is not given.
const CREDENTIAL_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|AUTH|COOKIE|SESSION|_PAT$|^PAT$|WEBHOOK)/i;

/** Names that look like credentials but are needed to run programs at all. */
const KEEP = new Set(['SSH_AUTH_SOCK']);

export function isCredentialName(name: string): boolean {
  return !KEEP.has(name) && CREDENTIAL_NAME.test(name);
}

/** A copy of `env` without variables whose names mark them as credentials. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!isCredentialName(name)) out[name] = value;
  return out;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      // The child leads its own process group (detached), so this stops what it started too.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
}

/** Runs a program without a shell, with a time limit; never throws. */
export function runProcess(cmd: string, args: string[], opts: ProcessOptions = {}): Promise<ProcessResult> {
  const max = opts.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Omit<ProcessResult, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ ...result, stdout, stderr, timedOut });
    };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ status: null, error: err as Error });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < max) stdout += d.slice(0, max - stdout.length);
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < max) stderr += d.slice(0, max - stderr.length);
    });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, opts.timeoutMs);
    }
    child.on('error', (err) => finish({ status: null, error: err }));
    child.on('close', (code) => finish({ status: code }));
  });
}

/** Default limit for one scanner run, when policy.yaml and the caller set none. */
export const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

/** Default limit for one git command. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** A positive integer number of milliseconds from an environment variable, else undefined. */
export function envMs(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a whole number of milliseconds, got "${raw}"`);
  return n;
}
