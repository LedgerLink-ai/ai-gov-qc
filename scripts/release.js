#!/usr/bin/env node
'use strict';

// Release checks, used by CI and by scripts/package.js:
//
//   node scripts/release.js --check              versions agree everywhere (see below)
//   node scripts/release.js --check <version>    ... and the version is <version> (the release workflow's input)
//   node scripts/release.js --notes <version> [--repo <owner/name>] [--sha256 <hex>] [--pull-requests <file>]
//                                                print the release notes for <version>
//
// The release notes are templates/release-notes.md (requirements, what qa
// setup installs, where qa is installed on each OS, install, check, upgrade,
// uninstall, roll back) with the CHANGELOG.md section for the version as
// "What's new". --pull-requests is GitHub's generated list of pull requests
// (the body from the releases/generate-notes API); pull requests reverted
// before the release are left out of it, with their reverts, and named under
// "Not in this release" (AIQC-90).
//
// The package version is the one `qa version` prints and the one repositories
// pin with "qa --require <version>", so a release must not drift from it:
//   - both package.json files carry the same MAJOR.MINOR.PATCH version
//   - templates/pre-commit-config.yaml pins exactly that version, and its hook
//     repositories by commit SHA
//   - templates/qa-pr-caller.yml, the reusable workflow and the organisation
//     ruleset (config/github/org-ruleset-qa.json) name it
//   - CHANGELOG.md has a section for it (the release notes)
//   - templates/release-notes.md renders for it, every placeholder filled
//   - policy.yaml's min_engine_version is not newer than it

const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function compare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The CHANGELOG.md section for `version`, without its heading, or undefined. */
function changelogSection(version, text = read('CHANGELOG.md')) {
  const lines = text.split(/\r?\n/);
  const heading = new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return (
    lines
      .slice(start + 1, end)
      .join('\n')
      .trim() || undefined
  );
}

const DEFAULT_REPO = 'LedgerLink-ai/ai-gov-qc';
const TEMPLATE = 'templates/release-notes.md';

/**
 * The pull requests in GitHub's generated release notes, one per
 * "* <title> by @<user> in <url>/pull/<number>" line, in their order.
 */
function parsePullRequests(text) {
  const prs = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\* (.+) by @\S+ in (\S+\/pull\/(\d+))\s*$/.exec(line);
    if (m) prs.push({ number: Number(m[3]), title: m[1], line: line.trimEnd() });
  }
  return prs;
}

/**
 * Splits the pull requests into those the release contains and those reverted
 * before it. A revert is a pull request whose title starts with "Revert" and
 * names what it reverts: "#20" (as many as it lists), or the quoted title of an
 * earlier pull request (GitHub's revert button: Revert "<title>"). A reverted
 * pull request in the list is left out; so is the revert, when everything it
 * reverts is in the list (otherwise it undoes an earlier release and is a real
 * change). Newest first, so a revert of a revert brings the original back.
 */
function withoutReverted(prs) {
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const revertedBy = new Map();
  const droppedReverts = new Set();
  for (const pr of [...prs].sort((a, b) => b.number - a.number)) {
    if (revertedBy.has(pr.number) || !/^Revert\b/i.test(pr.title)) continue;
    const targets = new Set(
      [...pr.title.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])).filter((n) => n !== pr.number),
    );
    const quoted = /^Revert\s+"(.+)"\s*$/i.exec(pr.title)?.[1];
    if (quoted) {
      const earlier = prs.filter((p) => p.title === quoted && p.number < pr.number).sort((a, b) => b.number - a.number);
      if (earlier[0]) targets.add(earlier[0].number);
    }
    if (targets.size === 0) continue;
    const present = [...targets].filter((n) => byNumber.has(n) && !revertedBy.has(n));
    for (const n of present) revertedBy.set(n, pr.number);
    if (present.length === targets.size) droppedReverts.add(pr.number);
  }
  return {
    included: prs.filter((p) => !revertedBy.has(p.number) && !droppedReverts.has(p.number)),
    reverted: prs.filter((p) => revertedBy.has(p.number)).map((p) => ({ ...p, revertedBy: revertedBy.get(p.number) })),
  };
}

