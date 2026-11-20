import { posix } from 'node:path';
import type { CheckDefinition, Finding, McpServerEntry, RunContext } from '../types';

// C14-6 / R14-6: only registry-listed MCP servers, pinned to an approved version.

/**
 * Any JSON (or JSONC) file is a candidate MCP configuration, not just a
 * fixed list of filenames: `ctx.filesFor(def)` already scopes this check to
 * `ai-config`-tagged paths (path-tags.yaml), and `serverMaps()` below only
 * reports something when the file actually has an MCP server map. So a new
 * or unlisted tool (Windsurf, opencode, Cline, ...) is checked as soon as its
 * path is tagged `ai-config`, with no engine change.
 */
const MCP_JSON = /\.jsonc?$/i;
/**
 * Files that are MCP configurations by name (Claude Code's .mcp.json, every
 * <tool>/mcp.json, Windsurf's mcp_config.json, VS Code and Gemini settings,
 * opencode.json). Only in these is the generic "servers" key read, and a file
 * that cannot be parsed reported; any other JSON file under an ai-config path
 * (a data file in context/, say) is checked only when it holds an
 * "mcpServers" or "mcp" map, so an unrelated "servers" list is not mistaken
 * for MCP servers.
 */
const MCP_CONFIG_NAME =
  /(^|\/)(?:\.mcp\.json|mcp\.jsonc?|mcp_config\.json|\.vscode\/settings\.json|\.gemini\/settings\.json|opencode\.jsonc?)$/i;
/** Text that names an MCP map: a file that fails to parse is reported only then. */
const MCP_KEY_TEXT = /"(?:mcpServers|mcp|mcp\.servers)"\s*:/;
/** Codex CLI: [mcp_servers.<name>] tables in TOML. */
const MCP_TOML = /(^|\/)\.codex\/config\.toml$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+].*)?$/;
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const DLX_RUNNERS = new Set(['pnpm', 'yarn', 'bun']);
/** Runner flags that only change output or confirmation, never what is installed or from where. */
const SAFE_RUNNER_FLAGS = new Set(['-y', '--yes', '--quiet', '--silent']);
/** npm package names, scoped or not; anything else (a URL, a path, a git spec) is not shown in messages. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
/**
 * Environment variables that change where a package runner installs from or
 * what the runtime loads: a registry or index override, or injected code.
 */
const UNSAFE_ENV =
  /^(?:npm_config_.*|.*REGISTRY.*|NODE_OPTIONS|NODE_PATH|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|PIP_FIND_LINKS|PIP_TRUSTED_HOST|UV_INDEX_URL|UV_EXTRA_INDEX_URL|UV_DEFAULT_INDEX|UV_INDEX|UV_FIND_LINKS|PYTHONPATH|LD_PRELOAD|DYLD_INSERT_LIBRARIES|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i;

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
  return dropTrailingCommas(out);
}

/** Drops a comma followed only by whitespace and "}" or "]", outside strings ("a,]" in a value stays). */
function dropTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

export function parsePackageSpec(spec: string): { name: string; version?: string } {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec };
}

/** The runner's own arguments (before the package), or undefined when the command is not a package runner. */
function runnerArgs(command: string, args: string[]): string[] | undefined {
  const runner = posix.basename(command.replace(/\\/g, '/')).replace(/\.(cmd|exe)$/i, '');
  if (DLX_RUNNERS.has(runner)) return args[0] === 'dlx' ? args.slice(1) : undefined;
  return PACKAGE_RUNNERS.has(runner) ? args : undefined;
}

/** The package an npx-style command launches, if it is one. */
export function packageSpecOf(command: string, args: string[]): string | undefined {
  const rest = runnerArgs(command, args);
  return rest?.find((a) => !a.startsWith('-'));
}

/**
 * A runner flag before the package that is not known to be safe, e.g.
 * --registry=, --package=, -p, --prefix: each can change what runs.
 * Returns the flag name only (never its value).
 */
