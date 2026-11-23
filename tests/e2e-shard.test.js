'use strict';
// scripts/e2e-shard.mjs deals the E2E suite to CI's shards by duration. Every
// shard computes the deal on its own, so what matters is that it is a pure
// function that hands each test location to exactly one shard, and that the
// table is read off Playwright's JSON the way the run writes it.
const test = require('node:test');
const assert = require('node:assert/strict');

let shard;
test.before(async () => {
  shard = await import('../scripts/e2e-shard.mjs');
});

// The shape both `playwright test --list --reporter=json` and a run's JSON
// report share: file suites, describe suites inside, specs with results.
const spec = (title, line, ...ms) => ({
  title, file: 'a.spec.js', line,
  tests: [{ results: ms.map((duration) => ({ duration })) }],
});
const report = {
  suites: [{
    title: 'a.spec.js', file: 'a.spec.js', line: 0,
    specs: [spec('param 1', 3, 2000), spec('param 2', 3, 1000), spec('flaky', 9, 4000, 6000)],
    suites: [{ title: 'group', file: 'a.spec.js', line: 5, specs: [spec('one', 6, 12340)] }],
  }],
};

test('tests are keyed by file and title path, located by file:line', () => {
  assert.deepEqual(shard.tests(report).map(({ where, key }) => [where, key]), [
    ['a.spec.js:3', 'a.spec.js › param 1'],
    ['a.spec.js:3', 'a.spec.js › param 2'],
    ['a.spec.js:9', 'a.spec.js › flaky'],
    ['a.spec.js:6', 'a.spec.js › group › one'],
  ]);
});

test('a test costs its shard every attempt, in tenths of a second', () => {
  assert.deepEqual(shard.durations(report), {
    'a.spec.js › param 1': 2,
    'a.spec.js › param 2': 1,
    'a.spec.js › flaky': 10,
    'a.spec.js › group › one': 12.3,
  });
});

test('a location weighs its tests together; one the table lacks weighs the median', () => {
  const table = { 'a.spec.js › param 1': 2, 'a.spec.js › flaky': 10, 'a.spec.js › gone': 4 };
  const w = shard.weights(shard.tests(report), table);
  assert.deepEqual(w.where, ['a.spec.js:3', 'a.spec.js:9', 'a.spec.js:6']);
  // param 2 and group › one are unknown: the median of 2, 4, 10 is 4.
  assert.deepEqual(w.weight, [2 + 4, 10, 4]);
  assert.equal(w.unknown, 2);
});

test('with no table every test weighs one', () => {
  assert.deepEqual(shard.weights(shard.tests(report), {}).weight, [2, 1, 1]);
});

test('every location goes to exactly one shard', () => {
  const weight = Array.from({ length: 117 }, (_, i) => ((i * 7919) % 61) + 1);
  for (const n of [1, 2, 6, 8]) {
    const { bins, load } = shard.deal(weight, n);
    assert.equal(bins.length, n);
    assert.deepEqual(bins.flat().sort((a, b) => a - b), weight.map((_, i) => i));
    assert.equal(load.reduce((a, b) => a + b), weight.reduce((a, b) => a + b));
    // LPT's bound: no shard exceeds the mean by more than one test.
    assert.ok(Math.max(...load) <= load.reduce((a, b) => a + b) / n + Math.max(...weight));
  }
});

test('the deal is longest first, to the lightest shard, ties to the lowest', () => {
  assert.deepEqual(shard.deal([3, 5, 4, 3, 3], 2).bins, [[1, 3], [0, 2, 4]]);
  // Equal weights deal in turn.
  assert.deepEqual(shard.deal([1, 1, 1, 1, 1], 3).bins, [[0, 3], [1, 4], [2]]);
});

test('the deal is a pure function of the weights', () => {
  const weight = [9, 1, 9, 1, 5, 5, 0, 0, 7];
  assert.deepEqual(shard.deal(weight, 4), shard.deal([...weight], 4));
});
