'use strict';
// Cross-layer config drift guards. The sim engine (native/libttp-sim/ttp/game.*)
// is standalone C++ — it cannot import public/shared/protocol.js — so a few
// shared-in-concept constants are duplicated there as fallbacks/benchmarks rather
// than carried across. These tests are the tripwire: if the protocol-side value
// moves, the engine-side constant must move in the same commit.
//
// Each constant is guarded TWICE, on purpose:
//   (a) against the C++ SOURCE TEXT — always runs, needs no build, and points at
//       the file a developer actually edits;
//   (b) against the LIVE wasm engine — proves the constant really reaches the
//       shipped snapshot (skipped when the wasm artifacts are not built).
// The source-text guards are deliberately literal: a reformat FAILS them loudly
// rather than silently matching nothing, which is the right failure direction for
// a tripwire.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const protocol = require('../public/shared/protocol.js');

const ROOT = path.join(__dirname, '..');
const GAME_CC = path.join(ROOT, 'native/libttp-sim/ttp/game.cc');
const GAME_H = path.join(ROOT, 'native/libttp-sim/ttp/game.h');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');

const skip = fs.existsSync(MJS) && fs.existsSync(WASM)
  ? false
  : 'ttp_runtime.mjs/.wasm not built — run native/scripts/build-runtime-web.sh';

// The controller's two steering modules, loaded live rather than scraped: both
// are browser ES modules written to import headlessly (see their headers).
let tilt, gate;
test.before(async () => {
  tilt = await import(pathToFileURL(path.join(ROOT, 'public/controller/TiltInput.js')).href);
  gate = await import(pathToFileURL(path.join(ROOT, 'public/controller/InputGate.js')).href);
});

