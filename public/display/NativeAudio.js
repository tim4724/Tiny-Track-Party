// NativeAudio — the display's edge of the audio DECISIONS, which are C++.
//
// AudioDecider's surface (audio/decide.js), backed by the native decision layer
// in the wasm (native/runtime/ttp_audio.h over libttp-runtime/ttp/audio.cc).
// Every method returns the same COMMAND stream Audio.js has performed since P5,
// so the device half never learned that the rules moved: main.js still writes
// `sfx(audioDecide.…)` and Audio.js still reads `{cue, gain}` / `{voice, id,
// level}` / `{music:'start', song, level}`.
//
// WHAT IS NOT HERE, AND THAT IS THE POINT. There is no `event()` and no
// `countdown()`. A race event and a countdown beat are decided into sound
// INSIDE the wasm as the sim fires them (ttp_audio_bind names the session the
// room can hear), so the shell no longer reads a car's world point, gathers the
// listeners or hands any of it back over the boundary. Whatever those beats
// decided is waiting in the queue and comes out of the next drain, in fire
// order, ahead of that frame's own commands.
//
// Nothing crosses as text on the frame path either: a cue is a CODE, the cue
// TABLE is read out of the wasm at init (so there is no mirror in this file to
// drift from the C++ one), a voice's subject is an opaque token, and a picked
// song is an INDEX resolved once per race through ttp_audio_song_json.
//
// public/display/audio/decide.js is GONE — it was the ORACLE, now retired:
// tests/fixtures/audio-corpus.jsonl was recorded off it, and
// native/runtimetest/audio_check.cc replays all 6397 cases of it through the
// C++ on every leg. A disagreement between the two is a bug in the port, never
// in the corpus.

import { loadNativeRuntime } from './nativeRuntime.js';

let M = null;   // the instantiated emscripten module (shared)
let fn = null;  // cwrap'd ABI
let CUES = [];  // TTP_CUE_* code -> cue id, read out of the wasm at init

// The packed command block (native/runtime/ttp_audio.h), as this reader needs
// it. Only the HEADER's size is written down; a command's comes out of the
// block itself (`stride`), for ttp_hud.h's reason — a decoder that baked in a
// sizeof would silently misread every record after a field was added.
const BLOCK_VERSION = 1;   // TTP_AUDIO_BLOCK_VERSION
const HEADER_BYTES = 16;   // version, count, stride, flags
// Byte offsets INSIDE a command. Hardcoded where the record's size is not, and
// the asymmetry is deliberate: `stride` absorbs a record growing at the END,
// which is the change a block can take; anything moving a field this reader
// already knows bumps TTP_AUDIO_BLOCK_VERSION, which the guard below sees.
const OFF_LEVEL = 16;
const OFF_RATE = 24;
const OFF_GAIN = 32;
const OFF_LP = 40;

// TtpAudioCmd.kind
const CMD_CUE = 1;
const CMD_COUNTDOWN = 2;
const CMD_VOICE = 3;
const CMD_VOICE_STOP = 4;
const CMD_STOP_ALL = 5;
const CMD_STOP_CAR = 6;
const CMD_MUSIC = 7;
// TtpAudioCmd.code, for CMD_MUSIC
const MUSIC_OPS = { 1: 'start', 2: 'stop', 3: 'pause', 4: 'resume' };
// TtpAudioCmd.flags
const F_GO = 1;
const F_MOD = 2;

const EMPTY = [];

export async function init() {
  if (M) return;
  M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    bind: c('ttp_audio_bind', null, ['number']),
    frame: c('ttp_audio_frame', null, ['number']),
    roster: c('ttp_audio_roster', null, ['number', 'number']),
    stopVoices: c('ttp_audio_stop_voices', null, []),
    stopCar: c('ttp_audio_stop_car', null, ['string']),
    music: c('ttp_audio_music', null, ['number', 'string']),
    drain: M._ttp_audio_drain,
    cueId: c('ttp_audio_cue_id', 'string', ['number']),
    songJson: c('ttp_audio_song_json', 'string', ['number'])
  };
  // The cue vocabulary, derived rather than mirrored: walk the codes until the
  // wasm runs out of names. CUES[code] is the id the device's palette
  // (audio/cues.js) knows the sound by.
  CUES = [null];
  for (let code = 1; ; code++) {
    const id = fn.cueId(code);
    if (!id) break;
    CUES.push(id);
  }
}

export class NativeAudioDecider {
  constructor() {
    if (!M) throw new Error('NativeAudioDecider used before init() resolved');
    this._songs = new Map(); // catalogue index -> song descriptor (once per song)
  }

  // The session whose race events make a sound. The lobby's attract demo races
  // a full field behind the menu and is never bound, which is what keeps it
  // silent without a mute flag on this side. 0 between races.
  bind(sessionHandle) {
    fn.bind(sessionHandle | 0);
    return EMPTY;
  }

  // One frame of the continuous mix, decided off the bound session's live cars
  // and rockets in C++. Also the flush point for any race event or countdown
  // beat that fired inside the last update — hence the clock, which is the only
  // thing this layer is told about time.
  frame(nowMs) {
    fn.frame(nowMs);
    return this._drain();
  }

  roster(count, inLobby) {
    fn.roster(count | 0, inLobby ? 1 : 0);
    return this._drain();
  }

  stopVoices() {
    fn.stopVoices();
    return this._drain();
  }

  stopCar(id) {
    fn.stopCar(JSON.stringify(id));
    return this._drain();
  }

