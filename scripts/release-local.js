#!/usr/bin/env node
'use strict';

// Publishes this checkout as a local pre-commit hook repository, the way the
// GitHub-hosted qc-workflows repository will serve it: a git repository with a
// tag that .pre-commit-config.yaml pins as `rev`. Used until qc-workflows is on
// GitHub; this checkout's own git history is not touched.
//
//   node scripts/release-local.js [target]     (default: ../sandbox/qa-hooks)
//
// The tag is v<version>-local.<tree hash>, so a release with different content
// gets a different rev and pre-commit never reuses a stale cached copy.
//
// A release carries the built engine (packages/engine/dist). pre-commit
// installs node hooks with "npm install -g <repo>", and in that global mode npm
// cannot build the TypeScript itself, so a hook release must already be built.
// The GitHub release workflow does the same when it tags a version.

const { execFileSync, spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, rmSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const DEFAULT_TARGET = resolve(ROOT, '..', 'sandbox', 'qa-hooks');
const DIST = 'packages/engine/dist';

function build() {
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const res = spawnSync(process.execPath, [tsc, '-p', 'packages/engine/tsconfig.build.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('the engine build failed; run "npm install" and "npm run build"');
}

function releaseLocal(target = DEFAULT_TARGET) {
  const { version } = require(join(ROOT, 'package.json'));
  build();
  const listed = (...args) =>
    execFileSync('git', ['ls-files', '-z', ...args], { cwd: ROOT })
      .toString('utf8')
      .split('\0')
      .filter((f) => f && existsSync(join(ROOT, f)));
  const files = [
    ...listed('--cached', '--others', '--exclude-standard'),
    ...listed('--others', '--ignored', '--exclude-standard', '--', DIST),
  ];

  rmSync(target, { recursive: true, force: true });
  for (const file of files) {
    const to = join(target, file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(ROOT, file), to);
  }
  const git = (...args) => execFileSync('git', args, { cwd: target, stdio: 'pipe' }).toString('utf8').trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'user.name', 'qa local release');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('add', '-f', DIST);
  git('commit', '-q', '-m', `release v${version}`);
  const rev = `v${version}-local.${git('rev-parse', 'HEAD^{tree}').slice(0, 7)}`;
  git('tag', rev);
  return { repo: target.split('\\').join('/'), rev, files: files.length };
}

module.exports = { build, releaseLocal };

if (require.main === module) {
  const target = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_TARGET;
  const { repo, rev, files } = releaseLocal(target);
  console.log(`Released ${files} files to ${repo}`);
  console.log(`Pin it in .pre-commit-config.yaml as:\n  - repo: '${repo}'\n    rev: ${rev}`);
}
