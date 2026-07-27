// decide.js — the audio DECISIONS, as a pure layer.
//
// WHAT THIS IS. Every "should a sound happen, which one, and how loud" rule the
// display owns, extracted out of main.js and Audio.js and expressed as a pure
// function of PLAIN DATA -> a stream of audio COMMANDS. It never touches an
// AudioContext, the DOM, localStorage, performance.now(), Math.random or any
// global: the clock and the RNG are injected, positions arrive as {x,y,z}
// literals, and the AI/human split arrives as a Set of car ids. That is what
// makes it loadable in Node (CLAUDE.md's dependency-free rule for modules the
// Node tests import directly) and recordable as an oracle.
//
// WHY IT IS SEPARATE. docs/native-port/shared-cpp-plan.md P7 moves exactly these
// rules into C++ (the DSP palette stays baked, the device stays per-platform).
// Once the JS is gone the oracle can never be recorded again — the one-way
// ratchet that already froze gen-roomflow-corpus.mjs and gen-grandprix-corpus.mjs
// — so scripts/gen-audio-corpus.mjs records the command stream NOW, while this
// layer still exists. Keep this file free of imports; the moment it grows one,
// the generator and the C++ port both inherit it.
//
// THE COMMAND VOCABULARY. Plain data, one object per command, emitted in the
// order the shell must perform them:
//
//   { cue, gain }             one-shot: play cue `cue` at linear gain `gain`
//   { cue: 'countdown',
//     part: 'tick'|'go' }     the countdown's two beats (one cue, two entries)
//   { voice, id, level }      sustained voice (cue `voice`, per car/rocket id):
//                             start it if it is not running, then set its level
//   { voice, id, level, mod } ... with a timbre modifier (the monster-truck engine)
//   { voice, id, stop: true } sustained voice: stop and free it
//   { voices: 'stop-all' }    kill every live voice (pause, race end, lobby)
//   { voices: 'stop-car', id} kill one car's voices (forfeit, cross-device rekey)
//   { music: 'start', song, level }   song descriptor + its trimmed bed level
//   { music: 'stop'|'pause'|'resume' }
//
// The DEVICE half (public/display/Audio.js) performs them and owns everything
// this file must not know: the AudioContext, the limiter, the gallery's variant
// picks, the <audio> element. It still exposes the named one-shots the gallery
// harness drives directly.

// ---- spatial audio: world-cue loudness by 3D distance to the nearest human ----
// The split-screen cells ARE the listeners: each shows one human car, so a world
// sound is loud when it happens next to a human and fades with straight-line WORLD
// distance to the nearest one — never gating hard to silence inside the scene, so
// distant action stays present, just quiet. This is the whole sound model: one
// curve, shared by every world cue (curb scrub, grabs, banana, spin, rocket). It
// replaces the old binary "is this CPU car on a human's camera?" visibility gate
// and generalises what used to be the rocket's private distance falloff.
//
// Distance is true 3D proximity (straight-line world distance): a car physically near a
// human is loud even when far apart in race position — an overpass, a crossing, a
// doubled-back straight — which reads on screen as "it's right there". Cheap: ≤4
// humans × a handful of sources per frame. Starting values — tune by ear in ?solo=1.
export const AUD_PEAK = 0.7;  // loudness at point-blank (≤ AUD_NEAR) — the ceiling for EVERY world cue, so even
                              //   your own car's events don't slam full master (HUD cues bypass this and stay full)
export const AUD_NEAR = 8;    // within this many world units of a human → AUD_PEAK (the pack around you)
export const AUD_FAR = 34;    // by here it has faded to the distance FLOOR (the far edge of the chase view)
export const AUD_FLOOR = 0.18; // quietest a still-in-scene source gets — distant but present, never silent here
export const AUD_CUT = 64;    // past here: out of the scene → silent (FLOOR tapers to 0 across [FAR, CUT], no click)

