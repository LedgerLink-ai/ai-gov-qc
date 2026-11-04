# Rules for developers and AI agents

What every commit and pull request to a LedgerLink repository must look like, and what AI agents may and may not do. Developers follow it; agents are pointed to it from their instruction file (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/…`, `.github/copilot-instructions.md`).

Source: the Development Guideline Policy V1.0 (draft for LedgerLink approval) and the AI Code Review implementation, sections 2 to 4. Where this page and the policy differ, the policy wins. The limits quoted here are the ones in [policy.yaml](../policy.yaml) and the `qa` engine.

## Where each rule is checked

Nothing on your machine rejects a commit message. The hooks pre-fill and remind; the pull request checks are what block.

| Rule                             | On your machine                                            | On the pull request                                                       |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| Ticket key in branch and subject | `prepare-commit-msg` fills it in; `qa prepr` warns         | Not checked: recommended, not required                                    |
| `Assisted-by` trailer form       | `prepare-commit-msg` adds your default; `qa prepr` reports | `pr-rules` (Danger JS) blocks a malformed trailer                         |
| Commit signing                   | Your git configuration                                     | Ruleset: unsigned commits cannot reach a protected branch                 |
| Pull request size                | `qa prepr` warns over 400 lines, errors over 1,000         | Reviewers                                                                 |
| Template and 10-item checklist   | —                                                          | `pr-rules` blocks until every item is ticked on AI-assisted pull requests |
| Secrets, hidden characters, lint | `pre-commit` hook                                          | `secrets`, `lint-format` and instruction-file checks, re-run in full      |

Checks on the pull request run report-only for two weeks, then block. Hooks can be skipped with `--no-verify`; the same checks run again on the pull request, where they cannot.

## Branch names

```
<TICKET-123>-<short-description>
```

- Example: `LCORE-210-limit-invariants`. A prefix is fine: `feature/LCORE-210-limit-invariants`.
- The ticket key is capital letters and digits starting with a letter, a hyphen, then digits (`LCORE-210`, `LWMNG-141`). It is followed by `-`, `_`, `.`, `/` or the end of the name. A lowercase key (`lcore-210`) is not recognised.
- Recommended, not required. Without a key the hook cannot pre-fill your commit messages, and `qa prepr` warns.
- Never commit on the branch the pull request merges into (`main`, `dev`, `develop`). `qa prepr` reports it as an error.

## Commit messages

```
<TICKET-123>: <short description>

<optional body: what changed and why>

Assisted-by: <tool>, <model>, <version>
```

| Part          | Rule                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject       | Short, specific, imperative: "Add idempotency key to refund endpoint", not "fixed stuff". No other subject format is enforced (no Conventional Commits).                |
| Ticket key    | Recommended. The hook prefixes it from the branch name unless the subject already starts with one. Repositories whose own hook already requires the key keep that rule. |
| Body          | Optional. What changed and why, not how.                                                                                                                                |
| `Assisted-by` | Required on every AI-assisted commit. A commit without it is declared as written without AI. Goes in the trailer block at the end, after a blank line.                  |

### The `Assisted-by` trailer

The value is exactly three comma-separated parts, none empty: the tool, the model, and a version number.

| Valid                                            | Not valid                                 | Why                       |
| ------------------------------------------------ | ----------------------------------------- | ------------------------- |
| `Assisted-by: Cursor, gpt-5, 1.7.0`              | `Assisted-by: Cursor`                     | Model and version missing |
| `Assisted-by: Claude Code, claude-opus-5-5, 2.1` | `Assisted-by: Cursor, gpt-5`              | Version missing           |
| `Assisted-by: GitHub Copilot, gpt-5, v1.300.0`   | `Assisted-by: Cursor, gpt-5, latest`      | Not a version number      |
|                                                  | `Assisted-by: Cursor, gpt-5, 1.7.0, chat` | Four parts                |

- The version is digits separated by dots, optionally with a leading `v` and a suffix such as `-beta.1`.
- Use the tool's name as it appears in [registry/ai-registry.yaml](../registry/ai-registry.yaml): Claude Code, Cursor, GitHub Copilot, OpenAI Codex. Only the form is checked on a commit; whether the tool is approved is checked against the registry separately.
- One commit may carry several `Assisted-by` lines if several tools were used.
- `Co-authored-by` lines that AI tools add (Cursor, Claude Code, Copilot, Codex) are not a declaration. The hook converts them to `Assisted-by`; fill in the model and version if it asks you to.

### Declaring AI use

| Situation                                                                                     | What to do                                                                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| No AI tool was used                                                                           | Delete the `Assisted-by` line the hook added.                                                            |
| You wrote the change with AI help (suggestions, completions, chat, generated code you edited) | Keep the line, and correct it if you used a different tool or model.                                     |
| An AI agent made the change                                                                   | The agent commits under its own GitHub App identity. Never re-commit agent work under your own identity. |

Set your default once per machine, so the hook adds it for you:

```bash
git config --global ledgerlink.assistedBy "Cursor, gpt-5, 1.7.0"
```

If you do not use AI tools, set it to `none` and the hook stops reminding you. `qa doctor` shows the current default.

### What the hook leaves alone

Merge, squash and amend messages, `git commit -c`/`-C`, and subjects starting with `fixup!`, `squash!`, `amend!` or `Revert "` are not changed.

### Examples

```
LCORE-212: Add idempotency key to refund endpoint

A retried POST /refunds could issue the same refund twice. Keys are
stored for 24 hours.

Assisted-by: Cursor, gpt-5, 1.7.0
```

```
LWMNG-141: Stop logging the Fireblocks API key at start-up
```

The second commit has no trailer, so it declares that no AI was used.

### Fixing a commit before you push

- The last commit: `git commit --amend`.
- An earlier one: `git rebase -i <base branch>`, mark the commit `reword`, and correct the message.
- When a pull request is squash-merged, the squash message summarises the whole change and keeps every `Assisted-by` line.

### Signing

Every commit to a protected branch is signed: by you with an SSH or GPG key, or by an agent's GitHub App. GitHub must show your commits as **Verified**.

```bash
git config --global user.signingkey <your-key>
git config --global commit.gpgsign true
git config --global gpg.format ssh   # SSH keys only
```

## Pull requests

### Before you open one

- The change is complete and meets the ticket's acceptance criteria.
- It is one change, small enough to review within one business day. `qa prepr` counts changed lines without lockfiles and snapshots: over 400 is a warning, over 1,000 an error. Split larger changes.
- Every commit is signed and its `Assisted-by` trailer, if any, is well formed.
- Unit tests are added or updated and pass. `qa prepr` reports line coverage under 80%.
- You have reviewed every line yourself, including every line written with AI help.

Run the pre-PR checks:

```bash
pre-commit run --hook-stage manual --all-files
```

### Title

The policy sets no title format. Recommended: the same form as a commit subject, `LCORE-212: Add idempotency key to refund endpoint`.

### Description

Complete the repository's pull request template. Every section is required:

| Section            | What to write                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Summary            | What changed and why, in a few sentences.                                                                                |
| Linked ticket      | The ticket key, for example `LCORE-212`.                                                                                 |
| Risk areas touched | Tick every area that applies: payments, ledger or smart contracts, personal data, AI features, infrastructure or gitops. |
| How it was tested  | The tests you added or ran, and any manual checks.                                                                       |
| Security checklist | LedgerLink's approved 10-item checklist, as it appears in the template.                                                  |

The security checklist is enforced on AI-assisted pull requests: all 10 items must be ticked, and a qualified engineer reviews the change before merge. Do not delete or reword the items.

```markdown
## Summary

Adds an idempotency key to POST /refunds so a retried request cannot
issue the same refund twice. Keys are stored for 24 hours.

## Linked ticket

LCORE-212

## Risk areas touched

- [x] Payments
- [ ] Ledger / smart contracts
- [ ] Personal data
- [ ] AI features
- [ ] Infrastructure / gitops

## How it was tested

- Unit tests for duplicate and expired keys
- Integration test: two identical refund calls produce one refund

## Security checklist

(all 10 items from the template, ticked)
```

### Content rules

- Pull request text, code, comments and READMEs must not contain instructions aimed at AI tools or automated reviewers. The AI review treats them as data; an attempt to steer an automated check breaches the policy.
- No hidden Unicode, bidirectional or zero-width characters anywhere.
- No secrets, card data or personal data in code, test data or the description.

### Getting it merged

- Required checks pass on the latest commit. Fix a failure with a new commit or by completing the template. Never disable, skip or weaken a check to get a pull request through.
- Code owners approve: one for most paths; two named approvers for ledger, smart-contract and gitops paths; a security code owner for agent instruction files. New commits dismiss earlier approvals.
- Every review thread is resolved.
- The AI policy review comments and never approves. Fix Critical and High findings, or have a member of the review-override team override them with a written reason. Answer Medium and Low findings in the thread if you disagree.
- Default branches merge by squash only.

## Rules for AI agents

These apply to any agent that writes code, commits or opens pull requests in a LedgerLink repository, in addition to everything above.

1. **Identity.** Commit and open pull requests only under the agent's own GitHub App identity, never a person's token or credentials. Agent pull requests are labelled as agent-authored.
2. **Never skip hooks.** Do not commit or push with `--no-verify`. If a hook fails, fix the cause.
3. **Never weaken a control.** Do not disable, skip, comment out or loosen tests, lint, scans, hooks or checks, and do not add baseline entries or exemptions to make a finding go away.
4. **Protected paths.** Do not edit CI and signing configuration or the files below; a human makes these changes, with code-owner review:
   - workflow and CI configuration (`.github/workflows/**`, `CODEOWNERS`, `.github/pull_request_template.md`), and the gitops repository
   - wallet, custody and signing code, as tagged `signing` in [path-tags.yaml](../path-tags.yaml) (for example `src/fireblocks/**` and `src/vault/**` in the enterprise wallet)
   - keys and certificates: `**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.pfx`, `**/keys/**`
   - environment files: `**/.env`, `**/.env.*`
   - production configuration: `**/prod/**`
5. **Git.** Never force-push, delete branches or push to a protected branch directly.
6. **Credentials and money.** No access to Vault paths holding Fireblocks credentials, the Fireblocks API, signing keys or transaction submission. Deploys, on-chain transactions and key operations always need a named human approval.
7. **Data.** Never put secrets, card data, personal data or customer data into a prompt, a commit, a log or a pull request.
8. **Instruction files** (`AGENTS.md`, `CLAUDE.md`, `.cursor/**`, `.claude/**`, `.github/copilot-instructions.md`, `**/*.prompt.md`, `.mcp.json`): plain visible text only. No secrets, hidden characters, long encoded blobs, or text telling agents to bypass a control. Changes need code-owner approval.
9. **Integrations.** Use only MCP servers and integrations listed in the AI registry.
10. **Before opening a pull request**, run the pre-PR checks and complete the template, including the security checklist. Never write instructions to reviewers or review tools into the pull request.

## Quick reference

- Branch: `LCORE-210-limit-invariants`.
- Commit: `LCORE-210: <imperative description>`, plus `Assisted-by: <tool>, <model>, <version>` when AI helped, signed.
- Set once: `git config --global ledgerlink.assistedBy "<tool>, <model>, <version>"` (or `none`).
- Before the pull request: `pre-commit run --hook-stage manual --all-files`.
- Pull request: one small change, template complete, all 10 checklist items ticked, checks green, threads resolved.
- You own every line you commit, however it was written.
