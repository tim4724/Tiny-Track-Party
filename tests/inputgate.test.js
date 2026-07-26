'use strict';
// The CONTROL send gate (public/controller/InputGate.js). The gate decides which
// of the 25 Hz samples reach the wire, so its failure modes are asymmetric: over-
// sending only costs bandwidth, while over-FILTERING leaves the display steering
// a car on stale input. The property test at the bottom is the one that matters —
// it pins the guarantee (divergence bounded by the threshold, staleness by the
// idle timeout) rather than any particular rule.
const test = require('node:test');
const assert = require('node:assert/strict');

let InputGate, DEFAULT_STEER_THRESHOLD, SHADOW_THRESHOLDS;
test.before(async () => {
  ({ InputGate, DEFAULT_STEER_THRESHOLD, SHADOW_THRESHOLDS } =
    await import('../public/controller/InputGate.js'));
});

const TICK = 40; // the controller's 25 Hz sample period
const sample = (s, b = 0, u = 0) => ({ s, b, u });

// Drive the gate the way ControllerNet does: decide, and on a send record it as
// transmitted and (unless told otherwise) confirmed by the display.
function feed(gate, samples, { startAt = 0, srtt = 0, ack = true } = {}) {
  const out = [];
  let t = startAt;
  for (const smp of samples) {
    const why = gate.decide(smp, t, srtt);
    if (why) {
      gate.markSent(smp, t);
      if (ack) gate.markAcked(smp);
    }
    out.push({ t, why, smp });
    t += TICK;
  }
  return out;
}

test('first sample always sends — nothing is confirmed yet', () => {
  const gate = new InputGate();
  const [first] = feed(gate, [sample(0)]);
  assert.equal(first.why, 'change');
});

test('an identical sample is filtered (the display already holds it)', () => {
  const gate = new InputGate();
  const seq = feed(gate, [sample(0.5), sample(0.5), sample(0.5)]);
  assert.deepEqual(seq.map((r) => r.why), ['change', null, null]);
  assert.equal(gate.stats().sent, 1);
});

test('sub-threshold drift is filtered; crossing the threshold sends', () => {
  const gate = new InputGate({ steerThreshold: 0.03 });
  // +0.01 per tick: ticks 1 and 2 stay inside the threshold, tick 3 crosses it.
  const seq = feed(gate, [sample(0), sample(0.01), sample(0.02), sample(0.03)]);
  assert.deepEqual(seq.map((r) => r.why), ['change', null, null, 'change']);
});

test('a fast flick sends on the very next sample (no added latency)', () => {
  const gate = new InputGate({ steerThreshold: 0.03 });
  const seq = feed(gate, [sample(0), sample(0.9)]);
  assert.equal(seq[1].why, 'change');
  assert.equal(seq[1].t, TICK, 'sent on the next 40 ms tick, not deferred');
});

test('brake and the use-counter are never filtered, however small the steer delta', () => {
  const gate = new InputGate({ steerThreshold: 0.5 }); // absurdly coarse on purpose
  const seq = feed(gate, [sample(0, 0, 0), sample(0, 1, 0), sample(0, 1, 1), sample(0, 1, 1)]);
  assert.deepEqual(seq.map((r) => r.why), ['change', 'change', 'change', null]);
});

test('static input still transmits within the idle timeout', () => {
  const gate = new InputGate({ idleMs: 500 });
  // 20 identical samples = 800 ms, so the idle bound must fire at least once.
  const seq = feed(gate, Array.from({ length: 20 }, () => sample(0.25)));
  const idles = seq.filter((r) => r.why === 'idle');
  assert.ok(idles.length >= 1, 'idle timeout must bound staleness');
  const gap = idles[0].t - seq[0].t;
  assert.ok(gap >= 500 && gap < 500 + TICK, `first idle send at ${gap}ms, expected ~500ms`);
});

test('gates against last-ACKED, not last-sent: an unconfirmed value keeps being retried', () => {
  // The two only diverge when a send goes unconfirmed. Send 0.5 and never ack
  // it, then hold 0.52 — inside the threshold of what was SENT, so a sender that
  // gated on its own transmissions would fall permanently silent while the
  // display is holding nothing at all. Gating on acks must keep retrying.
  const gate = new InputGate({ steerThreshold: 0.03, minResendMs: 50, idleMs: 10_000 });
  gate.decide(sample(0.5), 0, 0);
  gate.markSent(sample(0.5), 0);            // deliberately never acked

  let sends = 0;
  for (let i = 1; i <= 20; i++) {
    const t = i * TICK;
    if (gate.decide(sample(0.52), t, 0)) { sends++; gate.markSent(sample(0.52), t); }
  }
  // 800 ms at a 50 ms cadence is a steady retry (~every other 40 ms sample),
  // and emphatically not the silence last-sent gating would produce.
  assert.ok(sends >= 8, `expected steady retries, got ${sends} sends in 800ms`);
});

test('an unacked sample is re-sent on the resend cadence, carrying the CURRENT value', () => {
  const gate = new InputGate({ steerThreshold: 0.03, minResendMs: 50, idleMs: 10_000 });
  gate.decide(sample(0.5), 0, 0);
  gate.markSent(sample(0.5), 0);
  gate.markAcked(sample(0.5));              // confirmed, so 'change' can't fire below
  // Now send something new and lose the ack for it.
  gate.decide(sample(0.9), 100, 0);
  gate.markSent(sample(0.9), 100);
  // Same value again 40 ms later: too soon to resend.
  assert.equal(gate.decide(sample(0.9), 140, 0), null);
  // Past the resend cadence: goes out again, as a fresh send of the current value.
  assert.equal(gate.decide(sample(0.9), 160, 0), 'resend');
});

