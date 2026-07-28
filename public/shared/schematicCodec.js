// schematicCodec.js — the track-map transport codec: the display PACKS a
// schematic into the room snapshot, the phone UNPACKS it into an <svg> path.
//
// SHARED because both halves of the party run it, and they are not the same
// program. The display side has a native twin — libttp-track/ttp/schematic.cc,
// reached through NativeSchematic.js — and the tvOS and Android shells will pack
// with that and never load this file. The PHONE side has no twin and never will:
// phones stay on the JS controller on all three TV platforms, so unpackSchematic
// is permanent browser code.
//
// That is why this is in shared/ rather than display/. It used to live in
// display/trackSchematic.js, which meant controller/main.js — the one part of
// the game guaranteed to stay JS forever — imported from the directory that is
// being replaced by three native shells.
//
// public/display/trackSchematic.js keeps the PROJECTION (buildTrack output -> a
// normalized SVG path). That half runs offline and is the oracle
// tests/fixtures/schematic-corpus.jsonl was recorded from; nothing ships it.

const VIEW = 256;   // viewBox square == the uint8 range: a coordinate IS a byte, so the
                    // codec below is an identity map, not a rescale.

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
// lands ~3.9 KiB (snapshot ~6.4 KiB, ~40% of the cap) — faithful to the full-res
// map (vs ~8 KiB / clipped at the old 24 uniform points).
//
// eps is tuned for FIDELITY, not just size: it's the max deviation (viewBox units ≈
// px at a 256-wide render) a kept point may sit from the true curve. Lower = more
// points = closer to the original. We have the byte budget, so this sits low enough
// (~74 pts/track avg) that straight segments reproduce the real shape — smoothing is
// deliberately NOT applied (see unpackSchematic for why it distorts more than it helps).
export const SCHEMATIC_EPS = 0.35;
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

// Decode packSchematic → { viewBox, d, start }: exactly the shape schematicSvg
// renders (so the picker is unchanged — decoding is a pure transport concern).
// Straight segments between the kept points — NO spline. The full-res source is
// itself a dense polyline, so at SCHEMATIC_EPS's resolution the kept points already
// trace the true shape (sharp corners stay sharp, curves read smooth under the
// round line-join). A Catmull-Rom/fillet spline was tried and reverted: RDP spaces
// points too unevenly for a spline (it bowed straights) and any spline IMPOSES a
// rounded look the original doesn't have — more points reproduces it, smoothing
// distorts it.
export function unpackSchematic(b64) {
  if (!b64) return { viewBox: VBOX, d: '', start: null };
  const b = fromB64(b64), n = b.length >> 1;
  let d = '', sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const x = b[i * 2], y = b[i * 2 + 1];
    if (i === 0) { sx = x; sy = y; }
    d += (i === 0 ? 'M' : ' L') + x + ' ' + y;
  }
  return { viewBox: VBOX, d: d + ' Z', start: { x: sx, y: sy } };
}
