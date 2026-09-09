'use strict';
// One source per shared number, for the cup points ladder and the column it has
// to fit in.
//
// `grand_prix.cc`'s POINTS_BY_RANK is the source, and every LIVE board takes its
// gains from it through the wire. What this file exists for is the surfaces that
// do not: the three harnesses fabricate cup boards with no series behind them
// (there is no room, and no race), so each carries a hand-typed copy of the
// ladder — and the results board's gain cell carries a hand-typed WIDTH sized to
// the ladder's biggest rung.
//
// WHY IT MATTERS THAT THEY AGREE. The gallery puts the same board from three
// platforms side by side, so a column scoring the old ladder differs in a way
// that has nothing to do with the UI under inspection. The width is worse than
// cosmetic: on the web it is a `min-width` and an outgrown cell merely resizes
// the board mid-animation, but both shells lay the cell out at a HARD width, so
// a gain that does not fit is clipped on a live TV board. Widening the ladder
// from four rungs to eight broke both of these at once, in the same change that
// widened it — which is why this is a gate and not a comment.
//
// Same shape as tests/bench-roster.test.js, and for the same reason.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Every integer in the list the anchor is assigned. Scanning starts at the `=`,
// not the anchor, so a C array's extent (`POINTS_BY_RANK[8]`) is not read as the
// list — all four spellings put their brackets on the right of one.
function numbers(rel, anchor) {
  const src = read(rel);
  const i = src.indexOf(anchor);
  assert.ok(i > 0, `${rel}: '${anchor}' has moved`);
  const eq = src.indexOf('=', i);
  assert.ok(eq > 0, `${rel}: '${anchor}' is not an assignment`);
  const open = src.slice(eq).search(/[[{(]/) + eq;
  const close = src.indexOf({ '[': ']', '{': '}', '(': ')' }[src[open]], open);
  const out = [...src.slice(open + 1, close).matchAll(/-?\d+/g)].map((m) => Number(m[0]));
  assert.ok(out.length > 0, `${rel}: '${anchor}' parsed empty — its spelling has moved`);
  return out;
}

// The source. The declaration carries its own extent, so a table that lost a
// rung fails here rather than zero-padding.
function ladder() {
  const out = numbers('native/libttp-sim/ttp/grand_prix.cc', 'const int POINTS_BY_RANK[');
  assert.equal(out.length, 8, 'grand_prix.cc POINTS_BY_RANK is no longer eight rungs');
  return out;
}

test('every harness fabricates its cup boards on the shipped ladder', () => {
  for (const [rel, anchor] of [
    ['public/display/TestHarness.js', 'const POINTS_BY_RANK'],
    ['public/controller/TestHarness.js', 'const POINTS_BY_RANK'],
    ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/Scenarios.kt',
      'private val POINTS_BY_RANK'],
    ['shells/tvos/TinyTrackParty/Harness/Scenarios.swift', 'private static let pointsByRank']
  ]) {
    assert.deepEqual(numbers(rel, anchor), ladder(),
      `${rel} disagrees with grand_prix.cc POINTS_BY_RANK`);
  }
});

test('the gain column fits the widest gain the ladder pays', () => {
  // In `em`/type multiples: the cell holds "+" plus the widest rung, and the
  // count-up empties it to "+0", so a width that only fits the SETTLED state
  // lets the cell change size under the re-sort. One number, three spellings.
  const widest = `+${Math.max(...ladder())}`;
  const css = /min-width:\s*([\d.]+)em/.exec(read('public/display/display.css')
    .split('.res-gain {')[1] || '');
  assert.ok(css, 'display.css .res-gain no longer declares a min-width');
  const width = Number(css[1]);
  // 0.9em per character is what the board's tabular figures measure at; the
  // point of the assertion is the RELATIONSHIP, not the constant.
  assert.ok(width >= widest.length * 0.9,
    `.res-gain is ${width}em, too narrow for "${widest}"`);
  // Anchored on the cell's own text, because every column in the row is written
  // as the same `type * N` and the first match is the wrong one.
  for (const [rel, anchor, re] of [
    ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/ResultsScreen.kt',
      'row.gained?.let { Copy.gained(it) }', /ROW_TYPE \* ([\d.]+)f/],
    ['shells/tvos/TinyTrackParty/Screens/ResultsView.swift',
      'Copy.gained(row.gained ?? 0)', /Self\.type \* ([\d.]+)/]
  ]) {
    const src = read(rel);
    const i = src.indexOf(anchor);
    assert.ok(i > 0, `${rel}: the gain cell has moved`);
    const m = re.exec(src.slice(i));
    assert.ok(m, `${rel}: the gain cell no longer declares a width`);
    assert.equal(Number(m[1]), width, `${rel} gain width disagrees with .res-gain`);
  }
});
