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
// Min wheel travel per stamp. This is the pool's real budget knob: at 0.04 a fast wheel
// stamped EVERY FRAME (~650 stamps/s across a 4-car field), wrapping the ring buffer in
// ~3s — trails on a long sustained bend (the 450° spiral) were recycled in interleaved
// chunks by the cars behind while still on screen, leaving moth-eaten dashes (glaring
// on the playroom's bright deck). 0.25 (~4 stamps/u, texture is length-uniform) keeps
// the ribbon visually continuous while cutting emission ~4× (measured ~150 stamps/s).
const SKID_SEG_MIN = 0.25;
const SKID_SEG_MAX = 1.5;          // gap bigger than this = a respawn/teleport → don't bridge it
// Ribbon-continuity guard: consecutive stamps SHARE their joint edge (seamless on bends),
// but past this direction cosine (~72°) — the spin-out whirl doubling back on itself —
// a shared edge would fold the quad into a bowtie, so the ribbon breaks and butt-joins.
const SKID_EDGE_DOT = 0.3;
// Rubber patina: a faded mark doesn't vanish — it settles at this fraction of its
// peak opacity and STAYS until its pool slot is recycled. Corners on the racing
// line get re-stamped every lap, so they accumulate visible rubber over a race
// (the track looks raced-on) while one-off marks eventually rotate out. All
// stamps live in ONE merged mesh with per-vertex alpha (single draw call —
// the old mesh-per-stamp pool put ~580 visible draw calls up during hard
// cornering), so lingering marks cost nothing extra. Starting value.
const SKID_PATINA = 0.22;          // lingering fraction of a mark's peak (~0.06 max alpha)
// Stamp slots (ring buffer) — bounds the patina's memory. Sized WITH SKID_SEG_MIN so the
// ring outlives a lap under full 4-car scrubbing (still one draw call; ~1.4MB of buffers).
const SKID_POOL = 4096;
// Brake marks: slamming the brake at speed lays straight streaks under the rears
// (firing in sync with the nose dive — two contact channels on the same beat).
const SKID_BRAKE_MIN = 0.6;        // analog brake input where marks start; full brake = full mark
// Launch scratch: hard forward acceleration from near-standstill (race start,
// boost from slow) scratches faint marks — torque biting into the asphalt.
const SKID_LAUNCH_MIN = 0.5;       // accelNorm (smoothed d(spd)/dt vs full throttle) where it starts
// Scuff RELEASE: how long a mark takes to trail off once the wheel stops
// scuffing (seconds from full strength to nothing). Without it the marks come
// out CHOPPED on a bendy road: a bot weaving down a curvy stretch crosses the
// scuff threshold every few frames and brushes the curb in between, so the
// ribbon is a run of hard-edged dashes — and worse, each dip DETACHES the
// ribbon (below), so the next mark starts with a fresh unjoined rear edge and
// the joints stack into dark bars on the bend. Holding the strength up through
// the dips keeps one continuous trail that simply fades where the scrub eased.
const SKID_RELEASE = 0.4;
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
    this._cA = new THREE.Vector3();    // stamp corner scratches: rear L/R, front L/R
    this._cB = new THREE.Vector3();
    this._cC = new THREE.Vector3();
    this._cD = new THREE.Vector3();
    // slot → the wheel-state currently growing in it. When the ring buffer wraps all
    // the way around onto a still-growing stamp, its wheel is detached first so two
    // writers never fight over one slot.
    this._growing = new Map();
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
    for (const st of this._growing.values()) st.slot = -1;
    this._growing.clear();
    this._skidCol.needsUpdate = true;
    this._skidN = 0;
  }

  // Claim the next ring-buffer slot for a growing stamp (recycling the oldest
  // mark/patina when the pool wraps — including another wheel's still-growing
  // stamp, which is detached first).
  _alloc(owner) {
    const i = this._skidN;
    this._skidN = (this._skidN + 1) % SKID_POOL;
    const prev = this._growing.get(i);
    if (prev) prev.slot = -1;
    this._growing.set(i, owner);
    return i;
  }

  // Stop growing a wheel's active stamp (it keeps fading like any finished mark).
  _detach(st) {
    if (st.slot < 0) return;
    this._growing.delete(st.slot);
    st.slot = -1;
  }

  // Forget a wheel's trail state entirely (car stopped / wheel set changed):
  // nothing may bridge from its stale contact point later.
  _resetWheel(w) {
    const st = w.userData.skid;
    if (st) { this._detach(st); st.seeded = false; st.hasEdge = false; }
  }

  // Write a stamp's 4 corners + alpha into slot `i`. Corner order matches the
  // (0,0)(1,0)(1,1)(0,1) UVs: rear-left, rear-right, front-right, front-left
  // (texture u feathers ACROSS the width, v runs rear→front).
  _writeSlot(i, rL, rR, fR, fL, strength) {
    const pos = this._skidPos.array, col = this._skidCol.array;
    let p = i * 4 * 3;
    pos[p++] = rL.x; pos[p++] = rL.y; pos[p++] = rL.z;
    pos[p++] = rR.x; pos[p++] = rR.y; pos[p++] = rR.z;
    pos[p++] = fR.x; pos[p++] = fR.y; pos[p++] = fR.z;
    pos[p++] = fL.x; pos[p++] = fL.y; pos[p]   = fL.z;
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

  // SKIDMARK ribbon. Each marking wheel grows its trail as a CONNECTED strip:
  // the stamp under the wheel stretches to the contact point EVERY frame (no lag
  // gap trailing the tyre), and when it reaches SKID_SEG_MIN it freezes and hands
  // its leading edge to the next stamp as its trailing edge. Sharing the joint
  // edge is what keeps bends clean — independently-oriented butt-joined quads
  // overlap on a curve's inside and the transparent alpha stacks into a dark bar
  // at every joint (a regular "chopped" banding, glaring on bright decks).
  // A mark's opacity ramps smoothly from ZERO at the scuff threshold: a dead-
  // straight cruise leaves nothing (the contact shadow grounds it there), gentle
  // bends fade in faintly; hard cornering, curb grinding, braking, launching and
  // spin-outs mark clearly.
  layTrails(cars, dt = 1 / 60) {
    for (const c of cars.values()) {
      if (!c.pose) continue;
      const spd = c.spd || 0;                                // normalised 0..1 (per-car top speed)
      if (spd <= 0.05 && !c.scrub) {
        // stopped: forget every wheel's contact so we never bridge across a stop
        if (c.backWheels) for (const w of c.backWheels) this._resetWheel(w);
        if (c.frontWheels) for (const w of c.frontWheels) this._resetWheel(w);
        continue;
      }
      const up = c.pose.up;
      const turn = Math.min(1, Math.abs(c.steerAmt || 0));   // how hard we're cornering
      // spin-out (oil, lightning): the car whirls while it slides — all four tyres
      // scrub sideways, scribbling loops under the spin. setCarPose stores the whirl.
      const spinning = Math.abs(c.spinAmt || 0) > 0.05;
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
      const raw = (c.scrub || spinning) ? 1 : Math.min(1, Math.max(slip * 1.3, brakeBite, launch)); // 0 at threshold → smooth fade-in
      // Attack instantly, release over SKID_RELEASE (see the constant): a scuff
      // that stops dead leaves a dash, so every burst tapers into the trail.
      c.skidHold = Math.max(raw, (c.skidHold || 0) - dt / SKID_RELEASE);
      const strength = c.skidHold;
      c.group.updateWorldMatrix(false, true); // fresh wheel world transforms
      // curb grind / spin-out marks all four wheels; otherwise just the loaded
      // rears (reset the fronts so a later scrub can't bridge from a stale spot).
      // The four-wheel channel releases on the same taper, so the fronts fade
      // out with the rears instead of stopping mid-mark.
      c.skidAllHold = (c.scrub || spinning) ? 1
        : Math.max(0, (c.skidAllHold || 0) - dt / SKID_RELEASE);
      const marksAll = c.skidAllHold > 0.02;
      const wheels = marksAll ? c.allWheels : c.backWheels;
      if (!marksAll && c.frontWheels) for (const w of c.frontWheels) this._resetWheel(w);
      for (const w of wheels) {
        // wheel position dropped onto the road plane under the car = contact patch
        const gp = w.getWorldPosition(this._gpA);
        gp.addScaledVector(up, -this._projV.copy(gp).sub(c.pose.pos).dot(up));
        let st = w.userData.skid;
        if (!st) {
          st = w.userData.skid = {
            last: new THREE.Vector3(),  // start of the growing stamp
            dir: new THREE.Vector3(),   // its travel direction (kink guard)
            edgeL: new THREE.Vector3(), // previous stamp's leading edge → shared joint
            edgeR: new THREE.Vector3(),
            hasEdge: false, seeded: false, slot: -1
          };
        }
        if (!st.seeded) { st.last.copy(gp); st.seeded = true; st.hasEdge = false; continue; } // first contact: seed it
        const seg = this._segV.copy(gp).sub(st.last);
        const dist = seg.length();
        if (dist > SKID_SEG_MAX) { this._detach(st); st.last.copy(gp); st.hasEdge = false; continue; } // respawn/teleport — don't streak across it
        if (strength <= 0.02) {
          // not scuffing: freeze whatever was growing (it fades from here) and keep
          // the contact marching forward so the next real mark starts adjacent
          this._detach(st);
          if (dist >= SKID_SEG_MIN) { st.last.copy(gp); st.hasEdge = false; }
          continue;
        }
        if (dist < 1e-4) continue;                          // no travel this frame
        const dir = this._dirV.copy(seg).multiplyScalar(1 / dist);
        // basis: L → lateral (texture u, feathered), F → travel-in-plane, U → road up
        this._skU.copy(up).normalize();
        this._skF.copy(dir).addScaledVector(this._skU, -dir.dot(this._skU));
        if (this._skF.lengthSq() < 1e-9) continue;          // travel parallel to up (shouldn't happen)
        this._skF.normalize();
        this._skL.copy(this._skF).cross(this._skU).multiplyScalar(c.skidWidth / 2); // L = F × U (right-handed)
        if (st.hasEdge && st.dir.dot(dir) < SKID_EDGE_DOT) st.hasEdge = false; // kink guard (see SKID_EDGE_DOT)
        const rL = this._cA, rR = this._cB, fL = this._cC, fR = this._cD;
        if (st.hasEdge) { rL.copy(st.edgeL); rR.copy(st.edgeR); } // seamless joint (already lifted)
        else {
          rL.copy(st.last).sub(this._skL).addScaledVector(this._skU, 0.006); // a hair above the road
          rR.copy(st.last).add(this._skL).addScaledVector(this._skU, 0.006);
        }
        fL.copy(gp).sub(this._skL).addScaledVector(this._skU, 0.006);
        fR.copy(gp).add(this._skL).addScaledVector(this._skU, 0.006);
        if (st.slot < 0) st.slot = this._alloc(st);
        this._writeSlot(st.slot, rL, rR, fR, fL, strength);
        st.dir.copy(dir);
        if (dist >= SKID_SEG_MIN) {
          // stamp full: freeze it and hand its leading edge to the next one
          this._detach(st);
          st.edgeL.copy(fL); st.edgeR.copy(fR); st.hasEdge = true;
          st.last.copy(gp);
        }
      }
    }
  }
}
