'use strict';
// The web's present pacer, driven with rAF stamp trains.
//
// WHAT IT PINS. At the host's half rate on a 120 Hz panel (divisor 2), a rAF
// callback that arrives one vsync late costs a three-vsync picture ONLY when
// it is the callback that was due to draw — no callback existed on the due
// vsync, so no gate can do better. A slip on the other callback costs nothing:
// the one after it is two vsyncs past the last present and draws. Counting
// callbacks (the previous gate) skipped that one too, for being odd, so every
// slip was a long picture. The property is therefore the earliest-callback
// rule: a callback draws iff it is at least `divisor` whole vsyncs after the
// last present. The old rule is kept as the control arm so the assertion is
// known to be able to fail.
const test = require('node:test');
const assert = require('node:assert/strict');

const PERIOD = 1000 / 120;

// Stamps of a 120 Hz train in which the callbacks named in `late` arrive one
// vsync late (the browser skipped a vsync before them), plus optional jitter.
function train(n, late = [], jitter = () => 0) {
  const out = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    if (late.includes(i)) t += PERIOD;
    out.push(t + jitter(i));
    t += PERIOD;
  }
  return out;
}

// Which stamps draw under the pacer, with the period known from the second
// stamp on (the loop learns it off the first delta).
async function presents(stamps, divisor) {
  const { PresentPacer } = await import('../public/display/presentPacer.js');
  const pacer = new PresentPacer();
  return stamps.filter((t, i) => pacer.due(t, i === 0 ? 0 : PERIOD, divisor));
}

// The old gate: every `divisor`th callback, counted from the first.
const parity = (stamps, divisor) => stamps.filter((_, i) => i % divisor === 0);

// Present gaps in whole vsyncs, which is what a panel shows.
const gaps = (drawn) => drawn.slice(1).map((t, i) => Math.round((t - drawn[i]) / PERIOD));

// The earliest-callback rule, checked over the whole train: a callback draws
// iff it is at least `divisor` whole vsyncs after the last present.
function earliest(stamps, drawn, divisor) {
  const set = new Set(drawn);
  let last = -Infinity;
  for (const t of stamps) {
    const due = Math.round((t - last) / PERIOD) >= divisor;
    if (set.has(t) !== due) return false;
    if (due) last = t;
  }
  return true;
}

test('divisor 2 on a clean 120 Hz train draws every second vsync', async () => {
  const drawn = await presents(train(40), 2);
  assert.equal(drawn.length, 20);
  assert.deepEqual(new Set(gaps(drawn)), new Set([2]));
});

test('a slip on the callback that was NOT due costs no long picture', async () => {
  // Draws start on the even callbacks, and each off-phase slip moves them to
  // the other parity (the late callback itself draws), so the slips alternate.
  const stamps = train(60, [3, 10, 17]);
  const drawn = await presents(stamps, 2);
  assert.deepEqual(new Set(gaps(drawn)), new Set([2]), `gaps ${gaps(drawn)}`);
  // The control arm: counting callbacks made each of them a three-vsync gap.
  assert.equal(gaps(parity(stamps, 2)).filter((g) => g === 3).length, 3);
});

test('a slip on the due callback costs exactly one long picture, then relocks', async () => {
  const stamps = train(60, [4, 10]);
  const drawn = await presents(stamps, 2);
  const g = gaps(drawn);
  assert.equal(g.filter((x) => x === 3).length, 2, `gaps ${g}`);
  assert.deepEqual(new Set(g), new Set([2, 3]));
  assert.ok(earliest(stamps, drawn, 2));
});

test('mixed and consecutive slips: the earliest-callback rule holds, parity breaks it', async () => {
  const stamps = train(80, [3, 17, 18, 40, 41, 42, 61]);
  const drawn = await presents(stamps, 2);
  assert.ok(earliest(stamps, drawn, 2));
  assert.ok(!earliest(stamps, parity(stamps, 2), 2), 'control arm must violate the rule on this train');
  assert.ok(gaps(drawn).filter((x) => x === 3).length < gaps(parity(stamps, 2)).filter((x) => x === 3).length);
});

test('stamp jitter of ±1 ms does not move a present', async () => {
  const jitter = (i) => ((i * 7919) % 2000) / 1000 - 1;   // deterministic, in [-1, 1)
  const stamps = train(60, [9, 30], jitter);
  const drawn = await presents(stamps, 2);
  assert.deepEqual(new Set(gaps(drawn)), new Set([2]), `gaps ${gaps(drawn)}`);
});

test('divisor 1, and an unknown period, draw every callback', async () => {
  assert.equal((await presents(train(30, [4]), 1)).length, 30);
  const { PresentPacer } = await import('../public/display/presentPacer.js');
  const pacer = new PresentPacer();
  for (const t of train(10)) assert.equal(pacer.due(t, 0, 2), true);
});

test('a stall draws at once rather than waiting out another vsync', async () => {
  const { PresentPacer } = await import('../public/display/presentPacer.js');
  const pacer = new PresentPacer();
  assert.equal(pacer.due(0, PERIOD, 2), true);
  assert.equal(pacer.due(PERIOD, PERIOD, 2), false);
  // 300 ms later the loop's period average holds the stall and hands over 0.
  assert.equal(pacer.due(PERIOD + 300, 0, 2), true);
  // The cadence resumes from the stall's own present.
  assert.equal(pacer.due(PERIOD + 300 + PERIOD, PERIOD, 2), false);
  assert.equal(pacer.due(PERIOD + 300 + 2 * PERIOD, PERIOD, 2), true);
});

test('divisor 4 on a 120 Hz train with slips holds the earliest-callback rule', async () => {
  const stamps = train(80, [5, 6, 21, 50]);
  const drawn = await presents(stamps, 4);
  assert.ok(earliest(stamps, drawn, 4));
  assert.ok(gaps(drawn).every((x) => x === 4 || x === 5), `gaps ${gaps(drawn)}`);
});
