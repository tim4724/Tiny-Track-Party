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
  // call. The JS table survives for the music gallery and the credits test, so
  // the two exist at once and this is the only place they meet — index for
  // index, field for field, including the authored LUFS trims that
  // audio-corpus.jsonl records as a level.
  const { RACE_MUSIC } = await imp('public/display/audio/decide.js');
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

// ---- the wiring, against the oracle -----------------------------------------
test('the native bus decides a live race exactly as the JS oracle does', async () => {
  const M = await load();
  const { AudioDecider } = await imp('public/display/audio/decide.js');

  const c = (n, r, a) => M.cwrap(n, r, a);
  const abi = {
    begin: c('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
    addHuman: c('ttp_add_human', null, ['number', 'string', 'string']),
    addBot: c('ttp_add_bot', null, ['number', 'string', 'number', 'number', 'number', 'string']),
    start: c('ttp_session_start', null, ['number', 'number']),
    update: c('ttp_update', null, ['number', 'number']),
    input: c('ttp_process_input', null, ['number', 'string', 'number', 'number', 'number', 'number']),
    snapshot: c('ttp_snapshot_json', 'string', ['number']),
    events: c('ttp_events_json', 'string', ['number']),
    carWorldPos: c('ttp_car_world_pos', 'number', ['number', 'string', 'number']),
    trackPoint: c('ttp_track_point', 'number', ['number', 'number', 'number', 'number']),
    dispose: c('ttp_dispose', null, ['number']),
    bind: c('ttp_audio_bind', null, ['number']),
    frame: c('ttp_audio_frame', null, ['number'])
  };
  const vecPtr = M._malloc(3 * 8);
  const vec = () => ({
    x: M.HEAPF64[vecPtr >> 3], y: M.HEAPF64[(vecPtr >> 3) + 1], z: M.HEAPF64[(vecPtr >> 3) + 2]
  });

  const CUE_CODES = ['pickup', 'roulette', 'banana_drop', 'monster_inflate', 'monster_deflate',
    'banana_slip', 'rocket_hit', 'screech', 'lap', 'join', 'countdown',
    'boost', 'corner', 'brake', 'engine_putt', 'rocket_fire'];

  // ONE decider for the whole test, on both sides: the native bus is a
  // singleton whose state outlives a race (the lap/screech spacing clocks, the
  // live-voice set), so a second race that agreed only because both sides were
  // freshly constructed would prove nothing.
  const dec = new AudioDecider({ rng: () => { throw new Error('this race draws no randomness'); } });
  let nowMs = 0;
  const seen = { beat: 0, cue: 0, voice: 0, stop: 0, mod: 0, jet: 0, boom: 0 };
  // subject -> the car/rocket id the oracle used. Interning is the native
  // side's own bookkeeping (ttp_audio.h: no car id crosses), so the streams can
  // only be compared through a consistent bijection — which is itself the thing
  // worth checking about it. Valid within a STOP_ALL epoch, which is exactly
  // when both sides forget every voice they had.
  let subjectOf = new Map();
  let idOf = new Map();
  const sameSubject = (subject, id, where) => {
    if (subjectOf.has(id)) {
      assert.equal(subjectOf.get(id), subject, `${where}: ${id} kept its subject`);
    } else {
      assert.ok(!idOf.has(subject), `${where}: subject ${subject} is not reused for ${id}`);
      subjectOf.set(id, subject);
      idOf.set(subject, id);
    }
  };

  // Compare one batch of native commands against the oracle's, in order.
  const agree = (got, want, at) => {
    assert.equal(got.length, want.length,
      `${at}: ${got.length} native commands vs ${want.length} from the oracle\n`
      + `  native ${JSON.stringify(got)}\n  oracle ${JSON.stringify(want)}`);
    got.forEach((g, i) => {
      const w = want[i];
      const where = `${at} cmd ${i}`;
      if (w.voices === 'stop-all') {
        assert.equal(g.kind, CMD.STOP_ALL, `${where}: stop every voice`);
        subjectOf = new Map();
        idOf = new Map();
      } else if (w.voices === 'stop-car') {
        assert.equal(g.kind, CMD.STOP_CAR, `${where}: stop one car's voices`);
        sameSubject(g.subject, w.id, where);
      } else if (w.cue === 'countdown') {
        seen.beat++;
        assert.equal(g.kind, CMD.COUNTDOWN, `${where}: a countdown beat`);
        assert.equal(!!(g.flags & F_GO), w.part === 'go', `${where}: ${w.part}`);
      } else if (w.cue !== undefined) {
        seen.cue++;
        if (w.cue === 'rocket_hit') seen.boom++;
        assert.equal(g.kind, CMD.CUE, `${where}: a one-shot`);
        assert.equal(CUE_CODES[g.code - 1], w.cue, `${where}: cue id`);
        assert.equal(g.level, w.gain, `${where}: ${w.cue} gain`);
      } else if (w.voice !== undefined && w.stop) {
        seen.stop++;
        assert.equal(g.kind, CMD.VOICE_STOP, `${where}: a voice stop`);
        assert.equal(CUE_CODES[g.code - 1], w.voice, `${where}: voice id`);
        sameSubject(g.subject, w.id, where);
      } else if (w.voice !== undefined) {
        seen.voice++;
        if (w.voice === 'rocket_fire') seen.jet++;
        if (w.mod) seen.mod++;
        assert.equal(g.kind, CMD.VOICE, `${where}: a voice level`);
        assert.equal(CUE_CODES[g.code - 1], w.voice, `${where}: voice id`);
        assert.equal(g.level, w.level, `${where}: ${w.voice} level`);
        assert.deepEqual(g.mod, w.mod || null, `${where}: ${w.voice} timbre`);
        sameSubject(g.subject, w.id, where);
      } else {
        assert.fail(`${where}: the oracle emitted ${JSON.stringify(w)} — unexpected here`);
      }
    });
  };

  // Two humans and two bots, so the AI/human split is load-bearing on both
  // sides: a CPU car is neither a listener nor a voice, and the native side
  // works that out from the sim's own bot list rather than being told.
  const AI = new Set(['ai-1', 'ai-2']);
  const race = (label, forceItem, frames) => {
    const h = abi.begin('tidepool', 42, 3, forceItem);
    assert.ok(h, `${label}: the session opened`);
    abi.addHuman(h, '0', null);
    abi.addHuman(h, '1', null);
    abi.addBot(h, '"ai-1"', 1, 0, 7, null);
    abi.addBot(h, '"ai-2"', 0.9, 0.3, 11, null);
    abi.bind(h);
    abi.start(h, 3);

    const listeners = () => {
      const out = [];
      for (const car of JSON.parse(abi.snapshot(h)).cars) {
        if (AI.has(car.id)) continue;
        if (abi.carWorldPos(h, JSON.stringify(car.id), vecPtr)) out.push(vec());
      }
      return out;
    };

    for (let f = 0; f < frames; f++) {
      // The humans have to actually DRIVE, or none of the interesting arms are
      // ever reached: this game has no lateral grip, so a car handed a constant
      // steer walls itself in three seconds and spends the race scrubbing along
      // a barrier at a quarter speed, never touching a box. A proportional pull
      // back to the centre line keeps them racing, grabbing and firing — while
      // still leaning hard enough into the corners to squeal, and still finding
      // the odd wall. `u` has to CHANGE to count as a press, hence the
      // alternation.
      for (const car of JSON.parse(abi.snapshot(h)).cars) {
        if (AI.has(car.id)) continue;
        const steer = Math.max(-1, Math.min(1, -car.lat * 1.2));
        abi.input(h, JSON.stringify(car.id), 7, steer,
          car.id === 0 && f % 211 === 0 ? 1 : 0, f % 37 === 0 ? 1 : 0);
      }
      abi.update(h, 1000 / 60);
      nowMs += 1000 / 60;

      // ---- the oracle, driven the way main.js drove it ----
      const want = [];
      for (const e of JSON.parse(abi.events(h))) {
        if (e.type === '_countdown') { want.push(...dec.countdown(e.n)); continue; }
        if (e.type === '_raceStart' || e.type === '_raceEnd') continue;
        let pos = null;
        if (e.type === 'rocket_expire') pos = abi.trackPoint(h, e.s, e.lat, vecPtr) ? vec() : null;
        else if (e.id != null) pos = abi.carWorldPos(h, JSON.stringify(e.id), vecPtr) ? vec() : null;
        want.push(...dec.event(e, { pos, humanPositions: listeners(), aiIds: AI, nowMs }));
      }
      const snap = JSON.parse(abi.snapshot(h));
      want.push(...dec.frame({
        cars: snap.cars,
        rockets: (snap.rockets || []).map((r) => ({
          id: r.id, pos: abi.trackPoint(h, r.s, r.lat, vecPtr) ? vec() : null
        })),
        aiIds: AI,
        nowMs
      }));

      // ---- the native bus ----
      abi.frame(nowMs);
      agree(drain(M), want, `${label} frame ${f}`);
    }

    // Race over, the way the shell ends one.
    M._ttp_audio_stop_voices();
    agree(drain(M), dec.stopVoices(), `${label} teardown`);
    abi.bind(0);
    abi.dispose(h);
  };

  // Every box rolls a rocket: jets, booms and the spins they cause. Then every
  // box rolls a monster truck, which is the one command that carries a TIMBRE.
  race('rockets', 'rocket', 1800);
  race('monsters', 'monster', 1800);

  // A race that decided nothing would pass every assertion above.
  assert.ok(seen.beat >= 8, `the countdown was heard, twice (${seen.beat} beats)`);
  assert.ok(seen.voice > 1500, `the state voices ran (${seen.voice} level commands)`);
  assert.ok(seen.stop > 0, `voices died on their falling edge (${seen.stop})`);
  assert.ok(seen.cue > 0, `one-shot cues fired (${seen.cue})`);
  assert.ok(seen.jet > 0, `rockets were voiced in flight (${seen.jet})`);
  assert.ok(seen.boom > 0, `and landed (${seen.boom} impacts)`);
  assert.ok(seen.mod > 0, `the monster-truck timbre crossed (${seen.mod} modified voices)`);

  M._free(vecPtr);
});
