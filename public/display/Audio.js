// RaceAudio — the DEVICE half of the big screen's sound, built on the "toy foley"
// cue palette in audio/cues.js (Web Audio synthesis, no asset files, no engine
// drone — see the rejected v1 for why).
//
// It decides nothing, and the decisions are no longer even in this language:
// every "should a sound happen, which one, how loud" rule is C++
// (native/libttp-runtime/ttp/audio.cc, behind the ttp_audio.h ABI), and arrives
// here as a stream of COMMANDS that apply() performs. NativeAudio.js decodes the
// packed block into the plain objects below; the vocabulary is unchanged from
// when the rules were JS, which is why nothing in this file moved when they
// went. The JS twin (audio/decide.js) is GONE — it was the oracle
// tests/fixtures/audio-corpus.jsonl was recorded from, and it went once the port
// was conformance-proven; the music catalogue it also held is now the pure-data
// audio/musicCatalogue.js, which this file does not read either (see below).
//
// What is left here is exactly what names a platform API: the AudioContext, the
// master bus + limiter, the variant picks, the <audio> element streaming the
// song. That split is what let the rules move at all
// (docs/native-port/shared-cpp-plan.md P7, which keeps the DSP baked and the
// device per-platform).
//
// Which variant plays per cue: the sound gallery's starred picks (localStorage,
// same browser + origin as /gallery-sounds.html) override the committed
// DEFAULT_PICKS — so an audition round applies to local races immediately, and
// every other machine (the TV, preview deploys) gets the defaults. The gallery
// volume slider shares the same key and acts as the race's master volume.
//
// Browsers require a user gesture before audio runs; call resume() from
// pointerdown/keydown. Every play method no-ops safely while locked.
import { resolveVariant, loadSampleBuffers } from './audio/cues.js';
import { assetUrl } from '../shared/assetUrl.js';
import { createMasterBus, storedVolume } from './audio/bus.js';
import { storedPicks } from './audio/picks.js';

// THIS FILE IMPORTS NO TABLE, and that is the whole of the device half's job
// description: it performs commands and decides nothing. The music catalogue —
// the pool per biome, the per-song LUFS trim, the no-repeat shuffle — belongs to
// the decision layer, which is C++ (libttp-runtime/ttp/audio.cc); a picked song
// reaches this file as a descriptor on a `{music:'start', song, level}` command,
// resolved once per race through ttp_audio_song_json.
//
// It used to re-export four constants from audio/decide.js so the music gallery
// and the credits test had an address for them. That pulled the whole 495-line
// ORACLE onto the shipped display page's import graph for tables nothing on the
// race path reads. Those surfaces import audio/musicCatalogue.js directly now —
// the catalogue outlived the oracle it was carved out of, as data.

