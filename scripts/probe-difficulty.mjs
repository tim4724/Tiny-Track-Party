// Difficulty report card for every CATALOGUE track: the geometric metrics
// (measureTrack, still JS — TrackBuilder is the renderer's and the authoring
// pipeline's) joined to the AI lap probe, which is now the NATIVE engine's:
// `probe_cli laptime --json` (native/probe/probe_cli.cc). The in-process aiProbe
// died with the JS engine; this reads the C++ instrument instead.
//
// Job: sanity-check that a newly registered track lands in its cup's band.
//
// TWO CAVEATS, both real:
//  - The numbers are NOT comparable to pre-2026-07-25 readings. The JS probe drove
//    the AI with no game context and an unseeded item RNG (see probe_cli's header).
//  - brakeFrac now spans a much narrower band than the JS probe's did: the AI runs
//    essentially flat-out and brakes only as a safety net (CORNER_MARGIN 1.25), so
//    the easy cups read 0.00-0.03 and only the twisty ones (pretzel, tangle,
//    cloverleaf, avalanche) reach 0.12-0.15. It still ranks tracks, but the
//    brakeFrac gate bands in track-gen.mjs PROFILES were calibrated against a
//    braking AI and are far too wide to bite. Judge with lap time + geometry.
//
// Only BAKED tracks can be probed — the native engine builds from its compiled
// catalogue (generated/track_defs.h), so the Gym and any unregistered candidate
// show geometry with no lap row. Profiling an unbaked def needs probe_cli
// --track-json, which does not exist yet.
//
// Usage: npm run probe:difficulty   (builds probe_cli, then runs this)
//        node scripts/probe-difficulty.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { measureTrack, buildTrack } from './track-gen.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROBE = path.join(ROOT, 'native/build/probe_cli');

if (!fs.existsSync(PROBE)) {
  console.error(`probe_cli not built at ${path.relative(ROOT, PROBE)}\n` +
    'build it with:\n' +
    '  cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && ' +
    'cmake --build native/build --target probe_cli --parallel');
  process.exit(2);
}

// One process for the whole catalogue: the probe races 3 laps per track.
const probed = new Map();
for (const line of execFileSync(PROBE, ['laptime', '--json'], { encoding: 'utf8' }).trim().split('\n')) {
  if (!line) continue;
  const r = JSON.parse(line);
  probed.set(r.track, r);
}

// Both catalogues (devTracks.js adds the Gym, which the native engine cannot build).
const { TRACKS } = await import(new URL('../public/shared/tracks.js', import.meta.url));
const { DEV_TRACKS } = await import(new URL('../public/shared/devTracks.js', import.meta.url));

console.log('track        diff     len  lap(s) brake  minR hairp  dens  rec  minW maxW climb');
for (const [id, def] of Object.entries({ ...TRACKS, ...DEV_TRACKS })) {
  const t = buildTrack(def);
  const m = measureTrack(t);
  const ai = probed.get(id);
  console.log(
    `${id.padEnd(12)} ${String(def.difficulty).padEnd(8)}` +
    `${String(Math.round(t.length)).padStart(4)}  ` +
    `${(ai ? ai.lapSec.toFixed(1) : '  -').padStart(5)}  ${ai ? ai.brakeFrac.toFixed(2) : ' -  '}  ` +
    `${String(m.minRadius).padStart(4)}    ${m.hairpins}  ${m.cornerDensity.toFixed(3)}  ${String(m.minRecovery).padStart(3)}  ` +
    `${m.minW.toFixed(1)}  ${m.maxW.toFixed(1)}  ${String(m.climb).padStart(5)}`
  );
}

const missing = Object.keys({ ...TRACKS, ...DEV_TRACKS }).filter((id) => !probed.has(id));
if (missing.length) {
  console.log(`\nno lap row (not in the native catalogue): ${missing.join(', ')}`);
}
