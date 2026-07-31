// TiltInput — phone steering + braking for the Tiny Track Party controller.
//
// Steering is absolute (no recentering): we read DeviceOrientation, rebuild the
// gravity vector, and steer by the phone's ROLL — gravity's angle in the x–z
// plane:  roll = atan2(gx, -gz)  (this equals device `gamma`).
//
// Roll is the doodle-jump signal: lean the phone left/right. Critically it's
// PITCH-INDEPENDENT — the cosβ in gx and gz cancels, so a 25° lean reads 25°
// whether the phone is flat or tilted back to read it. (asin(gx) does NOT cancel
// pitch and weakened the lean the more upright you held it — that was a bug.)
//
// The steering-wheel twist still works: held upright, a twist swings gravity in
// the screen plane and the roll runs toward ±90°, so twisting drives the car too
// (sensitively — it reaches full lock fast, since roll isn't proportional to the
// twist the way it is to a flat lean). Both gestures, one signal, no mode switch.
//
// Roll is read in the SCREEN's current frame, not the phone's native one: we take
// the device-frame gravity vector and rotate its x/y by screen.orientation.angle,
// so "lean toward the right of whatever you're looking at" steers right whether the
// UI is portrait or landscape. Hold the phone any way up and the steering tracks
// the visible up-direction — the OS auto-rotating the UI rotates the steering
// reference WITH it (so they stay consistent), and orientation-locking just pins
// both. In portrait (angle 0) this collapses to the raw native roll, so nothing
// changes for the common case.
//
// iOS 13+ needs requestPermission() from a user gesture (call enableMotion() in a
// tap handler). HTTPS is required for sensors.
//
// Steering can also come from BUTTONS instead of the sensor (setScheme). LEFT and
// RIGHT are held like a d-pad and RAMP the steer linearly toward full lock, so
// hold time is the analog axis: a tap is a partial correction, a hold is a full
// turn (see the BTN_RAMP_MS note). The press edge still reaches the wire without
// waiting for the next sample (_flush). Holding BOTH is the brake: the two cancel
// to centre, so the pair reads as "stop", not "steer nowhere".
//
// Braking: a held BRAKE button. Held → brake = BRAKE_LEVEL; the engine reads it
// as a target speed of (1 - BRAKE_LEVEL) × top speed, so a full hold (1) bleeds
// the car all the way down to a standstill.
//
// Fallbacks (no tilt / desktop / permission denied): arrow keys or A/D steer,
// Space/Down brake. Steer = roll + keys (so the loop is testable headlessly).
// Emits {s,b,u} to onControl on every sensor sample and on every button/key
// edge — the InputGate downstream decides what actually reaches the wire — with
// a SEND_HZ interval kept as the idle heartbeat and the no-sensor fallback.

const SEND_HZ = 25;

// The three steering numbers below are MANIFEST values: they belong to the
// shared steering contract in shared/protocol.js (STEER), because the display's
// sim and the CONTROL send gate are sized against them. They are re-declared
// here rather than read from `window.STEER` because protocol.js is a classic
// script (the controller page loads it with <script src> before any module) and
// this file is documented importable headlessly by the Node suites — so they are
// EXPORTED instead, and tests/config-drift.test.js fails if either copy moves
// without the other.
export const ROLL_LOCK = 30;      // degrees of left/right roll for full lock
export const DEADZONE = 0.06;     // normalized steer ignored around centre
// Single light low-pass on the steer output: just enough to take the edge off
// sensor jitter (raw DeviceOrientation twitches ~1-2° even held still) without
// the lag of a heavier filter. Higher = snappier; set to 1 for fully raw.
// Applied once per emitted sample; since samples follow the sensor events, the
// filter converges at sensor rate (~24 ms to 50% at 60 Hz), while its per-sample
// noise halving — the property the gate's dead-band is derived from — is a
// function of the alpha alone and doesn't move with the event rate. It cannot be
// dropped outright: raw wobble (1-2° over ROLL_LOCK) clears GATE_THRESHOLD, so
// an unfiltered stream would chatter packets from a phone lying still.
export const SMOOTH = 0.5;

// Button steering ramps: a held button walks the steer LINEARLY to full lock over
// BTN_RAMP_MS, and letting go walks it back to centre in the faster BTN_RELEASE_MS.
// It must not borrow SMOOTH — that filter is sized against SENSOR NOISE (it halves
// the raw DeviceOrientation wobble, which is what lets the send gate's dead-band
// sit where it does) and a button has none; a one-pole's infinite tail (133 ms to
// 90% of a step, as long again to let go) reads as lag, not smoothing. Linear
// instead makes hold time itself the analog axis: constant progress from the first
// tick, a crisp landing exactly on ±1, and a quick tap (~100 ms) lands a ~2/3-lock
// correction instead of slamming full. Release is twice as fast because letting go
// must never feel sticky — the attack/release asymmetry every d-pad racing scheme
// uses. The ramp is WALL-CLOCK based (see _tick): _flush inserts extra ticks
// between the 25 Hz beats, and a per-tick step would fast-forward through them.
const BTN_RAMP_MS = 150;    // press → full lock
const BTN_RELEASE_MS = 75;  // release (or reversal, until it re-crosses centre) → 0

