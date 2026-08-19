'use strict';
// One source per shared number, for the eight names a harness seats.
//
// `race_flow.cc`'s `kBenchNames` is the source: `benchPlayers` composes the
// bench field from it, so every RACE a harness stands up — on all three
// platforms — is already named from C++ and cannot drift. What this file exists
// for is the two surfaces that do NOT go through that field and still have to
// agree with it: the web's lobby roster and fabricated boards, and the Android
// harness's fabricated boards. Those screens have no launch behind them (there
// is no room, and no race), so they carry a hand-typed copy.
//
// WHY IT MATTERS THAT THEY AGREE. The screens gallery exists to put the same
// screen from three platforms side by side. A column that renamed the players
// differs in a way that has nothing to do with the UI under inspection, and the
// tvOS harness proved it: it picked Ann/Bo/Cy/Di and every comparison since
// carried that as noise until it was aligned. A mirror is acceptable here (the
// alternative is a wasm round trip to paint a static lobby); a mirror that can
// drift silently is not, which is why this gate exists rather than a comment.
//
// Same shape as tests/feature-bits.test.js, and for the same reason.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The source: a C string array literal, one row.
function sourceNames() {
  const src = read('native/libttp-runtime/ttp/race_flow.cc');
  const i = src.indexOf('kBenchNames[]');
  assert.ok(i > 0, 'race_flow.cc no longer declares kBenchNames');
  const body = src.slice(src.indexOf('{', i), src.indexOf('};', i));
  const names = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 4, 'kBenchNames parsed empty — its spelling has moved');
  return names;
}

// A mirror, as `['a', 'b', …]` or `listOf("a", "b", …)` after the given anchor.
function mirror(rel, anchor) {
  const src = read(rel);
  const i = src.indexOf(anchor);
  assert.ok(i > 0, `${rel}: '${anchor}' has moved`);
  const open = src.indexOf('(', i) >= 0 && src.indexOf('(', i) < src.indexOf('[', i) + 1
    ? src.indexOf('(', i) : src.indexOf('[', i);
  const close = src.indexOf(src[open] === '(' ? ')' : ']', open);
  return [...src.slice(open, close).matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

test('the web harness names its seats what the bench field does', () => {
  // The lobby roster and the fabricated boards. The RACE scenarios take their
  // names off ttp_race_bench_field_json and are not at risk.
  assert.deepEqual(mirror('public/display/TestHarness.js', 'const FAKE_NAMES'),
    sourceNames(),
    'TestHarness.js FAKE_NAMES disagrees with race_flow.cc kBenchNames');
});

test('and so does the Android harness', () => {
  assert.deepEqual(
    mirror('shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/Scenarios.kt',
      'private val NAMES'),
    sourceNames(),
    'Scenarios.kt NAMES disagrees with race_flow.cc kBenchNames');
});

test('the tvOS harness keeps no copy at all', () => {
  // It takes every name off the bench field, which is what the other two should
  // do wherever they have a launch to take one from. A list reappearing here is
  // a regression, not a mirror to add to the gate above.
  const src = read('shells/tvos/TinyTrackParty/Harness/Scenarios.swift');
  for (const name of sourceNames()) {
    assert.ok(!src.includes(`"${name}"`),
      `Scenarios.swift has grown its own "${name}" — take it off the bench field instead`);
  }
});
