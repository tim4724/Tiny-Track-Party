'use strict';
// The perf HUD's two pure decisions: what the display's refresh period IS, and
// how many vsyncs a frame missed. Everything else in PerfHud.js is DOM, GL and
// drawing, which this cannot reach — but these two are what every number the
// HUD prints is measured against, so a wrong answer here mislabels the whole
// readout (a 60 Hz TV reported as 30 Hz would show a comfortable frame as
// "50% budget, no drops" while the player watches it stutter).
//
// Importing the module is safe in Node: the class touches document/window only
// in its constructor, never at module scope.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(
    path.join(__dirname, '..', 'public/display/render/PerfHud.js')).href;

test('snapPeriod names the refresh rate a measured cadence belongs to', async () => {
  const { snapPeriod } = await import(MOD);
  const hz = (ms) => Math.round(1000 / snapPeriod(ms));

  // The common displays, at their exact periods and with real jitter on top.
  assert.equal(hz(1000 / 60), 60);
  assert.equal(hz(16.61), 60, 'a jittery 60 Hz frame is still 60 Hz');
  assert.equal(hz(17.2), 60);
  assert.equal(hz(1000 / 120), 120);
  assert.equal(hz(8.1), 120, 'headless Chrome ran at 8.1 ms and that is 120 Hz');
  assert.equal(hz(1000 / 144), 144);
  assert.equal(hz(1000 / 50), 50, 'a 50 Hz TV is a real thing in Europe');

  // 16.7 must resolve at k=1. If the k>1 pass ever ran first (or the loops were
  // nested the other way), a 60 Hz display would report a 120 Hz target and
  // every frame would look like a dropped one.
  assert.equal(hz(1000 / 60), 60);

  // A solidly GPU-bound run: every single frame takes two vsyncs, so the FASTEST
  // frame in the window is 33.3 ms and no refresh rate matches it directly. The
  // k=2 pass recovers the real display, which is what makes the drop count
  // truthful instead of the HUD quietly redefining 30 fps as the target.
  assert.equal(hz(1000 / 30), 60);
  assert.equal(hz(1000 / 40), 120, 'three vsyncs per frame on a 120 Hz panel');

  // Nothing plausible: report what was measured rather than inventing a target.
  // (An unthrottled context — headless with vsync off — lands here.)
  assert.equal(snapPeriod(7.4), 7.4);
  // Degenerate input must not poison the budget maths downstream.
  assert.equal(hz(0), 60);
  assert.equal(hz(-5), 60);
  assert.equal(hz(NaN), 60);
  assert.equal(hz(Infinity), 60);
});

test('vsyncDrops counts missed presents, not fractions of one', async () => {
  const { vsyncDrops } = await import(MOD);
  const P = 1000 / 60;

  assert.equal(vsyncDrops(P, P), 0);
  assert.equal(vsyncDrops(16.9, P), 0, 'jitter inside one period is not a drop');
  assert.equal(vsyncDrops(2 * P, P), 1);
  assert.equal(vsyncDrops(3 * P, P), 2);
  // A present lands ON a vsync, so 25 ms is one slipped frame reported late,
  // not "1.5 frames" floored away to zero.
  assert.equal(vsyncDrops(25, P), 1);
  // A frame FASTER than the period (the period estimate lagging a mode change)
  // must never report negative drops.
  assert.equal(vsyncDrops(4, P), 0);
  assert.equal(vsyncDrops(0, P), 0);
  assert.equal(vsyncDrops(16, 0), 0, 'no period yet = nothing to have missed');
});
