// TrackBuilder — integrates a list of parametric SEGMENTS into a drivable centerline
// ribbon the car physics follows AND the renderer sweeps the procedural road over
// (see SceneRenderer._buildRibbonRoad). There are no road meshes here — only geometry.
//
// A track is authored as a sequence of segments (see ../shared/tracks.js):
//   straight(length, opts)         — a run, optionally with a lateral S-shift (chicane),
//                                    an elevation `rise`, or a net-flat `bump`.
//   arc(radius, angleDeg, opts)    — a turn; angle>0 = LEFT, <0 = RIGHT; optional `rise`.
// We walk a scalar cursor (plan position, heading, elevation) forward, emitting samples
// at a uniform arclength step. Heading 0 = +Z travel; +heading turns toward -X (left).
// The frame's `up` is parallel-transported (rotation-minimizing) so it stays perpendicular
// through hills, and the start/finish twist (holonomy) is unwound so `up` doesn't jump
// at the seam. (Banking + variable width layer onto this in later passes.)
import * as THREE from 'three';
import { Centerline } from './Centerline.js';
// Track DEFINITIONS (the catalogue) live in a dependency-free data module so the
// gallery + tests can read them without pulling in Three.js. We re-export the few
// that callers still import via TrackBuilder; everything else imports from tracks.js.
import { TRACKS, TRACK_LIST } from '../shared/tracks.js';

const SCALE = 2;           // unscaled track units → world (bigger track, more room for cars)
const ROAD_WIDTH = 2.5;    // default drivable width (unscaled); ×SCALE = 5.0 world. The
                           // single source of truth, read by the physics (maxLat in Game.js)
                           // AND the procedural road ribbon in SceneRenderer.
const GATE_WIDTH = 1.55;   // gate-finish arch span (measured) — scaled up to span the road
const DS = 0.25;           // centerline sample step (unscaled) — uniform arclength spacing,
                           // a few× finer than a kerb stripe and well above the min-seg floor.

// SMOOTHERSTEP (Perlin): zero FIRST and SECOND derivative at the ends, so a grade eases
// its pitch on/off smoothly (a plain ramp snaps to full pitch the instant it starts).
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const smoothstep = (t) => t * t * (3 - 2 * t); // C1 ends — used for the chicane lateral shift
// Bank easing across a segment: 0 at both ends, full in the middle (ease in over the
// first BANK_RAMP, hold, ease out) — so a banked corner leans in/out smoothly and is
// flat where it meets a straight.
const BANK_RAMP = 0.35;
const bankWindow = (f) => f < BANK_RAMP ? smootherstep(f / BANK_RAMP)
  : f > 1 - BANK_RAMP ? smootherstep((1 - f) / BANK_RAMP) : 1;
const v = (x, y, z) => new THREE.Vector3(x, y, z);

// Plan-frame basis at heading θ: travel direction and lateral-LEFT direction (the
// inward normal of a left turn). d = dL/dθ, so rotating L by φ gives L(θ+φ) — which is
// what makes the closed-form arc below exact.
const dirX = (th) => -Math.sin(th), dirZ = (th) => Math.cos(th);
const latX = (th) => -Math.cos(th), latZ = (th) => -Math.sin(th);
const DEG = Math.PI / 180;

