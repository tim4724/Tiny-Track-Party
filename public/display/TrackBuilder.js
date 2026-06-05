// TrackBuilder — turns a list of Kenney track pieces into (a) GLB placement
// matrices and (b) a drivable centerline ribbon the car physics follows.
//
// Pieces chain by connector frames: each piece has an ENTRY and EXIT frame in
// its own local space (+Z = travel direction, +Y = up). We keep a world "cursor"
// frame; for each piece we place it so its entry frame lands on the cursor, then
// advance the cursor to the piece's exit frame. Frames + arc geometry come from
// measuring the actual GLB vertices (see scripts/inspect-piece.js).
//
// Driving surface is local Y = -0.7 (the +Y face of the road slab). Connector
// nubs sit at Y = -0.975, a constant offset, so aligning surface frames aligns
// the pieces identically.
import * as THREE from 'three';
import { Centerline } from './Centerline.js';

const NUB_Y = -0.975;      // CONNECTOR-NUB height: where pieces physically mate.
                           // Frames MUST sit here so GLBs join seamlessly — the
                           // offset to the driving surface rotates into a GAP on
                           // pitched/looping pieces if the frame is placed higher.
const DRIVE_LIFT = 0.075;  // lift from the nub up to the driving surface
const Y = NUB_Y + DRIVE_LIFT; // = -0.9 DRIVING-SURFACE height (road floor between
                           // curbs). NB: -0.7 is the curb top; cars sit on -0.9.
const L = 4.37;            // straight connector span (Z: -0.185 .. 4.185)
const Z0 = -0.185;         // entry connector Z
const R_SMALL = 2.185;     // corner-small turn radius
const R_LARGE = 4.185;     // corner-large turn radius
const ROAD_WIDTH = 1.8;    // wide road DRIVABLE width (between curbs); full slab is 2.0
const GATE_WIDTH = 1.55;   // gate-finish arch span (measured) — scaled up to span the wide road
const SCALE = 2;           // uniform world scale — bigger track, more room for the cars
// Each connector nub protrudes ~0.185 past the road surface, so connector-to-
// connector placement leaves a ~0.37 gap between road tops. Overlap each piece
// into the previous by that much so the road is seamless (nubs interlock).
const OVERLAP = 0.37;

const v = (x, y, z) => new THREE.Vector3(x, y, z);

// Build a frame matrix from position + forward (+Z) + up (+Y).
function frame(pos, fwd, up = v(0, 1, 0)) {
  const z = fwd.clone().normalize();
  const x = up.clone().cross(z).normalize();
  const y = z.clone().cross(x).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(pos);
}

// Connector frame at the NUB. Pieces are authored along the DRIVING surface, but
// they physically mate at the connector nub, which sits DRIVE_LIFT below the road
// along the road normal (-up). Anchoring the frame there — not at the driving
// height — is what makes GLBs join seamlessly on pitched/looping pieces: a frame
// placed at driving height carries an offset that rotates into a GAP once the
// connector tilts out of horizontal (the cause of the broken loop).
function conn(driveAnchor, fwd, up = v(0, 1, 0)) {
  const u = up.clone().normalize();
  return frame(driveAnchor.clone().addScaledVector(u, -DRIVE_LIFT), fwd, u);
}

// ---- Piece registry. Each piece returns local entry/exit frames + a polyline
// of local centerline points (entry → exit inclusive). ----
function straightPiece(glb, len = L) {
  const pts = [];
  const N = 6;
  for (let i = 0; i <= N; i++) pts.push(v(0, Y, Z0 + (len) * (i / N)));
  return {
    glb,
    entry: conn(v(0, Y, Z0), v(0, 0, 1)),
    exit: conn(v(0, Y, Z0 + len), v(0, 0, 1)),
    points: pts
  };
}

