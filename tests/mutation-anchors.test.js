'use strict';

// ===========================================================================
// The engine mutation harness's anchors, checked on every `npm test`.
//
// scripts/mutation-check.mjs proves the ctests can fail, but it runs weekly
// (".github/workflows" "test the tests") and needs a native build, so the day a
// commit moved the code a mutation patches was never the day anyone heard of it:
// four entries reported ANCHOR MISSING for weeks, two of them aimed at camera
// constants a refactor had deleted. This is tests/wire-mutation-anchors.test.js
// for the engine list — DATA only, no build — and it holds each entry to:
//
//   1. `find` appears EXACTLY ONCE in its file. Zero means the code moved; more
//      than one means String.replace patches whichever comes first.
//   2. `expect` names a ctest that native/CMakeLists.txt still declares, so a
//      renamed test cannot read as a blind gate.
//
// It runs no mutation: whether one is CAUGHT stays the weekly job's question.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function countOccurrences(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

test('mutation-check: every mutation still anchors to live code', async () => {
  const { MUTATIONS } = await import('../scripts/mutation-check.mjs');
  assert.ok(MUTATIONS.length >= 40, `the list loaded (${MUTATIONS.length})`);

  const names = new Set();
  for (const m of MUTATIONS) {
    assert.ok(!names.has(m.name), `mutation names are ids: ${m.name} is used twice`);
    names.add(m.name);
    assert.notEqual(m.find, m.replace, `${m.name}: the mutation changes nothing`);
    if (m.optional) continue;
    const src = fs.readFileSync(path.join(ROOT, m.file), 'utf8');
    assert.equal(countOccurrences(src, m.find), 1,
      `${m.name}: its anchor must appear EXACTLY ONCE in ${m.file} — the code it breaks moved, ` +
      'so the mutation is dead and the gate it proves is unproven');
  }
});

test('mutation-check: every mutation names a ctest that still exists', async () => {
  const { MUTATIONS } = await import('../scripts/mutation-check.mjs');
  const cmake = fs.readFileSync(path.join(ROOT, 'native/CMakeLists.txt'), 'utf8');
  for (const m of MUTATIONS) {
    // The replay tests are declared once per fixture by a foreach: replay_${fx}.
    const declared = m.expect.startsWith('replay_')
      ? cmake.includes('add_test(NAME replay_${fx}') && cmake.includes(`  ${m.expect.slice(7)}\n`)
      : new RegExp(`add_test\\(NAME ${m.expect}\\b`).test(cmake);
    assert.ok(declared, `${m.name}: native/CMakeLists.txt declares no ctest named ${m.expect}`);
  }
});
