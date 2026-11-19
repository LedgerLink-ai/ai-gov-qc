# Changelog

Every release of `@ledgerlink/qa` (`ledgerlink-qa-<version>.tgz`). The section
for a version is its GitHub release notes (`node scripts/release.js --notes <version>`),
and `node scripts/release.js --check` fails a release without one.

Versions follow semantic versioning. Below 1.0, a minor version is a major one:
`qa --require 0.2.3` accepts 0.2.3 and later 0.2.x, never 0.3.0. A release
that a repository pinned to an earlier compatible version can install without
changing its hooks.

## Unreleased

Upgrade notes

- Install the package and run `qa setup` again on every machine, so the new
  hook scripts are written. Setup now refuses when a system or global scope
  (or a file it includes) sets `core.hooksPath` to anything but qa's; remove
  that setting first. `qa doctor` names the scope and file of the setting git
  uses.
- **Regenerate `.qa/baseline.sarif`** (`qa baseline`) in every repository that
  has one. Gitleaks fingerprints are now a hash of the rule and the matched
  secret instead of the line, and `encoded-blob` fingerprints a hash of the
  blob, so existing baseline entries for Gitleaks and `encoded-blob` findings
  no longer match, and those findings block once their check is in block
  mode. `qa baseline` now records only error-level findings that no exemption
  covers.
- `block_from` in `policy.yaml` is only valid with `mode: report`; a check
  with `mode: block` and `block_from` is rejected. `block_from`, exemption
  `expires` and `--as-of` must be real calendar dates (`YYYY-MM-DD`, UTC).
  Path tags and exemptions must name repositories in
  `registry/repositories.yaml`.
- Repositories that call `qa-pr.yml`: re-copy `templates/qa-pr-caller.yml`
  (commit pin, `QA_REPORT_TOKEN` only). The gate's checkout needs
  `fetch-depth: 0`; `qa-pr.yml` has it.
- Administrators: apply this repository's rulesets in `config/github/` and
  enable release immutability (docs/ENFORCEMENT.md, docs/OPERATIONS.md).
- A sandbox made before this release (`../sandbox` without a `.qa-sandbox`
  marker) must be deleted by hand once before `npm run sandbox -- setup`.

Security fixes

- In-repository suppressions are ignored: `gitleaks:allow` comments,
  `.gitleaksignore`, `nosemgrep` comments and `.semgrepignore`; `GITLEAKS_*`
  variables are dropped. Exemptions and the baseline are the only
  suppressions. Scanner control files (`.gitleaksignore`, `.gitleaks.toml`,
  `.semgrepignore`, `.semgrep.yml`, `.semgrep.yaml`, `.semgrep/`) are never
  copied to the scan directory.
- Exemptions are considered before the baseline: an expired exemption blocks
  even when the finding is baselined.
- `paths.protected` checks the old path of a renamed or moved file (moving a
  protected file away is reported), runs for changes that only delete files
  (`include_deleted` in `checks.yaml`), and matches globs ignoring case.
- A file a native check applies to but cannot read as text (binary, over
  2 MB, unsupported encoding) is an `unscannable` finding: an error in CI, a
  warning locally. UTF-16 with a byte order mark is read, and a UTF-8 byte
  order mark is removed.
- The gate requires a GitHub origin: https, http and `git://` must name
  github.com; ssh and scp-like remotes may name github.com, ssh.github.com or
  an SSH alias that `ssh -G` resolves to them. An alias that cannot be
  resolved is not verified (skipped locally, exit 2 in CI). Repository names
  are matched ignoring case, and the run uses the allowlist's spelling.
- In GitHub Actions, `--as-of`/`QA_AS_OF`, `--exclude`, `--mode local`,
  `--actor`/`QA_ACTOR` and `--repo` are refused (exit 2), as `--config`
  already was. In CI without `--base`, the working-tree baseline is ignored.
- `--files` refuses absolute paths, drive letters and `..`.
- Credential scrubbing also removes names ending in `KEY` or `PASS`,
  containing `_KEY_`, starting with `KEY_`, or containing `MNEMONIC`, `SEED`
  or `PRIVATE` (`GIT_*` and `PYTHONHASHSEED` are kept).
