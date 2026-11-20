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
- [ ] Narrow `config/semgrep/money-types.yml` patterns (field-name regex, bare `Number($X)`) to reduce false positives.
- [ ] Confirm `strict_required_status_checks_policy: false` in the GitHub repo rulesets (`config/github/repo-ruleset-{main,dev}.json`) is intentional.
- [ ] Reuse `exec.ts`'s `killSignal`/process-group handling in `setup.ts`'s local `run()` helper.
- [ ] Dedupe `removeIgnoreFiles` (currently duplicated in `gitleaks.ts` and `semgrep.ts`) into `workdir.ts`.
- [ ] Scope `mcp-allowlist.ts`'s `stripJsonc` trailing-comma regex to avoid touching string literal contents.
