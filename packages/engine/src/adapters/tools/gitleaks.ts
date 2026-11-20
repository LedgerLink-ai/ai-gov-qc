import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, scrubbedEnv, ToolTimeoutError } from '../../exec';
import { redact } from '../../redact';
import { gitMergeBase, readAtRef } from '../../sources';
import {
  ToolUnavailableError,
  type ChangedFile,
  type CheckDefinition,
  type Finding,
  type RunContext,
} from '../../types';
import type { ToolAdapter } from './index';
import { toolBinary } from '../../tools-home';
import { cachedVersion, hashFiles, versionIn, withCheckedFiles, PROBE_TIMEOUT_MS } from './workdir';

export interface GitleaksResult {
  RuleID: string;
  Description?: string;
  File: string;
  StartLine?: number;
  EndLine?: number;
  StartColumn?: number;
  EndColumn?: number;
  Commit?: string;
}

const binary = (): string => toolBinary('gitleaks');

/**
 * Gitleaks reads its configuration from these when --config is missing; the
 * engine always passes --config, and never lets the environment add to it.
 */
const gitleaksEnv = (): NodeJS.ProcessEnv => {
  const env = scrubbedEnv();
  for (const name of Object.keys(env)) if (/^GITLEAKS_/i.test(name)) delete env[name];
  return env;
};

/**
 * The kind of secret in plain words, from Gitleaks' rule description
 * ("Uncovered a GitHub Personal Access Token, potentially leading to ..." gives
 * "GitHub Personal Access Token"); the rule id when there is no description.
 */
export function secretKind(r: Pick<GitleaksResult, 'RuleID' | 'Description'>): string {
  const kind = (r.Description ?? '')
    .replace(/^(?:uncovered|detected|discovered|identified|found|identifies|detects)\s+(?:an?\s+|the\s+)?/i, '')
    .split(/,|\s+(?:potentially|which|that could|allowing|that may|exposing)\s/i)[0]
    .replace(/[.\s]+$/, '')
    .trim();
  return kind || r.RuleID;
}

const version = cachedVersion(() => {
  const res = spawnSync(binary(), ['version'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    env: gitleaksEnv(),
    windowsHide: true,
  });
  return !res.error && res.status === 0 ? (versionIn(res.stdout) ?? res.stdout.trim()) : undefined;
}, binary);

/**
 * The text a finding matched, cut from the scanned content by the finding's
 * position. Gitleaks reports 1-based byte columns, one too high on every line
 * but the first. Used only to hash; the value is never returned to any output.
 */
export function matchedText(text: string, r: GitleaksResult): string | undefined {
  const start = r.StartLine ?? 0;
  const end = r.EndLine ?? start;
  if (start < 1 || end < start || r.StartColumn === undefined || r.EndColumn === undefined) return undefined;
  const lines = text.split('\n');
  if (end > lines.length) return undefined;
  const bytes = Buffer.from(lines.slice(start - 1, end).join('\n'), 'utf8');
  const from = r.StartColumn - (start > 1 ? 1 : 0) - 1;
  const lastLineStart = Buffer.byteLength(lines.slice(start - 1, end - 1).join('\n'), 'utf8') + (end > start ? 1 : 0);
  const to = lastLineStart + r.EndColumn - (end > 1 ? 1 : 0);
  if (from < 0 || to <= from || to > bytes.length) return undefined;
  return bytes.subarray(from, to).toString('utf8');
}

/**
 * What a finding's fingerprint is built from: the rule and a hash of the
 * matched secret, so a baselined secret stays baselined when lines move but a
 * new secret on the same line is new. Falls back to the matched line(s).
 */
export function secretBasis(text: string | undefined, r: GitleaksResult): string {
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);
  const match = text === undefined ? undefined : matchedText(text, r);
  if (match !== undefined) return `${r.RuleID}:${sha(`${r.RuleID}\0${match}`)}`;
  const line = text?.split('\n')[(r.StartLine ?? 1) - 1];
  return line !== undefined
    ? `${r.RuleID}:line:${sha(line.trim())}`
    : `${r.RuleID}:${r.StartLine ?? 0}:${r.StartColumn ?? 0}`;
}

