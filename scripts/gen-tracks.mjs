// Bake the CHOSEN seeds into public/shared/genTracks.js — the resolved waypoints that the
// dependency-free catalogue (public/shared/tracks.js) imports. The generation pipeline lives
// in ./track-gen.mjs; this file just names which {seed, profile} becomes which track id and
// writes them, along with auto-placed furniture (oils/pads/boxes — see placeFurniture) for
// every non-classic track. The classic Backyard four keep their hand-tuned furniture in
// tracks.js, and their bakes must never change (the classic profile is frozen).
//
// Workflow for adding tracks:  node scripts/scan-seeds.mjs <profile> 1 400  →  pick seeds
//   →  add them to SEEDS below  →  node scripts/gen-tracks.mjs  →  register the id in
//   tracks.js (waypoints + furniture from GEN_TRACKS/GEN_FURNITURE, cup, difficulty)
//   →  node scripts/gen-track-schematics.js  →  preview at /?scenario=track&track=<id>
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { bakeSeed, buildTrack, placeFurniture, PROFILES } from './track-gen.mjs';
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const SELF = new URL(import.meta.url).pathname;

// which {seed, profile} becomes which track id (re-pick by editing this, then re-run)
// User-picked rosters (audition round of 2026-07-03; see gallery-tracks.html).
const SEEDS = {
  // Beach Cup (Easy)
  tidepool:   { seed: 88,  profile: 'easy' },
  cove:       { seed: 250, profile: 'easy' },
  driftwood:  { seed: 138, profile: 'easy' },
  riptide:    { seed: 330, profile: 'easy' },
  // Snow Cup (Medium) — the gentle end of the mid grammar: low brake fraction, no
  // hairpins, roomy min radii, but still crossings + real climb so nothing reads flat.
  powder:     { seed: 27,  profile: 'mid' },
  flurry:     { seed: 477, profile: 'mid' },
  glacier:    { seed: 290, profile: 'mid' },
  avalanche:  { seed: 125, profile: 'mid' },
  // Backyard Cup (middle) — pretzel/cloverleaf are original classic seeds re-baked
  // through the decorated mid profile (same plans/crossings — mid shares classic's
  // grammar). The frozen `classic` profile stays in track-gen as provenance.
  ribbon:     { seed: 128, profile: 'mid' },
  pretzel:    { seed: 13,  profile: 'mid' },
  tangle:     { seed: 372, profile: 'mid' },
  cloverleaf: { seed: 121, profile: 'mid' },
  // Canyon Cup (Hard)
  wash:       { seed: 193, profile: 'hard' },
  gulch:      { seed: 550, profile: 'hard' },
  crag:       { seed: 276, profile: 'hard' },
  sidewinder: { seed: 62,  profile: 'hard' },
};

// --stdout prints the bake instead of writing it, which is how
// tests/codegen-freshness.test.js drives this: regenerate, compare against the
// committed file. The per-track report goes to stderr under that flag so it
// cannot land in the bytes being compared.
const toStdout = process.argv.includes('--stdout');
const report = (line) => { if (toStdout) process.stderr.write(`${line}\n`); else console.log(line); };

// Bake ONE track. Everything below is a pure function of {seed, profile} — the
// RNG is track-gen's seeded mulberry32 and there is no Math.random anywhere in
// the pipeline — which is what makes the fan-out below legitimate rather than a
// race waiting to happen.
//
// It returns the two fragments ALREADY STRINGIFIED, and that is deliberate: the
// bytes a worker prints are the bytes the parent splices, so a value never makes
// a JSON round trip on its way into the bake. Re-serializing a parsed double is
// byte-safe in practice, but "safe in practice" is the wrong standard for the
// one file tests/codegen-freshness.test.js compares byte for byte.
function bakeOne(id, { seed, profile }) {
  const wp = bakeSeed(seed, profile);
  const src = { waypoints: wp };
  const t = buildTrack(src);
  const f = profile === 'classic'
    ? null
    : placeFurniture(src, { oils: PROFILES[profile].oilCount });
  return {
    id,
    wp: JSON.stringify(wp),
    furn: f === null ? null : JSON.stringify(f),
    line: `${id.padEnd(11)} ${profile.padEnd(7)} seed ${String(seed).padStart(3)}  ${wp.length} wp  len ${t.length.toFixed(0)} (~${(t.length * 0.124).toFixed(0)}s)  pillars ${t.pillars.length}  hills ${t.hills.length}  closed ${t.closed}`,
  };
}

