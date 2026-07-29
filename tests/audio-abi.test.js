'use strict';
// The AUDIO C ABI (native/runtime/ttp_audio.h), as the browser finds it in the
// SHIPPED module (public/display/engine/native/ttp_runtime.{mjs,wasm}).
//
// WHAT THIS GATE IS FOR, and it is not the decisions. Those are
// libttp-runtime/ttp/audio.cc, replayed against tests/fixtures/audio-corpus.jsonl
// by the `audio` ctest on all four legs — 6397 cases recorded off
// public/display/audio/decide.js while it was the only implementation. What no
// ctest can see is the SEAM this file covers: the shape of the surface
// NativeAudio.js binds to, the two lookups it derives its tables from, and —
// the real subject — the WIRING behind ttp_audio_frame. Those decisions are a
// pure function of a world, and something has to read that world off the live
// race: which cars are listeners, where the event happened, what a rocket's
// world point is, what order beats come out in. The corpus pins the function;
// this pins the arguments.
//
// So the last test races one field twice at once: through the native bus, and
// through the JS oracle driven the way main.js used to drive it (a snapshot per
// frame, an event queue, world points asked for over the boundary one call at a
// time). Command for command, they must agree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');

for (const f of [MJS, WASM]) {
  if (!fs.existsSync(f)) {
    throw new Error(`${path.relative(ROOT, f)} missing — run native/scripts/build-runtime-web.sh`);
  }
}

let modPromise = null;
const load = () => (modPromise = modPromise
  || import(pathToFileURL(MJS).href).then((m) => m.default()));

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

// TtpAudioCmd.kind / .flags — the reader's constants, kept here rather than
// imported so a change to NativeAudio.js cannot quietly move this gate with it.
const CMD = { CUE: 1, COUNTDOWN: 2, VOICE: 3, VOICE_STOP: 4, STOP_ALL: 5, STOP_CAR: 6, MUSIC: 7 };
const F_GO = 1;
const F_MOD = 2;
const HEADER_BYTES = 16;
const BLOCK_VERSION = 1;

// The packed block -> plain records. A second decoder on purpose: if this one
// and NativeAudio.js's ever disagree, one of them is misreading the layout.
function drain(M) {
  const ptr = M._ttp_audio_drain();
  assert.ok(ptr, 'ttp_audio_drain never answers null');
  const u32 = M.HEAPU32;
  const i32 = M.HEAP32;
  const f64 = M.HEAPF64;
  const head = ptr >> 2;
  assert.equal(u32[head], BLOCK_VERSION, 'TTP_AUDIO_BLOCK_VERSION');
  const count = u32[head + 1];
  const stride = u32[head + 2];
  assert.equal(u32[head + 3], 0, 'the block header carries no flags yet');
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = ptr + HEADER_BYTES + i * stride;
    const at = off >> 2;
    out.push({
      kind: i32[at], code: i32[at + 1], subject: i32[at + 2], flags: u32[at + 3],
      level: f64[(off + 16) >> 3],
      mod: (u32[at + 3] & F_MOD)
        ? { rateMul: f64[(off + 24) >> 3], gainMul: f64[(off + 32) >> 3], lpMul: f64[(off + 40) >> 3] }
        : null
    });
  }
  return out;
}

test('the shipped module exports the audio ABI the shell binds to', async () => {
  const M = await load();
  for (const name of ['bind', 'frame', 'roster', 'stop_voices', 'stop_car',
                      'music', 'drain', 'cue_id', 'song_json']) {
    assert.equal(typeof M[`_ttp_audio_${name}`], 'function',
      `_ttp_audio_${name} is not exported — the browser would fail at the cwrap call`);
  }
});

test('the cue codes name cues the device can actually play', async () => {
  const M = await load();
  const cueId = M.cwrap('ttp_audio_cue_id', 'string', ['number']);
  const cuePtr = M.cwrap('ttp_audio_cue_id', 'number', ['number']);
  // NativeAudio.js builds its whole table this way — walk until the wasm runs
  // out of names — which is why there is no mirror of these strings in the
  // browser to drift. What the walk cannot check is that the names mean
  // anything to the cue palette, and that is the failure that would be silent:
  // a renamed cue plays NOTHING, at no console cost.
  const { CUES, resolveVariant } = await imp('public/display/audio/cues.js');
  const names = [];
  for (let code = 1; ; code++) {
    const id = cueId(code);
    if (!id) break;
    names.push(id);
    assert.ok(resolveVariant(id, {}), `TTP_CUE code ${code} ("${id}") resolves to a variant`);
  }
  assert.equal(names.length, 16, 'the cue vocabulary is sixteen wide');
  // The ORDER is the code, so it is pinned, not just the set.
  assert.deepEqual(names, [
    'pickup', 'roulette', 'banana_drop', 'monster_inflate', 'monster_deflate',
    'banana_slip', 'rocket_hit', 'screech', 'lap', 'join', 'countdown',
    'boost', 'corner', 'brake', 'engine_putt', 'rocket_fire'
  ]);
  assert.equal(cuePtr(0), 0, 'code 0 is "no cue", not the first one');
  assert.equal(cuePtr(-1), 0, 'nothing below the table');
  assert.equal(cuePtr(names.length + 1), 0, 'nothing past the end of it');
  // Every cue the palette can play need not have a code (the galleries fire
  // some directly), but every code must be a cue.
  const known = new Set(CUES.map((c) => c.id));
  for (const n of names) assert.ok(known.has(n), `${n} is in the cue table`);
});

