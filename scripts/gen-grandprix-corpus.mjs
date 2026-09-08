// Generates tests/fixtures/grandprix-corpus.jsonl — the behavioural oracle for
// the C++ CupSeries port (libttp-sim/ttp/grand_prix.{h,cc}), the pure scoring
// core behind the Cup and Random picks.
//
// CupSeries is clock-free and RNG-injected (all identity/meta enters through
// applyRace, randomness through makeShuffleBag's rng), so its oracle is a SCRIPT
// trace like RoomFlow's and the fastlane's: each line is one scripted series —
// a construction config plus an op sequence — recording, per op, the return
// value and a digest of every PUBLIC observation afterwards.
//
//   line 1  header {kind:'grandprix', POINTS_BY_RANK, scripts, bagCases}
//   line 2+ {name, config:{cup:{id,name,tracks}, endless, bagSeed}, steps:[{op, ..., digest}]}
//        or {bagCase:{ids, seed, draws, out}}   — makeShuffleBag on its own
//
// Ops: applyRace {results:[{playerId,rank,finished}], field:[{peerIndex,name,
// colorIndex,ai}]} | advance | rekey {oldId,newId}. digest = {raceIndex,
// raceCount, currentTrackId, nextTrackId, finished, endless, tracks, standings}.
//
// playerIds are deliberately MIXED-TYPE (numeric peerIndex for humans, 'ai-N'
// strings for bots) because that is what the display keys seats by, and it is
// the part a C++ port is most likely to get wrong.
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-grandprix-corpus.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from './oracle-lib.mjs';
import { canonicalStringify } from './oracle-lib.mjs';

// FROZEN ORACLE. public/display/GrandPrix.js was retired when the cup layer moved
// to C++ (libttp-sim CupSeries), so this generator can no longer RUN as committed —
// the tests/fixtures/grandprix-corpus.jsonl it produced is permanent cross-
// implementation evidence, replayed by the grandprix ctest.
//
// It is kept because the scripts below ARE the scoring contract in executable
// form: read them to understand it, and extend them if you ever need to re-derive
// the oracle. To do that, restore the JS twin first:
//   git show f7859b0^:public/display/GrandPrix.js > public/display/GrandPrix.js
// (find the retirement commit with: git log --diff-filter=D -- public/display/GrandPrix.js)
// THE RESTORED TWIN CARRIES THE TABLE OF ITS OWN ERA. It was retired on a
// four-rung ladder and the table has widened since, so re-record only after
// copying the CURRENT POINTS_BY_RANK into it — otherwise the fixture silently
// regenerates the old one.
const { CupSeries, makeShuffleBag, POINTS_BY_RANK } =
  await import('../public/display/GrandPrix.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/grandprix-corpus.jsonl');

// The Beach Cup's real shape — the cup a fresh host auto-picks.
const BEACH = { id: 'beach', name: 'Beach Cup', tracks: ['tidepool', 'cove', 'driftwood', 'riptide'] };

// A full 4-seat field: two humans on peerIndex, two bots on 'ai-N' string ids.
const FIELD = [
  { peerIndex: 0, name: 'Alice', colorIndex: 0, ai: false },
  { peerIndex: 1, name: 'Bob', colorIndex: 3, ai: false },
  { peerIndex: 'ai-0', name: 'Bolt', colorIndex: 1, ai: true },
  { peerIndex: 'ai-1', name: 'Pixel', colorIndex: 2, ai: true },
];

// Bot seats past the four-seat FIELD, for the scripts that need a full grid (or
// more than one). Names follow AI_PERSONALITIES so a fixture reads like a race.
const FILL = ['Rusty', 'Zippy', 'Turbo', 'Gizmo', 'Scoot'].map((name, n) => (
  { peerIndex: `ai-${n + 2}`, name, colorIndex: (n + 4) % 8, ai: true }));
const grid = (n) => [...FIELD, ...FILL].slice(0, n);

const res = (playerId, rank, finished = true) => ({ playerId, rank, finished });

// ---------------------------------------------------------------------------
// Digest: every public getter plus the standings board, exactly as JS renders
// them. undefined survives as a DROPPED KEY through canonicalStringify (the C++
// port must reproduce that, which is why the no-seat script below exists).
// ---------------------------------------------------------------------------
function digest(series) {
  return {
    raceIndex: series.raceIndex,
    raceCount: series.raceCount,
    currentTrackId: series.currentTrackId,
    nextTrackId: series.nextTrackId,
    finished: series.finished,
    endless: series.endless,
    tracks: [...series.cup.tracks],
    standings: series.standings(),
  };
}

