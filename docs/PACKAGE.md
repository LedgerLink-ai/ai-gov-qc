# The installable package

Developers install the local checks from one package, `@ledgerlink/qa`, the same way on Windows, macOS and Linux. This page covers building it, hosting it and releasing it. For using it, see [PRECOMMIT.md](PRECOMMIT.md).

## What it contains

`npm run package` builds `out/ledgerlink-qa-<version>.tgz` (about 0.5 MB) and `out/ledgerlink-qa-<version>.tgz.sha256`.

| In the package  | What it is                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/`, `dist/` | The `qa` command: the compiled engine, plain JavaScript                                                                                      |
| `config/`       | A snapshot of the registries, `policy.yaml`, `checks.yaml`, the Gitleaks and Semgrep rules, the schemas, and the official Gitleaks checksums |
| `templates/`    | `pre-commit-config.yaml` for each repository                                                                                                 |
| `node_modules/` | Its npm dependencies (ajv, picomatch, yaml), bundled, so installing it needs no npm registry                                                 |

The tools that are not npm packages are installed by `qa setup` on each machine, at the versions pinned in `policy.yaml`:

| Tool       | Version | How `qa setup` installs it                                                                  |
| ---------- | ------- | ------------------------------------------------------------------------------------------- |
| pre-commit | 4.7.0   | pip, into a private Python environment in `~/.ledgerlink-qa/venv`                           |
| Semgrep    | 1.183.0 | same                                                                                        |
| Gitleaks   | 8.30.1  | the GitHub release archive for the OS and CPU, SHA-256 checked, into `~/.ledgerlink-qa/bin` |

Gitleaks builds exist for Windows (x64, arm64), macOS (x64, arm64) and Linux (x64, arm64 and others). Python 3.11 to 3.14 must already be on the machine; `qa setup` says so if it is missing.

## Where to host it

Any of these works; developers then run `npm install -g <location>` and `qa setup`:

| Host                  | Developers install with                                                                                 | Notes                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A shared drive        | `npm install -g \\server\share\ledgerlink-qa-0.2.1.tgz` (or the macOS/Linux mount path)                 | Simplest; publish the `.sha256` next to it                                                          |
| A GitHub release      | `npm install -g https://github.com/<org>/qc-workflows/releases/download/v0.2.1/ledgerlink-qa-0.2.1.tgz` | What `.github/workflows/release.yml` makes; private repositories need a download with a token first |
| AWS CodeArtifact      | `npm install -g @ledgerlink/qa@0.2.1` after `aws codeartifact login --tool npm …`                       | Same registry as `@ledgerlink/link-sdk`; the release workflow has the step, commented out           |
| GitHub Packages (npm) | `npm install -g @ledgerlink/qa@0.2.1` with an `.npmrc` for the `@ledgerlink` scope                      | Needs the GitHub organisation                                                                       |

## Releasing

Releases are automatic. To release a change, bump the version in its pull request:

1. Set the same new version in `package.json` and `packages/engine/package.json` (and in `package-lock.json`). Raise the `--require` versions in `templates/pre-commit-config.yaml` only when repositories need the new version; a patch release usually does not.
2. Merge the pull request into `main`.

On the push to `main`, `ci.yml` runs on Windows, macOS and Linux:

- lints, formats and builds
- runs `qa setup` to get the pinned scanners
- runs the tests and the conformance fixtures
- builds the package, installs it globally from the file and runs it

When it passes, `release.yml` reads the version in `package.json`. If `v<version>` is not tagged yet, it tags the merged commit and publishes a GitHub release with the package that `ci.yml` built and tested, its SHA-256, install instructions, and the pull requests since the last release. A merge that leaves the version unchanged releases nothing (the run says so). A failed release is retried with **Re-run jobs** on its run. Actions are pinned to commit SHAs.

**A path to the file must be absolute or start with `./`.** npm reads `out/ledgerlink-qa-0.2.1.tgz` as a GitHub `owner/repo` and fails with `Permission denied (publickey)`.

**Every published package needs a new version.** npm caches packages by name and version, so a rebuilt `0.1.0` is not picked up by machines that installed `0.1.0` before.

## Trying it locally

```bash
npm run package
npm install -g --prefix <empty folder> ./out/ledgerlink-qa-0.2.1.tgz --offline
<empty folder>/qa setup --home <another folder> --no-git-template
```

`--prefix` and `--home` keep the test away from the machine's own setup. The sandbox in [PRECOMMIT.md](PRECOMMIT.md) uses the package the same way: `npm run sandbox -- refresh` rebuilds it, unpacks it into `../sandbox/qa-package`, and points the clone's hooks at it.

To remove an installation: `npm uninstall -g @ledgerlink/qa`, delete `~/.ledgerlink-qa`, and unset `init.templateDir` if `qa setup` set it (`git config --global --unset init.templateDir`).

## Checked on 3 Nov 2026 (Windows 11 only)

- **Package:** built at 512 KB. It installed with `npm install -g --offline` in 8 s, and `qa validate` used the bundled configuration.
- **`qa setup`** in a throwaway folder installed pre-commit 4.7.0 and Semgrep 1.183.0 into the private environment. Gitleaks 8.30.1 was downloaded, SHA-256 checked and installed.
- **Git template:** with a separate global git config, `qa setup` created the template. A new repository then had all three hooks with no `pre-commit install`:
  - (0.1.0, the commit-msg design) `update readme` was blocked and `chore(repo): add local checks` with `Refs: LL-1423` committed.
  - (0.2.0) On branch `LCORE-210-limit-invariants` with a default set, `git commit -m "Add idempotency key to refund endpoint"` became `LCORE-210: Add idempotency key to refund endpoint` plus `Assisted-by: Cursor, gpt-5, 1.7.0`; with `--no-verify` a Cursor `Co-authored-by` line was still converted; amends and merges were left alone.
  - `qa doctor` showed READY.
  - With the config changed to require a newer version, the hook stopped with the install command.
  - (0.2.1) On branch `qa/quality-gates` with no default set, the hook printed both reasons it added nothing; with `ledgerlink.assistedBy` set and a `LCORE-210-…` branch, both were added; with the default `none` it stayed quiet about Assisted-by. Repository configurations that pin `--require 0.2.0` run 0.2.1 unchanged.
- **Sandbox:** on the package, stage 1 committed, a staged secret was blocked, a type error was blocked at push, and the good and bad pre-PR branches passed and were blocked as expected.
- **macOS and Linux** have not been run here. `ci.yml` runs them on GitHub once the repository is pushed.
