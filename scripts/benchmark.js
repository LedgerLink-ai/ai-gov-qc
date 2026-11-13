#!/usr/bin/env node
'use strict';

// Performance benchmark for the qa engine (docs/PERFORMANCE.md):
//
//   npm run build && node scripts/benchmark.js [--files 300] [--repeat 3] [--json out/benchmark.json]
//
// Generates a synthetic change of N files (TypeScript under ledger paths, agent
// instruction files, MCP configuration, plain docs), then times the engine:
//   native        the engine's own checks only (no scanners)
//   full-cold     every check, scanners included, cache empty, one check at a time
//   full-parallel the same with parallel checks (policy.yaml performance.parallelism)
//   full-warm     the same again with the cache filled (an unchanged re-run)
// Scanners that are not installed are left out and the report says so.
// Each scenario runs --repeat times; the median is reported.

const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir, cpus, platform, arch } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const engine = require(join(ROOT, 'packages', 'engine', 'dist', 'index.js'));
const { openCache } = require(join(ROOT, 'packages', 'engine', 'dist', 'cache.js'));
const { TOOL_ADAPTERS } = require(join(ROOT, 'packages', 'engine', 'dist', 'adapters', 'tools', 'index.js'));
const { createLogger, setLogger } = require(join(ROOT, 'packages', 'engine', 'dist', 'log.js'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const FILES = Number(arg('files', '300'));
const REPEAT = Number(arg('repeat', '3'));
const JSON_OUT = arg('json', undefined);

function generate(dir, n) {
  const files = [];
  const put = (rel, text) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    files.push(rel);
  };
  for (let i = 0; i < n; i++) {
    const kind = i % 10;
    if (kind < 6)
      put(
        `src/transaction/module${i}.ts`,
        `export function settle${i}(amount: bigint, fee: bigint): bigint {\n` +
          `  // settlement step ${i}\n  return amount - fee;\n}\n`.repeat(20),
      );
    else if (kind < 8)
      put(`src/util/helper${i}.ts`, `export const helper${i} = (x: number): number => x * ${i};\n`.repeat(30));
    else if (kind === 8) put(`docs/note${i}.md`, `# Note ${i}\n\nPlain documentation for the benchmark.\n`.repeat(10));
    else put(`packages/p${i}/AGENTS.md`, `Run the tests before committing. Never commit with --no-verify.\n`.repeat(5));
  }
  put('.mcp.json', JSON.stringify({ mcpServers: {} }, null, 2));
  return files;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function scenario(name, root, files, extra) {
  const config = engine.loadConfig(ROOT);
  const times = [];
  let last;
  for (let i = 0; i < REPEAT; i++) {
    const cache = extra.cacheDir ? openCache(extra.cacheDir) : undefined;
    const started = process.hrtime.bigint();
    last = await engine.run({
      config,
      repo: 'link_core',
      sha: 'benchmark',
      root,
      actor: 'human',
      mode: 'local',
      asOf: '2027-01-08',
      changedFiles: files.map((path) => ({ path, status: 'A' })),
      source: engine.directorySource(root),
      exclude: extra.exclude,
      parallelism: extra.parallelism,
      timeBudgetMs: 3_600_000,
      cache,
    });
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (extra.resetCache && extra.cacheDir) rmSync(extra.cacheDir, { recursive: true, force: true });
  }
  const perCheck = Object.fromEntries(
    last.checkRuns.filter((r) => r.status !== 'skipped').map((r) => [r.checkId, r.durationMs]),
  );
  return { name, median_ms: Math.round(median(times)), runs_ms: times.map(Math.round), per_check_ms: perCheck };
}

async function main() {
  setLogger(createLogger({ format: 'text', level: 'silent' }));
  const root = mkdtempSync(join(tmpdir(), 'qa-bench-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'qa-bench-cache-'));
  try {
    const files = generate(root, FILES);
    const tools = Object.keys(TOOL_ADAPTERS);
    const missing = tools.filter((t) => !TOOL_ADAPTERS[t].available());
    const config = engine.loadConfig(ROOT);
    const toolChecks = config.checks.filter((c) => c.kind === 'tool').map((c) => c.id);
    const missingChecks = config.checks.filter((c) => c.kind === 'tool' && missing.includes(c.tool)).map((c) => c.id);

    const results = [];
    results.push(await scenario('native', root, files, { exclude: toolChecks, parallelism: 1 }));
    results.push(
      await scenario('full-cold', root, files, { exclude: missingChecks, parallelism: 1, cacheDir, resetCache: true }),
    );
    results.push(
      await scenario('full-parallel', root, files, {
        exclude: missingChecks,
        parallelism: config.policy.performance?.parallelism ?? 4,
        cacheDir,
        resetCache: true,
      }),
    );
    // Fill the cache once, then time re-runs against it.
    await scenario('fill', root, files, { exclude: missingChecks, parallelism: 4, cacheDir });
    results.push(await scenario('full-warm', root, files, { exclude: missingChecks, parallelism: 4, cacheDir }));

    const report = {
      engine_version: engine.ENGINE_VERSION,
      files: files.length,
      repeat: REPEAT,
      host: { os: platform(), arch: arch(), cpus: cpus().length, cpu: cpus()[0]?.model, node: process.versions.node },
      tools: Object.fromEntries(tools.map((t) => [t, TOOL_ADAPTERS[t].version() ?? 'not installed'])),
      results,
    };
    console.log(`qa ${report.engine_version} benchmark: ${report.files} files, median of ${REPEAT} runs`);
    console.log(`host: ${report.host.os}/${report.host.arch}, ${report.host.cpus} CPUs, node ${report.host.node}`);
    console.log(
      `tools: ${Object.entries(report.tools)
        .map(([t, v]) => `${t} ${v}`)
        .join(', ')}`,
    );
    for (const r of results)
      console.log(`  ${r.name.padEnd(14)} ${String(r.median_ms).padStart(7)} ms   ${JSON.stringify(r.per_check_ms)}`);
    if (JSON_OUT) {
      mkdirSync(dirname(resolve(JSON_OUT)), { recursive: true });
      writeFileSync(resolve(JSON_OUT), JSON.stringify(report, null, 2) + '\n');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`benchmark: ${err.message}`);
  process.exitCode = 1;
});
