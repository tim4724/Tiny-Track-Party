// Top-down schematic of a built track, as a normalized SVG path the controllers
// can render WITHOUT Three.js. We project the centerline to the X/Z plane, fit it
// to a padded square viewBox, and emit one closed path (the "map" of the loop).
//
// trackSchematic() runs OFFLINE and NOTHING SHIPS IT. Nothing in the browser
// builds a track, so the maps are baked into shared/trackSchematics.js by
// scripts/gen-track-schematics.js (`npm run gen:schematics`, guarded by
// track.test.js) and the display ships those to phones in the room snapshot.
//
// WHAT THIS FILE IS NOW: the ORACLE. tests/fixtures/schematic-corpus.jsonl was
// recorded off the function below, and native/tracktest/schematic_check.cc holds
// libttp-track/ttp/schematic.cc to it on every leg — including the quirk printf
// cannot reproduce, the projection's round through Number.prototype.toFixed.
// A disagreement is a bug in the C++, never here.
//
// THE TRANSPORT CODEC IS NOT HERE ANY MORE. packSchematic/unpackSchematic moved
// to shared/schematicCodec.js, because the PHONE runs the unpack half and phones
// stay on the JS controller on all three TV platforms — so controller/main.js
// was importing from display/, the directory three native shells replace.

const VIEW = 256;   // viewBox square == the uint8 range, which is what lets the
                    // transport codec treat a coordinate as a byte with no rescale.
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

