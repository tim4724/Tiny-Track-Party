// TiltInput — phone steering + braking for the Tiny Track Party controller.
//
// Steering: DeviceOrientation `gamma` (left/right tilt in portrait), calibrated
// to a neutral capture, dead-zoned, clamped to ±FULL_LOCK°, normalised to
// [-1,1], low-pass smoothed. iOS 13+ needs requestPermission() from a user
// gesture (call enableMotion() in a tap handler). HTTPS is required for sensors.
//
// Braking: a held BRAKE button. Held → brake = BRAKE_LEVEL; the engine reads it
// as a target speed of (1 - BRAKE_LEVEL) × top speed, so a full hold (1) bleeds
// the car all the way down to a standstill.
//
// Fallbacks (no tilt / desktop / permission denied): arrow keys or A/D steer,
// Space/Down brake. Steer = tilt + keys (so the loop is testable headlessly).
// Emits {s,b} to onControl at ~25 Hz.

const SEND_HZ = 25;
const DEFAULT_LOCK = 28;   // degrees of tilt for full lock
const DEADZONE = 4;        // degrees ignored around neutral
const SMOOTH = 0.28;       // low-pass factor (higher = snappier)
const BRAKE_LEVEL = 1.0;   // held brake decelerates the car to a full stop

export class TiltInput {
  constructor({ onControl, surface }) {
    this.onControl = onControl || (() => {});
    this.surface = surface || document.body;
    this.fullLock = DEFAULT_LOCK;
    this.neutralGamma = 0;
    this.haveTilt = false;
    this.motionState = 'unknown'; // unknown | granted | denied | unsupported

    this._tilt = 0;        // smoothed normalized tilt steer
    this._rawTilt = 0;
    this._key = 0;         // keyboard steer (-1/0/1)
    this._keyL = false; this._keyR = false;
    this._brakeBtn = 0;    // brake from the on-screen BRAKE button (0 or BRAKE_LEVEL)
    this._brakeKey = 0;    // brake from keyboard (0 or BRAKE_LEVEL)
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
    if (e.gamma == null) return;
    this.haveTilt = true;
    this._rawTilt = e.gamma;
  }

  recenter() { this.neutralGamma = this._rawTilt; }

  setSensitivity(deg) { this.fullLock = Math.max(8, Math.min(60, deg)); }

  start() {
    if (this._timer) return;
    this.recenter();
    const interval = 1000 / SEND_HZ;
    this._timer = setInterval(() => this._tick(), interval);
  }
  stop() {
    clearInterval(this._timer); this._timer = null;
    this._brakeBtn = 0;
  }

  // Combined steer = smoothed tilt + keyboard, clamped. Brake = touch | key.
  _tick() {
    // tilt → normalized target
    let target = 0;
    if (this.haveTilt) {
      let d = this._rawTilt - this.neutralGamma;
      if (Math.abs(d) < DEADZONE) d = 0;
      else d = d - Math.sign(d) * DEADZONE;
      target = Math.max(-1, Math.min(1, d / (this.fullLock - DEADZONE)));
    }
    this._tilt += (target - this._tilt) * SMOOTH;

    const s = Math.max(-1, Math.min(1, this._tilt + this._key));
    const b = Math.max(this._brakeBtn, this._brakeKey);
    this.onControl({ s: +s.toFixed(3), b: +b.toFixed(3) });
  }

  // current state (for UI)
  get state() { return { steer: Math.max(-1, Math.min(1, this._tilt + this._key)), brake: Math.max(this._brakeBtn, this._brakeKey), tilt: this.haveTilt }; }

  // --- keyboard fallback / testing ---
  _bindKeys() {
    const set = (e, down) => {
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'a') { this._keyL = down; e.preventDefault(); }
      else if (k === 'arrowright' || k === 'd') { this._keyR = down; e.preventDefault(); }
      else if (k === 'arrowdown' || k === ' ' || k === 's') { this._brakeKey = down ? BRAKE_LEVEL : 0; e.preventDefault(); }
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
}
