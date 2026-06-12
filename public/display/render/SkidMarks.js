// Skidmark decal pool — tyre tracks laid under the wheels while cornering /
// curb-scrubbing / hard-braking / launching, fading to a lingering patina.
// See the cue notes in SceneRenderer.js for why these exist and what was
// rejected (dust, body vibration).
import * as THREE from 'three';
import { makeSkidTexture } from './textures.js';

const SKID_COLOR = 0x241f1c;       // near-black warm scuff
const SKID_MAX_OPACITY = 0.28;     // opacity of a fresh mark at full slip (hard scrub)
const SKID_THRESH = 0.2;           // |steer| at which tyres start to scuff (below this: no mark)
const SKID_LIFE = 1.2;             // seconds to fade down to the patina floor
const SKID_WIDTH = 0.12;           // fallback tyre-contact width; per-car width is measured in addCar
const SKID_SEG_MIN = 0.04;         // min wheel travel before laying the next stamp
const SKID_SEG_MAX = 1.5;          // gap bigger than this = a respawn/teleport → don't bridge it
// Rubber patina: a faded mark doesn't vanish — it settles at this fraction of its
// peak opacity and STAYS until its pool slot is recycled. Corners on the racing
// line get re-stamped every lap, so they accumulate visible rubber over a race
// (the track looks raced-on) while one-off marks eventually rotate out. All
// stamps live in ONE merged mesh with per-vertex alpha (single draw call —
// the old mesh-per-stamp pool put ~580 visible draw calls up during hard
// cornering), so lingering marks cost nothing extra. Starting value.
const SKID_PATINA = 0.22;          // lingering fraction of a mark's peak (~0.06 max alpha)
const SKID_POOL = 2048;            // stamp slots (ring buffer) — bounds the patina's memory
// Brake marks: slamming the brake at speed lays straight streaks under the rears
// (firing in sync with the nose dive — two contact channels on the same beat).
const SKID_BRAKE_MIN = 0.6;        // analog brake input where marks start; full brake = full mark
// Launch scratch: hard forward acceleration from near-standstill (race start,
// boost from slow) scratches faint marks — torque biting into the asphalt.
const SKID_LAUNCH_MIN = 0.5;       // accelNorm (smoothed d(spd)/dt vs full throttle) where it starts
export { SKID_WIDTH }; // addCar's fallback tyre-contact width

