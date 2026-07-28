// Haptics — the phone's single vibration motor, arbitrated.
//
// navigator.vibrate is ONE global channel with no intensity control, and every
// call REPLACES whatever pattern is already playing. Two consequences shape this
// whole module:
//
//   1. "Light" has to be faked with DUTY CYCLE — a short on-pulse at a fast cycle
//      is low average motor power (so it feels faint) with pulses too quick to
//      tell apart (so they blend into a hum rather than reading as taps). That's
//      what BRAKE_PATTERN is.
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

// Brake rumble: a continuous-feeling LIGHT buzz for as long as BRAKE is held —
// the player's eyes-free confirmation they're braking (they're watching the car
// on the main display, not the phone).
// Tune: raise the 8 (on-time) for a stronger rumble; raise the 22 (off-time) for
// fainter. Keep the cycle (8+22 = 30 ms) short or the pulses stop blending.
const BRAKE_PULSE = [8, 22];                                      // 30 ms cycle, ~27% duty: a light hum
export const BRAKE_PATTERN = Array(60).fill(BRAKE_PULSE).flat();  // ~1.8 s of rumble

// ...but a rumble that OPENS on that duty cycle feels late, and the reason is
// mechanical rather than a matter of code: a vibration motor has a mass to get
// moving, and 8 ms of drive followed by 22 ms of coast barely starts it. The hum
// only builds over several cycles, so the brake seems to answer a beat after the
// press even though vibrate() was called on the press itself.
//
// So the loop OPENS with one solid pulse — long enough to bring the motor up at
// once — then hands over to the duty cycle through a single lighter pulse, so it
// settles into the hum instead of reading as a knock followed by a rumble.
//
// This is the FIRST play only. Renewals replay BRAKE_PATTERN, because an opening
// on every renewal would put a thump into the middle of a long brake hold every
// BRAKE_RENEW_MS — which is the same two-things-to-feel bug in slow motion.
export const BRAKE_OPENING = [26, 14, 12, 18, ...BRAKE_PATTERN];
export const BRAKE_RENEW_MS = 1500;                               // renew before it ends (1.8 s > 1.5 s, no gap)

// Gap between a transient ending and the loop resuming underneath it. Small
// enough not to read as a hole in the rumble, large enough that the re-arming
// vibrate() call can't land while the transient is still playing and truncate it.
export const REARM_GAP_MS = 10;

// A vibrate() argument is either a duration or an on/off pattern; both need to
// resolve to "how long until the motor is free again".
const durationOf = (p) => (Array.isArray(p) ? p.reduce((a, v) => a + (+v || 0), 0) : (+p || 0));

export class Haptics {
  // Everything the browser provides is injected so the tests can drive this
  // deterministically — there is no other reason for the seams.
  constructor({ vibrate, schedule, cancel } = {}) {
    this._vibrate = vibrate || ((p) => {
      try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(p); } catch (_) {}
    });
    this._schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
    this._cancel = cancel || ((h) => clearTimeout(h));
    this._loop = null;    // { pattern, renewMs } while a background loop is armed
    this._timer = null;   // the pending renew (or post-transient re-arm)
  }

  // A one-off pulse or pattern: taps, item pickup, the countdown. Plays now; a
  // loop running underneath resumes once the pulse has finished.
  tick(p) {
    this._vibrate(p);
    if (this._loop) this._arm(durationOf(p) + REARM_GAP_MS);
  }

  // Start a self-renewing background loop (the brake rumble). navigator.vibrate
  // has no native loop, so we play a long pattern and re-issue it just before it
  // ends — the motor never falls silent. A second call while one is running is a
  // no-op, so a repeated press can't stack renewals.
  //
  // `opening` is what the FIRST play uses (see BRAKE_OPENING: the same rumble with
  // a lead-in that gets the motor up immediately). Everything after it — renewals,
  // and the re-arm that restores the loop under a transient — replays `pattern`,
  // which is why the two are separate arguments and only one of them is retained.
  // It DEFAULTS to the lead-in rather than to `pattern`: opening softly is the bug
  // this exists to fix, so a caller has to ask for that, not remember to avoid it.
  startLoop(pattern = BRAKE_PATTERN, renewMs = BRAKE_RENEW_MS, opening = BRAKE_OPENING) {
    if (this._loop) return;
    this._loop = { pattern, renewMs };
    this._vibrate(opening);
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
