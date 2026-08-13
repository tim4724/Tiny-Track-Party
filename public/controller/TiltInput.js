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
// tap handler). HTTPS is required for sensors. Permission is not delivery,
// though: enableMotion() also waits for a first real sample before it answers,
// because a granted-but-silent sensor is the common failure and it used to
// present as a dead steering wheel (see _settle / sensorPolicyBlocked).
//
// Braking: a held BRAKE button. Held → brake = BRAKE_LEVEL; the engine reads it
// as a target speed of (1 - BRAKE_LEVEL) × top speed, so a full hold (1) bleeds
// the car all the way down to a standstill.
//
// BUTTON steering mode (setMode('buttons')): the sensor is ignored and the two
// on-screen ‹ › buttons steer BINARY — full lock left/right, no ramp (ramps were
// tried and read as two steps anyway). Holding BOTH is the brake. Same {s,b,u}
// frame either way; the display never knows which mode a phone is in.
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

const BRAKE_LEVEL = 1.0;   // held brake decelerates the car to a full stop

// How long a listening page has to receive its first USABLE sample before the
// sensor is declared absent. Both platforms deliver at ~60 Hz from the moment
// the listener attaches, so a real sensor answers within a frame or two and
// pays none of this window; it only has to outlast a slow first sample.
const SENSOR_SETTLE_MS = 600;

