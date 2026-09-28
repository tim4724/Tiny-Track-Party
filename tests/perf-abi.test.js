'use strict';
// The two ABIs the BENCH rests on, against the SHIPPED wasm.
//
// WHY HERE AND NOT ONLY IN ctest. `perf` and `abi` prove the rules on every leg,
// and this file deliberately does not restate one of them. What it adds is the
// artifact: the `abi` ctest RECOMPILES the shims rather than linking the wasm
// target, so whether an export survived into the module the browser loads is a
// linker outcome no ctest can see — and `cwrap` does not throw on a missing
// name, it defers until the call, so absence surfaces as a mystery at bench
// time. Same reasoning as tests/display-abi.test.js and tests/party-abi.test.js.
//
// THE BENCH CONTRACT is one JSON object per line on three log streams, read by
// ONE parser, so the readout's key set is the wire between the platforms. It is
// taken from ttp_perf.h's own list here rather than typed out: a key added in
// C++ and not documented, or documented and not emitted, is the same silent
// break of that contract from either end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');

// The artifacts are CHECKED IN and the game is native-only, so a missing module
// is a broken checkout, not an unbuilt optional extra.
for (const f of [MJS, WASM]) {
  if (!fs.existsSync(f)) {
    throw new Error(`${path.relative(ROOT, f)} missing — run native/scripts/build-runtime-web.sh`);
  }
}

let modPromise = null;
const load = () => (modPromise = modPromise
  || import(pathToFileURL(MJS).href).then((m) => m.default()));

/** The readout's documented key set, read off the header's own listing. */
function headerKeys() {
  const src = fs.readFileSync(path.join(ROOT, 'native/runtime/ttp_perf.h'), 'utf8');
  const i = src.indexOf('ttp_perf_readout_json');
  const doc = src.slice(src.lastIndexOf('/*', i), i);
  const block = doc.match(/\{("[a-zA-Z]+",?\s*\*?\s*)+\}/);
  assert.ok(block, 'ttp_perf.h no longer lists the readout keys above its declaration');
  return [...block[0].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]).sort();
}

// DERIVED FROM THE HEADER, never listed here. A hand-written list is a list
// that misses the next export, and this one already did: ttp_perf_pacing was
// added and the gate stayed green over a module that did not carry it.
function perfExports() {
  const src = fs.readFileSync(path.join(ROOT, 'native/runtime/ttp_perf.h'), 'utf8');
  const names = [...src.matchAll(/TTP_ABI\s+[\w* ]+?\b(ttp_perf_\w+)\s*\(/g)].map((m) => m[1]);
  assert.ok(names.length >= 4, 'ttp_perf.h declares no TTP_ABI exports any more');
  return names;
}

test('the shipped module exports the perf and bench ABI a harness binds to', async () => {
  const M = await load();
  for (const name of [...perfExports(),
                      'ttp_race_autopilot_players', 'ttp_race_bench_field_json']) {
    assert.equal(typeof M[`_${name}`], 'function',
      `_${name} is not exported — the bench would fail at the cwrap call`);
  }
});

test('the readout is one object whose keys are the ones ttp_perf.h publishes', async () => {
  const M = await load();
  const reset = M.cwrap('ttp_perf_reset', null, []);
  const sample = M.cwrap('ttp_perf_sample', null,
    ['number', 'number', 'number', 'number', 'number']);
  const readout = M.cwrap('ttp_perf_readout_json', 'string',
    ['number', 'number', 'number', 'number', 'string']);

  reset();
  // A second of clean 60 Hz frames, past the warm-up, with a CPU cost and no
  // GPU timer — the web's own shape when the timer query is unavailable.
  for (let i = 0; i < 60; i++) sample(i * 16.667, 16.667, 1, 4.0, 0);
  const line = readout(4, 1280, 720, 2, 'tidepool');

  assert.equal(line.indexOf('\n'), -1, 'the bench logs ONE line per readout');
  const r = JSON.parse(line);
  assert.deepEqual(Object.keys(r).sort(), headerKeys(),
    'the readout and its header disagree about the shape three shells log and one '
    + 'parser reads');

  // The property the whole comparison rests on, crossing the real shim: an
  // absent cost is not a free one. `0` in and `null` out, never a zero.
  assert.equal(r.gpu, null, 'no GPU timer is ABSENT — a 0 here would read as a free frame');
  assert.ok(r.cpu && r.cpu.p95 > 0, 'a cost that WAS measured is reported');
  assert.equal(r.verdict, 'good');
});

test('the bench field is exactly what ttp_session_begin_field takes', async () => {
  // The claim ttp_race.h makes about the answer, driven end to end on the
  // artifact: a harness with no room hands the two arrays straight over and
  // gets a session. Anything else — a wrapper object, a renamed key, a bots
  // array the session rejects — is a bench that cannot start, and the C++ side
  // cannot see it because both halves are correct in isolation.
  const M = await load();
  const c = (n, r, a) => M.cwrap(n, r, a);
  const manifest = JSON.parse(c('ttp_protocol_manifest_json', 'string', [])());
  const cat = JSON.parse(c('ttp_ui_catalogue_json', 'string', [])());
  assert.equal(c('ttp_race_configure', 'number', ['string'])(JSON.stringify({
    fieldSize: manifest.FIELD_SIZE,
    carCount: manifest.CAR_MODELS.length,
    colorCount: manifest.CAR_COLORS.length,
    aiPrefix: 'ai-',
    personas: JSON.parse(c('ttp_race_personas_json', 'string', [])()),
    carStats: manifest.CAR_STATS,
    cups: cat.cups
  })), 1, 'the race layer configures');

  const PLAYERS = 4;
  const bench = JSON.parse(c('ttp_race_bench_field_json', 'string',
    ['string', 'number', 'number'])('tidepool', PLAYERS, 42));
  assert.equal(bench.field.length, manifest.FIELD_SIZE, 'a full grid');
  const players = bench.field.filter((e) => !e.ai);
  assert.equal(players.length, PLAYERS);
  // Players at the BACK is the game's own grid rule, not the bench's — a bench
  // that started them at the front would be measuring a different race.
  assert.deepEqual(bench.field.slice(-PLAYERS), players);
  // Every seat autopiloted, players included: that marker is what makes the
  // measured race a race rather than eight cars in the first barrier.
  assert.equal(bench.bots.length, manifest.FIELD_SIZE);
  assert.equal(bench.bots.filter((b) => b.player).length, PLAYERS);

  const h = c('ttp_session_begin_field', 'number',
    ['string', 'number', 'number', 'string', 'string', 'string'])(
    'tidepool', 42, 3, null, JSON.stringify(bench.field), JSON.stringify(bench.bots));
  try {
    assert.ok(h > 0, 'the two arrays go straight into a session');
    const seated = JSON.parse(c('ttp_snapshot_json', 'string', ['number'])(h)).cars
      .map((car) => car.id);
    assert.equal(seated.length, manifest.FIELD_SIZE, 'the whole grid is on the track');
    for (const p of players) {
      assert.ok(seated.includes(p.peerIndex),
        `player seat ${p.peerIndex} was dropped on the way into the session — a bench `
        + 'measuring a grid short of the cars it asked for');
    }
  } finally {
    c('ttp_dispose', null, ['number'])(h);
  }
});
