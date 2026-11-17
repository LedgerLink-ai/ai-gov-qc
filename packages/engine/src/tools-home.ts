import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

// Where "qa setup" installs the external tools, the same way on Windows,
// macOS and Linux:
//
//   <home>/venv          a private Python environment with pre-commit and Semgrep
//   <home>/bin           gitleaks, plus pre-commit and semgrep launchers (add it to PATH)
//   <home>/git-template  the git template that connects the hooks in new clones
//
// <home> is $QA_HOME, else ~/.ledgerlink-qa.

export const isWindows = process.platform === 'win32';

export function qaHome(): string {
  return resolve(process.env.QA_HOME ?? join(homedir(), '.ledgerlink-qa'));
}

export const binDir = (): string => join(qaHome(), 'bin');
export const venvDir = (): string => join(qaHome(), 'venv');

/** A program inside the private Python environment. */
export function venvProgram(name: string): string {
  return isWindows ? join(venvDir(), 'Scripts', `${name}.exe`) : join(venvDir(), 'bin', name);
}

/**
 * On Windows, a tool found on PATH as a program qa can start without a shell:
 * <dir>\<tool>.exe, or, for the <tool>.cmd launcher "qa setup" writes into
 * <home>\bin, the program it launches (<home>\venv\Scripts\<tool>.exe). Node
 * cannot start a .cmd file without a shell, and qa never uses one for
 * scanners, so without this a tool reachable only through the launcher would
 * look missing.
 */
export function windowsPathProgram(tool: string, path = process.env.PATH ?? ''): string | undefined {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const exe = join(dir, `${tool}.exe`);
    if (existsSync(exe)) return exe;
    const target = join(dir, '..', 'venv', 'Scripts', `${tool}.exe`);
    if (existsSync(join(dir, `${tool}.cmd`)) && existsSync(target)) return resolve(target);
  }
  return undefined;
}

/**
 * The program to run for a tool: $QA_<TOOL>_BIN, else the copy "qa setup"
 * installed, else the name itself, found on PATH.
 */
export function toolBinary(tool: 'gitleaks' | 'semgrep' | 'pre-commit'): string {
  const env = process.env[`QA_${tool.replace('-', '_').toUpperCase()}_BIN`];
  if (env) return env;
  const installed = tool === 'gitleaks' ? join(binDir(), isWindows ? 'gitleaks.exe' : 'gitleaks') : venvProgram(tool);
  if (existsSync(installed)) return installed;
  return (isWindows ? windowsPathProgram(tool) : undefined) ?? tool;
}
