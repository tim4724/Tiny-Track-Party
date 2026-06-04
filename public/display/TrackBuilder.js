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

const Y = -0.9;            // DRIVING-SURFACE height (road floor between curbs).
                           // NB: -0.7 is the curb top; cars sit on -0.9 or they float.
const L = 4.37;            // straight connector span (Z: -0.185 .. 4.185)
const Z0 = -0.185;         // entry connector Z
const R_SMALL = 2.185;     // corner-small turn radius
const R_LARGE = 4.185;     // corner-large turn radius
const ROAD_WIDTH = 1.8;    // wide road DRIVABLE width (between curbs); full slab is 2.0
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

// ---- Piece registry. Each piece returns local entry/exit frames + a polyline
// of local centerline points (entry → exit inclusive). ----
function straightPiece(glb, len = L) {
  const pts = [];
  const N = 6;
  for (let i = 0; i <= N; i++) pts.push(v(0, Y, Z0 + (len) * (i / N)));
  return {
    glb,
    entry: frame(v(0, Y, Z0), v(0, 0, 1)),
    exit: frame(v(0, Y, Z0 + len), v(0, 0, 1)),
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
    entry: frame(v(0, Y, Z0), v(0, 0, 1)),
    exit: frame(v(cx, Y, cz + R), v(-1, 0, 0)),
    points: pts
  };
}

// S-bend lane shift: +Z in and out, lateral -2 in X over the span.
function curvePiece(glb) {
  const shift = -2, N = 14, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const sm = t * t * (3 - 2 * t); // smoothstep
    pts.push(v(shift * sm, Y, Z0 + L * t));
  }
  return {
    glb,
    entry: frame(v(0, Y, Z0), v(0, 0, 1)),
    exit: frame(v(shift, Y, Z0 + L), v(0, 0, 1)),
    points: pts
  };
}

export const PIECES = {
  straight: () => straightPiece('track-road-wide-straight'),
  cornerL: () => cornerLeftPiece('track-road-wide-corner-small', R_SMALL),
  cornerLargeL: () => cornerLeftPiece('track-road-wide-corner-large', R_LARGE),
  curve: () => curvePiece('track-road-wide-curve')
};

// A drivable centerline: closed polyline of frames (pos, tangent, up, lateral)
// with cumulative arclength. sampleAt(s) interpolates, wrapping at the lap line.
//
// Position is interpolated with a CATMULL-ROM spline (not linearly): the raw
// polyline is an inscribed polygon, so linear interp makes the car travel in
// straight chords that kink at every vertex — its heading rotates smoothly but
// its path direction jumps ~1° at each sample, an ~10 Hz shimmy through curves.
// The spline gives a C1-smooth path, and we return its OWN derivative as the
// tangent so the car's facing and its direction of travel agree by construction.
export class Centerline {
  constructor(samples, length) {
    this.samples = samples;     // [{pos, tangent, up, lateral, s}]
    this.length = length;
  }
  sampleAt(s) {
    const len = this.length;
    s = ((s % len) + len) % len;
    const a = this.samples, n = a.length;
    // linear scan is fine (a few hundred points); could binary search later.
    let i = 0;
    while (i < n - 1 && a[i + 1].s <= s) i++;

    // Four-point stencil around the segment [i, i+1], wrapping the closed loop.
    // Arclengths are unwrapped relative to the segment start so they stay
    // monotonic across the start/finish seam.
    const idx = (k) => ((k % n) + n) % n;
    const pA = a[idx(i - 1)], pB = a[i], pC = a[idx(i + 1)], pD = a[idx(i + 2)];
    const sB = pB.s;
    let sA = pA.s, sC = pC.s, sD = pD.s;
    while (sA > sB) sA -= len;
    while (sC < sB) sC += len;
    while (sD < sC) sD += len;

    const h = (sC - sB) || 1e-6;
    const u = (s - sB) / h, u2 = u * u, u3 = u2 * u;
    // Non-uniform Catmull-Rom = cubic Hermite with finite-difference tangents
    // (per unit arclength) at the two knots; tangents scaled by the segment span.
    const mB = pC.pos.clone().sub(pA.pos).multiplyScalar(h / ((sC - sA) || 1e-6));
    const mC = pD.pos.clone().sub(pB.pos).multiplyScalar(h / ((sD - sB) || 1e-6));
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const pos = pB.pos.clone().multiplyScalar(h00)
      .addScaledVector(mB, h10).addScaledVector(pC.pos, h01).addScaledVector(mC, h11);
    // Derivative of the same curve → tangent (motion direction == facing).
    const g00 = 6 * u2 - 6 * u, g10 = 3 * u2 - 4 * u + 1;
    const g01 = -6 * u2 + 6 * u, g11 = 3 * u2 - 2 * u;
    const tangent = pB.pos.clone().multiplyScalar(g00)
      .addScaledVector(mB, g10).addScaledVector(pC.pos, g01).addScaledVector(mC, g11).normalize();

    const f = u;
    const up = pB.up.clone().lerp(pC.up, f).normalize();
    const lateral = tangent.clone().cross(up).normalize();
    return { pos, tangent, up, lateral };
  }
}

// Build the track. `pieceList` is an array of PIECES keys. Returns
// { instances:[{glb, matrix}], centerline, length, closed, gap }.
export function buildTrack(pieceList) {
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
  const SMOOTH_LAMBDA = 0.3, SMOOTH_PASSES = 4, ringN = worldPts.length;
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const ring = worldPts.map((p) => p.clone()); // Jacobi: read the pre-pass ring
    for (let i = 0; i < ringN; i++) {
      const a = ring[(i - 1 + ringN) % ringN], b = ring[(i + 1) % ringN];
      worldPts[i].lerp(a.clone().add(b).multiplyScalar(0.5), SMOOTH_LAMBDA);
    }
  }

  // Build samples with tangents (central differences around the loop), up=+Y,
  // lateral = tangent × up, and cumulative arclength.
  const n = worldPts.length;
  const samples = [];
  let s = 0, minY = Infinity;
  for (let i = 0; i < n; i++) {
    const prev = worldPts[(i - 1 + n) % n];
    const next = worldPts[(i + 1) % n];
    const tangent = next.clone().sub(prev).normalize();
    const up = v(0, 1, 0);
    const lateral = tangent.clone().cross(up).normalize();
    if (i > 0) s += worldPts[i].distanceTo(worldPts[i - 1]);
    minY = Math.min(minY, worldPts[i].y);
    samples.push({ pos: worldPts[i].clone(), tangent, up, lateral, s });
  }
  const length = s + worldPts[n - 1].distanceTo(worldPts[0]); // close the loop

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
