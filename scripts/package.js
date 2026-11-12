#!/usr/bin/env node
'use strict';

// Builds the installable package: out/ledgerlink-qa-<version>.tgz
//
//   node scripts/package.js        (npm run package)
//
// The package works the same on Windows, macOS and Linux and carries
// everything qa needs at run time:
//   bin/, dist/     the qa command (compiled engine)
//   config/         a snapshot of the registries, policy, rules, schemas and
//                   the pinned Gitleaks checksums
//   templates/      .pre-commit-config.yaml for each repository
//   node_modules/   its npm dependencies, bundled, so installing needs no registry
//
// Install it from wherever it is hosted (a file share, CodeArtifact, GitHub
// Packages) with "npm install -g <file, URL or @ledgerlink/qa@<version>>",
// then run "qa setup" once for pre-commit, Semgrep, Gitleaks and the hooks for every repository.

const { execFileSync, execSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { build } = require('./release-local');
const { checkVersions } = require('./release');

const ROOT = resolve(__dirname, '..');
const OUT = join(ROOT, 'out');
const STAGE = join(OUT, 'package');
const NAME = '@ledgerlink/qa';

// What the engine reads from its configuration directory.
const CONFIG = ['policy.yaml', 'checks.yaml', 'path-tags.yaml', 'exemptions.yaml', 'registry', 'schemas', 'config'];

/** npm is a .cmd shim on Windows, which only a shell can start; the shell takes one quoted command line. */
function npm(cwd, ...args) {
  const opts = { cwd, stdio: ['ignore', 'pipe', 'inherit'] };
  const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a}"`);
  const out =
    process.platform === 'win32'
      ? execSync(['npm', ...args].map(quote).join(' '), opts)
      : execFileSync('npm', args, opts);
  return out.toString('utf8').trim();
}

function packageJson(version) {
  const engine = JSON.parse(readFileSync(join(ROOT, 'packages', 'engine', 'package.json'), 'utf8'));
  return {
    name: NAME,
    version,
    description:
      'LedgerLink local checks: the qa command for the pre-commit, pre-push and pre-PR hooks, with "qa setup" for pre-commit, Semgrep and Gitleaks.',
    license: engine.license,
    bin: { qa: 'bin/qa.js' },
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    engines: engine.engines,
    files: ['bin', 'dist', 'config', 'templates', 'README.md'],
    dependencies: engine.dependencies,
    bundleDependencies: Object.keys(engine.dependencies),
  };
}

const README = (version) => `# ${NAME} ${version}

LedgerLink's local checks for every repository: the \`qa\` command behind the
pre-commit, prepare-commit-msg, pre-push and pre-PR hooks. Works on Windows, macOS and
Linux. Needs Node 20+, git and Python 3.11 to 3.14.

## Install, once per machine

Verify the file first (its SHA-256 and the build provenance signed by the
release workflow), then install it without running package scripts:

    sha256sum -c ledgerlink-qa-${version}.tgz.sha256
    gh attestation verify ledgerlink-qa-${version}.tgz --repo LedgerLink-ai/ai-gov-qc
    npm install -g --ignore-scripts ./ledgerlink-qa-${version}.tgz
    qa setup

Operations, rollback and maintenance: docs/OPERATIONS.md in the qa repository.

\`qa setup\` installs pre-commit, Semgrep and Gitleaks at the versions pinned in
\`config/policy.yaml\` into ~/.ledgerlink-qa (Gitleaks is checked against its
published SHA-256), and connects the hooks in every repository on the machine,
existing clones included (git's global core.hooksPath; \`qa setup --uninstall\`
removes them). Add the \`bin\` folder it names to PATH. Without network access to
GitHub: \`qa setup --gitleaks-archive <downloaded archive>\`.

## Each repository

Nothing to copy: in every opted-in LedgerLink-ai repository the hooks use the
default configuration in this package (\`templates/pre-commit-config.yaml\`).
To change what runs in one repository, copy that file there as
\`.pre-commit-config.yaml\`; the copy then wins. Then:

    qa doctor                                      # is this machine and repository ready?
    pre-commit run --hook-stage manual --all-files # the pre-PR checks
`;

function main() {
  const version = checkVersions();
  build();
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  cpSync(join(ROOT, 'packages', 'engine', 'bin'), join(STAGE, 'bin'), { recursive: true });
  cpSync(join(ROOT, 'packages', 'engine', 'dist'), join(STAGE, 'dist'), { recursive: true });
  for (const item of CONFIG) cpSync(join(ROOT, item), join(STAGE, 'config', item), { recursive: true });
  cpSync(join(ROOT, 'templates'), join(STAGE, 'templates'), { recursive: true });
  writeFileSync(join(STAGE, 'README.md'), README(version));
  writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify(packageJson(version), null, 2)}\n`);

  npm(STAGE, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error');
  const file = npm(STAGE, 'pack', '--pack-destination', OUT, '--loglevel=error').split(/\r?\n/).pop();
  const tgz = join(OUT, file);
  const sha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  writeFileSync(`${tgz}.sha256`, `${sha256}  ${file}\n`);
  return { tgz, sha256, version };
}

module.exports = { buildPackage: main };

if (require.main === module) {
  try {
    const { tgz, sha256 } = main();
    console.log(`Built ${tgz} (${Math.round(statSync(tgz).size / 1024)} KB)`);
    console.log(`SHA-256 ${sha256}`);
    console.log(`Install: npm install -g "${tgz}"   then: qa setup`);
  } catch (err) {
    console.error(`package: ${err.message}`);
    process.exitCode = 1;
  }
}
