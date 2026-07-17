// Difficulty report card for every CATALOGUE track: the geometric metrics (measureTrack)
// plus the headless AI lap probe (aiProbe) from the generator pipeline, run on the shipped
// geometry. Two jobs: calibrate the per-profile difficulty bands in track-gen.mjs against
// known reference tracks (meadow is the canonical Easy, switchback the canonical Hard,
// twister the stunt ceiling), and sanity-check that a newly registered track actually
// lands in its cup's band. Usage: node scripts/probe-difficulty.mjs
import { measureTrack, aiProbe, buildTrack } from './track-gen.mjs';

// Both catalogues. The reference tracks this exists to calibrate against — meadow,
// switchback, twister — are all RETIRED from the cups and live in devTracks.js, so reading
// the shipped list alone would drop precisely the anchors the bands are pinned to.
const { TRACKS } = await import(new URL('../public/shared/tracks.js', import.meta.url));
const { DEV_TRACKS } = await import(new URL('../public/shared/devTracks.js', import.meta.url));

console.log('track        diff     len  lap(s) brake  minR hairp  dens  rec  minW maxW climb');
for (const [id, def] of Object.entries({ ...TRACKS, ...DEV_TRACKS })) {
  const t = buildTrack(def);
  const m = measureTrack(t);
  const ai = await aiProbe(def);
  console.log(
    `${id.padEnd(12)} ${String(def.difficulty).padEnd(8)}` +
    `${String(Math.round(t.length)).padStart(4)}  ${String(ai.lapSec).padStart(5)}  ${ai.brakeFrac.toFixed(2)}  ` +
    `${String(m.minRadius).padStart(4)}    ${m.hairpins}  ${m.cornerDensity.toFixed(3)}  ${String(m.minRecovery).padStart(3)}  ` +
    `${m.minW.toFixed(1)}  ${m.maxW.toFixed(1)}  ${String(m.climb).padStart(5)}`
  );
}
