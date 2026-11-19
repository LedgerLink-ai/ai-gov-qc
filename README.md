# qc-workflows

LedgerLink QA harness: the governance registries and the `qa` check engine. The git hooks, the MCP server, the CI gate and the release job are thin wrappers around this one engine, so a finding is identical whichever path found it.

Design: `LedgerLink QA Harness Technical Design` V2.2. Build order: `qa-harness-guide/IMPLEMENTATION_PLAN.md`.

Repository: [LedgerLink-ai/ai-gov-qc](https://github.com/LedgerLink-ai/ai-gov-qc). Releases are published there by `release.yml`; the pull request gate other repositories call is `.github/workflows/qa-pr.yml`.

## Status (19 Nov 2026)

**Local checks on the developer's machine** (AI Code Review implementation, section 2): done, in three checkpoints: pre-commit (with prepare-commit-msg, which pre-fills the message, and commit-msg, which checks it), pre-push, and pre-PR (`qa prepr`). Installed from one package that works on Windows, macOS and Linux: `npm install -g` the `.tgz`, then `qa setup` for pre-commit, Semgrep and Gitleaks ([docs/PACKAGE.md](docs/PACKAGE.md)). Setup and manual testing in [docs/PRECOMMIT.md](docs/PRECOMMIT.md).

| Piece                                                                                                                                                                                                               | State                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Registries and JSON schemas (`registry/`, `path-tags.yaml`, `checks.yaml`, `policy.yaml`, `exemptions.yaml`, `schemas/`)                                                                                            | Done; validated at load time and in tests                                                                     |
| Engine core: CLI, changed-file selection (staged / merge-base / files / all), path tags, policy modes with switch-on dates, baseline, exemptions, SARIF 2.1.0, `evidence.json`, exit codes 0/1/2, fail closed in CI | Done                                                                                                          |
| Checks (`checks.yaml`): secrets (Gitleaks), AI configuration, protected paths, trailers, branch and commit conventions, Semgrep, pull request rules, coverage                                                       | Done; Gitleaks and Semgrep run wherever `qa setup` installed them, and always in CI                           |
| Conformance fixtures and `qa conform` (API and CLI paths, loose folders and git repositories with renames, deletions and pull requests)                                                                             | Every fixture runs in CI (`qa conform --require-all`); see [docs/TESTING.md](docs/TESTING.md)                 |
| Git hooks (`qa setup`, global `core.hooksPath`), execution gate, package and automatic releases with provenance                                                                                                     | Done (first automatic release v0.2.2, 3 Nov)                                                                  |
| Pull request gate (`qa-pr.yml`, caller template, rulesets in `config/github/`)                                                                                                                                      | Built; mandatory once an organisation owner applies the rulesets ([docs/ENFORCEMENT.md](docs/ENFORCEMENT.md)) |
| MCP server, `qa init`, OKF bundle                                                                                                                                                                                   | Not started                                                                                                   |

## Production use (issue #15)

| Topic                                              | Document                                   |
| -------------------------------------------------- | ------------------------------------------ |
| Install, configure, release, roll back, maintain   | [docs/OPERATIONS.md](docs/OPERATIONS.md)   |
| Pull request gate, rulesets, limits of local hooks | [docs/ENFORCEMENT.md](docs/ENFORCEMENT.md) |
| Security review, threat model, residual risks      | [docs/SECURITY.md](docs/SECURITY.md)       |
| Benchmarks                                         | [docs/PERFORMANCE.md](docs/PERFORMANCE.md) |
| Test suites                                        | [docs/TESTING.md](docs/TESTING.md)         |
| Release notes                                      | [CHANGELOG.md](CHANGELOG.md)               |

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
7. **Actor.** `paths.protected` blocks agents (`--actor agent`, or `QA_ACTOR=agent`) and only notes the path for humans, who need code-owner review instead. In the pull request gate the agent rules apply when the author is a registered agent, or when any commit of the pull request declares AI assistance (`Assisted-by`, or an AI `Co-authored-by`).

Findings are plain text with a fix hint and the control and rule IDs from `repo-docs/capabilities`. They never contain secret values and are never phrased as instructions to an agent.

## Where the engine runs (execution gate)

The engine acts only in a repository that is owned by `LedgerLink-ai` and listed with `enabled: true` in [registry/repositories.yaml](registry/repositories.yaml). Anywhere else it does nothing, silently, and exits 0: personal repositories, other organisations, forks, unlisted repositories, and repositories an administrator disabled. The hook commands (`check`, `precommit`, `prepare-commit-msg`, `commit-msg`, `prepush`, `prepr`, `baseline`, `repo-tool`, `repo-script`) are gated; `setup`, `doctor`, `rules`, `validate`, `conform`, `version` and `help` are not. `qa doctor` shows whether QA is enabled for the current repository.

- **Local:** identity is the `origin` remote (`owner/name`), not the folder name or `--repo`. A missing or unrecognised origin means skip. A developer controls their own remote, so this keeps the hooks out of unrelated repositories but is not tamper-proof.
- **GitHub Actions:** identity comes from `GITHUB_REPOSITORY` and the event payload, not the checkout. Forks, and pull requests from forks, are skipped. An identity that cannot be verified is exit 2 (fail closed).
- **Elsewhere in CI** (`CI` set, not GitHub Actions): an origin that cannot be verified is exit 2.
- **Allowlist changes** are pull requests to this repository with code-owner review; the list ships in the released package. Onboarding and offboarding commands (issue #14) are not built yet.

## Layout

```
registry/ai-registry.yaml   approved AI tools, models, agent identities, MCP servers (C14-1)
registry/repositories.yaml  repositories where the engine may run (execution gate, issue #8)
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

### Branches and releases

Changes reach `main` in two steps, each a pull request:

1. A feature branch (for example `feature/LCORE-210-limit-invariants`) into `dev`. The `ci` checks on Windows, macOS and Linux must pass.
2. `dev` into `main`, merged with a merge commit so the two branches stay in step. The `ci` checks and `branch-policy` must pass; `branch-policy` fails any pull request into `main` that does not come from `dev`.

Both branches take changes only through pull requests, with conversations resolved, and cannot be force-pushed or deleted. Release tags (`v*`) cannot be moved or deleted. When a merge into `main` changes the version in `package.json`, the release workflow tags it and publishes the package ([docs/PACKAGE.md](docs/PACKAGE.md)).