- Dates are UTC, so every machine agrees when a date is reached.
- SARIF URIs are percent-encoded. The unused `release` scope is removed.

Detection

- Pull request history: in `qa prepr` and the gate, Gitleaks also scans the
  pull request's commits (merge base..HEAD), outside the result cache and
  even when no file changed. Findings name the commit, never the value. No
  merge base is an engine error (fetch the full history).
- The `bip39-mnemonic` rule is case-insensitive and also catches JSON arrays,
  numbered lists, YAML lists and hyphen-joined words (still 12 to 24
  consecutive wordlist words).
- New Gitleaks rules: `evm-private-key-call` (a 64-hex key passed to
  `new Wallet()`, `privateKeyToAccount()` or a Hardhat accounts list) and
  `evm-private-key-name` (a `0x` key assigned to a signer, `pk` or key name),
  both with an entropy floor.
- MCP allowlist: `mcpServers`, `servers` and `mcp.servers` are all checked; a
  key that is present but not an object is an error. Only `-y`, `--yes`,
  `--quiet` and `--silent` may precede the package (`unsafe-runner-flag`);
  env variables that redirect a registry or index or inject code
  (`npm_config_*`, `*REGISTRY*`, `NODE_OPTIONS`, `PIP_INDEX_URL` and the
  like) are `unsafe-env`. New locations: `**/.vscode/mcp.json`,
  `.vscode/settings.json`, `.cursor/mcp.json`, `.gemini/settings.json`,
  `.roo/mcp.json`, `.amazonq/mcp.json` and `.codex/config.toml` (a minimal
  parser that fails closed). Messages show only a URL's scheme and host and
  the command's name. A UTF-8 byte order mark is accepted.
- Content lint flags more hidden characters: bidi marks, invisible operators,
  Hangul fillers, variation selectors (one U+FE0E or U+FE0F after an emoji is
  allowed), line and paragraph separators and interlinear annotation.
  Negation is judged per clause, and a comma no longer ends a clause. New
  bypass phrases: `SKIP=`, `HUSKY=0`, `git commit -n`, abbreviated
  `--no-verify`, `core.hooksPath=/dev/null` and disabling a named hook. In
  READMEs phrase matches are warnings, and "To skip ..." descriptions are not
  flagged.
- The `ai-config` tag also covers AGENTS.override.md, CLAUDE.local.md,
  GEMINI.md, `.cursorrules`, `.windsurfrules`, `.windsurf/`, `.clinerules`,
  `.roo/`, `.roomodes`, `.gemini/`, `.codex/`, `.amazonq/`,
  `.github/chatmodes/`, `.github/agents/`, `.github/prompts/`,
  `**/.vscode/mcp.json` and `.vscode/settings.json`.
- Protected paths: the `ai-config` tag (agents may not edit AGENTS.md,
  CLAUDE.md, .mcp.json, .cursor/ and the like; humans get a note for
  code-owner review), `.github/**`, `**/secrets/**`, `**/.gitleaksignore`,
  `**/.gitleaks.toml` and `**/.semgrepignore`. `.env.*` keeps covering
  `.env.example`.

Hooks

- The repository's own hook (Git LFS and the like) runs, with the same input,
  even when qa errors or refuses; its exit code still counts.
- qa's own problems never block a commit: a bad `QA_LOG_LEVEL` or
  `QA_LOG_FORMAT` gives a warning and the defaults; a missing or broken
  `dist/` gives a warning (hook calls exit 0, other commands exit 2 with
  reinstall instructions); an incompatible `--require` never blocks
  prepare-commit-msg. `CI` set in a developer's shell no longer makes the
  local hook paths (`hook`, `prepare-commit-msg`, `commit-msg`) fail closed;
  `check`, `precommit`, `prepush`, `prepr` and `baseline` run explicitly
  still do.
- pre-commit gets a `PATH` that starts with a qa launcher for the running
  install (`<qa home>/shims/<id>/qa` and `qa.cmd`) and node's directory, so
  `language: system` hooks find qa in GUI git clients.