export function unsafeRunnerFlag(command: string, args: string[]): string | undefined {
  const rest = runnerArgs(command, args);
  if (!rest) return undefined;
  for (const a of rest) {
    if (!a.startsWith('-')) return undefined;
    if (!SAFE_RUNNER_FLAGS.has(a)) return a.split('=')[0];
  }
  return undefined;
}

/** Scheme and host of a URL, never its path, query or credentials. */
export function urlForDisplay(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'an unparseable URL';
  }
}

const commandForDisplay = (command: string): string =>
  command ? posix.basename(command.replace(/\\/g, '/')) : 'no command';

const versionForDisplay = (version: string): string => (/^[\w.^~<>=*|+-]{1,40}$/.test(version) ? version : '...');

function lineOf(text: string, name: string): number | undefined {
  const index = text.indexOf(`"${name}"`);
  return index < 0 ? undefined : text.slice(0, index).split('\n').length;
}

export interface ServerConfig {
  command?: unknown;
  args?: unknown;
  url?: unknown;
  /** Gemini CLI's streamable HTTP endpoint. */
  httpUrl?: unknown;
  /** Windsurf's endpoint name. */
  serverUrl?: unknown;
  env?: unknown;
  /** opencode's name for env. */
  environment?: unknown;
}

/**
 * opencode writes a server as { "command": ["npx", "-y", "pkg@1.0.0"],
 * "environment": { ... } }: the command and its arguments in one array, and
 * the variables under "environment". Both are read as command/args and env.
 */
function normaliseServer(cfg: ServerConfig): ServerConfig {
  const out: ServerConfig = { ...cfg };
  if (Array.isArray(cfg.command)) {
    const [command, ...rest] = cfg.command as unknown[];
    out.command = typeof command === 'string' ? command : '';
    out.args = [...rest, ...(Array.isArray(cfg.args) ? cfg.args : [])];
  }
  if (cfg.environment !== undefined) {
    const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    // Both present: either one that is not a map is kept, so it is reported.
    if (cfg.env === undefined || !isMap(cfg.environment)) out.env = cfg.environment;
    else if (isMap(cfg.env)) out.env = { ...cfg.environment, ...cfg.env };
  }
  return out;
}

