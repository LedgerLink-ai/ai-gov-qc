# Enforcement: the limits of local hooks

qa runs on the developer's machine: at every commit and push through the git
hooks, and before a pull request when the developer runs `qa prepr`. These
checks are fast feedback. They are not an enforcement point, because the
developer controls the machine they run on.

## Pull requests are checked outside this repository

Pull request checks for LedgerLink-ai repositories are handled separately,
not by this repository. ai-gov-qc used to ship a GitHub pull request gate
(`.github/workflows/qa-pr.yml`, a caller stub and organisation and repository
rulesets). It was never enabled in any repository and was removed in AIQC-92.
Releases up to v0.2.3 still contain it at their tag.

The `qa prepr` command and the `pr.*` checks stay in the package: developers
can run them before opening a pull request
([BRANCH-AND-COMMIT-CONVENTIONS.md](BRANCH-AND-COMMIT-CONVENTIONS.md),
[PRECOMMIT.md](PRECOMMIT.md)).

## What local hooks cannot guarantee

The git hooks run on the developer's machine, which the developer controls.
They are skipped or defeated by:

| How                                                       | Effect                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| `git commit --no-verify`, `git push --no-verify`          | pre-commit and pre-push hooks do not run                        |
| Not running `qa setup`, or `core.hooksPath` set elsewhere | no hooks at all                                                 |
| Editing `.pre-commit-config.yaml` or `.git/hooks/*`       | different or no checks (the file is a protected path in review) |
| Changing the `origin` remote                              | the local gate (identity from `origin`) skips the repository    |
| An old qa, or a missing scanner                           | `--require` stops an old qa; a missing scanner defers to CI     |
| The commit itself (rebase, amend, `commit-tree`)          | hooks see only what git hands them                              |

Anything that must hold for every change has to be checked where the
developer cannot skip it: on the pull request, by the checks run outside this
repository, and by each repository's branch rulesets and code-owner review.

## This repository's own rulesets

The rules that protect qa itself are in `config/github/` too, and an
administrator of `LedgerLink-ai/ai-gov-qc` applies them (repository settings,
Rules, Rulesets; or `gh api -X PUT repos/LedgerLink-ai/ai-gov-qc/rulesets/<id> --input <file>`):

| File                                                                                | Protects       | Rules                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`repo-ruleset-main.json`](../config/github/repo-ruleset-main.json)                 | `main`         | Pull request with **one approval and code-owner review**, stale approvals dismissed, threads resolved, merge commits only (dev is merged into main); CI on three OSes and `branch-policy` pass |
| [`repo-ruleset-dev.json`](../config/github/repo-ruleset-dev.json)                   | `dev`          | Pull request with **one approval and code-owner review**, stale approvals dismissed, threads resolved, squash or merge; CI on three OSes passes                                                |
| [`repo-ruleset-release-tags.json`](../config/github/repo-ruleset-release-tags.json) | `refs/tags/v*` | Release tags cannot be created, moved or deleted, except by GitHub Actions (`release.yml` creates them)                                                                                        |

As of 18 Nov 2026 the live `main` and `dev` rulesets require **no**
approval and no code-owner review, so the code-owner review that the
baseline, exemptions, allowlist and `.github/` rely on is not enforced in
this repository until an administrator applies the two files above. The live
release-tag ruleset blocks moving and deleting `v*` tags but not creating
them; the file adds that. CODEOWNERS must name teams that exist, with write
access, or code-owner review cannot be satisfied.

## Who can bypass

| Control                    | Who can bypass                                                                                              | Recorded where            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| Local hooks                | Anyone (`--no-verify`)                                                                                      | Nowhere                   |
| A finding in a repository  | An exemption in `exemptions.yaml` (code-owner review, expiry date) or the dated baseline on the base branch | This repository's history |
| A check, organisation-wide | `policy.yaml` (`mode: off` / `report`), reviewed by the Solution Architect                                  | This repository's history |

Suppressions inside the checked repository do not count: `gitleaks:allow`
and `nosemgrep` comments, `.gitleaksignore` and `.semgrepignore` are ignored,
and scanner configuration files from the change never reach the scan. An
exemption in `exemptions.yaml` and the dated baseline are the only
suppressions.
