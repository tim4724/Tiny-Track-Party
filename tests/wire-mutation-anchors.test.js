'use strict';

// ===========================================================================
// The gate's gate, checked on every `npm test`.
//
// tests/wire-compat.test.js and tests/wire-fastlane.test.js are only a gate
// because scripts/wire-mutate{,-js}.mjs have been watched breaking them. But
// those harnesses run ON DEMAND — one needs emsdk and minutes of rebuild, the
// other is not wired into any CI job — so nothing noticed when four of their
// mutations stopped applying to anything: the LOBBY_UPDATE snapshot moved from
// public/display/Net.js into C++ (ttp::session::lobby_snapshot), the four
// `display/*` anchors matched no line any more, and the harness dutifully
// reported ANCHOR MISSING to an empty room.
//
// A mutation whose anchor is gone is a mutation that cannot fail, which is the
// same defect the wire suite exists to prevent, one level up. So this file reads
// scripts/wire-mutations.mjs — DATA, no build, no wasm, milliseconds — and holds
// every entry to the two things that make it real:
//
//   1. `find` still appears EXACTLY ONCE in the file it patches. Zero means the
//      code moved; more than one means String.replace would patch an arbitrary
//      occurrence and the mutation is not the one the entry describes.
//   2. `expect` still names a LIVE test title in one of the two suites. A
//      mutation that can only ever be "caught" by a test that no longer exists
//      reports NOT CAUGHT forever, which reads as a blind spot rather than as
//      the bookkeeping error it is.
//
// This file is deliberately NOT one of the suites the harnesses run: those runs
// patch the very anchors asserted here, so including it would paint one extra
// red test on every mutation.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SUITES = ['tests/wire-compat.test.js', 'tests/wire-fastlane.test.js'];

function countOccurrences(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

// Every `test('…', …)` title in the wire suites, unescaped the way the source
// wrote them (the titles carry \' escapes).
function suiteTitles() {
  const titles = [];
  for (const f of SUITES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/\btest\((['"])((?:\\.|(?!\1).)*)\1/g)) {
      titles.push(m[2].replace(/\\(['"\\])/g, '$1'));
    }
  }
  return titles;
}

test('wire: every mutation the harnesses apply still anchors to live code', async () => {
  const { CPP_MUTATIONS, JS_MUTATIONS } = await import('../scripts/wire-mutations.mjs');
  const all = [...CPP_MUTATIONS, ...JS_MUTATIONS];
  assert.ok(all.length >= 20, `both lists loaded (${all.length})`);

  const names = new Set();
  for (const m of all) {
    assert.ok(!names.has(m.name), `mutation names are ids: ${m.name} is used twice`);
    names.add(m.name);
    for (const k of ['name', 'kind', 'file', 'find', 'expect']) {
      assert.equal(typeof m[k], 'string', `${m.name}: ${k} is required`);
      assert.ok(m[k].length, `${m.name}: ${k} is empty`);
    }
    assert.equal(typeof m.replace, 'string', `${m.name}: replace is required (use '' to delete)`);
    assert.notEqual(m.find, m.replace, `${m.name}: the mutation changes nothing`);

    const abs = path.join(ROOT, m.file);
    assert.ok(fs.existsSync(abs), `${m.name}: ${m.file} does not exist`);
    const src = fs.readFileSync(abs, 'utf8');
    assert.equal(countOccurrences(src, m.find), 1,
      `${m.name}: its anchor must appear EXACTLY ONCE in ${m.file} — the code it breaks moved, ` +
      'so the mutation is dead and the gate it proves is unproven');
  }
});

test('wire: every mutation names a test that still exists to catch it', async () => {
  const { CPP_MUTATIONS, JS_MUTATIONS } = await import('../scripts/wire-mutations.mjs');
  const titles = suiteTitles();
  assert.ok(titles.length >= 30, `the suites' titles were scraped (${titles.length})`);
  for (const m of [...CPP_MUTATIONS, ...JS_MUTATIONS]) {
    assert.ok(titles.some((t) => t.includes(m.expect)),
      `${m.name}: no test in ${SUITES.join(' / ')} has a title containing "${m.expect}"`);
  }
});
