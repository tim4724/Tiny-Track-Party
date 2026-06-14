// Audition a RANGE of seeds for new Backyard tracks. Each seed is run through the full
// generate→solve pipeline (scripts/track-gen.mjs) and graded against the same gates the unit
// tests enforce on shipped tracks (closed, smooth, ≥1 bridged self-crossing, lap ~40-60s,
// no elevation knot). Prints the PASSING seeds with their stats so you can pick by the
// numbers, then eyeball the winners in 3D.
//
//   node scripts/scan-seeds.mjs [from] [to]      (defaults: 1 200)
//   node scripts/scan-seeds.mjs 1 400 --all      (also list why each seed FAILED)
//
// Then: add a winning seed to SEEDS in gen-tracks.mjs, re-bake, register it in tracks.js,
// and preview at /?scenario=track&track=<id>.
import { evaluateSeed } from './track-gen.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const showAll = process.argv.includes('--all');
const from = parseInt(args[0] || '1', 10), to = parseInt(args[1] || '200', 10);

const pass = [];
for (let seed = from; seed <= to; seed++) {
  let r; try { r = evaluateSeed(seed); } catch (e) { r = { seed, pass: false, reason: e.message }; }
  if (r.pass) pass.push(r);
  else if (showAll) console.log(`  seed ${String(seed).padStart(4)}  ✗  ${r.reason || `gap=${r.gap} len=${r.len} step=${r.step} cross=${r.crossings} bridge=${r.bridge} knot=${r.knot}`}`);
}
pass.sort((a, b) => b.crossings - a.crossings || a.step - b.step);
console.log(`\n${pass.length}/${to - from + 1} seeds PASS (${from}..${to}). Best first (more crossings, smoother):\n`);
for (const r of pass)
  console.log(`  seed ${String(r.seed).padStart(4)}  cross ${r.crossings}  bridge ${r.bridge}  len ${r.len} (~${r.lapSec}s)  step ${r.step}  maxY ${r.maxY}  wp ${r.wp}`);
console.log(`\nPick distinct shapes across the difficulty range, add to SEEDS in gen-tracks.mjs, re-bake, then eyeball /?scenario=track&track=<id>.`);