// Skidmark decals — flat quads laid on the road. ONE merged mesh with
// per-vertex RGBA (alpha animates the fade), so the whole rubber layer — live
// marks AND lingering patina — is a single draw call. The old mesh-per-stamp
// pool cost one draw call per visible mark (~580 during hard 4-car cornering)
// and forced marks to vanish to keep that count down; the merge removes both
// limits. A ring buffer recycles the oldest stamp when full.
export class SkidMarks {
  constructor(scene) {
    this._skidTex = makeSkidTexture();
    this._skidN = 0;
    // scratch vectors for orientation maths + the per-wheel travel measurement,
    // so the hot path allocates nothing per frame.
    this._skU = new THREE.Vector3();
    this._skF = new THREE.Vector3();
    this._skL = new THREE.Vector3();
    this._gpA = new THREE.Vector3();
    this._projV = new THREE.Vector3(); // scratch for the contact-patch projection
    this._segV = new THREE.Vector3();
    this._dirV = new THREE.Vector3();
    this._midV = new THREE.Vector3();
    // One BufferGeometry holding every stamp: 4 verts (12 floats pos / 16 floats
    // RGBA) + 6 indices per slot. RGB is SKID_COLOR baked per vertex (built via
    // THREE.Color so the sRGB hex lands in linear space exactly like the old
    // material.color did); alpha starts 0 (slot empty/invisible).
    const pos = new Float32Array(SKID_POOL * 4 * 3);
    const col = new Float32Array(SKID_POOL * 4 * 4);
    const uvA = new Float32Array(SKID_POOL * 4 * 2);
    const idx = new Uint32Array(SKID_POOL * 6);
    const rub = new THREE.Color(SKID_COLOR);
    for (let i = 0; i < SKID_POOL; i++) {
      for (let v = 0; v < 4; v++) {
        const ci = (i * 4 + v) * 4;
        col[ci] = rub.r; col[ci + 1] = rub.g; col[ci + 2] = rub.b; // alpha stays 0
      }
      // texture u runs ACROSS the width (the feathered axis), v along the length
      uvA.set([0, 0, 1, 0, 1, 1, 0, 1], i * 4 * 2);
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    this._skidPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._skidCol = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._skidPos);
    geo.setAttribute('color', this._skidCol);
    geo.setAttribute('uv', new THREE.BufferAttribute(uvA, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this._skidLife = new Float32Array(SKID_POOL); // >0: fading toward the patina floor
    this._skidPeak = new Float32Array(SKID_POOL); // 0: slot empty (alpha already 0)
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: this._skidTex, vertexColors: true, transparent: true, depthWrite: false,
      // pull the decals toward the camera in depth so they never z-fight the road
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    }));
    mesh.frustumCulled = false; // stamps span the whole track — always in view anyway
    scene.add(mesh);
    this._skidMesh = mesh;
  }

  // Wipe every skid mark + the accumulated patina (track change / fresh race).
  clear() {
    const col = this._skidCol.array;
    for (let i = 0; i < SKID_POOL; i++) {
      this._skidLife[i] = 0; this._skidPeak[i] = 0;
      for (let v = 0; v < 4; v++) col[(i * 4 + v) * 4 + 3] = 0;
    }
    this._skidCol.needsUpdate = true;
    this._skidN = 0;
  }

  // Lay one skid stamp centred at world `mid`, lying in the road plane
  // (normal = up) with its length along `dir` (a unit travel direction).
  // `width` is the car's tyre-contact width; `strength` (0..1) scales peak
  // opacity; `length` spans the wheel's last→now travel so consecutive stamps
  // butt together into one seamless ribbon. Writes the next ring-buffer slot's
  // 4 vertices in place (recycling the oldest mark/patina when the pool wraps).
  emitSeg(mid, up, dir, length, width, strength) {
    // basis: L → lateral (texture u, feathered), F → travel-in-plane, U → road up
    this._skU.copy(up).normalize();
    this._skF.copy(dir).addScaledVector(this._skU, -dir.dot(this._skU));
    if (this._skF.lengthSq() < 1e-9) return;             // travel parallel to up (shouldn't happen)
    this._skF.normalize();
    this._skL.copy(this._skF).cross(this._skU);          // L = F × U  (right-handed)
    const i = this._skidN;
    this._skidN = (this._skidN + 1) % SKID_POOL;
    const pos = this._skidPos.array, col = this._skidCol.array;
    const cx = mid.x + this._skU.x * 0.006,              // a hair above the road
          cy = mid.y + this._skU.y * 0.006,
          cz = mid.z + this._skU.z * 0.006;
    const lx = this._skL.x * width / 2, ly = this._skL.y * width / 2, lz = this._skL.z * width / 2;
    const fx = this._skF.x * length / 2, fy = this._skF.y * length / 2, fz = this._skF.z * length / 2;
    // 4 corners matching the (0,0)(1,0)(1,1)(0,1) UVs: −L−F, +L−F, +L+F, −L+F
    let p = i * 4 * 3;
    pos[p++] = cx - lx - fx; pos[p++] = cy - ly - fy; pos[p++] = cz - lz - fz;
    pos[p++] = cx + lx - fx; pos[p++] = cy + ly - fy; pos[p++] = cz + lz - fz;
    pos[p++] = cx + lx + fx; pos[p++] = cy + ly + fy; pos[p++] = cz + lz + fz;
    pos[p++] = cx - lx + fx; pos[p++] = cy - ly + fy; pos[p]   = cz - lz + fz;
    const peak = SKID_MAX_OPACITY * strength;
    for (let v = 0; v < 4; v++) col[(i * 4 + v) * 4 + 3] = peak;
    this._skidLife[i] = SKID_LIFE;
    this._skidPeak[i] = peak;
    this._skidPos.needsUpdate = true;
    this._skidCol.needsUpdate = true;
  }

  step(dt) {
    const col = this._skidCol.array;
    let dirty = false;
    for (let i = 0; i < SKID_POOL; i++) {
      if (this._skidLife[i] <= 0) continue;            // empty, or already settled patina
      this._skidLife[i] -= dt;
      // linear fade from peak down to the patina floor, where the mark settles
      // (it stays until the ring buffer recycles the slot — see SKID_PATINA)
      const k = Math.max(this._skidLife[i] / SKID_LIFE, 0);
      const a = this._skidPeak[i] * (SKID_PATINA + (1 - SKID_PATINA) * k);
      for (let v = 0; v < 4; v++) col[(i * 4 + v) * 4 + 3] = a;
      dirty = true;
    }
    if (dirty) this._skidCol.needsUpdate = true;
  }

  // SKIDMARK ribbon. Each rear wheel's contact point is tracked CONTINUOUSLY
  // while moving (so a new mark only ever bridges one short segment — no gaps),
  // but a mark's opacity ramps smoothly from ZERO at the scuff threshold: a dead-
  // straight cruise leaves nothing (the contact shadow grounds it there), gentle
  // bends fade in faintly, and hard cornering / curb grinding marks clearly.
  // Stamps are laid end-to-end (no overlap, so faint quads don't stack into
  // darker blobs) at the car's tyre width → one even ribbon along the exact
  // wheel path at any speed.
  layTrails(cars) {
    for (const c of cars.values()) {
      if (!c.pose) continue;
      const spd = c.spd || 0;                                // normalised 0..1 (per-car top speed)
      if (spd <= 0.05 && !c.scrub) {
        // stopped: forget every wheel's last contact so we never bridge across a stop
        if (c.backWheels) for (const w of c.backWheels) w.userData.skidLast = null;
        if (c.frontWheels) for (const w of c.frontWheels) w.userData.skidLast = null;
        continue;
      }
      const up = c.pose.up;
      const turn = Math.min(1, Math.abs(c.steerAmt || 0));   // how hard we're cornering
      // slip 0..1: 1 grinding the curb, else how far past the scuff threshold the corner is
      const slip = c.scrub ? 1 : Math.max(0, (turn - SKID_THRESH) / (1 - SKID_THRESH));
      // brake bite: slamming the analog brake at speed lays straight streaks, in
      // sync with the nose dive — the tyres visibly gripping the road to shed pace
      const brakeBite = ((c.brakeAmt || 0) > SKID_BRAKE_MIN && spd > 0.25)
        ? (c.brakeAmt - SKID_BRAKE_MIN) / (1 - SKID_BRAKE_MIN) : 0;
      // launch scratch: hard forward acceleration from near-standstill (race
      // start, boost from slow) — faint marks of torque biting in, fading out as
      // the car gets rolling
      const launch = ((c.accelNorm || 0) > SKID_LAUNCH_MIN && spd < 0.5)
        ? Math.min(1, (c.accelNorm - SKID_LAUNCH_MIN) / (1 - SKID_LAUNCH_MIN)) * (1 - spd / 0.5) * 0.6 : 0;
      const strength = c.scrub ? 1 : Math.min(1, Math.max(slip * 1.3, brakeBite, launch)); // 0 at threshold → smooth fade-in
      c.group.updateWorldMatrix(false, true); // fresh wheel world transforms
      // curb grind marks all four wheels; otherwise just the loaded rears (clear
      // the fronts so a later scrub doesn't bridge from a stale spot)
      const wheels = c.scrub ? c.allWheels : c.backWheels;
      if (!c.scrub && c.frontWheels) for (const w of c.frontWheels) w.userData.skidLast = null;
      for (const w of wheels) {
        // wheel position dropped onto the road plane under the car = contact patch
        const gp = w.getWorldPosition(this._gpA);
        gp.addScaledVector(up, -this._projV.copy(gp).sub(c.pose.pos).dot(up));
        // `last` is a live reference to w.userData.skidLast, so last.copy(...) below
        // advances the stored point in place.
        let last = w.userData.skidLast;
        if (!last) { w.userData.skidLast = gp.clone(); continue; } // first contact: seed it
        const seg = this._segV.copy(gp).sub(last);
        const dist = seg.length();
        if (dist < SKID_SEG_MIN) continue;                  // not moved enough yet — accumulate
        if (dist > SKID_SEG_MAX) { last.copy(gp); continue; } // respawn/teleport — don't streak across it
        // only draw if the corner is hard enough to scuff; otherwise just keep the
        // contact point marching forward so the next real mark bridges one segment
        if (strength > 0.02) {
          const dir = this._dirV.copy(seg).multiplyScalar(1 / dist);
          const mid = this._midV.copy(last).addScaledVector(seg, 0.5);
          this.emitSeg(mid, up, dir, dist, c.skidWidth, strength); // end-to-end, no overlap
        }
        last.copy(gp); // always advance (even on a straight) → next mark starts adjacent
      }
    }
  }
}
