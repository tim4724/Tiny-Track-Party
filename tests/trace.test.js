'use strict';
// Golden-trace oracle tooling (scripts/record-trace.mjs + verify-trace.mjs):
// the record/replay harness the native engine port will be conformance-tested
// against. Three properties are load-bearing and pinned here:
//   (a) determinism — the same config records a byte-identical trace;
//   (b) round-trip — a recorded trace replays to EXACT float equality;
//   (c) localisation — a corrupted trace reports the exact divergent frame
//       (and field path, when the frame carries a stored snapshot).
// Plus the oracle itself: every committed fixture under tests/fixtures/traces/
// must replay exactly. If an engine change fails that test, the behaviour
// change is real — re-record the fixtures IF it was intentional (the command
// line for each fixture is in its header/README), never loosen the comparison.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let rec, ver, CONTRACT_VERSION, MATHLIB; // record-trace.mjs / verify-trace.mjs module namespaces
test.before(async () => {
  rec = await import('../scripts/record-trace.mjs');
  ver = await import('../scripts/verify-trace.mjs');
  ({ CONTRACT_VERSION } = await import('../public/display/engine/contract.js'));
  ({ MATHLIB } = await import('../public/display/engine/math.js'));
});

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'traces');

// Small-but-real config: catalogue track, two persona bots, one scripted
// human (covers the human-input record/replay path), items + hazards live.
function smallConfig() {
  return {
    trackId: 'tidepool', frames: 150, seed: 42, laps: 3, snapshotEvery: 60,
    bots: rec.makeBots(2, 42),
    humans: [rec.scriptedHuman(0)]
  };
}

test('recording the same config twice is byte-identical', () => {
  const a = rec.recordTrace(smallConfig());
  const b = rec.recordTrace(smallConfig());
  assert.equal(a.text, b.text, 'same config must produce the same trace bytes');
  // and the bytes are real: header first, one line per frame, hash on every frame
  const { header, records } = rec.parseTrace(a.text);
  assert.equal(header.contractVersion, CONTRACT_VERSION);
  assert.equal(header.trackId, 'tidepool');
  assert.equal(records.length, header.frames);
  for (const r of records) assert.match(r.hash, /^[0-9a-f]{8}$/);
  // full snapshots every Kth frame + the last frame, hash-only in between
  assert.ok(records[0].snapshot && records[60].snapshot && records[149].snapshot);
  assert.equal(records[61].snapshot, undefined);
});

test('a recorded trace verifies clean (exact replay)', () => {
  const { text } = rec.recordTrace(smallConfig());
  const r = ver.verifyTrace(text);
  assert.deepEqual(r, { ok: true, frames: 150 });
});

test('corrupting a stored snapshot value reports that frame and field path', () => {
  const { header, records } = rec.parseTrace(rec.recordTrace(smallConfig()).text);
  records[60].snapshot.cars[0].pose.pos.x += 0.25; // hash untouched: the FIELD diff must catch it
  const r = ver.verifyTrace({ header, records });
  assert.equal(r.ok, false);
  assert.equal(r.frame, 60, 'must report the corrupted frame, not a later one');
  assert.match(r.path, /^snapshot\.cars\[0\]\.pose\.pos\.x$/);
  assert.equal(r.actual, r.expected - 0.25);
});

test('corrupting a hash-only frame reports that exact frame', () => {
  const { header, records } = rec.parseTrace(rec.recordTrace(smallConfig()).text);
  records[75].hash = '00000000'; // frame 75 carries no snapshot — hash is the only tripwire
  const r = ver.verifyTrace({ header, records });
  assert.equal(r.ok, false);
  assert.equal(r.frame, 75);
  assert.equal(r.path, null, 'no stored snapshot on this frame, so no field path');
  assert.match(r.message, /hash diverged/);
});

// Live lobbies key cars by NUMERIC peerIndex. JSONL stringifies the per-frame
// input keys, so the verifier must map them back to the roster's real id types
// or every input silently misses the cars Map and replay diverges with a bogus
// engine-divergence report (the exact regression this pins).
test('numeric car ids (live-shaped rosters) record and verify clean', () => {
  const cfg = {
    trackId: 'tidepool', frames: 90, seed: 5, laps: 3, snapshotEvery: 30,
    bots: [{ id: 2, skill: 0.9, laneBias: 0.15, aiSeed: 11 }],
    humans: [{ id: 3, script: (f) => ({ s: Math.sin(f / 25) * 0.6, b: f % 60 < 8 ? 1 : 0, u: 0 }) }]
  };
  const r = ver.verifyTrace(rec.recordTrace(cfg).text);
  assert.deepEqual(r, { ok: true, frames: 90 });
});

test('ids that collide once stringified are rejected at record time', () => {
  assert.throws(() => rec.recordTrace({
    trackId: 'tidepool', frames: 1,
    humans: [{ id: 3, script: () => null }, { id: '3', script: () => null }]
  }), /unique/);
});

test('a contract-version mismatch fails fast with a re-record message', () => {
  const { header, records } = rec.parseTrace(rec.recordTrace(smallConfig()).text);
  header.contractVersion = 999;
  const r = ver.verifyTrace({ header, records });
  assert.equal(r.ok, false);
  assert.match(r.message, /re-record/);
});

// ---- the Milestone-1 trace kinds (oracle expansion) ----

test('ai-live trace round-trips: the verifier re-runs the AI and matches every output', () => {
  const { text } = rec.recordTrace({ ...smallConfig(), aiLive: true });
  const r = ver.verifyTrace(text);
  assert.equal(r.ok, true, r.message);
  assert.match(text.split('\n')[0], /"aiLive":true/);
});

