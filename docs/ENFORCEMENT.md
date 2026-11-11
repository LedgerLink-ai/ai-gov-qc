# Enforcement: why the checks cannot be skipped

Issue #15, "Bypass prevention". The local hooks are fast feedback; the
control is the pull request gate in GitHub Actions, made mandatory by
rulesets that only organisation administrators can bypass.

## What local hooks cannot guarantee

The git hooks run on the developer's machine, which the developer controls.
They are skipped or defeated by:

| How                                                                 | Effect                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `git commit --no-verify`, `git push --no-verify`                    | pre-commit and pre-push hooks do not run                        |
| Not running `pre-commit install`, or `core.hooksPath` set elsewhere | no hooks at all                                                 |
| Editing `.pre-commit-config.yaml` or `.git/hooks/*`                 | different or no checks (the file is a protected path in review) |
| Changing the `origin` remote                                        | the local gate (identity from `origin`) skips the repository    |
| An old qa, or a missing scanner                                     | `--require` stops an old qa; a missing scanner defers to CI     |
| The commit itself (rebase, amend, `commit-tree`)                    | hooks see only what git hands them                              |

None of these reach the pull request gate, which runs on GitHub's runners
with qa and its configuration from a verified release.

## The pull request gate

[`.github/workflows/qa-pr.yml`](../.github/workflows/qa-pr.yml) runs on every
pull request into a protected branch of an opted-in repository:

0. Fails a pull request from a fork before anything runs: a required check
   must never pass without checking.
1. Installs the pinned qa release (`qa-version`), after checking its SHA-256
   and its build provenance attestation (signed by this repository's
   `release.yml`). Nothing from the pull request runs before this.
2. Installs Gitleaks, Semgrep and pre-commit at the pinned versions; every
   download is hash-checked.
3. Runs `qa prepr --mode ci`: every stage, on everything the pull request
   changes, with the configuration released with qa. In GitHub Actions the
   engine refuses `--config` and `QA_CONFIG_DIR`, takes the repository's
   identity from the Actions environment (only allowlisted LedgerLink-ai
   repositories run; forks never do) and reads the baseline from the base
   branch.
4. Fails on a blocking finding (exit 1) or on any check that could not run
   (exit 2). Uploads SARIF to code scanning and keeps `evidence.json` for 90
   days; the job summary lists every check.

The job is named `pull request checks`; called from a stub, its status check
is **`qa / pull request checks`**.

## Making it mandatory

Organisation owners do this once; repository settings are not enough on their
own, because a repository admin could change them. Rulesets for it are in
[`config/github/`](../config/github).

### Option A (preferred): organisation ruleset with a required workflow

[`config/github/org-ruleset-qa.json`](../config/github/org-ruleset-qa.json)
targets the opted-in repositories (the same names as
`registry/repositories.yaml`) and their default, `dev`, `develop` and
`release/*` branches, and:

- requires `qa-pr.yml` from this repository, at the release tag, to pass
  before merging ("Require workflows to pass before merging")
- requires a pull request with one approval, code-owner review, approval of
  the last push and resolved threads; dismisses stale approvals
- blocks force pushes and branch deletion
- lets only **organisation administrators** bypass, and only through a pull
  request (`bypass_mode: pull_request`), so every bypass is recorded

Fill in `repository_id` (the id of this repository), then:

```bash
gh api repos/LedgerLink-ai/ai-gov-qc --jq .id
gh api -X POST orgs/LedgerLink-ai/rulesets --input config/github/org-ruleset-qa.json
```

Required workflows in rulesets need GitHub Enterprise Cloud (or Team, for
public repositories). Check LedgerLink's GitHub plan first; otherwise use
Option B.

### Option B: a stub workflow and a required status check

Where Option A is not available:

1. Copy [`templates/qa-pr-caller.yml`](../templates/qa-pr-caller.yml) to
   `.github/workflows/qa.yml` in the repository. Pin `uses:` to the commit of
   the release tag (`git rev-list -n 1 v<version>`).
2. Apply
   [`config/github/repo-ruleset-qa-required-check.json`](../config/github/repo-ruleset-qa-required-check.json),
   which requires the `qa / pull request checks` status check (with
   up-to-date branches) and the same review rules; only the repository admin
   role can bypass, through a pull request:

   ```bash
   gh api -X POST repos/LedgerLink-ai/<repo>/rulesets --input config/github/repo-ruleset-qa-required-check.json
   ```

3. Keep `.github/` owned by DevOps in CODEOWNERS (it is a protected path), so
   the stub cannot be removed without their review.

### Rolling out a new qa release

Option A: update `ref` in the organisation ruleset to the new tag. Option B:
update `qa-version` and the pinned `uses:` in each stub (one pull request per
repository, or a bulk change). In both, rolling back is the same change with
the earlier version ([OPERATIONS.md](OPERATIONS.md#rollback)).

## Who can bypass

| Control                         | Who can bypass                                                                                              | Recorded where                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Local hooks                     | Anyone (`--no-verify`)                                                                                      | Nowhere; the pull request gate re-runs |
| Organisation ruleset (Option A) | Organisation administrators, through a pull request                                                         | Ruleset insights, audit log            |
| Repository ruleset (Option B)   | Repository admin role, through a pull request                                                               | Ruleset insights, audit log            |
| A finding in a repository       | An exemption in `exemptions.yaml` (code-owner review, expiry date) or the dated baseline on the base branch | This repository's history              |
| A check, organisation-wide      | `policy.yaml` (`mode: off` / `report`), reviewed by the Solution Architect                                  | This repository's history              |

## Checking it works

On an opted-in repository, after setup:

1. Open a pull request that adds an `AGENTS.md` containing a zero-width
   space. The `qa / pull request checks` check fails with `BLOCK
ai-config.content-lint`, and merging is blocked.
2. Commit the same file with `--no-verify`: the local hook is skipped, and
   the pull request check still fails.
3. As a non-admin, try to merge anyway or change the ruleset: refused.
4. Open the same pull request from a fork: the check fails at its first step
   without running anything from the fork (forks are never trusted), so the
   pull request stays unmergeable until a maintainer brings the change into a
   branch of the repository.
