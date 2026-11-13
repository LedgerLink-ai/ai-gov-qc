# Performance

Issue #15. How fast qa is, what makes it fast, and how to measure it.

## What keeps it fast

- **Only relevant checks.** A check runs only on changed files that carry
  one of its tags (`path-tags.yaml`): Semgrep's money rules run on ledger
  paths, the agent-file lint on agent instruction files. A check with nothing
  to look at is skipped with a reason.
- **Only changed files (incremental).** pre-commit reads the staged files,
  pre-push the commits being pushed, a pull request what it changes since the
  merge base. Scanners see a private copy of exactly those files.
- **Stages stop early.** A blocking finding at pre-commit stops later stages
  (P2).
- **Parallel checks.** Checks of the same stage run at the same time
  (`performance.parallelism` in policy.yaml, default 4; `--parallel`,
  `QA_PARALLELISM`). Results are ordered the same way whatever finishes first.
- **Cache.** Locally, scanner results are cached per file content
  (`<qa home>/cache`; `--no-cache`, `QA_NO_CACHE=1`, `qa cache clear`). An
  unchanged file is not scanned again. CI never uses the cache.
- **Time budgets and limits.** Locally, checks that would start after the
  stage's budget (policy.yaml `local`) are deferred to CI; every scanner run
  has a time limit (`timeouts`).

## Benchmarks

`scripts/benchmark.js` generates a synthetic change and times the engine
through its API (median of 3 runs, all stages, every check):

| Scenario        | What it measures                                                        |
| --------------- | ----------------------------------------------------------------------- |
| `native`        | the engine's own checks only (no scanners)                              |
| `full-cold`     | every check with Gitleaks and Semgrep, empty cache, one check at a time |
| `full-parallel` | the same with parallel checks                                           |
| `full-warm`     | the same re-run with the cache filled (an unchanged re-run)             |

Measured 11 Nov 2026, qa 0.2.3, Windows 11, Intel Core i5-7500 (4 cores),
Node 24.21, Gitleaks 8.30.1, Semgrep 1.183.0:

| Files | native | full-cold | full-parallel | full-warm |
| ----: | -----: | --------: | ------------: | --------: |
|    11 |   5 ms |     6.2 s |         6.1 s |     34 ms |
|   301 |  39 ms |     9.8 s |         9.4 s |     1.0 s |

Per check at 301 files (cold): Gitleaks 2.3 s, Semgrep 7.5 s, the native
checks under 40 ms together. Semgrep's cost is mostly starting its Python
runtime (about 5 s whatever the size), which is why it runs at pre-push, not
pre-commit.

What a developer sees, per checkpoint (budgets from policy.yaml):

| Checkpoint | Checks                                                    | Typical (10 files)         | Budget |
| ---------- | --------------------------------------------------------- | -------------------------- | ------ |
| pre-commit | Gitleaks, agent-file lint, MCP allowlist, protected paths | ~0.8 s cold, ~25 ms cached | 10 s   |
| pre-push   | Semgrep                                                   | ~5.5 s cold, ~10 ms cached | 60 s   |
| pre-PR     | everything, plus pull request rules                       | ~6 s cold                  | 180 s  |

Parallel checks help most where one stage has several scanner checks; today
each stage has at most one scanner, so the gain is small. The cache is what
makes repeated runs (amend, rebase, a second push) fast.

## Run it

```bash
npm run build
node scripts/benchmark.js --files 300 --repeat 3 --json out/benchmark.json
```

CI runs it on Linux, macOS and Windows for every pull request and keeps the
JSON as the `benchmark-<os>` artifact, so a slowdown shows up in review.
`packages/engine/test/performance.test.ts` guards against regressions with
generous limits: 2,000 files through the native checks in under 10 s, and an
unchanged re-run of a slow scanner answered from the cache.
