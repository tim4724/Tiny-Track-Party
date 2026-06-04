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
  straight: () => straightPiece('track-wide-straight'),
  cornerL: () => cornerLeftPiece('track-wide-corner-small', R_SMALL),
  cornerLargeL: () => cornerLeftPiece('track-wide-corner-large', R_LARGE),
  curve: () => curvePiece('track-wide-curve')
};

// A drivable centerline: closed polyline of frames (pos, tangent, up, lateral)
// with cumulative arclength. sampleAt(s) interpolates, wrapping at the lap line.
export class Centerline {
  constructor(samples, length) {
    this.samples = samples;     // [{pos, tangent, up, lateral, s}]
    this.length = length;
  }
  sampleAt(s) {
    const len = this.length;
    s = ((s % len) + len) % len;
    const a = this.samples;
    // linear scan is fine (a few hundred points); could binary search later.
    let i = 0;
    while (i < a.length - 1 && a[i + 1].s <= s) i++;
    const p0 = a[i], p1 = a[(i + 1) % a.length];
    const segLen = (p1.s > p0.s ? p1.s : len) - p0.s || 1e-6;
    const f = (s - p0.s) / segLen;
    return {
      pos: p0.pos.clone().lerp(p1.pos, f),
      tangent: p0.tangent.clone().lerp(p1.tangent, f).normalize(),
      up: p0.up.clone().lerp(p1.up, f).normalize(),
      lateral: p0.lateral.clone().lerp(p1.lateral, f).normalize()
    };
  }
}

// Build the track. `pieceList` is an array of PIECES keys. Returns
// { instances:[{glb, matrix}], centerline, length, closed, gap }.
export function buildTrack(pieceList) {
  let cursor = new THREE.Matrix4(); // start at world origin, +Z travel
  const startCursor = cursor.clone();
  const instances = [];
  const worldPts = [];

  const tmpInv = new THREE.Matrix4();
  for (const key of pieceList) {
    const spec = PIECES[key]();
    const place = cursor.clone().multiply(tmpInv.copy(spec.entry).invert());
    instances.push({ glb: spec.glb, matrix: place.clone() });

    // append centerline points (skip first of each piece after the first to
    // avoid duplicate vertices at joints)
    const start = worldPts.length === 0 ? 0 : 1;
    for (let i = start; i < spec.points.length; i++) {
      worldPts.push(spec.points[i].clone().applyMatrix4(place));
    }
    cursor = place.clone().multiply(spec.exit);
  }

  // Closure check: how far is the final cursor from where we started?
  const gap = new THREE.Vector3().setFromMatrixPosition(cursor)
    .distanceTo(new THREE.Vector3().setFromMatrixPosition(startCursor));
  const closed = gap < 0.5;

  // If closed, drop the last point (coincides with the first) so the loop is seamless.
  if (closed && worldPts.length > 1) worldPts.pop();

  // Build samples with tangents (central differences around the loop), up=+Y,
  // lateral = tangent × up, and cumulative arclength.
  const n = worldPts.length;
  const samples = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    const prev = worldPts[(i - 1 + n) % n];
    const next = worldPts[(i + 1) % n];
    const tangent = next.clone().sub(prev).normalize();
    const up = v(0, 1, 0);
    const lateral = tangent.clone().cross(up).normalize();
    if (i > 0) s += worldPts[i].distanceTo(worldPts[i - 1]);
    samples.push({ pos: worldPts[i].clone(), tangent, up, lateral, s });
  }
  const length = s + worldPts[n - 1].distanceTo(worldPts[0]); // close the loop

  return { instances, centerline: new Centerline(samples, length), length, closed, gap, roadWidth: ROAD_WIDTH };
}

// A simple closed oval: long sides (4 straights) + short sides (2), 4 left
// corners → counter-clockwise rectangle that auto-closes.
export const OVAL = [
  'straight', 'straight', 'straight', 'straight', 'cornerL',
  'straight', 'straight', 'cornerL',
  'straight', 'straight', 'straight', 'straight', 'cornerL',
  'straight', 'straight', 'cornerL'
];