test('the song catalogue is one table, in one order', async () => {
  const M = await load();
  const songJson = M.cwrap('ttp_audio_song_json', 'string', ['number']);
  // A music command carries an INDEX; NativeAudio.js resolves it through this
  // call. The JS table survives as DATA (audio/musicCatalogue.js — the music
  // gallery and the credits test read it), so the two exist at once and this is
  // the only place they meet: index for index, field for field, including the
  // authored LUFS trims that audio-corpus.jsonl records as a level.
  const { RACE_MUSIC } = await imp('public/display/audio/musicCatalogue.js');
  const flat = [];
  for (const biome of ['beach', 'playroom', 'snow', 'grass', 'canyon']) {
    for (const song of RACE_MUSIC[biome]) flat.push(song);
  }
  assert.equal(flat.length, 24, 'twenty-four songs over five pools');
  flat.forEach((song, i) => {
    const got = JSON.parse(songJson(i));
    assert.ok(got, `song ${i} exists in the wasm`);
    for (const k of ['file', 'title', 'duration', 'lufs', 'gain', 'artist', 'license', 'source']) {
      assert.equal(got[k], song[k], `song ${i} (${song.title}) agrees on ${k}`);
    }
  });
  assert.equal(JSON.parse(songJson(flat.length)), null, 'nothing past the end of the catalogue');
  assert.equal(JSON.parse(songJson(-1)), null, 'nothing below it');
});

test('the audio bus is a safe no-op with nothing bound', async () => {
  const M = await load();
  // ttp_abi.h: an absent singleton answers emptily rather than trapping. The
  // display calls frame() from a rAF loop that is already running before a race
  // exists, and stop_voices from teardown paths that may have unbound first.
  const frame = M.cwrap('ttp_audio_frame', null, ['number']);
  const bind = M.cwrap('ttp_audio_bind', null, ['number']);
  const music = M.cwrap('ttp_audio_music', null, ['number', 'string']);
  bind(0);
  assert.doesNotThrow(() => { frame(0); frame(16.7); M._ttp_audio_stop_voices(); });
  drain(M);                       // whatever the calls above left, take it away
  bind(4242);                     // a handle that never existed
  frame(1000);
  assert.deepEqual(drain(M), [], 'no session, nothing to say');
  assert.doesNotThrow(() => music(99, null), 'an unknown music op makes no sound');
  assert.deepEqual(drain(M), []);
  bind(0);
});

// ---- the wiring, and what used to be here -----------------------------------
// A test called "the native bus decides a live race exactly as the JS oracle
// does" stood here: it raced one field twice at once — through the native bus,
// and through AudioDecider driven the way main.js used to drive it — and
// required 3600 frames of identical commands. It went with decide.js when the
// audio oracle was retired, because it WAS the oracle running.
//
// Be clear about what that cost, because it is not nothing: it was the only
// check anywhere that ran the SHIPPED wasm against a second implementation at
// RUNTIME. What still covers the same ground, and what does not:
//
//   * the DECISIONS are covered as well as ever — tests/fixtures/audio-corpus.jsonl
//     is unchanged (the JS wrote it), the `audio` ctest replays all 6397 cases on
//     four legs, and `record_audio` now also holds a C++ re-emission of it
//     byte-identical.
//   * the WORLD those decisions read is covered by the corpus's 5900 trace
//     frames: audio_check re-races the golden trace and asserts the snapshot
//     hash per frame, so a wrong listener set or event point fails there.
//   * the ABI wiring is covered by abi_check's audio pass.
//   * what is NOT covered any more is the composition of all three inside the
//     shipped artifact, on a live race. The pieces are each gated; their
//     assembly in ttp_runtime.wasm is not.
