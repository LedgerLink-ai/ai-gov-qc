The same engine runs at commit, at push and before a pull request, so a finding is identical whichever path found it.
Design: `LedgerLink QA Harness Technical Design` V2.2. Build order: `qa-harness-guide/IMPLEMENTATION_PLAN.md`.
| Check                                                                                  | When it runs                      | What it catches                                                                                                         | Mode                    |
| -------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `secrets.gitleaks`                                                                     | Commit                            | Secrets: API keys, tokens, passwords and other credentials in any file, private keys, blockchain keys and BIP39 phrases | Blocks from 16 Nov 2026 |
| `ai-config.content-lint`                                                               | Commit                            | Hidden Unicode and risky instructions in `AGENTS.md`, `CLAUDE.md`, `.cursor/**` and similar files                       | Blocks from 30 Nov 2026 |
| `ai-config.mcp-allowlist`                                                              | Commit                            | MCP servers not in [registry/ai-registry.yaml](registry/ai-registry.yaml)                                               | Blocks from 30 Nov 2026 |
| `paths.protected`                                                                      | Commit                            | Changes to protected paths (agents blocked, humans need code-owner review)                                              | Blocks from 14 Dec 2026 |
| `commit.trailer`                                                                       | Commit                            | A malformed `Assisted-by:` trailer                                                                                      | Report                  |
| `branch.ticket`                                                                        | Commit                            | A branch name without a valid ticket key                                                                                | Report                  |
| `commit.message`                                                                       | Commit message                    | A subject that does not follow `<type>(<TICKET-123>): <description>`                                                    | Report                  |
| `sast.semgrep`                                                                         | Push                              | LedgerLink's fast Semgrep rules (for example money types)                                                               | Blocks from 16 Nov 2026 |
| `pr.branch-name`, `pr.commits`, `pr.commit-messages`, `pr.diff-size`, `tests.coverage` | `qa prepr`, before a pull request | Branch, commit and size conventions for the whole pull request, and test coverage                                       | Report                  |
| Limits of local hooks; pull requests               | [docs/ENFORCEMENT.md](docs/ENFORCEMENT.md)                                     |
- **Pull requests are checked outside this repository.** The GitHub pull request gate was removed (AIQC-92). qa's checks run on developers' machines, where they cannot be enforced; [docs/ENFORCEMENT.md](docs/ENFORCEMENT.md) explains the limits of local hooks.
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
templates/                  the default hook configuration, the release notes
conformance/fixtures/       planted defects; tree files are .tmpl templates
.github/workflows/          ci (Windows, macOS, Linux), release, branch policy
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
