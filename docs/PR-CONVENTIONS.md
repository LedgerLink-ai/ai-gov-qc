# Pull request conventions

AIQC-86 (GitHub issue #16). The QA pull request check (`qa / pull request checks`, from [qa-pr.yml](../.github/workflows/qa-pr.yml)) validates every pull request's title, ticket reference and description. The rules live here, in `ai-gov-qc`, and are the same for every opted-in repository unless `policy.yaml` overrides them for one.

## What is checked

| Check            | Fails when                                                                                                                                                                 | Fix                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pr.title`       | The title is empty, or does not match `pr.title_pattern` (default `<TICKET-123>: <short description>`)                                                                     | Edit the title, e.g. `LCORE-212: Add idempotency key to refund endpoint`             |
| `pr.ticket`      | No ticket key in the title or the Ticket section; a key from a project outside `pr.ticket_projects`; a ticket link (`…/browse/KEY`) that does not point to `pr.ticket_url` | Put the key at the start of the title and in the Ticket section                      |
| `pr.description` | The description is empty; a required section is missing or has only the template's comments; the Checklist section has no `- [ ]` items                                    | Copy [the template](../templates/pull_request_template.md) and fill in every section |

Keys elsewhere in the description, such as `SHA-256` in the Summary, are not treated as tickets. The checklist must be present; whether its items are ticked is not checked here (AIQC-49 covers the checklist on AI-assisted pull requests).

The title and description come from GitHub's `pull_request` event, never from the repository, so a pull request cannot change what is checked. Editing the title or description re-runs the check (`edited` is one of the workflow's triggers). Results appear in the check's log and its job summary, under **Findings**, with what to fix.

## Modes

The three checks run in `report` mode first: findings are shown, nothing blocks. Each switches to blocking on its `block_from` date in `policy.yaml`, agreed with LedgerLink. Once blocking, a failing pull request cannot merge while `qa / pull request checks` is a required status check (AIQC-48).

## Configuration (`policy.yaml`, `pr` section)

```yaml
pr:
  title_pattern: '^[A-Z][A-Z0-9]+-\d+: \S'
  title_example: '"<TICKET-123>: <short description>", e.g. "LCORE-212: Add idempotency key to refund endpoint"'
  ticket_projects: [] # empty: any key of the form ABC-123
  ticket_url: 'https://ledgerlink.atlassian.net/browse/'
  description_sections:
    - name: Summary
    - name: Ticket
      aliases: ['Linked ticket']
    - name: Changes
    - name: Testing
      aliases: ['How it was tested']
    - name: Security Impact
    - name: Checklist
      aliases: ['Security checklist']
      checklist: true
  repos:
    link_core:
      ticket_projects: [LCORE]
```

- **Sections** are Markdown headings of any level (`## Summary`). Case, emphasis and a trailing colon are ignored. `aliases` accept other headings for the same section.
- **Per repository**: `repos.<name>` overrides any of `title_pattern`, `title_example`, `ticket_projects`, `ticket_url` and `description_sections`. The name must be in `registry/repositories.yaml`.
- `qa validate` rejects a pattern that is not a valid regular expression and an override for an unknown repository.

Changes to `policy.yaml` are pull requests to this repository with code-owner review (Solution Architect), and reach the repositories in the next qa release.

## Exceptions

Administrators grant an exception in [exemptions.yaml](../exemptions.yaml), with an owner, an approver and an expiry date. These findings are about the pull request as a whole, so they have no path: use `path: '*'`. The exemption then covers every pull request in that repository until it expires.

```yaml
- id: EX-0007
  check: pr.description
  repo: link_core
  path: '*'
  owner: name
  approved_by: name
  reason: Release pull requests use the release template until 2027-01
  expires: 2027-01-31
```

## Before opening a pull request

```bash
qa prepr --pr-title "LCORE-212: Add idempotency key to refund endpoint" --pr-body-file pr.md
```

`QA_PR_TITLE` and `QA_PR_BODY_FILE` do the same. Without them, `qa prepr` leaves the three checks out (they need a title and description) and the pull request check runs them.

## Setting it up in a repository

1. Copy [templates/pull_request_template.md](../templates/pull_request_template.md) to `.github/pull_request_template.md`.
2. The caller workflow ([templates/qa-pr-caller.yml](../templates/qa-pr-caller.yml)) already runs these checks; nothing else is needed.