const BRAKE_LEVEL = 1.0;   // held brake decelerates the car to a full stop

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

// The screen's "right" axis expressed in the device's native x/y, keyed by the OS
// rotation angle. Projecting gravity onto this axis (instead of always onto native
// +x) is what makes a left/right lean read the same in portrait and landscape:
// rotate the steering reference with the UI. Equivalent to rotating (x,y) by the
// screen angle — { rx: cosθ, ry: -sinθ } — snapped to the four right angles.
const SCREEN_RIGHT = {
  0:   { rx: 1,  ry: 0 },   // portrait — native frame, unchanged
  90:  { rx: 0,  ry: -1 },  // landscape-primary
  180: { rx: -1, ry: 0 },   // upside-down portrait
  270: { rx: 0,  ry: 1 },   // landscape-secondary
};

export class TiltInput {
  constructor({ onControl, surface }) {
    this.onControl = onControl || (() => {});
    this.surface = surface || (typeof document !== 'undefined' ? document.body : null);
    this.haveTilt = false;
    this.motionState = 'unknown'; // unknown | granted | denied | unsupported

    // latest gravity unit vector in the device frame (overwritten each event;
    // the flat seed only stands in until the first reading arrives)
    this._g = { x: 0, y: 0, z: -1 };

    this._steer = 0;       // smoothed steer output (-1..1)
    this._key = 0;         // keyboard steer (-1/0/1)
    this._keyL = false; this._keyR = false;
    this._tiltOn = true;   // sensor steering (off in the button schemes — see setScheme)
    this._btnL = false; this._btnR = false;  // on-screen LEFT/RIGHT steer buttons
    this._btnTickMs = 0;   // last button-path tick, for the wall-clock ramp dt
    this.extraAngle = 0;   // degrees the LAYOUT is rotated on top of the OS (see setScheme)
    this._brakeBtn = 0;    // brake from the on-screen BRAKE button (0 or BRAKE_LEVEL)
    this._brakeKey = 0;    // brake from keyboard (0 or BRAKE_LEVEL)
    this._useCount = 0;    // ACTION presses, mod 256 — a wrapping use-counter (see _tick)
    this._actKeyDown = false;
    this._actionEnabled = false; // gate: ACTION does nothing unless the slot holds an item (set via setActionEnabled)
    this._timer = null;

    this._onOrient = this._onOrient.bind(this);
    this._bindKeys();
    this._initSurface();
  }

