# Changelog

Every release of `@ledgerlink/qa` (`ledgerlink-qa-<version>.tgz`). The section
for a version is the "What's new" part of its GitHub release notes
(`templates/release-notes.md`, `node scripts/release.js --notes <version>`),
and `node scripts/release.js --check` fails a release without one.

Versions follow semantic versioning. Below 1.0, a minor version is a major one:
`qa --require 0.2.3` accepts 0.2.3 and later 0.2.x, never 0.3.0. A release
that a repository pinned to an earlier compatible version can install without
changing its hooks.

## 0.2.4

Upgrading from 0.2.3

- Install the package and run `qa setup` again. Compatible with 0.2.x:
  repositories pinned with `qa --require 0.2.0` to `0.2.3` keep working.
- The secret scan now finds credentials it missed before (AIQC-89), so a
  commit that passed on 0.2.3 can be blocked on 0.2.4. Move the value to a
  variable or the secrets manager; for a test value, see "Not reported" below.

### Readable hook output, and the real reason in IDE commit pop-ups (AIQC-88)

Nothing about what is checked or what blocks changes in this part.

- When a commit, commit message or push is stopped, the hooks print one
  summary line: what was found and where (`qa: commit blocked: possible
secret: GitHub Personal Access Token (github-pat) in src/config.ts line 12`),
  or which hook failed.
- Without a terminal (VS Code's commit button and other IDEs), the hook
  collects the output and prints the summary line first, so the pop-up, which
  shows only the first line, says why. In a terminal the output streams as
  before and the summary is the last line. `QA_HOOK_OUTPUT=stream|buffer`
  chooses.
- The text report puts each finding's message, fix and rule ids on their own
  lines. Checks that did not run are counted, and listed only with the new
  `--verbose` flag; checks deferred to CI and checks that could not run are
  always shown.
- Text logs say in words what happened (`secrets.gitleaks did not run here
(...); CI runs it`) instead of printing the event as JSON. JSON logs are
  unchanged.
- Gitleaks findings name the kind of secret plainly ("GitHub Personal Access
  Token") instead of repeating the scanner's whole description.
- The default hook configuration no longer marks the repository's own
  Prettier, ESLint, tests, type check and build hooks as verbose, so a passing
  run does not print their `- hook id` and `- duration` lines.

### Secrets: credentials in any file (AIQC-89)

- Fix: `secrets.gitleaks` missed most credentials that are not a known token
  format. Gitleaks' default generic rule only matches values of 10 to 150
  characters made of letters, digits, `_`, `.`, `=` and `-` (or longer
  base64), so it missed an AWS CodeArtifact token in `.npmrc` (about 1,000
  characters with `.`, `-` and `_`), passwords containing characters such as
  `@ ! # % & ~`, and credentials inside URLs, connection strings, command
  lines and XML. Of 38 such leaks in a test set, it reported 5; it now reports
  all 38.
- New rules, by the shape of a credential rather than by file, so they apply
  to every file a commit or push changes:
  - `credential-assignment`: a quoted value given to a password, secret,
    token or key name (`password: "..."`, `"apiKey": "..."`,
    `const dbPassword = '...'`, `$env:API_TOKEN = "..."`), in any file, any
    length, any characters;
  - `credential-assignment-config`: the same, unquoted, in `.env*`,
    properties, ini, YAML, TOML, Terraform, shell, PowerShell, CI and Docker
    files and package-manager credential files (`.npmrc`, `.yarnrc.yml`,
    `.pypirc`, `credentials`, ...);
  - `credential-export`: `export TOKEN=...`, `set`, `ENV` and `ARG` lines in
    any file, including documentation;
  - `credential-in-url`: `https://user:password@host`, `postgres://`,
    `amqp://`, git remotes and registry URLs;
  - `credential-in-connection-string`: `Password=...;`, `?password=`,
    `?access_token=`, `?sig=` (Azure SAS);
  - `credential-on-command-line`: `--password`, `--token`, `--api-key`,
    `--secret` and `curl -u user:password`;
  - `credential-authorization-header`: `Authorization: Bearer|Basic|Token ...`;
  - `credential-in-xml` and `credential-in-xml-setting`: Maven
    `settings.xml`, `NuGet.Config`, `app.config` and `web.config`;
  - `netrc-password`, and `credential-file` for files that are credentials
    whatever they contain: SSH private keys (`id_rsa`, `id_ed25519`, ...),
    `.git-credentials`, `.pgpass` and keystores (`.p12`, `.pfx`, `.jks`,
    `.keystore`, `.ppk`, `.kdbx`);
  - `jwe-token` (any encrypted JWT) and `aws-codeartifact-token`.
- Not reported, so the rules do not stop ordinary work: values kept elsewhere
  (`${VAR}`, `$VAR`, `%VAR%`, `{{ template }}`, `<placeholder>`, YAML tags),
  identifiers and paths (`process.env.DB_PASSWORD`, `/run/secrets/db`),
  masked values (`********`), examples (`changeme`, `your-token`, `test`,
  `example`), local hosts and documentation domains in URLs
  (`localhost`, `example.com`), and `--password-stdin`. On 58 MB of
  third-party packages the new rules added no finding outside test files and
  documentation examples.
- Each line is reported once: where several rules match it, the most specific
  is kept (for example `aws-codeartifact-token` over `jwe-token`).
- Conformance fixtures can generate a value each time they run
  (`{ random: password | alnum | hex | base64url, length | parts, prefix }`),
  so this repository holds no credential, not even split into pieces. F17 and
  F18 use them: 30 leaks that must be reported, and 29 look-alikes that must
  not.

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
