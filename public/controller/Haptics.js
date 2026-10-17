// Haptics — the phone's single vibration motor, arbitrated, with every cue
// named so each platform can play it the way it can.
//
// A cue is an EFFECT (a row of EFFECTS below), never a raw duration at the call
// site. Three platforms play them three ways:
//   - the plain web page has only navigator.vibrate, which takes durations and
//     nothing else — so every effect carries a `ms` fallback;
//   - the CouchPad launcher offers CouchPadHost.haptic(primitive, scale), one of
//     Android's composition primitives at a strength (CONTRACT.md §12), plus a
//     navigator.vibrate on both apps (§11, polyfilled on iOS);
//   - inside the AirConsole iframe only the SDK's composition vibrate works —
//     the same primitive vocabulary. See airConsoleBackend.
//
// What does NOT change per platform is the arbitration. Every motor here is ONE
// global channel with no mixing, and every call REPLACES whatever is playing.
// Two consequences shape this module:
//
//   1. "Light" has to come from SPACING — short ticks with clear gaps between
//      them. Faking a faint hum by fast on/off (gaps the motor blurs over) only
//      works on Android's motor; the iPhone's stops dead after every pulse and
//      plays the same pattern as harsh bursts. Gaps of 50 ms and more feel the
//      same on both. That's what BRAKE_PATTERN is.
//   2. A background loop and a transient tick CANNOT coexist. A buzz fired while
//      the brake rumble is running silences it until the loop's next renewal —
//      up to BRAKE_RENEW_MS of dead motor in the middle of a held brake.
//
// So every cue goes through one Haptics instance. There is no mixing (the
// hardware cannot mix), only PRIORITY: a transient plays immediately and, if a
// loop was running underneath, re-arms it the moment the pulse ends.
//
// Dependency-free so the Node tests can import it directly (see CLAUDE.md).
// navigator/window are reached only through the injected defaults, so importing
// this module under Node is safe.

// The transients. `primitive`/`scale` is what a primitive-capable backend plays;
// `ms` is the navigator.vibrate stand-in AND how long the motor is considered
// busy before a loop underneath resumes. The web lengths are sized against
// Android's own pre-composition fallback for a click (20 ms).
export const EFFECTS = {
  tap:   { primitive: 'click', scale: 0.7, ms: 15 },       // every menu/lobby/pause/results button
  steer: { primitive: 'click', scale: 0.5, ms: 12 },       // a ‹ › steer-button press (the chord gets the rumble)
  use:   { primitive: 'click', scale: 1,   ms: 20 },       // the USE button press
  item:  { primitive: 'click', scale: 1,   ms: 20 },       // eyes-free "you picked something up"
  count: { primitive: 'click', scale: 1,   ms: 20 },       // 3..2..1
  go:    { primitive: 'thud',  scale: 1,   ms: [0, 90] },  // GO — a low knock that rings out
};

// Brake rumble: a LIGHT ABS-like ticking for as long as BRAKE is held — the
// player's eyes-free confirmation they're braking (they're watching the car on
// the main display, not the phone).
// Tune: raise the 12 (tick length) for stronger ticks; raise the 60 (gap) for
// sparser. Keep the gap at 50 ms or more (see 1. above).
const BRAKE_PULSE = [12, 60];                                     // 72 ms cycle: ~14 soft ticks a second
export const BRAKE_PATTERN = Array(25).fill(BRAKE_PULSE).flat();  // ~1.8 s of rumble
export const BRAKE_RENEW_MS = 1500;                               // renew before it ends (1.8 s > 1.5 s, no gap)

// Gap between a transient ending and the loop resuming underneath it. Small
// enough not to read as a hole in the rumble, large enough that the re-arming
// vibrate() call can't land while the transient is still playing and truncate it.
export const REARM_GAP_MS = 10;

// A vibrate() argument is either a duration or an on/off pattern; both need to
// resolve to "how long until the motor is free again".
const durationOf = (p) => (Array.isArray(p) ? p.reduce((a, v) => a + (+v || 0), 0) : (+p || 0));