  // Call from a user gesture (e.g. the Join tap). Returns the permission state.
  async enableMotion() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { this.motionState = 'unsupported'; return this.motionState; }
    try {
      if (typeof DOE.requestPermission === 'function') {
        const res = await DOE.requestPermission(); // iOS
        this.motionState = res === 'granted' ? 'granted' : 'denied';
      } else {
        this.motionState = 'granted'; // Android/desktop: just attach
      }
    } catch (_) {
      this.motionState = 'denied';
    }
    if (this.motionState === 'granted') window.addEventListener('deviceorientation', this._onOrient);
    return this.motionState;
  }

  _onOrient(e) {
    if (e.beta == null && e.gamma == null) return;
    this.haveTilt = true;

    // Gravity (unit, pointing down) in the device frame from the W3C Z-X'-Y''
    // Euler angles. alpha (compass yaw) doesn't tilt gravity, so it drops out —
    // which is exactly why steering needs no compass and no recentering.
    const b = (e.beta || 0) * DEG, g = (e.gamma || 0) * DEG;
    const cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    // Store gravity straight from this sample — no smoothing here. The only
    // low-pass is the one on the steer output (SMOOTH), so there's no startup
    // ramp and no stacked latency; "level" is wherever gravity actually points.
    this._g.x = cb * sg;
    this._g.y = -sb;
    this._g.z = -cb * cg;

    // Emit straight from the sensor event: a fresh sample used to sit up to
    // 40 ms waiting for the interval tick, which was the single largest
    // software-added stage of input-to-photon latency. The gate downstream
    // filters sub-threshold wobble, so this raises the wire rate only while
    // the phone is actually moving.
    if (this._timer) this._tick();
  }

  start() {
    if (this._timer) return;
    // Fallback cadence only: sensor events and button/key edges emit directly,
    // so this interval matters just for keyboard-held steering and as the
    // heartbeat that lets the gate's idle/resend rules fire on a still phone.
    const interval = 1000 / SEND_HZ;
    this._timer = setInterval(() => this._tick(), interval);
  }
  stop() {
    clearInterval(this._timer); this._timer = null;
    this._brakeBtn = 0;
    this._btnL = false; this._btnR = false; // a race can end with a steer button still down
    this._useCount = 0; // fresh race → restart the counter (display's useSeq resets too)
    this._actKeyDown = false; // clear held-key state so a missed keyup can't suppress the next race's first press
  }

  // Steer = roll = gravity's angle in the screen's x–z plane = atan2(gRight, -gz),
  // where gRight is gravity's component along the screen's current "right" axis (the
  // device x/y rotated by the screen orientation; see SCREEN_RIGHT / _screenAngle).
  // In portrait this is the native roll (= device gamma): pitch-independent (cosβ
  // cancels) so the doodle-jump lean is full-strength at any hold angle, and an
  // upright twist runs gz→0 so roll heads toward ±90° and twisting steers too. In
  // landscape the same screen-relative lean is read off the device's pitch axis
  // instead — one signal, any orientation.
  // Pick which source drives the steer, and tell the sensor how the LAYOUT is
  // oriented. `extraAngle` is degrees the PAGE has rotated its own pixels on top
  // of whatever the OS did (90 for the emulated-landscape schemes, which rotate
  // the game surface in CSS because the shell locks the WebView to portrait). It
  // adds to the real screen angle, so "lean toward the right of what you're
  // looking at" keeps steering right however the picture got there.
  setScheme({ tilt = true, extraAngle = 0 } = {}) {
    const on = !!tilt;
    const ang = ((Math.round(extraAngle / 90) * 90) % 360 + 360) % 360;
    // Re-applying the live scheme must be free: callers refresh it on every screen
    // change, and a race is full of those — resetting the steer there would flick
    // the wheel straight mid-corner.
    if (on === this._tiltOn && ang === this.extraAngle) return;
    this._tiltOn = on;
    this.extraAngle = ang;
    // Drop the old source's output rather than letting it decay into the new
    // one: a scheme swap mid-corner would otherwise carry that lock across.
    this._steer = 0;
    this._btnL = false; this._btnR = false;
  }

  _sensorSteer() {
    if (!this.haveTilt || !this._tiltOn) return 0;
    const { x, y, z } = this._g;
    const { rx, ry } = SCREEN_RIGHT[this._screenAngle()] || SCREEN_RIGHT[0];
    const gRight = x * rx + y * ry;
    const rollDeg = Math.atan2(gRight, -z) * RAD;
    return clamp1(rollDeg / ROLL_LOCK);
  }

  // Degrees the UI is rotated from the device's natural (portrait) orientation,
  // snapped to {0,90,180,270}: what the OS did, plus what the page did to itself
  // (extraAngle). Prefer the modern Screen Orientation API; fall back to the
  // legacy window.orientation (which reports -90, hence the wrap). Absent both
  // (desktop / Node test), assume portrait. The two compose exactly — each 90°
  // step maps the layout's "right" onto the previous frame's "down" — so an
  // auto-rotating browser and our own CSS rotation can both be in play.
  _screenAngle() {
    const so = (typeof screen !== 'undefined' && screen.orientation
        && typeof screen.orientation.angle === 'number') ? screen.orientation.angle
      : (typeof window !== 'undefined' && typeof window.orientation === 'number'
        ? window.orientation : 0);
    return (((Math.round(so / 90) * 90 + this.extraAngle) % 360) + 360) % 360;
  }

  // the ramp's clock — an instance method so the headless suites can stub time
  _now() { return performance.now(); }

  _tick() {
    // Two steer sources, each with the ramp it actually wants. The sensor is a
    // continuous signal carrying noise, so it gets the dead-zone and the one-pole
    // SMOOTH. The buttons are a clean step with no noise to filter, so they get
    // the linear wall-clock ramp instead — no dead-zone (±1 and 0 are exact) and
    // no exponential tail. See BTN_RAMP_MS.
    if (this._tiltOn) {
      let target = this._sensorSteer();
      // dead-zone the centre, then re-expand so full lock still reaches ±1
      if (Math.abs(target) < DEADZONE) target = 0;
      else target = (target - Math.sign(target) * DEADZONE) / (1 - DEADZONE);
      this._steer += (target - this._steer) * SMOOTH;
      // Snap out of the EMA's asymptote: the filter halves the residual per
      // sample, so it nears a held target but never lands on it — and the tail
      // of a full flick then sits under the send gate's dead-band, reading as a
      // steer bar stuck at ~97% until the idle resend. Once the residual is
      // inside 0.01 (a third of the gate, invisible authority) converge exactly,
      // so full lock and a released centre are values that actually occur.
      if (Math.abs(target - this._steer) < 0.01) this._steer = target;
    } else {
      // Walk the steer toward the held direction (both held = 0, the brake pose)
      // at the two linear rates above. dt is clamped to one-and-a-bit beats so the
      // first tick after a stall or a scheme switch can't jump the whole ramp.
      const target = (this._btnR ? 1 : 0) - (this._btnL ? 1 : 0);
      const now = this._now();
      const dt = Math.min(now - this._btnTickMs, 50);
      this._btnTickMs = now;
      const d = target - this._steer;
      // any move that shrinks |steer| is a release; growing it is the ramp
      const releasing = this._steer !== 0 && Math.sign(d) !== Math.sign(this._steer);
      const step = dt / (releasing ? BTN_RELEASE_MS : BTN_RAMP_MS);
      this._steer += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }

    const s = clamp1(this._steer + this._key);
    const b = Math.max(this._brakeBtn, this._brakeKey, this.bothSteerHeld ? BRAKE_LEVEL : 0);
    // u is a wrapping use-counter: the display fires the held item once each time it
    // CHANGES, so it survives the fastlane's latest-wins drops (a dropped frame just
    // re-delivers the same value) without a separate reliable message.
    this.onControl({ s: +s.toFixed(3), b: +b.toFixed(3), u: this._useCount });
  }

  // current steer (for the on-screen steer indicator)
  get state() {
    return { steer: clamp1(this._steer + this._key) };
  }

  // --- keyboard fallback / testing ---
  _bindKeys() {
    if (typeof window === 'undefined') return;
    const set = (e, down) => {
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'a') { this._keyL = down; e.preventDefault(); }
      else if (k === 'arrowright' || k === 'd') { this._keyR = down; e.preventDefault(); }
      else if (k === 'arrowdown' || k === ' ' || k === 's') { this._brakeKey = down ? BRAKE_LEVEL : 0; e.preventDefault(); }
      else if (k === 'enter' || k === 'e' || k === 'arrowup') {
        // ACTION (use item): bump only on the leading edge so key auto-repeat doesn't spam
        if (down && !this._actKeyDown) this.pressAction();
        this._actKeyDown = down; e.preventDefault(); return;
      }
      else return;
      this._key = (this._keyR ? 1 : 0) - (this._keyL ? 1 : 0);
      if (this._timer) this._tick(); // edge-driven, same as the sensor path
    };
    window.addEventListener('keydown', (e) => set(e, true));
    window.addEventListener('keyup', (e) => set(e, false));
  }

  // Steering is via tilt; the control surface just needs to not scroll/zoom under
  // the player's thumb while they drive.
  _initSurface() {
    if (this.surface) this.surface.style.touchAction = 'none';
  }

  // Sample NOW rather than at the next 25 Hz beat. The sampler exists for the
  // SENSOR, which has nothing to say between beats; a button edge does, and making
  // it wait costs up to a full 40 ms period (20 ms on average) before the display
  // hears about a press it could already have. Off the driving path (no timer) it
  // is a no-op — there is nothing to send to. The regular interval is untouched,
  // so this only ever ADDS the edge's own sample; the send gate treats it as the
  // change it is, and drops it if the display already holds that value.
  _flush() { if (this._timer) this._tick(); }

  // On-screen BRAKE button: held → brake at the fixed BRAKE_LEVEL, released → 0.
  pressBrake(on) { this._brakeBtn = on ? BRAKE_LEVEL : 0; this._flush(); }

  // On-screen LEFT/RIGHT steer buttons (button schemes). `dir` < 0 is left.
  pressSteer(dir, on) {
    if (dir < 0) this._btnL = !!on; else this._btnR = !!on;
    this._flush();
  }
  // Both steer buttons down = the brake. Exposed so the UI can light both buttons
  // and run the brake rumble off the same fact the tick brakes on.
  get bothSteerHeld() { return this._btnL && this._btnR; }

  // Enable/disable ACTION — mirrors the held-item slot (main.js drives this from
  // setHeldItem). Gates BOTH input paths (on-screen button AND keyboard) so a press
  // with no item can't bump the counter and ghost-fire at the next race's start.
  setActionEnabled(on) { this._actionEnabled = !!on; }

  // ACTION button: one tap = one item use. Bump the wrapping counter on the press
  // edge and carry it out on the spot (_flush), so the item fires when it was
  // tapped rather than up to a sampler period later. No-op when no item is held
  // (see setActionEnabled).
  pressAction() {
    if (!this._actionEnabled) return;
    this._useCount = (this._useCount + 1) & 255;
    this._flush();
  }
}
