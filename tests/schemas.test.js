'use strict';
// The contract schemas (docs/native-port/contract/*.schema.json) stay honest:
// each parses as JSON, and its field sets match the LIVE engine output (a real
// snapshot/results/built track) plus the committed golden-trace fixtures. No
// full JSON Schema validator (deliberately no dependency); what we pin is the
// FIELD VOCABULARY and the version stamps, which is where schema drift starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_DIR = path.join(__dirname, '..', 'docs', 'native-port', 'contract');
const SCHEMA_FILES = [
  'snapshot.schema.json',
  'events.schema.json',
  'input.schema.json',
  'track.schema.json',
  'results.schema.json'
];
const loadSchema = (name) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));

let buildTrack, Game, CONTRACT_VERSION;
test.before(async () => {
  ({ buildTrack } = await import('../public/display/TrackBuilder.js'));
  ({ Game, CONTRACT_VERSION } = await import('../public/display/engine/Game.js'));
});

// Compact closed oval, same shape the engine tests use (private fixture, not a
// catalogue track).
const L = 4.0, RL = 4.185;
const straight = (length) => ({ kind: 'straight', length });
const arc = (radius, angle) => ({ kind: 'arc', radius, angle });
const run = (n) => Array.from({ length: n }, () => straight(L));
const TEST_OVAL = [
  ...run(4), arc(RL, 90), ...run(2), arc(RL, 90),
  ...run(4), arc(RL, 90), ...run(2), arc(RL, 90)
];

const keysOf = (o) => Object.keys(o).sort();

test('every contract schema file parses as JSON', () => {
  for (const f of SCHEMA_FILES) {
    const s = loadSchema(f); // throws on bad JSON
    assert.ok(s.$schema, `${f} declares $schema`);
    assert.ok(s.title, `${f} has a title`);
  }
});

test('snapshot schema matches a live getSnapshot()', () => {
  const schema = loadSchema('snapshot.schema.json');
  const track = buildTrack(TEST_OVAL);
  track.totalLaps = 3;
  track.boxes = [{ s: 5, lat: 0, radius: 0.5 }];
  track.seed = 42;
  const game = new Game([{ id: 1 }, { id: 2 }], track, {});
  for (let i = 0; i < 30; i++) {
    game.processInput(1, { s: 0.3, b: 0.1, u: 0 });
    game.update(16);
  }
  const snap = game.getSnapshot();

  assert.equal(snap.version, CONTRACT_VERSION, 'live snapshot carries the code contract version');
  assert.equal(schema.properties.version.const, CONTRACT_VERSION, 'schema pins the same contract version');
  assert.deepEqual(keysOf(snap), keysOf(schema.properties), 'top-level snapshot fields == schema properties');
  assert.deepEqual(keysOf(schema.properties), [...schema.required].sort(), 'all top-level fields required');

  const carProps = schema.$defs.carSnap.properties;
  for (const car of snap.cars) {
    assert.deepEqual(keysOf(car), keysOf(carProps), 'car fields == schema carSnap properties');
    assert.deepEqual(keysOf(car.pose), keysOf(carProps.pose.properties), 'pose fields');
    for (const k of ['pos', 'forward', 'up']) {
      assert.deepEqual(keysOf(car.pose[k]), ['x', 'y', 'z'], `pose.${k} is a plain xyz literal`);
    }
  }
  assert.deepEqual(keysOf(carProps), [...schema.$defs.carSnap.required].sort(), 'all car fields required');
});

test('event vocabulary in the schema matches every onEvent emit site in Game.js', () => {
  const schema = loadSchema('events.schema.json');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'display', 'engine', 'Game.js'), 'utf8');
  const emitted = new Set();
  for (const m of src.matchAll(/this\.onEvent\(\{\s*type:\s*'([a-z_]+)'/g)) emitted.add(m[1]);
  assert.ok(emitted.size >= 7, 'found the emit sites (regex still matches the source)');

  const schemaTypes = new Set();
  for (const ref of schema.oneOf) {
    const name = ref.$ref.split('/').pop();
    schemaTypes.add(schema.$defs[name].properties.type.const);
  }
  assert.deepEqual([...schemaTypes].sort(), [...emitted].sort(), 'schema kinds == emitted kinds');

  // The spin causes: the banana/oil ternary emit plus every _spinOut(car, 'x') call.
  const causes = new Set(['banana', 'oil']);
  for (const m of src.matchAll(/_spinOut\(\w+, '([a-z_]+)'\)/g)) causes.add(m[1]);
  assert.deepEqual([...schema.$defs.spin.properties.cause.enum].sort(), [...causes].sort(), 'spin causes');
});

test('input schema covers exactly the {s, b, u} triple', () => {
  const schema = loadSchema('input.schema.json');
  assert.deepEqual(keysOf(schema.properties), ['b', 's', 'u']);
  assert.equal(schema.properties.u.maximum, 255, 'use-counter wraps at 8 bits');
});

test('track schema matches a live buildTrack() output', () => {
  const schema = loadSchema('track.schema.json');
  const track = buildTrack(TEST_OVAL);
  assert.equal(track.version, CONTRACT_VERSION, 'built track carries the code contract version');
  assert.equal(schema.properties.version.const, CONTRACT_VERSION, 'schema pins the same contract version');
  assert.deepEqual(keysOf(track), keysOf(schema.properties), 'buildTrack fields == schema properties');
  assert.deepEqual(keysOf(schema.properties), [...schema.required].sort(), 'all track fields required');

  const sampleProps = schema.$defs.centerlineSample.properties;
  assert.deepEqual(keysOf(track.centerline.samples[0]), keysOf(sampleProps), 'centerline sample fields');
});

test('results schema matches a live getResults()', () => {
  const schema = loadSchema('results.schema.json');
  const track = buildTrack(TEST_OVAL);
  track.totalLaps = 1;
  const game = new Game([{ id: 1 }, { id: 2 }], track, {});
  game.forceFinish(1, 12.5);
  const res = game.getResults();
  assert.deepEqual(keysOf(res), keysOf(schema.properties), 'top-level results fields');
  const rowProps = schema.properties.results.items.properties;
  for (const row of res.results) assert.deepEqual(keysOf(row), keysOf(rowProps), 'result row fields');
});

test('committed trace fixtures agree with the snapshot schema', (t) => {
  const schema = loadSchema('snapshot.schema.json');
  const dir = path.join(__dirname, 'fixtures', 'traces');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    // Oracle disarmed (see tests/trace.test.js); the live-snapshot checks
    // above still pin the schema against the engine.
    t.diagnostic('no committed trace fixtures (oracle disarmed)');
    return;
  }
  const carProps = schema.$defs.carSnap.properties;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0]);
    assert.equal(header.contractVersion, schema.properties.version.const, `${f}: header contract version`);
    const withSnap = lines.slice(1).map((l) => JSON.parse(l)).filter((r) => r.snapshot);
    assert.ok(withSnap.length >= 1, `${f}: has stored snapshots`);
    for (const rec of withSnap) {
      assert.deepEqual(keysOf(rec.snapshot), keysOf(schema.properties), `${f} frame ${rec.frame}: snapshot fields`);
      for (const car of rec.snapshot.cars) {
        assert.deepEqual(keysOf(car), keysOf(carProps), `${f} frame ${rec.frame}: car fields`);
      }
    }
  }
});
