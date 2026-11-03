# qc-workflows

LedgerLink QA harness: the governance registries and the `qa` check engine. The git hooks, the MCP server, the CI gate and the release job are thin wrappers around this one engine, so a finding is identical whichever path found it.

Design: `LedgerLink QA Harness Technical Design` V2.2. Build order: `qa-harness-guide/IMPLEMENTATION_PLAN.md`.

> **Local only.** This repository has no remote. Nothing is pushed, and no repository is created in the LedgerLink-ai organisation, until LedgerLink provides organisation-owner action (client request 1.1).

## Status (2 Nov 2026)

**Local checks on the developer's machine** (AI Code Review implementation, section 2): done, in three checkpoints: pre-commit (with commit-msg), pre-push, and pre-PR (`pre-commit run --hook-stage manual --all-files`). Installed from one package that works on Windows, macOS and Linux: `npm install -g` the `.tgz`, then `qa setup` for pre-commit, Semgrep and Gitleaks ([docs/PACKAGE.md](docs/PACKAGE.md)). Setup and manual testing in [docs/PRECOMMIT.md](docs/PRECOMMIT.md). Added since 22 Oct:

- `.pre-commit-hooks.yaml` and `templates/pre-commit-config.yaml`
- Gitleaks rules for blockchain private keys and BIP39 mnemonics
- `commit.conventional`
- the `Assisted-by: <tool>, <model>, <version>` format
- `sast.semgrep` at pre-push
- `qa prepush` and `qa doctor`
- `qa prepr` with the pull request checks `pr.branch-name`, `pr.commits`, `pr.diff-size` and `tests.coverage`
- the `repo-script` and `repo-tool` hooks for each repository's tests, type check and build
- the hook sandbox
- the `@ledgerlink/qa` package (`npm run package`), `qa setup`, `qa --require <version>`, and the `ci` and `release` workflows (not run yet)

Tests: 69 pass. Conformance: 16 of 16 fixtures pass.

### Engine status (22 Oct 2026, step 1 of the plan)

| Piece                                                                                                                                                                                                               | State                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Registries and JSON schemas (`registry/`, `path-tags.yaml`, `checks.yaml`, `policy.yaml`, `exemptions.yaml`, `schemas/`)                                                                                            | Done; validated at load time and in tests                                 |
| Engine core: CLI, changed-file selection (staged / merge-base / files / all), path tags, policy modes with switch-on dates, baseline, exemptions, SARIF 2.1.0, `evidence.json`, exit codes 0/1/2, fail closed in CI | Done                                                                      |
| Checks: `ai-config.content-lint` (C14-4), `ai-config.mcp-allowlist` (C14-6), `paths.protected` (C15-4), `commit.trailer` (C11-2)                                                                                    | Done                                                                      |
| Check: `secrets.gitleaks`                                                                                                                                                                                           | Adapter done; not yet run here because Gitleaks is not installed (week 2) |
| Conformance fixtures and `qa conform` (API path and CLI path)                                                                                                                                                       | 9 pass, 1 skipped (needs Gitleaks), 1 pending (BIP39 rule, week 2)        |
| Git hooks installer, `qa commit-metadata`, MCP server, `qa init`, OKF bundle, gate                                                                                                                                  | Not started (weeks 2 to 6)                                                |

## Use

Requires Node 20 or later.

```bash
npm install
npm run build
npm test
npm run validate
npm run conform
```

Run the engine against a repository:

```bash
node packages/engine/bin/qa.js precommit --config "C:/LedgerLink Client/Implementation/qc-workflows"
node packages/engine/bin/qa.js check --base origin/develop --actor agent --format sarif
node packages/engine/bin/qa.js rules src/transaction/retry.ts --repo link_core
node packages/engine/bin/qa.js help
```

Exit codes: `0` pass, `1` blocking findings, `2` the engine could not run. Callers treat `2` as a failure, never as a pass.

## How a run decides

1. **Changed files.** The run uses one of: staged content (read from the index, so pre-commit checks exactly what will be committed), files since the merge base, an explicit list, or a whole folder.
2. **Tags.** Each file gets its tags from `path-tags.yaml` for this repository. `docs-only` applies only to files with no other tag.
3. **Checks.** A check runs when it is in `checks.yaml`, applies to the tags, is in scope and is not `off`. Stages run cheapest first; a blocking finding stops later stages (P2). Skipped checks are listed with a reason.
4. **Mode.** In `policy.yaml`, a check reports until its `block_from` date and blocks from then (P9). Override the date with `--as-of`.
5. **Blocking.** A finding blocks only when it is error level, its check is in block mode, and it is neither in `.qa/baseline.sarif` nor covered by an unexpired exemption.
6. **Fail closed.** In CI, a check that cannot run (for example, a missing scanner) is an engine error, exit 2. Locally it is skipped with "runs in CI", and the pipeline re-runs everything anyway.
7. **Actor.** `paths.protected` blocks agents (`--actor agent`, or `QA_ACTOR=agent`) and only notes the path for humans, who need code-owner review instead.

Findings are plain text with a fix hint and the control and rule IDs from `repo-docs/capabilities`. They never contain secret values and are never phrased as instructions to an agent.

## Layout

```
registry/ai-registry.yaml   approved AI tools, models, agent identities, MCP servers (C14-1)
path-tags.yaml              tags by repo and glob; later generates CODEOWNERS
checks.yaml                 every check: kind, stage, scope, tags, control and rule IDs
policy.yaml                 report/block modes, switch-on dates, protected paths, local time budget
exemptions.yaml             dated exemptions with owner and approver
schemas/                    JSON schemas for all of the above and for fixtures
config/gitleaks.toml        Gitleaks rules used by secrets.gitleaks (generated: npm run gen:gitleaks)
config/semgrep/             fast Semgrep rule set used by sast.semgrep at pre-push
.pre-commit-hooks.yaml      the hooks this repository provides to LedgerLink repositories
templates/                  .pre-commit-config.yaml to copy into each repository
scripts/                    local release, sandbox and Gitleaks config generator
conformance/fixtures/       planted defects; tree files are .tmpl templates
packages/engine/            the qa engine (published later as @ledgerlink/qa-mcp)
docs/DECISIONS.md           defaults taken for open decisions
```

### Conformance fixtures

Every file under a fixture's `tree/` is a `.tmpl` template. Secrets and hidden characters are written as `{{PLACEHOLDER}}` and assembled only in a temporary directory at run time. This repository therefore never holds a live secret, a live hidden character or an active `.mcp.json`, and it stays clean under its own checks.

To add a check:

1. Add a fixture that fails without the check.
2. Add the check to `checks.yaml`, citing existing control or rule IDs only.
3. Implement it in `packages/engine/src/checks/`, or add a tool adapter.
4. Add its policy entry.
5. Run `npm test` and `npm run conform`.
