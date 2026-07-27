'use strict';
// The contract schemas (docs/native-port/contract/*.schema.json) stay honest:
// each parses as JSON, and its field sets match the LIVE engine output (a real
// snapshot/results/built track) plus the committed golden-trace fixtures. No
// full JSON Schema validator (deliberately no dependency); what we pin is the
// FIELD VOCABULARY and the version stamps, which is where schema drift starts.
//
// "Live engine" now means the NATIVE sim through its C ABI (the wasm build of
// native/libttp-sim, loaded exactly as tests/runtime-abi.test.js does). Two
// consequences:
//   - the sim-side fixtures are a CATALOGUE track, not a private oval: a session
//     is opened by track id from a code-generated catalogue (track_defs.h). The
//     track-BUILDER schemas still use a private descriptor, which the builder
//     reaches through ttp_track_build_json (scripts/native-track.mjs);
//   - the event vocabulary is read out of the C++ source (native/libttp-sim/
//     ttp/game.cc), which is now the only place events are emitted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'docs', 'native-port', 'contract');
const GAME_CC = path.join(ROOT, 'native/libttp-sim/ttp/game.cc');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');
const SCHEMA_FILES = [
  'snapshot.schema.json',
  'events.schema.json',
  'input.schema.json',
  'track.schema.json',
  'race-track.schema.json',
  'results.schema.json'
];
const loadSchema = (name) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));

const skip = fs.existsSync(MJS) && fs.existsSync(WASM)
  ? false
  : 'ttp_runtime.mjs/.wasm not built — run native/scripts/build-runtime-web.sh';

let buildTrack, CONTRACT_VERSION;
test.before(async () => {
  const nt = await import('../scripts/native-track.mjs');
  await nt.init();
  buildTrack = nt.buildTrack;
  ({ CONTRACT_VERSION } = await import('../public/display/engine/contract.js'));
});

