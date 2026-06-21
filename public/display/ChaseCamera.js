// ChaseCamera — the per-player spring chase camera. Sits behind the car's heading
// and looks just ahead of it, with the position and look-target damped so the view
// lags and swings smoothly behind through turns (the standard chase cam every kart
// racer uses). One per car; SceneRenderer renders the shared scene through each
// car's camera into its split-screen cell. Owns its own smoothing state + FOV, so
// the chase tuning lives in one place rather than smeared across the renderer's
// per-car bag.
import * as THREE from 'three';

// Close chase that sits LOW and just behind the car with a fairly tight lens, so
// the camera stays comfortable to drive rather than steeply top-down.
const CHASE_DIST = 1.35, CHASE_HEIGHT = 0.64, CHASE_LOOK = 1.5; // close, low, slight look-down (dolly'd ~33% nearer so the car reads bigger)
const CHASE_TGT_UP = 0.11;    // look point barely above the road → camera pitches onto the car
const CAM_POS_RATE = 7.0, CAM_TGT_RATE = 13.0; // damping speed per second (higher = snappier)
// The position spring lags the car by ~velocity/rate, so the faster you go the
// further back the camera sits — at full boost that lag alone shrinks the car more
// than the FOV/dist cues do. So the follow rate climbs with spd² (applied in
// update): fast straights/boosts tighten and stay glued (car stays big), while
// slow corners keep the low base rate and its loose swing-behind.
const CAM_POS_RATE_SPD = 13.0; // extra follow rate per spd² (see above)
const CAM_RATE_SPD_MAX = 1.6;  // cap the spd feeding that term so a future >1.6 boost can't drive the cam toward rigid
const BASE_FOV = 55;          // camera FOV at rest — tighter lens, less wide-angle stretch
// Sense of speed (no shake): FOV widens and the chase camera stretches back with
// speed. `spd` is normalised to the car's own vmax but a BOOST raises v above it
// (spd reaches ~1.6), so both cues automatically over-extend during a boost — the
// kick is proportional to how fast you ACTUALLY go. The FOV response is asymmetric:
// it kicks wide fast (a boost lands as a hit) and eases back slow (running out of
// boost is a taper, not a snap).
const FOV_GAIN = 4;           // extra FOV degrees at top speed (~+6° at full boost) — trimmed so the car doesn't shrink at speed
const FOV_RISE = 9, FOV_FALL = 3; // FOV damping rates (1/s): fast in, slow out
const CHASE_DIST_GAIN = 0.06; // extra chase distance at full speed — a hint of pull-away (kept tiny: distance shrink is pure car-shrink, no speed-feel upside)

// PerspectiveCamera intrinsics for the toy-scale world. INIT_FOV is a placeholder —
// update() overwrites fov every frame before the cell ever renders; aspect is set
// per-cell in the render loop.
const NEAR = 0.1, FAR = 600, INIT_FOV = 62;

export class ChaseCamera {
  constructor() {
    this.camera = new THREE.PerspectiveCamera(INIT_FOV, 1, NEAR, FAR);
    this._pos = new THREE.Vector3();     // damped camera position
    this._target = new THREE.Vector3();  // damped look-at point
    this._want = new THREE.Vector3();    // scratch: this frame's ideal position
    this._wantTgt = new THREE.Vector3(); // scratch: this frame's ideal target
    this._init = false;                  // first update snaps (no lag-in from the origin)
    this._fov = BASE_FOV;
  }

  // Advance the spring one frame from the car's world pose + normalised speed.
  // `pose` is { pos, forward, up }; `spd` is normalised to vmax (exceeds 1 under boost).
  update(pose, spd, dt) {
    const { pos, forward, up } = pose;
    spd = spd || 0;
    // ideal pose: behind the CAR's heading, stretching further back with speed
    // (the car visibly pulls away from the camera as it accelerates), looking
    // just ahead of it.
    const dist = CHASE_DIST + CHASE_DIST_GAIN * spd;
    const want = this._want.copy(pos).addScaledVector(forward, -dist).addScaledVector(up, CHASE_HEIGHT);
    const target = this._wantTgt.copy(pos).addScaledVector(forward, CHASE_LOOK).addScaledVector(up, CHASE_TGT_UP);
    // frame-rate-independent damping → smooth lag/swing behind the car through turns.
    // Follow rate climbs with speed² (capped) so the spring lag (≈v/rate) doesn't
    // pull the car small at max speed; the quadratic keeps the rate near base through
    // slow corners (loose swing preserved) and only tightens on fast straights/boosts.
    const rateSpd = Math.min(spd, CAM_RATE_SPD_MAX);
    const aPos = 1 - Math.exp(-(CAM_POS_RATE + CAM_POS_RATE_SPD * rateSpd * rateSpd) * dt);
    const aTgt = 1 - Math.exp(-CAM_TGT_RATE * dt);
    if (!this._init) { this._pos.copy(want); this._target.copy(target); this._init = true; }
    else { this._pos.lerp(want, aPos); this._target.lerp(target, aTgt); }
    const cam = this.camera;
    cam.position.copy(this._pos);
    // sense of speed: widen FOV with speed (no shake) — fast attack so a boost
    // lands as a kick, slow release so it tapers off rather than snapping back.
    const fovTarget = BASE_FOV + spd * FOV_GAIN;
    const fovRate = fovTarget > this._fov ? FOV_RISE : FOV_FALL;
    this._fov += (fovTarget - this._fov) * (1 - Math.exp(-fovRate * dt));
    cam.fov = this._fov;
    cam.up.copy(up);
    cam.lookAt(this._target);
  }
}
