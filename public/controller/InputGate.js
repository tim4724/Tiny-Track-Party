// InputGate — decides which control samples actually reach the wire.
//
// CONTROL is absolute state ({s,b,u}) resampled on every sensor event and input
// edge (25 Hz interval as the idle fallback), not a stream of discrete events.
// The display applies inputs on arrival straight into the sim's
// car fields and only steps physics from rAF, so it HOLDS the last value it was
// given until a new one replaces it. That means a sample identical (or near
// identical) to what the display already holds is a no-op on the wire: sending it
// changes nothing anyone can observe.
//
// So instead of "transmit every sample", the rule is SEND UNTIL CONFIRMED,
// PACED BY URGENCY:
//
//   1. sample matches what the display confirmed  → skip, unless idleMs elapsed
//   2. it differs (u or b at all, or |Δs| >= steerThreshold) → send, paced:
//      STRONG news (u or b changed, or |Δs| >= strongThreshold — a deliberate
//      action, not drift) goes as soon as sendMinIntervalMs has passed since
//      the last send; sub-strong news rides the sendIntervalMs baseline cadence
//   3. ...except when an equivalent value is already IN FLIGHT and the resend
//      cadence hasn't elapsed → skip and let the ack arrive
//
// Deferral is lossless: CONTROL is absolute latest-wins state, so a send that
// waits out its window carries whatever is freshest when the window opens —
// the sensor events keep re-offering the current sample until it goes.
//
// Note what falls out of rule 2: because the comparison is against the last
// ACKED sample, an unconfirmed value keeps differing and so keeps being sent, all
// by itself. "Resend until acknowledged" needs no rule of its own — it is what
// gating on acknowledgement already means. The resend cadence therefore exists to
// THROTTLE that (rule 3), not to drive it: without it, a value in flight would be
// re-sent on every sample, and on a 100 ms link that is many copies where one
// would do — burning exactly the bandwidth this gate exists to save.
//
// Rule 3 overlaps the kit's own loss recovery, deliberately. PartyFastlane keeps
// retransmitting the ring every TICK_MS (50 ms) until the ack lands, so on a
// healthy link the two never both fire: half-RTT there runs ~15-30 ms, the value
// is confirmed well inside a sample interval, and neither retransmit is reached.
// They only meet on a link sick enough that a duplicate is the least of it. The
// gate's copy is worth keeping as the backstop because the kit's stops at TTL_MS
// (300 ms) — past that the ring is empty and nothing but rule 3 would ever tell
// the display again.
//
// Every comparison is against the LAST ACKNOWLEDGED sample, never the last sent
// one. If a send was lost, "last sent" is a value the display never saw, and
// gating against it would leave the display stale with the sender believing
// otherwise. Only an ack reveals what the display actually holds. Because the ack
// lags by one RTT, the comparison is against a slightly old state, which makes the
// gate keener to send — the safe direction.
//
// A rule-3 resend is a fresh SEND, not a retransmit. The receiver identifies an event by
// its seq (`es > lastAppliedEs`), so re-sending a newer payload under an already
// delivered seq would have it discarded as a duplicate — the transport would
// silently throw away the fresher value, and only when the network was healthy
// enough to deliver both. Re-sending means "enqueue the current sample again".
//
// GUARANTEE, and the thing the tests pin: a strong change reaches the wire
// within sendMinIntervalMs of the previous send (a flick's first packet is
// only ever behind the hard floor, never a cadence); an unsent sub-strong
// divergence never outlives sendIntervalMs; staleness of confirmed state is
// bounded by idleMs; and none of it compounds. In the other direction the rate
// is bounded too: every tier's wait is at least sendMinIntervalMs (resend
// floors at minResendMs, idle at idleMs, both larger), so no two sends are
// ever closer than the floor and the wire rate is PROVABLY at most
// 1000/sendMinIntervalMs messages a second — sized to the strictest platform
// message budget in sight (AirConsole allows 25/s).
//
// Dependency-free so the Node tests can import it directly (see CLAUDE.md).

