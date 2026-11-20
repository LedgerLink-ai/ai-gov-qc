# Operations: installing, releasing, rolling back and maintaining qa

Issue #15. For the people who install qa across the organisation, release
it, and keep it running. Developer setup is in [PRECOMMIT.md](PRECOMMIT.md);
packaging details in [PACKAGE.md](PACKAGE.md); the limits of local hooks in
[ENFORCEMENT.md](ENFORCEMENT.md).

## Production installation

Requirements: Node 20 or later, git, Python 3.11 to 3.14, Windows, macOS or
Linux. The GitHub CLI (`gh`) for verification.

```bash
VERSION=0.2.4
gh release download "v$VERSION" --repo LedgerLink-ai/ai-gov-qc --pattern "ledgerlink-qa-$VERSION.tgz*"
sha256sum -c "ledgerlink-qa-$VERSION.tgz.sha256"                              # integrity
gh attestation verify "ledgerlink-qa-$VERSION.tgz" --repo LedgerLink-ai/ai-gov-qc   --signer-workflow LedgerLink-ai/ai-gov-qc/.github/workflows/release.yml   --source-ref refs/heads/main --deny-self-hosted-runners   # built by release.yml for main, on GitHub's runners
npm install -g --ignore-scripts "./ledgerlink-qa-$VERSION.tgz"
qa setup                    # pre-commit, Semgrep, Gitleaks at the pinned versions, hash-checked; the hooks for every repository
git config --global ledgerlink.assistedBy "<tool>, <model>, <version>"    # "none" without AI tools
qa doctor                   # in a repository: READY, or what is missing
```

On Windows without `sha256sum`: `Get-FileHash ledgerlink-qa-0.2.4.tgz -Algorithm SHA256`
and compare with the `.sha256` file.

**Without access to GitHub or PyPI.** Download the Gitleaks archive named in
`config/gitleaks_<version>_checksums.txt` and run
`qa setup --gitleaks-archive <file>` (still checksum-checked), or point
`--download-base` / `QA_GITLEAKS_DOWNLOAD_BASE` at an https mirror. For pip,
set `PIP_INDEX_URL` to an internal mirror; hashes are still checked, so the
mirror cannot substitute files.

**Per repository.** Nothing for the hooks: `qa setup` connects them in every
clone on the machine, and they use the default configuration that ships with
qa unless the repository has a `.pre-commit-config.yaml` of its own (copy
`templates/pre-commit-config.yaml` only to change what runs there). Add the
repository to
`registry/repositories.yaml` with `enabled: true` through a pull request, and
release qa (the allowlist ships inside the package).

**What qa writes.** `qa setup`: `~/.ledgerlink-qa` (or `QA_HOME`), including
the hook scripts in `<qa home>/hooks`, the `qa` launchers that the hooks put
first on `PATH` for pre-commit in `<qa home>/shims`, and git's global
`core.hooksPath` pointing at the hooks, only if no system or global scope (or
file they include) sets it to anything else (`qa setup --uninstall` removes
the hooks and the setting; `--no-global-hooks` sets up the older per-clone
git template instead). Setup names the scope and file of a foreign setting,
and after writing checks that qa's value is the one git uses; `qa doctor`
shows the value in use with its scope and file, and fails when another
setting overrides qa's. After installing a new release, run `qa setup` again
so the hook scripts are rewritten. Hooks: nothing in the working tree. In a repository
without its own `.pre-commit-config.yaml`, the default configuration is copied
to `.git/ledgerlink-qa/pre-commit-config.yaml` (git metadata, never committed),
because pre-commit cannot use a configuration on another drive on Windows. The
prepare-commit-msg hook edits only the commit message git hands it. Scanner
results are cached in `<qa home>/cache`. `--out` and CI write
`results.sarif` and `evidence.json` (CI default `.qa/out`, which repositories
should ignore). `qa baseline` writes `.qa/baseline.sarif` when asked.

## Configuration reference (production)

| Setting                                  | Where                                                                          | Default                 |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ----------------------- |
| Scanner time limit                       | `timeouts.tool_ms`, `timeouts.tools.<tool>`; `--timeout`, `QA_TOOL_TIMEOUT_MS` | 300 s (Semgrep 600 s)   |
| git time limit                           | `timeouts.git_ms`; `QA_GIT_TIMEOUT_MS`                                         | 120 s                   |
| Download / upload time limit and retries | `timeouts.download_ms`, `timeouts.network_retries`; `QA_DOWNLOAD_TIMEOUT_MS`   | 120 s, 3 retries        |
| Parallel checks                          | `performance.parallelism`; `--parallel`, `QA_PARALLELISM`                      | 4                       |
| Local cache                              | `performance.cache`; `--no-cache`, `QA_NO_CACHE=1`, `QA_CACHE_DIR`             | on locally, never in CI |
| Structured logs                          | `--log-format json`, `QA_LOG_FORMAT=json`; `--log-level`, `QA_LOG_LEVEL`       | text, warnings only     |
| Central reporting                        | `--report-url`, `QA_REPORT_URL`, `QA_REPORT_TOKEN`, `QA_REPORT_REQUIRED=1`     | off                     |
| Hook output                              | `QA_HOOK_OUTPUT=stream` (summary last) or `buffer` (summary first, for IDEs)   | stream in a terminal    |
| Text report detail                       | `--verbose` lists the checks that did not run                                  | counted, not listed     |
| Oldest compatible engine                 | `min_engine_version`                                                           | 0.2.3                   |