function runScript(script) {
  // Endless scripts draw from a seeded bag so the appended track ids are
  // reproducible; the display passes page Math.random here.
  const rng = script.bagSeed != null ? mulberry32(script.bagSeed) : null;
  const bag = rng ? makeShuffleBag(script.bagIds ?? BEACH.tracks, rng) : null;
  const series = new CupSeries(script.cup ?? BEACH, bag ? { drawNext: () => bag.draw() } : undefined);

  const steps = [];
  for (const op of script.ops) {
    const step = { op: op.op };
    if (op.op === 'applyRace') {
      step.results = op.results;
      step.field = op.field ?? FIELD;
      series.applyRace(op.results, step.field);
    } else if (op.op === 'advance') {
      series.advance();
    } else if (op.op === 'rekey') {
      step.oldId = op.oldId;
      step.newId = op.newId;
      series.rekey(op.oldId, op.newId);
    } else {
      throw new Error(`unknown op ${op.op}`);
    }
    step.digest = digest(series);
    steps.push(step);
  }
  return {
    name: script.name,
    config: {
      cup: script.cup ?? BEACH,
      endless: !!bag,
      ...(script.bagSeed != null ? { bagSeed: script.bagSeed } : {}),
      ...(script.bagIds ? { bagIds: script.bagIds } : {}),
    },
    steps,
  };
}

// ---------------------------------------------------------------------------
// The scripts. Each documents the behaviour it pins.
// ---------------------------------------------------------------------------
const SCRIPTS = [
  // The points table itself, one row per rung: a FULL grid, every car home, so
  // each of the eight values is pinned by a finisher that earned it.
  {
    name: 'points-table-full-field',
    ops: [{
      op: 'applyRace',
      results: [res(0, 1), res('ai-0', 2), res(1, 3), res('ai-1', 4),
                res('ai-2', 5), res('ai-3', 6), res('ai-4', 7), res('ai-5', 8)],
      field: grid(8),
    }],
  },

  // DNF earns nothing regardless of rank, and still records lastRank (so it
  // participates in the tie-break).
  {
    name: 'dnf-earns-nothing',
    ops: [{ op: 'applyRace', results: [res(0, 1), res(1, 2, false), res('ai-0', 3), res('ai-1', 4, false)] }],
  },

  // The table pays every one of the 8 grid slots, and a rank PAST it scores 0.
  // Nine cars is more than FIELD_SIZE, deliberately: the guard is what stops a
  // rank the table cannot answer for, and only a field larger than the table
  // reaches it. JS reads POINTS_BY_RANK[8] === undefined || 0; C++ bounds-checks
  // against POINTS_RANKS. Both must answer 0 for the 9th.
  {
    name: 'rank-past-the-table-scores-zero',
    ops: [{
      op: 'applyRace',
      results: [res(0, 1), res(1, 2), res('ai-0', 3), res('ai-1', 4), res('ai-2', 5),
                res('ai-3', 6), res('ai-4', 7), res('ai-5', 8), res('ai-6', 9)],
      field: grid(9),
    }],
  },

  // Equal points break on placement in the LATEST race: Bob wins race 2 and so
  // leads Alice despite identical totals.
  {
    name: 'tie-breaks-on-the-latest-race',
    ops: [
      { op: 'applyRace', results: [res(0, 1), res(1, 4), res('ai-0', 2), res('ai-1', 3)] },
      { op: 'advance' },
      { op: 'applyRace', results: [res(1, 1), res(0, 4), res('ai-0', 3), res('ai-1', 2)] },
    ],
  },

  // Sitting a race out shows "+0" and LOSES the tie-break (latest → Infinity),
  // while the banked points stay on the board. The second race is ENGINEERED to
  // reach that comparison: Alice banks a 2nd and leaves, and Bolt's 3rd plus a
  // 7th land on exactly her total. Without a real tie the script pins the "+0"
  // half and the comparison its name promises never runs.
  {
    name: 'absentee-gains-zero-and-loses-the-tiebreak',
    ops: [
      { op: 'applyRace', results: [res(1, 1), res(0, 2), res('ai-0', 3), res('ai-1', 4)] },
      { op: 'advance' },
      {
        op: 'applyRace',
        results: [res(1, 1), res('ai-1', 2), res('ai-2', 3), res('ai-3', 4),
                  res('ai-4', 5), res('ai-5', 6), res('ai-0', 7)],
        field: grid(8).filter((f) => f.peerIndex !== 0),
      },
    ],
  },

  // A late joiner scores from the race they first appear in and sorts after
  // everyone banked ahead of them.
  {
    name: 'late-joiner-scores-from-first-appearance',
    ops: [
      { op: 'applyRace', results: [res(0, 1), res('ai-0', 2), res('ai-1', 3)] },
      { op: 'advance' },
      { op: 'applyRace', results: [res(0, 2), res(1, 1), res('ai-0', 3), res('ai-1', 4)] },
    ],
  },

  // A result whose playerId is in NO field entry: JS reads `seats.get(id) || {}`,
  // so name/colorIndex come back undefined (dropped from the JSON) and ai is
  // false. Reachable when a seat vanishes between the flag and the standings.
  {
    name: 'result-with-no-field-seat',
    ops: [{
      op: 'applyRace',
      results: [res(0, 1), res('ghost-9', 2)],
      field: [FIELD[0]],
    }],
  },

  // The whole 4-race cup: advance between races, finished flips only when the
  // FINAL race's results are applied, and advance past the end is a no-op.
  {
    name: 'four-race-cup-to-the-podium',
    ops: [
      { op: 'applyRace', results: [res(0, 1), res(1, 2), res('ai-0', 3), res('ai-1', 4)] },
      { op: 'advance' },
      { op: 'applyRace', results: [res(1, 1), res(0, 2), res('ai-0', 4), res('ai-1', 3)] },
      { op: 'advance' },
      { op: 'applyRace', results: [res('ai-0', 1), res(0, 2), res(1, 3), res('ai-1', 4)] },
      { op: 'advance' },
      { op: 'applyRace', results: [res(0, 1), res('ai-1', 2), res(1, 3), res('ai-0', 4)] },
      { op: 'advance' },  // past the end: no-op, raceIndex stays at 3
      { op: 'advance' },
    ],
  },

  // Applying the same race twice without advancing: the second application
  // overwrites gained/lastRank and banks AGAIN (the display never does this, but
  // the recorded behaviour is the contract).
  {
    name: 'apply-twice-without-advancing',
    ops: [
      { op: 'applyRace', results: [res(0, 1), res(1, 2)] },
      { op: 'applyRace', results: [res(0, 3), res(1, 1)] },
    ],
  },

  // rekey carries a reconnecting human's banked cup to their new peerIndex and
  // must preserve FIRST-SEEN order (the stable tie-break), so the renamed row
  // stays where it was rather than moving to the end.
  {
    name: 'rekey-preserves-first-seen-order',
    ops: [
      { op: 'applyRace', results: [res(0, 3), res(1, 1), res('ai-0', 2), res('ai-1', 4)] },
      { op: 'rekey', oldId: 0, newId: 7 },
      { op: 'rekey', oldId: 0, newId: 8 },      // old id gone now: no-op
      { op: 'rekey', oldId: 7, newId: 7 },      // same id: no-op
      { op: 'rekey', oldId: 'nobody', newId: 9 },  // unknown id: no-op
    ],
  },

  // Endless (Random mode) never finishes: applying the last listed race appends
  // a fresh draw instead of setting done, so nextTrackId is always populated.
  {
    name: 'endless-series-never-finishes',
    bagSeed: 20260725,
    bagIds: ['tidepool', 'cove', 'driftwood', 'riptide', 'powder'],
    cup: { id: 'random', name: 'Random', tracks: ['tidepool'] },
    ops: [
      { op: 'applyRace', results: [res(0, 1), res('ai-0', 2)] },
      { op: 'advance' },
      { op: 'applyRace', results: [res(0, 2), res('ai-0', 1)] },
      { op: 'advance' },
      { op: 'applyRace', results: [res(0, 1), res('ai-0', 2)] },
      { op: 'advance' },
      { op: 'applyRace', results: [res('ai-0', 1), res(0, 2)] },
    ],
  },

  // A single-track cup: the first applyRace is already the last race.
  {
    name: 'one-race-cup-finishes-immediately',
    cup: { id: 'solo', name: 'Solo', tracks: ['gauntlet'] },
    ops: [
      { op: 'applyRace', results: [res(0, 1), res('ai-0', 2)] },
      { op: 'advance' },
    ],
  },
];

