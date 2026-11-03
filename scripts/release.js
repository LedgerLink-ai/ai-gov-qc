#!/usr/bin/env node
'use strict';

// Release checks, used by CI and by scripts/package.js:
//
//   node scripts/release.js --check              both package.json files carry the same version
//   node scripts/release.js --check <version>    ... and it is <version> (the release workflow's input)
//
// The package version is the one `qa version` prints and the one repositories
// pin with "qa --require <version>", so a release must not drift from it.

const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

function checkVersions(expected) {
  const root = require(join(ROOT, 'package.json')).version;
  const engine = require(join(ROOT, 'packages', 'engine', 'package.json')).version;
  if (root !== engine)
    throw new Error(
      `package.json is ${root} but packages/engine/package.json is ${engine}; set both to the same version`,
    );
  if (!SEMVER.test(root)) throw new Error(`version ${root} is not MAJOR.MINOR.PATCH`);
  if (expected !== undefined && expected !== root)
    throw new Error(`asked to release ${expected}, but package.json is ${root}; bump both package.json files first`);
  return root;
}

module.exports = { checkVersions };

if (require.main === module) {
  try {
    if (process.argv[2] !== '--check') throw new Error('usage: node scripts/release.js --check [<version>]');
    console.log(`Version ${checkVersions(process.argv[3])}`);
  } catch (err) {
    console.error(`release: ${err.message}`);
    process.exitCode = 1;
  }
}