/**
 * Flags every gitleaks run gets: the engine's configuration only, redaction
 * on, and no in-repository suppression. "gitleaks:allow" comments and
 * .gitleaksignore files are ignored; the only suppressions are exemptions.yaml
 * and the dated baseline.
 */
function commonArgs(ctx: RunContext, report: string, noIgnore: string): string[] {
  if (!ctx.config.gitleaksConfig) throw new Error('config/gitleaks.toml is missing from the qa configuration');
  return [
    '--report-format',
    'json',
    '--report-path',
    report,
    '--redact',
    '--no-banner',
    '--exit-code',
    '0',
    '--ignore-gitleaks-allow',
    // A path that never exists, so no .gitleaksignore can apply.
    '--gitleaks-ignore-path',
    noIgnore,
    '--config',
    ctx.config.gitleaksConfig,
  ];
}

async function runGitleaks(def: CheckDefinition, ctx: RunContext, args: string[], cwd: string): Promise<void> {
  const timeoutMs = ctx.timeoutFor(def);
  const res = await runProcess(binary(), args, { cwd, env: gitleaksEnv(), timeoutMs });
  if (res.timedOut) throw new ToolTimeoutError('gitleaks', timeoutMs);
  if (res.error || res.status !== 0) {
    throw new Error(
      `gitleaks failed (exit ${res.status}): ${redact((res.stderr || res.error?.message || '').trim()).slice(0, 500)}`,
    );
  }
}

/**
 * Gitleaks always reads a .gitleaksignore at the root of what it scans, even
 * with --gitleaks-ignore-path set elsewhere, so none may be among the copied
 * files.
 */
export function removeIgnoreFiles(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) removeIgnoreFiles(full);
    else if (e.name.toLowerCase() === '.gitleaksignore') rmSync(full, { force: true });
  }
}

/**
 * The repository's git directory. The history scan points gitleaks there, not
 * at the work tree, because gitleaks reads a .gitleaksignore from the root of
 * the path it scans and a pull request could commit one.
 */
function gitDir(root: string): string {
  const res = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const dir = res.status === 0 ? res.stdout.trim() : '';
  if (!dir) throw new Error('gitleaks: the git directory could not be found, so the pull request was not scanned');
  return dir;
}

const readReport = (report: string): GitleaksResult[] =>
  JSON.parse(readFileSync(report, 'utf8') || '[]') as GitleaksResult[];

const toPath = (file: string): string => file.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * The pull request's commits (merge base..HEAD), so a secret added in one
 * commit and removed in a later one is still found: it stays in the history
 * the pull request pushes. Runs only when the run has a pull request.
 */
