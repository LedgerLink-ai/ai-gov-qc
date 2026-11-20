# Review Findings — ai-gov-qc (dev)

Running list of issues found in code review, to track until fixed. Check items off as they're resolved.

## Must fix (critical, before Nov 30 mcp-allowlist go-live)

- [x] Add Windsurf's MCP config path(s) to `MCP_JSON` in `packages/engine/src/checks/mcp-allowlist.ts` — fixed by generalizing the match to any JSON/JSONC file under an `ai-config`-tagged path, instead of a per-tool filename list.
- [x] Resolve the `pending-inventory` status for all 4 tools in `registry/ai-registry.yaml` (set to `approved`/`not-approved`), or make an overdue `review_by` escalate findings to error-level — **code fix landed** (an MCP-server registry entry past its `review_by` now escalates to error instead of staying a warning). **Still open as a business decision**: the `tools:` entries' `status`/`review_by`/`tier`/`owner`/`models` are informational only — no code path enforces them (confirmed in `commit-trailer.ts`, by design: "the weekly reconciliation is the real check"). Someone who owns LedgerLink's AI governance process needs to actually resolve Claude Code/Cursor/Copilot/Codex's inventory; code can't fabricate that.

## Should fix

- [x] `packages/engine/src/checks/conventions.ts`: merge/revert exemption now requires git's exact generated subject shape (merge) or the `This reverts commit <sha>.` trailer (revert) instead of a bare text prefix. `fixup!`/`squash!`/`amend!` left as-is (self-limiting via rebase workflow, not worth the complexity).
- [x] `packages/engine/src/checks/mcp-allowlist.ts`: added `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` to `UNSAFE_ENV`.
- [x] `packages/engine/src/cli.ts` (`windowsCommandLine`): trailing backslashes are now doubled before the closing quote; added a regression test in `security.test.ts`.
- [x] `packages/engine/src/setup.ts`: hooks still install (preserves the documented fail-open design), but the summary now explicitly warns that commits won't be scanned locally until the earlier `FAIL`s are fixed.

## Harness coverage (market-readiness pass)

- [x] Generalized `ai-config.mcp-allowlist` to match MCP config by file shape (any JSON/JSONC under an `ai-config`-tagged path), not a fixed filename list, so a new/unlisted tool needs only a `path-tags.yaml` entry, not an engine change.
- [x] Added `opencode.json`/`.opencode/**` to `path-tags.yaml`'s `ai-config` paths.
- [x] Registered Windsurf, Gemini CLI, Roo Code, Amazon Q Developer, Cline and opencode in `registry/ai-registry.yaml` (status `pending-inventory`, profiles filled in). **Open**: `trailer_aliases` left unset for all of them — nobody has confirmed the real `Co-authored-by` string each tool writes; add it once verified, or `Assisted-by` attribution won't trigger for them.
- [x] Added conformance fixtures `F28-opencode-mcp` and `F29-windsurf-mcp` proving the generalized detection works end-to-end; updated `docs/RULES.md` and `CHANGELOG.md` to describe the shape-based behavior instead of naming a fixed tool list.

## Nice to have

- [ ] Confirm `.gitignore` under `ai-config` in `path-tags.yaml` is deliberate (forces code-owner review on every `.gitignore` edit).
- [ ] Confirm `secrets.gitleaks`/`sast.semgrep` already being in block mode (dates already passed as of 2026-11-20) is the intended current production state.
- [ ] Narrow `config/semgrep/money-types.yml` patterns (field-name regex, bare `Number($X)`) to reduce false positives. **Decision needed, not done**: it trades missed money bugs for less noise on a C16-1 control, and the rules cannot be verified without Semgrep (fixture F12 needs it). Example false positives today: `totalPages: number`, `feedback: number` (`feew*`).
- [ ] Confirm `strict_required_status_checks_policy: false` in the GitHub repo rulesets (`config/github/repo-ruleset-{main,dev}.json`) is intentional.
- [x] Reuse `exec.ts`'s process-tree handling in `setup.ts`: setup now runs programs through `runProcess` (a timeout stops pip and everything it started), behind an injectable `Runner` so the Python and gitleaks install paths are unit-tested.
- [x] Dedupe `removeIgnoreFiles` into `workdir.ts` (`removeFilesNamed`); both adapters call it. Direct test added: it is a second line of defense behind `isScannerControlFile`, so no flow reached it in tests before.
- [x] `stripJsonc` drops trailing commas with a string-aware pass; `,]`/`,}` inside a string value are kept (regression tests added).

## Test and verification pass (2026-11-20)

Coverage was concentrated in the checks; the code that runs on developers' machines had little direct testing. Added: `run-hook.test.ts`, `setup-cli.test.ts`, `setup-tools.test.ts`, `cli-commands.test.ts`, and tests in `security.test.ts` and `mcp-allowlist.test.ts`. Each fix and new test was checked by breaking the code it covers (mutation) and confirming a test fails.

- [x] `qa setup` reported the global hooks connected (and set `core.hooksPath`) while a non-qa file in `~/.ledgerlink-qa/hooks` meant git ran that file instead of qa: no checks ran. Now FAIL, naming the file, and `core.hooksPath` is left unset.
- [x] `qa prepare-commit-msg` / `qa commit-msg` exited 2 (git refuses the commit) on a configuration qa cannot find or read, contrary to `LOCAL_HOOK_COMMANDS` ("qa's own problems never block them"). Only reachable when a repository calls them directly; the global hooks already failed open. Now warn and exit 0.
- [x] `requirementProblems` accepted a `--hash` that was only in a comment, or longer than 64 hex characters.
- [x] `branch-commit-cli.test.ts` failed under load: the 10 s pre-commit budget (`local.time_budget_ms`) ran out on gitleaks, so the conventions checks were deferred to CI and nothing blocked. The test now sets a large budget.
- [ ] **Decision**: a slow scanner can use the whole pre-commit budget, so millisecond native checks after it (`branch.ticket`, `paths.protected`) are deferred to CI on a slow or busy machine. Consider exempting native checks from the budget.