// Steering deltas below this are treated as "the display already knows".
// Derived from the SENSOR NOISE FLOOR, not from what feels like a meaningful
// turn: raw DeviceOrientation twitches 1-2 degrees held still, which over
// TiltInput's ROLL_LOCK of 30 degrees is 0.033-0.066 of s, roughly halved by its
// one-pole SMOOTH — so ~0.02-0.03 of wobble survives on a phone that is not
// moving. A threshold under that never engages; the gate would pass every sample
// and do nothing. Sized at |s| -> 1 where the display's STEER_EXPO gain peaks at
// 1.25, so the worst-case visible error stays under 0.0375 of steer authority
// (near centre the expo's ~0.70 gain suppresses it further). For scale, the
// controller already discards +/-0.06 around centre as DEADZONE.
//
// That paragraph is arithmetic over numbers owned by two OTHER files, so it is
// no longer only a paragraph: ROLL_LOCK/SMOOTH/STEER_EXPO and this threshold all
// live in the shared steering contract (shared/protocol.js STEER), and the two
// figures below are the derivation's own inputs. tests/config-drift.test.js
// re-runs both bounds against the manifest, so tuning STEER_EXPO in the C++ sim
// or ROLL_LOCK on the phone fails here instead of silently invalidating this.
//
// What none of that derivation can tell you is how much of a REAL stream this
// suppresses: sensor jitter, how twitchy a given person is and how much of a lap
// is spent holding a line all move it, so that number has to be read off an
// actual party rather than a simulated input walk — which is what the retired
// on-phone overlay and its per-threshold shadow counters were for. The whole
// rig — NetStats.js, this file's shadow counters and `stats()`, and the
// ?netstats wiring in controller main.js — is revivable from one commit:
// `git show 39fe3599` has all of it.
export const DEFAULT_STEER_THRESHOLD = 0.03;

// A steer delta at or past this is a deliberate action rather than drift: 5x
// the noise gate and past the DEADZONE re-expansion scale (0.06), yet small
// enough that any real turn crosses it within a sample or two of starting.
// Strong news may interrupt the baseline cadence; it waits only the hard send
// floor. Must sit above the noise gate or every change is "strong" and the
// baseline tier is dead — config-drift pins the ordering.
export const DEFAULT_STRONG_THRESHOLD = 0.15;

// Baseline cadence for sub-strong news: how long an unconfirmed sub-strong
// steering change may wait before it must reach the wire.
export const DEFAULT_SEND_INTERVAL_MS = 100;

// Hard floor between ANY two sends — the rate cap. Every tier waits at least
// this long since the last send, which is what makes the <= 25 msgs/s bound
// provable rather than statistical (AirConsole's platform budget).
export const DEFAULT_SEND_MIN_INTERVAL_MS = 40;

// The FLOOR of the measured idle twitch (the "1-2 degrees" above). The floor, not
// the ceiling: a threshold under the QUIETEST phone's surviving wobble never
// engages at all, so that is the bound worth pinning.
export const SENSOR_NOISE_FLOOR_DEG = 1;
// ...and the ceiling on the other side: the most steer authority the gate is
// allowed to hide, measured at the gain STEER_EXPO peaks at.
export const STEER_ERROR_BUDGET = 0.0375;

// Staleness bound: the longest a sub-threshold change can wait. Matches the kit's
// IDLE_MS so a gated stream degrades into exactly the heartbeat cadence the
// fastlane already emits when idle, rather than inventing a second timer.
export const DEFAULT_IDLE_MS = 500;

// Floor for the unacked-resend cadence. The real interval is derived from live
// RTT: resending sooner than an ack could physically arrive burns a duplicate on
// every single sample.
export const DEFAULT_MIN_RESEND_MS = 50;
export const RESEND_RTT_FACTOR = 1.5;

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

// The three steer values with a face: full lock either way, and dead centre.
// They are terminal (a held flick or a released stick rests ON one), and the
// display renders them as 100%/0%, so "off by under the threshold" is visible
// there in a way it is nowhere else on the range — the bar reads 97% while the
// stick is pinned. A rail therefore always differs from a non-rail acked value
// and is always urgent; being terminal, it cannot chatter — once acked, the
// ordinary rules hold it silent.
const isRail = (s) => s === 1 || s === -1 || s === 0;

