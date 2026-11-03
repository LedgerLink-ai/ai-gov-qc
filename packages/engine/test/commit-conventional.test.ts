import { checkConventional } from '../src/checks/commit-conventional';

const rules = (message: string) => checkConventional('commit.conventional', message).map((f) => f.ruleId);

describe('commit.conventional', () => {
  it('accepts the documented format: header, blank line, Refs, optional body and Assisted-by', () => {
    expect(rules('feat(payments): add idempotency key to refund endpoint\n\nRefs: LL-1423\n')).toEqual([]);
    expect(rules('fix: handle empty batch\n\nRetry once.\n\nRefs: LD-480, LD-481\n')).toEqual([]);
    expect(
      rules('refactor(ledger)!: split posting service\n\nRefs: F2SAT-12\nAssisted-by: Cursor, gpt-5, 1.7.0\n'),
    ).toEqual([]);
  });

  it('accepts messages git writes itself', () => {
    expect(rules("Merge branch 'main' into feature/x\n")).toEqual([]);
    expect(rules('Merge pull request #12 from org/branch\n')).toEqual([]);
    expect(rules('Revert "feat: add x"\n\nThis reverts commit abc.\n')).toEqual([]);
    expect(rules('fixup! feat: add x\n')).toEqual([]);
  });

  it('rejects free-form headers, ticket-prefix headers and unknown types', () => {
    expect(rules('Fixed the retry thing\n\nRefs: LD-1\n')).toEqual(['not-conventional']);
    expect(rules('LD-475: add toggles\n\nRefs: LD-475\n')).toEqual(['not-conventional']);
    expect(rules('test:pre-commit checks\n\nRefs: LD-1\n')).toEqual(['not-conventional']);
    expect(rules('feature: add x\n\nRefs: LD-1\n')).toEqual(['unknown-type']);
    expect(rules('Feat: add x\n\nRefs: LD-1\n')).toEqual(['unknown-type']);
  });

  it('requires the Refs ticket line, well formed', () => {
    expect(rules('feat: add x\n')).toEqual(['missing-ticket']);
    expect(rules('feat: add x\n\nRefs: the dashboard ticket\n')).toEqual(['malformed-ticket']);
    expect(rules('feat: add x\n\nRefs: ld-480\n')).toEqual(['malformed-ticket']);
  });

  it('requires a blank line after the header', () => {
    expect(rules('feat: add x\nRefs: LD-1\n')).toEqual(['no-blank-line']);
  });

  it('skips comment lines and warns on a long header', () => {
    expect(rules('# Please enter the commit message\nfix: x\n\nRefs: LD-1\n')).toEqual([]);
    const findings = checkConventional('commit.conventional', `fix: ${'a'.repeat(120)}\n\nRefs: LD-1\n`);
    expect(findings.map((f) => [f.ruleId, f.level])).toEqual([['header-too-long', 'warning']]);
  });
});