// 90° left turn (+Z in, -X out). Arc center at (-R, _, Z0); sweep +X→+Z.
function cornerLeftPiece(glb, R) {
  const cx = -R, cz = Z0;
  const N = 16, pts = [];
  for (let i = 0; i <= N; i++) {
    const a = (Math.PI / 2) * (i / N);
    pts.push(v(cx + R * Math.cos(a), Y, cz + R * Math.sin(a)));
  }
  return {
    glb,
    entry: conn(v(0, Y, Z0), v(0, 0, 1)),
    exit: conn(v(cx, Y, cz + R), v(-1, 0, 0)),
    points: pts
  };
}

// S-bend lane shift: +Z in and out, `shift` lateral in X over the span,
// smoothstepped so it eases in and out. shift<0 drifts left, shift>0 right —
// `curveR` is just the mirror (see PIECES).
function curvePiece(glb, shift = -2) {
  const N = 14, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const sm = t * t * (3 - 2 * t); // smoothstep
    pts.push(v(shift * sm, Y, Z0 + L * t));
  }
  return {
    glb,
    entry: conn(v(0, Y, Z0), v(0, 0, 1)),
    exit: conn(v(shift, Y, Z0 + L), v(0, 0, 1)),
    points: pts
  };
}

// ---- 3D / elevation pieces ----
// Connector heights/radii are MEASURED from the GLB vertices (see
// scripts/inspect-piece.js + profile-piece.js). All are expressed at the Y=-0.9
// driving height so they chain against the flat pieces above.
const R_BEND = 2.16;         // straight-bend vertical-arc radius
const R_BEND_LARGE = 4.16;   // straight-bend-large vertical-arc radius
const HILL_FULL = 1.0;       // hill-complete / corner-ramp climb
const HILL_HALF = 0.5;       // hill-complete-half climb
const BUMP_AMP = 0.5;        // bump hump / dip amplitude

const smoothstep = (t) => t * t * (3 - 2 * t);

// Vertical quarter-loop: flat entry (+Z), exit pointing straight UP (+Y) with the
// road facing back (-Z). Four of these + a lateral curve make a loop-the-loop
// whose exit clears its entry. The arc lies in the local Y–Z plane about a centre
// on the NUB datum; the centreline rides the DRIVING arc (radius R - DRIVE_LIFT,
// the nub arc lifted toward centre), and conn() drops the connector frames back
// to the nub so the bend tiles mate exactly (the original frame-at-driving-height
// version left a gap that grew through the loop — the disconnected pieces).
function bendPiece(glb, R) {
  const cy = NUB_Y + R, cz = Z0;          // arc centre, on the nub datum
  const r = R - DRIVE_LIFT;               // driving-surface radius (lifted toward centre)
  const N = 12, pts = [];
  for (let i = 0; i <= N; i++) {
    const a = (Math.PI / 2) * (i / N);
    pts.push(v(0, cy - r * Math.cos(a), cz + r * Math.sin(a)));
  }
  return {
    glb,
    entry: conn(pts[0].clone(), v(0, 0, 1), v(0, 1, 0)),
    exit: conn(pts[N].clone(), v(0, 1, 0), v(0, 0, -1)), // heading +Y, road normal -Z
    points: pts
  };
}

// Gentle hump (net-flat ends): the road rises (bump-up) or dips (bump-down) by
// BUMP_AMP at the middle and returns to the entry height. A RAISED COSINE (not a
// plain sine) so the slope is ZERO at both connectors — a sine starts with a
// non-zero slope, kinking the road at every flat→bump joint (the bumpy ride).
function bumpPiece(glb, amp) {
  const N = 10, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push(v(0, Y + amp * (1 - Math.cos(2 * Math.PI * t)) / 2, Z0 + L * t));
  }
  return { glb, entry: conn(v(0, Y, Z0), v(0, 0, 1)), exit: conn(v(0, Y, Z0 + L), v(0, 0, 1)), points: pts };
}

// Straight ramp with FLAT ends at different heights (hill-complete / -half): the
// road eases up by `climb` over the span via a smoothstep, level at both ends.
function hillPiece(glb, climb) {
  const N = 12, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push(v(0, Y + climb * smoothstep(t), Z0 + L * t));
  }
  return { glb, entry: conn(v(0, Y, Z0), v(0, 0, 1)), exit: conn(v(0, Y + climb, Z0 + L), v(0, 0, 1)), points: pts };
}