// Does this document's permissions policy allow the motion sensors?
// false = the embedder withheld them, null = this browser cannot say.
//
// A cross-origin iframe is granted the sensors only if its embedder spends an
// `allow` attribute on them, and where it doesn't, DeviceOrientationEvent still
// EXISTS on window and simply never fires. The presence of the constructor
// therefore proves nothing, which is why this is asked separately.
//
// Blink-only (`document.featurePolicy`; there is no `document.permissionsPolicy`
// despite the rename of the header). WebKit and Gecko expose no equivalent, so
// they get no early answer and fall back to SENSOR_SETTLE_MS. Only the
// accelerometer is consulted: it is required for any gravity reading at all,
// while a gyroscope-only withholding is left to the settle check rather than
// risking a false "no sensor" on a phone that would have worked.
function sensorPolicyBlocked() {
  const fp = typeof document !== 'undefined' && document.featurePolicy;
  if (!fp || typeof fp.allowsFeature !== 'function') return null;
  try { return !fp.allowsFeature('accelerometer'); } catch (_) { return null; }
}

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
    // unknown | granted | denied | unsupported. 'unsupported' means THIS PAGE
    // cannot get tilt, however that came about, because nothing downstream can
    // act on the difference: startup falls back to buttons (main.js) and the
    // settings card disables Tilt (modals.js) either way.
    //
    // Two ways in need no gesture, so both resolve right here, before any
    // permission flow: no DeviceOrientationEvent constructor (no sensor, ever),
    // or a permissions policy that withholds the sensors from this document.
    // The THIRD way can only be found by listening — see _settle.
    this.motionState = (typeof window !== 'undefined'
      && (!window.DeviceOrientationEvent || sensorPolicyBlocked() === true))
      ? 'unsupported' : 'unknown';

    // latest gravity unit vector in the device frame (overwritten each event;
    // the flat seed only stands in until the first reading arrives)
    this._g = { x: 0, y: 0, z: -1 };

    this.mode = 'tilt';    // 'tilt' | 'buttons' (see setMode)
    this._steer = 0;       // smoothed steer output (-1..1)
    this._key = 0;         // keyboard steer (-1/0/1)
    this._keyL = false; this._keyR = false;
    this._btnL = false; this._btnR = false; // on-screen ‹ › steer buttons (buttons mode)
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

  // Call from a user gesture (e.g. the Join tap). Resolves once the sensor has
  // been proved to deliver or not, so the returned state is final: callers can
  // switch steering mode off it without a second round.
  async enableMotion() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return this.motionState; // 'unsupported' since the constructor — nothing to request
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
    if (this.motionState === 'granted') {
      window.addEventListener('deviceorientation', this._onOrient);
      await this._settle();
    }
    return this.motionState;
  }

  // Permission is not delivery. A page can hold a granted listener that never
  // fires — an embedder withholding the sensors from the frame (the common one:
  // a cross-origin iframe with no `allow` for them), or hardware that simply
  // has no gyroscope — and downstream that is indistinguishable from having no
  // sensor, so resolve it to 'unsupported' rather than leave a dead steering
  // wheel in tilt mode. Waits for the first USABLE sample, so a working phone
  // pays a frame rather than the window — and a sample that lands after the
  // window still takes the verdict back (see _onOrient), so a slow sensor
  // costs a fallback, never a stranding.
  _settle() {
    if (this.haveTilt) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        clearTimeout(timer);
        window.removeEventListener('deviceorientation', onSample);
        resolve();
      };
      // _onOrient attached first, so for this very event it has already decided
      // whether the sample was usable. That matters: Chromium emits one
      // all-null deviceorientation event on sensorless hardware, and an event
      // count would read it as a working sensor.
      const onSample = () => { if (this.haveTilt) finish(); };
      timer = setTimeout(() => {
        if (!this.haveTilt) this.motionState = 'unsupported';
        finish();
      }, SENSOR_SETTLE_MS);
      window.addEventListener('deviceorientation', onSample);
    });
  }

  // NOTE (AirConsole): tilt here rides DeviceOrientation like everywhere else.
  // The SDK's device_motion relay (raw accelerometer posted into the iframe —
  // AirConsole's answer to browsers that block sensors in embedded frames) was
  // tried with a gravity-extraction filter and REMOVED 2026-08-13: the damped
  // feel wasn't worth a second input path. Git history has it (setGravity)
  // if AC-app tilt is ever required; until then those phones fall back to
  // button steering through the ordinary no-sensor flow.

  _onOrient(e) {
    if (e.beta == null && e.gamma == null) return;
    this.haveTilt = true;
    // A usable sample after _settle gave up means the sensor was slow, not
    // absent, so take the verdict back. Worth the line because 'unsupported' is
    // otherwise TERMINAL for the page load: the Settings Tilt row it disables is
    // the only way back to tilt, so a single over-eager timeout would strand a
    // working phone on buttons until a reload. The card re-reads motionState on
    // every open, so this is all the recovery needs. (Only reachable while the
    // listener is attached, i.e. permission was granted — the constructor's two
    // routes to 'unsupported' never attach one.)
    if (this.motionState === 'unsupported') this.motionState = 'granted';

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
    this._btnL = this._btnR = false; // a held ‹/› must not survive into the next race
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
    if (this.mode === 'buttons') {
      // Binary steering: no sensor, no smoothing — an edge IS the value.
      this._steer = 0;
    } else {
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
    }

    const s = clamp1(this._steer + this._key + this._btnSteer());
    const b = Math.max(this._brakeBtn, this._brakeKey, this._btnBrake());
    // u is a wrapping use-counter: the display fires the held item once each time it
    // CHANGES, so it survives the fastlane's latest-wins drops (a dropped frame just
    // re-delivers the same value) without a separate reliable message.
    this.onControl({ s: +s.toFixed(3), b: +b.toFixed(3), u: this._useCount });
  }

  // The ‹ › buttons' contribution: ±1 while exactly one is held. Both held is
  // the BRAKE chord — steer reads centre so the car slows straight.
  _btnSteer() { return (this._btnR ? 1 : 0) - (this._btnL ? 1 : 0); }
  _btnBrake() { return this._btnL && this._btnR ? BRAKE_LEVEL : 0; }

  // current steer (for the on-screen steer indicator)
  get state() {
    return { steer: clamp1(this._steer + this._key + this._btnSteer()) };
  }

  // Steering input mode. Switching mid-hold releases the other mode's residue:
  // buttons → tilt keeps no stuck ±1, tilt → buttons drops the smoothed lean.
  setMode(mode) {
    this.mode = mode === 'buttons' ? 'buttons' : 'tilt';
    this._btnL = this._btnR = false;
    this._steer = 0;
    if (this._timer) this._tick();
  }

  // On-screen ‹ › steer buttons (buttons mode): held → full lock that side,
  // both → brake. Emits on the edge, same as every other button.
  pressSteer(side, on) {
    if (side === 'left') this._btnL = !!on; else this._btnR = !!on;
    if (this._timer) this._tick();
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

  // On-screen BRAKE button: held → brake at the fixed BRAKE_LEVEL, released → 0.
  // Emits on the edge — a brake press must not wait out the interval tick.
  pressBrake(on) {
    this._brakeBtn = on ? BRAKE_LEVEL : 0;
    if (this._timer) this._tick();
  }

  // Enable/disable ACTION — mirrors the held-item slot (main.js drives this from
  // setHeldItem). Gates BOTH input paths (on-screen button AND keyboard) so a press
  // with no item can't bump the counter and ghost-fire at the next race's start.
  setActionEnabled(on) { this._actionEnabled = !!on; }

  // ACTION button: one tap = one item use. Bump the wrapping counter on the press
  // edge and emit immediately — the display fires the held item once per counter
  // change. No-op when no item is held (see setActionEnabled).
  pressAction() {
    if (!this._actionEnabled) return;
    this._useCount = (this._useCount + 1) & 255;
    if (this._timer) this._tick();
  }
}
