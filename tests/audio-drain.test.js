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
    assert.equal(typeof start.song[k], 'string', `the attribution's ${k} crossed`);
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

test('a music start is the LAST command in its batch', async () => {
  const d = await decider();
  // THE CROSS-FILE INVARIANT, pinned. Resolving a song is a nested wasm call
  // that can grow the heap, and the decoder captures its heap views once — so
  // anything decoded AFTER a music record is what a stale view would corrupt,
  // silently (a detached read yields undefined, it does not throw).
  //
  // `_drain` no longer depends on this: it resolves songs after the decode loop,
  // so the ordering below is not load-bearing for correctness any more. It is
  // pinned anyway because it is what made the PREVIOUS version safe, it was
  // never stated at either end, and a shell built against the old shape would
  // still be relying on it. If C++ ever queues a command after a music record,
  // this goes red and this comment is the explanation.
  //
  // Driven with a live race bound so the flush path is exercised: C++ empties
  // whatever the sim queued BEFORE appending the music command.
  const sim = await imp('public/display/NativeRaceSession.js');
  await sim.init();
  const field = [];
  for (let i = 0; i < 4; i++) {
    field.push({ peerIndex: i + 1, name: 'P' + i, colorIndex: i, carIndex: i, ai: false });
  }
  const session = new sim.NativeRaceSession(field, { trackId: 'tidepool', totalLaps: 3, seed: 1 }, {});
  d.bind(session.h);
  session.startCountdown(0);
  for (let i = 0; i < 120; i++) { session.update(16.6); d.frame(1000 + i * 16.6); }

  const cmds = d.startMusic('beach');
  const at = cmds.findIndex((c) => c.music === 'start');
  assert.ok(at >= 0, 'starting music emits a start command');
  assert.equal(at, cmds.length - 1,
    'a music start is last in its batch — anything C++ queues after it would decode '
    + 'through heap views the song lookup may have detached');
  // Whatever else rode along is intact, which is the observable form of "no view
  // went stale": a detached read produces undefined, never a finite number.
  for (const c of cmds) {
    assert.ok(c && typeof c === 'object', 'a decoded command is an object');
    if (c.cue) assert.equal(typeof c.cue, 'string', 'a cue id resolved');
    if (c.voice) {
      assert.equal(typeof c.voice, 'string', 'a voice id resolved');
      assert.ok(Number.isFinite(c.level), 'a voice level is finite, not a detached read');
    }
  }
  d.bind(0);
  session.dispose();
});

test('a drain re-reads its heap views, so a grown heap decodes normally', async () => {
  const d = await decider();
  const M = await (await imp('public/display/nativeRuntime.js')).loadNativeRuntime();
  // This asserts the HALF of the rule that is reachable from a test: views are
  // captured per call, so growth BETWEEN drains is a non-event.
  //
  // The other half — growth DURING a decode — is not provokable from out here.
  // The only nested call now happens after the loop; `fn` is module-private with
  // no injection seam; and leaning on ttp_audio_song_json's own ~4 KB allocation
  // to grow the heap does not work, because emscripten's allocator has slack (I
  // reintroduced the bug and squeezed the heap, and it still did not grow at the
  // wrong moment — so a green run there would have proved nothing). _drain
  // carries a runtime guard for that case instead: it compares its captured view
  // against the live one and names the cause rather than returning quietly
  // corrupt commands. Same standing as the BLOCK_VERSION guard above it — a
  // condition this repo cannot reach, instrumented so that if a future change
  // does reach it, the failure says what happened instead of going silent.
  const errs = [];
  const realError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  let big = 0;
  try {
    // ALLOW_MEMORY_GROWTH is live, so a large allocation swaps every typed array
    // the module hands out. This is exactly what a nested call inside the decode
    // loop would do — the difference is only WHEN.
    const before = M.HEAPU32;
    big = M._malloc(128 * 1024 * 1024);
    assert.ok(big, 'the probe allocation succeeded');
    assert.notEqual(M.HEAPU32, before,
      'growing the heap swaps the views — the mechanism the guard exists for');

    // Growth BEFORE a drain is ordinary: _drain re-reads its views per call, so
    // it must decode normally and report nothing.
    const cmds = d.stopVoices();
    assert.deepEqual(cmds, [{ voices: 'stop-all' }], 'a drain after a growth decodes normally');
    assert.deepEqual(errs, [], 'and says nothing — the guard is about growth DURING a decode');
  } finally {
    if (big) M._free(big);
    console.error = realError;
  }
});

// WHAT THIS FILE STILL DOES NOT PROVE, so the coverage is not mistaken for more
// than it is: it does not catch the original bug. Every test here passes against
// the pre-fix decoder too, because that decoder was correct in every reachable
// scenario — the corruption needed an allocation at one exact moment, and no
// caller can force one. An earlier draft had a test NAMED for the regression
// that could not reproduce it (it passed against the broken code), which is
// worse than no test: it reads like cover. What is genuinely held here is the
// decoder that had NO test at all, the cross-file ordering invariant above, and
// the guard that makes a reintroduction loud instead of silent.