// 90° left turn that also climbs by `climb`, level at both ends (corner-*-ramp).
function cornerRampPiece(glb, R, climb) {
  const cx = -R, cz = Z0, N = 16, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, a = (Math.PI / 2) * t;
    pts.push(v(cx + R * Math.cos(a), Y + climb * smoothstep(t), cz + R * Math.sin(a)));
  }
  return { glb, entry: conn(v(0, Y, Z0), v(0, 0, 1)), exit: conn(v(cx, Y + climb, cz + R), v(-1, 0, 0)), points: pts };
}

// Traverse a piece BACKWARD: its exit connector becomes the entry. A climbing
// piece thus becomes a descending one (same GLB, driven the other way), which is
// how the loop returns to ground level — the kit ships no dedicated "down" tiles.
function reverseSpec(spec) {
  const ex = new THREE.Vector3(), ey = new THREE.Vector3(), ez = new THREE.Vector3();
  const xx = new THREE.Vector3(), xy = new THREE.Vector3(), xz = new THREE.Vector3();
  spec.entry.extractBasis(ex, ey, ez);
  spec.exit.extractBasis(xx, xy, xz);
  const ePos = new THREE.Vector3().setFromMatrixPosition(spec.entry);
  const xPos = new THREE.Vector3().setFromMatrixPosition(spec.exit);
  // Use frame(), not conn(): these positions come straight off the already-conn'd
  // entry/exit matrices, so they sit at the nub already — no DRIVE_LIFT re-applied.
  return {
    glb: spec.glb,
    entry: frame(xPos, xz.clone().negate(), xy), // at old exit, travel reversed, same road normal
    exit: frame(ePos, ez.clone().negate(), ey),
    points: spec.points.slice().reverse()
  };
}

export const PIECES = {
  straight: () => straightPiece('track-road-wide-straight'),
  cornerL: () => cornerLeftPiece('track-road-wide-corner-small', R_SMALL),
  cornerLargeL: () => cornerLeftPiece('track-road-wide-corner-large', R_LARGE),
  curve: () => curvePiece('track-road-wide-curve'),
  curveR: () => curvePiece('track-road-wide-curve', 2), // mirror of curve
  // vertical quarter-arcs (loop-the-loop building blocks)
  bend: () => bendPiece('track-road-wide-straight-bend', R_BEND),
  bendLarge: () => bendPiece('track-road-wide-straight-bend-large', R_BEND_LARGE),
  // gentle humps (net-flat)
  bumpUp: () => bumpPiece('track-road-wide-straight-bump-up', BUMP_AMP),
  bumpDown: () => bumpPiece('track-road-wide-straight-bump-down', -BUMP_AMP),
  // straight ramps (flat ends, different heights) + their descents
  hillUp: () => hillPiece('track-road-wide-straight-hill-complete', HILL_FULL),
  hillDown: () => reverseSpec(hillPiece('track-road-wide-straight-hill-complete', HILL_FULL)),
  hillHalfUp: () => hillPiece('track-road-wide-straight-hill-complete-half', HILL_HALF),
  hillHalfDown: () => reverseSpec(hillPiece('track-road-wide-straight-hill-complete-half', HILL_HALF)),
  // ramped corners (turn + climb) + their descents
  rampCornerUp: () => cornerRampPiece('track-road-wide-corner-small-ramp', R_SMALL, HILL_FULL),
  rampCornerDown: () => reverseSpec(cornerRampPiece('track-road-wide-corner-small-ramp', R_SMALL, HILL_FULL)),
  rampCornerLargeUp: () => cornerRampPiece('track-road-wide-corner-large-ramp', R_LARGE, HILL_FULL),
  rampCornerLargeDown: () => reverseSpec(cornerRampPiece('track-road-wide-corner-large-ramp', R_LARGE, HILL_FULL)),
  // right turns (same GLBs driven backward) — for chicanes / closing the circuit
  cornerR: () => reverseSpec(cornerLeftPiece('track-road-wide-corner-small', R_SMALL)),
  cornerLargeR: () => reverseSpec(cornerLeftPiece('track-road-wide-corner-large', R_LARGE))
};