Exit codes: `0` pass, `1` blocking findings, `2` qa could not run a check or
refused to run (treat as a failure, never as a pass).

## Observability

- **Logs.** `QA_LOG_FORMAT=json` writes one JSON object per line on stderr:
  `ts`, `level`, `event`, `engine_version`, `run_id` and the event's fields.
  Events: `gate.allowed` / `gate.skipped` / `gate.unverified` /
  `gate.config-refused`, `run.start` (repo, sha, mode, actor, tags, stages,
  parallelism, cache), `check.start`, `check.finish` (status, duration,
  findings, blocking, cached files), `check.deferred`, `check.error`,
  `baseline.source`, `run.finish`, `run.summary`, `report.written`,
  `report.sent` / `report.failed`, and `usage.error`, `input.refused`,
  `config.error`, `engine.error`. Every line is redacted.
- **Evidence.** `evidence.json` (schema `ledgerlink-qa/evidence/v1`): engine
  version, configuration hashes, run id, repository, commit, actor, mode,
  as-of date, profiles (tags, stages, enabled checks and their modes), every
  check's status, duration, mode, tool version and cached files, failed
  validations, summary counts, host. SARIF 2.1.0 carries the findings.
- **Centralised.** With `QA_REPORT_URL`, evidence is also POSTed to a
  collector.

## Releasing

1. In a pull request to `dev`: bump `version` in both `package.json` files,
   add a `## <version>` section to `CHANGELOG.md`, and update the pins that
   name the version: `qa --require` in `templates/pre-commit-config.yaml`.
   `node scripts/release.js --check` (run by CI) fails until they agree.
2. Merge `dev` into `main` (the only allowed source for `main`). CI runs on
   Linux, macOS and Windows and builds the package.
3. `release.yml` then, when the version is not tagged yet: checks the
   package's SHA-256, signs a build provenance attestation for it, tags the
   commit `v<version>` and publishes the GitHub release with the changelog
   section, install and verification commands. A failed release is retried
   with "Re-run jobs".
4. Roll out: announce the `npm install` command.

**Immutable releases (administrator, once).** Releases up to v0.2.3 are
published with `immutable: false`: an administrator can still replace their
assets, and only the attestation check would notice. Turn on immutable
releases for `LedgerLink-ai/ai-gov-qc` (repository Settings, General,
Releases, "Enable release immutability", or the organisation policy), so each
release's assets and tag are locked once published. Check with
`gh api repos/LedgerLink-ai/ai-gov-qc/releases/latest --jq .immutable`.
Release tags are also protected by
[`config/github/repo-ruleset-release-tags.json`](../config/github/repo-ruleset-release-tags.json)
([ENFORCEMENT.md](ENFORCEMENT.md#this-repositorys-own-rulesets)).

Version rules: semantic versioning; below 1.0 a minor version is breaking
(`--require 0.2.3` accepts 0.2.x from 0.2.3, never 0.3.0). A configuration
change an older engine cannot read raises `min_engine_version`. Evidence and
SARIF formats only gain fields within a schema version.

## Rollback

qa is pinned everywhere it runs, so rolling back is choosing the earlier
version, not reverting history:

| Where                      | Roll back by                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Developer machines         | Install the earlier release (same commands as above); `qa version` confirms                                                    |
| Hooks in a repository      | Set `qa --require` back in `.pre-commit-config.yaml` (within the same 0.x line, an older `--require` accepts the newer qa too) |
| A single misbehaving check | In `policy.yaml`, set the check to `mode: report` (or `off`) and release: no engine change needed                              |

Then fix forward: revert the change on `dev`, release a new patch version.
Never delete or move a published tag: repositories pin to it. Rollbacks are
tested: `qa --require` compatibility in `setup.test.ts`,
`min_engine_version` in `config.test.ts`.

## Maintenance

| Task                          | How                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Onboard a repository          | Add it to `registry/repositories.yaml` (`enabled: true`) and the ruleset's repository list; release                    |
| Switch a repository off       | `enabled: false` in `registry/repositories.yaml`; release                                                              |
| Exempt a finding              | `exemptions.yaml` with owner, approver, reason and an expiry date; code-owner review                                   |
| Upgrade Gitleaks              | Pin in `policy.yaml` `tools`, add `config/gitleaks_<version>_checksums.txt` from the Gitleaks release                  |
| Upgrade pre-commit or Semgrep | Pin in `policy.yaml` `tools`, regenerate `config/python-requirements.txt` (command at its top); tests check they match |
| Upgrade a GitHub Action       | Change the commit SHA (a test refuses unpinned actions); pick a version at least two weeks old                         |
| Update pre-commit-hooks       | New commit SHA with `# frozen: vX` in the template                                                                     |
| Clear a developer's cache     | `qa cache clear`                                                                                                       |
| A scanner hangs or is slow    | Check `check.finish` durations in JSON logs; raise `timeouts.tools.<tool>` or fix the rule                             |
| Engine error (exit 2) in CI   | The job log and `evidence.json` `failed_validations` name the check and the reason; never mark it passed               |
| Review dependencies           | `npm audit` for the engine (3 runtime dependencies, exact versions); Dependabot on this repository                     |

Security fixes follow the same release path, as a patch version, with the
rollout step done the same day.
