'use strict';
// The perf HUD's one pure decision: how many frame budgets a frame missed.
// Everything else in PerfHud.js is DOM, GL and drawing, which this cannot reach.
//
// There used to be a second decision here — what the display's refresh rate IS,
// via a snap table and a rank statistic over the frame ring. It is gone, and
// deliberately: the bar is a flat 60 fps, so every number the HUD prints is
// measured against a CONSTANT 16.7 ms and there is nothing left to detect. The
// detector's own boot bug (one junk interval from Stage.start() naming a 476 Hz
// display) went with it. git history has it if a per-panel budget is ever
// wanted back.
//
// Importing the module is safe in Node: the class touches document/window only
// in its constructor, never at module scope.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(
    path.join(__dirname, '..', 'public/display/render/PerfHud.js')).href;

test('the frame budget is a flat 60 fps, not the panel', async () => {
  const { BUDGET_MS, GOOD_HZ } = await import(MOD);
  assert.equal(GOOD_HZ, 60);
  assert.ok(Math.abs(BUDGET_MS - 16.6667) < 0.001);
});

test('warm-up needs a RUN of good frames, not one', async () => {
  const { warmupRun } = await import(MOD);
  const RUN = 3;   // WARMUP_RUN
  // Fold a boot sequence the way tick() does; returns the index of the first
  // frame that gets RECORDED (everything before it is discarded).
  const firstKept = (seq) => {
    let run = 0;
    for (let i = 0; i < seq.length; i++) {
      run = warmupRun(seq[i], run);
      if (run >= RUN) return i;
    }
    return -1;
  };

  // The measured boot of this game: shader compilation and first uploads, then
  // a clean cadence. Recording any of those four would hold the readout amber
  // for a full second after the game is already perfect, because fps and drops
  // are both windowed over the trailing second.
  const boot = [75.5, 17, 50, 58, 8.7, 8.3, 8.3, 8.3];
  assert.equal(firstKept(boot), 6, 'all four boot frames are discarded');

  // Why a run and not a single frame: boot is bursty. That 17 ms frame at index
  // 1 is already inside budget, so a one-frame all-clear would start recording
  // there and let the 50 and 58 ms frames straight into the window.
  assert.equal(warmupRun(17, 0), 1, '17 ms misses no budget on its own...');
  assert.equal(warmupRun(50, 1), 0, '...but the 50 ms behind it resets the run');

  // A steady cadence needs exactly RUN frames, whatever the panel: a 50 Hz TV
  // never "warms up" indefinitely just because it cannot reach 60.
  assert.equal(firstKept([20, 20, 20, 20]), 2, 'a 50 Hz TV is warm in 3 frames');
  assert.equal(firstKept([8.3, 8.3, 8.3]), 2, 'and so is an already-warm loop');

  // A machine that never strings three together is not warming up, it is slow.
  // tick()'s WARMUP_MAX backstop is what stops hiding that; here it just never
  // resolves on its own.
  assert.equal(firstKept(new Array(40).fill(200)), -1);
});

test('budgetsMissed counts missed budgets, not fractions of one', async () => {
  const { budgetsMissed, BUDGET_MS } = await import(MOD);
  const B = BUDGET_MS;

  assert.equal(budgetsMissed(B), 0);
  assert.equal(budgetsMissed(16.9), 0, 'jitter inside one budget is not a drop');
  assert.equal(budgetsMissed(2 * B), 1);
  assert.equal(budgetsMissed(3 * B), 2);
  // A present lands ON a vsync, so 25 ms is one slipped frame reported late,
  // not "1.5 frames" floored away to zero.
  assert.equal(budgetsMissed(25), 1);
  // Anything at or above the bar is free: on a 144 Hz panel a 6.9 ms frame must
  // not read as a fraction of a drop, and on a 120 Hz one 8.3 ms is simply fine.
  assert.equal(budgetsMissed(1000 / 144), 0);
  assert.equal(budgetsMissed(1000 / 120), 0);
  assert.equal(budgetsMissed(4), 0, 'never negative');
  assert.equal(budgetsMissed(0), 0);
  assert.equal(budgetsMissed(16, 0), 0, 'no budget = nothing to have missed');
});