// ---------------------------------------------------------------------------
// makeShuffleBag on its own: dealing, refills, and the no-boundary-repeat rule.
// Recorded as flat draw lists so the C++ ShuffleBag is pinned independently of
// the series (the endless script above only sees the bag through nextTrackId).
// ---------------------------------------------------------------------------
const BAG_CASES = [
  // Two full cycles plus a bit: exercises refill and the boundary swap.
  { ids: ['a', 'b', 'c', 'd'], seed: 1, draws: 11 },
  // A single-id bag: all.length > 1 is false, so the boundary guard never fires
  // and the same id repeats forever.
  { ids: ['only'], seed: 7, draws: 4 },
  // Two ids: the boundary swap is maximally constrained (it must alternate
  // across every refill).
  { ids: ['x', 'y'], seed: 3, draws: 9 },
  // The real Beach Cup list, several cycles deep, on a big seed.
  { ids: BEACH.tracks, seed: 20260725, draws: 17 },
  // A longer bag so Fisher-Yates does real work.
  { ids: ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'], seed: 99, draws: 20 },
];

function runBagCase(c) {
  const bag = makeShuffleBag(c.ids, mulberry32(c.seed));
  const out = [];
  for (let i = 0; i < c.draws; i++) out.push(bag.draw());
  return { bagCase: { ids: c.ids, seed: c.seed, draws: c.draws, out } };
}

// ---------------------------------------------------------------------------
const lines = [];
lines.push(canonicalStringify({
  kind: 'grandprix',
  POINTS_BY_RANK,
  scripts: SCRIPTS.length,
  bagCases: BAG_CASES.length,
}));
for (const s of SCRIPTS) lines.push(canonicalStringify(runScript(s)));
for (const c of BAG_CASES) lines.push(canonicalStringify(runBagCase(c)));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`wrote ${path.relative(ROOT, OUT)}: ${SCRIPTS.length} scripts, ` +
  `${BAG_CASES.length} bag cases, ${lines.length} lines`);
