# What Are the 10 Checks Implemented in This Project?

The project currently defines 10 security, AI governance, code quality, and pull request checks.

These checks are divided into three main stages:

1. Stage 1 – Basic Security and AI Governance Checks
2. Stage 2 – Financial Code Security
3. Stage 3 – Pull Request Checks

## Stage 1: Basic Security and AI Governance Checks

These checks focus on detecting secrets, validating AI configurations, controlling MCP servers, protecting sensitive files, and identifying AI-assisted commits.

### 1. `secrets.gitleaks`

Status: Implemented

Purpose: Detect secrets and sensitive information before they enter Git.

Tool Used: Gitleaks

It detects sensitive information such as:

- Passwords.
- API keys.
- Blockchain private keys.
- BIP32 extended private keys (`xprv`).
- Wallet Import Format (WIF) private keys.
- Solana keypair arrays.
- BIP39 recovery phrases containing 12–24 words.

How does it work?

- The engine copies only the content being checked into a temporary directory.
- It runs Gitleaks against that temporary directory.
- Secret values are redacted in scanner output.
- It uses Gitleaks' default rules along with custom rules for blockchain-related secrets.
- Custom configuration is generated using `scripts/gen-gitleaks-config.js`.
- The recovery phrase wordlist is validated against a stored SHA-256 hash to ensure it has not unexpectedly changed.

Blocking Date: 16 November 2026.

### 2. `ai-config.content-lint`

Status: Implemented

Purpose: Detect suspicious or potentially dangerous content in AI instruction and configuration files.

Files Checked:

- `AGENTS.md`
- `CLAUDE.md`
- `.cursor/**`
- Other AI configuration files and applicable READMEs.

What does it detect?

1. Hidden Unicode characters:
   - Bidirectional control characters.
   - Zero-width characters.
   - Tag characters.
   - Soft hyphens.
2. Suspicious phrases:
   - `--no-verify`
   - `skip the tests`
   - `ignore previous instructions`
3. Long Base64-like strings containing 120 or more characters.

How does it work?

- It scans AI instruction files for hidden Unicode characters that could conceal malicious instructions.
- It searches for suspicious phrases.
- It attempts to reduce false positives by checking whether suspicious phrases are negated in the same sentence.
- Long Base64-like strings are reported as warnings rather than errors.

Blocking Date: 30 November 2026.

### 3. `ai-config.mcp-allowlist`

Status: Implemented

Purpose: Ensure developers use only approved Model Context Protocol (MCP) servers.

Files Checked:

- `.mcp.json`
- `.cursor/mcp.json`
- `.vscode/mcp.json`

How does it work?

- Checks whether an MCP server is registered in the approved registry.
- Supports server identification through:
  - Server URLs.
  - NPM-style packages executed using `npx`.
  - Exact command configurations.
- Allows comments in configuration files.
- Requires NPM package versions to be explicitly pinned to an approved version.

Expected Behavior:

Using an unregistered MCP server generates a finding.

Blocking Date: 30 November 2026.

### 4. `paths.protected`

Status: Implemented

Purpose: Protect sensitive files and directories from unauthorized modifications.

Protected areas include:

- `ci-config`
- `signing`
- `*.pem`
- `*.key`
- `.env*`
- `keys/**`
- `prod/**`

How does it work?

The check identifies modifications to protected files and distinguishes between human developers and AI agents.

| Actor           | Current Behavior           |
| --------------- | -------------------------- |
| AI agent        | Generates an error finding |
| Human developer | Generates a note           |

This distinction allows the project to eventually block modifications made by AI agents while keeping human modifications reportable as notes.

Blocking Date: 14 December 2026.

### 5. `commit.trailer`

Status: Implemented

Purpose: Identify commits created with AI assistance.

AI-assisted commits are expected to contain a trailer in the following format:

text

```text
Assisted-by: Claude, Sonnet, 4.5
```

The exact values depend on the configured AI tool, model, and version.

How does it work?

- Checks whether the `Assisted-by` trailer follows the expected format.
- A commit without an `Assisted-by` trailer is allowed.
- An AI `Co-authored-by` line without an `Assisted-by` trailer generates a note.
- It does not block commits.

Blocking Date: Never (Report-only).

## Stage 2: Financial Code Security

This stage focuses on preventing unsafe numerical operations in financial and monetary code.

### 6. `sast.semgrep`

Status: Implemented

Purpose: Detect unsafe JavaScript number handling in financial code.