- `qa setup` reads every `core.hooksPath` git uses outside a repository
  (system, global and included files), refuses when one is not qa's (naming
  its scope and origin) and checks the effective value after writing.
  `qa doctor` shows the effective value with its scope and origin and fails
  when another setting overrides qa's.
- prepare-commit-msg leaves rebased, cherry-picked and reverted commits and
  commits on a detached HEAD as they are. Comment lines follow
  `core.commentChar` / `core.commentString`.
- Co-authored-by to Assisted-by: an alias with an `@` must be the co-author's
  exact address; any other alias must be a whole word of the name or the
  login of a GitHub no-reply address.
- A pass-through hook script copied into `.git/hooks` no longer runs itself
  for ever.

CI and release

- The gate verifies the qa package's attestation was signed by `release.yml`
  running for `refs/heads/main` on a GitHub-hosted runner
  (`--source-ref`, `--deny-self-hosted-runners`).
- `templates/qa-pr-caller.yml` calls `qa-pr.yml` at a commit SHA with a
  `# v<version>` comment, and passes only `QA_REPORT_TOKEN` instead of
  `secrets: inherit`. `scripts/release.js --check` refuses a tag or branch
  pin, a missing or newer release comment, or a comment that does not match
  the fetched tag.
- `qa prepr` runs the agent rules when any commit of the pull request
  declares AI assistance (`Assisted-by`, or a `Co-authored-by` naming a
  registry AI tool), not only for a registered agent author. `--actor` still
  decides.
- In CI, `qa prepr` ignores a coverage summary committed to the repository
  ("not coverage produced in this run"); locally nothing changes.
- Rulesets for this repository in `config/github/`: `main` and `dev` need one
  approving code-owner review (stale approvals dismissed); release tags
  cannot be created, moved or deleted except by GitHub Actions.
- Conformance: 27 fixtures. Fixtures can rename and delete files and describe
  a pull request (branch, commits, coverage); such fixtures run from a git
  repository on both paths. New fixtures F17 to F25: rename and deletion of
  protected paths, an agent editing AI configuration, and `pr.branch-name`,
  `pr.commits`, `pr.commit-messages`, `pr.diff-size` and `tests.coverage`.
  F00 is now a human change. `qa conform --require-all` fails on a skipped or
  pending fixture; CI uses it. The CLI path keeps `QA_HOME` and the
  `QA_*_BIN` tool locations, so it finds the same scanners as the API path.
- The sandbox (`scripts/make-sandbox.js`) runs the hooks: the clone's origin
  is `https://github.com/LedgerLink-ai/link_core.git`, with pushes going to
  the local bare repository (`pushurl`); its git and pre-commit calls use
  `../sandbox/gitconfig`; `../sandbox` is deleted only when it has the
  `.qa-sandbox` marker. `.pre-commit-hooks.yaml` names the real install
  route.
- picomatch 4.0.7.
- Tests: the cache performance guard compares the warm run with the cold one
  instead of a fixed time (`QA_PERF_BUDGET_MS` sets the cap); the global
  hooks tests allow slower git commands (`QA_TEST_GIT_TIMEOUT_MS`).

Docs

- README.md: repository location and status; how a run decides (exemptions
  before the baseline, dates, `unscannable`, renames and deletions,
  `include_deleted`); the GitHub origin check.
- docs/SECURITY.md: threat model rows for in-repository suppressions,
  unreadable files, history scanning, Actions overrides, `--files`,
  credential names and the hook paths in CI.
- docs/ENFORCEMENT.md: gate pins, rulesets, history scanning and the only
  suppressions.
- docs/PRECOMMIT.md: the commit-msg hook, new Gitleaks rules, the AI
  configuration checks, setup and `core.hooksPath`, commit message handling,
  the sandbox.
- docs/OPERATIONS.md, docs/PACKAGE.md, docs/TESTING.md and docs/DECISIONS.md:
  the pinned verify command, release immutability, what `qa setup` writes,
  fixtures, and the open point on a maximum exemption lifetime.

## 0.2.3

Upgrading from 0.2.2

