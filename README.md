# ai-gov-qc

LedgerLink's QA harness for AI-assisted development. It is the source of the `qa` engine and the `@ledgerlink/qa` package, plus the registries and policy the engine enforces.

Developers install the package once. It then checks every commit and push in LedgerLink-ai repositories for these things:

- leaked secrets;
- unsafe or unapproved AI-agent configuration;
- changes to protected files;
- risky code;
- ticket-based branch and commit conventions.

The same engine runs at commit, at push and before a pull request, so a finding is identical whichever path found it.

Design: `LedgerLink QA Harness Technical Design` V2.2. Build order: `qa-harness-guide/IMPLEMENTATION_PLAN.md`.

## What it does

- **Hooks for every repository.** `qa setup` connects git's `pre-commit`, `prepare-commit-msg`, `commit-msg` and `pre-push` hooks for every clone on the machine through git's global `core.hooksPath`. Nothing is copied into any repository.
- **Only in LedgerLink-ai repositories.** The engine acts only in repositories owned by `LedgerLink-ai` and listed with `enabled: true` in [registry/repositories.yaml](registry/repositories.yaml). Everywhere else the hooks do nothing ([execution gate](#where-the-engine-runs-execution-gate)).
- **Commit messages written for you.** `prepare-commit-msg` pre-fills `<type>(<TICKET-123>): ` from a branch named `<type>/<TICKET-123>-<description>`, and an `Assisted-by:` trailer recording the AI tool used ([docs/BRANCH-AND-COMMIT-CONVENTIONS.md](docs/BRANCH-AND-COMMIT-CONVENTIONS.md)).
- **Report first, then block.** Every check reports problems until its agreed blocking date in [policy.yaml](policy.yaml), and blocks from then. A baseline and dated exemptions cover known findings.
- **One installable package.** It works the same on Windows, macOS and Linux. Every new version merged into `main` is released automatically, with a SHA-256 checksum and a signed provenance attestation.

### Checks

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

The repository's own Prettier, ESLint, tests, type check and build can also run as hooks (`repo-tool`, `repo-script`). The full list, with what each check is for, is in [checks.yaml](checks.yaml).

## Requirements

To install and use the package:

| Dependency        | Version                                          | Used for                                                       |
| ----------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| Node.js, with npm | 20 or later                                      | Runs `qa`                                                      |
| Git               | Any recent version (on Windows, Git for Windows) | The hooks                                                      |
| Python            | 3.11 to 3.14                                     | A private environment for pre-commit and Semgrep               |
| GitHub CLI (`gh`) | Any recent version, signed in                    | Downloading a release and verifying its attestation (optional) |

`qa setup` installs the rest, at the versions pinned in [policy.yaml](policy.yaml). It checks every download before using it:

- pre-commit and Semgrep come from PyPI and are hash-checked;
- Gitleaks comes from its GitHub release and is checked against its SHA-256.

Setup needs network access to github.com, pypi.org and files.pythonhosted.org, and about 420 MB of disk. It needs no administrator rights.

To develop this repository you also need `npm install`. The scanners are only needed for the tests that run them.

## Where qa is installed

| What                                                | Windows                                     | macOS and Linux                                    |
| --------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| The npm package                                     | `%APPDATA%\npm\node_modules\@ledgerlink\qa` | `$(npm prefix -g)/lib/node_modules/@ledgerlink/qa` |
| The `qa` command                                    | `%APPDATA%\npm\qa.cmd`                      | `$(npm prefix -g)/bin/qa`                          |
| qa home (`QA_HOME` or `--home` to change it)        | `%USERPROFILE%\.ledgerlink-qa`              | `~/.ledgerlink-qa`                                 |
| pre-commit and Semgrep (private Python environment) | `<qa home>\venv\Scripts`                    | `<qa home>/venv/bin`                               |
| Gitleaks and tool launchers (add to PATH)           | `<qa home>\bin`                             | `<qa home>/bin`                                    |
| Hook scripts for every repository                   | `<qa home>\hooks`                           | `<qa home>/hooks`                                  |
| Scanner result cache                                | `<qa home>\cache`                           | `<qa home>/cache`                                  |
| Global git setting `core.hooksPath`                 | `%USERPROFILE%\.gitconfig`                  | `~/.gitconfig`                                     |
| pre-commit's own cache                              | `%USERPROFILE%\.cache\pre-commit`           | `~/.cache/pre-commit`                              |

## Install

Quick install, on Windows, macOS and Linux (replace `<version>` with the [latest release](https://github.com/LedgerLink-ai/ai-gov-qc/releases), for example `0.2.3`):

```bash
npm install -g --ignore-scripts https://github.com/LedgerLink-ai/ai-gov-qc/releases/download/v<version>/ledgerlink-qa-<version>.tgz
qa setup
```

Then put `~/.ledgerlink-qa/bin` on your PATH and run `qa doctor` inside a LedgerLink-ai repository.

The quick install does not check the package's SHA-256 or its build provenance attestation. Each release's notes have the step-by-step install that checks both, for each OS, and how to upgrade, uninstall and roll back. To remove qa, run `qa setup --uninstall` first and then `npm uninstall -g @ledgerlink/qa`.

## Documentation

| Topic                                              | Document                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Install, configure, release, roll back, maintain   | [docs/OPERATIONS.md](docs/OPERATIONS.md)                                       |
| The package: contents, hosting, releases           | [docs/PACKAGE.md](docs/PACKAGE.md)                                             |
| Hooks on a developer's machine, and manual testing | [docs/PRECOMMIT.md](docs/PRECOMMIT.md)                                         |
| Branch names and commit messages                   | [docs/BRANCH-AND-COMMIT-CONVENTIONS.md](docs/BRANCH-AND-COMMIT-CONVENTIONS.md) |
| Limits of local hooks; pull requests               | [docs/ENFORCEMENT.md](docs/ENFORCEMENT.md)                                     |
| Security review, threat model, residual risks      | [docs/SECURITY.md](docs/SECURITY.md)                                           |
| Benchmarks                                         | [docs/PERFORMANCE.md](docs/PERFORMANCE.md)                                     |
| Test suites                                        | [docs/TESTING.md](docs/TESTING.md)                                             |
| Defaults taken for open decisions                  | [docs/DECISIONS.md](docs/DECISIONS.md)                                         |
| Changes in each version                            | [CHANGELOG.md](CHANGELOG.md)                                                   |

## Status and limits

- **Done:** the local checkpoints, which are:

  - pre-commit, with prepare-commit-msg and commit-msg;
  - pre-push;
  - `qa prepr`.

  Also done: the execution gate, hooks for every repository, the package with automatic releases, and the production hardening (issue #15).

- **Pull requests are checked outside this repository.** The GitHub pull request gate was removed (AIQC-92). qa's checks run on developers' machines, where they cannot be enforced; [docs/ENFORCEMENT.md](docs/ENFORCEMENT.md) explains the limits of local hooks.
- **Not built yet:** the MCP server, `qa init` and the onboarding and offboarding commands (issue #14).

## Development

Requires Node 20 or later.

```bash
npm install
npm run build
npm test
npm run validate
npm run conform
npm run lint
npm run format:check
npm run release:check
```

Build the package (`out/ledgerlink-qa-<version>.tgz` and its `.sha256`), and preview a version's release notes:

```bash
npm run package
node scripts/release.js --notes <version>
```

Run the engine against a repository:

```bash
node packages/engine/bin/qa.js precommit --config <path to this checkout>
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
scripts/                    package and release checks, local release, sandbox, Gitleaks config generator
conformance/fixtures/       planted defects; tree files are .tmpl templates
packages/engine/            the qa engine and CLI, released as @ledgerlink/qa
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

Both branches take changes only through pull requests, with conversations resolved, and cannot be force-pushed or deleted. Release tags (`v*`) cannot be moved or deleted. When a merge into `main` changes the version in `package.json`, the release workflow tags it and publishes the package ([docs/PACKAGE.md](docs/PACKAGE.md)). The release notes are built from [templates/release-notes.md](templates/release-notes.md) and the version's `CHANGELOG.md` section. The pull request list leaves out pull requests that were reverted before the release.