// Build the track. `pieceList` is an array of PIECES keys. `opts.startGate`
// (default true) straddles the start/finish line with the gate-finish arch.
// Returns { instances:[{glb, matrix}], centerline, length, closed, gap }.
// (The Centerline class lives in Centerline.js, imported above.)
export function buildTrack(pieceList, opts = {}) {
  const { startGate = true } = opts;
  let cursor = new THREE.Matrix4(); // start at world origin, +Z travel
  const startCursor = cursor.clone();
  const instances = [];
  const worldPts = [];

  // Uniform scale applied to both GLB placements and the centerline so they
  // stay consistent. Pieces chain in unscaled space (cursor), then scale out.
  const scaleM = new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE);
  const overlapBack = new THREE.Matrix4().makeTranslation(0, 0, -OVERLAP);
  const tmpInv = new THREE.Matrix4();
  for (const key of pieceList) {
    if (!PIECES[key]) throw new Error(`Unknown track piece "${key}" (valid: ${Object.keys(PIECES).join(', ')})`);
    const spec = PIECES[key]();
    const place = cursor.clone().multiply(tmpInv.copy(spec.entry).invert());
    instances.push({ glb: spec.glb, matrix: scaleM.clone().multiply(place) });

    // Append centerline points. Skip the leading points that fall within the
    // OVERLAP region (where this piece backs into the previous one), so the
    // centerline never steps backward at a joint. Skipping just one vertex is
    // not enough where the first segment is shorter than OVERLAP (corners are
    // sampled in equal angle steps → short first segment) — that back-step is
    // the "hiccup" felt entering curves.
    let start = 0;
    if (worldPts.length > 0) {
      start = 1;
      let acc = 0;
      for (let i = 1; i < spec.points.length; i++) {
        acc += spec.points[i].distanceTo(spec.points[i - 1]);
        if (acc >= OVERLAP) { start = i; break; }
      }
    }
    for (let i = start; i < spec.points.length; i++) {
      worldPts.push(spec.points[i].clone().applyMatrix4(place).multiplyScalar(SCALE));
    }
    // Advance to the exit, then pull back along travel so the NEXT piece overlaps
    // this one's connector region — closes the road-surface gap at every joint.
    cursor = place.clone().multiply(spec.exit).multiply(overlapBack);
  }

  // Closure check: how far is the final cursor from where we started?
  const gap = new THREE.Vector3().setFromMatrixPosition(cursor)
    .distanceTo(new THREE.Vector3().setFromMatrixPosition(startCursor));
  const closed = gap < 0.5;

  // If closed, trim trailing points that overshoot PAST the start point — the
  // overlap makes the final piece run a little past where the first piece began,
  // which would back-step when the loop wraps (the hiccup at the start/finish).
  if (closed && worldPts.length > 3) {
    const p0 = worldPts[0];
    const startTan = worldPts[1].clone().sub(p0).normalize();
    while (worldPts.length > 3 &&
           worldPts[worldPts.length - 1].clone().sub(p0).dot(startTan) > 0) {
      worldPts.pop();
    }
  }

  // Weld out degenerate-short segments. The OVERLAP skip and the closure trim
  // above each leave forward progress intact but can land a vertex a few cm from
  // its neighbour: a corner's first kept vertex falling just past the joint, or
  // the loop's final vertex landing almost on top of the first. The car crosses
  // such a stub in a single frame, snapping its tangent ~6° in one step — that's
  // the twitch felt entering a curve. Drop any vertex within MIN_SEG of its kept
  // predecessor (and the last vertex if it collapses onto the start). Every
  // intended sample spacing scales with SCALE and is far larger (the smallest,
  // a small-corner arc step, is ~0.43 world), so only joint/seam stubs are cut.
  const MIN_SEG = 0.125 * SCALE;
  const welded = [worldPts[0]];
  for (let i = 1; i < worldPts.length; i++) {
    if (worldPts[i].distanceTo(welded[welded.length - 1]) >= MIN_SEG) welded.push(worldPts[i]);
  }
  if (welded.length > 3 && welded[welded.length - 1].distanceTo(welded[0]) < MIN_SEG) welded.pop();
  worldPts.splice(0, worldPts.length, ...welded);

  // Round the CURVATURE step at every straight<->curve joint into a short ramp.
  // Pieces meet with discontinuous curvature (a straight's kappa=0 abuts an arc's
  // kappa=1/R). The spline that sampleAt fits through that step overshoots and
  // even briefly reverses curvature right at the joint — the car gets nudged the
  // wrong way then snaps back, the jitter felt entering a curve. A few light
  // Laplacian passes (nudge each point toward the midpoint of its neighbours)
  // spread the step over a short transition. Kept light so steady-corner
  // curvature is preserved and the racing line shifts only a few tenths of a unit.
  //
  // Smooth ONLY the horizontal plane (X, Z), and only on near-flat points. This
  // rounds the curvature step at flat straight↔corner joints (the original jitter
  // fix) WITHOUT touching the vertical profile. The elevation pieces author their
  // own C1-smooth height (raised-cosine bumps, smoothstep hills — all flat-ended),
  // so the centreline already rides the GLB road exactly; smoothing Y would only
  // pull it OFF the road at the bump/hill transitions (float then clip). Steep /
  // looping points are skipped so the vertical loop keeps its true radius.
  const SMOOTH_LAMBDA = 0.3, SMOOTH_PASSES = 4, ringN = worldPts.length;
  const at = (i) => worldPts[(i % ringN + ringN) % ringN];
  const steep = worldPts.map((_, i) => {
    const t = at(i + 1).clone().sub(at(i - 1));
    return Math.abs(t.y) > 0.3 * (t.length() || 1); // climbing/looping → leave the geometry alone
  });
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const ring = worldPts.map((p) => p.clone()); // Jacobi: read the pre-pass ring
    for (let i = 0; i < ringN; i++) {
      if (steep[i]) continue;
      const a = ring[(i - 1 + ringN) % ringN], b = ring[(i + 1) % ringN];
      worldPts[i].x += ((a.x + b.x) * 0.5 - worldPts[i].x) * SMOOTH_LAMBDA;
      worldPts[i].z += ((a.z + b.z) * 0.5 - worldPts[i].z) * SMOOTH_LAMBDA;
    }
  }

  // Build samples with tangents (central differences around the loop), up=+Y,
  // lateral = tangent × up, and cumulative arclength.
  const n = worldPts.length;
  // Tangents via central differences around the closed ring.
  const tangents = [];
  for (let i = 0; i < n; i++) {
    const prev = worldPts[(i - 1 + n) % n];
    const next = worldPts[(i + 1) % n];
    tangents.push(next.clone().sub(prev).normalize());
  }
  // Parallel-transport (rotation-minimizing frame) an `up` vector around the ring
  // so the ribbon carries REAL 3D orientation: it stays ~+Y on flat track, and
  // rotates with the road through a vertical loop (fully inverted at the top).
  // The old code hardcoded up=+Y — a flat-only assumption that can't represent a
  // loop-the-loop. Each step rotates `up` by the same rotation that turns the
  // previous tangent into the current one, then re-orthogonalizes against drift.
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
  // Any residual twist after a full lap (frame holonomy) would jump `up` at the
  // start/finish seam. Measure it (the signed angle, about the start tangent,
  // from the transported-back-to-start up to the initial up) and unwind it evenly
  // — rotating each frame about ITS OWN tangent keeps `up` perpendicular for free.
  const t0 = tangents[0];
  const resid = Math.atan2(ups[n - 1].clone().cross(ups[0]).dot(t0), ups[n - 1].dot(ups[0]));
  for (let i = 0; i < n; i++) {
    up.copy(ups[i]).applyAxisAngle(tangents[i], resid * (i / n));
    ups[i].copy(up);
  }

  const samples = [];
  let s = 0, minY = Infinity;
  for (let i = 0; i < n; i++) {
    const tangent = tangents[i];
    const u = ups[i];
    const lateral = tangent.clone().cross(u).normalize();
    if (i > 0) s += worldPts[i].distanceTo(worldPts[i - 1]);
    minY = Math.min(minY, worldPts[i].y);
    samples.push({ pos: worldPts[i].clone(), tangent, up: u, lateral, s });
  }
  const length = s + worldPts[n - 1].distanceTo(worldPts[0]); // close the loop

  // Start/finish gate: the gate-finish arch straddling the line at s=0. The kit's
  // gate is sized for the narrow track, so scale it to span the wide road and
  // orient it across the lane (X=lateral, Y=up, Z=travel), base on the surface.
  if (startGate) {
    const g = samples[0];
    // Scale the arch so its LEGS straddle the road on the grass — clear of the full
    // slab (2.0), not just the drivable width — and it reads as a grand bridge over
    // the wide track. GATE_WIDTH is the arch's measured outer leg-to-leg span.
    const SLAB_W = 2.0;       // wide piece's full outer width (drivable ROAD_WIDTH is 1.8)
    const LEG_OVERHANG = 0.9; // how far each leg lands beyond the slab edge, onto the grass
    const GS = (SLAB_W * SCALE + 2 * LEG_OVERHANG) / GATE_WIDTH; // span ~5.8
    const m = new THREE.Matrix4().makeBasis(g.lateral.clone(), g.up.clone(), g.tangent.clone());
    m.scale(new THREE.Vector3(GS, GS, GS));
    // Plant the legs at the ROAD surface (the gate model's origin is at its base), so
    // the arch sits at track level — not sunk to the grass plane, which is a slab-height
    // (~0.3) BELOW the road and made the gate read as lower than the track.
    m.setPosition(g.pos.clone().addScaledVector(g.up, -0.02 * SCALE)); // a hair into the road so it looks planted
    instances.push({ glb: 'gate-finish', matrix: m });
  }

  return {
    instances,
    centerline: new Centerline(samples, length),
    length, closed, gap,
    roadWidth: ROAD_WIDTH * SCALE,
    groundY: minY - 0.3 // grass plane just under the road slab
  };
}

