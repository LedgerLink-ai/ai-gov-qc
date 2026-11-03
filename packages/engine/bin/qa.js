#!/usr/bin/env node
'use strict';

require('../dist/cli.js')
  .main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`qa: engine error: ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
