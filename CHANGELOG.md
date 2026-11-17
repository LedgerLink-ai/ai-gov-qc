# Changelog

Every release of `@ledgerlink/qa` (`ledgerlink-qa-<version>.tgz`). The section
for a version is its GitHub release notes (`node scripts/release.js --notes <version>`),
and `node scripts/release.js --check` fails a release without one.

Versions follow semantic versioning. Below 1.0, a minor version is a major one:
`qa --require 0.2.3` accepts 0.2.3 and later 0.2.x, never 0.3.0. A release
that a repository pinned to an earlier compatible version can install without
changing its hooks.

## 0.2.3

Production hardening (issue #15). Compatible with 0.2.x: repositories pinned
with `qa --require 0.2.0` to `0.2.2` keep working.

Security

- Configuration comes from the installed qa package: `--config` and
  `QA_CONFIG_DIR` pointing inside the repository being checked are refused,
  and both are refused altogether in GitHub Actions.
- In CI the dated baseline is read from the pull request's base, so a pull
  request cannot baseline its own findings. A malformed baseline is an error.
- `.pre-commit-config.yaml`, `.husky/**` and `.qa/baseline.sarif` are
  protected paths (code-owner review; agents may not change them).
- Scanners and git run without a shell, with credential variables
  (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `AWS_*_KEY`, ...) removed from their
  environment.
- `qa repo-tool` and `qa repo-script` refuse package and script names that are
  not plain names, executables outside the package, `--cwd` outside the
  repository, and, on Windows, arguments cmd.exe would interpret (`%`, `!`, `"`).
- Git revisions from flags and the environment are validated; nothing that
  git could read as an option reaches it.
- Output, logs, reports and error messages are redacted (tokens, keys,
  passwords, private keys, credentials in URLs).
- `qa setup` installs pre-commit and Semgrep from `config/python-requirements.txt`
  with `pip --require-hashes --no-deps`: every Python dependency is pinned and
  hash-checked. Downloads are https only.
- The pre-commit-hooks repository is pinned by commit SHA in the template.
- Releases carry a signed build provenance attestation;
  `gh attestation verify` checks it.

Reliability

- Time limits for every scanner run (`timeouts` in policy.yaml,
  `--timeout`, `QA_TOOL_TIMEOUT_MS`), git command and download. A scanner that
  runs past its limit is stopped with its child processes; locally the check
  is deferred to CI, in CI it is an engine error (exit 2).
- Downloads and report uploads retry with backoff on network errors, 429 and
  5xx.
- Results are deterministic: findings are ordered by check, path, line,
  column, sub-rule and fingerprint, whatever order parallel checks finish in.
- Fix: `qa setup` now requires Python 3.11 to 3.14 (pre-commit 4.7.0 does not
  install on 3.9 or 3.10, which were accepted before).

Performance

- Checks of the same stage run in parallel (`performance.parallelism`,
  `--parallel`, `QA_PARALLELISM`); stages stay in order.
- Local per-file cache of scanner results (`<qa home>/cache`, `--no-cache`,
  `QA_NO_CACHE=1`, `qa cache clear`); never used in CI.

Observability

- Structured logs: `--log-format json` / `QA_LOG_FORMAT=json` writes one JSON
  event per line on stderr with the engine version and a run id.
- `evidence.json` adds the run id, profiles (tags, stages, enabled checks and
  their modes), failed validations, tool versions, cache use and host; the
  summary adds check counts. All v1 fields are unchanged.
- Central reporting: `--report-url` / `QA_REPORT_URL` POSTs the evidence to an
  https collector (`QA_REPORT_TOKEN`, `QA_REPORT_REQUIRED=1`).

Enforcement

- `.github/workflows/qa-pr.yml`: the pull request gate, reusable or required
  by an organisation ruleset. Installs the pinned, verified qa release, runs
  every check with the released configuration, uploads SARIF to code scanning
  and keeps the evidence for 90 days. Caller stub: `templates/qa-pr-caller.yml`.
  Setup: docs/ENFORCEMENT.md.

Version management

- `policy.yaml` `min_engine_version`: an older qa refuses a newer configuration
  with instructions.
- `scripts/release.js --check` also checks the template pins, the workflow
  defaults, this changelog and `min_engine_version`.

## 0.2.2

- Fix `qa setup` on Python 3.15 (Semgrep's pywin32 pin has no 3.15 build) and
  the CI package install step.

## 0.2.1

- The prepare-commit-msg hook says why it added nothing.

## 0.2.0

- Pre-fill commit messages (ticket key from the branch, Assisted-by default)
  instead of rejecting them.

## 0.1.0

- Local checks at commit, push and before a pull request.
