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

// The complementary filter behind setGravity (the AirConsole sensor relay —
// the DeviceOrientation path never touches these, the OS fused it already).
// Phone-only tuning knobs, so they live here, not in the STEER manifest.
const ORIENT_FRESH_MS = 1000;    // fused events this recent silence the relay
const ACCEL_G = 9.81;            // 1 g, what a motionless sample reads
const ACCEL_TRUST_BAND = 4;      // m/s² of |a|−g deviation at which trust hits 0
// With a calibrated gyro the accelerometer only anchors drift: ~0.8 s time
// constant at the 16 ms relay cadence — hand-motion contamination barely
// registers.
const ACCEL_CORRECT = 0.02;
// Not calibrated yet (boot, or a device without a gyro): the accel is the
// only signal, so correct at the old damped-filter rate instead.
const ACCEL_ONLY_CORRECT = 0.2;
// The scale estimator only learns from samples this close to 1 g (m/s²) —
// tighter than the trust band, because here the accel must BE gravity.
const ACCEL_CAL_BAND = 1.5;
// Calibration threshold on the estimator's denominator (Σ|gyro delta|²,
// raw-rate units): a single deliberate lean clears it for a rad/s source,
// one sample-burst for a deg/s source (57× the deltas, 3300× the energy).
const GYRO_CAL_DEN = 3e-3;
// Minimum fit quality (r²) to trust the calibration — separates a correct
// axis mapping (measured 0.2+ on real hand data) from a permuted one
// (measured 0.004) by a wide margin.
const GYRO_CAL_R2 = 0.05;

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
    //
    // EXCEPT on AirConsole, where neither route means what it says: the SDK's
    // device_motion relay is the sensor there (setGravity), and the frame is
    // expected to fail both checks. Stay 'unknown' and let the first relayed
    // sample resolve it to 'granted'.
    this.motionState = (typeof window !== 'undefined' && !window.airconsole
      && (!window.DeviceOrientationEvent || sensorPolicyBlocked() === true))
      ? 'unsupported' : 'unknown';

    // latest gravity unit vector in the device frame (overwritten each event;
    // the flat seed only stands in until the first reading arrives)
    this._g = { x: 0, y: 0, z: -1 };
    this._orientAt = 0;   // last fused DeviceOrientation event (0 = never)
    this._motionAt = 0;   // last relayed sensor sample (setGravity's dt clock)
    // The online gyro-scale estimator (see setGravity): num/den = the signed
    // scalar mapping raw relayed rates onto observed gravity motion.
    this._gyroNum = 0; this._gyroDen = 0; this._gyroObs = 0;
    this._aPrev = null;   // previous near-1g accel direction (estimator input)

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

  // External sensor feed, for AirConsole — the game is a cross-origin iframe
  // inside airconsole.com (browser) or the AC app's webview, and the embedder
  // delegates no motion sensors to the frame (verified on-device: the game
  // iframe's allow list is "autoplay; microphone; camera"), so
  // DeviceOrientation NEVER fires here. The SDK's top-level page reads the
  // sensors — it isn't in an iframe — and posts every sample in: accel =
  // accelerationIncludingGravity (flat face-up = +9.81 z), rates = the gyro
  // about the device axes (alpha: z, beta: x, gamma: y).
  //
  // The raw accelerometer is gravity + the hand's own motion, and taking it
  // verbatim rang the steer around centre; a plain low-pass damped the ring
  // but felt spongy. This is the COMPLEMENTARY FILTER instead — the same
  // shape as the OS fusion behind DeviceOrientation:
  //  - PREDICT from the gyro: rotate the gravity estimate by the body rates
  //    (a world-fixed vector seen from a rotating body evolves as
  //    dg/dt = −ω × g). The gyro is blind to linear acceleration, so this
  //    carries ALL the fast response with none of the wobble.
  //  - CORRECT from the accelerometer, slowly (ACCEL_CORRECT, further scaled
  //    by how close the sample is to 1 g) — it only anchors gyro drift.
  //
  // The rate UNITS AND SIGN are deliberately not assumed: the spec says
  // deg/s, Chrome on Android delivers rad/s (measured on a Pixel 7 — a 73°
  // roll integrated to 1.1 "degrees"), and what each AC app build relays is
  // unverified. One signed scalar absorbs all of it, ESTIMATED ONLINE by
  // correlating the gyro's predicted gravity motion against the motion the
  // accelerometer actually observed (least squares, accumulated only on
  // near-1g samples). A single deliberate lean locks it in; until then the
  // accel corrects at the fast rate (ACCEL_ONLY_CORRECT — also what a
  // gyro-less device permanently gets, and what makes boot acquisition
  // immediate).
  setGravity(ax, ay, az, ra, rb, rg) {
    // If real fused DeviceOrientation is somehow delivering (an embedder that
    // DOES delegate sensors), it owns gravity — never fight it with raw data.
    if (Date.now() - this._orientAt < ORIENT_FRESH_MS) return;
    const now = Date.now();
    const dt = Math.min(0.05, Math.max(0.008, (now - this._motionAt) / 1000));
    this._motionAt = now;
    const g = this._g;

    // The gyro's predicted gravity delta in RAW rate units (scale applied
    // only after calibration): dg = −(ω × g)·dt. AXIS MAPPING: rotationRate's
    // alpha/beta/gamma are the rates about x/y/z IN THAT ORDER — the mapping
    // browsers actually implement (measured on a Pixel 7: a pure roll about y
    // rode the beta channel at 0.93 correlation, and the full-capture fit put
    // the spec-text ordering at r²=0.004), documented as the cross-browser
    // implementation reality in the W3C geolocation list, 2017-08. If a
    // platform ever ships the other ordering, the r² gate below rejects the
    // calibration and tilt degrades to the damped accel-only mode rather
    // than engaging a garbage scale.
    const wx = ra || 0, wy = rb || 0, wz = rg || 0;
    const dxr = -(wy * g.z - wz * g.y) * dt;
    const dyr = -(wz * g.x - wx * g.z) * dt;
    const dzr = -(wx * g.y - wy * g.x) * dt;

    const n = Math.hypot(ax, ay, az);
    const nearG = n > 1 && Math.abs(n - ACCEL_G) < ACCEL_CAL_BAND;

    // Online scale estimation: on consecutive near-1g samples the accel IS
    // the gravity direction, so its frame-to-frame delta is the observed
    // motion the gyro delta should explain — accumulate the least-squares
    // ratio between the two. The predicted delta here is computed against the
    // PREVIOUS ACCEL DIRECTION, never against the filter's own estimate: the
    // estimate moves with the calibrated scale, and teaching the scale from a
    // reference it steers is a feedback loop (a drifted scale corrupts the
    // very data that should correct it — observed live as a sign flip).
    // Halving past the cap keeps the running sums finite, ratio preserved.
    if (nearG) {
      const adx = -ax / n, ady = -ay / n, adz = -az / n;
      const p = this._aPrev;
      if (p) {
        const ex = -(wy * p.z - wz * p.y) * dt;
        const ey = -(wz * p.x - wx * p.z) * dt;
        const ez = -(wx * p.y - wy * p.x) * dt;
        this._gyroNum += (adx - p.x) * ex + (ady - p.y) * ey + (adz - p.z) * ez;
        this._gyroDen += ex * ex + ey * ey + ez * ez;
        this._gyroObs += (adx - p.x) ** 2 + (ady - p.y) ** 2 + (adz - p.z) ** 2;
        if (this._gyroDen > 20) { this._gyroNum *= 0.5; this._gyroDen *= 0.5; this._gyroObs *= 0.5; }
      }
      this._aPrev = { x: adx, y: ady, z: adz };
    } else {
      this._aPrev = null; // never difference across an untrusted gap
    }

    const s = this._snappedScale();
    if (s !== null) {
      g.x += dxr * s; g.y += dyr * s; g.z += dzr * s;
    }
    const calibrated = s !== null;

    // Accel correct, trust-weighted by closeness to 1 g.
    if (n > 1) {
      this.haveTilt = true;
      this.motionState = 'granted';
      const base = calibrated ? ACCEL_CORRECT : ACCEL_ONLY_CORRECT;
      const k = base * Math.max(0, 1 - Math.abs(n - ACCEL_G) / ACCEL_TRUST_BAND);
      if (k > 0) {
        g.x += (-ax / n - g.x) * k;
        g.y += (-ay / n - g.y) * k;
        g.z += (-az / n - g.z) * k;
      }
    }

    // Predict and correct both bend the length; keep the direction, restore
    // unit length so the roll math downstream reads clean gravity.
    const m = Math.hypot(g.x, g.y, g.z) || 1;
    g.x /= m; g.y /= m; g.z /= m;
    if (this._timer) this._tick();
  }

  // The scale the predict step actually applies, or null while uncalibrated.
  // The raw least-squares magnitude is attenuation-biased (noise in the accel
  // reference shrinks it, measured 0.4–0.8x of truth depending on how hard
  // the hand swings), so the estimate is used only to CLASSIFY — sign, and
  // which unit family the source speaks — and the EXACT constant for that
  // family is applied. deg/s and rad/s sit 57x apart, far beyond any
  // attenuation, so the bands cannot be crossed by noise:
  //   |raw| in (0.004..0.08)  → deg/s source → ±π/180
  //   |raw| in (0.25..4)      → rad/s source → ±1
  // Anything else (including a wrong axis order, which lands near 0 and is
  // additionally rejected by the r² gate) stays uncalibrated — the damped
  // accel-only mode, functional if spongier.
  _snappedScale() {
    const ok = this._gyroDen > GYRO_CAL_DEN
      && (this._gyroNum * this._gyroNum) > GYRO_CAL_R2 * this._gyroDen * this._gyroObs;
    if (!ok) return null;
    const raw = this._gyroNum / this._gyroDen, m = Math.abs(raw);
    if (m > 0.004 && m < 0.08) return Math.sign(raw) * DEG;
    if (m > 0.25 && m < 4) return Math.sign(raw);
    return null;
  }

  // Diagnostic surface (tilt-lab): the applied (snapped) scale — ±π/180 for a
  // deg/s source, ±1 for rad/s — or null before a lean has calibrated it.
  gyroScale() { return this._snappedScale(); }

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
    this._orientAt = Date.now(); // fused events outrank the relay while fresh (setGravity returns early)

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
