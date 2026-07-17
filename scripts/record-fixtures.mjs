// Records the committed golden-trace fixture set (tests/fixtures/traces/).
//
// Run this ON THE REFERENCE PLATFORM: the CI unit-job environment (ubuntu
// x64, Node major pinned in .github/workflows/test.yml). Traces are bit-exact
// only per engine+platform, so fixtures recorded on a dev machine will not
// replay on CI. The record-traces workflow (workflow_dispatch) wraps this
// script and uploads the result as an artifact; commit that.
//
// The endgame fixture must cover the whole event vocabulary. This script
// tries ENDGAME_SEED first and, if an engine or platform change moved the
// race enough to lose coverage, scans seeds for the first fully-covering one
// and records that instead (the filename carries the seed). When the seed
// changes, update ENDGAME_SEED here and the fixture list in
// tests/fixtures/traces/README.md.
//
// Usage: node scripts/record-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordTrace, makeBots, scriptedHuman } from './record-trace.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'traces');

const NEED_KINDS = ['spin', 'monster_end', 'finish', 'race_over', 'lap', 'pad', 'pickup', 'item_use', 'rocket_expire'];
const NEED_CAUSES = ['banana', 'oil', 'rocket', 'monster'];
const ENDGAME_SEED = 39;
const ENDGAME_SCAN_LIMIT = 500;

function endgameConfig(seed) {
  return { trackId: 'switchback', frames: 3600, seed, laps: 2, snapshotEvery: 400, bots: makeBots(5, seed) };
}

function coverage(records) {
  const kinds = new Set(), causes = new Set();
  let raceOver = null;
  for (const r of records) for (const e of (r.events || [])) {
    kinds.add(e.type);
    if (e.type === 'spin') causes.add(e.cause);
    if (e.type === 'race_over') raceOver = r.frame;
  }
  return { kinds, causes, raceOver };
}

function missing(c) {
  const out = [
    ...NEED_KINDS.filter((k) => !c.kinds.has(k)).map((k) => `event:${k}`),
    ...NEED_CAUSES.filter((x) => !c.causes.has(x)).map((x) => `spin:${x}`),
  ];
  if (c.raceOver === null) out.push('race_over within the frame budget');
  return out;
}

function write(name, { text, records }) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, name), text);
  const snaps = records.filter((r) => r.snapshot !== undefined).length;
  console.log(`wrote ${name}: ${records.length} frames, ${snaps} full snapshots, ${Buffer.byteLength(text)} bytes`);
}

// Starter slices: short, early-race physics on both track families.
write('tidepool-4bots-600f-seed42.jsonl',
  recordTrace({ trackId: 'tidepool', frames: 600, seed: 42, laps: 3, snapshotEvery: 100, bots: makeBots(4, 42) }));
write('helix-3bots-1human-500f-seed7.jsonl',
  recordTrace({ trackId: 'helix', frames: 500, seed: 7, laps: 3, snapshotEvery: 100, bots: makeBots(3, 7), humans: [scriptedHuman(0)] }));

// Endgame fixture: a complete race covering the full event vocabulary.
let seed = ENDGAME_SEED;
let out = recordTrace(endgameConfig(seed));
let miss = missing(coverage(out.records));
if (miss.length) {
  console.log(`seed ${seed} lost coverage on this engine/platform (missing: ${miss.join(', ')}); scanning...`);
  out = null;
  for (seed = 1; seed <= ENDGAME_SCAN_LIMIT; seed++) {
    const cand = recordTrace(endgameConfig(seed));
    miss = missing(coverage(cand.records));
    if (!miss.length) { out = cand; break; }
    if (seed % 25 === 0) console.log(`  ...scanned to seed ${seed}`);
  }
  if (!out) throw new Error(`no fully-covering endgame seed in 1..${ENDGAME_SCAN_LIMIT}; widen the scan or the frame budget`);
  console.log(`seed ${seed} covers fully; update ENDGAME_SEED in scripts/record-fixtures.mjs and the README fixture list`);
}
for (const f of fs.readdirSync(DIR)) {
  if (/^switchback-.*\.jsonl$/.test(f)) fs.unlinkSync(path.join(DIR, f));
}
write(`switchback-5bots-2laps-seed${seed}.jsonl`, out);

const c = coverage(out.records);
console.log(`endgame coverage: kinds [${[...c.kinds].sort().join(', ')}], spin causes [${[...c.causes].sort().join(', ')}], race_over at frame ${c.raceOver}`);
console.log(`recorded on Node ${process.versions.node} (V8 ${process.versions.v8}) ${process.platform}/${process.arch}`);