// The runtime C ABI, same cwrap conventions as tests/runtime-abi.test.js (ids
// cross as JSON scalars; null stats = the engine benchmark car).
async function loadAbi() {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const Module = await factory();
  const cw = (name, ret, args) => Module.cwrap(name, ret, args);
  return {
    begin: cw('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
    addHuman: cw('ttp_add_human', 'void', ['number', 'string', 'string']),
    start: cw('ttp_session_start', 'void', ['number', 'number']),
    update: cw('ttp_update', 'void', ['number', 'number']),
    snapshot: cw('ttp_snapshot_json', 'string', ['number']),
    dispose: cw('ttp_dispose', 'void', ['number']),
    getSteerExpo: cw('ttp_get_steer_expo', 'number', []),
  };
}

// One benchmark car on a catalogue track, stepped once, as a snapshot. `laps` is
// passed through verbatim, so laps = 0 exercises the engine's own fallback.
async function benchmarkCarSnap(abi, laps) {
  const h = abi.begin('tidepool', 42, laps, null);
  assert.ok(h > 0, 'session_begin returned a handle');
  abi.addHuman(h, '1', null); // null stats = the engine's benchmark defaults
  abi.start(h, -1);           // no countdown: racing from frame 0
  abi.update(h, 1000 / 60);
  const car = JSON.parse(abi.snapshot(h)).cars[0];
  abi.dispose(h);
  return car;
}

test('engine totalLaps fallback matches protocol TOTAL_LAPS (C++ source)', () => {
  const src = fs.readFileSync(GAME_CC, 'utf8');
  const m = /totalLaps_\(track\.totalLaps \? track\.totalLaps : (\d+)\)/.exec(src);
  assert.ok(m, 'found the totalLaps fallback in game.cc (regex still matches the source)');
  assert.equal(Number(m[1]), protocol.TOTAL_LAPS,
    'game.cc `track.totalLaps ? track.totalLaps : N` fallback drifted from protocol.TOTAL_LAPS');
});

test('engine benchmark collision footprint matches the protocol reference car (C++ source)', () => {
  // A stats-less car gets the engine benchmark (ttp::Stats' member defaults).
  // protocol.CAR_STATS holds the per-model footprints measured from the Kenney
  // meshes; index 0 (Dash) is the reference body both sides were authored against.
  const src = fs.readFileSync(GAME_H, 'utf8');
  const m = /struct Stats \{[^}]*halfLen = ([\d.]+), halfWid = ([\d.]+);/.exec(src);
  assert.ok(m, 'found ttp::Stats defaults in game.h (regex still matches the source)');
  const ref = protocol.carStats(0);
  assert.equal(Number(m[1]), ref.halfLen, 'ttp::Stats::halfLen drifted from protocol.CAR_STATS[0]');
  assert.equal(Number(m[2]), ref.halfWid, 'ttp::Stats::halfWid drifted from protocol.CAR_STATS[0]');
});

test('the live wasm engine ships those same values', { skip }, async () => {
  const abi = await loadAbi();

  // laps = 0 is "the track carries no totalLaps", so the engine fallback applies.
  const fallback = await benchmarkCarSnap(abi, 0);
  assert.equal(fallback.totalLaps, protocol.TOTAL_LAPS,
    'live engine totalLaps fallback drifted from protocol.TOTAL_LAPS');

  // Sanity: an explicit lap count is still honoured (the fallback is a fallback,
  // not a hard-coded value).
  const explicit = await benchmarkCarSnap(abi, protocol.TOTAL_LAPS + 2);
  assert.equal(explicit.totalLaps, protocol.TOTAL_LAPS + 2, 'explicit laps must win over the fallback');

  const ref = protocol.carStats(0);
  assert.equal(fallback.halfLen, ref.halfLen, 'live engine benchmark halfLen drifted from protocol.CAR_STATS[0]');
  assert.equal(fallback.halfWid, ref.halfWid, 'live engine benchmark halfWid drifted from protocol.CAR_STATS[0]');
  assert.equal(fallback.monster, false, 'sanity: the snapshot footprint is unmultiplied (not the x1.3 monster body)');
});

// ---------------------------------------------------------------------------
// The steering contract: protocol.js STEER vs the three files that spend it.
//
// STEER_EXPO (the sim), ROLL_LOCK (the phone) and the CONTROL gate's dead-band
// are one design, and the third is ARITHMETIC over the first two. Before the
// manifest existed that was stated only in prose, in a file that owns none of
// the numbers it reasons about — so tuning the steering curve in C++ left a
// controller comment quietly describing a car that no longer exists.
//
// Four links, all machine-checked, and only the first two live here:
//   1. TiltInput/InputGate  == the manifest        (this file, below)
//   2. InputGate's derivation still closes          (this file, below)
//   3. protocol.h           == protocol.js          (protocol-corpus + `protocol` ctest)
//   4. game.cc              == protocol.h           (the same ctest's own assertion)
// Plus the belt-and-braces guard this file already applies to everything else:
// read the value back out of the SHIPPED wasm, not just the sources.
// ---------------------------------------------------------------------------

test('TiltInput spends the manifest steering numbers', () => {
  const S = protocol.STEER;
  assert.equal(tilt.ROLL_LOCK, S.ROLL_LOCK_DEG, 'TiltInput ROLL_LOCK drifted from protocol.STEER.ROLL_LOCK_DEG');
  assert.equal(tilt.DEADZONE, S.DEADZONE, 'TiltInput DEADZONE drifted from protocol.STEER.DEADZONE');
  assert.equal(tilt.SMOOTH, S.SMOOTH, 'TiltInput SMOOTH drifted from protocol.STEER.SMOOTH');
});

test('InputGate spends the manifest steering numbers', () => {
  assert.equal(gate.DEFAULT_STEER_THRESHOLD, protocol.STEER.GATE_THRESHOLD,
    'InputGate DEFAULT_STEER_THRESHOLD drifted from protocol.STEER.GATE_THRESHOLD');
});

test("InputGate's dead-band derivation still closes over the manifest", () => {
  const S = protocol.STEER;
  const t = S.GATE_THRESHOLD;

  // Lower bound — the gate must ENGAGE. A phone lying still twitches
  // SENSOR_NOISE_FLOOR_DEG at the quiet end; over ROLL_LOCK_DEG that is a
  // fraction of full steer, and TiltInput's one-pole SMOOTH takes roughly half
  // of it back out. A threshold under what survives calls every idle sample a
  // change, so the gate passes everything and saves nothing.
  const survivingNoise = (gate.SENSOR_NOISE_FLOOR_DEG / S.ROLL_LOCK_DEG) * S.SMOOTH;
  assert.ok(t >= survivingNoise,
    `gate threshold ${t} is under the ${survivingNoise} of sensor wobble that survives `
    + `ROLL_LOCK_DEG=${S.ROLL_LOCK_DEG} and SMOOTH=${S.SMOOTH} — the gate would never engage`);

  // Upper bound — the gate must not HIDE too much. Worst case is |s| -> 1, where
  // the display's expo gain peaks at EXPO itself.
  assert.ok(t * S.EXPO <= gate.STEER_ERROR_BUDGET,
    `gate threshold ${t} at the display's peak expo gain ${S.EXPO} hides ${t * S.EXPO} of `
    + `steer authority, over the ${gate.STEER_ERROR_BUDGET} budget`);

  // And the band has to be a band: a floor above the ceiling means no threshold
  // satisfies both, i.e. the four numbers no longer describe one design.
  assert.ok(survivingNoise * S.EXPO <= gate.STEER_ERROR_BUDGET,
    'no gate threshold can satisfy both bounds — the steering manifest is self-contradictory');
});

test('the live wasm engine ships the manifest steering exponent', { skip }, async () => {
  const abi = await loadAbi();
  // Read before anything calls ttp_set_steer_expo, so this is game.cc's own
  // default arriving in the browser — the number the shipped game actually
  // steers with, not a source literal.
  assert.equal(abi.getSteerExpo(), protocol.STEER.EXPO,
    'the shipped wasm steering exponent drifted from protocol.STEER.EXPO');
});
