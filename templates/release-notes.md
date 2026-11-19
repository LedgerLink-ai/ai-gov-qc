`@ledgerlink/qa` {{version}}: local QA checks for LedgerLink-ai repositories, run by git hooks on every commit and push.

|           |                                                       |
| --------- | ----------------------------------------------------- |
| Package   | `ledgerlink-qa-{{version}}.tgz` (attached below)      |
| SHA-256   | {{sha256}}                                            |
| Tag       | `v{{version}}`                                        |
| Platforms | Windows, macOS, Linux                                 |
| Changes   | [What's new in {{version}}](#whats-new-in-{{anchor}}) |

## Quick install

One command on Windows, macOS and Linux, then setup. You need Node.js 20+, Git and Python 3.11 to 3.14 first ([Requirements](#requirements)).

```bash
npm install -g --ignore-scripts https://github.com/{{repo}}/releases/download/v{{version}}/ledgerlink-qa-{{version}}.tgz
qa setup
```

Then:

- Put `~/.ledgerlink-qa/bin` on your PATH (the last command for your OS in [Install](#install)) and open a new terminal.
- Run `qa doctor` inside a LedgerLink-ai repository. It ends with `result: READY` when the hooks will run.

This installs the package straight from this release without checking its SHA-256 or its build provenance attestation. To check both, use the step-by-step [Install](#install).

**Contents:** [Quick install](#quick-install) · [Requirements](#requirements) · [What `qa setup` installs](#what-qa-setup-installs) · [Where qa is installed](#where-qa-is-installed) · [Install](#install) · [Check the installation](#check-the-installation) · [Upgrade](#upgrade) · [Uninstall](#uninstall) · [Roll back](#roll-back) · [What's new](#whats-new-in-{{anchor}}) · [Pull requests](#pull-requests-in-this-release)

## Requirements

Install these before you install qa. qa does not install them.

| Dependency        | Version                                                                                | Used for                                                                                                  | Check with                                              |
| ----------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Node.js, with npm | 20 or later                                                                            | Runs qa                                                                                                   | `node --version`                                        |
| Git               | Any recent version. On Windows, Git for Windows: git runs the hooks with its own `sh`. | The hooks on every commit and push                                                                        | `git --version`                                         |
| Python            | 3.11 to 3.14                                                                           | A private environment for pre-commit and Semgrep                                                          | Windows: `py -0`. macOS and Linux: `python3 --version`. |
| GitHub CLI (`gh`) | Any recent version, signed in with access to `{{repo}}`                                | Downloading the package and verifying its attestation. Optional: you can download from this page instead. | `gh auth status`                                        |

You also need:

- **Network access**, during `qa setup` and the first commit in each repository, to:
  - github.com: the Gitleaks release, and the pinned pre-commit-hooks repository;
  - pypi.org and files.pythonhosted.org: pre-commit and Semgrep.
- **About 420 MB of disk** for the qa home folder, most of it Semgrep.
- **No administrator rights.** Everything installs into your user profile. On Linux, if `npm install -g` fails with `EACCES`, install Node with a version manager such as nvm, or set npm's prefix to a folder you own. Do not use `sudo`.

## What `qa setup` installs

You do not install these yourself. `qa setup` installs the pinned versions and checks each download before using it.

| Tool       | Version        | Source                                            | Integrity check                                                                                                         |
| ---------- | -------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| pre-commit | {{pre_commit}} | PyPI, with pip, into a private Python environment | `pip --require-hashes --no-deps`: every Python dependency is pinned and hash-checked (`config/python-requirements.txt`) |
| Semgrep    | {{semgrep}}    | PyPI, the same way                                | The same                                                                                                                |
| Gitleaks   | {{gitleaks}}   | The GitHub release for your OS and CPU            | SHA-256 against `config/gitleaks_{{gitleaks}}_checksums.txt` in the package                                             |

Gitleaks builds used by `qa setup`:

| OS      | CPUs                                  |
| ------- | ------------------------------------- |
| Windows | x64, arm64, x86                       |
| macOS   | Intel (x64) and Apple silicon (arm64) |
| Linux   | x64, arm64, armv7, x86                |

## Where qa is installed

| What                                                 | Windows                                                           | macOS and Linux                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| The npm package                                      | `%APPDATA%\npm\node_modules\@ledgerlink\qa`                       | `$(npm prefix -g)/lib/node_modules/@ledgerlink/qa` |
| The `qa` command                                     | `%APPDATA%\npm\qa.cmd`                                            | `$(npm prefix -g)/bin/qa`                          |
| qa home (`QA_HOME` or `--home` to change it)         | `%USERPROFILE%\.ledgerlink-qa`                                    | `~/.ledgerlink-qa`                                 |
| The private Python environment (pre-commit, Semgrep) | `<qa home>\venv\Scripts`                                          | `<qa home>/venv/bin`                               |
| Gitleaks, and the pre-commit and Semgrep launchers   | `<qa home>\bin` (`gitleaks.exe`, `pre-commit.cmd`, `semgrep.cmd`) | `<qa home>/bin`                                    |
| The git hook scripts for every repository            | `<qa home>\hooks`                                                 | `<qa home>/hooks`                                  |
| Scanner result cache (local only)                    | `<qa home>\cache`                                                 | `<qa home>/cache`                                  |
| Global git setting `core.hooksPath`                  | `%USERPROFILE%\.gitconfig`                                        | `~/.gitconfig`                                     |
| pre-commit's own cache (hook environments)           | `%USERPROFILE%\.cache\pre-commit`                                 | `~/.cache/pre-commit`                              |

The npm paths are npm's defaults; `npm prefix -g` shows yours (nvm and similar tools use their own folders).

**How the hooks work:** `qa setup` writes one script per git hook into `<qa home>/hooks` and points git's global `core.hooksPath` at that folder. Every clone on the machine, existing or new, then runs the hooks, and nothing is copied into any repository. The checks run only in LedgerLink-ai repositories listed and enabled in `registry/repositories.yaml`. Everywhere else the hooks do nothing.

`core.hooksPath` is the only setting qa changes outside the folders above. If it is already set to something else, `qa setup` leaves it as it is and tells you what to do.

## Install

The step-by-step install checks the package before installing it. For the one-command install, see [Quick install](#quick-install).

Run these from the folder you download the package into.

### Windows (PowerShell)

```powershell
gh release download v{{version}} --repo {{repo}} --pattern 'ledgerlink-qa-{{version}}.tgz*'
(Get-FileHash .\ledgerlink-qa-{{version}}.tgz -Algorithm SHA256).Hash.ToLower()
gh attestation verify .\ledgerlink-qa-{{version}}.tgz --repo {{repo}}
npm install -g --ignore-scripts .\ledgerlink-qa-{{version}}.tgz
qa setup
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:USERPROFILE\.ledgerlink-qa\bin", 'User')
```

- The second command must print the SHA-256 at the top of these notes.
- The last command puts Gitleaks, pre-commit and Semgrep on your PATH. Open a new terminal afterwards.

### macOS (Terminal, zsh)

```bash
gh release download v{{version}} --repo {{repo}} --pattern 'ledgerlink-qa-{{version}}.tgz*'
shasum -a 256 -c ledgerlink-qa-{{version}}.tgz.sha256
gh attestation verify ledgerlink-qa-{{version}}.tgz --repo {{repo}}
npm install -g --ignore-scripts ./ledgerlink-qa-{{version}}.tgz
qa setup
echo 'export PATH="$HOME/.ledgerlink-qa/bin:$PATH"' >> ~/.zshrc
```

### Linux (bash)

```bash
gh release download v{{version}} --repo {{repo}} --pattern 'ledgerlink-qa-{{version}}.tgz*'
sha256sum -c ledgerlink-qa-{{version}}.tgz.sha256
gh attestation verify ledgerlink-qa-{{version}}.tgz --repo {{repo}}
npm install -g --ignore-scripts ./ledgerlink-qa-{{version}}.tgz
qa setup
echo 'export PATH="$HOME/.ledgerlink-qa/bin:$PATH"' >> ~/.bashrc
```

On macOS and Linux the checksum command must print `ledgerlink-qa-{{version}}.tgz: OK`. Open a new terminal afterwards.

**Without `gh`:** download `ledgerlink-qa-{{version}}.tgz` from the assets below, check its SHA-256, and start at `npm install -g`. You cannot verify the attestation this way.

**CI jobs** that only need the scanners run `qa setup --no-global-hooks --no-git-template`, so the runner's global git configuration is not changed.

## Check the installation

```bash
qa --version
git config --global core.hooksPath
qa doctor
```

- `qa --version` prints `{{version}}`.
- `git config --global core.hooksPath` prints the hooks folder in your qa home.
- Run `qa doctor` inside a LedgerLink-ai repository. It says whether QA is enabled for that repository, and why not if it isn't, and checks the tools and hooks.

## Upgrade

1. Install the package as in [Install](#install). It replaces the installed version.
2. Run `qa setup` again, then `qa doctor` in a repository. `qa doctor` reports hooks set up by an earlier qa as out of date.
3. Read [What's new in {{version}}](#whats-new-in-{{anchor}}) for anything that changes for developers or CI.

## Uninstall

Remove the hooks **first**, while qa is still installed:

```bash
qa setup --uninstall
npm uninstall -g @ledgerlink/qa
```

`qa setup --uninstall` deletes the hook scripts. It unsets the global `core.hooksPath` only if it points at qa's hooks, so every repository uses its own `.git/hooks` again.

If you run `npm uninstall` first, `core.hooksPath` keeps pointing at qa's hook scripts. To fix that, run `git config --global --unset core.hooksPath`.

Then delete the tools. This is optional; it frees about 420 MB.

|                                                             | Windows (PowerShell)                                                                    | macOS and Linux                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| qa home                                                     | `Remove-Item -Recurse -Force "$env:USERPROFILE\.ledgerlink-qa"`                         | `rm -rf ~/.ledgerlink-qa`                                                            |
| pre-commit's cache (also used by other pre-commit projects) | `Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\pre-commit"`                      | `rm -rf ~/.cache/pre-commit`                                                         |
| The PATH entry                                              | Remove `%USERPROFILE%\.ledgerlink-qa\bin` from the user `Path` in Environment Variables | Remove the `export PATH=...ledgerlink-qa/bin...` line from `~/.zshrc` or `~/.bashrc` |

## Roll back

Install the previous release the same way, and set `qa --require` and `qa-version` back (docs/OPERATIONS.md).

## What's new in {{version}}

{{changes}}

## Pull requests in this release

{{pull_requests}}
