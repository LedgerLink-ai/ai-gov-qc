# Rules for developers and AI agents

What every branch, commit and pull request in a LedgerLink-ai repository must look like, and what AI agents may and may not do. Developers follow it; agents are pointed to it from their instruction file (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/…`, `.github/copilot-instructions.md`).

Sources: the Development Guideline Policy V1.0 (draft for LedgerLink approval), the AI Code Review implementation (sections 2 to 4), [policy.yaml](../policy.yaml), [registry/ai-registry.yaml](../registry/ai-registry.yaml), [path-tags.yaml](../path-tags.yaml) and the `qa` engine. Where this page and the policy differ, the policy wins. Every limit and date below is the one in `policy.yaml` for qa 0.2.4.

**Contents:** [Quick reference](#quick-reference) · [How the rules are checked](#how-the-rules-are-checked) · [1. Branch names](#1-branch-names) · [2. Commit messages](#2-commit-messages) · [3. What a commit must not contain](#3-what-a-commit-must-not-contain) · [4. Pull requests](#4-pull-requests) · [5. Rules for AI agents](#5-rules-for-ai-agents) · [6. When a check stops you](#6-when-a-check-stops-you)

## Quick reference

| What                  | Rule                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                | `<type>/<TICKET-123>-<short-description>`, e.g. `feature/LCORE-212-refund-idempotency`                                                                                           |
| Commit subject        | `<type>(<TICKET-123>): <description>`, e.g. `feat(LCORE-212): add idempotency key to refund endpoint`. The hook writes the prefix.                                               |
| AI help               | `Assisted-by: <tool>, <model>, <version>` at the end of the message. Set your default once: `git config --global ledgerlink.assistedBy "<tool>, <model>, <version>"` (or `none`) |
| Never commit          | Secrets of any kind, floating-point money in payment or ledger code, instructions to AI tools to skip checks, unapproved MCP servers                                             |
| Before a pull request | `qa prepr`: branch, every commit, size (400 / 1,000 lines), coverage (80%)                                                                                                       |
| Agents                | Their own identity, `QA_ACTOR=agent`, never `--no-verify`, never protected paths, never a weakened control                                                                       |
| Always                | You own every line you commit, however it was written                                                                                                                            |

## How the rules are checked

qa runs on your machine through git hooks: at every commit (`pre-commit`, `prepare-commit-msg`, `commit-msg`), at every push (`pre-push`), and before a pull request when you run `qa prepr`. It acts only in LedgerLink-ai repositories listed in `registry/repositories.yaml`; `qa doctor` in a repository says whether it is on.

Each check reports first and blocks from its date in `policy.yaml`. Before the date you see the finding and the commit or push goes through; from the date it is refused until you fix it.

| Check                     | What it checks                                                                      | When       | Blocks from     |
| ------------------------- | ----------------------------------------------------------------------------------- | ---------- | --------------- |
| `secrets.gitleaks`        | No secret, password, token, key or credential file ([section 3](#secrets))          | Commit     | **16 Nov 2026** |
| `sast.semgrep`            | No floating-point money in payment, ledger, signing and ingestion code              | Push       | **16 Nov 2026** |
| `ai-config.content-lint`  | AI instruction files and READMEs: no hidden characters, no text weakening a control | Commit     | 30 Nov 2026     |
| `ai-config.mcp-allowlist` | MCP servers in the repository are approved and pinned                               | Commit     | 30 Nov 2026     |
| `paths.protected`         | Agents do not touch protected paths; humans get a code-owner note                   | Commit     | 14 Dec 2026     |
| `branch.ticket`           | The branch name has a type and a ticket key                                         | Commit     | Report only     |
| `commit.message`          | The subject follows the convention with the branch's ticket                         | Commit     | Report only     |
| `commit.trailer`          | An `Assisted-by` trailer has the right form                                         | Commit     | Report only     |
| `pr.*`, `tests.coverage`  | Branch, every commit, trailers, size and coverage of the whole pull request         | `qa prepr` | Report only     |

Your repository's own Prettier, ESLint, tests, type check and build also run as hooks, from the repository's `node_modules`.

**Pull requests are checked outside this repository.** ai-gov-qc no longer provides a GitHub pull request gate (AIQC-92). A developer controls their own machine and can commit without the hooks (or never run `qa setup`), so the hooks are feedback, not an enforcement point; each repository's pull request checks, branch rulesets and code-owner review are where rules hold for every change. See [ENFORCEMENT.md](ENFORCEMENT.md).

## 1. Branch names

```
<type>/<TICKET-123>-<short-description>
```

| Part        | Rule                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type        | `feature` or `feat`, `bugfix` or `fix`, `hotfix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, `build`                                                           |
| Ticket key  | Capital letters and digits starting with a letter, a hyphen, then digits: `LCORE-212`, `LWMNG-141`. A repository may accept only its own projects (`ticket_projects`). |
| Description | Short, lowercase words joined by hyphens                                                                                                                               |

| Valid                                  | Not valid                      | Why                             |
| -------------------------------------- | ------------------------------ | ------------------------------- |
| `feature/LCORE-212-refund-idempotency` | `LCORE-212-refund-idempotency` | No type                         |
| `bugfix/LWMNG-141-fireblocks-logging`  | `feature/refund-idempotency`   | No ticket key                   |
| `hotfix/LCORE-300-security-patch`      | `feature/lcore-212-refund`     | Lowercase key                   |
|                                        | `wip/LCORE-212-refund`         | Unknown type                    |
|                                        | `main`, `dev`, `develop`       | Never commit on the base branch |

The type and ticket come from the branch, never from what you type in the message: name the branch once and every commit gets its prefix. To fix a branch name: `git branch -m feature/LCORE-212-refund-idempotency` (`-M` when only the case changes). On `main` or `dev`, start a branch instead: `git switch -c feature/LCORE-212-…` (staged changes come along). Details: [BRANCH-AND-COMMIT-CONVENTIONS.md](BRANCH-AND-COMMIT-CONVENTIONS.md).

## 2. Commit messages

```
<type>(<TICKET-123>): <description>

<optional body: what changed and why>

Assisted-by: <tool>, <model>, <version>
```

| Part          | Rule                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prefix        | Written by the `prepare-commit-msg` hook from the branch: `feature/LCORE-212-…` gives `feat(LCORE-212): `. You may choose another type: `fix: …` becomes `fix(LCORE-212): …`. |
| Type          | `feat`, `fix`, `hotfix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, `build`, `style`, `revert`                                                                        |
| Description   | Short, specific, imperative: "add idempotency key to refund endpoint", not "fixed stuff"                                                                                      |
| Ticket        | The branch's key. A different key is reported (`ticket-mismatch`): commit on that ticket's branch instead.                                                                    |
| Body          | Optional. What changed and why, not how.                                                                                                                                      |
| `Assisted-by` | Required on every AI-assisted commit, in the trailer block at the end after a blank line. A commit without it declares that no AI was used.                                   |

A repository can keep the older `LCORE-212: <description>` form through `conventions.repos.<name>.commit_template` in `policy.yaml`; the hook then writes that prefix.

### The `Assisted-by` trailer

Exactly three comma-separated parts, none empty: the tool, the model, and a version number.

| Valid                                            | Not valid                                 | Why                       |
| ------------------------------------------------ | ----------------------------------------- | ------------------------- |
| `Assisted-by: Cursor, gpt-5, 1.7.0`              | `Assisted-by: Cursor`                     | Model and version missing |
| `Assisted-by: Claude Code, claude-opus-5-5, 2.1` | `Assisted-by: Cursor, gpt-5`              | Version missing           |
| `Assisted-by: GitHub Copilot, gpt-5, v1.300.0`   | `Assisted-by: Cursor, gpt-5, latest`      | Not a version number      |
|                                                  | `Assisted-by: Cursor, gpt-5, 1.7.0, chat` | Four parts                |

- The version is digits separated by dots, optionally with a leading `v` and a suffix such as `-beta.1`.
- Use the tool's name as it appears in [registry/ai-registry.yaml](../registry/ai-registry.yaml): Claude Code, Cursor, GitHub Copilot, OpenAI Codex. Only the form is checked on a commit.
- One commit may carry several `Assisted-by` lines when several tools were used.
- `Co-authored-by` lines that AI tools add (Cursor, Claude Code, Copilot, Codex) are not a declaration. The hook converts them to `Assisted-by`; fill in the model and version if it asks you to.

### Declaring AI use

| Situation                                                                        | What to do                                                                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| No AI tool was used                                                              | No trailer. Delete the line if the hook added your default.                                                             |
| You wrote the change with AI help (suggestions, chat, generated code you edited) | Keep the line, and correct it if you used another tool or model.                                                        |
| An AI agent made the change                                                      | The agent commits under its own identity ([section 5](#5-rules-for-ai-agents)). Never re-commit agent work as your own. |

Set your default once per machine, so the hook adds it for you:

```bash
git config --global ledgerlink.assistedBy "Cursor, gpt-5, 1.7.0"
```

If you do not use AI tools, set it to `none` and the hook stops reminding you. `qa doctor` shows the current default.

### What the hook leaves alone

Merge, squash and amend messages, `git commit -c`/`-C`, a subject with its own scope (`feat(api): …`), and subjects starting with `fixup!`, `squash!`, `amend!` or `Revert "`.

### Examples

```
feat(LCORE-212): add idempotency key to refund endpoint

A retried POST /refunds could issue the same refund twice. Keys are
stored for 24 hours.

Assisted-by: Cursor, gpt-5, 1.7.0
```

```
fix(LWMNG-141): stop logging the Fireblocks API key at start-up
```

The second commit has no trailer, so it declares that no AI was used.

### Fixing a commit before you push

- The last commit: `git commit --amend`.
- An earlier one: `git rebase -i <base branch>`, mark the commit `reword`, and correct the message. During a rebase the hooks read the branch being rebased.
- A refused message is kept: `git commit -e -F "$(git rev-parse --git-path COMMIT_EDITMSG)"`.
- When a pull request is squash-merged, the squash message keeps every `Assisted-by` line.

### Signing

The policy requires every commit to a protected branch to be signed: by you with an SSH or GPG key, or by an agent's GitHub App, so that GitHub shows it as **Verified**. qa does not check signatures; the repository's branch rulesets do.

```bash
git config --global user.signingkey <your-key>
git config --global commit.gpgsign true
git config --global gpg.format ssh   # SSH keys only
```

## 3. What a commit must not contain

### Secrets

`secrets.gitleaks` scans every file a commit changes, of any type, and blocks:

- known token formats: AWS keys, GitHub tokens, Stripe keys, private keys and many more;
- LedgerLink's blockchain rules: EVM private keys, BIP32 `xprv` keys, Bitcoin WIF keys, Solana keypairs, BIP39 recovery phrases;
- credentials in any file (AIQC-89): a value given to a password, secret, token or key name, quoted or not, including typed declarations; `export TOKEN=…`, `ENV`, `ARG`; passwords in URLs (`https://user:pass@host`) and connection strings (`Password=…;`, `?password=`); `--password`, `--token` and `curl -u user:pass` on command lines; `Authorization:` headers; Maven and NuGet XML; `.netrc`; AWS CodeArtifact and other encrypted tokens of any length;
- files that are credentials by nature: SSH private keys (`id_rsa`, `id_ed25519`, …), `.git-credentials`, `.pgpass`, keystores (`.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`, `.kdbx`).

Findings never show the value. Keep credentials out of the repository:

| Instead of                 | Write                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DB_PASSWORD=…` in `.env`  | Commit `.env.example` with placeholders (`DB_PASSWORD=<your-password>`); keep `.env` in `.gitignore`  |
| `password: "…"` in YAML    | `password: ${DB_PASSWORD}`, or a secret reference (`secretKeyRef`, `!Ref`, `{{ .Values.x }}`)         |
| `_authToken=…` in `.npmrc` | `_authToken=${NPM_TOKEN}`, set by `aws codeartifact login` or your CI                                 |
| A token in a test          | A value generated when the test runs, or an obvious placeholder (`test-token`, `changeme`, `<token>`) |

These are not reported: `${VAR}`, `$VAR`, `%VAR%`, `{{ template }}`, `<placeholder>`, YAML tags, identifiers such as `process.env.DB_PASSWORD`, paths, masked values (`********`), examples (`changeme`, `your-token`, `test`, `example`), and `localhost` or `example.com` in URLs. If a real secret was committed, removing it is not enough: rotate it (R22-10). An exception that must stay goes in `exemptions.yaml`, with code-owner review and an expiry date.

### Money types

`sast.semgrep` blocks at push, in payment, ledger, signing and ingestion code (the paths tagged in [path-tags.yaml](../path-tags.yaml)), any of: `parseFloat()`, `Number(…)` or `.toFixed()` on money, and a money field (`amount`, `balance`, `price`, `fee`, `total`) typed as `number`. Use the Decimal or BigInt money type (C16-1).

### AI instruction files

The files AI tools read as instructions (`AGENTS.md`, `CLAUDE.md`, `context/**`, `.claude/**`, `.cursor/**`, `.github/copilot-instructions.md`, `.github/instructions/**`, `**/*.prompt.md`, `.mcp.json`, `.vscode/mcp.json`) and every `README.md` must be plain visible text:

- no hidden characters: zero-width, bidirectional controls, Unicode tag characters, soft hyphens;
- no text telling agents to weaken a control: to commit without the hooks, to switch off or get round tests, lint, checks, hooks, scans or reviews, to disregard findings or warnings, or to disregard their earlier instructions. The exact phrases are in `packages/engine/src/checks/content-lint.ts`;
- no long encoded blobs (a warning).

A sentence that forbids the action is fine, for example "Never skip the hooks." Pull request text, code comments and READMEs must not contain instructions aimed at AI tools or automated reviewers.

### MCP servers

An MCP server in `.mcp.json`, `.cursor/mcp.json` or `.vscode/mcp.json` must be listed as `approved` in [registry/ai-registry.yaml](../registry/ai-registry.yaml) and run at an exact approved version: `npx -y @ledgerlink/qa-mcp@0.1.0`, not `npx @ledgerlink/qa-mcp` or `@latest`. URL servers and local commands must be registered too. To use a new server, propose it in the registry with an owner and a review date (R14-6). Personal MCP settings outside the repository are not checked.

### Protected paths

Humans may change these, and the pull request then needs a code-owner approval; agents must not ([section 5](#5-rules-for-ai-agents)):

- CI and review configuration: `.github/workflows/**`, `CODEOWNERS`, `.github/pull_request_template.md`, the gitops repository;
- wallet, custody and signing code, as tagged `signing` in [path-tags.yaml](../path-tags.yaml) (for example `src/fireblocks/**` and `src/vault/**` in the enterprise wallet);
- keys and certificates: `**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.pfx`, `**/keys/**`;
- environment files: `**/.env`, `**/.env.*`; production configuration: `**/prod/**`;
- what the checks run: `.pre-commit-config.yaml`, `.husky/**`, and the baseline `.qa/baseline.sarif`.

## 4. Pull requests

### Before you open one

- The change is complete and meets the ticket's acceptance criteria.
- It is one change, small enough to review within one business day: over 400 changed lines is a warning, over 1,000 an error (lockfiles and snapshots are not counted). Split larger changes.
- Every commit follows section 2, is signed, and its `Assisted-by` trailer, if any, is well formed.
- Unit tests are added or updated and pass, with line coverage of at least 80%.
- You have reviewed every line yourself, including every line written with AI help.

Run the pull request checks locally. They cover the branch, every commit (including commits that skipped the hooks), trailers, size and coverage, and run every other check on the whole change since the base branch:

```bash
qa prepr
```

`qa prepr` finds the base branch from `origin/HEAD`; set `QA_PR_BASE` (for example `origin/develop`) to use another. For the full pre-PR stage, with full lint, formatting, the test suite with coverage and the build: `pre-commit run --hook-stage manual --all-files`, adding `-c "$(npm prefix -g)/node_modules/@ledgerlink/qa/templates/pre-commit-config.yaml"` in a repository without its own `.pre-commit-config.yaml`.

### Title

The policy sets no title format. Recommended: the commit-subject form, `feat(LCORE-212): add idempotency key to refund endpoint`.

### Description

Complete the repository's pull request template. Every section is required:

| Section            | What to write                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Summary            | What changed and why, in a few sentences.                                                                                |
| Linked ticket      | The ticket key, for example `LCORE-212`.                                                                                 |
| Risk areas touched | Tick every area that applies: payments, ledger or smart contracts, personal data, AI features, infrastructure or gitops. |
| How it was tested  | The tests you added or ran, and any manual checks.                                                                       |
| Security checklist | LedgerLink's approved checklist, as it appears in the template. Do not delete or reword the items.                       |

On AI-assisted pull requests every checklist item must be ticked, and a qualified engineer reviews the change before merge.

### Getting it merged

These are set by the policy and enforced by each repository's pull request checks and rulesets, outside this repository:

- Required checks pass on the latest commit. Fix a failure with a new commit. Never disable or weaken a check to get a pull request through.
- Code owners approve: one for most paths; two for ledger, smart-contract, signing and agent-authentication paths (`min_approvals` in [path-tags.yaml](../path-tags.yaml)); an AI-governance owner for AI configuration. New commits dismiss earlier approvals.
- Every review thread is resolved.
- The AI policy review comments and never approves. Fix Critical and High findings, or have a member of the review-override team override them with a written reason.

## 5. Rules for AI agents

These apply to any agent that writes code, commits or opens pull requests in a LedgerLink-ai repository, in addition to everything above.

1. **Identity.** Commit and open pull requests only under the agent's own identity (its GitHub App or bot account, listed under `agents` in the AI registry), never a person's token or credentials. Pull requests are labelled as agent-authored.
2. **Say you are an agent.** Run the hooks with `QA_ACTOR=agent` set, so the agent rules apply (for example, `paths.protected` blocks instead of noting).
3. **Never skip hooks.** Never commit or push with the option that skips them. If a hook fails, fix the cause.
4. **Never weaken a control.** Never disable, comment out or loosen tests, lint, scans, hooks or checks, and never add baseline entries, exemptions or scanner suppressions to make a finding go away.
5. **Protected paths.** Never edit a path in [section 3](#protected-paths). Stop and ask the developer to make the change.
6. **Git.** Never force-push, delete branches or push to a protected branch directly.
7. **Credentials and money.** No access to Vault paths holding Fireblocks credentials, the Fireblocks API, signing keys or transaction submission. Deploys, on-chain transactions and key operations always need a named human approval.
8. **Data.** Never put secrets, card data, personal data or customer data into a prompt, a commit, a log or a pull request.
9. **Instruction files and integrations.** Keep instruction files plain visible text ([section 3](#ai-instruction-files)). Use only MCP servers and integrations approved and pinned in the AI registry.
10. **Before opening a pull request**, run `qa prepr` and complete the template, including the security checklist. Never write instructions to reviewers or review tools into the pull request.

## 6. When a check stops you

The hook prints one summary line saying what was found and where (in an IDE's commit pop-up it is the first line), then the details with a `fix:` for each finding.

| Message                                                  | What to do                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `BLOCK secrets.gitleaks … Possible secret (<rule>)`      | Move the value to a variable or the secrets manager ([section 3](#secrets)); rotate it if it was real |
| `BLOCK sast.semgrep … money-…`                           | Use the money type                                                                                    |
| `ai-config.content-lint … weaken a control` / `Hidden …` | Remove the instruction or the hidden character                                                        |
| `ai-config.mcp-allowlist … not in the AI registry`       | Remove the server, pin an approved version, or propose it in the registry                             |
| `branch.ticket … no-ticket` / `format`                   | Rename the branch: the message gives the exact `git branch -m` command                                |
| `commit.message … format` / `ticket-mismatch`            | Use `<type>(<branch's TICKET>): <description>`; the refused message is kept                           |
| `qa: no Assisted-by added: no default set`               | A reminder, not an error: set `ledgerlink.assistedBy` once (or `none`)                                |
| `prettier` / `eslint` "files were modified by this hook" | The hook fixed formatting: stage the changed files and commit again                                   |
| `… is not installed in this repository yet … skipped`    | Run the repository's package install (`npm ci`, `yarn install`)                                       |

To try a check before its blocking date, set `QA_AS_OF=2026-11-30` (or `--as-of`) for one command. `qa doctor` checks the setup of the machine and the repository.
