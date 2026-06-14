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
// Braking: a held BRAKE button. Held → brake = BRAKE_LEVEL; the engine reads it
// as a target speed of (1 - BRAKE_LEVEL) × top speed, so a full hold (1) bleeds
// the car all the way down to a standstill.
//
// Fallbacks (no tilt / desktop / permission denied): arrow keys or A/D steer,
// Space/Down brake. Steer = roll + keys (so the loop is testable headlessly).
// Emits {s,b} to onControl at ~25 Hz.

const SEND_HZ = 25;
const ROLL_LOCK = 30;      // degrees of left/right roll for full lock
const DEADZONE = 0.06;     // normalized steer ignored around centre
// Single light low-pass on the steer output: just enough to take the edge off
// sensor jitter (raw DeviceOrientation twitches ~1-2° even held still) without
// the lag of a heavier filter. Higher = snappier; set to 1 for fully raw.
const SMOOTH = 0.5;
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
  }

  start() {
    if (this._timer) return;
    const interval = 1000 / SEND_HZ;
    this._timer = setInterval(() => this._tick(), interval);
  }
  stop() {
    clearInterval(this._timer); this._timer = null;
    this._brakeBtn = 0;
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
  _sensorSteer() {
    if (!this.haveTilt) return 0;
    const { x, y, z } = this._g;
    const { rx, ry } = SCREEN_RIGHT[this._screenAngle()] || SCREEN_RIGHT[0];
    const gRight = x * rx + y * ry;
    const rollDeg = Math.atan2(gRight, -z) * RAD;
    return clamp1(rollDeg / ROLL_LOCK);
  }

  // Degrees the OS has rotated the UI from its natural (portrait) orientation,
  // snapped to {0,90,180,270}. Prefer the modern Screen Orientation API; fall back
  // to the legacy window.orientation (which reports -90, hence the wrap). Absent
  // both (desktop / Node test), assume portrait.
  _screenAngle() {
    const so = (typeof screen !== 'undefined' && screen.orientation
        && typeof screen.orientation.angle === 'number') ? screen.orientation.angle
      : (typeof window !== 'undefined' && typeof window.orientation === 'number'
        ? window.orientation : 0);
    return (((Math.round(so / 90) * 90) % 360) + 360) % 360;
  }

  _tick() {
    let target = this._sensorSteer();
    // dead-zone the centre, then re-expand so full lock still reaches ±1
    if (Math.abs(target) < DEADZONE) target = 0;
    else target = (target - Math.sign(target) * DEADZONE) / (1 - DEADZONE);
    this._steer += (target - this._steer) * SMOOTH;

    const s = clamp1(this._steer + this._key);
    const b = Math.max(this._brakeBtn, this._brakeKey);
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
    };
    window.addEventListener('keydown', (e) => set(e, true));
    window.addEventListener('keyup', (e) => set(e, false));
  }

  // Steering is via tilt; the control surface just needs to not scroll/zoom under
  // the player's thumb while they drive.
  _initSurface() {
    if (this.surface) this.surface.style.touchAction = 'none';
  }

  // On-screen BRAKE button: held → brake at the fixed BRAKE_LEVEL, released → 0.
  pressBrake(on) { this._brakeBtn = on ? BRAKE_LEVEL : 0; }

  // Enable/disable ACTION — mirrors the held-item slot (main.js drives this from
  // setHeldItem). Gates BOTH input paths (on-screen button AND keyboard) so a press
  // with no item can't bump the counter and ghost-fire at the next race's start.
  setActionEnabled(on) { this._actionEnabled = !!on; }

  // ACTION button: one tap = one item use. Bump the wrapping counter on the press
  // edge; the next _tick carries it and the display fires the held item once. No-op
  // when no item is held (see setActionEnabled).
  pressAction() { if (this._actionEnabled) this._useCount = (this._useCount + 1) & 255; }
}