// WORKER MODE. A BATCH of tracks, one line of JSON each on stdout, then out.
// Nothing else may reach stdout in this mode.
//
// A batch rather than a single track because the fixed cost of a worker is not
// just the ~60 ms of node boot + import: the first bake in a process also pays
// cold JIT on the whole solver, and measured that is ~0.15 s of CPU per process.
// One process per track spent 15.6 s of CPU to save wall clock; batching spends
// ~11 s for the same wall clock. This tree runs ~70 worktrees on one machine, so
// the CPU it does NOT burn is the difference between everyone else's build being
// slow or not.
const bakeArg = process.argv.find((a) => a.startsWith('--bake='));
if (bakeArg) {
  const ids = bakeArg.slice('--bake='.length).split(',').filter(Boolean);
  const unknown = ids.find((id) => !SEEDS[id]);
  if (unknown) { process.stderr.write(`unknown track id: ${unknown}\n`); process.exit(2); }
  process.stdout.write(ids.map((id) => `${JSON.stringify(bakeOne(id, SEEDS[id]))}\n`).join(''));
  process.exit(0);
}

// The 16 bakes are INDEPENDENT and each costs 0.4-0.8 s of pure CPU: 16 elevation
// solves and grid-anchor shortlists, each building real geometry through the
// native builder. Serially that was 10.3 s at 104% CPU, and since this script is
// what tests/codegen-freshness.test.js shells out to, those 10.3 s were 93% of
// the whole `npm test` wall clock — one assertion, one core, everything waiting.
//
// So: fan them across child processes, 10.3 s -> 2.5 s. THE GATE IS UNCHANGED —
// all 16 solves still run, through the same code, and the same bytes are still
// compared. Only the waiting is gone.
//
// Batches are STRIDED (worker w takes tracks w, w+W, w+2W...) rather than
// contiguous, because SEEDS is grouped by cup and therefore by profile: a `hard`
// bake is roughly twice an `easy` one, so contiguous slices would hand one
// worker all four Canyon tracks and leave it running alone at the end.
//
// --serial runs the old in-process loop. Keep it working: it is the readable
// stack when a bake throws, and the fallback if a machine ever makes spawning
// worker processes the slower answer.
async function bakeAll(entries) {
  if (process.argv.includes('--serial') || entries.length < 2) {
    return entries.map(([id, s]) => bakeOne(id, s));
  }
  // Enough workers to fill the machine, but never so many that each one bakes
  // only a track or two. Measured over the 16-track catalogue (user seconds are
  // the stable number here; wall clock swings with whatever the other worktrees
  // are doing): 3 workers 11.4 s CPU, 4 -> 11.5, 6 -> 12.2, 10 -> 13.9, against
  // 10.2 s serial. Wall clock is flat from 4 upward (~2.8 s), so everything past
  // that is CPU spent on cold JIT for no one's benefit. Four tracks per worker
  // is where the curve turns, and it scales: add tracks and the width grows.
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  const want = parseInt(process.env.TTP_BAKE_WORKERS, 10) || Math.ceil(entries.length / 4);
  const width = Math.max(1, Math.min(entries.length, cores, want));
  const batches = Array.from({ length: width }, (_, w) => entries.filter((_, i) => i % width === w));
  const lines = await Promise.all(batches.filter((b) => b.length).map((batch) => new Promise((resolve, reject) => {
    const ids = batch.map(([id]) => id);
    execFile(process.execPath, [SELF, `--bake=${ids.join(',')}`],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`baking ${ids.join(',')} failed: ${err.message}\n${stderr}`));
        try {
          const got = stdout.trim().split('\n').map((l) => JSON.parse(l));
          if (got.length !== ids.length) throw new Error(`asked for ${ids.length} bakes, got ${got.length}`);
          resolve(got);
        } catch (e) { reject(new Error(`baking ${ids.join(',')} produced no usable JSON: ${e.message}\n${stdout}\n${stderr}`)); }
      });
  })));
  const byId = new Map(lines.flat().map((b) => [b.id, b]));
  return entries.map(([id]) => byId.get(id));
}

// Assembled in SEEDS order regardless of which worker finished first — the bake's
// key order is part of the committed file.
const baked = await bakeAll(Object.entries(SEEDS));
for (const b of baked) report(b.line);
const body = baked.map((b) => `  ${b.id}: ${b.wp}`).join(',\n');
const furnBody = baked.filter((b) => b.furn !== null).map((b) => `  ${b.id}: ${b.furn}`).join(',\n');
const seedNote = Object.entries(SEEDS).map(([id, s]) => `${id}=${s.seed}(${s.profile})`).join(', ');
const text =
  `// GENERATED by scripts/gen-tracks.mjs — DO NOT EDIT BY HAND.\n` +
  `// Resolved waypoints for seeded generated tracks (solved elevation + decoration baked in),\n` +
  `// plus auto-placed furniture (placeFurniture) for the non-classic ones.\n` +
  `// Seeds: ${seedNote}.\n` +
  `// Regenerate: node scripts/gen-tracks.mjs\nexport const GEN_TRACKS = {\n${body}\n};\n\n` +
  `export const GEN_FURNITURE = {\n${furnBody}\n};\n`;
// No process.exit() after writing to a pipe — see gen-design-tokens.mjs for what
// that truncates.
if (toStdout) {
  process.stdout.write(text);
} else {
  fs.writeFileSync(path.join(ROOT, 'public/shared/genTracks.js'), text);
  console.log('wrote public/shared/genTracks.js');
}