// A simple closed oval: long sides (4 straights) + short sides (2), 4 large
// left corners (gentle radius → followable with a calm steering rate) → a
// counter-clockwise rectangle that auto-closes.
export const OVAL = [
  'straight', 'straight', 'straight', 'straight', 'cornerLargeL',
  'straight', 'straight', 'cornerLargeL',
  'straight', 'straight', 'straight', 'straight', 'cornerLargeL',
  'straight', 'straight', 'cornerLargeL'
];

// =====================================================================
// Track definitions. A track is just an ordered list of PIECES keys; the
// builder chains them by connector frames and auto-closes the loop. Compose
// reusable runs (a hill, a chicane) and splice them into a skeleton.
// =====================================================================

// "Grand Tour": the oval skeleton (4 large corners, auto-closing) with each
// straight swapped for a wide-road FEATURE (speed bumps, half-hill, full hill).
// Opposite sides match length so it closes like the oval, and every feature
// returns to ground level, so the lap is net-flat. The start/finish straight
// (gate) leads.
export const GRAND_TOUR = [
  // start/finish straight (gate here) → speed bumps   [4 straight-equivalents]
  'straight', 'straight', 'bumpUp', 'bumpDown', 'cornerLargeL',
  // short side: a half-height hill (up then down)     [2]
  'hillHalfUp', 'hillHalfDown', 'cornerLargeL',
  // far side: straights + a full hill                 [4]
  'straight', 'straight', 'hillUp', 'hillDown', 'cornerLargeL',
  // short side: more bumps                             [2]
  'bumpUp', 'bumpDown', 'cornerLargeL'
];

// Registry of named, previewable tracks (display: ?track=<name>).
export const TRACKS = {
  oval: OVAL,
  grand: GRAND_TOUR
};