export async function scanHistory(ctx: RunContext, def: CheckDefinition): Promise<Finding[]> {
  if (!ctx.pr) return [];
  if (!version())
    throw new ToolUnavailableError(
      'gitleaks',
      `"${binary()} version" did not run (run "qa setup", set QA_GITLEAKS_BIN or install gitleaks)`,
    );
  const mergeBase = gitMergeBase(ctx.root, ctx.pr.base);
  if (!mergeBase) {
    throw new Error(
      `gitleaks: no merge base between ${ctx.pr.base} and HEAD, so the pull request's commits were not scanned (fetch the full history)`,
    );
  }
  const work = mkdtempSync(join(tmpdir(), 'qa-gitleaks-history-'));
  try {
    const report = join(work, 'report.json');
    const args = [
      'git',
      gitDir(ctx.root),
      `--log-opts=${mergeBase}..HEAD`,
      ...commonArgs(ctx, report, join(work, 'none')),
    ];
    await runGitleaks(def, ctx, args, work);
    const seen = new Set<string>();
    const findings: Finding[] = [];
    for (const r of readReport(report)) {
      const path = toPath(r.File);
      const commit = r.Commit && /^[0-9a-f]{7,64}$/i.test(r.Commit) ? r.Commit : undefined;
      const basis = secretBasis(commit ? readAtRef(ctx.root, commit, path) : undefined, r);
      if (seen.has(`${path}\0${basis}`)) continue;
      seen.add(`${path}\0${basis}`);
      findings.push({
        checkId: def.id,
        ruleId: r.RuleID,
        level: 'error',
        path,
        line: r.StartLine,
        column: r.StartColumn,
        message:
          `Possible secret: ${secretKind(r)} (${r.RuleID}), added in commit ${commit ? commit.slice(0, 12) : 'unknown'} of this pull request. ` +
          'A later commit removing it does not remove it from the history. The value is not shown.',
        fixHint:
          'Rotate the credential (R22-10), load it from the secrets manager, and remove it from the branch history before merging.',
        fingerprintBasis: basis,
      });
    }
    return findings;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Scans exactly the changed files with LedgerLink's rules (config/gitleaks.toml:
 * the default rules plus private keys, BIP39 mnemonics and credentials in any
 * file), with redaction on. One finding per line: where several rules match
 * the same line, the most specific one is kept. The pull request's commits are
 * scanned separately, by scanHistory, which the runner calls outside the
 * result cache.
 */
async function run(ctx: RunContext, def: CheckDefinition, files: ChangedFile[]): Promise<Finding[]> {
  if (!version())
    throw new ToolUnavailableError(
      'gitleaks',
      `"${binary()} version" did not run (run "qa setup", set QA_GITLEAKS_BIN or install gitleaks)`,
    );
  const tree = await withCheckedFiles(ctx, 'gitleaks', files, async (work, src) => {
    removeIgnoreFiles(src);
    const report = join(work, 'report.json');
    await runGitleaks(def, ctx, ['dir', '.', ...commonArgs(ctx, report, join(work, 'none'))], src);
    return onePerLine(readReport(report)).map((r): Finding => {
      const path = toPath(r.File);
      return {
        checkId: def.id,
        ruleId: r.RuleID,
        level: 'error',
        path,
        line: r.StartLine,
        column: r.StartColumn,
        message: `Possible secret: ${secretKind(r)} (${r.RuleID}). The value is not shown.`,
        fixHint: 'Remove the value, rotate the credential (R22-10) and load it from the secrets manager.',
        fingerprintBasis: secretBasis(ctx.source.read(path), r),
      };
    });
  });
  return tree;
}

/**
 * Rules that match any credential-shaped value. A line they report together
 * with a rule for a known kind of secret (aws-codeartifact-token, github-pat,
 * ...) is reported once, under that rule.
 */
const GENERAL_RULES = /^(?:generic-api-key|credential-.*|jwe-token)$/;

/**
 * Keeps one result per file and line: a specific rule over a general one, then
 * the first rule id in alphabetical order. Gitleaks reports in no fixed order,
 * and the choice must not depend on it (the rule id is part of the fingerprint).
 */
export function onePerLine<T extends { RuleID: string; File: string; StartLine?: number }>(results: T[]): T[] {
  const rank = (r: T): string => `${GENERAL_RULES.test(r.RuleID) ? 1 : 0}:${r.RuleID}`;
  const kept = new Map<string, T>();
  for (const r of results) {
    const key = `${r.File}:${r.StartLine ?? 0}`;
    const prev = kept.get(key);
    if (!prev || rank(r) < rank(prev)) kept.set(key, r);
  }
  return [...kept.values()].sort((a, b) =>
    a.File === b.File ? (a.StartLine ?? 0) - (b.StartLine ?? 0) : a.File < b.File ? -1 : 1,
  );
}

export const gitleaks: ToolAdapter = {
  name: 'gitleaks',
  available: () => version() !== undefined,
  version,
  rulesHash: (ctx) => hashFiles(ctx.config.gitleaksConfig ? [ctx.config.gitleaksConfig] : []),
  run,
  history: scanHistory,
};
