# Security review: the qa engine

Issue #15. Scope: the `qa` engine and CLI (`packages/engine`), `qa setup`,
the release and pull request workflows, and the hook template, as of 0.2.3.
Reviewed 11 Nov 2026 against the code in this repository.

## What qa is trusted with

qa runs on developer machines (git hooks) and on GitHub's runners (the pull
request gate). It reads the changed files, runs Gitleaks and Semgrep on a
private copy of them, and reports findings. It never needs credentials, never
changes the repository, and sends data only where it is told to
(`QA_REPORT_URL`).

## Threat model

| Threat                                                                     | Where       | Control                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| qa runs in a repository it must not (personal, other organisations, forks) | local, CI   | Execution gate (#8): owner `LedgerLink-ai` and listed, enabled, in `registry/repositories.yaml`. In Actions, identity from `GITHUB_REPOSITORY` and the event payload; forks skipped; unverifiable identity fails closed (exit 2). Tests: `gate.test.ts`, `cli-e2e.test.ts`                                                                     |
| A pull request weakens the rules it is checked against                     | CI          | Configuration comes from the qa release: `--config`/`QA_CONFIG_DIR` refused in Actions and anywhere inside the repository. The baseline is read from the base branch. `.qa/baseline.sarif`, `.pre-commit-config.yaml`, `.husky/**` are protected paths. Tests: `security.test.ts`, `cli-e2e.test.ts`                                           |
| A pull request suppresses its own findings with a baseline                 | CI          | As above: the PR's own `.qa/baseline.sarif` is ignored in CI; a malformed baseline is an error                                                                                                                                                                                                                                                 |
| Command injection through flags, environment or hook arguments             | local, CI   | No shell anywhere except `repo-script` on Windows, where cmd.exe's special characters inside quotes are refused. Git revisions validated (nothing option-like reaches git). Package, executable and script names validated; executables must be inside their package; `--cwd` inside the repository. Tests: `security.test.ts`, `exec.test.ts` |
| A scanner (or a compromised scanner) reads credentials                     | local, CI   | Scanners and git run with credential variables removed (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*KEY*`, `AUTH`, ...); Semgrep metrics and version checks off. Test: `exec.test.ts`                                                                                                                                                               |
| Secrets leak into logs, reports or the reporting endpoint                  | local, CI   | Gitleaks runs with `--redact` and messages never carry values; every output path (text, JSON, SARIF, evidence, logs, error messages) passes through redaction; the report token is registered for masking; evidence carries no file contents. Tests: `redact.test.ts`, `publish.test.ts`                                                       |
| A tampered qa package                                                      | install, CI | Releases carry a SHA-256 and a Sigstore build provenance attestation from `release.yml`; the pull request gate verifies both before installing (`npm install --ignore-scripts`)                                                                                                                                                                |
| A tampered scanner or Python dependency                                    | `qa setup`  | Gitleaks: SHA-256 from a checksum file kept in this repository. pre-commit, Semgrep and every transitive dependency: `pip --require-hashes --no-deps` from `config/python-requirements.txt`. Downloads https only, no credentials in URLs                                                                                                      |
| A moved tag changes what a hook runs                                       | local       | `pre-commit-hooks` pinned by commit SHA in the template; qa pinned by `--require`; every GitHub Action pinned by commit SHA (test enforces)                                                                                                                                                                                                    |
| A scanner hangs and blocks commits or CI                                   | local, CI   | Time limits per scanner, git command and download; the process tree is killed. Locally deferred to CI; in CI an engine error                                                                                                                                                                                                                   |
| Path traversal from a file name                                            | local, CI   | Files are copied into a private temp directory only if they resolve inside it; paths starting with `-` or containing `..` segments are refused                                                                                                                                                                                                 |
| The cache serves a wrong result                                            | local       | Key covers engine version, check, scanner and version, rule-file hash, path and exact content; damaged entries are misses; never used in CI                                                                                                                                                                                                    |
| Workflow token abuse                                                       | CI          | Every workflow defaults to `contents: read`; jobs add only what they need (`security-events: write` for SARIF; `id-token`/`attestations: write` only in the release job); checkout without persisted credentials in the gate                                                                                                                   |

## Findings of this review and what was done

| #   | Finding                                                                                                              | Severity          | Resolution in 0.2.3                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| 1   | `--config`/`QA_CONFIG_DIR` could replace the allowlist and policy, including from inside the checked repository      | High              | Refused inside the repository and in Actions (`gate.ts`, `configSourceProblem`) |
| 2   | No enforced pull request gate: the docs said checks "cannot be skipped" on the pull request, but no workflow existed | High              | `qa-pr.yml`, caller stub, rulesets, docs/ENFORCEMENT.md                         |
| 3   | A pull request could add its own findings to `.qa/baseline.sarif`                                                    | High              | Baseline read from the base branch in CI; baseline is a protected path          |
| 4   | Scanner runs had no time limit                                                                                       | Medium            | Time limits with process-tree kill                                              |
| 5   | pip installed pre-commit and Semgrep by version only, dependencies unpinned and unhashed                             | Medium            | Hashed, fully pinned lockfile with `--require-hashes --no-deps`                 |
| 6   | Released package had a same-origin checksum only                                                                     | Medium            | Build provenance attestation, verified by the gate                              |
| 7   | Windows `repo-script` quoting let `%VAR%` expand                                                                     | Low               | cmd.exe-special characters refused (`windowsCommandLine`)                       |
| 8   | `repo-tool` package names and `bin` paths were not validated                                                         | Low               | Names validated; executable must be inside the package                          |
| 9   | Scanners inherited every environment variable, including tokens                                                      | Low               | Credential variables removed                                                    |
| 10  | Tool error output was echoed unredacted                                                                              | Low               | Redaction on every output path                                                  |
| 11  | `pre-commit-hooks` pinned to a movable tag                                                                           | Low               | Pinned by commit SHA                                                            |
| 12  | `qa setup` accepted Python 3.9 and 3.10, where pre-commit 4.7.0 does not install                                     | Low (reliability) | 3.11 to 3.14                                                                    |

## Residual risks (accepted)

- **The local gate trusts `origin`.** A developer can point it elsewhere and
  skip local checks. Accepted: local hooks are feedback; the pull request
  gate decides (docs/ENFORCEMENT.md).
- **Rulesets must be applied by an organisation owner.** Until they are, the
  pull request gate exists but is not mandatory. Needs organisation-owner
  action (client request 1.1).
- **Python build dependencies.** If a wheel is missing for a platform, pip
  builds from the (hash-checked) source distribution, and the build tools it
  fetches for that are not hash-checked. All pinned packages ship wheels for
  Windows, macOS and Linux on Python 3.11 to 3.14 today.
- **Repository scripts are the repository's own code.** `qa repo-script` and
  `qa repo-tool` run the repository's tests, linters and build with its own
  dependencies; that is their purpose, and it is no more trust than
  `npm test`.
- **Scanner coverage.** Gitleaks and Semgrep find what their rules describe.
  Rule changes go through review like any other configuration.

## Sign-off

| Role                      | Name | Date | Result |
| ------------------------- | ---- | ---- | ------ |
| Author of the review      |      |      |        |
| Senior AI Engineer        |      |      |        |
| Solution Architect        |      |      |        |
| LedgerLink security owner |      |      |        |

This review is complete for the code in this repository. The sign-off rows
are for the named reviewers (CODEOWNERS) when this change is merged.
