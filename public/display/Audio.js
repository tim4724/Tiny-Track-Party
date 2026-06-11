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
import { resolveVariant } from './audio/cues.js';

const PICKS_KEY = 'tinytrack_sound_picks_v1';
const VOLUME_KEY = 'tinytrack_sound_volume_v1';
const SCREECH_GAP_MS = 140; // min spacing so curb contact can't machine-gun
const LAP_GAP_MS = 350;     // min spacing between lap chimes (8 cars can bunch)

export class RaceAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._picks = null;
    this._lastScreech = -Infinity;
    this._lastLap = -Infinity;
    this._voices = new Map(); // 'cueId:carId' -> live state voice {set, stop}
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
  _variant(cueId) {
    if (!this._picks) {
      try { this._picks = JSON.parse(localStorage.getItem(PICKS_KEY)) || {}; }
      catch (_) { this._picks = {}; }
    }
    return resolveVariant(cueId, this._picks);
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
}