export function checkServer(
  checkId: string,
  path: string,
  name: string,
  cfg: ServerConfig,
  registry: McpServerEntry[],
  line?: number,
  asOf?: string,
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
  const statusProblem = (entry: McpServerEntry, what: string, shown: string): Finding | undefined => {
    if (entry.status === 'approved') return undefined;
    if (entry.status === 'pending-inventory') {
      const overdue = entry.review_by !== undefined && asOf !== undefined && asOf > entry.review_by;
      if (!overdue) {
        return finding(
          'pending',
          `MCP server "${name}" (${shown}) is still pending the AI inventory.`,
          'Confirm it in the week-1 inventory.',
          what,
          'warning',
        );
      }
      return finding(
        'pending-overdue',
        `MCP server "${name}" (${shown}) is still pending the AI inventory, past its ${entry.review_by} review date.`,
        'Confirm it in registry/ai-registry.yaml (approved or not-approved), or remove it from the configuration.',
        what,
      );
    }
    return finding(
      'not-approved',
      `MCP server "${name}" (${shown}) is ${entry.status} in the AI registry.`,
      'Remove it from the configuration.',
      what,
    );
  };

  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return finding(
      'unparseable',
      `MCP server "${name}" is not an object, so it cannot be checked.`,
      'Fix the configuration.',
      'not-an-object',
    );
  }
  cfg = normaliseServer(cfg);

  // Environment that redirects installs or injects code, whatever the server is.
  if (cfg.env !== undefined) {
    if (cfg.env === null || typeof cfg.env !== 'object' || Array.isArray(cfg.env)) {
      return finding(
        'unsafe-env',
        `MCP server "${name}" has an "env" that is not an object, so it cannot be checked.`,
        'Make "env" an object of variable names to values.',
        'env-not-object',
      );
    }
    const bad = Object.keys(cfg.env).filter((k) => UNSAFE_ENV.test(k));
    if (bad.length > 0) {
      return finding(
        'unsafe-env',
        `MCP server "${name}" sets ${bad.join(', ')}, which can change where packages are installed from or what code runs.`,
        'Remove the variable. Registries and runtime options are not set per MCP server (R14-6).',
        `env:${bad.sort().join(',')}`,
      );
    }
  }

  const urls = [cfg.url, cfg.httpUrl, cfg.serverUrl].filter((u): u is string => typeof u === 'string');
  for (const url of urls) {
    const entry = registry.find((e) => e.match.url === url);
    const shown = urlForDisplay(url);
    if (!entry) {
      return finding(
        'unregistered',
        `MCP server "${name}" at ${shown} is not in the AI registry.`,
        'Remove it, or propose it in registry/ai-registry.yaml with an owner and a review date (R14-6).',
        url,
      );
    }
    const problem = statusProblem(entry, url, shown);
    if (problem) return problem;
  }
  if (urls.length > 0 && cfg.command === undefined) return undefined;

  const command = typeof cfg.command === 'string' ? cfg.command : '';
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [];
  const flag = unsafeRunnerFlag(command, args);
  if (flag) {
    return finding(
      'unsafe-runner-flag',
      `MCP server "${name}" passes ${flag} to ${commandForDisplay(command)}; it can change which package runs or where it comes from.`,
      'Launch the package with only -y/--yes, e.g. npx -y <package>@<version> (R14-6).',
      `flag:${flag}`,
    );
  }
  const spec = packageSpecOf(command, args);
  if (!spec) {
    const full = [command, ...args].join(' ').trim();
    const entry = registry.find((e) => e.match.command === full);
    const shown = `command ${commandForDisplay(command)}`;
    if (!entry) {
      return finding(
        'unregistered',
        `MCP server "${name}" (${shown}) is not in the AI registry.`,
        'Remove it, or register its exact command in registry/ai-registry.yaml (R14-6).',
        full,
      );
    }
    return statusProblem(entry, full, shown);
  }

  const { name: pkg, version } = parsePackageSpec(spec);
  const pkgShown = PACKAGE_NAME.test(pkg) ? pkg : 'a package spec that is not a registry package name';
  const entry = registry.find((e) => e.match.package === pkg);
  if (!entry) {
    return finding(
      'unregistered',
      `MCP server "${name}" runs ${PACKAGE_NAME.test(pkg) ? `package ${pkg}` : pkgShown}, which is not in the AI registry.`,
      'Remove it, or propose it in registry/ai-registry.yaml with an owner and a review date (R14-6).',
      pkg,
    );
  }
  if (!version || !EXACT_VERSION.test(version)) {
    return finding(
      'unpinned',
      `MCP server "${name}" runs ${pkgShown} without an exact version${version ? ` (${versionForDisplay(version)})` : ''}.`,
      `Pin an approved version, e.g. ${pkg}@${entry.match.versions?.[0] ?? 'x.y.z'}.`,
      `${pkg}@${version ?? ''}`,
    );
  }
  if (entry.match.versions && !entry.match.versions.includes(version)) {
    return finding(
      'version-not-approved',
      `MCP server "${name}" runs ${pkgShown}@${versionForDisplay(version)}; approved versions are ${entry.match.versions.join(', ')}.`,
      'Use an approved version, or approve this one in the registry.',
      `${pkg}@${version}`,
    );
  }
  return statusProblem(entry, `${pkg}@${version}`, `${pkgShown}@${versionForDisplay(version)}`);
}

// ---- Codex config.toml: the minimal TOML subset its [mcp_servers.<name>] tables use ----

class TomlSubsetError extends Error {}

