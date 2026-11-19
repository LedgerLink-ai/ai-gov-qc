#!/usr/bin/env node
'use strict';

const argv = process.argv.slice(2);

// "qa hook <name>", also after "--require <version>": the git hooks "qa setup"
// installs for every repository. A broken install never blocks every repository.
function isHookCall(args) {
  const lead = /^--require=/.test(args[0] || '') ? 1 : args[0] === '--require' ? 2 : 0;
  return args[lead] === 'hook';
}

let cli;
try {
  cli = require('../dist/cli.js');
} catch (err) {
  const reason = err && err.message ? err.message.split('\n')[0] : String(err);
  if (isHookCall(argv)) {
    process.stderr.write(
      `qa: the LedgerLink QA engine could not load (${reason}), so its checks were skipped. Reinstall qa, or remove its hooks: qa setup --uninstall\n`,
    );
    process.exitCode = 0;
  } else {
    process.stderr.write(
      `qa: the LedgerLink QA engine could not load (${reason}). Reinstall it (npm install -g @ledgerlink/qa, or the .tgz from your team's release); in a checkout, run "npm run build".\n`,
    );
    process.exitCode = 2;
  }
}

if (cli) {
  Promise.resolve()
    .then(() => cli.main(argv))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`qa: engine error: ${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = 2;
    });
}
