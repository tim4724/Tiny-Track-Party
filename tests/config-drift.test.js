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