test('ai-live divergence localises to the exact frame, bot and field', () => {
  const { header, records } = rec.parseTrace(rec.recordTrace({ ...smallConfig(), aiLive: true }).text);
  // Tamper with one recorded bot steer mid-trace: the re-run AI now disagrees
  // with the recording — the definition of an AI port divergence.
  const f = 90, botKey = 'cpu-bolt';
  assert.ok(records[f].inputs[botKey], 'expected a recorded input for the tampered bot');
  records[f].inputs[botKey].s += 1e-13;
  const r = ver.verifyTrace({ header, records });
  assert.equal(r.ok, false);
  assert.equal(r.frame, f);
  assert.equal(r.path, `inputs.${botKey}.s`);
  assert.match(r.message, /AI-LIVE/);
});

test('session trace round-trips: countdown, variable dt, racing flip, early raceEnd stop', () => {
  const config = {
    trackId: 'tidepool', frames: 600, seed: 11, laps: 1, snapshotEvery: 60,
    bots: rec.makeBots(2, 11), humans: [rec.scriptedHuman(0)],
    session: true, countdown: 2,
    dtJitter: { amp: 6, spikeEvery: 97, spikeScale: 4, jseed: 5 },
    // End the race deterministically mid-budget so raceEnd + the early stop are
    // both exercised without simulating full laps.
    schedule: [
      { frame: 300, op: 'forceFinish', id: 'human-1', time: 30000 },
      { frame: 300, op: 'forceFinish', id: 'cpu-bolt', time: 31000 },
      { frame: 300, op: 'forceFinish', id: 'cpu-pixel', time: 32000 }
    ]
  };
  const { header, records, text } = rec.recordTrace(config);
  assert.equal(header.driver, 'session');
  assert.ok(header.frames < 600, 'race end must stop the trace early');
  assert.equal(records.length, header.frames);
  const flips = records.filter((r) => r.racing !== undefined);
  assert.deepEqual(flips.map((r) => r.racing), [true, false],
    'two racing flips: GO, then the end-of-race stop on the raceEnd frame');
  const last = records[records.length - 1];
  assert.equal(flips[1], last, 'the false flip rides the raceEnd frame');
  assert.ok(last.raceEnd, 'last frame carries the raceEnd results');
  assert.ok(last.snapshot, 'early stop still stores a final full snapshot');
  const r = ver.verifyTrace(text);
  assert.equal(r.ok, true, r.message);
  // Determinism across re-records, same as the base kind.
  assert.equal(rec.recordTrace(config).text, text, 'session trace must be byte-reproducible');
});

test('schedule ops round-trip and actually mutate the race', () => {
  const config = {
    ...smallConfig(), frames: 220,
    schedule: [
      { frame: 40, op: 'giveItem', id: 'cpu-bolt', item: 'rocket' },
      { frame: 45, op: 'useItem', id: 'cpu-bolt' },
      { frame: 80, op: 'setCarStats', id: 'cpu-pixel', stats: { vmax: 1.06, turn: 0.92 } },
      { frame: 120, op: 'rekeyCar', id: 'human-1', newId: 'human-9' },
      { frame: 160, op: 'removeCar', id: 'cpu-pixel' }
    ]
  };
  const { header, records, text } = rec.recordTrace(config);
  const r = ver.verifyTrace(text);
  assert.equal(r.ok, true, r.message);
  const last = records[records.length - 1].snapshot;
  const ids = last.cars.map((c) => String(c.id));
  assert.ok(!ids.includes('cpu-pixel'), 'removed car must be gone from the final snapshot');
  assert.ok(ids.includes('human-9') && !ids.includes('human-1'), 'rekeyed car must carry its new id');
  assert.ok(records.some((x) => (x.events || []).some((e) => e.type === 'item_use')), 'useItem must emit item_use');
  assert.match(text.split('\n')[0], /"schedule":\[/);
  // Post-rekey human inputs must be recorded under the LIVE id or replay would
  // silently drop them.
  assert.ok(records[150].inputs['human-9'] && !records[150].inputs['human-1'], 'inputs re-keyed with the car');
  assert.equal(header.frames, 220);
});

// Traces are engine- and platform-independent (transcendentals go through
// engine/math.js, fdlibm WASM), so every committed fixture replays EVERYWHERE
// — dev machines and CI alike, no skips. The one provenance that must match
// is the mathlib build stamped in each header: a fixture recorded with a
// different mathlib is stale by definition and fails with a re-record
// message instead of being chased as phantom sim divergence.
//
// ARMED since the mathlib swap (Milestone 0 of the C++ port): fixtures are
// committed and their exact replay gates every change. If this test fails
// after an engine change, the behaviour change is real — re-record via
// `node scripts/record-fixtures.mjs` (any machine) IF it was intentional,
// never loosen the comparison.
test('committed golden fixtures replay exactly (the port-conformance oracle)', (t) => {
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    t.diagnostic('oracle disarmed: no committed fixtures; record and commit via scripts/record-fixtures.mjs');
    return;
  }
  for (const f of files) {
    const { header } = rec.parseTrace(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8'));
    assert.ok(ver.mathMatches(header),
      `${f} was recorded with ${header.math ?? 'V8 Math.* (pre-mathlib header)'} but the engine ships ${MATHLIB} — re-record the fixtures (node scripts/record-fixtures.mjs)`);
    const r = ver.verifyTraceFile(path.join(FIXTURE_DIR, f));
    assert.ok(r.ok, `${f} diverged: ${r.message} — if the engine change was intentional, re-record the fixtures (see tests/fixtures/traces/README.md)`);
  }
});
