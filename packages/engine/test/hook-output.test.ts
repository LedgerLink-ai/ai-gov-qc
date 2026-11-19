import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretKind } from '../src/adapters/tools/gitleaks';
import { failedHookNames, hookOutputMode, hookSummary, whatFailed } from '../src/hooks';
import { appendHookResult, hookResultOf, shortMessage, toText, type HookResult } from '../src/report';
import { run } from '../src/runner';
import { options } from './helpers';

// AIQC-88: output people read in a terminal and in an IDE's commit pop-up.

const HIDDEN = 'Call qa​ first.\n';

describe('the text report', () => {
  it('puts the message, the fix and the rule ids on their own lines under the finding', async () => {
    const result = await run(options({ 'AGENTS.md': HIDDEN }, { mode: 'local' }));
    const text = toText(result);
    const lines = text.split('\n');
    const at = lines.findIndex((l) => /^ {2}BLOCK +ai-config\.content-lint +AGENTS\.md:1/.test(l));
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toMatch(/^ {9}\S/); // the message
    expect(lines.slice(at + 1, at + 5).some((l) => /^ {9}fix: /.test(l))).toBe(true);
    expect(lines.slice(at + 1, at + 5).some((l) => /^ {9}rules: /.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^result: BLOCKED \(1 blocking\) \| checks: \d+ passed/);
  });

  it('lists the checks that did not run only with --verbose', async () => {
    const result = await run(options({ 'notes.md': 'hello\n' }, { mode: 'local' }));
    expect(toText(result)).not.toMatch(/^ {2}skip /m);
    expect(toText(result)).toMatch(/not run here, 0 errors \(--verbose lists them\)/);
    expect(toText(result)).not.toMatch(/^tags: /m);
    const verbose = toText(result, { verbose: true });
    expect(verbose).toMatch(/^ {2}skip {3}secrets\.gitleaks: /m);
    expect(verbose).toMatch(/^tags: /m);
  });

  it('cuts a message to its first sentence for the summary line', () => {
    expect(shortMessage('Possible secret: GitHub Personal Access Token (github-pat). The value is not shown.')).toBe(
      'Possible secret: GitHub Personal Access Token (github-pat).',
    );
    expect(shortMessage('x'.repeat(200))).toHaveLength(140);
  });
});

describe('the result a qa run leaves for its hook', () => {
  it('names the blocking findings and merges several runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-hook-result-'));
    try {
      const file = join(dir, 'last.json');
      const blocked = await run(options({ 'AGENTS.md': HIDDEN }, { mode: 'local' }));
      appendHookResult(file, blocked);
      appendHookResult(file, blocked);
      const merged = JSON.parse(readFileSync(file, 'utf8')) as HookResult;
      expect(merged.exitCode).toBe(1);
      expect(merged.blocking).toHaveLength(2);
      expect(merged.blocking[0]).toMatchObject({ check: 'ai-config.content-lint', path: 'AGENTS.md', line: 1 });
      expect(hookResultOf(blocked).errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the hook summary line', () => {
  const secret: HookResult = {
    exitCode: 1,
    blocking: [
      {
        check: 'secrets.gitleaks',
        path: 'docs/plan.md',
        line: 70,
        summary: 'Possible secret: GitHub Personal Access Token (github-pat).',
      },
    ],
    errors: [],
  };

  it('names the first blocking finding and where it is', () => {
    expect(hookSummary('pre-commit', secret, [], 'buffer')).toBe(
      'qa: commit blocked: possible secret: GitHub Personal Access Token (github-pat) in docs/plan.md line 70. Full details are in the git output.',
    );
    const two = { ...secret, blocking: [...secret.blocking, ...secret.blocking] };
    expect(hookSummary('pre-commit', two, [], 'stream')).toMatch(/line 70 \(and 1 more\)\. Details above\.$/);
  });

  it('says what stopped: a commit, a commit message or a push', () => {
    expect(hookSummary('commit-msg', secret, [], 'buffer')).toMatch(/^qa: commit message refused: /);
    expect(hookSummary('pre-push', undefined, ['unit tests'], 'buffer')).toBe(
      'qa: push blocked by unit tests. Full details are in the git output.',
    );
  });

  it('names a check that could not run, then failed hooks, then nothing more', () => {
    const error: HookResult = {
      exitCode: 2,
      blocking: [],
      errors: [{ check: 'secrets.gitleaks', summary: 'gitleaks is not available.' }],
    };
    expect(hookSummary('pre-commit', error, [], 'stream')).toBe(
      'qa: commit blocked: secrets.gitleaks could not run (gitleaks is not available). Details above.',
    );
    expect(hookSummary('pre-commit', undefined, [], 'stream')).toBe('qa: commit blocked. Details above.');
  });

  it("reads the failed hooks from pre-commit's output, colour codes and all", () => {
    const output = [
      'check for added large files..............................Passed',
      'eslint (repository version)..........(no files to check)Skipped',
      'unit tests...............................................Failed',
      '\u001b[41mqa: fast Semgrep rule set\u001b[m......................\u001b[41mFailed\u001b[m',
      '- hook id: unit-tests',
    ].join('\n');
    expect(failedHookNames(output)).toEqual(['unit tests', 'qa: fast Semgrep rule set']);
    expect(whatFailed(output)).toEqual(['unit tests', 'qa: fast Semgrep rule set']);
  });

  it('names pre-commit itself when it crashed before running any hook', () => {
    const crash = [
      '[INFO] Installing environment for https://github.com/pre-commit/pre-commit-hooks.',
      "An unexpected error has occurred: CalledProcessError: command: ('python.exe', '-mvirtualenv')",
    ].join('\n');
    expect(hookSummary('pre-commit', undefined, whatFailed(crash), 'buffer')).toBe(
      'qa: commit blocked by pre-commit itself, which stopped with CalledProcessError. Full details are in the git output.',
    );
    expect(whatFailed('nothing failed here')).toEqual([]);
  });
});

describe('how a hook prints', () => {
  it('streams in a terminal, collects behind a summary line elsewhere, and can be told which', () => {
    expect(hookOutputMode({}, true)).toBe('stream');
    expect(hookOutputMode({}, false)).toBe('buffer');
    expect(hookOutputMode({ QA_HOOK_OUTPUT: 'buffer' }, true)).toBe('buffer');
    expect(hookOutputMode({ QA_HOOK_OUTPUT: 'STREAM' }, false)).toBe('stream');
    expect(hookOutputMode({ QA_HOOK_OUTPUT: 'loud' }, false)).toBe('buffer');
  });
});

describe('Gitleaks findings', () => {
  it('name the kind of secret plainly', () => {
    const kind = (d?: string) => secretKind({ RuleID: 'rule-x', Description: d });
    expect(
      kind(
        'Uncovered a GitHub Personal Access Token, potentially leading to unauthorized repository access and sensitive content exposure.',
      ),
    ).toBe('GitHub Personal Access Token');
    expect(kind('Identified a Slack Bot token, which may compromise bot integrations.')).toBe('Slack Bot token');
    expect(kind('EVM private key (64 hex characters) assigned to a key-like name')).toBe(
      'EVM private key (64 hex characters) assigned to a key-like name',
    );
    expect(kind(undefined)).toBe('rule-x');
  });
});
