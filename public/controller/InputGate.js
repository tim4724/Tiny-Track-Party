// InputGate — decides which of the 25 Hz control samples actually reach the wire.
//
// CONTROL is absolute state ({s,b,u}) resampled every 40 ms, not a stream of
// discrete events. The display applies inputs on arrival straight into the sim's
// car fields and only steps physics from rAF, so it HOLDS the last value it was
// given until a new one replaces it. That means a sample identical (or near
// identical) to what the display already holds is a no-op on the wire: sending it
// changes nothing anyone can observe.
//
// So instead of "transmit every sample", the rule is SEND UNTIL CONFIRMED:
//
//   1. sample matches what the display confirmed  → skip, unless idleMs elapsed
//   2. it differs (u or b at all, or |Δs| >= steerThreshold) → send
//   3. ...except when an equivalent value is already IN FLIGHT and the resend
//      cadence hasn't elapsed → skip and let the ack arrive
//
// Note what falls out of rule 2: because the comparison is against the last
// ACKED sample, an unconfirmed value keeps differing and so keeps being sent, all
// by itself. "Resend until acknowledged" needs no rule of its own — it is what
// gating on acknowledgement already means. The resend cadence therefore exists to
// THROTTLE that (rule 3), not to drive it: without it, a value in flight would be
// re-sent every 40 ms, and on a 100 ms link that is three copies where one would
// do — burning exactly the bandwidth this gate exists to save.
//
// Every comparison is against the LAST ACKNOWLEDGED sample, never the last sent
// one. If a send was lost, "last sent" is a value the display never saw, and
// gating against it would leave the display stale with the sender believing
// otherwise. Only an ack reveals what the display actually holds. Because the ack
// lags by one RTT, the comparison is against a slightly old state, which makes the
// gate keener to send — the safe direction.
//
// Rule 4 is a fresh SEND, not a retransmit. The receiver identifies an event by
// its seq (`es > lastAppliedEs`), so re-sending a newer payload under an already
// delivered seq would have it discarded as a duplicate — the transport would
// silently throw away the fresher value, and only when the network was healthy
// enough to deliver both. Re-sending means "enqueue the current sample again".
//
// GUARANTEE, and the thing the tests pin: divergence from the display is bounded
// by steerThreshold, staleness is bounded by idleMs, and neither compounds. A fast
// flick clears the threshold on the very next sample and goes out with no added
// latency; a slow drift fires the moment it accumulates past the threshold. The
// only thing ever delayed is a drift that never gets there.
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
export const DEFAULT_STEER_THRESHOLD = 0.03;

// Staleness bound: the longest a sub-threshold change can wait. Matches the kit's
// IDLE_MS so a gated stream degrades into exactly the heartbeat cadence the
// fastlane already emits when idle, rather than inventing a second timer.
export const DEFAULT_IDLE_MS = 500;

// Floor for the unacked-resend cadence. The real interval is derived from live
// RTT: resending sooner than an ack could physically arrive burns a duplicate on
// every single sample.
export const DEFAULT_MIN_RESEND_MS = 50;
export const RESEND_RTT_FACTOR = 1.5;

// Thresholds the shadow counters evaluate alongside the live one, so a single
// real session yields the whole suppression curve instead of one point. 0 is the
// LOSSLESS case: it filters only exactly-identical samples, which the display
// provably cannot distinguish, so it costs nothing in feel.
export const SHADOW_THRESHOLDS = [0, 0.01, 0.02, 0.03, 0.05, 0.08];

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

// True when `a` differs from `b` enough that the display needs telling.
// `u` and `b` are compared exactly: the use-counter is discrete (a missed change
// costs the player an item) and brake is effectively binary, so neither has a
// meaningful "close enough".
function differs(a, b, steerThreshold) {
  if (!b) return true;                       // nothing confirmed yet
  if (num(a.u) !== num(b.u)) return true;
  if (num(a.b) !== num(b.b)) return true;
  const d = Math.abs(num(a.s) - num(b.s));
  // A threshold of 0 means LOSSLESS — filter only exact repeats. Testing
  // `d >= 0` would call every sample different and disable the gate entirely,
  // which is the opposite of what 0 should mean.
  return steerThreshold > 0 ? d >= steerThreshold : d > 0;
}

