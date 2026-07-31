'use strict';
// Headless verification of the controller's tilt→steer mapping, with the focus on
// ORIENTATION ROBUSTNESS: the same physical "lean toward the right of the screen"
// gesture must steer right whether the UI is portrait, landscape, or upside-down.
// We feed raw DeviceOrientation samples (beta/gamma) through _onOrient and read the
// normalized steer out of _sensorSteer, faking screen.orientation.angle per case.
const test = require('node:test');
const assert = require('node:assert/strict');

// TiltInput is a browser ES module but is written to construct headlessly (window/
// document guards). Load it dynamically like the other suites.
let TiltInput;
test.before(async () => {
  ({ TiltInput } = await import('../public/controller/TiltInput.js'));
});

// _screenAngle reads the `screen` global; set/clear it around each case so the
// faked orientation can't leak between tests.
function withScreenAngle(angle, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'screen');
  const prev = globalThis.screen;
  globalThis.screen = { orientation: { angle } };
  try { return fn(); } finally {
    if (had) globalThis.screen = prev; else delete globalThis.screen;
  }
}

// Drive one orientation sample in, read the steer out. ROLL_LOCK is 30°, so a 15°
// effective roll lands at exactly ±0.5 — a clean fixture clear of the 0.06 deadzone.
function steerFor({ angle, beta, gamma }) {
  return withScreenAngle(angle, () => {
    const t = new TiltInput({});
    t._onOrient({ beta, gamma });
    return t._sensorSteer();
  });
}

const HALF = 0.5; // 15° / ROLL_LOCK(30°)
const EPS = 1e-9;

test('no reading yet → neutral steer', () => {
  const t = new TiltInput({});
  assert.equal(t._sensorSteer(), 0);
});

test('portrait (0°): a right roll (gamma>0) steers right, left steers left', () => {
  assert.ok(Math.abs(steerFor({ angle: 0, beta: 0, gamma: 15 }) - HALF) < EPS);
  assert.ok(Math.abs(steerFor({ angle: 0, beta: 0, gamma: -15 }) + HALF) < EPS);
});

test('portrait: pure pitch (beta) does NOT steer', () => {
  assert.ok(Math.abs(steerFor({ angle: 0, beta: 25, gamma: 0 })) < EPS);
  assert.ok(Math.abs(steerFor({ angle: 0, beta: -25, gamma: 0 })) < EPS);
});

test('landscape-primary (90°): the screen-right lean rides the pitch axis', () => {
  // Held in landscape-primary, "dip the screen's right edge" is a device pitch
  // (beta>0). It must steer right — and pure native roll (gamma) must NOT steer.
  assert.ok(Math.abs(steerFor({ angle: 90, beta: 15, gamma: 0 }) - HALF) < EPS);
  assert.ok(Math.abs(steerFor({ angle: 90, beta: -15, gamma: 0 }) + HALF) < EPS);
  assert.ok(Math.abs(steerFor({ angle: 90, beta: 0, gamma: 25 })) < EPS);
});

test('landscape-secondary (270°): pitch steers the opposite way to 90°', () => {
  assert.ok(Math.abs(steerFor({ angle: 270, beta: 15, gamma: 0 }) + HALF) < EPS);
  assert.ok(Math.abs(steerFor({ angle: 270, beta: -15, gamma: 0 }) - HALF) < EPS);
});

test('upside-down portrait (180°): roll steers the opposite way to 0°', () => {
  assert.ok(Math.abs(steerFor({ angle: 180, beta: 0, gamma: 15 }) + HALF) < EPS);
  assert.ok(Math.abs(steerFor({ angle: 180, beta: 0, gamma: -15 }) - HALF) < EPS);
});

test('legacy window.orientation (-90) is honoured when screen.orientation is absent', () => {
  const hadS = Object.prototype.hasOwnProperty.call(globalThis, 'screen');
  const prevS = globalThis.screen;
  const hadW = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prevW = globalThis.window;
  delete globalThis.screen; // force the fallback path
  // orientation -90 == 270 → landscape-secondary; addEventListener stub so the
  // constructor's _bindKeys (gated on `typeof window`) doesn't blow up.
  globalThis.window = { orientation: -90, addEventListener() {} };
  try {
    const t = new TiltInput({});
    t._onOrient({ beta: 15, gamma: 0 });
    assert.ok(Math.abs(t._sensorSteer() + HALF) < EPS);
  } finally {
    if (hadW) globalThis.window = prevW; else delete globalThis.window;
    if (hadS) globalThis.screen = prevS; else delete globalThis.screen;
  }
});

test('a full twist past the lock still clamps to ±1', () => {
  assert.equal(steerFor({ angle: 0, beta: 0, gamma: 75 }), 1);
  assert.equal(steerFor({ angle: 0, beta: 0, gamma: -75 }), -1);
});

// ---- the _tick output loop: deadzone, brake, the gated ACTION counter, stop() ----
// _tick is the per-frame producer of the {s,b,u} CONTROL frame. We call it directly
// (no real 25 Hz timer) and read the emitted control off an onControl capture.