/** Parses one TOML value at `s[i]`: strings, arrays, inline tables, booleans, numbers. */
function tomlValue(s: string, i: number): [unknown, number] {
  const skip = (j: number): number => {
    while (j < s.length && /\s/.test(s[j])) j++;
    return j;
  };
  i = skip(i);
  const ch = s[i];
  if (s.startsWith('"""', i) || s.startsWith("'''", i)) throw new TomlSubsetError('multi-line string');
  if (ch === '"') {
    let out = '';
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j];
      if (c === '"') return [out, j + 1];
      if (c === '\n') break;
      if (c === '\\') {
        const e = s[++j];
        const simple: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
        if (e in simple) out += simple[e];
        else if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8;
          const hexDigits = s.slice(j + 1, j + 1 + len);
          if (!/^[0-9a-fA-F]+$/.test(hexDigits) || hexDigits.length !== len) throw new TomlSubsetError('escape');
          out += String.fromCodePoint(parseInt(hexDigits, 16));
          j += len;
        } else throw new TomlSubsetError('escape');
      } else out += c;
    }
    throw new TomlSubsetError('unterminated string');
  }
  if (ch === "'") {
    const end = s.indexOf("'", i + 1);
    if (end < 0 || s.slice(i + 1, end).includes('\n')) throw new TomlSubsetError('unterminated string');
    return [s.slice(i + 1, end), end + 1];
  }
  if (ch === '[') {
    const arr: unknown[] = [];
    let j = i + 1;
    for (;;) {
      j = skipComments(s, skip(j));
      if (s[j] === ']') return [arr, j + 1];
      const [v, next] = tomlValue(s, j);
      arr.push(v);
      j = skipComments(s, skip(next));
      if (s[j] === ',') j++;
      else if (s[j] !== ']') throw new TomlSubsetError('array');
    }
  }
  if (ch === '{') {
    const table: Record<string, unknown> = {};
    let j = skip(i + 1);
    if (s[j] === '}') return [table, j + 1];
    for (;;) {
      const [key, afterKey] = tomlKey(s, skip(j));
      j = skip(afterKey);
      if (s[j] !== '=') throw new TomlSubsetError('inline table');
      const [v, next] = tomlValue(s, j + 1);
      if (key.length !== 1) throw new TomlSubsetError('dotted key in inline table');
      table[key[0]] = v;
      j = skip(next);
      if (s[j] === ',') j = skip(j + 1);
      else if (s[j] === '}') return [table, j + 1];
      else throw new TomlSubsetError('inline table');
    }
  }
  const m = /^(?:true|false|[+-]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?)/.exec(s.slice(i));
  if (m) return [m[0] === 'true' ? true : m[0] === 'false' ? false : Number(m[0].replace(/_/g, '')), i + m[0].length];
  throw new TomlSubsetError('value');
}

function skipComments(s: string, j: number): number {
  while (s[j] === '#') {
    while (j < s.length && s[j] !== '\n') j++;
    while (j < s.length && /\s/.test(s[j])) j++;
  }
  return j;
}

/** A dotted key: bare or quoted parts. */
function tomlKey(s: string, i: number): [string[], number] {
  const parts: string[] = [];
  let j = i;
  for (;;) {
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (s[j] === '"' || s[j] === "'") {
      const [v, next] = tomlValue(s, j);
      parts.push(v as string);
      j = next;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(j));
      if (!m) throw new TomlSubsetError('key');
      parts.push(m[0]);
      j += m[0].length;
    }
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (s[j] !== '.') return [parts, j];
    j++;
  }
}

interface TomlServer {
  name: string;
  line: number;
  cfg: Record<string, unknown>;
}

/**
 * The MCP servers in a Codex config.toml. Understands the subset Codex
 * documents ([mcp_servers.<name>] and [mcp_servers.<name>.env] tables with
 * strings, arrays and inline tables); throws TomlSubsetError on anything else
 * that touches mcp_servers, so the check fails closed.
 */
