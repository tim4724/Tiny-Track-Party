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
  'race-track.schema.json',
  'results.schema.json'
];
const loadSchema = (name) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));

let buildTrack, resolveFurniture, TRACK_LIST, Game, CONTRACT_VERSION;
test.before(async () => {
  ({ buildTrack, resolveFurniture, TRACK_LIST } = await import('../public/display/TrackBuilder.js'));
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

// The augmented (race-ready) track object the sim actually consumes: buildTrack()
// geometry + the host's game-side layer (resolved furniture + identity + per-race
// inputs), the same assembly scripts/export-track-data.mjs dumps. Its built-track
// fields are $ref'd to track.schema.json (checked here to point at real properties);
// the augmentation fields are defined in race-track.schema.json in full.
test('race-track schema matches a live augmented track', () => {
  const schema = loadSchema('race-track.schema.json');
  const trackSchema = loadSchema('track.schema.json');

  // A private descriptor (like TEST_OVAL) carrying every authored furniture kind, so
  // the resolve produces non-empty hazards (one with renderer-only `cones`), disc
  // pads, boxes, authored poles and bananas — no catalogue dependency.
  const def = {
    segments: TEST_OVAL,
    oils: [{ u: 0.10, lat: 0.7, cones: [[0, 0]] }, { u: 0.55, lat: -0.5, radius: 1.2 }],
    pads: [{ u: 0.25, lat: 0.3 }, { u: 0.80, lat: 0, radius: 0.9 }],
    boxes: [{ u: 0.30, lat: 0.4 }, { u: 0.35, lat: -0.4 }],
    poles: [{ u: 0.50, lat: 1.0, radius: 0.6 }],
    bananas: [{ u: 0.70, lat: 0.2 }]
  };
  const track = buildTrack(def);
  track.cup = 'beach';         // renderer identity, as buildEntry sets it
  track.trackId = 'test-oval';
  resolveFurniture(track, def);
  track.totalLaps = 3;         // per-race inputs the race stamps on
  track.seed = 1;

  assert.equal(track.version, CONTRACT_VERSION, 'augmented track carries the code contract version');
  assert.equal(schema.properties.version.const, CONTRACT_VERSION, 'schema pins the same contract version');
  assert.deepEqual(keysOf(track), keysOf(schema.properties), 'augmented fields == schema properties');
  assert.deepEqual(keysOf(schema.properties), [...schema.required].sort(), 'all augmented fields required');

  // Every built-track field is carried by $ref into track.schema.json; each ref must
  // resolve to a real property there (an honest cross-file link, not a dangling one).
  for (const [k, v] of Object.entries(schema.properties)) {
    if (!v.$ref) continue;
    const m = /^track\.schema\.json#\/properties\/(.+)$/.exec(v.$ref);
    assert.ok(m, `${k}: $ref points into track.schema.json properties`);
    assert.ok(trackSchema.properties[m[1]], `${k}: $ref target track.properties.${m[1]} exists`);
  }

  // Furniture field vocabularies: every live item's keys sit inside the matching $def
  // and carry its required keys. Pads are a disc/strip oneOf.
  const within = (item, d, label) => {
    const allowed = keysOf(d.properties);
    for (const key of Object.keys(item)) assert.ok(allowed.includes(key), `${label}: key '${key}' is in the schema vocab`);
    for (const r of d.required) assert.ok(r in item, `${label}: required key '${r}' present`);
  };
  const matches = (item, d) =>
    Object.keys(item).every((key) => keysOf(d.properties).includes(key)) && d.required.every((r) => r in item);

  assert.ok(track.hazards.length && track.boxes.length && track.poles.length && track.bananas.length, 'furniture arrays populated');
  for (const h of track.hazards) within(h, schema.$defs.hazard, 'hazard');
  for (const b of track.boxes) within(b, schema.$defs.box, 'box');
  for (const p of track.poles) within(p, schema.$defs.pole, 'pole');
  for (const b of track.bananas) within(b, schema.$defs.banana, 'banana');
  for (const p of track.pads) {
    assert.ok(matches(p, schema.$defs.padDisc) || matches(p, schema.$defs.padStrip), 'pad matches the disc or strip $def');
  }

  // The strip pad (auto loop-launch) has no analogue on the private oval; cover it on
  // a shipped stunt track, which builds a loop -> a `shape: 'strip'` pad.
  const stunt = TRACK_LIST.find((t) => t.id === 'skysnake');
  const st = buildTrack(stunt);
  resolveFurniture(st, stunt);
  const strips = st.pads.filter((p) => p.shape === 'strip');
  assert.ok(strips.length >= 1, 'skysnake resolves at least one strip launch pad');
  for (const p of strips) within(p, schema.$defs.padStrip, 'padStrip');
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