// The runtime C ABI (tests/runtime-abi.test.js conventions: ids cross as JSON
// scalars, null stats = the benchmark car, ttp_session_start(h, -1) = no
// countdown / racing from frame 0). Loaded once, lazily.
let _abi = null;
async function abi() {
  if (_abi) return _abi;
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const Module = await factory();
  const cw = (name, ret, args) => Module.cwrap(name, ret, args);
  _abi = {
    begin: cw('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
    addHuman: cw('ttp_add_human', 'void', ['number', 'string', 'string']),
    addBot: cw('ttp_add_bot', 'void', ['number', 'string', 'number', 'number', 'number', 'string']),
    start: cw('ttp_session_start', 'void', ['number', 'number']),
    update: cw('ttp_update', 'void', ['number', 'number']),
    input: cw('ttp_process_input', 'void',
      ['number', 'string', 'number', 'number', 'number', 'number']),
    snapshot: cw('ttp_snapshot_json', 'string', ['number']),
    results: cw('ttp_results_json', 'string', ['number']),
    forceFinish: cw('ttp_force_finish', 'void', ['number', 'string', 'number']),
    dispose: cw('ttp_dispose', 'void', ['number']),
  };
  return _abi;
}

// A live mixed-roster race: two humans (numeric ids) + two persona bots (string
// ids), so the snapshot covers BOTH id types the schema allows. Items and hazards
// are live and unforced, so a long-enough run also produces dropped bananas and
// rockets in flight — the arrays the old JS fixture never populated. Returns the
// first frame plus the first frame each of those arrays is non-empty (keeping all
// 3000 would be pointless megabytes).
const SIM_TRACK = 'tidepool';
async function liveRace(frames) {
  const a = await abi();
  const h = a.begin(SIM_TRACK, 42, 3, null);
  assert.ok(h > 0, `ttp_session_begin('${SIM_TRACK}') returned a handle`);
  a.addHuman(h, '1', null);
  a.addHuman(h, '2', null);
  a.addBot(h, '"cpu-bolt"', 1.05, -0.6, 1, null);
  a.addBot(h, '"cpu-pixel"', 1.0, 0.6, 1, null);
  a.start(h, -1);
  const out = { first: null, bananas: null, rockets: null };
  for (let i = 0; i < frames; i++) {
    a.input(h, '1', 1 | 2 | 4, 0.05, 0, i % 256);
    a.input(h, '2', 1 | 2, -0.05, 0, 0);
    a.update(h, 1000 / 60);
    const snap = JSON.parse(a.snapshot(h));
    if (!out.first) out.first = snap;
    for (const key of ['bananas', 'rockets']) if (!out[key] && snap[key].length) out[key] = snap;
  }
  a.dispose(h);
  return out;
}

const keysOf = (o) => Object.keys(o).sort();

// Compact closed oval for the TRACK-BUILDER schemas (private fixture, not a
// catalogue track, so the shipped track list and these invariants evolve
// independently).
const L = 4.0, RL = 4.185;
const straight = (length) => ({ kind: 'straight', length });
const arc = (radius, angle) => ({ kind: 'arc', radius, angle });
const run = (n) => Array.from({ length: n }, () => straight(L));
const TEST_OVAL = [
  ...run(4), arc(RL, 90), ...run(2), arc(RL, 90),
  ...run(4), arc(RL, 90), ...run(2), arc(RL, 90)
];

test('every contract schema file parses as JSON', () => {
  for (const f of SCHEMA_FILES) {
    const s = loadSchema(f); // throws on bad JSON
    assert.ok(s.$schema, `${f} declares $schema`);
    assert.ok(s.title, `${f} has a title`);
  }
});

test('snapshot schema matches a live ttp_snapshot_json()', { skip }, async () => {
  const schema = loadSchema('snapshot.schema.json');
  // Long enough for items to roll, be used, and land: a dropped banana and a
  // rocket in flight both appear inside three laps of tidepool.
  const live = await liveRace(3000);

  const snap = live.first;
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
  // Both id types the schema allows really occur (numeric humans, string bots).
  const idTypes = new Set(snap.cars.map((c) => typeof c.id));
  assert.deepEqual([...idTypes].sort(), ['number', 'string'], 'roster covers numeric and string car ids');

  // The furniture arrays: the JS fixture never populated these, so their field
  // vocabularies were unpinned against live output. Pin them on the first frame
  // each is non-empty.
  for (const key of ['bananas', 'rockets']) {
    const s = live[key];
    assert.ok(s, `the race produced at least one live ${key.slice(0, -1)}`);
    const itemProps = schema.properties[key].items.properties;
    for (const it of s[key]) {
      assert.deepEqual(keysOf(it), keysOf(itemProps), `${key} item fields == schema properties`);
    }
    assert.deepEqual(keysOf(itemProps), [...schema.properties[key].items.required].sort(),
      `all ${key} item fields required`);
  }
  // boxes is a bare boolean array, index-aligned with the track's authored boxes.
  assert.ok(snap.boxes.length > 0 && snap.boxes.every((b) => typeof b === 'boolean'),
    'boxes is a non-empty boolean array');
});

test('event vocabulary in the schema matches every emit site in game.cc', () => {
  const schema = loadSchema('events.schema.json');
  const src = fs.readFileSync(GAME_CC, 'utf8');
  // The C++ engine builds an Event POD and hands it to emit(): every site is a
  // literal `e.type = "<kind>"`.
  const emitted = new Set();
  for (const m of src.matchAll(/\be\.type = "([a-z_]+)"/g)) emitted.add(m[1]);
  assert.ok(emitted.size >= 7, 'found the emit sites (regex still matches the source)');

  const schemaTypes = new Set();
  for (const ref of schema.oneOf) {
    const name = ref.$ref.split('/').pop();
    schemaTypes.add(schema.$defs[name].properties.type.const);
  }
  assert.deepEqual([...schemaTypes].sort(), [...emitted].sort(), 'schema kinds == emitted kinds');

  // The spin causes: every spinOut(car, "x") call, plus the hazard emit that sets
  // e.cause inline (the banana/oil ternary) rather than going through spinOut.
  const causes = new Set();
  for (const m of src.matchAll(/\bspinOut\([^,)]+, "([a-z_]+)"\)/g)) causes.add(m[1]);
  for (const m of src.matchAll(/\be\.cause = [^;]+;/g)) {
    for (const q of m[0].matchAll(/"([a-z_]+)"/g)) causes.add(q[1]);
  }
  assert.deepEqual([...schema.$defs.spin.properties.cause.enum].sort(), [...causes].sort(), 'spin causes');
});

test('input schema covers exactly the {s, b, u} triple', () => {
  const schema = loadSchema('input.schema.json');
  assert.deepEqual(keysOf(schema.properties), ['b', 's', 'u']);
  assert.equal(schema.properties.u.maximum, 255, 'use-counter wraps at 8 bits');
});

