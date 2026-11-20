# Testing step 1 locally

Everything below runs on your machine only. Nothing is pushed, and nothing touches GitHub or the LedgerLink-ai organisation. The commands work in PowerShell and in Git Bash. Run them from the `qc-workflows` folder:

```
cd "C:\LedgerLink Client\Implementation\qc-workflows"
```

You need Node 20 or later and git. With Gitleaks 8.30.1 and Semgrep 1.183.0 installed (see [PRECOMMIT.md](PRECOMMIT.md)), every check runs; without them, their checks are skipped locally with a "runs in CI" notice.

This page tests the engine directly. To test the git hooks themselves (`git commit` and `git push` in a developer clone), use [PRECOMMIT.md](PRECOMMIT.md).

## 1. Build and run the automated checks (about 1 minute)

```
npm install
npm run build
npm test
npm run validate
npm run conform
```

| Command            | Expected result                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`         | `Tests: 56 passed, 56 total`                                                                                                                                                                                                                                                                                                               |
| `npm run validate` | `Configuration valid` and `13 checks, 11 tags, 4 AI tools, 1 MCP servers, 0 exemptions`                                                                                                                                                                                                                                                    |
| `npm run conform`  | All 27 fixtures `PASS`, `0 fail, 0 skipped, 0 pending` (a few minutes). Without Gitleaks, F01, F02 and F07–F09 are skipped; without Semgrep, F12; CI runs `npm run conform -- --require-all`, where a skipped or pending fixture fails the run. Each fixture shows `(paths: api, cli)`, meaning both entry points gave identical findings. |

## 2. Try each check by hand in a sandbox repository

`npm run sandbox -- <scenario>` resets the throwaway clone at `C:\LedgerLink Client\Implementation\sandbox\link_core` (building it with `setup` the first time), writes the scenario's files and stages them. Then run the engine command the pre-commit hook runs. [PRECOMMIT.md](PRECOMMIT.md) lists the further scenarios: `secrets`, `large-file`, `merge-conflict`, `format`, `lint` and `money`.

`--as-of 2027-01-08` evaluates the change as it will be treated after every gate is switched on (Phase 1 delivery). Without `--as-of`, today's date applies and the checks are still in their report-only period: findings show as `REPORT` and nothing blocks.

| Scenario           | Command after `npm run sandbox -- <scenario>`                                                           | Expected                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `clean`            | `node packages/engine/bin/qa.js precommit --root ../sandbox/link_core --actor agent --as-of 2027-01-08` | `result: PASS`, exit 0. The clean AGENTS.md says "Never commit with --no-verify" and is not flagged.                 |
| `hidden-unicode`   | `node packages/engine/bin/qa.js precommit --root ../sandbox/link_core --as-of 2027-01-08`               | 2 × `BLOCK ai-config.content-lint` (U+200B and U+202E, with line and column), exit 1                                 |
| `hidden-unicode`   | same command without `--as-of`                                                                          | Same 2 findings as `REPORT`, `result: PASS`, exit 0 (report-only until 30 Nov)                                       |
| `disable-controls` | `node packages/engine/bin/qa.js precommit --root ../sandbox/link_core --as-of 2027-01-08`               | `BLOCK` for "skip the tests" and "--no-verify", exit 1                                                               |
| `bad-mcp`          | same                                                                                                    | `BLOCK ai-config.mcp-allowlist`: some-web-mcp-server is not in the AI registry, exit 1                               |
| `unpinned-mcp`     | same                                                                                                    | `BLOCK ai-config.mcp-allowlist`: @ledgerlink/qa-mcp without an exact version (in a JSONC file with comments), exit 1 |
| `workflow-edit`    | `node packages/engine/bin/qa.js precommit --root ../sandbox/link_core --actor agent --as-of 2027-01-08` | `BLOCK paths.protected`: an agent changes a protected path, exit 1                                                   |
| `workflow-edit`    | same with `--actor human`                                                                               | `NOTE paths.protected`: needs code-owner review, `result: PASS`, exit 0                                              |
| `all`              | `node packages/engine/bin/qa.js precommit --root ../sandbox/link_core --actor agent --as-of 2027-01-08` | Findings from three checks together                                                                                  |

To see the exit code: in PowerShell run `$LASTEXITCODE`; in Git Bash run `echo $?`.

You can also edit files in the sandbox yourself, `git add` them inside `../sandbox/link_core`, and run `precommit` again. Only staged content is checked: edit a staged file without re-adding it, and the check still sees the staged version.

## 3. Commit messages: pre-fill and the trailer form

Every sandbox also writes sample messages into `../sandbox/messages/`. The prepare-commit-msg hook only pre-fills messages (see PRECOMMIT.md, "Commit messages"); the Assisted-by form is checked with:

```
node packages/engine/bin/qa.js check --files README.md --root ../sandbox/link_core --commit-msg-file ../sandbox/messages/msg-malformed.txt
```

| Message file        | Content                                    | Expected                                                                   |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `msg-good.txt`      | `Assisted-by: Cursor, gpt-5, 1.7.0`        | PASS                                                                       |
| `msg-malformed.txt` | `Assisted-by: cursor/gpt-5` (the old form) | `REPORT commit.trailer`: not in the form `<tool>, <model>, <version>`      |
| `msg-coauthor.txt`  | `Co-authored-by: Cursor Agent <…>` only    | `NOTE`: declared, but not via Assisted-by. PASS                            |
| `msg-none.txt`      | no trailer                                 | PASS. No trailer is not a finding (P10); reconciliation checks this later. |

## 4. Baseline: existing findings report but do not block

```
npm run sandbox -- hidden-unicode
node packages/engine/bin/qa.js baseline --staged --root ../sandbox/link_core --as-of 2027-01-08
node packages/engine/bin/qa.js precommit --root ../sandbox/link_core --as-of 2027-01-08
```

Expected: `Baselined 2 finding(s)`, then the same two findings as `REPORT` with "Present in the dated baseline", `result: PASS`. Only error-level findings that no exemption covers are recorded; notes and warnings never block, so they are left out. An exemption is considered before the baseline: once it expires, its finding blocks even if it is in the baseline. The baseline is `../sandbox/link_core/.qa/baseline.sarif`. Delete it to make the findings block again.

## 5. Report files (what CI will store as evidence)

```
node packages/engine/bin/qa.js precommit --root ../sandbox/link_core --as-of 2027-01-08 --out ../sandbox/out
```

This writes `../sandbox/out/results.sarif` (SARIF 2.1.0: every finding with its control IDs, fingerprint and blocking flag) and `../sandbox/out/evidence.json` (engine version, a hash of every registry file, each check's status and timing). Use `--format json` or `--format sarif` to print these to the screen instead.

## 6. Ask what applies to a file

```
node packages/engine/bin/qa.js rules src/transaction/retry.ts AGENTS.md --repo link_core
```

Expected: `retry.ts` is tagged `ledger` and needs 2 approvals; `AGENTS.md` is tagged `ai-config`. Each line lists the checks that apply and their control and rule IDs.

## 7. Read-only run against a real LedgerLink clone

This only reads files. It writes nothing into the repository, because there is no `--out` and the mode is local.

```
node packages/engine/bin/qa.js check --all --root C:/Users/htadmin/Documents/LedgerLink/link_core --repo link_core --as-of 2027-01-08
```

Result on 22 Oct 2026: `PASS`. The real `AGENTS.md` produces no findings. Workflow files and `.env.example` / `.env.test` show as `NOTE paths.protected`. They are informational for humans and would block only an agent.

## 8. Configuration changes you can try

| Change                                                                                                              | Then run                      | Expected                                                    |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| In `policy.yaml`, set `ai-config.content-lint: { mode: off }`                                                       | the `hidden-unicode` scenario | The check is listed as `skip … switched off in policy.yaml` |
| In `registry/ai-registry.yaml`, add `0.2.0` to `ledgerlink-qa` versions, then pin `@0.2.0` in a sandbox `.mcp.json` | `precommit`                   | PASS                                                        |
| Make a mistake, e.g. `stage: 5` in `checks.yaml`                                                                    | `npm run validate`            | `configuration error … does not match its schema`, exit 2   |

Undo your edits afterwards, then run `npm test`.

## Automated tests

`npm test` (after `npm run build`; CI runs it on Linux, macOS and Windows):

| Kind                   | Where                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                   | `config`, `runner`, `content-lint`, `mcp-allowlist`, `commit-trailer`, `pr-rules`, `prepare-message`, `conventions` (branch names and commit messages, AIQC-87), `setup`, `exec`, `redact`                                                                                                                                                                                                                                               |
| Integration            | `git.test.ts` (real git repositories), `runner-hardening.test.ts` (timeouts, parallel checks, cache, evidence), `publish.test.ts` (a local collector)                                                                                                                                                                                                                                                                                    |
| End to end             | `prepr-gate.test.ts` (`qa prepr` in CI: agent rules from AI-declared commits, committed coverage ignored), `cli-e2e.test.ts` (the built CLI: exit codes, gate, configuration trust, JSON logs, baseline in CI, agent rules), `branch-commit-cli.test.ts` (commits through the pre-commit, prepare-commit-msg and commit-msg hooks, in block and report mode), `conformance.test.ts` and `npm run conform` (fixtures through API and CLI) |
| Git hook lifecycle     | `hooks-lifecycle.test.ts`: hooks installed in a clone; commit, message pre-fill, block, `--no-verify`, push, push blocked by Semgrep                                                                                                                                                                                                                                                                                                     |
| Security               | `security.test.ts` (configuration trust, injection, URLs, baseline, pinned actions, hooks and Python dependencies, release check), `exec.test.ts`, `redact.test.ts`                                                                                                                                                                                                                                                                      |
| Negative authorization | `gate.test.ts` (29 cases), `cli-e2e.test.ts` (not allowlisted, configuration from the repository)                                                                                                                                                                                                                                                                                                                                        |
| Performance            | `performance.test.ts` (guards), `scripts/benchmark.js` in CI ([PERFORMANCE.md](PERFORMANCE.md))                                                                                                                                                                                                                                                                                                                                          |
| Cross-platform         | the `ci` workflow matrix: ubuntu, windows, macos                                                                                                                                                                                                                                                                                                                                                                                         |

Every check has unit tests, and each hook stage (pre-commit,
prepare-commit-msg, commit-msg, pre-push, pre-PR) runs end to end. The
conformance fixtures cover every check in `checks.yaml` through both the API
and the CLI path:

| Check                             | Fixtures                                                        |
| --------------------------------- | --------------------------------------------------------------- |
| `secrets.gitleaks`                | F01, F02, F07–F09                                               |
| `ai-config.content-lint`          | F00, F03, F03b, F10                                             |
| `ai-config.mcp-allowlist`         | F00, F04, F04b                                                  |
| `paths.protected`                 | F05, F05b, F19 (rename), F20 (deletion), F21 (AI configuration) |
| `commit.trailer`                  | F06, F11                                                        |
| `branch.ticket`, `commit.message` | F15, F16                                                        |
| `sast.semgrep`                    | F12                                                             |
| `pr.branch-name`                  | F24                                                             |
| `pr.commits`                      | F25                                                             |
| `pr.commit-messages`              | F22                                                             |
| `pr.diff-size`                    | F23                                                             |
| `tests.coverage`                  | F26, F27 (committed summary ignored in CI)                      |

A fixture is a `fixture.yaml` (schema: `schemas/fixture.schema.json`) and a
`tree/` of `.tmpl` files. Without `operations` or `pr` the tree is a loose
folder and every file counts as added (`qa check --all`). With `operations`
(`rename: {from, to}`, `delete: <path>`, `write: {path, lines | text}`) or
`pr` (`branch`, `commits` with messages, `coverage` the test run wrote), the
tree is committed on `main` in a git repository, the operations are committed
on the branch, and both paths read the change from git: the API path with
the engine's git functions, the CLI path with `qa check --base main` or
`qa prepr --base main` in CI mode. The CLI path runs with a cleaned
environment, but keeps `QA_HOME` and the `QA_*_BIN` tool locations, so it
finds the same scanners as the API path.

## What is not covered yet

- The MCP server and `qa init` (week 3).
- Pull request checks: handled outside this repository
  ([ENFORCEMENT.md](ENFORCEMENT.md)).
