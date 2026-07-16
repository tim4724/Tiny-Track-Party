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

// Background music, keyed by BIOME name (shared/themes.js biomeNameForCup —
// the Backyard cup resolves to 'grass'). Each biome holds a POOL of songs that
// share its mood; startMusic picks one at random per race, never repeating the
// song that just played when the pool allows. Descriptors carry the credit-chip
// fields (title + artist, linking to `source`) — which is also how we satisfy
// the CC-BY attribution for Kevin MacLeod's tracks (see music/CREDITS.txt).
// duration = whole seconds, baked so galleries can show a song's length
// without loading its metadata (the race itself never reads it).
const song = (file, title, duration) => ({
  file: `/assets/audio/music/${file}`,
  title,
  duration,
  artist: 'Kevin MacLeod',
  license: 'CC-BY 4.0',
  source: 'https://incompetech.com/music/royalty-free/music.html',
});
export const RACE_MUSIC = {
  beach: [
    song('beachfront_celebration.mp3', 'Beachfront Celebration', 187),
    song('island_meet_and_greet.mp3', 'Island Meet and Greet', 217),
    song('paradise_found.mp3', 'Paradise Found', 187),
  ],
  playroom: [
    song('itty_bitty_8_bit.mp3', 'Itty Bitty 8 Bit', 194),
    song('bit_shift.mp3', 'Bit Shift', 192),
  ],
  snow: [
    song('wallpaper.mp3', 'Wallpaper', 220),
    song('new_friendly.mp3', 'New Friendly', 169),
    song('glitter_blast.mp3', 'Glitter Blast', 178),
  ],
  grass: [
    song('happy_bee.mp3', 'Happy Bee', 302),
    song('hyperfun.mp3', 'Hyperfun', 233),
  ],
  canyon: [
    song('still_pickin.mp3', 'Still Pickin', 298),
    song('desert_of_lost_souls.mp3', 'Desert of Lost Souls', 181),
    song('surf_shimmy.mp3', 'Surf Shimmy', 123),
  ],
  // Unlisted/empty biomes (currently just the cupless 'sunset') fall back to
  // the neutral ex-global track rather than silence. Exported for the music
  // gallery, which shows the fallback on pickless cups.
};
export const MUSIC_FALLBACK = RACE_MUSIC.snow;
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
    this.nowPlaying = null;   // the picked song descriptor — read by the credit chip
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

  // Just the world pop — no roulette/ready chain. For any non-player grab (a CPU,
  // or a finished human's victory lap): the box bounce is a world event, so it's
  // scaled by `vol` (distance to the nearest human — see main.js audibility()).
  pickupPop(vol = 1) { this._play('pickup', vol); }

  // STATE-DRIVEN voices: a continuous sound per (cue, car) whose level follows
  // live physics every frame (boost wind, cornering squeal, brake skid). A
  // voice starts when its level rises above the floor and dies when it falls
  // back — call these from the render loop with the snapshot values.
  _stateVoice(cueId, id, level, mod) {
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
    voice.set(level, mod); // mod (optional) deepens the engine voice into a monster-truck growl
  }
  // boostMul 1.0 → silent; the pad/item peak (~1.6) → full level.
  boostWind(id, boostMul) { this._stateVoice('boost', id, Math.max(0, Math.min(1, (boostMul - 1) / 0.6))); }
  cornerSqueal(id, level) { this._stateVoice('corner', id, level); }
  brakeSkid(id, level) { this._stateVoice('brake', id, level); }
  // Driving sound — a STATE-DRIVEN voice like the others: the recorded engine
  // loop, pitch + level following the car's speed every frame (silent at rest).
  // Called per HUMAN car from the render loop; CPU cars stay silent (an 8-car
  // engine chorus would be mud, same reasoning as corner/brake).
  // monster=true DEEPENS the engine into a heavy big-truck growl for the duration of a
  // monster-truck transform: pitch down, a touch louder, top end muffled. Starting values.
  engineDrive(id, level, monster = false) {
    this._stateVoice('engine_putt', id, Math.max(0, Math.min(1, level)),
      monster ? { rateMul: 0.6, gainMul: 1.45, lpMul: 0.82 } : null);
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
  // World cues, scaled by `vol` (distance to the nearest human — see main.js
  // audibility()): full for the player's own car, quieter for a distant CPU.
  bananaDrop(vol = 1) { this._play('banana_drop', vol); }
  spin(vol = 1) { this._play('banana_slip', vol); } // oil shares the comedy cue
  // Monster-truck transform: inflate (pump up) on use, deflate (sputter down) on lapse.
  // World cues — scaled by distance to the nearest human, like the other one-shots.
  monsterInflate(vol = 1) { this._play('monster_inflate', vol); }
  monsterDeflate(vol = 1) { this._play('monster_deflate', vol); }
  // Rocket FLIGHT — a sustained voice (like boost wind / engine), one per in-flight rocket id,
  // held from launch to impact. level 0 stops + frees it. The host drives level by the rocket's
  // distance to the nearest player (see main.js driveRocketAudio). NOT a one-shot.
  rocketFlight(id, level) { this._stateVoice('rocket_fire', id, Math.max(0, Math.min(1, level))); }
  rocketHit(level = 1) { this._play('rocket_hit', Math.max(0, Math.min(1, level))); } // detonation thump; level scaled by distance to a player (main.js), default full (gallery)
  lap() {
    const now = performance.now();
    if (now - this._lastLap < LAP_GAP_MS) return;
    this._lastLap = now;
    this._play('lap');
  }
  // intensity = how hard the scrub (from speed); dist = spatial attenuation in
  // [0,1] (1 for the player's own car, lower for a distant CPU's curb contact on
  // a human's screen — see main.js audibility()).
  screech(intensity = 1, dist = 1) {
    const now = performance.now();
    if (now - this._lastScreech < SCREECH_GAP_MS) return;
    this._lastScreech = now;
    this._play('screech', Math.max(0.3, Math.min(1, intensity)) * dist);
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
  //
  // Takes the race's BIOME name and picks from that biome's pool — random, but
  // never the song that just played (across races AND biomes) when there's an
  // alternative, so a 4-race GP through one biome rotates its pool.
  startMusic(biome) {
    if (!this.ready) return;
    const pool = (RACE_MUSIC[biome] && RACE_MUSIC[biome].length) ? RACE_MUSIC[biome] : MUSIC_FALLBACK;
    const fresh = pool.length > 1 ? pool.filter((s) => s.file !== this._musicUrl) : pool;
    const pick = fresh[(Math.random() * fresh.length) | 0];
    this.nowPlaying = pick;
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
    // Swap src only on a real song change; re-racing the same song keeps it
    // buffered. createMediaElementSource follows the element, so the routing
    // survives a src change.
    if (this._musicUrl !== pick.file) { this._music.src = pick.file; this._musicUrl = pick.file; }
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
