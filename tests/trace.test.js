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

let rec, ver; // record-trace.mjs / verify-trace.mjs module namespaces
test.before(async () => {
  rec = await import('../scripts/record-trace.mjs');
  ver = await import('../scripts/verify-trace.mjs');
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
  assert.equal(header.contractVersion, 1);
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

test('a contract-version mismatch fails fast with a re-record message', () => {
  const { header, records } = rec.parseTrace(rec.recordTrace(smallConfig()).text);
  header.contractVersion = 999;
  const r = ver.verifyTrace({ header, records });
  assert.equal(r.ok, false);
  assert.match(r.message, /re-record/);
});

test('committed golden fixtures replay exactly (the port-conformance oracle)', () => {
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 2, `expected committed trace fixtures in ${FIXTURE_DIR}, found ${files.length}`);
  for (const f of files) {
    const r = ver.verifyTraceFile(path.join(FIXTURE_DIR, f));
    assert.ok(r.ok, `${f} diverged: ${r.message} — if the engine change was intentional, re-record the fixtures (see tests/fixtures/traces/README.md)`);
  }
});
