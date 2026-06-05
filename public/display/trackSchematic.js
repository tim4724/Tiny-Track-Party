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
  const px = (x) => +(offX + (x - minX) * scale).toFixed(1);
  const pz = (z) => +(offZ + (z - minZ) * scale).toFixed(1);

  let d = '';
  for (let i = 0; i < samples.length; i++) {
    d += (i === 0 ? 'M' : ' L') + px(xs[i]) + ' ' + pz(zs[i]);
  }
  d += ' Z';

  return {
    viewBox: `0 0 ${VIEW} ${VIEW}`,
    d,
    start: { x: px(xs[0]), y: pz(zs[0]) }
  };
}