export class InputGate {
  constructor(opts = {}) {
    this.steerThreshold = opts.steerThreshold != null ? opts.steerThreshold : DEFAULT_STEER_THRESHOLD;
    this.idleMs = opts.idleMs != null ? opts.idleMs : DEFAULT_IDLE_MS;
    this.minResendMs = opts.minResendMs != null ? opts.minResendMs : DEFAULT_MIN_RESEND_MS;

    this._acked = null;      // newest sample the display CONFIRMED applying
    this._sent = null;       // newest sample handed to the transport
    this._sentAt = 0;        // when that happened
    this._pending = false;   // that send is outstanding (sent, not yet acked)

    // Live counters + one shadow counter per candidate threshold. Shadows track
    // their own would-be acked state, because a different threshold would have
    // sent at different moments and therefore have a different confirmed value.
    this.produced = 0;
    this.sent = 0;
    this._shadows = SHADOW_THRESHOLDS.map((t) => ({ threshold: t, sent: 0, acked: null, sentAt: 0 }));
  }

  // Resend cadence for an unacked sample, from the live smoothed RTT.
  _resendMs(srttMs) {
    return Math.max(this.minResendMs, RESEND_RTT_FACTOR * num(srttMs));
  }

  // Decide whether `sample` goes on the wire. Returns the reason it was sent
  // ('change' | 'resend' | 'idle') or null when it is filtered. Pure apart from
  // the counters — call markSent() when the send actually happens, so a dropped
  // or failed transmit doesn't get recorded as confirmed-in-flight.
  decide(sample, nowMs, srttMs) {
    this.produced += 1;
    this._tickShadows(sample, nowMs);

    // The display already holds an equivalent value: only the staleness bound
    // can justify spending a packet.
    if (!differs(sample, this._acked, this.steerThreshold)) {
      return nowMs - this._sentAt >= this.idleMs ? 'idle' : null;
    }
    // It needs this value. If an equivalent one is already in flight, hold off
    // until the resend cadence rather than re-sending on every 40 ms sample.
    const inFlight = this._pending && !differs(sample, this._sent, this.steerThreshold);
    if (inFlight) {
      return nowMs - this._sentAt >= this._resendMs(srttMs) ? 'resend' : null;
    }
    return 'change';
  }

  // Record that `sample` was handed to the transport.
  markSent(sample, nowMs) {
    this.sent += 1;
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
    this._sentAt = 0;
    for (const sh of this._shadows) { sh.acked = null; sh.sentAt = 0; }
  }

  // Counters for the netstats overlay. `shadows` answers "what would we have
  // sent at threshold X" over the same real input, so one party measures the
  // whole curve. Shadow rows assume every send is instantly confirmed, so they
  // read as the FLOOR — the live path also spends sends on resends and idles.
  stats() {
    const suppressed = this.produced - this.sent;
    return {
      produced: this.produced,
      sent: this.sent,
      suppressed,
      suppressedPct: this.produced ? (suppressed / this.produced) * 100 : 0,
      threshold: this.steerThreshold,
      shadows: this._shadows.map((sh) => ({
        threshold: sh.threshold,
        sent: sh.sent,
        suppressedPct: this.produced ? ((this.produced - sh.sent) / this.produced) * 100 : 0,
      })),
    };
  }

  // Replay this sample through each candidate threshold. Mirrors decide()'s
  // change/idle rules; 'resend' is deliberately left out because it depends on
  // real ack timing a shadow can't observe, which is why shadows are a floor.
  _tickShadows(sample, nowMs) {
    for (const sh of this._shadows) {
      if (differs(sample, sh.acked, sh.threshold) || nowMs - sh.sentAt >= this.idleMs) {
        sh.sent += 1;
        sh.sentAt = nowMs;
        sh.acked = { s: num(sample.s), b: num(sample.b), u: num(sample.u) };
      }
    }
  }
}
