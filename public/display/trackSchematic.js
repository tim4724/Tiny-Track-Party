// Top-down schematic of a built track, as a normalized SVG path the controllers
// can render WITHOUT Three.js. We project the centerline to the X/Z plane, fit it
// to a padded square viewBox, and emit one closed path (the "map" of the loop).
//
// The display builds every track once at boot — buildTrack is pure geometry, so
// it needs no GLBs — and ships each map to phones in the room snapshot, packed by
// packSchematic (see the codec at the foot of this file). The phone unpacks it and
// drops the path into an <svg>: no geometry math, no assets, and the map updates
// automatically whenever a track's pieces change.

const VIEW = 256;   // viewBox square == the uint8 range: a coordinate IS a byte, so the
                    // snapshot codec (packSchematic) is an identity map, not a rescale.
const PAD = 30;     // inset (~12% of VIEW) so the stroke + start dot never clip at the edge

// trackSchematic(track) -> { viewBox, d, start:{x,y} }
//   track: the object returned by buildTrack() (uses track.centerline.samples).
export function trackSchematic(track) {
  const samples = (track.centerline && track.centerline.samples) || [];
  if (!samples.length) return { viewBox: `0 0 ${VIEW} ${VIEW}`, d: '', start: null };

  // Project to a top-down map: x across, z down. (Any consistent orientation
  // reads fine as a schematic.)
  const xs = samples.map((s) => s.pos.x);
  const zs = samples.map((s) => s.pos.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const scale = (VIEW - 2 * PAD) / span;
  // Center the (possibly non-square) extent inside the square viewBox.
  const offX = PAD + (VIEW - 2 * PAD - (maxX - minX) * scale) / 2;
  const offZ = PAD + (VIEW - 2 * PAD - (maxZ - minZ) * scale) / 2;
  // Rounding can produce -0 (e.g. +(-0.001).toFixed(2)), which JSON flattens to 0 —
  // so a baked schematic (gen-track-schematics.js) would never deepStrictEqual the
  // runtime value. Normalize it away everywhere a number leaves this module.
  const z0 = (n) => (n === 0 ? 0 : n);
  // 0..VIEW-1 space at 0.1 precision. Kept sub-integer on purpose: packSchematic
  // runs RDP on these SMOOTH points and only then rounds survivors to bytes —
  // rounding first would jitter straights by ±0.5 and defeat the simplification.
  // The projection keeps everything inside [PAD, VIEW-PAD]; clamp is belt-and-braces.
  const q = (n) => z0(+Math.max(0, Math.min(VIEW - 1, n)).toFixed(1));
  const px = (x) => q(offX + (x - minX) * scale);
  const pz = (z) => q(offZ + (z - minZ) * scale);

  let d = '';
  for (let i = 0; i < samples.length; i++) {
    d += (i === 0 ? 'M' : ' L') + px(xs[i]) + ' ' + pz(zs[i]);
  }
  d += ' Z';

  return {
    viewBox: `0 0 ${VIEW} ${VIEW}`,
    d,
    start: { x: px(xs[0]), y: pz(zs[0]) },
    // World→map projection, so overlays (the track-preview minimap) can plot LIVE
    // positions onto the same schematic: mapX = offX + (worldX - minX)·scale, and
    // likewise for z. Pure extra data — phones that only read viewBox/d/start ignore it.
    proj: { minX: z0(+minX.toFixed(2)), minZ: z0(+minZ.toFixed(2)), scale: z0(+scale.toFixed(4)), offX: z0(+offX.toFixed(2)), offZ: z0(+offZ.toFixed(2)) }
  };
}

// ---- snapshot transport codec ----
// A full loop is ~877 points (uniform-arclength, TrackBuilder DS) → ~180 KiB of
// SVG text, far past the relay's 16 KiB set_state cap. We ship a compact form:
//   1. SIMPLIFY with Ramer–Douglas–Peucker — keep the points that carry the shape
//      (corners) and drop collinear filler on straights. Uniform "every Nth point"
//      would instead spend equal budget everywhere and CHORD ACROSS hairpins.
//   2. PACK each surviving point as two bytes. Coordinates already live in 0..255
//      (VIEW), so this is just Math.round — a byte IS the coordinate, no rescale
//      (the only loss is ≤0.5 unit ≈ 0.5 px on a 256-wide map).
//   3. base64 so it rides the JSON set_state blob.
// The viewBox is the constant `0 0 VIEW VIEW` and `start` is just the first point,
// so neither is transmitted; unpackSchematic rebuilds both. Whole 20-track catalog
// lands ~2.6 KiB with sub-pixel corner fidelity (vs ~8 KiB / clipped at 24 points).
export const SCHEMATIC_EPS = 0.75; // max chord deviation kept, in viewBox units (≈ px at a 256-wide render)
const VBOX = `0 0 ${VIEW} ${VIEW}`;

function pathPoints(d) {
  if (!d) return [];
  return d.replace(/^M/, '').replace(/ Z$/, '').split(' L')
    .map((s) => { const [x, y] = s.trim().split(' '); return [+x, +y]; });
}

// Ramer–Douglas–Peucker on an OPEN polyline (both endpoints fixed — the loop's
// start point is meaningful: it's the grid). Iterative (no recursion depth risk).
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const ax = pts[i][0], ay = pts[i][1];
    const dx = pts[j][0] - ax, dy = pts[j][1] - ay, L2 = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let k = i + 1; k < j; k++) {
      const px = pts[k][0], py = pts[k][1];
      // perpendicular distance from point k to the chord i→j
      const dist = L2
        ? Math.abs((px - ax) * dy - (py - ay) * dx) / Math.sqrt(L2)
        : Math.hypot(px - ax, py - ay);
      if (dist > md) { md = dist; mi = k; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([i, mi], [mi, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// btoa/atob are global in browsers and Node ≥16, so this codec is shared by the
// display (pack), the controller (unpack) and Node tests without a Buffer branch.
function toB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function fromB64(b64) { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }

// Pack a full schematic → base64 string for the room snapshot (simplify, then 2
// bytes/point). Pass a smaller eps for a crisper map at more bytes.
export function packSchematic(s, eps = SCHEMATIC_EPS) {
  const pts = rdp(pathPoints(s && s.d), eps); // simplify the SMOOTH path, then quantize survivors
  const buf = new Uint8Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) { buf[i * 2] = Math.round(pts[i][0]) & 255; buf[i * 2 + 1] = Math.round(pts[i][1]) & 255; }
  return toB64(buf);
}

// Smooth CLOSED SVG path (Catmull-Rom → cubic Bézier) through pts=[[x,y],…]. The
// packed map is sparse (RDP kept ~50 points), so joining them with straight lines
// facets the curves; a spline THROUGH the same points renders smooth at zero extra
// wire cost — the corners RDP kept still anchor the shape, we just curve between
// them. Uniform Catmull-Rom, tension 1/6; the loop wraps (cyclic) so the closing
// segment is smooth too. Control-point coords rounded to 0.1 (DOM string only).
function smoothClosedPath(pts) {
  const n = pts.length;
  if (n < 3) return n ? 'M' + pts.map((p) => p.join(' ')).join(' L') + ' Z' : '';
  const P = (i) => pts[(i % n + n) % n];
  const r = (v) => Math.round(v * 10) / 10;
  let d = 'M' + P(0)[0] + ' ' + P(0)[1];
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ' C' + r(c1x) + ' ' + r(c1y) + ' ' + r(c2x) + ' ' + r(c2y) + ' ' + p2[0] + ' ' + p2[1];
  }
  return d + ' Z';
}

// Decode packSchematic → { viewBox, d, start }: exactly the shape schematicSvg
// renders (so the picker is unchanged — decoding is a pure transport concern).
// `d` is a smoothed spline through the packed points (see smoothClosedPath).
export function unpackSchematic(b64) {
  if (!b64) return { viewBox: VBOX, d: '', start: null };
  const b = fromB64(b64), n = b.length >> 1, pts = [];
  for (let i = 0; i < n; i++) pts.push([b[i * 2], b[i * 2 + 1]]);
  return { viewBox: VBOX, d: smoothClosedPath(pts), start: pts.length ? { x: pts[0][0], y: pts[0][1] } : null };
}
