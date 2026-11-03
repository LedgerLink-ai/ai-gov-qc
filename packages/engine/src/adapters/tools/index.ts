import type { ChangedFile, CheckDefinition, Finding, RunContext } from '../../types';
import { gitleaks } from './gitleaks';
import { semgrep } from './semgrep';

/**
 * An external scanner. The adapter is the only code that knows the tool's
 * command line and output format; it returns findings in the common shape.
 * It throws ToolUnavailableError when the tool is not installed.
 */
export interface ToolAdapter {
  name: string;
  available(): boolean;
  /** Installed version, or undefined when the tool does not run. */
  version(): string | undefined;
  run(ctx: RunContext, def: CheckDefinition, files: ChangedFile[]): Finding[] | Promise<Finding[]>;
}

export const TOOL_ADAPTERS: Record<string, ToolAdapter> = {
  gitleaks,
  semgrep,
};
