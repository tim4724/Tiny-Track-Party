// Records the committed golden-trace fixture set (tests/fixtures/traces/).
//
// Run this on ANY machine: the sim's transcendentals go through
// engine/math.js (fdlibm WASM), so traces are engine- and platform-
// independent — fixtures recorded on a dev laptop replay bit-exactly on CI
// and vice versa. Each header stamps the mathlib build; re-record whenever
// that stamp changes. The record-traces workflow (workflow_dispatch) still
// wraps this script on CI as an independent cross-platform re-record check.
//
// The endgame fixture must cover the whole event vocabulary. This script
// tries ENDGAME_SEED first and, if an engine change moved the
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

const NEED_KINDS = ['spin', 'monster_end', 'finish', 'lap', 'pickup', 'item_use', 'rocket_expire'];
const NEED_CAUSES = ['banana', 'oil', 'rocket', 'monster'];
const ENDGAME_FIELD = 5; // bots in the endgame race — all must finish inside the budget
const ENDGAME_SEED = 39;
const ENDGAME_SCAN_LIMIT = 500;

function endgameConfig(seed) {
  // Skysnake: the shortest shipped lap (~42 s), so a 2-lap race with full furniture
  // chaos fits the frame budget. (The old anchor, retired dev-track Switchback, is gone.)
  // The staged target-less rocket whiffs at end of run → guaranteed rocket_expire
  // (bot rockets always connect on the shipped tracks, so no seed covers it naturally).
  return {
    trackId: 'skysnake', frames: 6600, seed, laps: 2, snapshotEvery: 400,
    bots: makeBots(ENDGAME_FIELD, seed),
    stage: [{ kind: 'rocket', s: 5, lat: 0 }]
  };
}

function coverage(records) {
  const kinds = new Set(), causes = new Set();
  let finishes = 0, raceOver = null; // race over = the LAST car's finish (no race_over event in the contract)
  for (const r of records) for (const e of (r.events || [])) {
    kinds.add(e.type);
    if (e.type === 'spin') causes.add(e.cause);
    if (e.type === 'finish' && ++finishes >= ENDGAME_FIELD) raceOver = r.frame;
  }
  return { kinds, causes, raceOver };
}

function missing(c) {
  const out = [
    ...NEED_KINDS.filter((k) => !c.kinds.has(k)).map((k) => `event:${k}`),
    ...NEED_CAUSES.filter((x) => !c.causes.has(x)).map((x) => `spin:${x}`),
  ];
  if (c.raceOver === null) out.push('all finishes within the frame budget');
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

// ---- Milestone-1 oracle-expansion kinds (see record-trace.mjs header) ----

// AI-LIVE: the verifier (and later the C++ replay CLI) re-runs the AI every
// frame and must reproduce each recorded control bit-for-bit. Twin of the
// tidepool starter so a divergence isolates to the AI, not new race dynamics.
write('tidepool-ailive-4bots-600f-seed42.jsonl',
  recordTrace({ trackId: 'tidepool', frames: 600, seed: 42, laps: 3, snapshotEvery: 100, bots: makeBots(4, 42), aiLive: true }));

// SESSION + VARIABLE DT: RaceSession-driven (countdown beats under jittered
// frame times, racing flip on GO) with a render-hitch spike every 97 frames.
write('helix-session-jitter-3bots-1human-800f-seed7.jsonl',
  recordTrace({
    trackId: 'helix', frames: 800, seed: 7, laps: 3, snapshotEvery: 100,
    bots: makeBots(3, 7), humans: [scriptedHuman(0)],
    session: true, countdown: 3,
    dtJitter: { amp: 6, spikeEvery: 97, spikeScale: 4, jseed: 7 }
  }));

// MUTATION SCHEDULE: every mid-race lifecycle/staging op the display can call,
// in one trace — the C++ port's API-surface conformance fixture.
const scheduled = recordTrace({
  trackId: 'tidepool', frames: 700, seed: 42, laps: 3, snapshotEvery: 100,
  bots: makeBots(5, 42), humans: [scriptedHuman(0)],
  schedule: [
    { frame: 60, op: 'giveItem', id: 'cpu-bolt', item: 'rocket' },
    { frame: 65, op: 'useItem', id: 'cpu-bolt' },
    { frame: 150, op: 'setCarStats', id: 'cpu-pixel', stats: { vmax: 1.06, turn: 0.92 } },
    { frame: 240, op: 'rekeyCar', id: 'human-1', newId: 'human-R' },
    { frame: 330, op: 'removeCar', id: 'cpu-rusty' },
    { frame: 420, op: 'forceFinish', id: 'cpu-pixel', time: 7000 }
  ]
});
{
  // Assert every op left its mark — a schedule that silently no-ops (typo'd
  // id, renamed API) must fail HERE, not ship as vacuous coverage.
  const last = scheduled.records[scheduled.records.length - 1].snapshot;
  const ids = last.cars.map((c) => String(c.id));
  const assert = (cond, msg) => { if (!cond) throw new Error(`schedule fixture lost coverage: ${msg}`); };
  assert(!ids.includes('cpu-rusty'), 'removeCar had no effect');
  assert(ids.includes('human-R') && !ids.includes('human-1'), 'rekeyCar had no effect');
  assert(scheduled.records.some((r) => (r.events || []).some((e) => e.type === 'item_use')), 'useItem emitted no item_use');
  assert(last.cars.find((c) => String(c.id) === 'cpu-pixel')?.finished, 'forceFinish had no effect');
}
write('tidepool-schedule-5bots-1human-700f-seed42.jsonl', scheduled);

// SESSION + AI-LIVE combined: both new verify paths in one medium slice.
write('tidepool-session-ailive-4bots-900f-seed13.jsonl',
  recordTrace({
    trackId: 'tidepool', frames: 900, seed: 13, laps: 3, snapshotEvery: 100,
    bots: makeBots(4, 13),
    session: true, countdown: 2, aiLive: true,
    dtJitter: { amp: 4, jseed: 13 }
  }));

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
  if (/^skysnake-5bots-.*\.jsonl$/.test(f)) fs.unlinkSync(path.join(DIR, f));
}
write(`skysnake-5bots-2laps-seed${seed}.jsonl`, out);

const c = coverage(out.records);
console.log(`endgame coverage: kinds [${[...c.kinds].sort().join(', ')}], spin causes [${[...c.causes].sort().join(', ')}], last finish at frame ${c.raceOver}`);
console.log(`recorded on Node ${process.versions.node} (V8 ${process.versions.v8}) ${process.platform}/${process.arch}`);
