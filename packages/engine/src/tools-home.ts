import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
 * The program to run for a tool: $QA_<TOOL>_BIN, else the copy "qa setup"
 * installed, else the name itself, found on PATH.
 */
export function toolBinary(tool: 'gitleaks' | 'semgrep' | 'pre-commit'): string {
  const env = process.env[`QA_${tool.replace('-', '_').toUpperCase()}_BIN`];
  if (env) return env;
  const installed = tool === 'gitleaks' ? join(binDir(), isWindows ? 'gitleaks.exe' : 'gitleaks') : venvProgram(tool);
  return existsSync(installed) ? installed : tool;
}
