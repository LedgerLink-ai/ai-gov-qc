#!/usr/bin/env node
'use strict';

// Release checks, used by CI and by scripts/package.js:
//
//   node scripts/release.js --check              versions agree everywhere (see below)
//   node scripts/release.js --check <version>    ... and the version is <version> (the release workflow's input)
//   node scripts/release.js --notes <version>    print the CHANGELOG.md section for <version> (release notes)
//
// The package version is the one `qa version` prints and the one repositories
// pin with "qa --require <version>", so a release must not drift from it:
//   - both package.json files carry the same MAJOR.MINOR.PATCH version
//   - templates/pre-commit-config.yaml pins exactly that version, and its hook
//     repositories by commit SHA
//   - templates/qa-pr-caller.yml, the reusable workflow and the organisation
//     ruleset (config/github/org-ruleset-qa.json) name it
//   - CHANGELOG.md has a section for it (the release notes)
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

  const min = /^min_engine_version:\s*'?(\d+\.\d+\.\d+)'?/m.exec(read('policy.yaml'))?.[1];
  if (min && SEMVER.test(root) && compare(min, root) > 0)
    problems.push(`policy.yaml needs qa ${min} (min_engine_version), newer than this package (${root})`);

  if (problems.length > 0) throw new Error(problems.join('\n  '));
  return root;
}

module.exports = { checkVersions, changelogSection, workflowVersions };

if (require.main === module) {
  try {
    if (process.argv[2] === '--notes') {
      const notes = changelogSection(process.argv[3] ?? '');
      if (!notes) throw new Error(`CHANGELOG.md has no section for "${process.argv[3]}"`);
      console.log(notes);
    } else if (process.argv[2] === '--check') {
      console.log(`Version ${checkVersions(process.argv[3])}`);
    } else throw new Error('usage: node scripts/release.js --check [<version>] | --notes <version>');
  } catch (err) {
    console.error(`release: ${err.message}`);
    process.exitCode = 1;
  }
}
