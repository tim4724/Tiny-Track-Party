// RaceAudio — all sound for the big screen, built on the "toy foley" cue
// palette in audio/cues.js (Web Audio synthesis, no asset files, no engine
// drone — see the rejected v1 for why).
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

const PICKS_KEY = 'tinytrack_sound_picks_v1';
const VOLUME_KEY = 'tinytrack_sound_volume_v1';
const SCREECH_GAP_MS = 140; // min spacing so curb contact can't machine-gun
const LAP_GAP_MS = 350;     // min spacing between lap chimes (8 cars can bunch)

// Background music: one shipped track for now (track-specific songs come later —
// this will grow into a per-track map). Exported so the display can show an
// on-screen credit chip (title + artist, linking to `source`) — which is also
// how we satisfy the CC-BY attribution for Kevin MacLeod's "Wallpaper" (see
// music/wallpaper.LICENSE.txt).
export const RACE_MUSIC = {
  file: '/assets/audio/music/wallpaper.mp3',
  title: 'Wallpaper',
  artist: 'Kevin MacLeod',
  license: 'CC-BY 4.0',
  source: 'https://incompetech.com/music/royalty-free/music.html',
};
// MUSIC_LEVEL is a STARTING VALUE — a bed under the SFX, not a wall of sound.
// Tune by ear in ?solo=1: if it buries the cues, drop by 0.05; if it vanishes,
// raise it. It rides the master gain, so the volume slider scales it too.
// Settled at 0.28 by ear — a touch forward of the SFX bed (Tim, 2026-06-14).
const MUSIC_LEVEL = 0.28;

export class RaceAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._picks = null;
    this._lastScreech = -Infinity;
    this._lastLap = -Infinity;
    this._voices = new Map(); // 'cueId:carId' -> live state voice {set, stop}
    this._music = null;       // streamed background track (HTMLAudioElement)
    this._musicUrl = null;    // its current src, so we only reload on a track change
  }

  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this._volume();
    // Soft limiter: overlapping cues (8 cars' worth) must not clip TV speakers.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 24;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
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

  _volume() {
    try {
      const raw = parseInt(localStorage.getItem(VOLUME_KEY), 10);
      return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) / 100 : 0.6;
    } catch (_) { return 0.6; }
  }

  // Gallery picks, read once per session (re-read after resume() if you ever
  // need live re-picking; a race doesn't).
  _loadPicks() {
    if (!this._picks) {
      try { this._picks = JSON.parse(localStorage.getItem(PICKS_KEY)) || {}; }
      catch (_) { this._picks = {}; }
    }
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

  // ---- race moments ----

  // RaceSession's 1 Hz countdown: n > 0 ticks, n === 0 is the GO beat.
  countdown(n) {
    if (!this.ready || n < 0) return;
    const v = this._variant('countdown');
    if (!v) return;
    if (n > 0) v.tick(this.ctx, this.master);
    else v.go(this.ctx, this.master);
  }

  // Box grab: pickup pop + the roulette tick-down (the renderer's chip spin is
  // ~0.86s). The roulette's reveal pop lands the "item ready" beat — a separate
  // ding was auditioned and cut as redundant.
  pickup() {
    this._play('pickup');
    this._play('roulette');
  }

  // Just the world pop — no roulette/ready chain. For CPU pickups that happen
  // on camera: the box bounce is visible but there's no HUD slot to narrate.
  pickupPop() { this._play('pickup'); }

  // STATE-DRIVEN voices: a continuous sound per (cue, car) whose level follows
  // live physics every frame (boost wind, cornering squeal, brake skid). A
  // voice starts when its level rises above the floor and dies when it falls
  // back — call these from the render loop with the snapshot values.
  _stateVoice(cueId, id, level) {
    if (!this.ready) return;
    const key = cueId + ':' + id;
    let voice = this._voices.get(key);
    if (level <= 0.02) {
      if (voice) { voice.stop(); this._voices.delete(key); }
      return;
    }
    if (!voice) {
      const v = this._variant(cueId);
      if (!v || !v.start) return;
      voice = v.start(this.ctx, this.master);
      this._voices.set(key, voice);
    }
    voice.set(level);
  }
  // boostMul 1.0 → silent; the pad/item peak (~1.6) → full level.
  boostWind(id, boostMul) { this._stateVoice('boost', id, Math.max(0, Math.min(1, (boostMul - 1) / 0.6))); }
  cornerSqueal(id, level) { this._stateVoice('corner', id, level); }
  brakeSkid(id, level) { this._stateVoice('brake', id, level); }
  // Driving sound — a STATE-DRIVEN voice like the others: the recorded engine
  // loop, pitch + level following the car's speed every frame (silent at rest).
  // Called per HUMAN car from the render loop; CPU cars stay silent (an 8-car
  // engine chorus would be mud, same reasoning as corner/brake).
  engineDrive(id, level) {
    this._stateVoice('engine_putt', id, Math.max(0, Math.min(1, level)));
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
  bananaDrop() { this._play('banana_drop'); }
  spin() { this._play('banana_slip'); } // oil shares the comedy cue
  lap() {
    const now = performance.now();
    if (now - this._lastLap < LAP_GAP_MS) return;
    this._lastLap = now;
    this._play('lap');
  }
  screech(intensity = 1) {
    const now = performance.now();
    if (now - this._lastScreech < SCREECH_GAP_MS) return;
    this._lastScreech = now;
    this._play('screech', Math.max(0.3, Math.min(1, intensity)));
  }
  join() { this._play('join'); }

  // ---- background music ----
  // Ambient, not a cue: the race song plays globally for the whole race (it does
  // NOT follow the visible-events rule the SFX do). Unlike the synth cues and the
  // tiny engine loop (Web Audio buffers), the song is a multi-MB full track, so
  // it STREAMS through an <audio> element rather than decoding ~40 MB of PCM into
  // memory. It's routed into the master gain so the limiter and volume slider
  // apply; if MediaElementSource isn't available it falls back to the element's
  // own volume scaled by the master level.
  startMusic(url = RACE_MUSIC.file) {
    if (!this.ready) return;
    if (!this._music) {
      const el = new Audio();
      el.loop = true;
      el.preload = 'auto';
      this._music = el;
      try {
        const node = this.ctx.createMediaElementSource(el);
        const g = this.ctx.createGain();
        g.gain.value = MUSIC_LEVEL;
        node.connect(g);
        g.connect(this.master);
        this._musicGain = g; // kept for inspection / live level tuning
      } catch (_) {
        el.volume = MUSIC_LEVEL * this._volume(); // routed straight to the device
      }
    }
    // Swap src only on a real track change (per-track songs later); re-racing the
    // same track keeps it buffered. createMediaElementSource follows the element,
    // so the routing survives a src change.
    if (this._musicUrl !== url) { this._music.src = url; this._musicUrl = url; }
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