test('_tick dead-zones a centred lean to zero, but full lock still re-expands to ±1', () => {
  withScreenAngle(0, () => {
    const out = [];
    const t = new TiltInput({ onControl: (c) => out.push(c) });
    t._onOrient({ beta: 0, gamma: 1 }); // ~0.03 normalized, inside the 0.06 dead-zone
    t._tick();
    assert.equal(out.at(-1).s, 0, 'a lean inside the dead-zone steers nothing');
    t._onOrient({ beta: 0, gamma: 75 }); // hard lock
    for (let i = 0; i < 12; i++) t._tick(); // SMOOTH=0.5 converges in a few ticks
    assert.equal(out.at(-1).s, 1, 'full lock LANDS on exactly 1 (the snap kills the EMA asymptote)');
    // ...and releasing to centre lands on exactly 0, for the same reason: the
    // rails must be values that actually occur, or the send gate's dead-band
    // leaves the display's steer bar stuck a few percent short.
    t._onOrient({ beta: 0, gamma: 0 });
    for (let i = 0; i < 12; i++) t._tick();
    assert.equal(out.at(-1).s, 0, 'released centre lands on exactly 0');
  });
});

test('_tick re-expands a mid lean past the dead-zone (lock maps linearly, no lost travel)', () => {
  withScreenAngle(0, () => {
    const out = [];
    const t = new TiltInput({ onControl: (c) => out.push(c) });
    t._onOrient({ beta: 0, gamma: 15 }); // raw sensor steer 0.5 (15°/30°)
    for (let i = 0; i < 20; i++) t._tick();
    const expected = (0.5 - 0.06) / (1 - 0.06); // 0.5, dead-zone removed and re-expanded
    assert.ok(Math.abs(out.at(-1).s - expected) < 0.01, `re-expanded steer ~${expected.toFixed(3)} (got ${out.at(-1).s})`);
  });
});

test('button steering ramps linearly to lock and releases at double speed', () => {
  const out = [];
  const t = new TiltInput({ onControl: (c) => out.push(c) });
  t.setScheme({ tilt: false });
  let ms = 0; t._now = () => ms; // the ramp is wall-clock based; drive time by hand
  t._tick(); // seed the ramp clock
  t.pressSteer(1, true);
  t._tick(); // the edge's own sample (headlessly the flush is a no-op, so tick by hand)
  assert.ok(Math.abs(out.at(-1).s - 16 / 200) < 0.001, `the press edge itself carries the head start, one wire step (got ${out.at(-1).s})`);
  for (let i = 0; i < 5; i++) { ms += 40; t._tick(); }
  assert.equal(out.at(-1).s, 1, 'head start + ~200 ms of beats LANDS exactly on 1 — the ramp has no asymptote');
  t.pressSteer(1, false);
  ms += 40; t._tick(); ms += 40; t._tick();
  assert.equal(out.at(-1).s, 0, 'released, the steer is back to exactly 0 within two beats (75 ms release)');
});

test('the on-screen BRAKE button feeds b through _tick and clears on release', () => {
  const out = [];
  const t = new TiltInput({ onControl: (c) => out.push(c) });
  t.pressBrake(true); t._tick();
  assert.equal(out.at(-1).b, 1, 'a held brake reports full BRAKE_LEVEL');
  t.pressBrake(false); t._tick();
  assert.equal(out.at(-1).b, 0, 'releasing the brake reports zero');
});

test('ACTION is gated by the held-item slot and bumps the use-counter once per press', () => {
  const out = [];
  const t = new TiltInput({ onControl: (c) => out.push(c) });
  t.pressAction(); t._tick();
  assert.equal(out.at(-1).u, 0, 'with no item, a press does not bump the counter (no ghost-fire)');
  t.setActionEnabled(true);
  t.pressAction(); t._tick();
  assert.equal(out.at(-1).u, 1, 'with an item, a press bumps the counter');
  t.pressAction(); t._tick();
  assert.equal(out.at(-1).u, 2, 'each press bumps exactly once');
});

test('the ACTION use-counter wraps at 256 (matches the display fire-on-change protocol)', () => {
  const t = new TiltInput({});
  t.setActionEnabled(true);
  for (let i = 0; i < 256; i++) t.pressAction();
  assert.equal(t._useCount, 0, 'the wrapping counter returns to 0 after 256 presses');
});

test('stop() resets brake + ACTION state so the next race cannot inherit a stale press', () => {
  const t = new TiltInput({});
  t.setActionEnabled(true);
  t.pressAction(); t.pressBrake(true);
  assert.ok(t._useCount > 0 && t._brakeBtn > 0, 'state is set mid-race');
  t.stop();
  assert.equal(t._useCount, 0, 'use-counter reset on stop');
  assert.equal(t._brakeBtn, 0, 'brake reset on stop');
  assert.equal(t._actKeyDown, false, 'held-key flag cleared on stop');
});