test('the resend cadence follows RTT — never resend before an ack could arrive', () => {
  const gate = new InputGate({ minResendMs: 50, idleMs: 10_000 });
  gate.decide(sample(0.5), 0, 0);
  gate.markSent(sample(0.5), 0);
  // srtt 200 ms → 1.5x = 300 ms, so a 100 ms-old send is NOT yet due.
  assert.equal(gate.decide(sample(0.5), 100, 200), null);
  assert.equal(gate.decide(sample(0.5), 320, 200), 'resend');
});

test('reset() drops confirmed state so the next sample re-establishes ground truth', () => {
  const gate = new InputGate();
  feed(gate, [sample(0.5), sample(0.5)]);
  gate.reset();
  assert.equal(gate.decide(sample(0.5), 1000, 0), 'change',
    'after a transport reset the display state is unknowable — assume it knows nothing');
});

test('shadow counters cover every candidate threshold and are monotonic', () => {
  const gate = new InputGate({ steerThreshold: 0.03 });
  // A noisy hold: ±0.02 wobble, the shape real sensor jitter takes.
  const samples = Array.from({ length: 200 }, (_, i) => sample(0.4 + (i % 2 ? 0.02 : -0.02)));
  feed(gate, samples);
  const { shadows } = gate.stats();
  assert.equal(shadows.length, SHADOW_THRESHOLDS.length);
  // A coarser threshold can never send more than a finer one.
  for (let i = 1; i < shadows.length; i++) {
    assert.ok(shadows[i].sent <= shadows[i - 1].sent,
      `threshold ${shadows[i].threshold} sent ${shadows[i].sent}, more than ${shadows[i - 1].threshold}`);
  }
  // This wobble (0.04 peak-to-peak) is exactly what a 0.03 gate should NOT absorb
  // and a 0.05 gate should — the case the whole threshold derivation turns on.
  const at3 = shadows.find((s) => s.threshold === 0.03);
  const at5 = shadows.find((s) => s.threshold === 0.05);
  assert.ok(at3.suppressedPct < 10, `0.03 should pass jitter this size (got ${at3.suppressedPct}%)`);
  assert.ok(at5.suppressedPct > 90, `0.05 should absorb it (got ${at5.suppressedPct}%)`);
});

test('the lossless shadow (threshold 0) only ever filters exact repeats', () => {
  const gate = new InputGate();
  const samples = [sample(0.1), sample(0.1), sample(0.100001), sample(0.1)];
  feed(gate, samples);
  const zero = gate.stats().shadows.find((s) => s.threshold === 0);
  // sample 2 is an exact repeat (filtered); 3 differs and 4 differs from 3.
  assert.equal(zero.sent, 3);
});

// --- the guarantee -----------------------------------------------------------

test('PROPERTY: divergence stays within the threshold and staleness within the timeout', () => {
  const THRESH = 0.03, IDLE = 500;
  // Deterministic pseudo-random walk — mixes slow drifts (the case the gate is
  // allowed to delay) with flicks (the case it must never delay).
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const gate = new InputGate({ steerThreshold: THRESH, idleMs: IDLE });
  let s = 0, displayHolds = null, lastChangeAt = 0, t = 0;
  let worstErr = 0, worstStale = 0;

  for (let i = 0; i < 5000; i++) {
    // 3% of ticks are a flick, the rest a slow drift.
    s = rnd() < 0.03 ? rnd() * 2 - 1 : Math.max(-1, Math.min(1, s + (rnd() - 0.5) * 0.02));
    const smp = sample(+s.toFixed(3));

    const changedFromDisplay = displayHolds == null || Math.abs(smp.s - displayHolds) > 1e-9;
    if (changedFromDisplay) lastChangeAt = Math.min(lastChangeAt || t, t);

    const why = gate.decide(smp, t, 30);
    if (why) {
      gate.markSent(smp, t);
      gate.markAcked(smp);       // healthy link: confirmed immediately
      displayHolds = smp.s;
      lastChangeAt = 0;
    }
    if (displayHolds != null) {
      worstErr = Math.max(worstErr, Math.abs(smp.s - displayHolds));
      if (lastChangeAt) worstStale = Math.max(worstStale, t - lastChangeAt);
    }
    t += TICK;
  }

  // Bounded by the threshold plus one sample of drift (a value may cross the
  // threshold between ticks and is sent on the next one).
  assert.ok(worstErr <= THRESH + 0.02,
    `display diverged by ${worstErr.toFixed(4)}, expected <= ${(THRESH + 0.02).toFixed(4)}`);
  assert.ok(worstStale <= IDLE + TICK,
    `stale for ${worstStale}ms, expected <= ${IDLE + TICK}ms`);
  // And it must actually be doing something, or the bounds are trivially met.
  const st = gate.stats();
  assert.ok(st.sent < st.produced, 'gate suppressed nothing — bounds are meaningless');
});

test('default threshold matches the documented sensor-noise derivation', () => {
  assert.equal(DEFAULT_STEER_THRESHOLD, 0.03);
  assert.ok(SHADOW_THRESHOLDS.includes(0), 'the lossless case must be measurable');
  assert.ok(SHADOW_THRESHOLDS.includes(DEFAULT_STEER_THRESHOLD));
});
