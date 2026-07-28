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

let Haptics, BRAKE_PATTERN, BRAKE_OPENING, BRAKE_RENEW_MS, REARM_GAP_MS;
test.before(async () => {
  ({ Haptics, BRAKE_PATTERN, BRAKE_OPENING, BRAKE_RENEW_MS, REARM_GAP_MS } =
    await import('../public/controller/Haptics.js'));
});

// A deterministic stand-in for the browser: records every vibrate() argument and
// runs scheduled callbacks only when the clock is advanced past their due time.
function harness() {
  const calls = [];
  let now = 0, next = 1;
  const timers = new Map();
  const h = new Haptics({
    vibrate: (p) => calls.push(p),
    schedule: (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    cancel: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    const end = now + ms;
    // Fire due timers in time order, letting a callback schedule its successor
    // (which is exactly how the renew loop sustains itself).
    for (;;) {
      let due = null;
      for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
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
  h.tick(15);
  assert.deepEqual(calls, [15]);
  assert.equal(pending(), 0, 'no loop to restore — nothing to re-arm');
  advance(10_000);
  assert.deepEqual(calls, [15], 'and it must not resurrect itself later');
});

test('the brake loop renews itself before the pattern runs out', () => {
  const { h, calls, advance } = harness();
  h.startLoop();
  assert.deepEqual(calls, [BRAKE_OPENING]);
  advance(BRAKE_RENEW_MS * 3 + 1);
  assert.equal(calls.length, 4, 'one initial play plus one renewal per period');
  assert.ok(calls.slice(1).every((c) => c === BRAKE_PATTERN));
});

test('the lead-in plays ONCE — a long hold must not thump every renewal', () => {
  // The rumble opens with a solid pulse because a duty-cycled hum takes several
  // cycles to spin the motor up and so feels late (see BRAKE_OPENING). That pulse
  // belongs to the START of the brake: replaying it on every renewal would put a
  // knock into the middle of a held brake once every BRAKE_RENEW_MS.
  const { h, calls, advance } = harness();
  h.startLoop();
  advance(BRAKE_RENEW_MS * 4 + 1);
  assert.equal(calls.filter((c) => c === BRAKE_OPENING).length, 1, 'exactly one lead-in, at the press');
  assert.ok(calls.length > 1, 'and the loop really did renew');
});

test('a transient restores the loop with the BODY, not another lead-in', () => {
  // Same rule mid-brake: an item buzz over the rumble hands back to the hum. A
  // lead-in here would read as a second brake press the player never made.
  const { h, calls, advance } = harness();
  h.startLoop();
  h.tick(20);
  advance(20 + REARM_GAP_MS);
  assert.deepEqual(calls, [BRAKE_OPENING, 20, BRAKE_PATTERN]);
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

test('stopLoop kills the motor immediately and stops renewing', () => {
  const { h, calls, advance, pending } = harness();
  h.startLoop();
  h.stopLoop();
  assert.deepEqual(calls, [BRAKE_OPENING, 0], 'vibrate(0) cancels the pattern still playing out');
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
  h.tick(20);
  assert.deepEqual(calls, [BRAKE_OPENING, 20]);

  // The rumble comes back as soon as the pulse has finished — NOT a renewal
  // period later.
  advance(20 + REARM_GAP_MS);
  assert.deepEqual(calls, [BRAKE_OPENING, 20, BRAKE_PATTERN]);

  // ...and the renew loop is running again off the new play, so the rumble is
  // sustained rather than trailing off after this one pattern.
  advance(BRAKE_RENEW_MS);
  assert.equal(calls.length, 4);
});

test('the restore gap is bounded by the transient, so a long pattern is not truncated', () => {
  const { h, calls, advance } = harness();
  h.startLoop();
  h.tick([0, 90]);                      // the GO countdown pulse: 90 ms of motor
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
  h.tick(15);
  advance(10_000);
  assert.deepEqual(calls, [BRAKE_OPENING, 0, 15], 'the tap is the last thing the motor does');
});

test('stopping between a transient and its re-arm leaves the motor silent', () => {
  // The race can end inside the ~30 ms restore window; the pending re-arm must
  // notice the loop is gone rather than starting a rumble nothing will stop.
  const { h, calls, advance } = harness();
  h.startLoop();
  h.tick(20);
  h.stopLoop();
  advance(10_000);
  assert.deepEqual(calls, [BRAKE_OPENING, 20, 0]);
});

test('the default vibrate is safe to construct and call without a browser', () => {
  // main.js constructs Haptics at module scope; under Node (and any browser
  // without the API) it must degrade to nothing rather than throw.
  const h = new Haptics();
  assert.doesNotThrow(() => { h.tick(15); });
});
