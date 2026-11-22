#!/usr/bin/env node
// `node scripts/e2e-shard.mjs <k>/<n> [playwright args]` — run every n-th test
// of the E2E suite, counted across the whole listing.
//
// Playwright's own --shard cuts the listing into n CONTIGUOUS blocks of equal
// test count. The slow tests here are neighbours (the landmark gallery's specs
// sit in two adjacent files), so one block got all of them and ran several
// times longer than the rest, and the workflow is as slow as its slowest shard.
// Dealing the listing out in turn spreads any such cluster over every shard
// with no table of timings to keep current.
//
// A test is named by file:line, which is what Playwright takes on its command
// line. Parameterised tests share a line and so stay together.
import { execFileSync, spawnSync } from 'node:child_process';

const [k, n] = (process.argv[2] || '').split('/').map(Number);
const rest = process.argv.slice(3);
if (!(k >= 1 && k <= n)) {
  console.error('usage: node scripts/e2e-shard.mjs <k>/<n> [playwright args]');
  process.exit(2);
}

const listing = JSON.parse(execFileSync('npx',
  ['playwright', 'test', '--list', '--reporter=json', ...rest],
  { encoding: 'utf8', maxBuffer: 64 << 20 }));
const where = new Set();
const walk = (suite) => {
  for (const spec of suite.specs || []) where.add(`${spec.file}:${spec.line}`);
  for (const child of suite.suites || []) walk(child);
};
listing.suites.forEach(walk);

const mine = [...where].filter((_, i) => i % n === k - 1);
if (!mine.length) {
  console.error(`shard ${k}/${n} drew no tests out of ${where.size}`);
  process.exit(1);
}
console.log(`shard ${k}/${n}: ${mine.length} of ${where.size} test locations`);
process.exit(spawnSync('npx', ['playwright', 'test', ...rest, ...mine], { stdio: 'inherit' }).status ?? 1);