/** The "Pull requests in this release" section from GitHub's generated notes. */
function pullRequestSection(generated) {
  if (generated === undefined) return 'Listed on the release page when the release is published.';
  const { included, reverted } = withoutReverted(parsePullRequests(generated));
  const parts = [included.length > 0 ? included.map((p) => p.line).join('\n') : 'None.'];
  if (reverted.length > 0)
    parts.push(
      '**Not in this release.** These pull requests were merged and then reverted before the release, so the package does not contain them:',
      reverted.map((p) => `* ${p.title} (#${p.number}), reverted by #${p.revertedBy}`).join('\n'),
    );
  const full = /^\*\*Full Changelog\*\*:.*$/m.exec(generated)?.[0];
  if (full) parts.push(full.trimEnd());
  return parts.join('\n\n');
}

/**
 * The pinned tool versions: pre-commit and Gitleaks from policy.yaml's
 * top-level "tools:" block, Semgrep from the Python lock file. Read without a
 * YAML parser: the release workflow runs this without installing packages.
 */
function toolVersions() {
  const block = /^tools:[ \t]*\r?\n((?:[ \t]+\S.*(?:\r?\n|$))*)/m.exec(read('policy.yaml'))?.[1] ?? '';
  const tools = Object.fromEntries(
    [...block.matchAll(/^[ \t]+([\w-]+):[ \t]*['"]?([^'"\s#]+)/gm)].map((m) => [m[1], m[2]]),
  );
  const semgrep = /^semgrep==(\S+)/m.exec(read('config/python-requirements.txt'))?.[1];
  return { pre_commit: tools['pre-commit'], gitleaks: tools.gitleaks, semgrep };
}

/**
 * The release notes for `version`: templates/release-notes.md with every
 * {{placeholder}} filled. Throws for an unknown or empty placeholder.
 */
function renderNotes(version, { repo = DEFAULT_REPO, sha256, pullRequests, template } = {}) {
  const changes = changelogSection(version);
  if (!changes) throw new Error(`CHANGELOG.md has no section for "${version}"`);
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`"${sha256}" is not a SHA-256`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not <owner>/<name>`);
  const values = {
    version,
    anchor: version.replace(/\./g, ''),
    repo,
    sha256: sha256 ? `\`${sha256}\`` : `in \`ledgerlink-qa-${version}.tgz.sha256\`, attached below`,
    changes,
    pull_requests: pullRequestSection(pullRequests),
    ...toolVersions(),
  };
  const text = template ?? read(TEMPLATE);
  const problems = [];
  const out = text.replace(/\{\{\s*([\w-]*)\s*\}\}/g, (all, name) => {
    const value = values[name];
    if (typeof value !== 'string' || value === '') {
      problems.push(`${TEMPLATE}: ${all} has no value`);
      return all;
    }
    return value;
  });
  if (problems.length > 0) throw new Error([...new Set(problems)].join('\n  '));
  return out;
}

/** Every qa version a workflow file names. */
function workflowVersions(text) {
  const patterns = [
    /qa-version:\s*'?(\d+\.\d+\.\d+)'?/g,
    /default:\s*'(\d+\.\d+\.\d+)'/g,
    /\|\|\s*'(\d+\.\d+\.\d+)'/g,
    /qa-pr\.yml@v(\d+\.\d+\.\d+)/g,
    /refs\/tags\/v(\d+\.\d+\.\d+)/g,
  ];
  return patterns.flatMap((p) => [...text.matchAll(p)].map((m) => m[1]));
}

function checkVersions(expected) {
  const root = require(join(ROOT, 'package.json')).version;
  const engine = require(join(ROOT, 'packages', 'engine', 'package.json')).version;
  const problems = [];
  if (root !== engine)
    problems.push(
      `package.json is ${root} but packages/engine/package.json is ${engine}; set both to the same version`,
    );
  if (!SEMVER.test(root)) problems.push(`version ${root} is not MAJOR.MINOR.PATCH`);
  if (expected !== undefined && expected !== root)
    problems.push(`asked to release ${expected}, but package.json is ${root}; bump both package.json files first`);

  const template = read('templates/pre-commit-config.yaml');
  const pins = [...template.matchAll(/qa --require[ =](\S+)/g)].map((m) => m[1]);
  if (pins.length === 0) problems.push('templates/pre-commit-config.yaml has no "qa --require <version>"');
  for (const pin of new Set(pins))
    if (pin !== root) problems.push(`templates/pre-commit-config.yaml pins qa ${pin}; the package is ${root}`);
  for (const m of template.matchAll(/@ledgerlink\/qa@(\d+\.\d+\.\d+)|ledgerlink-qa-(\d+\.\d+\.\d+)\.tgz/g)) {
    const v = m[1] ?? m[2];
    if (v !== root)
      problems.push(`templates/pre-commit-config.yaml tells developers to install ${v}; the package is ${root}`);
  }
  for (const m of template.matchAll(/^\s*rev:\s*(\S+)/gm))
    if (!/^[0-9a-f]{40}$/.test(m[1]))
      problems.push(`templates/pre-commit-config.yaml pins a hook repository to "${m[1]}", not a commit SHA`);

  for (const file of [
    'templates/qa-pr-caller.yml',
    '.github/workflows/qa-pr.yml',
    'config/github/org-ruleset-qa.json',
  ]) {
    if (!existsSync(join(ROOT, file))) {
      problems.push(`${file} is missing`);
      continue;
    }
    const versions = workflowVersions(read(file));
    if (versions.length === 0) problems.push(`${file} names no qa version`);
    for (const v of new Set(versions)) if (v !== root) problems.push(`${file} uses qa ${v}; the package is ${root}`);
  }

  if (!existsSync(join(ROOT, 'CHANGELOG.md'))) problems.push('CHANGELOG.md is missing');
  else if (!changelogSection(root)) problems.push(`CHANGELOG.md has no "## ${root}" section (the release notes)`);
  else if (!existsSync(join(ROOT, TEMPLATE))) problems.push(`${TEMPLATE} is missing (the release notes)`);
  else
    try {
      renderNotes(root);
    } catch (err) {
      problems.push(err.message);
    }

  const min = /^min_engine_version:\s*'?(\d+\.\d+\.\d+)'?/m.exec(read('policy.yaml'))?.[1];
  if (min && SEMVER.test(root) && compare(min, root) > 0)
    problems.push(`policy.yaml needs qa ${min} (min_engine_version), newer than this package (${root})`);

  if (problems.length > 0) throw new Error(problems.join('\n  '));
  return root;
}

module.exports = {
  checkVersions,
  changelogSection,
  workflowVersions,
  parsePullRequests,
  withoutReverted,
  pullRequestSection,
  renderNotes,
};

const USAGE =
  'usage: node scripts/release.js --check [<version>] | --notes <version> [--repo <owner/name>] [--sha256 <hex>] [--pull-requests <file>]';

/** "--name value" options after the version. */
function notesOptions(args) {
  const opts = {};
  const names = { '--repo': 'repo', '--sha256': 'sha256', '--pull-requests': 'pullRequestsFile' };
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]];
    if (!name || args[i + 1] === undefined) throw new Error(USAGE);
    opts[name] = args[i + 1];
  }
  return opts;
}

if (require.main === module) {
  try {
    if (process.argv[2] === '--notes') {
      const version = process.argv[3] ?? '';
      const { pullRequestsFile, ...opts } = notesOptions(process.argv.slice(4));
      if (pullRequestsFile) opts.pullRequests = readFileSync(resolve(pullRequestsFile), 'utf8');
      process.stdout.write(renderNotes(version, opts));
    } else if (process.argv[2] === '--check') {
      console.log(`Version ${checkVersions(process.argv[3])}`);
    } else throw new Error(USAGE);
  } catch (err) {
    console.error(`release: ${err.message}`);
    process.exitCode = 1;
  }
}
