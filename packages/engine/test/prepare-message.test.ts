import { prepareMessage, ticketFromBranch, type PrepareInput } from '../src/prepare-message';
import type { AiRegistry } from '../src/types';

const tool = (id: string, name: string, alias: string) => ({
  id,
  name,
  vendor: 'v',
  status: 'approved' as const,
  tier: 'b',
  models: ['*'],
  owner: 'o',
  review_by: '2026-11-06',
  trailer_aliases: [alias],
});
const registry: AiRegistry = {
  version: 1,
  updated: '2026-11-03',
  agents: [],
  mcp_servers: [],
  tools: [
    tool('cursor', 'Cursor', 'cursoragent@cursor.com'),
    tool('claude-code', 'Claude Code', 'noreply@anthropic.com'),
  ],
};

const DEFAULT = 'Cursor, gpt-5, 1.7.0';
const prep = (message: string, over: Partial<PrepareInput> = {}) =>
  prepareMessage({ message, source: 'message', branch: 'LCORE-210-limit-invariants', registry, ...over });

describe('ticket key from the branch name', () => {
  it('reads an upper-case key at the start of the branch or of a path segment', () => {
    expect(ticketFromBranch('LCORE-210-limit-invariants')).toBe('LCORE-210');
    expect(ticketFromBranch('feature/LWMNG-141-stop-logging')).toBe('LWMNG-141');
    expect(ticketFromBranch('LD-480')).toBe('LD-480');
  });

  it('finds none in branches without one', () => {
    for (const b of ['main', 'develop', 'chore/precommit-local-checks', 'lcore-210-x', 'release-2-0', 'HEAD'])
      expect(ticketFromBranch(b)).toBeUndefined();
  });
});

describe('prepare-commit-msg', () => {
  it('prefixes the subject with the ticket key from the branch', () => {
    const r = prep('Add idempotency key to refund endpoint\n');
    expect(r.message).toBe('LCORE-210: Add idempotency key to refund endpoint\n');
    expect(r.notes).toEqual(['added "LCORE-210: " from branch LCORE-210-limit-invariants']);
  });

  it('leaves a subject that already starts with a ticket key, any project', () => {
    expect(prep('LWMNG-141: Stop logging the API key\n').message).toBe('LWMNG-141: Stop logging the API key\n');
    expect(prep('LCORE-210 tidy\n').notes).toEqual([]);
  });

  it('enforces no subject format: a Conventional Commits subject only gains the key', () => {
    expect(prep('feat(payments): add key\n').message).toBe('LCORE-210: feat(payments): add key\n');
  });

  it('adds the Assisted-by default after a blank line, and says so', () => {
    const r = prep('Add retry\n', { branch: 'main', assistedBy: DEFAULT });
    expect(r.message).toBe(`Add retry\n\nAssisted-by: ${DEFAULT}\n`);
    expect(r.notes).toEqual([`added "Assisted-by: ${DEFAULT}"; delete it if no AI was used (git commit --amend)`]);
  });

  it('appends to an existing trailer block instead of starting a new one', () => {
    const r = prep('Fix\n\nBody text.\n\nSigned-off-by: A <a@example.invalid>\n', {
      branch: 'main',
      assistedBy: DEFAULT,
    });
    expect(r.message).toBe(`Fix\n\nBody text.\n\nSigned-off-by: A <a@example.invalid>\nAssisted-by: ${DEFAULT}\n`);
  });

  it('does not add a second Assisted-by', () => {
    const msg = 'Fix\n\nAssisted-by: Claude Code, model-a, 2.1.0\n';
    expect(prep(msg, { branch: 'main', assistedBy: DEFAULT }).message).toBe(msg);
  });

  it("pre-fills an empty message in the editor above git's comment lines", () => {
    const editor = '\n# Please enter the commit message for your changes.\n#\n';
    const r = prep(editor, { source: '', assistedBy: DEFAULT });
    expect(r.message).toBe(
      `LCORE-210: \n\nAssisted-by: ${DEFAULT}\n\n# Please enter the commit message for your changes.\n#\n`,
    );
  });

  it('ignores what git commit -v shows below the scissors line', () => {
    const msg = 'Fix\n# ------------------------ >8 ------------------------\n Assisted-by: inside a diff\n';
    expect(prep(msg, { branch: 'main', assistedBy: DEFAULT }).message).toBe(
      `Fix\n\nAssisted-by: ${DEFAULT}\n# ------------------------ >8 ------------------------\n Assisted-by: inside a diff\n`,
    );
  });

  it('converts an AI Co-authored-by line to Assisted-by, using the default when it names that tool', () => {
    const r = prep('Fix\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>\n', {
      branch: 'main',
      assistedBy: DEFAULT,
    });
    expect(r.message).toBe(`Fix\n\nAssisted-by: ${DEFAULT}\n`);
  });

  it('converts a Co-authored-by line of another tool with placeholders to fill in', () => {
    const r = prep('Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>\n', { branch: 'main', assistedBy: DEFAULT });
    expect(r.message).toBe('Fix\n\nAssisted-by: Claude Code, <model>, <version>\n');
    expect(r.notes[0]).toMatch(/fill in the model and version/);
  });

  it('leaves human co-authors alone', () => {
    const msg = 'Fix\n\nCo-authored-by: Priya <priya@example.invalid>\n';
    expect(prep(msg, { branch: 'main' }).message).toBe(msg);
  });

  it('leaves merges, squashes, amends and git-written subjects alone', () => {
    for (const source of ['merge', 'squash', 'commit'])
      expect(prep("Merge branch 'x'\n", { source, assistedBy: DEFAULT }).message).toBe("Merge branch 'x'\n");
    for (const msg of [
      'fixup! LCORE-1: Add x\n',
      'squash! Add x\n',
      'Revert "Add x"\n\nThis reverts commit abc1234.\n',
    ])
      expect(prep(msg, { assistedBy: DEFAULT }).message).toBe(msg);
  });

  it('ignores a malformed default and says why', () => {
    const r = prep('Fix\n', { branch: 'main', assistedBy: 'cursor/gpt-5' });
    expect(r.message).toBe('Fix\n');
    expect(r.notes).toEqual([
      'ledgerlink.assistedBy "cursor/gpt-5" is not "Assisted-by: <tool>, <model>, <version>"; not used',
    ]);
  });

  it('keeps Windows line endings', () => {
    expect(prep('Add retry\r\n', { assistedBy: DEFAULT }).message).toBe(
      `LCORE-210: Add retry\r\n\r\nAssisted-by: ${DEFAULT}\r\n`,
    );
  });
});