// Build the track. `track` is a bare segment array OR a catalogue descriptor
// ({ segments, width, ... }) from shared/tracks.js. `opts.startGate` (default true)
// straddles the start/finish line with the gate-finish arch.
// Returns { instances, centerline, length, closed, gap, roadWidth, groundY }.
// `instances` carries only non-road scenery GLBs to place (currently the start/finish
// gate); the road surface itself is generated procedurally from `centerline`.
export function buildTrack(track, opts = {}) {
  const { startGate = true } = opts;
  const segments = Array.isArray(track) ? track : (track && track.segments);
  if (!Array.isArray(segments)) {
    throw new Error('buildTrack: expected a segment array or a track descriptor with a .segments array');
  }
  const trackWidth = (track && !Array.isArray(track) && track.width) || ROAD_WIDTH;

  // Per-segment drivable width at local fraction f: a number (constant), an [a,b] taper,
  // or the track default. Carried per sample so the road can flare/pinch along the lap.
  const segWidth = (seg, f) => {
    const w = seg.width;
    if (w == null) return trackWidth;
    return Array.isArray(w) ? w[0] + (w[1] - w[0]) * f : w;
  };
  // Per-sample bank roll (radians, eased), signed to lean INTO the turn: a positive
  // `bank` on a left arc rolls `up` one way, on a right arc the other. Applied to the
  // frame after parallel-transport (a roll about the tangent), so it can't break closure.
  const segBank = (seg, f) => {
    if (!seg.bank) return 0;
    const sign = seg.kind === 'arc' ? Math.sign(seg.angle || 1) : 1;
    return seg.bank * DEG * bankWindow(f) * sign;
  };

  // ---- Forward integrate the centerline (unscaled plan coords) ----
  let X = 0, Z = 0, theta = 0, elev = 0;     // cursor
  const worldPts = [v(0, 0, 0)];             // start at origin; scaled to world after the walk
  const widths = [trackWidth];               // per-sample drivable width (unscaled), parallel to worldPts
  const banks = [0];                          // per-sample bank roll (radians), parallel to worldPts

  for (const seg of segments) {
    if (seg.kind === 'straight') {
      const len = seg.length, lat = seg.lateral || 0, rise = seg.rise || 0, bump = seg.bump || 0;
      const N = Math.max(1, Math.round(len / DS));
      const dx = dirX(theta), dz = dirZ(theta), lx = latX(theta), lz = latZ(theta);
      const x0 = X, z0 = Z, y0 = elev;
      for (let i = 1; i <= N; i++) {
        // Lateral shift eases with SMOOTHstep, not smootherstep: smootherstep zeroes the
        // 2nd derivative at both ends, so at a chicane's interior joint the turn-rate dwells
        // to ~0 (a hitch felt as a left-right "shift" mid-S). smoothstep carries a continuous
        // non-zero curvature through that joint, and its gentler peak slope (1.5 vs 1.875)
        // softens the swing. (rise/bump below stay smootherstep — grades want the C2 ends.)
        const f = i / N, off = lat * smoothstep(f);
        worldPts.push(v(
          x0 + dx * len * f + lx * off,
          y0 + rise * smootherstep(f) + bump * (1 - Math.cos(2 * Math.PI * f)) / 2,
          z0 + dz * len * f + lz * off
        ));
        widths.push(segWidth(seg, f)); banks.push(segBank(seg, f));
      }
      X = x0 + dx * len + lx * lat; Z = z0 + dz * len + lz * lat; elev = y0 + rise;
    } else if (seg.kind === 'arc') {
      const R = seg.radius, ang = (seg.angle || 0) * DEG, rise = seg.rise || 0;
      const sgn = Math.sign(ang) || 1, A = Math.abs(ang);
      const x0 = X, z0 = Z, y0 = elev, th0 = theta;
      // Exact arc: point(φ) = P0 + R·sgn·(L(θ0) − L(θ0+φ)), left/right via sgn.
      const N = Math.max(1, Math.round(R * A / DS));
      for (let i = 1; i <= N; i++) {
        const f = i / N, th = th0 + ang * f;
        worldPts.push(v(x0 + R * sgn * (latX(th0) - latX(th)), y0 + rise * smootherstep(f), z0 + R * sgn * (latZ(th0) - latZ(th))));
        widths.push(segWidth(seg, f)); banks.push(segBank(seg, f));
      }
      X = x0 + R * sgn * (latX(th0) - latX(th0 + ang));
      Z = z0 + R * sgn * (latZ(th0) - latZ(th0 + ang));
      theta = th0 + ang; elev = y0 + rise;
    } else {
      throw new Error(`Unknown segment kind "${seg && seg.kind}" (expected "straight" or "arc")`);
    }
  }

  // Closure: distance from the cursor back to the origin (unscaled). The last emitted
  // point IS the cursor, so on a closed loop it duplicates the start — drop it so the
  // ring has no zero-length seam segment (the wrap last→first then spans one step).
  const gap = Math.hypot(X, elev, Z);
  const closed = gap < 0.5;
  if (worldPts.length > 3 && worldPts[worldPts.length - 1].distanceTo(worldPts[0]) < DS) { worldPts.pop(); widths.pop(); banks.pop(); }

  // Scale positions + widths to world.
  for (const p of worldPts) p.multiplyScalar(SCALE);
  for (let i = 0; i < widths.length; i++) widths[i] *= SCALE;
  // Ease width transitions across segment joints so a flare/pinch ramps over a short
  // span instead of stepping at one sample (a few light wrapping-average passes).
  for (let pass = 0; pass < 3; pass++) {
    const w = widths.slice();
    for (let i = 0; i < widths.length; i++) {
      widths[i] = 0.5 * w[i] + 0.25 * (w[(i - 1 + widths.length) % widths.length] + w[(i + 1) % widths.length]);
    }
  }

  // (No position smoothing pass: clothoid arc transitions + the C2 chicane ease give a
  // curvature-continuous centreline by construction, so the old Laplacian — which also
  // rippled the steady arc and shrank the radius — is gone.)
  const n = worldPts.length;

  // Tangents via central differences around the closed ring.
  const tangents = [];
  for (let i = 0; i < n; i++) {
    tangents.push(worldPts[(i + 1) % n].clone().sub(worldPts[(i - 1 + n) % n]).normalize());
  }
  // Parallel-transport (rotation-minimizing frame) an `up` vector around the ring so the
  // ribbon carries REAL 3D orientation: ~+Y on flat track, tilting to stay perpendicular
  // through hills. Each step rotates `up` by the rotation that turns the previous tangent
  // into the current one, then re-orthogonalizes against drift.
  let up = v(0, 1, 0);
  up.addScaledVector(tangents[0], -up.dot(tangents[0]));
  if (up.lengthSq() < 1e-6) up = v(0, 0, 1).addScaledVector(tangents[0], -tangents[0].z);
  up.normalize();
  const ups = [up.clone()];
  for (let i = 1; i < n; i++) {
    const t0 = tangents[i - 1], t1 = tangents[i];
    const axis = t0.clone().cross(t1);
    const sin = axis.length();
    if (sin > 1e-8) {
      axis.multiplyScalar(1 / sin);
      up.applyAxisAngle(axis, Math.atan2(sin, Math.max(-1, Math.min(1, t0.dot(t1)))));
    }
    up.addScaledVector(t1, -up.dot(t1)).normalize();
    ups.push(up.clone());
  }
  // Unwind the residual twist (frame holonomy) evenly so `up` doesn't jump at the seam.
  const t0 = tangents[0];
  const resid = Math.atan2(ups[n - 1].clone().cross(ups[0]).dot(t0), ups[n - 1].dot(ups[0]));
  for (let i = 0; i < n; i++) {
    up.copy(ups[i]).applyAxisAngle(tangents[i], resid * (i / n));
    ups[i].copy(up);
  }
  // Banking: roll each frame about its tangent by the per-sample bank angle. This is the
  // last frame step, so `lateral = tangent × up` (computed below) tilts with the road and
  // the physics/car/ribbon all lean together. Banks ease to 0 at corner ends, so the seam
  // and straights stay upright (holonomy/upright tests hold for the tasteful ≤~12° used).
  for (let i = 0; i < n; i++) if (banks[i]) ups[i].applyAxisAngle(tangents[i], banks[i]);

  const samples = [];
  let s = 0, minY = Infinity;
  for (let i = 0; i < n; i++) {
    const tangent = tangents[i], u = ups[i];
    const lateral = tangent.clone().cross(u).normalize();
    if (i > 0) s += worldPts[i].distanceTo(worldPts[i - 1]);
    minY = Math.min(minY, worldPts[i].y);
    samples.push({ pos: worldPts[i].clone(), tangent, up: u, lateral, s, width: widths[i] });
  }
  const length = s + worldPts[n - 1].distanceTo(worldPts[0]); // close the loop

  const instances = [];
  // Start/finish gate: the gate-finish arch straddling the line at s=0, oriented across
  // the lane (X=lateral, Y=up, Z=travel), legs straddling the road onto the grass.
  if (startGate) {
    const g = samples[0];
    const LEG_OVERHANG = 0.9; // how far each leg lands beyond the road edge, onto the grass
    const GS = (trackWidth * SCALE + 2 * LEG_OVERHANG) / GATE_WIDTH; // straddle the full road
    const m = new THREE.Matrix4().makeBasis(g.lateral.clone(), g.up.clone(), g.tangent.clone());
    m.scale(new THREE.Vector3(GS, GS, GS));
    m.setPosition(g.pos.clone().addScaledVector(g.up, -0.02 * SCALE)); // a hair into the road
    instances.push({ glb: 'gate-finish', matrix: m });
  }

  return {
    instances,
    centerline: new Centerline(samples, length),
    length, closed, gap,
    roadWidth: trackWidth * SCALE,
    groundY: minY - 0.3 // grass plane just under the road
  };
}

// Track definitions + the named registry live in the dependency-free catalogue
// (../shared/tracks.js). Re-export what callers import via TrackBuilder: TRACKS
// (the tests) and TRACK_LIST (main.js + the lobby track picker).
export { TRACKS, TRACK_LIST };