Tool Used: Semgrep

Areas Checked:

- Ledger code.
- Payment code.
- Signing code.
- Ingestion code.

What does it detect?

It identifies potentially unsafe JavaScript numerical operations, such as:

javascript

```javascript
parseFloat(amount);

Number(value);

amount.toFixed(2);
```

It also checks for money-related fields declared using the JavaScript `number` type.

Why is this important?

JavaScript uses floating-point numbers for ordinary numeric calculations. Floating-point arithmetic can introduce precision errors.

In financial transactions, even small precision errors can result in incorrect monetary values.

The objective is to prevent unsafe numerical representations from being used in sensitive financial operations.

Blocking Date: 16 November 2026.

## Stage 3: Pull Request Checks

These checks focus on pull request quality, traceability, governance, and test coverage.

All four checks are currently report-only.

### 7. `pr.branch-name`

Purpose: Ensure that branch names contain the required ticket identifier.

Example:

text

```text
feature/LCORE-210-payment-update
```

This ensures that code changes can be associated with the relevant development task or ticket.

Behavior: Reports branches that do not follow the expected naming convention.

Mode: Report-only.

### 8. `pr.commits`

Purpose: Check commit trailers across every commit included in a pull request.

How does it work?

- Examines commits included in the pull request.
- Checks whether AI-assisted commits follow the expected `Assisted-by` trailer format.
- Reports missing or incorrectly formatted trailers according to the configured rules.

Mode: Report-only.

### 9. `pr.diff-size`

Purpose: Identify pull requests containing too many changed lines.

Configured Thresholds:

| Changed Lines         | Threshold                |
| --------------------- | ------------------------ |
| More than 400 lines   | Warning threshold        |
| More than 1,000 lines | High diff-size threshold |

These thresholds help identify unusually large pull requests that may require additional review.

Mode: Report-only.

### 10. `tests.coverage`

Purpose: Ensure that pull requests maintain sufficient test coverage.

Minimum Configured Line Coverage: 80%.

How does it work?

- Checks test coverage associated with the pull request.
- Compares the reported line coverage against the configured 80% minimum.
- Reports an issue if coverage falls below the required threshold.

Example:

| Line Coverage | Result            |
| ------------- | ----------------- |
| 95%           | Meets requirement |
| 85%           | Meets requirement |
| 80%           | Meets requirement |
| 75%           | Below requirement |

Mode: Report-only.

## Summary: All 10 Implemented Checks

| #   | Check Name                | Stage   | Purpose                                              | Mode                       |
| --- | ------------------------- | ------- | ---------------------------------------------------- | -------------------------- |
| 1   | `secrets.gitleaks`        | Stage 1 | Detect secrets and sensitive information             | Blocking date: 16 Nov 2026 |
| 2   | `ai-config.content-lint`  | Stage 1 | Detect suspicious AI instructions and hidden Unicode | Blocking date: 30 Nov 2026 |
| 3   | `ai-config.mcp-allowlist` | Stage 1 | Allow only approved MCP servers                      | Blocking date: 30 Nov 2026 |
| 4   | `paths.protected`         | Stage 1 | Protect sensitive files and directories              | Blocking date: 14 Dec 2026 |
| 5   | `commit.trailer`          | Stage 1 | Identify AI-assisted commits                         | Report-only                |
| 6   | `sast.semgrep`            | Stage 2 | Detect unsafe numerical operations in financial code | Blocking date: 16 Nov 2026 |
| 7   | `pr.branch-name`          | Stage 3 | Validate branch naming conventions                   | Report-only                |
| 8   | `pr.commits`              | Stage 3 | Validate commit trailers in pull requests            | Report-only                |
| 9   | `pr.diff-size`            | Stage 3 | Identify excessively large pull requests             | Report-only                |
| 10  | `tests.coverage`          | Stage 3 | Verify minimum 80% line coverage                     | Report-only                |

## Final Overview

The project implements 10 checks across three stages:

- Stage 1 – 5 checks: Focuses on basic security, AI governance, MCP server validation, protected files, and AI-assisted commit identification.
- Stage 2 – 1 check: Focuses on financial code security and preventing unsafe JavaScript numerical operations.
- Stage 3 – 4 checks: Focuses on pull request quality, branch naming, commit governance, diff size, and test coverage.

The overall objective is to establish a security and governance framework that detects sensitive information, controls AI-assisted development, protects financial code, and improves pull request quality.

Total: 10 implemented checks across 3 stages.
