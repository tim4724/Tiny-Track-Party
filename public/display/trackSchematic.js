// Top-down schematic of a built track, as a normalized SVG path the controllers
// can render WITHOUT Three.js. We project the centerline to the X/Z plane, fit it
// to a padded square viewBox, and emit one closed path (the "map" of the loop).
//
// The display builds every track once at boot — buildTrack is pure geometry, so
// it needs no GLBs — and ships the resulting paths to phones in the WELCOME
// catalog. The phone just drops the path into an <svg>: no geometry math, no
// assets, and the map updates automatically whenever a track's pieces change.

const VIEW = 100;   // viewBox square (arbitrary units; the <svg> scales to its box)
const PAD = 12;     // inset so the stroke + start dot never clip at the edge

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
  const px = (x) => z0(+(offX + (x - minX) * scale).toFixed(1));
  const pz = (z) => z0(+(offZ + (z - minZ) * scale).toFixed(1));

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

// Decimate a schematic's path to at most `maxPts` points (dropping `proj`), for
// the phone's picker thumbnail. A full-detail loop is hundreds of points (~9 KiB);
// a ~60–100 px picker tile reads fine at ~24, which is what lets the whole reduced
// catalog ride the relay's retained room snapshot (set_state, 16 KiB) instead of a
// 183 KiB WELCOME. Returns just { viewBox, d, start } — the shape the <svg> needs.
export function reduceSchematic(s, maxPts = 24) {
  if (!s || !s.d) return s ? { viewBox: s.viewBox, d: s.d || '', start: s.start || null } : s;
  const pts = s.d.replace(/^M/, '').replace(/ Z$/, '').split(' L');
  if (pts.length <= maxPts) return { viewBox: s.viewBox, d: s.d, start: s.start };
  const step = pts.length / maxPts;
  const out = [];
  for (let i = 0; i < maxPts; i++) out.push(pts[Math.floor(i * step)].trim());
  return { viewBox: s.viewBox, d: 'M' + out[0] + out.slice(1).map((p) => ' L' + p).join('') + ' Z', start: s.start };
}
