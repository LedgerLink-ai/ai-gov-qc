import { checkTrailers, messageLines, parseTrailerValue } from '../src/checks/commit-trailer';
import type { AiRegistry } from '../src/types';

const registry: AiRegistry = {
  version: 1,
  updated: '2026-10-22',
  agents: [],
  mcp_servers: [],
  tools: [
    {
      id: 'cursor',
      name: 'Cursor',
      vendor: 'v',
      status: 'approved',
      tier: 'b',
      models: ['*'],
      owner: 'o',
      review_by: '2026-11-06',
      trailer_aliases: ['cursoragent@cursor.com'],
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      vendor: 'v',
      status: 'approved',
      tier: 'b',
      models: ['model-a'],
      owner: 'o',
      review_by: '2026-11-06',
      trailer_aliases: ['noreply@anthropic.com'],
    },
    {
      id: 'retired-tool',
      name: 'Old',
      vendor: 'v',
      status: 'retired',
      tier: 'b',
      models: ['*'],
      owner: 'o',
      review_by: '2026-11-06',
    },
  ],
};
const rules = (message: string) => checkTrailers('commit.trailer', message, registry).map((f) => f.ruleId);

describe('commit.trailer', () => {
  it('has nothing to say about a commit without AI trailers (P10)', () => {
    expect(rules('fix: typo\n')).toEqual([]);
  });

  it('accepts "<tool>, <model>, <version>" by tool id or display name, any case', () => {
    expect(rules('fix: x\n\nAssisted-by: Cursor, gpt-5, 1.7.0\n')).toEqual([]);
    expect(rules('fix: x\n\nassisted-by: claude code, model-a, v2.1.3\n')).toEqual([]);
    expect(rules('fix: x\n\nAssisted-by: claude-code, MODEL-A, 2.1.3-beta.1\n')).toEqual([]);
  });

  it('rejects malformed trailers, including the old tool/model form', () => {
    expect(rules('x\n\nAssisted-by: cursor\n')).toEqual(['malformed']);
    expect(rules('x\n\nAssisted-by: cursor/gpt-5\n')).toEqual(['malformed']);
    expect(rules('x\n\nAssisted-by: Cursor, gpt-5\n')).toEqual(['malformed']);
    expect(rules('x\n\nAssisted-by: Cursor, gpt-5, latest\n')).toEqual(['malformed']);
  });

  it('rejects unregistered, retired and unapproved-model trailers', () => {
    expect(rules('x\n\nAssisted-by: Windsurf, swe-1, 1.12.0\n')).toEqual(['unregistered-tool']);
    expect(rules('x\n\nAssisted-by: retired-tool, m, 1.0\n')).toEqual(['tool-not-approved']);
    expect(rules('x\n\nAssisted-by: Claude Code, model-b, 2.0.0\n')).toEqual(['model-not-approved']);
  });

  it('ignores comment lines and anything below the scissors line, as git does', () => {
    expect(rules('x\n# Assisted-by: windsurf, swe-1, 1.0\n')).toEqual([]);
    expect(rules('x\n# ------------------------ >8 ------------------------\nAssisted-by: bad\n')).toEqual([]);
    expect(messageLines('a\n# ------------------------ >8 ------------------------\ndiff --git')).toEqual(['a']);
  });

  it('notes a Co-authored-by AI declaration without Assisted-by, without blocking', () => {
    const findings = checkTrailers(
      'commit.trailer',
      'x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>\n',
      registry,
    );
    expect(findings.map((f) => [f.ruleId, f.level])).toEqual([['co-author-only', 'note']]);
  });

  it('does not add the note when Assisted-by is present', () => {
    expect(
      rules('x\n\nAssisted-by: Cursor, gpt-5, 1.7.0\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>\n'),
    ).toEqual([]);
  });

  it('parses the three parts of a trailer value', () => {
    expect(parseTrailerValue(' Cursor ,  gpt-5 , 1.7.0 ')).toEqual({
      tool: 'Cursor',
      model: 'gpt-5',
      version: '1.7.0',
    });
    expect(parseTrailerValue('Cursor, , 1.7.0')).toBeUndefined();
  });
});