export function parseCodexServers(text: string): TomlServer[] {
  const servers = new Map<string, TomlServer>();
  if (/"""|'''/.test(text) && /mcp_servers/.test(text)) throw new TomlSubsetError('multi-line string');
  let table: string[] = [];
  let i = 0;
  let lineNo = 1;
  const advance = (to: number): void => {
    for (let k = i; k < to && k < text.length; k++) if (text[k] === '\n') lineNo++;
    i = to;
  };
  const server = (name: string, line: number): TomlServer => {
    let s = servers.get(name);
    if (!s) {
      s = { name, line, cfg: {} };
      servers.set(name, s);
    }
    return s;
  };
  while (i < text.length) {
    // Skip blank lines and comments.
    const ws = /^[ \t\r\n]*/.exec(text.slice(i))?.[0].length ?? 0;
    advance(i + ws);
    if (i >= text.length) break;
    if (text[i] === '#') {
      const end = text.indexOf('\n', i);
      advance(end < 0 ? text.length : end);
      continue;
    }
    const lineEnd = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i);
    if (text[i] === '[') {
      const header = text.slice(i, lineEnd).replace(/#.*$/, '').trim();
      if (header.startsWith('[[')) {
        if (header.includes('mcp_servers')) throw new TomlSubsetError('array of tables');
        table = ['(array)'];
      } else {
        let key: string[] | undefined;
        try {
          const [k, end] = tomlKey(header, 1);
          if (header.endsWith(']') && header.slice(end).trim() === ']') key = k;
        } catch {
          key = undefined;
        }
        if (!key) {
          if (header.includes('mcp_servers')) throw new TomlSubsetError('table header');
          // Not a header we understand (or an array continuation): it cannot name mcp_servers.
          advance(lineEnd);
          continue;
        }
        table = key;
        if (table[0] === 'mcp_servers' && table.length >= 2) server(table[1], lineNo);
        else if (table[0] === 'mcp_servers') throw new TomlSubsetError('mcp_servers table');
      }
      advance(lineEnd);
      continue;
    }
    // key = value
    let key: string[];
    let at: number;
    try {
      [key, at] = tomlKey(text, i);
    } catch (err) {
      if (table[0] === 'mcp_servers' || text.slice(i, lineEnd).includes('mcp_servers')) throw err;
      advance(lineEnd);
      continue;
    }
    while (text[at] === ' ' || text[at] === '\t') at++;
    const full = [...table, ...key];
    const relevant = full[0] === 'mcp_servers';
    if (text[at] !== '=') {
      if (relevant) throw new TomlSubsetError('key/value');
      advance(lineEnd);
      continue;
    }
    let value: unknown;
    let next: number;
    try {
      [value, next] = tomlValue(text, at + 1);
    } catch (err) {
      if (relevant) throw err;
      advance(lineEnd);
      continue;
    }
    const rest = text.slice(next, text.indexOf('\n', next) < 0 ? text.length : text.indexOf('\n', next));
    if (relevant && rest.trim() !== '' && !rest.trim().startsWith('#')) throw new TomlSubsetError('trailing text');
    if (relevant) {
      if (full.length < 2) throw new TomlSubsetError('mcp_servers value');
      if (full.length === 2) {
        // mcp_servers.<name> = { ... } inline
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TomlSubsetError('server');
        Object.assign(server(full[1], lineNo).cfg, value);
      } else {
        const s = server(full[1], lineNo);
        if (full.length === 3) s.cfg[full[2]] = value;
        else if (full[2] === 'env' && full.length === 4) {
          const env = (s.cfg.env ??= {}) as Record<string, unknown>;
          if (typeof env !== 'object' || Array.isArray(env)) throw new TomlSubsetError('env');
          env[full[3]] = value;
        } else if (['command', 'args', 'url', 'env'].includes(full[2])) {
          throw new TomlSubsetError('nested server key');
        }
      }
    }
    advance(next);
    const nl = text.indexOf('\n', i);
    advance(nl < 0 ? text.length : nl);
  }
  return [...servers.values()];
}

/**
 * The server maps in a JSON configuration: "mcpServers" (Claude Code,
 * Cursor, Gemini CLI, Roo Code, Windsurf, Cline), "servers" (VS Code
 * mcp.json; read only in a file named as an MCP configuration), VS Code
 * settings' "mcp": { "servers" } or "mcp.servers", and opencode's "mcp" map of
 * servers. Every key present is checked, so an empty map under one key cannot
 * hide servers under another.
 */
function serverMaps(doc: unknown, named: boolean): { maps: Array<Record<string, unknown>>; bad: string[] } {
  const maps: Array<Record<string, unknown>> = [];
  const bad: string[] = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { maps, bad: named ? ['(top level)'] : [] };
  const d = doc as Record<string, unknown>;
  const mcp = d.mcp && typeof d.mcp === 'object' && !Array.isArray(d.mcp) ? (d.mcp as Record<string, unknown>) : {};
  const candidates: Array<[string, unknown]> = [
    ['mcpServers', d.mcpServers],
    ['servers', named ? d.servers : undefined],
    ['mcp.servers', d['mcp.servers']],
    ['mcp.servers', mcp.servers],
  ];
  if (d.mcp !== undefined && mcp.servers === undefined) {
    if (d.mcp === null || typeof d.mcp !== 'object' || Array.isArray(d.mcp)) {
      if (named) bad.push('mcp');
    } else {
      // opencode: "mcp": { "<name>": { "type": "local", "command": [...] } }.
      // Values that are not objects (VS Code's "inputs" list, say) are not
      // servers: a server has to be an object to run at all.
      const servers = Object.entries(mcp).filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v));
      if (servers.length > 0) maps.push(Object.fromEntries(servers));
    }
  }
  for (const [key, value] of candidates) {
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) bad.push(key);
    else maps.push(value as Record<string, unknown>);
  }
  return { maps, bad };
}

export function mcpAllowlist(ctx: RunContext, def: CheckDefinition): Finding[] {
  const findings: Finding[] = [];
  const registry = ctx.config.registry.mcp_servers;
  const problem = (path: string, ruleId: string, message: string, fixHint: string, basis: string): Finding => ({
    checkId: def.id,
    ruleId,
    level: 'error',
    path,
    message,
    fixHint,
    fingerprintBasis: basis,
  });
  for (const file of ctx.filesFor(def)) {
    const isJson = MCP_JSON.test(file.path);
    const isToml = MCP_TOML.test(file.path);
    if (!isJson && !isToml) continue;
    const raw = ctx.source.read(file.path);
    if (raw === undefined) continue;
    const text = raw.replace(/^\uFEFF/, '');

    if (isToml) {
      let servers: TomlServer[];
      try {
        servers = parseCodexServers(text);
      } catch (err) {
        if (!(err instanceof TomlSubsetError)) throw err;
        findings.push(
          problem(
            file.path,
            'unsupported-format',
            'MCP config in an unsupported format needs review: the [mcp_servers] tables could not be read, so their servers cannot be checked.',
            'Use plain [mcp_servers.<name>] tables with command, args, env and url as strings, arrays and tables.',
            'unsupported-format',
          ),
        );
        continue;
      }
      for (const s of servers) {
        const f = checkServer(def.id, file.path, s.name, s.cfg as ServerConfig, registry, s.line, ctx.asOf);
        if (f) findings.push(f);
      }
      continue;
    }

    const named = MCP_CONFIG_NAME.test(file.path);
    let doc: unknown;
    try {
      doc = JSON.parse(stripJsonc(text));
    } catch {
      // A JSON file that is not an MCP configuration by name and never
      // mentions an MCP key is someone else's data: its syntax is not ours.
      if (!named && !MCP_KEY_TEXT.test(text)) continue;
      findings.push(
        problem(
          file.path,
          'unparseable',
          'MCP configuration is not valid JSON, so its servers cannot be checked.',
          'Fix the syntax.',
          'unparseable',
        ),
      );
      continue;
    }
    const { maps, bad } = serverMaps(doc, named);
    for (const key of bad) {
      findings.push(
        problem(
          file.path,
          'unparseable',
          `"${key}" in the MCP configuration is not an object, so its servers cannot be checked.`,
          'Make it an object of server names to server configurations.',
          `not-an-object:${key}`,
        ),
      );
    }
    for (const servers of maps) {
      for (const [name, cfg] of Object.entries(servers)) {
        const f = checkServer(
          def.id,
          file.path,
          name,
          (cfg ?? {}) as ServerConfig,
          registry,
          lineOf(text, name),
          ctx.asOf,
        );
        if (f) findings.push(f);
      }
    }
  }
  return findings;
}