// track.schema.json describes the GEOMETRY half of a built track — what the
// builder produced before the host's furniture resolve and per-race stamps were
// layered on. The builder no longer emits that half as a separate object (it
// returns the augmented one in a single call), so the check is that every field
// the schema names is really there, carrying the version it pins.
test('track schema matches the geometry half of a live built track', { skip }, () => {
  const schema = loadSchema('track.schema.json');
  const track = buildTrack({ segments: TEST_OVAL });
  assert.equal(track.version, CONTRACT_VERSION, 'built track carries the code contract version');
  assert.equal(schema.properties.version.const, CONTRACT_VERSION, 'schema pins the same contract version');
  assert.deepEqual(keysOf(schema.properties), [...schema.required].sort(), 'all track fields required');
  for (const k of keysOf(schema.properties)) {
    assert.ok(k in track, `schema names "${k}", which the builder does not emit`);
  }

  const sampleProps = schema.$defs.centerlineSample.properties;
  assert.deepEqual(keysOf(track.centerline.samples[0]), keysOf(sampleProps), 'centerline sample fields');
});

// The augmented (race-ready) track object the sim actually consumes: the geometry
// plus resolved furniture, identity and per-race inputs — one build now, the same
// assembly scripts/export-track-data.mjs dumps. Its built-track fields are $ref'd
// to track.schema.json (checked here to point at real properties); the
// augmentation fields are defined in race-track.schema.json in full.
test('race-track schema matches a live augmented track', { skip }, () => {
  const schema = loadSchema('race-track.schema.json');
  const trackSchema = loadSchema('track.schema.json');

  // A private descriptor (like TEST_OVAL) carrying every authored furniture kind, so
  // the resolve produces non-empty hazards (one with renderer-only `cones`), disc
  // pads, boxes, authored poles and bananas — no catalogue dependency.
  // (No authored `cones` on the oil: the builder does not carry them — the codegen
  // refuses a furniture entry that declares one rather than dropping it silently.)
  const def = {
    id: 'test-oval',
    segments: TEST_OVAL,
    oils: [{ u: 0.10, lat: 0.7 }, { u: 0.55, lat: -0.5, radius: 1.2 }],
    pads: [{ u: 0.25, lat: 0.3 }, { u: 0.80, lat: 0, radius: 0.9 }],
    boxes: [{ u: 0.30, lat: 0.4 }, { u: 0.35, lat: -0.4 }],
    poles: [{ u: 0.50, lat: 1.0, radius: 0.6 }],
    bananas: [{ u: 0.70, lat: 0.2 }]
  };
  const track = buildTrack(def, { laps: 3, seed: 1 });
  track.cup = 'beach';         // renderer identity — the host's tag, not the builder's

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
  const st = buildTrack('skysnake');
  const strips = st.pads.filter((p) => p.shape === 'strip');
  assert.ok(strips.length >= 1, 'skysnake resolves at least one strip launch pad');
  for (const p of strips) within(p, schema.$defs.padStrip, 'padStrip');
});

test('results schema matches a live ttp_results_json()', { skip }, async () => {
  const schema = loadSchema('results.schema.json');
  const a = await abi();
  const h = a.begin(SIM_TRACK, 42, 1, null);
  assert.ok(h > 0, `ttp_session_begin('${SIM_TRACK}') returned a handle`);
  a.addHuman(h, '1', null);
  a.addBot(h, '"cpu-bolt"', 1.05, -0.6, 1, null);
  a.start(h, -1);
  a.forceFinish(h, '1', 12.5); // one finisher, one still racing — both row shapes
  const res = JSON.parse(a.results(h));
  a.dispose(h);

  assert.deepEqual(keysOf(res), keysOf(schema.properties), 'top-level results fields');
  const rowProps = schema.properties.results.items.properties;
  assert.equal(res.results.length, 2, 'a row per car');
  for (const row of res.results) assert.deepEqual(keysOf(row), keysOf(rowProps), 'result row fields');
  assert.deepEqual(res.results.map((r) => r.finished), [true, false], 'the forced finisher ranks first');
});

test('committed trace fixtures agree with the snapshot schema', (t) => {
  const schema = loadSchema('snapshot.schema.json');
  const dir = path.join(__dirname, 'fixtures', 'traces');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    // Oracle disarmed (see tests/trace.test.js); the live-snapshot check
    // above still pins the schema against the engine.
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