  startMusic(biome) {
    fn.music(1, biome || '');
    return this._drain();
  }
  stopMusic() { fn.music(2, null); return this._drain(); }
  pauseMusic() { fn.music(3, null); return this._drain(); }
  resumeMusic() { fn.music(4, null); return this._drain(); }

  // A song descriptor by catalogue index — the file to stream plus the
  // attribution fields. Off the frame path (one pick per race) and memoized, so
  // the one string in the whole audio path is read at most once per song.
  _song(index) {
    let s = this._songs.get(index);
    if (!s) {
      s = JSON.parse(fn.songJson(index));
      if (s) this._songs.set(index, s);
    }
    return s;
  }

  // The packed block -> the plain command objects Audio.js performs.
  //
  // THE DECODE LOOP CALLS NO WASM. That is a property worth stating, because the
  // three heap views below are captured ONCE and ALLOW_MEMORY_GROWTH detaches
  // any typed array held across an allocation — so a nested call that allocated
  // would leave every later record in this batch decoding from a detached
  // buffer, and a detached read returns `undefined` rather than throwing. The
  // one call that could do it is the song lookup (ttp_audio_song_json builds a
  // Value tree and canonical_stringify reserves 4 KB), so music indices are
  // COLLECTED here and resolved after the loop, once the views are done with.
  //
  // It was previously resolved inline and was safe only by accident: C++ flushes
  // queued race events AHEAD of a music command, so a MUSIC record happened to be
  // last in its own batch. Nothing stated or enforced that, at either end.
  _drain() {
    const ptr = fn.drain();
    if (!ptr) return EMPTY;
    const u32 = M.HEAPU32;
    const i32 = M.HEAP32;
    const f64 = M.HEAPF64;
    const head = ptr >> 2;
    if (u32[head] !== BLOCK_VERSION) {
      // Unreachable while the wasm and this file ship in one repo, so it is a
      // one-shot log rather than a throw on a per-frame path: a stale
      // checked-in artifact should go quiet, not spew stack traces at 60 Hz.
      if (!this._versionLogged) {
        this._versionLogged = true;
        console.error(`[audio] command block v${u32[head]}, expected v${BLOCK_VERSION} —`
            + ' rebuild with native/scripts/build-runtime-web.sh');
      }
      return EMPTY;
    }
    const count = u32[head + 1];
    if (!count) return EMPTY;
    const stride = u32[head + 2];
    const out = [];
    // Music 'start' records, as [position in `out`, catalogue index]. Resolved
    // below, after the heap views are out of scope — see the note above.
    let pendingSongs = null;
    for (let i = 0; i < count; i++) {
      const off = ptr + HEADER_BYTES + i * stride;
      const at = off >> 2;
      const kind = i32[at];
      const code = i32[at + 1];
      const subject = i32[at + 2];
      const flags = u32[at + 3];
      const level = f64[(off + OFF_LEVEL) >> 3];
      switch (kind) {
        case CMD_CUE:
          if (CUES[code]) out.push({ cue: CUES[code], gain: level });
          break;
        case CMD_COUNTDOWN:
          out.push({ cue: 'countdown', part: (flags & F_GO) ? 'go' : 'tick' });
          break;
        case CMD_VOICE: {
          const cmd = { voice: CUES[code], id: subject, level };
          // The timbre rides the command as numbers, so the monster truck's
          // pitch-down is written down once — in the layer that authored it.
          if (flags & F_MOD) {
            cmd.mod = {
              rateMul: f64[(off + OFF_RATE) >> 3],
              gainMul: f64[(off + OFF_GAIN) >> 3],
              lpMul: f64[(off + OFF_LP) >> 3]
            };
          }
          if (cmd.voice) out.push(cmd);
          break;
        }
        case CMD_VOICE_STOP:
          if (CUES[code]) out.push({ voice: CUES[code], id: subject, stop: true });
          break;
        case CMD_STOP_ALL:
          out.push({ voices: 'stop-all' });
          break;
        case CMD_STOP_CAR:
          out.push({ voices: 'stop-car', id: subject });
          break;
        case CMD_MUSIC: {
          const op = MUSIC_OPS[code];
          if (!op) break;
          if (op !== 'start') { out.push({ music: op }); break; }
          // A placeholder, patched below. `song` stays null if the index does
          // not resolve, and the entry is dropped — the same answer the inline
          // lookup gave by simply not pushing.
          (pendingSongs || (pendingSongs = [])).push([out.length, subject]);
          out.push({ music: 'start', song: null, level });
          break;
        }
        default: break;
      }
    }
    // THE GUARD that keeps the rule above from being a comment. If a future edit
    // puts an allocating wasm call back inside the loop, these three views are
    // swapped out from under it and every record decoded afterwards is garbage —
    // silently, because a detached read yields `undefined` rather than throwing.
    // An identity check costs one comparison per drain and turns that into a
    // stated cause. One-shot, and not a throw, for the version guard's reason:
    // this is a per-frame path and a stale build should be legible, not a stack
    // trace at 60 Hz.
    if (M.HEAPU32 !== u32 && !this._detachLogged) {
      this._detachLogged = true;
      console.error('[audio] the wasm heap grew while the command block was being decoded —'
          + ' the views this drain read are stale, so some commands were lost.'
          + ' Nothing in the decode loop may call into wasm; resolve after it (see _drain).');
    }
    // Past here the heap views are no longer read, so a lookup that grows the
    // wasm heap can detach nothing.
    if (!pendingSongs) return out;
    for (const [at, index] of pendingSongs) out[at].song = this._song(index);
    return out.filter((c) => c.music !== 'start' || c.song);
  }
}
