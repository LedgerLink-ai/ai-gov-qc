import { checkServer, packageSpecOf, parsePackageSpec, stripJsonc } from '../src/checks/mcp-allowlist';
import type { McpServerEntry } from '../src/types';

const registry: McpServerEntry[] = [
  {
    id: 'ledgerlink-qa',
    status: 'approved',
    owner: 'x',
    match: { package: '@ledgerlink/qa-mcp', versions: ['0.1.0', '0.2.0'] },
  },
  { id: 'kb', status: 'approved', owner: 'x', match: { url: 'https://kb.internal/mcp' } },
  { id: 'old', status: 'blocked', owner: 'x', match: { package: 'old-mcp' } },
  { id: 'local-bin', status: 'approved', owner: 'x', match: { command: 'node tools/mcp.js' } },
];
const check = (cfg: object) => checkServer('ai-config.mcp-allowlist', '.mcp.json', 's', cfg, registry);

describe('MCP config parsing', () => {
  it('strips JSONC comments and trailing commas but not slashes inside strings', () => {
    const text = '{\n // note\n "a": "http://x//y", /* block */ "b": [1,],\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: 'http://x//y', b: [1] });
  });

  it('parses scoped and unscoped package specs', () => {
    expect(parsePackageSpec('@ledgerlink/qa-mcp@1.4.0')).toEqual({ name: '@ledgerlink/qa-mcp', version: '1.4.0' });
    expect(parsePackageSpec('@ledgerlink/qa-mcp')).toEqual({ name: '@ledgerlink/qa-mcp' });
    expect(parsePackageSpec('tool@latest')).toEqual({ name: 'tool', version: 'latest' });
  });

  it('finds the package for npx, npx.cmd and pnpm dlx, and nothing for other commands', () => {
    expect(packageSpecOf('npx', ['-y', 'pkg@1.0.0'])).toBe('pkg@1.0.0');
    expect(packageSpecOf('C:\\Program Files\\nodejs\\npx.cmd', ['--yes', 'pkg@1.0.0'])).toBe('pkg@1.0.0');
    expect(packageSpecOf('pnpm', ['dlx', 'pkg@1.0.0'])).toBe('pkg@1.0.0');
    expect(packageSpecOf('pnpm', ['install'])).toBeUndefined();
    expect(packageSpecOf('node', ['server.js'])).toBeUndefined();
  });
});

describe('ai-config.mcp-allowlist', () => {
  it('accepts an approved package at an approved exact version', () => {
    expect(check({ command: 'npx', args: ['-y', '@ledgerlink/qa-mcp@0.2.0'] })).toBeUndefined();
  });

  it.each([
    [{ command: 'npx', args: ['-y', 'unknown-mcp@1.0.0'] }, 'unregistered'],
    [{ command: 'npx', args: ['-y', '@ledgerlink/qa-mcp'] }, 'unpinned'],
    [{ command: 'npx', args: ['-y', '@ledgerlink/qa-mcp@^0.1.0'] }, 'unpinned'],
    [{ command: 'npx', args: ['-y', '@ledgerlink/qa-mcp@latest'] }, 'unpinned'],
    [{ command: 'npx', args: ['-y', '@ledgerlink/qa-mcp@9.9.9'] }, 'version-not-approved'],
    [{ command: 'npx', args: ['-y', 'old-mcp@1.0.0'] }, 'not-approved'],
    [{ url: 'https://evil.example/mcp' }, 'unregistered'],
    [{ command: 'python', args: ['server.py'] }, 'unregistered'],
  ])('rejects %j as %s', (cfg, rule) => {
    const f = check(cfg);
    expect(f?.ruleId).toBe(rule);
    expect(f?.level).toBe('error');
  });

  it('accepts registered URLs and exact commands', () => {
    expect(check({ url: 'https://kb.internal/mcp' })).toBeUndefined();
    expect(check({ command: 'node', args: ['tools/mcp.js'] })).toBeUndefined();
  });
});
