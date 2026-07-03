// Audition a RANGE of seeds for new generated tracks. Each seed runs the full
// generate→solve→decorate→bake pipeline (scripts/track-gen.mjs) for the given difficulty
// PROFILE and is graded against two layers of gates: the structural ones the unit tests
// enforce on shipped tracks (closed, smooth, every crossing bridged, no elevation knot)
// and the profile's difficulty BAND (crossings, lap length, corner metrics, and a headless
// AI lap probe's brake fraction). Prints the PASSING seeds with their stats so you can
// pick by the numbers, then eyeball the winners in 3D.
//
//   node scripts/scan-seeds.mjs [profile] [from] [to]   (defaults: classic 1 200)
//   node scripts/scan-seeds.mjs hard 1 400 --all        (also list why each seed FAILED)
//   node scripts/scan-seeds.mjs easy 1 400 --no-probe   (skip the AI probe — quick shape scan)
//
// Then: add a winning seed to SEEDS in gen-tracks.mjs (with its profile), re-bake, register
// the id in tracks.js, and preview at /?scenario=track&track=<id>.
import { evaluateSeed, PROFILES } from './track-gen.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const showAll = process.argv.includes('--all');
const noProbe = process.argv.includes('--no-probe');
let profile = 'classic';
if (args[0] && Number.isNaN(parseInt(args[0], 10))) profile = args.shift();
if (!PROFILES[profile]) {
  console.error(`unknown profile "${profile}" — have: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}
const from = parseInt(args[0] || '1', 10), to = parseInt(args[1] || '200', 10);

const line = (r) =>
  `  seed ${String(r.seed).padStart(4)}  cross ${r.crossings}  len ${r.len} (~${r.lapSec != null ? r.lapSec : '?'}s)` +
  `  brake ${r.brakeFrac != null ? r.brakeFrac.toFixed(2) : '  — '}  minR ${String(r.minRadius).padStart(4)}` +
  `  hairp ${r.hairpins}  dens ${r.cornerDensity.toFixed(3)}  rec ${String(r.minRecovery).padStart(3)}` +
  `  climb ${r.climb}  step ${r.step}  wp ${r.wp}`;

const pass = [];
for (let seed = from; seed <= to; seed++) {
  let r;
  try { r = await evaluateSeed(seed, profile, { probe: !noProbe }); }
  catch (e) { r = { seed, pass: false, fails: ['crash'], reason: e.message }; }
  if (r.pass) { pass.push(r); console.log(line(r)); }
  else if (showAll) console.log(`  seed ${String(seed).padStart(4)}  ✗  ${r.reason || r.fails.join(' ')}`);
}
console.log(`\n${pass.length}/${to - from + 1} seeds PASS profile "${profile}" (${from}..${to}).`);
console.log('Pick distinct shapes, add {seed, profile} to SEEDS in gen-tracks.mjs, re-bake, then eyeball /?scenario=track&track=<id>.');
