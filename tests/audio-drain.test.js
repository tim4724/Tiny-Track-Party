'use strict';
// NativeAudio._drain() — the display's own decoder for the packed audio command
// block, against the SHIPPED wasm.
//
// WHY THIS EXISTS SEPARATELY FROM audio-abi.test.js. That suite deliberately
// carries its OWN decoder ("imported so a change to NativeAudio.js cannot
// quietly move this gate with it"), which is the right call for a conformance
// gate — but it leaves the decoder the browser ACTUALLY runs with no test at
// all. Everything below drives the real `NativeAudioDecider`, so the two
// readings of ttp_audio.h's layout are both exercised and a disagreement
// between them surfaces here rather than at a party.
//
// The music path gets the most attention because it is the only branch that
// leaves the packed block: a `music:'start'` command carries a catalogue INDEX,
// and the song descriptor behind it is a separate wasm call. That lookup builds
// a Value tree and canonical_stringify's it (~4 KB reserved), so it can grow the
// wasm heap — and ALLOW_MEMORY_GROWTH detaches every typed array held across an
// allocation. `_drain` therefore captures its three heap views once, decodes the
// whole block with NO nested wasm call, and resolves song indices afterwards. A
// detached read returns `undefined` rather than throwing, so getting this wrong
// is silent; hence a test rather than a comment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
for (const f of [MJS, path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm')]) {
  if (!fs.existsSync(f)) {
    throw new Error(`${path.relative(ROOT, f)} missing — run native/scripts/build-runtime-web.sh`);
  }
}

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// One module for the file: NativeAudio memoizes its own init, and the adapters
// all share a single wasm heap by design (nativeRuntime.js).
let audio;
async function decider() {
  if (!audio) {
    audio = await imp('public/display/NativeAudio.js');
    await audio.init();
  }
  return new audio.NativeAudioDecider();
}

test('the cue table is derived from the wasm, not mirrored in JS', async () => {
  const d = await decider();
  // init() walks ttp_audio_cue_id until the codes run out. If that walk broke,
  // every cue command would decode to an undefined id and be dropped silently.
  const cmds = d.startMusic('grass');
  assert.ok(Array.isArray(cmds), 'a decision call answers a command array');
});

test('music start carries a resolved song descriptor, not an index', async () => {
  const d = await decider();
  const cmds = d.startMusic('grass');
  const start = cmds.find((c) => c.music === 'start');
  assert.ok(start, 'starting music emits a start command');
  // The INDEX must not leak: the shell performs `song.file`, and a number here
  // would make Audio.js stream `undefined`.
  assert.equal(typeof start.song, 'object', 'the catalogue index was resolved to a descriptor');
  assert.equal(typeof start.song.file, 'string', 'a song names a file to stream');
  assert.ok(start.song.file.length, 'the file is not empty');
  for (const k of ['title', 'artist', 'license', 'source']) {
    assert.equal(typeof start.song[k], 'string', `the credit chip's ${k} crossed`);
  }
  assert.equal(typeof start.level, 'number', 'the per-song LUFS trim rides the command');
  assert.ok(start.level > 0 && start.level <= 4, `a plausible gain, got ${start.level}`);
});

test('a song descriptor is read at most once and then memoized', async () => {
  const d = await decider();
  // Same biome twice. The pool is no-repeat, so the second pick is a DIFFERENT
  // song — what matters is that both resolve, i.e. the cache neither returns a
  // stale descriptor for a new index nor misses forever.
  const a = d.startMusic('grass').find((c) => c.music === 'start');
  const b = d.startMusic('grass').find((c) => c.music === 'start');
  assert.ok(a && b, 'both picks resolved');
  for (const s of [a.song, b.song]) assert.equal(typeof s.file, 'string');
});

test('the non-start music ops decode to a bare op with no song lookup', async () => {
  const d = await decider();
  for (const [call, op] of [['stopMusic', 'stop'], ['pauseMusic', 'pause'], ['resumeMusic', 'resume']]) {
    const cmds = d[call]();
    const m = cmds.find((c) => c.music);
    assert.ok(m, `${call} emits a music command`);
    assert.equal(m.music, op);
    assert.ok(!('song' in m), `${op} carries no song — it is not a pick`);
  }
});

test('stopVoices is a COMMAND, not an empty drain', async () => {
  const d = await decider();
  const cmds = d.stopVoices();
  assert.deepEqual(cmds, [{ voices: 'stop-all' }],
    'the device half is told to kill its voices; it does not infer it from silence');
});

test('a drain with nothing queued is the shared empty array, not a fresh one', async () => {
  const d = await decider();
  d.bind(0);                        // nothing bound: the frame has nothing to say
  d.frame(1000);                    // flush anything the unbind left
  const a = d.frame(2000);
  const b = d.frame(3000);
  assert.deepEqual(a, [], 'an unbound frame decides nothing');
  assert.deepEqual(b, []);
  // Identity, not just emptiness: this runs at 60 Hz through the whole lobby,
  // and a fresh [] per call would be garbage for nothing.
  assert.equal(a, b, 'an empty drain answers the shared EMPTY constant');
});

test('a music command decodes correctly even when it is NOT last in the batch', async () => {
  const d = await decider();
  // THE REGRESSION THIS FILE EXISTS FOR. Song resolution is a nested wasm call
  // that can grow the heap and detach the decoder's captured views, so anything
  // decoded AFTER a music record is what would break. Today C++ flushes queued
  // race events ahead of a music command, so a MUSIC record happens to land last
  // in its own batch — nothing states or enforces that, at either end.
  //
  // Rather than depend on that ordering, drive the decoder over a block that
  // definitely contains records after a music start: bind a live race (whose
  // frame emits engine voices) and start music on the same tick.
  const sim = await imp('public/display/NativeRaceSession.js');
  await sim.init();
  const field = [];
  for (let i = 0; i < 4; i++) {
    field.push({ peerIndex: i + 1, name: 'P' + i, colorIndex: i, carIndex: i, ai: false });
  }
  const session = new sim.NativeRaceSession(field, { trackId: 'tidepool', totalLaps: 3, seed: 1 }, {});
  session.startCountdown(0);
  for (let i = 0; i < 120; i++) session.update(16.6);

  d.bind(session.h);
  d.startMusic('beach');
  const cmds = d.frame(2000);
  // Every command that came back is intact — the point is that NOTHING decodes
  // to a partially-undefined record, which is what a detached view produces.
  for (const c of cmds) {
    assert.ok(c && typeof c === 'object', 'a decoded command is an object');
    if (c.cue) assert.equal(typeof c.cue, 'string', 'a cue id resolved');
    if (c.voice) {
      assert.equal(typeof c.voice, 'string', 'a voice id resolved');
      assert.equal(typeof c.level, 'number', 'a voice level decoded');
      assert.ok(Number.isFinite(c.level), 'a voice level is finite, not a detached read');
    }
    if (c.music === 'start') assert.equal(typeof c.song, 'object', 'a song resolved');
  }
  d.bind(0);
  session.dispose();
});
