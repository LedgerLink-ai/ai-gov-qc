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

## Who can bypass

| Control                    | Who can bypass                                                                                              | Recorded where            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| Local hooks                | Anyone (`--no-verify`)                                                                                      | Nowhere                   |
| A finding in a repository  | An exemption in `exemptions.yaml` (code-owner review, expiry date) or the dated baseline on the base branch | This repository's history |
| A check, organisation-wide | `policy.yaml` (`mode: off` / `report`), reviewed by the Solution Architect                                  | This repository's history |
