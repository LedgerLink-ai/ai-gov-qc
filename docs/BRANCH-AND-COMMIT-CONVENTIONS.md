# Branch names and commit messages

AIQC-87 (GitHub issue #10). Every branch carries a ticket key, and every commit message gets its key from the branch. Developers type the key once, in the branch name. The QA engine reads it from there and never trusts a key typed into the message.

## The convention

```
<type>/<TICKET-123>-<short-description>        branch
<type>(<TICKET-123>): <description>            commit subject
```

| Branch                                | Commit subject the hook pre-fills               |
| ------------------------------------- | ----------------------------------------------- |
| `feature/LL-1234-user-authentication` | `feat(LL-1234): implement user authentication`  |
| `bugfix/LL-2345-fix-login-validation` | `fix(LL-2345): resolve login validation issue`  |
| `hotfix/LL-3456-security-patch`       | `hotfix(LL-3456): patch security vulnerability` |

Branch types and the commit type each one pre-fills: `feature` and `feat` → `feat`, `bugfix` and `fix` → `fix`, `hotfix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, `build`. A commit can use another type than its branch's: write `fix: …` on a feature branch and the hook makes it `fix(LL-1234): …`.

## What runs where

| Where                             | Check                | What it does                                                                                                                                                                    |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-commit hook (`qa precommit`)  | `branch.ticket`      | The branch being committed to has a valid ticket key and type. Refuses the commit otherwise (block mode), with the command to rename the branch                                 |
| prepare-commit-msg hook           | (pre-fill)           | Writes `<type>(<TICKET-123>): ` into the subject from the branch. Never rejects a commit                                                                                        |
| commit-msg hook (`qa commit-msg`) | `commit.message`     | The subject follows the convention and names the branch's ticket. Merges, `fixup!`/`squash!`/`amend!` and `Revert "…"` subjects are left to git                                 |
| `qa prepr` and the PR gate        | `pr.branch-name`     | The pull request's branch follows the convention and is not the base branch itself                                                                                              |
| `qa prepr` and the PR gate        | `pr.commit-messages` | Every commit of the pull request follows the convention with the branch's ticket. Local hooks can be skipped with `--no-verify`; this is where the convention cannot be skipped |

During a rebase HEAD is detached; the hooks read the branch being rebased instead. On a detached HEAD with no rebase, `branch.ticket` warns and does not block.

The pre-filling, in detail:

- An empty message (the editor) starts with the prefix: `feat(LL-1234): `.
- `add retry` becomes `feat(LL-1234): add retry`.
- `fix: add retry` becomes `fix(LL-1234): add retry` (the type you chose is kept).
- `LL-1234: add retry` (the older form) becomes `feat(LL-1234): add retry` when the key is the branch's.
- A subject that already follows the convention is left alone. So is one with a scope of its own (`feat(api): …`) or another ticket's key: the commit-msg hook then says what to change.

## Errors and how to fix them

| Rule               | Example                                       | Fix (the message gives the exact command)                                                                                   |
| ------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `no-ticket`        | `main`, `feature/user-authentication`         | `git branch -m feature/<TICKET-123>-…`, or on `main`: `git switch -c feature/<TICKET-123>-…` (staged changes come along)    |
| `malformed-ticket` | `feature/ll-1234-auth`, `bugfix/LL1234-x`     | `git branch -M feature/LL-1234-auth` (`-M` when only the case changes; `-m` says the branch exists on Windows and macOS)    |
| `format`           | `LL-1234-auth`, `wip/LL-1234-auth`            | `git branch -m feature/LL-1234-auth`: a known type, then `/`, then the key                                                  |
| `unknown-project`  | `feature/XYZ-1-x` where only `LL` is accepted | Use a ticket from an accepted project                                                                                       |
| `format` (commit)  | `fixed the bug`                               | `fix(LL-1234): <description>`; the refused message is kept: `git commit -e -F "$(git rev-parse --git-path COMMIT_EDITMSG)"` |
| `ticket-mismatch`  | `feat(LL-9): …` on `feature/LL-1234-…`        | Use the branch's key, or commit on the branch for the other ticket                                                          |

## Mode

Like every new check, the three checks start in **report** mode: findings are shown and nothing is refused. A date to switch them to block is to be agreed with LedgerLink; it is set with `block_from` under `checks:` in `policy.yaml`. To try the hooks in block mode on your machine, point `QA_CONFIG_DIR` at a copy of the configuration with `mode: block` for `branch.ticket` and `commit.message`.

## Configuration

`policy.yaml`, section `conventions` (changes need code-owner review):

```yaml
conventions:
  ticket_pattern: '[A-Z][A-Z0-9]+-\d+' # a Jira key; no anchors or capturing groups
  branch_types: { feature: feat, bugfix: fix, hotfix: hotfix, ... }
  commit_types: [feat, fix, hotfix, chore, docs, refactor, test, ci, perf, build, style, revert]
  commit_template: '{type}({ticket}): '
  exempt_branches: [] # globs, e.g. ['release/*']
  repos:
    link_core:
      commit_template: '{ticket}: ' # the older "LCORE-1234: <description>" form
```

- **Accepted ticket projects** come from `pr.ticket_projects` (per repository under `pr.repos.<name>.ticket_projects`), so branches, commits and pull request titles accept the same projects.
- **Another ticket system** needs only another `ticket_pattern`, for example `GH-\d+`; nothing in the code assumes Jira.
- `qa validate` refuses a pattern that does not compile or has capturing groups, a template without exactly one `{ticket}`, a branch type mapped to an unknown commit type, and repository names that are not in `registry/repositories.yaml`.

## Hooks

`qa setup` connects the commit-msg hook along with the others. A machine set up with an earlier qa has a commit-msg script that only passes through: `qa doctor` reports the global hooks as out of date, and running `qa setup` again fixes it. A repository with its own `.pre-commit-config.yaml` adds the `qa-commit-msg` hook (see `templates/pre-commit-config.yaml`) and `commit-msg` to `default_install_hook_types`. A husky repository adds `.husky/commit-msg` with `pre-commit run --hook-stage commit-msg --commit-msg-filename "$1"` (or `qa hook commit-msg "$1"`); a husky commit-msg hook that already enforces the repository's Jira key can stay.