// A sustained voice below this level is not running at all: it starts when its
// level first rises above the floor and dies when it falls back.
export const VOICE_FLOOR = 0.02;
export const SCREECH_GAP_MS = 140; // min spacing so curb contact can't machine-gun
export const LAP_GAP_MS = 350;     // min spacing between lap chimes (8 cars can bunch)
// A wall-grind only counts as a scrub above this speed — below it the car is
// leaning on the barrier, not scraping along it.
export const SCRUB_SPD_MIN = 0.35;
// The monster-truck engine: the same recorded loop, pitch down, a touch louder,
// top end muffled. Starting values.
export const MONSTER_ENGINE_MOD = { rateMul: 0.6, gainMul: 1.45, lpMul: 0.82 };

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Min straight-line world distance from point `p` to any human car (Infinity with
// no humans / no live poses). Humans are the only listeners — CPU cars have no cell.
export function nearestHumanDist(p, humanPositions) {
  let best = Infinity;
  for (const hp of humanPositions) {
    if (!hp) continue;
    const d = Math.hypot(hp.x - p.x, hp.y - p.y, hp.z - p.z);
    if (d < best) best = d;
  }
  return best;
}

// Loudness in [0, AUD_PEAK] for a world cue at world position `p` (AUD_PEAK within
// AUD_NEAR of a human, FLOOR at AUD_FAR, 0 past AUD_CUT). A human's own car is at
// distance 0 → AUD_PEAK, so this needs no human/CPU branch: a player's own moments
// come out at the ceiling for free. A missing position (`!p`) plays at the ceiling
// rather than dropping the cue. (HUD cues — lap/roulette/countdown — never reach
// here; they bypass the distance model and play at full master.)
export function audibility(p, humanPositions) {
  if (!p) return AUD_PEAK;
  const d = nearestHumanDist(p, humanPositions);
  if (d <= AUD_NEAR) return AUD_PEAK;
  if (d >= AUD_CUT) return 0;
  if (d <= AUD_FAR) return AUD_PEAK - (AUD_PEAK - AUD_FLOOR) * (d - AUD_NEAR) / (AUD_FAR - AUD_NEAR);
  return AUD_FLOOR * (1 - (d - AUD_FAR) / (AUD_CUT - AUD_FAR));
}

// Loudness of a rocket IMPACT, kept CONSISTENT with the flight so you never get a
// jet that fades in with no boom: the detonation is at the target car, so reuse
// audibility on the target's world position (a human hit → always full), with a
// payoff floor so an audible jet always lands an audible boom. Returns 0 only when
// the impact is out of every human's earshot. `pos` null = the target is already
// gone (rare) — just play it.
export function rocketImpactLevel(pos, targetIsAi, humanPositions) {
  if (!pos) return 1;
  if (!targetIsAi) return 1; // a human got hit → full
  const a = audibility(pos, humanPositions);
  return a > 0 ? Math.max(0.45, a) : 0;
}

// ---- background music ----
// Keyed by BIOME name (shared/biomes.js forTrack, over the C++ palette tables —
// the Backyard cup resolves to 'grass'). Each biome holds a POOL of songs that
// share its mood; pickSong picks one at random per race, never repeating the song
// that just played when the pool allows. Descriptors carry the credit-chip fields
// (title + artist, linking to `source`) — which is also how we satisfy the CC-BY
// attribution for Kevin MacLeod's tracks (see music/CREDITS.txt). duration = whole
// seconds, baked so galleries can show a song's length without loading its
// metadata (the race itself never reads it).
//
// Re-exported by display/Audio.js, which is where the galleries and the credits
// test import it from.
const MACLEOD = {
  artist: 'Kevin MacLeod',
  license: 'CC-BY 4.0',
  source: 'https://incompetech.com/music/royalty-free/music.html',
};
// lufs = the file's integrated EBU R128 loudness, measured once at wiring time:
//   ffmpeg -i song.mp3 -map 0:a -filter ebur128=framelog=quiet -f null -
// (read the summary's "I:" line). The catalogue is mastered all over the place
// (-19.1 .. -8.7 LUFS as shipped — the hottest song lands >2x as loud as the
// quietest), so each song carries a gain trimming it to a common target and
// every pick sits at the same perceived level. The target sits just under the
// quietest pick so gains stay ≤ 1 (safe for plain el.volume routing); if a new
// pick measures quieter, lower the target and raise MUSIC_LEVEL by the same dB
// (the credits test pins gain ≤ 1 so a too-quiet pick fails loudly).
export const MUSIC_TARGET_LUFS = -19.2;
const song = (file, title, duration, lufs, credit = MACLEOD) => ({
  file: `/assets/audio/music/${file}`,
  title,
  duration,
  lufs,
  gain: 10 ** ((MUSIC_TARGET_LUFS - lufs) / 20),
  ...credit,
});
export const RACE_MUSIC = {
  beach: [
    song('beachfront_celebration.mp3', 'Beachfront Celebration', 187, -9.2),
    song('island_meet_and_greet.mp3', 'Island Meet and Greet', 217, -13.6),
    song('paradise_found.mp3', 'Paradise Found', 187, -11.5),
    song('tiki_bar_mixer.mp3', 'Tiki Bar Mixer', 212, -15.3),
    song('arroz_con_pollo.mp3', 'Arroz Con Pollo', 162, -13.2),
  ],
  playroom: [
    song('itty_bitty_8_bit.mp3', 'Itty Bitty 8 Bit', 194, -11.9),
    song('bit_shift.mp3', 'Bit Shift', 192, -13.3),
    song('chipper_doodle_v2.mp3', 'Chipper Doodle v2', 172, -12.2),
    song('voice_over_under.mp3', 'Voice Over Under', 197, -15.4),
    song('delightful_d.mp3', 'Delightful D', 184, -10.3),
  ],
  snow: [
    song('wallpaper.mp3', 'Wallpaper', 220, -11.2),
    song('new_friendly.mp3', 'New Friendly', 169, -15.7),
    song('glitter_blast.mp3', 'Glitter Blast', 178, -15.1),
    song('cloud_dancer.mp3', 'Cloud Dancer', 220, -13.6),
    song('digital_lemonade.mp3', 'Digital Lemonade', 180, -14.0),
  ],
  grass: [
    song('happy_bee.mp3', 'Happy Bee', 302, -9.1),
    song('hyperfun.mp3', 'Hyperfun', 233, -19.1),
    song('feelin_good.mp3', 'Feelin Good', 225, -18.0),
    song('vivacity.mp3', 'Vivacity', 232, -12.8),
    song('happy_happy_game_show.mp3', 'Happy Happy Game Show', 158, -9.7),
  ],
  canyon: [
    song('still_pickin.mp3', 'Still Pickin', 298, -13.9),
    song('desert_of_lost_souls.mp3', 'Desert of Lost Souls', 181, -16.7),
    song('surf_shimmy.mp3', 'Surf Shimmy', 123, -13.4),
    song('bama_country.mp3', 'Bama Country', 212, -18.2),
  ],
  // Unlisted/empty biomes (currently just the cupless 'sunset') fall back to
  // the neutral ex-global track rather than silence. Exported for the music
  // gallery, which shows the fallback on pickless cups.
};
export const MUSIC_FALLBACK = RACE_MUSIC.snow;
// MUSIC_LEVEL is a STARTING VALUE — a bed under the SFX, not a wall of sound.
// Tune by ear in ?solo=1: if it buries the cues, drop by 0.05; if it vanishes,
// raise it. It rides the master gain, so the volume slider scales it too.
// Settled at 0.28 by ear (Tim, 2026-06-14) when songs played raw; per-song
// gains now trim every pick to MUSIC_TARGET_LUFS (≈5 dB below the old average
// pick), so the level here is 0.28 × 10^(5.2/20) — same perceived bed height.
export const MUSIC_LEVEL = 0.51;

// ---- the decider ----
// Holds the small amount of state these rules need across calls: which sustained
// voices are live, the two one-shot spacing clocks, the last song (so the shuffle
// can avoid repeating it) and the last roster size. Everything else is derived
// from the arguments.
//
// opts.rng — the [0,1) source the music shuffle draws from. Defaults to
// Math.random, which is the shipped path; the corpus generator injects a seeded
// stream so the picks are recordable. Nothing else in here is random.
export class AudioDecider {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this._voices = new Set();   // 'cue:id' of every voice believed to be running
    this._rockets = new Set();  // rocket ids that had a jet voice last frame
    this._lastScreech = -Infinity;
    this._lastLap = -Infinity;
    this._musicFile = null;     // last picked song's file, for the no-repeat filter
    this._rosterCount = 0;
    this.nowPlaying = null;     // the picked song descriptor — read by the credit chip
  }

  // ---- sustained voices ----
  // A voice starts when its level rises above VOICE_FLOOR and dies when it falls
  // back. `stop` is emitted on the falling edge only: a level command implicitly
  // starts a voice that is not running, so a shell that dropped one (audio still
  // locked when it was first asked for) picks it back up on the next frame.
  _voice(out, cue, id, level, mod) {
    const key = cue + ':' + id;
    if (level <= VOICE_FLOOR) {
      if (this._voices.delete(key)) out.push({ voice: cue, id, stop: true });
      return;
    }
    this._voices.add(key);
    out.push(mod ? { voice: cue, id, level, mod } : { voice: cue, id, level });
  }

  // ---- per-frame drive ----
  // state:
  //   cars    the snapshot's cars (id, spd, steer, brake, boostMul, spin,
  //           monster, onWall, pose.pos) — iteration order is the emission order
  //   rockets in-flight rockets as [{ id, pos }] — pos is the rocket's WORLD
  //           point (the shell resolves it the same way the engine poses cars,
  //           so the jet and its boom are measured in one metric)
  //   aiIds   Set of car ids driven by the sim's own AI (they have no cell, so
  //           they are neither listeners nor voiced)
  //   nowMs   monotonic clock, for the one-shot spacing gates
  frame(state) {
    const out = [];
    const cars = state.cars || [];
    const aiIds = state.aiIds;
    // The listeners: every human car's world point, in car order.
    const humans = [];
    for (const c of cars) if (!aiIds.has(c.id)) humans.push(c.pose && c.pose.pos);

    // Curb scrub — loudness by distance to the nearest human (the player's own car
    // is at distance 0 → the ceiling). Unlike the one-shot cues this is a continuous
    // grind on a single shared throttle, so only in-scene scrubs (≥ the FLOOR)
    // compete and the loudest wins the window — a distant AI wall-grind can't claim it.
    let bestScrub = null;
    for (const c of cars) {
      if (c.onWall && c.spd > SCRUB_SPD_MIN) {
        const g = audibility(c.pose && c.pose.pos, humans);
        if (g >= AUD_FLOOR && (!bestScrub || g > bestScrub.g)) bestScrub = { spd: c.spd, g };
      }
      // State-driven voices per HUMAN car — each level follows the physics this
      // frame: boost wind from the boost multiplier, tire squeal from hard
      // steering at speed (squared so gentle corrections stay silent; a spinning
      // car's wheels aren't gripping, so no squeal), brake skid from brake
      // pressure while the car still moves. CPU cars stay silent here — they
      // corner and brake constantly, and a 7-car chorus would be noise.
      // Gate thresholds are starting values — tune by ear in ?solo=1.
      if (aiIds.has(c.id)) continue;
      // boostMul 1.0 → silent; the pad/item peak (~1.6) → full level.
      this._voice(out, 'boost', c.id, clamp01((c.boostMul - 1) / 0.6), null);
      const fastGate = clamp01((c.spd - 0.45) / 0.3);
      this._voice(out, 'corner', c.id, c.spin ? 0 : c.steer * c.steer * fastGate, null);
      this._voice(out, 'brake', c.id, c.brake * clamp01((c.spd - 0.2) / 0.4), null);
      // Engine voice — pitch + level rise with speed (recorded loop, RPM=rate).
      // Divisor maps normal top speed (~1.0) to near-full and lets boost (~1.6)
      // peg the top of the range; starting value, tune by ear in ?solo=1. While a
      // monster truck, the same loop deepens into a heavy big-truck growl.
      this._voice(out, 'engine_putt', c.id, clamp01(c.spd / 1.2),
                  c.monster ? MONSTER_ENGINE_MOD : null);
    }
    // the nearest scrub owns the shared throttle
    if (bestScrub) this._screech(out, bestScrub.spd, bestScrub.g, state.nowMs);

    // Rocket flight: a sustained jet per in-flight rocket, held the whole air time,
    // its level set by the SAME audibility curve as every other world cue (so the
    // jet and its boom always agree, and a rocket near a human is loud while a far
    // one is a quiet whoosh). Voices stop when a rocket leaves the snapshot
    // (hit/expired) or drifts out of every human's earshot.
    const seen = new Set();
    for (const r of (state.rockets || [])) {
      seen.add(r.id);
      this._voice(out, 'rocket_fire', r.id, clamp01(audibility(r.pos, humans)), null);
    }
    for (const id of this._rockets) if (!seen.has(id)) this._voice(out, 'rocket_fire', id, 0, null);
    this._rockets = seen;
    return out;
  }

  // intensity = how hard the scrub (from speed); dist = the shared throttle's
  // spatial attenuation in [0,1].
  _screech(out, intensity, dist, nowMs) {
    if (nowMs - this._lastScreech < SCREECH_GAP_MS) return;
    this._lastScreech = nowMs;
    out.push({ cue: 'screech', gain: Math.max(0.3, Math.min(1, intensity)) * dist });
  }
  _lap(out, nowMs) {
    if (nowMs - this._lastLap < LAP_GAP_MS) return;
    this._lastLap = nowMs;
    out.push({ cue: 'lap', gain: 1 });
  }

  // ---- race events ----
  // Map engine events onto cues. World moments (a car's grab, banana drop, spin,
  // curb scrub) are scaled by distance to the nearest human: close = loud, far =
  // quiet but present — so the player's own moments come out full (gap 0) and a
  // CPU's fade with distance instead of popping on/off as they enter or leave a
  // camera. HUD-narration cues stay human-only and full: the roulette describes
  // the player's item slot, and lap / finish narrate their cell's HUD.
  //
  // ctx:
  //   pos             the event's source world point, or null: the car's own
  //                   point for a car event (null = that car is already gone),
  //                   the rocket's track point for 'rocket_expire'
  //   humanPositions  every human car's world point (the listeners)
  //   aiIds           Set of AI car ids
  //   nowMs           monotonic clock, for the lap chime's spacing gate
  event(e, ctx) {
    const out = [];
    const pos = ctx.pos == null ? null : ctx.pos;
    const humans = ctx.humanPositions;
    const isAi = e.id != null && ctx.aiIds.has(e.id);
    const isHuman = !isAi;
    // 1 for the player's own car / idless cues, distance-scaled for CPUs.
    const g = e.id == null ? AUD_PEAK : audibility(pos, humans);
    switch (e.type) {
      case 'pickup':
        // A finished car has no HUD item slot to narrate, so its victory-lap grabs play
        // just the world pop (like a CPU grab) — never the player roulette chain.
        if (isHuman && !e.finished) {
          // pop + the roulette tick-down (the renderer's chip spin is ~0.86s).
          // The roulette's reveal pop lands the "item ready" beat — a separate
          // ding was auditioned and cut as redundant.
          out.push({ cue: 'pickup', gain: 1 });
          out.push({ cue: 'roulette', gain: 1 });
        } else if (g > 0) {
          out.push({ cue: 'pickup', gain: g }); // any other grab: world pop, by distance
        }
        break;
      // (boost item-use and pad crossings make no one-shot sound — the boost
      // WIND in frame() tracks the resulting speed state instead.)
      case 'item_use':
        if (g > 0 && e.item === 'banana') out.push({ cue: 'banana_drop', gain: g });
        else if (g > 0 && e.item === 'monster') out.push({ cue: 'monster_inflate', gain: g }); // pump-up as the car transforms
        // the rocket's launch+flight is a SUSTAINED voice driven per-frame in
        // frame(), not a one-shot here; boost item-use stays silent.
        break;
      // The monster transform lapsing back to a car: the deflate sputter (pairs with the
      // on-screen shrink). World cue, scaled by distance to the nearest human like the rest.
      case 'monster_end':
        if (g > 0) out.push({ cue: 'monster_deflate', gain: g });
        break;
      case 'spin': {
        // rocket → boom (its own distance metric, kept in step with the flight so the
        // jet and explosion are always heard together); oil/banana → comedy slip
        // (oil shares the comedy cue), scaled by distance to the nearest human
        // like every other world cue.
        if (e.cause === 'rocket') {
          const lvl = rocketImpactLevel(pos, isAi, humans);
          if (lvl > 0) out.push({ cue: 'rocket_hit', gain: clamp01(lvl) });
        } else if (g > 0) {
          out.push({ cue: 'banana_slip', gain: g });
        }
        break;
      }
      // The chequered-flag crossing chimes like any other lap (a 'finish' fanfare
      // was auditioned and cut) — the results overlay carries the celebration.
      case 'lap': case 'finish':
        if (isHuman) this._lap(out, ctx.nowMs);
        break;
      // A rocket self-destructing at the end of its flight (a whiff): detonate at
      // its track point, scaled by distance to the nearest human.
      case 'rocket_expire': {
        const lvl = audibility(pos, humans);
        if (lvl > 0) out.push({ cue: 'rocket_hit', gain: clamp01(lvl) });
        break;
      }
    }
    return out;
  }

  // RaceSession's 1 Hz countdown: n > 0 ticks, n === 0 is the GO beat, n < 0 is
  // the banner-clearing beat and makes no sound.
  countdown(n) {
    if (n < 0) return [];
    return [{ cue: 'countdown', part: n > 0 ? 'tick' : 'go' }];
  }

  // A bigger roster means someone joined (renames and car picks keep the count) —
  // greet them with the join plink. Lobby only; mid-race arrivals are reconnects.
  roster(count, inLobby) {
    const grew = count > this._rosterCount;
    this._rosterCount = count;
    return (grew && inLobby) ? [{ cue: 'join', gain: 1 }] : [];
  }

  // ---- voice lifecycle ----
  // Kill all live voices — pause, race end, return to lobby. Without this a
  // frozen frame would hold its sounds forever (frame() stops updating levels).
  stopVoices() {
    this._voices.clear();
    this._rockets = new Set();
    return [{ voices: 'stop-all' }];
  }
  // One car left the race (forfeit) or changed id (cross-device rejoin) — frame()
  // will never feed that id a zero level, so kill its voices here.
  stopCar(id) {
    const suffix = ':' + id;
    for (const key of this._voices) if (key.endsWith(suffix)) this._voices.delete(key);
    return [{ voices: 'stop-car', id }];
  }

  // ---- music ----
  // Ambient, not a cue: the race song plays globally for the whole race (it does
  // NOT follow the visible-events rule the SFX do).
  //
  // Takes the race's BIOME name and picks from that biome's pool — random, but
  // never the song that just played (across races AND biomes) when there's an
  // alternative, so a 4-race GP through one biome rotates its pool. Per-pick
  // loudness trim: MUSIC_LEVEL is the bed height, pick.gain flattens the
  // catalogue's mastering spread so every song sits at that height.
  startMusic(biome) {
    const pool = (RACE_MUSIC[biome] && RACE_MUSIC[biome].length) ? RACE_MUSIC[biome] : MUSIC_FALLBACK;
    const fresh = pool.length > 1 ? pool.filter((s) => s.file !== this._musicFile) : pool;
    const pick = fresh[(this.rng() * fresh.length) | 0];
    this.nowPlaying = pick;
    this._musicFile = pick.file;
    return [{ music: 'start', song: pick, level: MUSIC_LEVEL * (pick.gain || 1) }];
  }
  stopMusic() { return [{ music: 'stop' }]; }
  pauseMusic() { return [{ music: 'pause' }]; }
  resumeMusic() { return [{ music: 'resume' }]; }
}