// True when `a` differs from `b` enough that the display needs telling.
// `u` and `b` are compared exactly: the use-counter is discrete (a missed change
// costs the player an item) and brake is effectively binary, so neither has a
// meaningful "close enough".
function differs(a, b, steerThreshold) {
  if (!b) return true;                       // nothing confirmed yet
  if (num(a.u) !== num(b.u)) return true;
  if (num(a.b) !== num(b.b)) return true;
  const d = Math.abs(num(a.s) - num(b.s));
  if (d > 0 && isRail(num(a.s))) return true; // rails land exactly (see isRail)
  // A threshold of 0 means LOSSLESS — filter only exact repeats. Testing
  // `d >= 0` would call every sample different and disable the gate entirely,
  // which is the opposite of what 0 should mean.
  return steerThreshold > 0 ? d >= steerThreshold : d > 0;
}

export class InputGate {
  constructor(opts = {}) {
    this.steerThreshold = opts.steerThreshold != null ? opts.steerThreshold : DEFAULT_STEER_THRESHOLD;
    this.strongThreshold = opts.strongThreshold != null ? opts.strongThreshold : DEFAULT_STRONG_THRESHOLD;
    this.sendIntervalMs = opts.sendIntervalMs != null ? opts.sendIntervalMs : DEFAULT_SEND_INTERVAL_MS;
    this.sendMinIntervalMs = opts.sendMinIntervalMs != null ? opts.sendMinIntervalMs : DEFAULT_SEND_MIN_INTERVAL_MS;
    this.idleMs = opts.idleMs != null ? opts.idleMs : DEFAULT_IDLE_MS;
    this.minResendMs = opts.minResendMs != null ? opts.minResendMs : DEFAULT_MIN_RESEND_MS;

    this._acked = null;      // newest sample the display CONFIRMED applying
    this._sent = null;       // newest sample handed to the transport
    this._sentAt = -Infinity; // when that happened; never-sent means no pacing wait
    this._pending = false;   // that send is outstanding (sent, not yet acked)
  }

  // Resend cadence for an unacked sample, from the live smoothed RTT.
  _resendMs(srttMs) {
    return Math.max(this.minResendMs, RESEND_RTT_FACTOR * num(srttMs));
  }

  // Decide whether `sample` goes on the wire. Returns the reason it was sent
  // ('change' | 'resend' | 'idle') or null when it is filtered. Pure — call
  // markSent() when the send actually happens, so a dropped or failed transmit
  // doesn't get recorded as confirmed-in-flight.
  decide(sample, nowMs, srttMs) {
    // The display already holds an equivalent value: only the staleness bound
    // can justify spending a packet.
    if (!differs(sample, this._acked, this.steerThreshold)) {
      return nowMs - this._sentAt >= this.idleMs ? 'idle' : null;
    }
    // It needs this value. If an equivalent one is already in flight, hold off
    // until the resend cadence rather than re-sending on every sample.
    const inFlight = this._pending && !differs(sample, this._sent, this.steerThreshold);
    if (inFlight) {
      return nowMs - this._sentAt >= this._resendMs(srttMs) ? 'resend' : null;
    }
    // Fresh news: how soon it may go depends on how big it is. Strong changes
    // wait only the hard floor; sub-strong drift rides the baseline cadence.
    const wait = this._isStrong(sample) ? this.sendMinIntervalMs : this.sendIntervalMs;
    return nowMs - this._sentAt >= wait ? 'change' : null;
  }

  // A change worth interrupting the baseline cadence for: the same question as
  // "does the display need telling", just held to the coarser strong threshold
  // — so it IS differs(), at the other dead-band. One function carries the
  // u/b/rail rules for both.
  _isStrong(sample) {
    return differs(sample, this._acked, this.strongThreshold);
  }

  // Record that `sample` was handed to the transport.
  markSent(sample, nowMs) {
    this._sent = { s: num(sample.s), b: num(sample.b), u: num(sample.u) };
    this._sentAt = nowMs;
    this._pending = true;
  }

  // The display confirmed applying `sample` (fastlane ack). On the relay path
  // there are no acks — WS is reliable and ordered, so a send IS a confirmation
  // and callers pass the sample straight here.
  markAcked(sample) {
    if (!sample) return;
    this._acked = { s: num(sample.s), b: num(sample.b), u: num(sample.u) };
    this._pending = false;
  }

  // Transport went away (fastlane closed, relay reconnect). The display's state
  // is no longer knowable, so drop the confirmed value: the next sample is
  // unconditionally a 'change' and re-establishes ground truth.
  reset() {
    this._acked = null;
    this._sent = null;
    this._pending = false;
    this._sentAt = -Infinity;
  }
}
