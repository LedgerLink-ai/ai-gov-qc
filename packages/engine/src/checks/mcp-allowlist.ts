import { posix } from 'node:path';
import type { CheckDefinition, Finding, McpServerEntry, RunContext } from '../types';

// C14-6 / R14-6: only registry-listed MCP servers, pinned to an approved version.

const MCP_CONFIG = /(^|\/)(\.mcp\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json)$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+].*)?$/;
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const DLX_RUNNERS = new Set(['pnpm', 'yarn', 'bun']);

/** Removes // and /* *\/ comments and trailing commas outside strings (VS Code uses JSONC). */
export function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parsePackageSpec(spec: string): { name: string; version?: string } {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec };
}

/** The package an npx-style command launches, if it is one. */
export function packageSpecOf(command: string, args: string[]): string | undefined {
  const runner = posix.basename(command.replace(/\\/g, '/')).replace(/\.(cmd|exe)$/i, '');
  let rest = args;
  if (DLX_RUNNERS.has(runner)) {
    if (rest[0] !== 'dlx') return undefined;
    rest = rest.slice(1);
  } else if (!PACKAGE_RUNNERS.has(runner)) {
    return undefined;
  }
  return rest.find((a) => !a.startsWith('-'));
}

function lineOf(text: string, name: string): number | undefined {
  const index = text.indexOf(`"${name}"`);
  return index < 0 ? undefined : text.slice(0, index).split('\n').length;
}

interface ServerConfig {
  command?: unknown;
  args?: unknown;
  url?: unknown;
}

export function checkServer(
  checkId: string,
  path: string,
  name: string,
  cfg: ServerConfig,
  registry: McpServerEntry[],
  line?: number,
): Finding | undefined {
  const finding = (
    ruleId: string,
    message: string,
    fixHint: string,
    basis: string,
    level: Finding['level'] = 'error',
  ): Finding => ({
    checkId,
    ruleId,
    level,
    path,
    line,
    message,
    fixHint,
    fingerprintBasis: `${name}|${basis}`,
  });
  const statusProblem = (entry: McpServerEntry, what: string): Finding | undefined => {
    if (entry.status === 'approved') return undefined;
    if (entry.status === 'pending-inventory') {
      return finding(
        'pending',
        `MCP server "${name}" (${what}) is still pending the AI inventory.`,
        'Confirm it in the week-1 inventory.',
        what,
        'warning',
      );
    }
    return finding(
      'not-approved',
      `MCP server "${name}" (${what}) is ${entry.status} in the AI registry.`,
      'Remove it from the configuration.',
      what,
    );
  };

  if (typeof cfg.url === 'string') {
    const entry = registry.find((e) => e.match.url === cfg.url);
    if (!entry) {
      return finding(
        'unregistered',
        `MCP server "${name}" at ${cfg.url} is not in the AI registry.`,
        'Remove it, or propose it in registry/ai-registry.yaml with an owner and a review date (R14-6).',
        cfg.url,
      );
    }
    return statusProblem(entry, cfg.url);
  }

  const command = typeof cfg.command === 'string' ? cfg.command : '';
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [];
  const spec = packageSpecOf(command, args);
  if (!spec) {
    const full = [command, ...args].join(' ').trim();
    const entry = registry.find((e) => e.match.command === full);
    if (!entry) {
      return finding(
        'unregistered',
        `MCP server "${name}" (${full || 'no command'}) is not in the AI registry.`,
        'Remove it, or register its exact command in registry/ai-registry.yaml (R14-6).',
        full,
      );
    }
    return statusProblem(entry, full);
  }

  const { name: pkg, version } = parsePackageSpec(spec);
  const entry = registry.find((e) => e.match.package === pkg);
  if (!entry) {
    return finding(
      'unregistered',
      `MCP server "${name}" runs package ${pkg}, which is not in the AI registry.`,
      'Remove it, or propose it in registry/ai-registry.yaml with an owner and a review date (R14-6).',
      pkg,
    );
  }
  if (!version || !EXACT_VERSION.test(version)) {
    return finding(
      'unpinned',
      `MCP server "${name}" runs ${pkg} without an exact version${version ? ` (${version})` : ''}.`,
      `Pin an approved version, e.g. ${pkg}@${entry.match.versions?.[0] ?? 'x.y.z'}.`,
      `${pkg}@${version ?? ''}`,
    );
  }
  if (entry.match.versions && !entry.match.versions.includes(version)) {
    return finding(
      'version-not-approved',
      `MCP server "${name}" runs ${pkg}@${version}; approved versions are ${entry.match.versions.join(', ')}.`,
      'Use an approved version, or approve this one in the registry.',
      `${pkg}@${version}`,
    );
  }
  return statusProblem(entry, `${pkg}@${version}`);
}

export function mcpAllowlist(ctx: RunContext, def: CheckDefinition): Finding[] {
  const findings: Finding[] = [];
  const registry = ctx.config.registry.mcp_servers;
  for (const file of ctx.filesFor(def)) {
    if (!MCP_CONFIG.test(file.path)) continue;
    const text = ctx.source.read(file.path);
    if (text === undefined) continue;
    let doc: { mcpServers?: unknown; servers?: unknown };
    try {
      doc = JSON.parse(stripJsonc(text));
    } catch {
      findings.push({
        checkId: def.id,
        ruleId: 'unparseable',
        level: 'error',
        path: file.path,
        message: 'MCP configuration is not valid JSON, so its servers cannot be checked.',
        fixHint: 'Fix the syntax.',
        fingerprintBasis: 'unparseable',
      });
      continue;
    }
    const servers = (doc?.mcpServers ?? doc?.servers) as Record<string, ServerConfig> | undefined;
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, cfg] of Object.entries(servers)) {
      const f = checkServer(def.id, file.path, name, cfg ?? {}, registry, lineOf(text, name));
      if (f) findings.push(f);
    }
  }
  return findings;
}
