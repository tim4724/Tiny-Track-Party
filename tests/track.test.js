'use strict';
// Headless verification of the track geometry: the oval must close into a
// seamless loop, and the centerline must be a sane, monotonic ribbon.
const test = require('node:test');
const assert = require('node:assert/strict');

// TrackBuilder is an ES module importing 'three'; load it dynamically.
let buildTrack, OVAL;
test.before(async () => {
  const mod = await import('../public/display/TrackBuilder.js');
  buildTrack = mod.buildTrack;
  OVAL = mod.OVAL;
});

test('oval closes into a loop', () => {
  const t = buildTrack(OVAL);
  assert.ok(t.closed, `oval should close (gap=${t.gap.toFixed(3)})`);
  assert.ok(t.gap < 0.5, `closure gap too large: ${t.gap}`);
});

test('centerline is a non-trivial closed ribbon', () => {
  const t = buildTrack(OVAL);
  assert.ok(t.length > 30, `track length looks too short: ${t.length}`);
  assert.ok(t.centerline.samples.length > 40, 'too few centerline samples');
  // arclength strictly increasing
  const s = t.centerline.samples.map((p) => p.s);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1], 'arclength not monotonic');
});

test('sampleAt wraps and returns oriented frames', () => {
  const t = buildTrack(OVAL);
  const a = t.centerline.sampleAt(0);
  const b = t.centerline.sampleAt(t.length + 5); // wraps
  const c = t.centerline.sampleAt(5);
  assert.ok(Math.abs(b.pos.x - c.pos.x) < 1e-6 && Math.abs(b.pos.z - c.pos.z) < 1e-6, 'wrap mismatch');
  // tangent and lateral roughly perpendicular, both ~horizontal
  assert.ok(Math.abs(a.tangent.dot(a.lateral)) < 1e-3, 'tangent/lateral not perpendicular');
  assert.ok(Math.abs(a.tangent.y) < 0.2, 'flat track tangent should be ~horizontal');
});
