#!/usr/bin/env node
// `node scripts/e2e-shard.mjs <k>/<n> [playwright args]` — run shard k of n of
// the E2E suite, the tests dealt out by how long each took on CI.
// `node scripts/e2e-shard.mjs --durations <report.json>...` — print that table
// of durations, out of the JSON reports the shards wrote.
//
// Playwright's own --shard cuts the listing into n CONTIGUOUS blocks of equal
// test count. The slow tests here are neighbours (the landmark gallery's specs
// sit in two adjacent files), so one block got all of them and ran several
// times longer than the rest, and the workflow is as slow as its slowest shard.
// Dealing in turn spread them, but still left one shard well over the others,
// so the deal is by DURATION: longest first, each to the shard with the least
// so far. The table is CI's own, refreshed from every green run on main
// (.github/workflows/test.yml), so nobody keeps it. A test it has not seen yet
// weighs the median; with no table at all every test weighs the same, which
// comes to nearly the old deal in turn.
//
// A test is named by file:line, which is what Playwright takes on its command
// line. Parameterised tests share a line and so stay together. The table is
// keyed by file and title instead, which survives a test moving down its file.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/// Every test in a Playwright JSON listing or report, in listing order: its
/// file:line and the key the duration table names it by.
export function tests(json) {
  const out = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs || []) {
      out.push({ where: `${spec.file}:${spec.line}`, key: [spec.file, ...titles, spec.title].join(' › '), spec });
    }
    for (const child of suite.suites || []) walk(child, [...titles, child.title]);
  };
  // The top-level suites are the files, whose title is the file again.
  for (const file of json.suites || []) walk(file, []);
  return out;
}

/// Seconds each test of a report cost its shard, retries included.
export function durations(report) {
  const table = {};
  for (const { key, spec } of tests(report)) {
    const ms = spec.tests.flatMap((t) => t.results).reduce((sum, r) => sum + r.duration, 0);
    table[key] = Math.round(ms / 100) / 10;
  }
  return table;
}

/// Weight per test location, in listing order: the sum of its tests' seconds
/// in the table, a test the table lacks counted at the table's median.
export function weights(listed, table) {
  const known = Object.values(table).sort((a, b) => a - b);
  const median = known.length ? known[known.length >> 1] : 1;
  const byWhere = new Map();
  let unknown = 0;
  for (const { where, key } of listed) {
    if (!(key in table)) unknown++;
    byWhere.set(where, (byWhere.get(where) || 0) + (table[key] ?? median));
  }
  return { where: [...byWhere.keys()], weight: [...byWhere.values()], unknown };
}

/// Longest-processing-time deal: indices into `weight`, n bins. Heaviest first,
/// each to the lightest bin so far (the lowest on a tie), so the result is a
/// pure function of the weights and every shard computes the same deal.
export function deal(weight, n) {
  const bins = Array.from({ length: n }, () => []);
  const load = new Array(n).fill(0);
  const order = weight.map((_, i) => i).sort((a, b) => weight[b] - weight[a] || a - b);
  for (const i of order) {
    const k = load.indexOf(Math.min(...load));
    bins[k].push(i);
    load[k] += weight[i];
  }
  return { bins: bins.map((b) => b.sort((x, y) => x - y)), load };
}

function main(argv) {
  if (argv[0] === '--durations') {
    const table = {};
    for (const file of argv.slice(1)) Object.assign(table, durations(JSON.parse(fs.readFileSync(file, 'utf8'))));
    if (!Object.keys(table).length) {
      console.error('e2e-shard: no test durations in', argv.slice(1).join(' ') || 'no reports');
      return 1;
    }
    process.stdout.write(JSON.stringify(table) + '\n');
    return 0;
  }

  const [k, n] = (argv[0] || '').split('/').map(Number);
  const rest = argv.slice(1);
  if (!(k >= 1 && k <= n)) {
    console.error('usage: node scripts/e2e-shard.mjs <k>/<n> [playwright args]');
    console.error('       node scripts/e2e-shard.mjs --durations <report.json>...');
    return 2;
  }
  // The table arrives as JSON in the environment, the same for every shard.
  const table = JSON.parse(process.env.E2E_DURATIONS || '{}');
  const listing = JSON.parse(execFileSync('npx',
    ['playwright', 'test', '--list', '--reporter=json', ...rest],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
  const listed = tests(listing);
  const { where, weight, unknown } = weights(listed, table);
  const { bins, load } = deal(weight, n);
  const mine = bins[k - 1].map((i) => where[i]);
  if (!mine.length) {
    console.error(`shard ${k}/${n} drew no tests out of ${where.length}`);
    return 1;
  }
  const s = (x) => Math.round(x);
  console.log(`shard ${k}/${n}: ${mine.length} of ${where.length} test locations; ` + (Object.keys(table).length
    ? `~${s(load[k - 1])} s by the duration table (slowest shard ~${s(Math.max(...load))} s),`
      + ` ${unknown} of ${listed.length} tests not in it`
    : 'no duration table, so every test weighs the same'));
  // The report the next table is made from (test.yml): Playwright clears
  // test-results/ when the run starts, and this is written when it ends.
  const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: path.resolve('test-results/e2e-report.json') };
  return spawnSync('npx', ['playwright', 'test', '--reporter=list,json', ...rest, ...mine],
    { stdio: 'inherit', env }).status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
