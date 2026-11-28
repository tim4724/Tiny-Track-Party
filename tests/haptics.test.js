'use strict';
// The controller's vibration motor (public/controller/Haptics.js).
//
// The motor is a SINGLE channel where every call cancels the last, so the bug
// this class exists to prevent is silent: a transient fired mid-brake leaves the
// rumble dead until its next renewal, and nothing in the UI shows it. These tests
// therefore assert on the exact vibrate() call SEQUENCE rather than on internal
// state — the sequence is the only thing the player can actually feel.
const test = require('node:test');
const assert = require('node:assert/strict');

let Haptics, EFFECTS, BRAKE_PATTERN, DRIFT_PATTERN, BRAKE_RENEW_MS, REARM_GAP_MS, airConsoleBackend, hapticChain;
let DriftFeel;
test.before(async () => {
  ({ Haptics, EFFECTS, BRAKE_PATTERN, DRIFT_PATTERN, BRAKE_RENEW_MS, REARM_GAP_MS, airConsoleBackend, hapticChain } =
    await import('../public/controller/Haptics.js'));
  ({ DriftFeel } = await import('../public/controller/driftFeel.js'));
});

// A deterministic stand-in for the browser: records every vibrate() argument and
// runs scheduled callbacks only when the clock is advanced past their due time.
// `play` is the optional primitive channel (the launcher / AirConsole); when
// given, its calls land in the same list as [primitive, scale] pairs.
function harness({ play = false } = {}) {
  const calls = [];
  let now = 0, next = 1;
  const timers = new Map();
  const h = new Haptics({
    vibrate: (p) => calls.push(p),
    play: play ? (primitive, scale) => calls.push([primitive, scale]) : undefined,
    schedule: (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    cancel: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    const end = now + ms;
    // Fire due timers in time order, letting a callback schedule its successor
    // (which is exactly how the renew loop sustains itself).
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { h, calls, advance, pending: () => timers.size };
}

test('a transient with no loop running is a single pulse and schedules nothing', () => {
  const { h, calls, advance, pending } = harness();
  h.tick('tap');
  assert.deepEqual(calls, [EFFECTS.tap.ms]);
  assert.equal(pending(), 0, 'no loop to restore — nothing to re-arm');
  advance(10_000);
  assert.deepEqual(calls, [EFFECTS.tap.ms], 'and it must not resurrect itself later');
});

test('a cue is named, never a raw duration — a typo fails loudly', () => {
  const { h } = harness();
  assert.throws(() => h.tick('tapp'), /no effect named/);
  assert.throws(() => h.tick(15), /no effect named/);
});

test('every effect has a primitive at a 0-1 scale and a vibrate fallback', () => {
  for (const [name, e] of Object.entries(EFFECTS)) {
    assert.match(e.primitive, /^[a-z_]+$/, `${name}: a contract §12 primitive name`);
    assert.ok(e.scale >= 0 && e.scale <= 1, `${name}: scale in 0-1`);
    const ms = Array.isArray(e.ms) ? e.ms : [e.ms];
    assert.ok(ms.every((v) => Number.isInteger(v) && v >= 0) && ms.some((v) => v > 0), `${name}: a vibrate pattern with some motor time`);
  }
});

test('the brake loop renews itself before the pattern runs out', () => {
  const { h, calls, advance } = harness();
  h.startLoop();
  assert.deepEqual(calls, [BRAKE_PATTERN]);
  advance(BRAKE_RENEW_MS * 3 + 1);
  assert.equal(calls.length, 4, 'one initial play plus one renewal per period');
  assert.ok(calls.every((c) => c === BRAKE_PATTERN));
});

test('starting a running loop again is a no-op (a repeated press cannot stack renewals)', () => {
  const { h, calls, advance } = harness();
  h.startLoop();
  h.startLoop();
  h.startLoop();
  assert.equal(calls.length, 1);
  advance(BRAKE_RENEW_MS + 1);
  assert.equal(calls.length, 2, 'exactly one renewal, not three');
});

test('another loop replaces a running one at once and renews as itself (a drift ending in a brake)', () => {
  const { h, calls, advance } = harness();
  h.startLoop(DRIFT_PATTERN);
  h.startLoop(DRIFT_PATTERN);
  h.startLoop(BRAKE_PATTERN);
  assert.deepEqual(calls, [DRIFT_PATTERN, BRAKE_PATTERN], 'the same pattern is a no-op, another one plays now');
  advance(BRAKE_RENEW_MS + 1);
  assert.deepEqual(calls.slice(2), [BRAKE_PATTERN], 'and only the new one renews');
});

test('the drift rumble is slower and heavier than the brake\'s, and outlasts the renewal', () => {
  const on = (p) => p.filter((_, i) => i % 2 === 0);
  const sum = (p) => p.reduce((a, b) => a + b, 0);
  assert.ok(Math.min(...on(DRIFT_PATTERN)) > Math.max(...on(BRAKE_PATTERN)), 'longer pulses');
  assert.ok(on(DRIFT_PATTERN).length / sum(DRIFT_PATTERN) < on(BRAKE_PATTERN).length / sum(BRAKE_PATTERN),
    'fewer of them a second');
  assert.ok(sum(DRIFT_PATTERN) > BRAKE_RENEW_MS, 'no gap before the renewal');
  assert.ok(hapticChain(DRIFT_PATTERN).every((s) => s.primitive === 'click'), 'a firmer tick on a primitive backend');
  assert.ok(hapticChain(BRAKE_PATTERN).every((s) => s.primitive === 'low_tick'), 'the brake keeps its light one');
});

// driftFeel.js: the sim's slide rule (game.cc) on the phone's own steer and button.
test('a held button rumbles drift only while the steer slides the car, as the sim rules', () => {
  const f = new DriftFeel();
  assert.equal(f.step(false, 1), null, 'nothing held, no rumble');
  assert.equal(f.step(true, 0.1), 'brake', 'a straight press brakes');
  assert.equal(f.step(true, 0.6), 'drift', '…and steering past the start slides, on the same press');
  assert.equal(f.step(true, 0.3), 'drift', 'easing off keeps the slide');
  assert.equal(f.step(true, 0.1), 'brake', 'straightening up ends it in a brake');
  assert.equal(f.step(true, 0.9), 'brake', 'and no slide again until a fresh press');
  assert.equal(f.step(false, 0.9), null);
  assert.equal(f.step(true, -0.7), 'drift', 'a fresh press with a steer slides, either way');
});

test('stopLoop kills the motor immediately and stops renewing', () => {
  const { h, calls, advance, pending } = harness();
  h.startLoop();
  h.stopLoop();
  assert.deepEqual(calls, [BRAKE_PATTERN, 0], 'vibrate(0) cancels the pattern still playing out');
  assert.equal(pending(), 0);
  advance(10_000);
  assert.equal(calls.length, 2);
});

test('stopLoop with no loop running does not fire a stray vibrate(0)', () => {
  const { h, calls } = harness();
  h.stopLoop();
  assert.deepEqual(calls, []);
});

// --- the bug this module exists to fix ---------------------------------------

test('THE FIX: a transient during the brake rumble restores it, not silences it', () => {
  // Before the arbiter, an item-pickup buzz mid-brake replaced the running
  // pattern and left the motor dead until the next 1.5 s renewal.
  const { h, calls, advance } = harness();
  h.startLoop();
  h.tick('item');
  assert.deepEqual(calls, [BRAKE_PATTERN, EFFECTS.item.ms]);

  // The rumble comes back as soon as the pulse has finished — NOT a renewal
  // period later.
  advance(EFFECTS.item.ms + REARM_GAP_MS);
  assert.deepEqual(calls, [BRAKE_PATTERN, EFFECTS.item.ms, BRAKE_PATTERN]);

  // ...and the renew loop is running again off the new play, so the rumble is
  // sustained rather than trailing off after this one pattern.
  advance(BRAKE_RENEW_MS);
  assert.equal(calls.length, 4);
});

test('the restore gap is bounded by the transient, so a long pattern is not truncated', () => {
  const { h, calls, advance } = harness();
  h.startLoop();
  h.tick('go');                         // the GO countdown pulse: 90 ms of motor
  assert.deepEqual(EFFECTS.go.ms, [0, 90]);
  advance(89);
  assert.equal(calls.length, 2, 'must not re-arm while the transient is still playing');
  advance(1 + REARM_GAP_MS);
  assert.equal(calls.length, 3);
});

test('a transient after stopLoop does not resurrect the rumble', () => {
  // Race end: stopDriving() stops the loop, then a results-screen tap buzzes.
  const { h, calls, advance } = harness();
  h.startLoop();
  h.stopLoop();
  h.tick('tap');
  advance(10_000);
  assert.deepEqual(calls, [BRAKE_PATTERN, 0, EFFECTS.tap.ms], 'the tap is the last thing the motor does');
});

test('stopping between a transient and its re-arm leaves the motor silent', () => {
  // The race can end inside the ~30 ms restore window; the pending re-arm must
  // notice the loop is gone rather than starting a rumble nothing will stop.
  const { h, calls, advance } = harness();
  h.startLoop();
  h.tick('count');
  h.stopLoop();
  advance(10_000);
  assert.deepEqual(calls, [BRAKE_PATTERN, EFFECTS.count.ms, 0]);
});

// --- the primitive channel (Paper Balloon launcher §12, AirConsole composition) ---

test('with a primitive channel, transients play as [primitive, scale] and the loop still rides vibrate', () => {
  const { h, calls, advance } = harness({ play: true });
  h.tick('tap');
  assert.deepEqual(calls, [['click', 0.7]], 'the tap is a primitive, not a duration');
  h.startLoop();
  h.tick('go');
  assert.deepEqual(calls, [['click', 0.7], BRAKE_PATTERN, ['thud', 1]]);
  // The motor is held for the effect's `ms` — the same clock as the web — then
  // the rumble resumes.
  advance(90 + REARM_GAP_MS);
  assert.deepEqual(calls.at(-1), BRAKE_PATTERN);
});

test('the AirConsole backend plays a transient as a one-entry composition', () => {
  const sent = [];
  const VIBRATE = { TYPE: { COMPOSITION: 'composition' }, PRIMITIVE: { CLICK: 'primitiveClick', THUD: 'primitiveThud', LOW_TICK: 'primitiveLowTick' } };
  const b = airConsoleBackend({ vibrate: (o) => sent.push(o) }, VIBRATE);
  b.play('click', 0.7);
  b.play('thud', 1);
  assert.deepEqual(sent, [
    { type: 'composition', value: [{ primitive: 'primitiveClick', scale: 0.7, delay: 0 }] },
    { type: 'composition', value: [{ primitive: 'primitiveThud', scale: 1, delay: 0 }] },
  ]);
});

test('the AirConsole backend turns the brake pattern into a chain of low ticks on the pattern\'s own timing', () => {
  const sent = [];
  const VIBRATE = { TYPE: { COMPOSITION: 'composition' }, PRIMITIVE: { LOW_TICK: 'primitiveLowTick' } };
  const b = airConsoleBackend({ vibrate: (o) => sent.push(o) }, VIBRATE);
  b.vibrate([12, 60, 12, 60, 12]);
  assert.deepEqual(sent, [{ type: 'composition', value: [
    { primitive: 'primitiveLowTick', scale: 1, delay: 0 },
    { primitive: 'primitiveLowTick', scale: 1, delay: 60 },   // the tick IS the 12 ms on; the 60 ms off is the delay
    { primitive: 'primitiveLowTick', scale: 1, delay: 60 },
  ] }]);
  // The real rumble: one tick per on-segment, so 25 entries 60 ms apart.
  sent.length = 0;
  b.vibrate(BRAKE_PATTERN);
  assert.equal(sent[0].value.length, 25);
  assert.ok(sent[0].value.slice(1).every((e) => e.delay === 60));
  // A bare duration is one tick.
  sent.length = 0;
  b.vibrate(15);
  assert.equal(sent[0].value.length, 1);
});

test('hapticChain is the launcher\'s §12 sequence: contract names, the cancel call an empty sequence', () => {
  // The Paper Balloon launcher takes the chain as is (hapticComposition), and an empty
  // sequence is its stop — which is what a vibrate(0) must become there.
  assert.deepEqual(hapticChain([12, 60, 12]), [
    { primitive: 'low_tick', scale: 1, delay: 0 },
    { primitive: 'low_tick', scale: 1, delay: 60 },
  ]);
  assert.deepEqual(hapticChain(0), []);
  assert.equal(hapticChain(BRAKE_PATTERN).length, 25, 'within the launcher\'s 32-step cap');
});

test('the AirConsole backend has no cancel, so vibrate(0) replaces the chain with the faintest tick', () => {
  const sent = [];
  const VIBRATE = { TYPE: { COMPOSITION: 'composition' }, PRIMITIVE: { LOW_TICK: 'primitiveLowTick' } };
  const b = airConsoleBackend({ vibrate: (o) => sent.push(o) }, VIBRATE);
  b.vibrate(0);
  assert.deepEqual(sent, [{ type: 'composition', value: [{ primitive: 'primitiveLowTick', scale: 0, delay: 0 }] }]);
});

test('the default vibrate is safe to construct and call without a browser', () => {
  // main.js constructs Haptics at module scope; under Node (and any browser
  // without the API) it must degrade to nothing rather than throw.
  const h = new Haptics();
  assert.doesNotThrow(() => { h.tick('tap'); });
});