- Install the package and run `qa setup` again. It now connects the hooks
  for every repository on the machine through git's global `core.hooksPath`,
  which changes the developer's global git configuration (below). Check a
  repository with `qa doctor`.
- qa now acts only in LedgerLink-ai repositories listed, and enabled, in
  `registry/repositories.yaml`; everywhere else it does nothing.
- Commit subjects become `<type>(<TICKET-123>): <description>` instead of
  `<TICKET-123>: <description>`.
- CI jobs that run `qa setup` for the scanners only pass
  `--no-global-hooks --no-git-template`.

Execution gate (issue #8)

- `check`, `precommit`, `prepare-commit-msg`, `commit-msg`, `prepush`,
  `prepr`, `baseline`, `repo-tool` and `repo-script` run only in a repository
  whose `origin` is `LedgerLink-ai/<name>` and whose `<name>` is listed with
  `enabled: true` in `registry/repositories.yaml` (new, with its schema).
  Anywhere else they do nothing and exit 0, with no output. `--repo` cannot
  switch QA on.
- In GitHub Actions the repository comes from `GITHUB_REPOSITORY` and the
  event payload, not from `origin`. Forks and pull requests from forks are
  skipped; an identity that cannot be verified is exit 2. In other CI, an
  `origin` that cannot be verified is exit 2.
- `enabled: false` is the administrators' opt-out for a listed repository.
  `qa validate` rejects duplicate entries.
- `qa doctor` says whether QA is enabled for the current repository, and why
  not.

Hooks for every repository (AIQC-85, issue #13)

- `qa setup` writes one script per git hook into `<qa home>/hooks` and sets
  git's global `core.hooksPath` to it. Every clone on the machine, made before
  or after, runs the hooks; nothing is copied into any repository. A global
  `core.hooksPath` that is not qa's is left alone, and setup says so.
- `qa setup --uninstall` removes the scripts and unsets `core.hooksPath` if it
  is qa's. `qa setup --no-global-hooks` sets up the per-clone git template of
  0.2.2 instead.
- New `qa hook <name>`, which the pre-commit, prepare-commit-msg, commit-msg
  and pre-push scripts call. It runs the repository's own `.git/hooks/<name>`
  first (git ignores `.git/hooks` once `core.hooksPath` is set, so Git LFS and
  similar tools keep working), then, in an opted-in repository, the checks
  through pre-commit: from the repository's `.pre-commit-config.yaml` when it
  has one, else from the default configuration shipped in the package
  (`templates/pre-commit-config.yaml`). Every other hook passes straight
  through to the repository's own copy.
- pre-commit's own scripts in `.git/hooks` are skipped in opted-in
  repositories, so the checks do not run twice.
- If qa or pre-commit is missing, the commit or push goes through with a
  warning: a broken install never blocks every repository.
- Repositories with husky (a local `core.hooksPath`) keep their hooks and add
  one line per hook, `qa hook <name>`; `qa doctor` points this out.
- Not covered: `reference-transaction`, `post-index-change`,
  `fsmonitor-watchman` and `push-to-checkout`.

Ticket-based branch names and commit messages (AIQC-87, issue #10)

- Branches are named `<type>/<TICKET-123>-<short-description>` and commit
  subjects `<type>(<TICKET-123>): <description>`. The ticket key comes from
  the branch, never from the message.
- New checks, in report mode until a blocking date is agreed:
  `branch.ticket` (pre-commit), `commit.message` (the new commit-msg hook,
  `qa commit-msg`) and `pr.commit-messages` (`qa prepr` and the PR gate).
  `pr.branch-name` now applies the same convention, as an error.
- `qa prepare-commit-msg` pre-fills `<type>(<TICKET-123>): ` instead of
  `<TICKET-123>: `, and keeps a type the developer wrote (`fix: x`).
- `policy.yaml` `conventions` section, per repository under
  `conventions.repos`, with the accepted ticket projects
  (`ticket_projects`); `pr.branch_pattern` is replaced by it.
- `qa setup` connects the commit-msg hook; `qa doctor` reports hooks set up by
  an earlier qa as out of date.

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