export class RaceAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._picks = null;
    this._voices = new Map(); // 'cueId:carId' -> live state voice {set, stop}
    this._music = null;       // streamed background track (HTMLAudioElement)
    this._musicUrl = null;    // its current src, so we only reload on a track change
    this.nowPlaying = null;   // the picked song descriptor — read by the credit chip
    this._muted = false;      // the display's mute switch — per-session, never stored (see bus.js)
  }

  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    // Master gain + soft limiter, from audio/bus.js — the SAME bus the audition
    // galleries build, which is what makes their A/B a comparison of cues rather
    // than of mixes.
    this.master = createMasterBus(this.ctx);
    if (this._muted) this.master.gain.value = 0;
    // Decode the one recorded cue (the engine loop) up front, on the same
    // user-gesture that creates the context — so the buffer is ready by the
    // time the first race frame asks for an engine. Fire-and-forget: the voice
    // stays silent until it resolves and never throws if the fetch fails.
    loadSampleBuffers(this.ctx);
  }

  resume() {
    this._ensure();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  // The display's mute switch. Two silencers on purpose: the master gain covers
  // every bus-routed source, and the element's own `muted` covers the music's
  // no-MediaElementSource fallback (where level lands on el.volume instead).
  get muted() { return this._muted; }
  setMuted(on) {
    this._muted = !!on;
    if (this.master) this.master.gain.value = this._muted ? 0 : storedVolume();
    if (this._music) this._music.muted = this._muted;
  }

  // Music is an <audio> element routed straight to the device rather than through
  // the bus, so it has to scale itself by the same preference the bus was built
  // with. See the _music branch below.
  _volume() { return storedVolume(); }

  // Gallery picks, read once per session (re-read after resume() if you ever
  // need live re-picking; a race doesn't).
  _loadPicks() {
    if (!this._picks) this._picks = storedPicks();
    return this._picks;
  }
  _variant(cueId) {
    return resolveVariant(cueId, this._loadPicks());
  }

  // Play a cue, optionally attenuated (vol < 1 routes through a trim gain so
  // cue code stays volume-agnostic). Returns silently while audio is locked.
  _play(cueId, vol = 1) {
    if (!this.ready) return;
    const v = this._variant(cueId);
    if (!v) return;
    let dest = this.master;
    if (vol < 1) {
      dest = this.ctx.createGain();
      dest.gain.value = vol;
      dest.connect(this.master);
    }
    v.play(this.ctx, dest);
  }

  // ---- the command bus ----
  // Perform a decision stream, in order. This is the ONLY path the race drives
  // (NativeAudio.js hands it the wasm's answers); the named methods below exist
  // for the gallery harness, which has no decision layer behind it.
  apply(cmds) {
    for (const c of cmds) {
      if (c.cue !== undefined) {
        if (c.cue === 'countdown') this._countdownBeat(c.part);
        else this._play(c.cue, c.gain);
      } else if (c.voice !== undefined) {
        if (c.stop) this._stopVoice(c.voice, c.id);
        else this._stateVoice(c.voice, c.id, c.level, c.mod);
      } else if (c.voices === 'stop-all') {
        this.stopVoices();
      } else if (c.voices === 'stop-car') {
        this.stopCarVoices(c.id);
      } else if (c.music === 'start') {
        this._startMusic(c.song, c.level);
      } else if (c.music === 'stop') {
        this.stopMusic();
      } else if (c.music === 'pause') {
        this.pauseMusic();
      } else if (c.music === 'resume') {
        this.resumeMusic();
      }
    }
  }

  // ---- race moments ----

  // One beat of the 3-2-1-GO countdown: the cue exposes tick()/go() so the race
  // can play a beat at a time as RaceSession's 1 Hz timer fires.
  _countdownBeat(part) {
    if (!this.ready) return;
    const v = this._variant('countdown');
    if (!v) return;
    if (part === 'go') v.go(this.ctx, this.master);
    else v.tick(this.ctx, this.master);
  }

  // STATE-DRIVEN voices: a continuous sound per (cue, car) whose level follows
  // live physics every frame (boost wind, cornering squeal, brake skid, the
  // engine loop, a rocket's jet). The decision layer owns when one starts and
  // stops; this just holds the live nodes.
  _stateVoice(cueId, id, level, mod) {
    if (!this.ready) return;
    const key = cueId + ':' + id;
    let voice = this._voices.get(key);
    if (level <= 0.02) { this._stopVoice(cueId, id); return; }
    if (!voice) {
      const v = this._variant(cueId);
      if (!v || !v.start) return;
      voice = v.start(this.ctx, this.master);
      this._voices.set(key, voice);
    }
    voice.set(level, mod); // mod (optional) deepens the engine voice into a monster-truck growl
  }
  _stopVoice(cueId, id) {
    const key = cueId + ':' + id;
    const voice = this._voices.get(key);
    if (voice) { voice.stop(); this._voices.delete(key); }
  }
  // Kill all live voices — pause, race end, return to lobby. Without this a
  // frozen frame would hold its sounds forever (the loop stops updating levels).
  stopVoices() {
    for (const voice of this._voices.values()) voice.stop();
    this._voices.clear();
  }
  // One car left the race (forfeit) or changed id (cross-device rejoin) — the
  // render loop will never feed that id a zero level, so kill its voices here.
  stopCarVoices(id) {
    for (const [key, voice] of this._voices) {
      if (key.endsWith(':' + id)) { voice.stop(); this._voices.delete(key); }
    }
  }

  // ---- gallery surface ----
  // /gallery.html's scenarios (display/TestHarness.js) fire cues directly: they
  // run a preview world with no players, so there is no distance model and no
  // decision stream behind them. Full level, no gating.
  spin(vol = 1) { this._play('banana_slip', vol); } // oil shares the comedy cue
  monsterInflate(vol = 1) { this._play('monster_inflate', vol); }
  monsterDeflate(vol = 1) { this._play('monster_deflate', vol); }
  rocketFlight(id, level) { this._stateVoice('rocket_fire', id, Math.max(0, Math.min(1, level))); }
  rocketHit(level = 1) { this._play('rocket_hit', Math.max(0, Math.min(1, level))); }
  // `mod` DEEPENS the engine into a heavy big-truck growl (pitch down, a touch
  // louder, top end muffled) — {rateMul, gainMul, lpMul}, or null for the stock
  // voice. The CALLER supplies it rather than this file keeping a monster flag
  // and a table to resolve it: on the race path that timbre already arrives as
  // numbers on the voice command (NativeAudio's cmd.mod, authored in the C++
  // decision layer), so a second copy here would be the one place the growl was
  // written down twice. The gallery hands in MONSTER_ENGINE_MOD from the oracle.
  engineDrive(id, level, mod = null) {
    this._stateVoice('engine_putt', id, Math.max(0, Math.min(1, level)), mod);
  }

  // ---- background music ----
  // Ambient, not a cue: the race song plays globally for the whole race. Unlike
  // the synth cues and the tiny engine loop (Web Audio buffers), the song is a
  // multi-MB full track, so it STREAMS through an <audio> element rather than
  // decoding ~40 MB of PCM into memory. It's routed into the master gain so the
  // limiter and volume slider apply; if MediaElementSource isn't available it
  // falls back to the element's own volume scaled by the master level.
  //
  // WHICH song and at WHAT level is decided in native/libttp-runtime/ttp/audio.cc
  // (pool by biome, no-repeat shuffle, per-song LUFS trim) and arrives as a
  // 'start' command.
  _startMusic(song, level) {
    if (!this.ready) return;
    this.nowPlaying = song;
    if (!this._music) {
      const el = new Audio();
      el.loop = true;
      el.preload = 'auto';
      el.muted = this._muted;
      this._music = el;
      try {
        const node = this.ctx.createMediaElementSource(el);
        const g = this.ctx.createGain();
        node.connect(g);
        g.connect(this.master);
        this._musicGain = g; // kept for inspection / live level tuning
      } catch (_) { /* no MediaElementSource — level lands on el.volume below */ }
    }
    if (this._musicGain) this._musicGain.gain.value = level;
    else this._music.volume = level * this._volume(); // routed straight to the device
    // Swap src only on a real song change; re-racing the same song keeps it
    // buffered. createMediaElementSource follows the element, so the routing
    // survives a src change.
    // song.file is the wasm's canonical site path; resolve it here at the
    // device edge (see shared/assetUrl.js — the AC zip serves from a subpath).
    if (this._musicUrl !== song.file) { this._music.src = assetUrl(song.file); this._musicUrl = song.file; }
    try { this._music.currentTime = 0; } catch (_) { /* not seekable yet */ }
    this._music.play().catch(() => { /* gesture/decoding race — stays silent */ });
  }
  pauseMusic() { if (this._music) this._music.pause(); }
  resumeMusic() { if (this._music && this.ready) this._music.play().catch(() => {}); }
  stopMusic() {
    if (!this._music) return;
    this._music.pause();
    try { this._music.currentTime = 0; } catch (_) { /* ignore */ }
  }
}
