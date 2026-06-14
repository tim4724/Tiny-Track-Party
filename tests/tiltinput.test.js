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
    if (hadS) {/* screen restored by withScreenAngle elsewhere */}
  }
});

test('a full twist past the lock still clamps to ±1', () => {
  assert.equal(steerFor({ angle: 0, beta: 0, gamma: 75 }), 1);
  assert.equal(steerFor({ angle: 0, beta: 0, gamma: -75 }), -1);
});