export class Haptics {
  // A backend is { vibrate, play }: `vibrate(pattern)` is the Vibration API
  // shape (a duration, an on/off pattern, or 0 to cancel) and carries the brake
  // loop; `play(primitive, scale)` is optional and, when present, plays every
  // transient instead of its `ms`. The timer pair exists only for the tests.
  constructor({ vibrate, play, schedule, cancel } = {}) {
    this._vibrate = vibrate || ((p) => {
      try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(p); } catch (_) {}
    });
    this._play = play || null;
    this._schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
    this._cancel = cancel || ((h) => clearTimeout(h));
    this._loop = null;    // { pattern, renewMs } while a background loop is armed
    this._timer = null;   // the pending renew (or post-transient re-arm)
  }

  // A one-off effect by name: taps, the countdown. Plays now; a loop running
  // underneath resumes once the effect's `ms` has elapsed.
  tick(name) {
    const effect = EFFECTS[name];
    if (!effect) throw new Error(`Haptics: no effect named "${name}"`);
    if (this._play) this._play(effect.primitive, effect.scale);
    else this._vibrate(effect.ms);
    if (this._loop) this._arm(durationOf(effect.ms) + REARM_GAP_MS);
  }

  // Start a self-renewing background loop (the brake rumble). navigator.vibrate
  // has no native loop, so we play a long pattern and re-issue it just before it
  // ends — the motor never falls silent. A second call while one is running is a
  // no-op, so a repeated press can't stack renewals.
  startLoop(pattern = BRAKE_PATTERN, renewMs = BRAKE_RENEW_MS) {
    if (this._loop) return;
    this._loop = { pattern, renewMs };
    this._vibrate(pattern);
    this._arm(renewMs);
  }

  // Stop the loop and kill the motor now — vibrate(0) cancels the pattern still
  // playing out, which would otherwise run on for up to its full length.
  stopLoop() {
    if (!this._loop) return;
    this._loop = null;
    this._clear();
    this._vibrate(0);
  }

  _arm(ms) {
    this._clear();
    this._timer = this._schedule(() => {
      this._timer = null;
      if (!this._loop) return;          // stopped while we were waiting
      this._vibrate(this._loop.pattern);
      this._arm(this._loop.renewMs);
    }, ms);
  }

  _clear() {
    if (this._timer != null) { this._cancel(this._timer); this._timer = null; }
  }
}

// A vibrate() pattern as a composition — the step shape both the CouchPad
// launcher (CONTRACT.md §12 hapticComposition) and the AirConsole SDK take:
// one low tick per on-segment, and the pattern's off-segments become each
// step's `delay`, the rest AFTER the previous step ends (Android's composition
// clock), so the tick itself stands in for the on-segment and only the gap is
// delay. The cancel call (0) is the empty sequence.
export function hapticChain(p) {
  if (!Array.isArray(p)) p = [p];
  const chain = [];
  let gap = 0;      // off-time since the previous tick
  for (let i = 0; i < p.length; i++) {
    const ms = +p[i] || 0;
    if (i % 2 === 1) gap += ms;
    else if (ms > 0) { chain.push({ primitive: 'low_tick', scale: 1, delay: gap }); gap = 0; }
  }
  return chain;
}

// The AirConsole backend: everything through the SDK's composition vibrate.
// `airconsole` is the SDK instance; `VIBRATE` is AirConsole.VIBRATE, whose
// PRIMITIVE keys are our primitive names upper-cased (click → CLICK,
// low_tick → LOW_TICK) — passed in rather than re-typed here.
//
// The brake rumble has no SDK counterpart (no loop, no duration pattern that
// iOS honours), so it rides hapticChain. The SDK leaves the delay's reference
// point unstated; the shape is Android's, so Android's clock is assumed. There
// is no cancel either; vibrate(0) plays a single tick at scale 0 — the faintest
// the device makes — which REPLACES the chain still playing out.
// UNVERIFIED on a device: whether the AirConsole iOS app honours `delay`, and
// how low ticks feel at this spacing. Judge on the phone, not here.
export function airConsoleBackend(airconsole, VIBRATE) {
  const composition = (value) => airconsole.vibrate({ type: VIBRATE.TYPE.COMPOSITION, value });
  const entry = ({ primitive, scale, delay }) => ({ primitive: VIBRATE.PRIMITIVE[primitive.toUpperCase()], scale, delay });
  return {
    play: (primitive, scale) => composition([entry({ primitive, scale, delay: 0 })]),
    vibrate: (p) => {
      const chain = hapticChain(p).map(entry);
      composition(chain.length ? chain : [entry({ primitive: 'low_tick', scale: 0, delay: 0 })]);
    },
  };
}
