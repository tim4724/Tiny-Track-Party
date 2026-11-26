// Candidate "toy foley" sound palette — Web Audio synthesis, no asset files.
//
// This module is the single source of truth for race SFX. Each cue offers a few
// candidate variants; /gallery-sounds.html is the audition surface where
// variants get approved or vetoed before anything is wired into the race.
// Once a palette is approved, RaceAudio plays the picked variant per cue.
//
// Texture rules (why these sound the way they do):
// - The game looks like soft plastic toys, so cues are toy noises (plinks,
//   knocks, pops, boings, squeaks) — not car noises. Sine/triangle timbres
//   only; no raw sawtooth/square drones (the rejected v1 engine).
// - Pitches sit on a C-major pentatonic-ish palette so overlapping cues stay
//   harmonically friendly on a TV running for a whole session.
// - Every frequent cue self-jitters ±1 semitone so spamming it doesn't fatigue.
//
// Every variant's play(ctx, dest) schedules from ctx.currentTime and works on
// both AudioContext and OfflineAudioContext (no performance.now, no globals).

// ---- note palette (Hz) ----
import { assetUrl } from '../../shared/assetUrl.js';

const C5 = 523.25, E5 = 659.25, G5 = 783.99;
const C6 = 1046.50, E6 = 1318.51;

// ±spread semitones of random detune — variation against repetition fatigue.
function jitter(spread = 1) {
  return Math.pow(2, ((Math.random() * 2 - 1) * spread) / 12);
}

// 1s of cached white noise per context (WeakMap so offline contexts get their own).
const noiseBufs = new WeakMap();
function noiseBuf(ctx) {
  let buf = noiseBufs.get(ctx);
  if (!buf) {
    const n = ctx.sampleRate;
    buf = ctx.createBuffer(1, n, n);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    noiseBufs.set(ctx, buf);
  }
  return buf;
}

// The one asset-backed cue. Everything else in this module is synthesized, but
// the driving engine is a REAL recorded loop (CC0, ggbotnet —
// public/assets/audio/engine_loop.ogg, see its .LICENSE.txt), played the way
// shipping racers do: loop it and pitch-shift playbackRate with speed.
//
// Web Audio can't decode synchronously and this module stays fetch-free at
// import time (so Node can import the cue table), so the host (RaceAudio / the
// gallery) calls loadSampleBuffers(ctx) once after it creates the context. The
// decoded buffer is cached per-context; until it resolves the engine voice is
// simply silent — in practice the decode finishes during the lobby, long before
// the first race frame asks for an engine.
const SAMPLE_URLS = {
  engine: assetUrl('/assets/audio/engine_loop.ogg'),
  // The rocket impact — a real CC0 recording (assets/audio/sfx/SFX.LICENSE.txt), decoded with
  // the engine loop on the first user gesture and played one-shot by the rocket_hit cue.
  explosionPunch: assetUrl('/assets/audio/sfx/explosion-punch.ogg')
};
const sampleBufs = new WeakMap(); // ctx -> { engine: AudioBuffer, ... }

export async function loadSampleBuffers(ctx) {
  let cache = sampleBufs.get(ctx);
  if (!cache) { cache = {}; sampleBufs.set(ctx, cache); }
  await Promise.all(Object.entries(SAMPLE_URLS).map(async ([name, url]) => {
    if (cache[name]) return;                          // already decoded for this ctx
    try {
      const data = await fetch(url).then((r) => r.arrayBuffer());
      cache[name] = await ctx.decodeAudioData(data);
    } catch (_) { /* leave unset — the voice stays silent rather than throwing */ }
  }));
  return cache;
}
function sampleBuf(ctx, name) {
  const cache = sampleBufs.get(ctx);
  return (cache && cache[name]) || null;
}

// Loop a recorded buffer and pitch-shift it by speed (playbackRate = RPM),
// opening a lowpass for air as it revs. bufFn(ctx) returns the decoded buffer
// (or null if the async decode hasn't landed yet — then the voice is silently
// inert). opts give the per-variant rate / filter / gain ranges.
function bakedLoopVoice(ctx, dest, bufFn, opts = {}) {
  const { rate0 = 0.55, rateSpan = 1.25, lp0 = 500, lpSpan = 2200, gain0 = 0.05, gainSpan = 0.06, Q = 0.7 } = opts;
  const src = ctx.createBufferSource();
  const buf = bufFn(ctx);
  if (buf) src.buffer = buf;        // null until the decode lands → plays silence
  src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = lp0; lp.Q.value = Q;
  const out = ctx.createGain(); out.gain.value = 0.0001;
  src.connect(lp); lp.connect(out); out.connect(dest);
  src.start(ctx.currentTime);
  return {
    // mod (optional): { rateMul, gainMul, lpMul } scale the pitch / loudness / lowpass
    // cutoff away from the speed curve — used to DEEPEN the engine into a big-truck growl
    // while a car is a monster truck (rateMul<1 = lower pitch, lpMul<1 = muffled top end).
    // setTargetAtTime smooths the jump, so it glides into/out of the growl, not a click.
    set(level, mod) {
      const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
      const rMul = (mod && mod.rateMul) || 1, gMul = (mod && mod.gainMul) || 1, fMul = (mod && mod.lpMul) || 1;
      src.playbackRate.setTargetAtTime((rate0 + l * rateSpan) * rMul, at, 0.12); // RPM
      lp.frequency.setTargetAtTime((lp0 + l * lpSpan) * fMul, at, 0.1);
      out.gain.setTargetAtTime((gain0 + l * gainSpan) * gMul, at, 0.08);
    },
    stop() {
      const at = ctx.currentTime;
      out.gain.setTargetAtTime(0.0001, at, 0.1);
      try { src.stop(at + 0.5); } catch (_) { /* already stopped */ }
    }
  };
}

// One-shot sample play: a decoded buffer (or a leading WINDOW of it) with a quick fade
// in/out, optionally pitch-shifted. Returns the played duration (0 if the buffer hasn't
// decoded yet — then it's silently inert, like the engine voice). The rocket cues use this
// to play real CC0 recordings (assets/audio/sfx) instead of synthesis. `dur` trims a long
// clip (e.g. the explosion's 4 s tail) to a tidy length with a fade-out.
function playSample(ctx, dest, t, name, gain = 1) {
  const buf = sampleBuf(ctx, name);
  if (!buf) return 0;                                   // decode hasn't landed yet → silent (like the engine voice)
  const peak = Math.max(gain, 0.0002), dur = buf.duration;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.004);     // tiny attack, no click
  g.gain.setValueAtTime(peak, t + dur - 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);     // tiny release
  const src = ctx.createBufferSource(); src.buffer = buf;
  src.connect(g); g.connect(dest);
  src.start(t);
  return dur;
}

// ---- building blocks ----

// Percussive gain envelope: fast attack → (optional hold) → exponential decay.
function env(ctx, dest, t, vol, a, d, hold = 0) {
  const g = ctx.createGain();
  g.connect(dest);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + a);
  if (hold > 0) g.gain.setValueAtTime(vol, t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
  return g;
}

// Enveloped oscillator, optional pitch glide. The workhorse.
function tone(ctx, dest, t, { f, to = 0, dur = 0.2, type = 'sine', vol = 0.3, a = 0.008, hold = 0 }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (to > 0) o.frequency.exponentialRampToValueAtTime(to, t + a + hold + dur);
  const g = env(ctx, dest, t, vol, a, dur, hold);
  o.connect(g);
  o.start(t);
  o.stop(t + a + hold + dur + 0.08);
}

// Filtered noise burst, optional frequency sweep (whoosh).
function noise(ctx, dest, t, { dur = 0.1, f = 1500, fTo = 0, Q = 1, vol = 0.15, a = 0.01, hold = 0, type = 'bandpass' }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf(ctx);
  src.loop = true;
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.frequency.setValueAtTime(f, t);
  if (fTo > 0) filt.frequency.exponentialRampToValueAtTime(fTo, t + a + hold + dur);
  filt.Q.value = Q;
  const g = env(ctx, dest, t, vol, a, dur, hold);
  src.connect(filt);
  filt.connect(g);
  src.start(t);
  src.stop(t + a + hold + dur + 0.08);
}

// Marimba-ish pluck: sine fundamental + fast-dying inharmonic partial + mallet tick.
function pluck(ctx, dest, t, f, vol = 0.3) {
  tone(ctx, dest, t, { f, dur: 0.3, type: 'sine', vol });
  tone(ctx, dest, t, { f: f * 3.93, dur: 0.06, type: 'sine', vol: vol * 0.3 });
  noise(ctx, dest, t, { dur: 0.012, f: f * 3, Q: 1, vol: vol * 0.2 });
}

// Woodblock knock: very short mid sine + clicky noise.
function knock(ctx, dest, t, f = 820, vol = 0.3) {
  tone(ctx, dest, t, { f, dur: 0.045, type: 'sine', vol, a: 0.002 });
  noise(ctx, dest, t, { dur: 0.018, f: f * 2.2, Q: 2, vol: vol * 0.5, a: 0.001 });
}

// Amplitude-tremolo tone: a tone whose loudness flutters at tremHz, with an
// optional pitch glide. Dizzy wah-wah-wahs, flutter rises.
function tremTone(ctx, dest, t, { f, to = 0, dur = 0.4, type = 'sine', vol = 0.25, tremHz = 12, depth = 0.8, a = 0.02 }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (to > 0) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  const trem = ctx.createGain();
  trem.gain.value = 1 - depth / 2;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = tremHz;
  const lg = ctx.createGain();
  lg.gain.value = depth / 2;
  lfo.connect(lg);
  lg.connect(trem.gain);
  const g = env(ctx, dest, t, vol, a, 0.08, Math.max(0, dur - 0.08));
  o.connect(trem);
  trem.connect(g);
  o.start(t); o.stop(t + dur + 0.1);
  lfo.start(t); lfo.stop(t + dur + 0.1);
}

// Rising bubble pop.
function pop(ctx, dest, t, { from = 250, to = 540, dur = 0.07, vol = 0.3 }) {
  tone(ctx, dest, t, { f: from, to, dur, type: 'sine', vol, a: 0.004 });
  noise(ctx, dest, t, { dur: 0.015, f: 2400, Q: 1.5, vol: vol * 0.2, a: 0.001 });
}

// Committed palette — what plays when no gallery pick overrides it (fresh
// browser, the TV, preview deploys). Every entry is an audition WINNER (Tim's
// starred picks, settled 2026-06-11), so each cue carries one variant. Taste
// rules that got here (don't relitigate): big physical moments are
// non-musical (the boost is state-tracked wind; nine rounds of stings were
// vetoed as "too musical / too cartoonish"); small UI beats are toy-musical.
export const DEFAULT_PICKS = {
  countdown: 'marimba',
  pickup: 'bubble',
  roulette: 'ticktock',
  boost: 'smooth',
  corner: 'squeal',
  brake: 'rubber',
  drift: 'grain',           // Tim's pick from the drift sound lineup (2026-10-13)
  sand: 'grit',
  sand_snow: 'crunch',
  sand_gravel: 'crackle',
  sand_dirt: 'rush',
  sand_felt: 'rub',
  rain: 'storm',           // the weather's bed, under a race whose sky rains
  banana_drop: 'plop',
  banana_slip: 'dizzy',
  monster_inflate: 'turbo', // Tim's gallery pick (2026-06-21)
  monster_deflate: 'hiss',  // Tim's gallery pick (2026-06-21)
  lap: 'plink2',
  screech: 'rumble',
  join: 'risingtwo',
  engine_putt: 'realloop', // the recorded engine loop, pitch-shifted by speed (Tim, 2026-06-13)
  rocket_fire: 'jet',      // rocket FLIGHT — continuous airy jet loop, held for the whole air time
  rocket_hit: 'punch',     // rocket detonation — punchy CC0 explosion sample
  land: 'thud'             // a car comes down off a hop
  // Cut after auditioning: 'ready' (the roulette's reveal pop already lands
  // that beat), 'final_lap' (redundant with the lap chime) and 'finish' (the
  // chequered-flag crossing plays the ordinary lap chime — the results screen
  // carries the celebration).
};

// The variant the race should play for a cue: caller-supplied picks (the sound
// gallery's starred choices) override DEFAULT_PICKS; unknown ids fall back so a
// stale localStorage pick can't silence a cue.
export function resolveVariant(cueId, picks = {}) {
  const cue = CUES.find((c) => c.id === cueId);
  if (!cue) return null;
  const wanted = picks[cueId] || DEFAULT_PICKS[cueId];
  return cue.variants.find((v) => v.id === wanted) || cue.variants[0];
}

// ---- the cue table ----
// One entry per game moment. `variants` are the candidates to audition; demos
// play the cue the way the race would fire it (sequences play in rhythm).

export const CUES = [
  {
    id: 'countdown',
    label: 'Countdown · 3-2-1-GO',
    desc: 'One tick per beat (1s apart), then GO on the launch beat.',
    // Countdown variants expose tick()/go() so the race can play one beat at a
    // time as RaceSession's 1 Hz timer fires; play() composes them for the demo.
    variants: [
      {
        id: 'marimba', label: 'A · marimba',
        tick(ctx, dest, t = ctx.currentTime) { pluck(ctx, dest, t, E5 * jitter(0.3), 0.3); },
        go(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.3);
          pluck(ctx, dest, t, C6 * j, 0.34);
          pluck(ctx, dest, t + 0.05, E6 * j, 0.2);
        },
        play(ctx, dest, t = ctx.currentTime) {
          for (let i = 0; i < 3; i++) this.tick(ctx, dest, t + i);
          this.go(ctx, dest, t + 3);
          return 3.6;
        }
      },
    ]
  },
  {
    id: 'pickup',
    label: 'Item box pickup',
    desc: 'Car drives through an item box. Fires often — spam the button to fatigue-test.',
    variants: [
      {
        id: 'bubble', label: 'A · bubble pop',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter();
          pop(ctx, dest, t, { from: 260 * j, to: 560 * j, vol: 0.3 });
          return 0.15;
        }
      },
    ]
  },
  {
    id: 'roulette',
    label: 'Item roulette',
    desc: 'Decelerating ticks while the item chip spins (~0.9s), soft pop on the reveal.',
    variants: [
      {
        id: 'ticktock', label: 'A · tick-tock',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.5);
          let dt = 0.06, at = 0, i = 0;
          while (at < 0.78) {
            knock(ctx, dest, t + at, (i % 2 ? 660 : 820) * j, 0.16);
            at += dt; dt *= 1.22; i++;
          }
          pop(ctx, dest, t + 0.88, { from: 300 * j, to: 600 * j, vol: 0.26 });
          return 1.1;
        }
      },
    ]
  },
  {
    id: 'boost',
    label: 'Boost',
    desc: 'A STATE-DRIVEN voice (the one continuous race sound): starts on the surge, follows the live boost strength every frame, dies with the taper. Slider = boost strength.',
    continuous: true,
    variants: [
      {
        id: 'smooth', label: 'smooth wind',
        start(ctx, dest) {
          // The plainest option: a dark steady bed whose level and brightness
          // simply follow the boost.
          const t = ctx.currentTime;
          const src = ctx.createBufferSource();
          src.buffer = noiseBuf(ctx);
          src.loop = true;
          const filt = ctx.createBiquadFilter();
          filt.type = 'lowpass';
          filt.frequency.value = 500;
          const out = ctx.createGain();
          out.gain.value = 0.0001;
          src.connect(filt); filt.connect(out); out.connect(dest);
          src.start(t);
          return {
            set(level) {
              const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.1 * l, at, 0.06);
              filt.frequency.setTargetAtTime(420 + l * 480, at, 0.08);
            },
            stop() {
              const at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001, at, 0.08);
              try { src.stop(at + 0.5); } catch (_) { /* already stopped */ }
            }
          };
        }
      }
    ]
  },
  {
    id: 'corner',
    label: 'Tire squeal (cornering)',
    desc: 'STATE-DRIVEN like the boost wind: rises while steering hard at speed, gone when the wheel straightens. Slider = cornering intensity.',
    continuous: true,
    variants: [
      {
        id: 'squeal', label: 'soft squeal',
        start(ctx, dest) {
          // A narrow band of noise with a slow wobble — tire song, not a shriek.
          const t = ctx.currentTime;
          const src = ctx.createBufferSource();
          src.buffer = noiseBuf(ctx);
          src.loop = true;
          const filt = ctx.createBiquadFilter();
          filt.type = 'bandpass';
          filt.frequency.value = 1300;
          filt.Q.value = 5;
          const lfo = ctx.createOscillator();
          lfo.frequency.value = 6;
          const depth = ctx.createGain();
          depth.gain.value = 70;
          lfo.connect(depth);
          depth.connect(filt.frequency);
          const out = ctx.createGain();
          out.gain.value = 0.0001;
          src.connect(filt); filt.connect(out); out.connect(dest);
          src.start(t); lfo.start(t);
          return {
            set(level) {
              const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.07 * l, at, 0.05);
              filt.frequency.setTargetAtTime(1200 + l * 350, at, 0.07);
            },
            stop() {
              const at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001, at, 0.06);
              try { src.stop(at + 0.4); lfo.stop(at + 0.4); } catch (_) { /* already stopped */ }
            }
          };
        }
      },
    ]
  },
  {
    id: 'brake',
    label: 'Brake skid',
    desc: 'STATE-DRIVEN: rises with brake pressure while the car still has speed, gone at rest. Slider = brake × speed.',
    continuous: true,
    variants: [
      {
        id: 'rubber', label: 'pulsing rubber',
        start(ctx, dest) {
          // A juddering rub — the tire grabbing in pulses as it slows.
          const t = ctx.currentTime;
          const src = ctx.createBufferSource();
          src.buffer = noiseBuf(ctx);
          src.loop = true;
          const filt = ctx.createBiquadFilter();
          filt.type = 'bandpass';
          filt.frequency.value = 950;
          filt.Q.value = 3;
          const gate = ctx.createGain();
          gate.gain.value = 0.55;
          const lfo = ctx.createOscillator();
          lfo.frequency.value = 11;
          const depth = ctx.createGain();
          depth.gain.value = 0.45;
          lfo.connect(depth);
          depth.connect(gate.gain);
          const out = ctx.createGain();
          out.gain.value = 0.0001;
          src.connect(filt); filt.connect(gate); gate.connect(out); out.connect(dest);
          src.start(t); lfo.start(t);
          return {
            set(level) {
              const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.14 * l, at, 0.05);
            },
            stop() {
              const at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001, at, 0.06);
              try { src.stop(at + 0.4); lfo.stop(at + 0.4); } catch (_) { /* already stopped */ }
            }
          };
        }
      },
    ]
  },
  {
    id: 'drift',
    label: 'Drift',
    desc: 'STATE-DRIVEN: the drift\'s own tyre voice, lower and rougher than the corner squeal; the squeal and the brake give way to it. Rises with the drift, gone when it ends. Slider = drift mix.',
    continuous: true,
    variants: [
      {
        id: 'grain', label: 'rough grain',
        start(ctx, dest) {
          // Two noise bands, a low one wobbling slowly, with a fast grain
          // flutter over both: scrubbing rubber rather than a squeal, as loud
          // as the squeal it replaces (A-weighted).
          // Both LFOs are integer Hz so the baked 1 s loop closes in phase.
          const t = ctx.currentTime;
          const src = ctx.createBufferSource();
          src.buffer = noiseBuf(ctx);
          src.loop = true;
          const lo = ctx.createBiquadFilter();
          lo.type = 'bandpass';
          lo.frequency.value = 760;
          lo.Q.value = 4;
          const hi = ctx.createBiquadFilter();
          hi.type = 'bandpass';
          hi.frequency.value = 1520;
          hi.Q.value = 7;
          const hiGain = ctx.createGain();
          hiGain.gain.value = 0.45;
          const wobble = ctx.createOscillator();
          wobble.frequency.value = 3;
          const wobbleDepth = ctx.createGain();
          wobbleDepth.gain.value = 35;
          wobble.connect(wobbleDepth);
          wobbleDepth.connect(lo.frequency);
          const grain = ctx.createGain();
          grain.gain.value = 0.7;
          const flutter = ctx.createOscillator();
          flutter.frequency.value = 17;
          const flutterDepth = ctx.createGain();
          flutterDepth.gain.value = 0.3;
          flutter.connect(flutterDepth);
          flutterDepth.connect(grain.gain);
          const out = ctx.createGain();
          out.gain.value = 0.0001;
          src.connect(lo); src.connect(hi); hi.connect(hiGain);
          lo.connect(grain); hiGain.connect(grain); grain.connect(out); out.connect(dest);
          src.start(t); wobble.start(t); flutter.start(t);
          return {
            set(level) {
              const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.124 * l, at, 0.05);
            },
            stop() {
              const at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001, at, 0.06);
              try { src.stop(at + 0.4); wobble.stop(at + 0.4); flutter.stop(at + 0.4); } catch (_) { /* already stopped */ }
            }
          };
        }
      },
    ]
  },
  {
    id: 'sand',
    label: 'Sand',
    desc: 'STATE-DRIVEN: tyres ploughing through the sand strip beside the road: a low rush with a dry hiss over it.',
    continuous: true,
    variants: [
      {
        id: 'grit', label: 'gritty rush',
        start(ctx, dest) {
          // Foley, not a tyre note: two wide noise bands, far apart so it sits
          // clear of the squeal and the drift, with a fast uneven grain over both.
          // Both LFOs are integer Hz so the baked 1 s loop closes in phase.
          const t = ctx.currentTime;
          const src = ctx.createBufferSource();
          src.buffer = noiseBuf(ctx);
          src.loop = true;
          const lo = ctx.createBiquadFilter();
          lo.type = 'bandpass';
          lo.frequency.value = 340;
          lo.Q.value = 1;
          const hi = ctx.createBiquadFilter();
          hi.type = 'bandpass';
          hi.frequency.value = 3200;
          hi.Q.value = 0.8;
          const hiGain = ctx.createGain();
          hiGain.gain.value = 0.35;
          const grain = ctx.createGain();
          grain.gain.value = 0.7;
          const flutterA = ctx.createOscillator();
          flutterA.frequency.value = 23;
          const flutterB = ctx.createOscillator();
          flutterB.frequency.value = 37;
          const flutterDepth = ctx.createGain();
          flutterDepth.gain.value = 0.2;
          flutterA.connect(flutterDepth);
          flutterB.connect(flutterDepth);
          flutterDepth.connect(grain.gain);
          const out = ctx.createGain();
          out.gain.value = 0.0001;
          src.connect(lo); src.connect(hi); hi.connect(hiGain);
          lo.connect(grain); hiGain.connect(grain); grain.connect(out); out.connect(dest);
          src.start(t); flutterA.start(t); flutterB.start(t);
          return {
            set(level) {
              const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.16 * l, at, 0.05);
            },
            stop() {
              const at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001, at, 0.06);
              try { src.stop(at + 0.4); flutterA.stop(at + 0.4); flutterB.stop(at + 0.4); } catch (_) {}
            }
          };
        }
      },
    ]
  },
  {
    id: 'sand_snow',
    label: 'Snow strip',
    desc: 'STATE-DRIVEN: tyres through the loose powder beside a snow road: a soft, slow crunch. The sand cue\'s graph with this ground\'s numbers.',
    continuous: true,
    variants: [
      {
        id: 'crunch', label: 'powder crunch',
        start(ctx, dest) {
          const t = ctx.currentTime;
          const src = ctx.createBufferSource();
          src.buffer = noiseBuf(ctx);
          src.loop = true;
          const lo = ctx.createBiquadFilter();
          lo.type = 'bandpass';
          lo.frequency.value = 520;
          lo.Q.value = 0.8;
          const hi = ctx.createBiquadFilter();
          hi.type = 'bandpass';
          hi.frequency.value = 5200;
          hi.Q.value = 0.7;
          const hiGain = ctx.createGain();
          hiGain.gain.value = 0.22;
          const grain = ctx.createGain();
          grain.gain.value = 0.55;
          const flutterA = ctx.createOscillator();
          flutterA.frequency.value = 9;
          const flutterB = ctx.createOscillator();
          flutterB.frequency.value = 13;
          const flutterDepth = ctx.createGain();
          flutterDepth.gain.value = 0.225;
          flutterA.connect(flutterDepth);
          flutterB.connect(flutterDepth);
          flutterDepth.connect(grain.gain);
          const out = ctx.createGain();
          out.gain.value = 0.0001;
          src.connect(lo); src.connect(hi); hi.connect(hiGain);
          lo.connect(grain); hiGain.connect(grain); grain.connect(out); out.connect(dest);
          src.start(t); flutterA.start(t); flutterB.start(t);
          return {
            set(level) {
              const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.14 * l, at, 0.05);
            },
            stop() {
              const at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001, at, 0.06);
              try { src.stop(at + 0.4); flutterA.stop(at + 0.4); flutterB.stop(at + 0.4); } catch (_) {}
            }
          };
        }
      },
    ]
  },
  {
    id: 'sand_gravel',
    label: 'Gravel strip',
    desc: 'STATE-DRIVEN: tyres on the gravel beside a backyard road: a bright, fast crackle. The sand cue\'s graph with this ground\'s numbers.',
    continuous: true,
    variants: [
      {
        id: 'crackle', label: 'gravel crackle',
        start(ctx, dest) {
          const t = ctx.currentTime;
          const src = ctx.createBufferSource();
          src.buffer = noiseBuf(ctx);
          src.loop = true;
          const lo = ctx.createBiquadFilter();
          lo.type = 'bandpass';
          lo.frequency.value = 900;
          lo.Q.value = 1.2;
          const hi = ctx.createBiquadFilter();
          hi.type = 'bandpass';
          hi.frequency.value = 4200;
          hi.Q.value = 1;
          const hiGain = ctx.createGain();
          hiGain.gain.value = 0.6;
          const grain = ctx.createGain();
          grain.gain.value = 0.55;
          const flutterA = ctx.createOscillator();
          flutterA.frequency.value = 41;
          const flutterB = ctx.createOscillator();
          flutterB.frequency.value = 59;
          const flutterDepth = ctx.createGain();
          flutterDepth.gain.value = 0.225;
          flutterA.connect(flutterDepth);
          flutterB.connect(flutterDepth);
          flutterDepth.connect(grain.gain);
          const out = ctx.createGain();
          out.gain.value = 0.0001;
          src.connect(lo); src.connect(hi); hi.connect(hiGain);
          lo.connect(grain); hiGain.connect(grain); grain.connect(out); out.connect(dest);
          src.start(t); flutterA.start(t); flutterB.start(t);
          return {
            set(level) {
              const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.17 * l, at, 0.05);
            },
            stop() {
              const at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001, at, 0.06);
              try { src.stop(at + 0.4); flutterA.stop(at + 0.4); flutterB.stop(at + 0.4); } catch (_) {}
            }
          };
        }
      },
    ]
  },
  {
    id: 'sand_dirt',
    label: 'Dirt strip',
    desc: 'STATE-DRIVEN: tyres in the loose dirt beside a canyon road: a low, dry rush. The sand cue\'s graph with this ground\'s numbers.',
    continuous: true,
    variants: [
      {
        id: 'rush', label: 'dirt rush',
        start(ctx, dest) {
          const t = ctx.currentTime;
          const src = ctx.createBufferSource();
          src.buffer = noiseBuf(ctx);
          src.loop = true;
          const lo = ctx.createBiquadFilter();
          lo.type = 'bandpass';
          lo.frequency.value = 260;
          lo.Q.value = 1;
          const hi = ctx.createBiquadFilter();
          hi.type = 'bandpass';
          hi.frequency.value = 2200;
          hi.Q.value = 0.8;
          const hiGain = ctx.createGain();
          hiGain.gain.value = 0.3;
          const grain = ctx.createGain();
          grain.gain.value = 0.75;
          const flutterA = ctx.createOscillator();
          flutterA.frequency.value = 19;
          const flutterB = ctx.createOscillator();
          flutterB.frequency.value = 31;
          const flutterDepth = ctx.createGain();
          flutterDepth.gain.value = 0.125;
          flutterA.connect(flutterDepth);
          flutterB.connect(flutterDepth);
          flutterDepth.connect(grain.gain);
          const out = ctx.createGain();
          out.gain.value = 0.0001;
          src.connect(lo); src.connect(hi); hi.connect(hiGain);
          lo.connect(grain); hiGain.connect(grain); grain.connect(out); out.connect(dest);
          src.start(t); flutterA.start(t); flutterB.start(t);
          return {
            set(level) {
              const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.16 * l, at, 0.05);
            },
            stop() {
              const at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001, at, 0.06);
              try { src.stop(at + 0.4); flutterA.stop(at + 0.4); flutterB.stop(at + 0.4); } catch (_) {}
            }
          };
        }
      },
    ]
  },
  {
    id: 'sand_felt',
    label: 'Felt strip',
    desc: 'STATE-DRIVEN: tyres on the felt beside a playroom track: a quiet, muffled rub. The sand cue\'s graph with this ground\'s numbers.',
    continuous: true,
    variants: [
      {
        id: 'rub', label: 'felt rub',
        start(ctx, dest) {
          const t = ctx.currentTime;
          const src = ctx.createBufferSource();
          src.buffer = noiseBuf(ctx);
          src.loop = true;
          const lo = ctx.createBiquadFilter();
          lo.type = 'bandpass';
          lo.frequency.value = 220;
          lo.Q.value = 0.7;
          const hi = ctx.createBiquadFilter();
          hi.type = 'bandpass';
          hi.frequency.value = 900;
          hi.Q.value = 0.7;
          const hiGain = ctx.createGain();
          hiGain.gain.value = 0.1;
          const grain = ctx.createGain();
          grain.gain.value = 0.9;
          const flutterA = ctx.createOscillator();
          flutterA.frequency.value = 5;
          const flutterB = ctx.createOscillator();
          flutterB.frequency.value = 7;
          const flutterDepth = ctx.createGain();
          flutterDepth.gain.value = 0.05;
          flutterA.connect(flutterDepth);
          flutterB.connect(flutterDepth);
          flutterDepth.connect(grain.gain);
          const out = ctx.createGain();
          out.gain.value = 0.0001;
          src.connect(lo); src.connect(hi); hi.connect(hiGain);
          lo.connect(grain); hiGain.connect(grain); grain.connect(out); out.connect(dest);
          src.start(t); flutterA.start(t); flutterB.start(t);
          return {
            set(level) {
              const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.08 * l, at, 0.05);
            },
            stop() {
              const at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001, at, 0.06);
              try { src.stop(at + 0.4); flutterA.stop(at + 0.4); flutterB.stop(at + 0.4); } catch (_) {}
            }
          };
        }
      },
    ]
  },
  {
    id: 'rain',
    label: 'Rain',
    desc: 'STATE-DRIVEN, but the weather\'s rather than a car\'s: a steady bed under the whole race on a track whose sky rains (Driftwood\'s storm). Rain on sand and water, a soft wind, the surf far off. Slider = level; a race plays it at full.',
    continuous: true,
    variants: [
      {
        id: 'storm', label: 'storm beach',
        // Its OWN loop, not the 1 s noise buffer the other beds run off: one
        // second of rain repeats audibly, ten do not. Seeded and made at its
        // own rate, so every context plays the same storm and the bake is that
        // storm sample for sample. Made once per context, tens of milliseconds
        // of work, which is why the bed starts when a wet race is BOUND: that
        // lands it in the launch rather than on the countdown.
        rate: 32000, loopSeconds: 10, channels: 2,
        loops: new WeakMap(),
        loop(ctx) {
          let buf = this.loops.get(ctx);
          if (buf) return buf;
          const sr = this.rate, n = sr * this.loopSeconds, TAU = 2 * Math.PI;
          let seed = 0x5241494e;                               // 'RAIN', a xorshift32
          const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed; };
          const rnd = () => (next() >>> 0) / 4294967296;
          const white = () => {
            const x = new Float32Array(n);
            for (let i = 0; i < n; i++) x[i] = next() / 2147483648;
            return x;
          };
          const coef = (hz) => 1 - Math.exp(-TAU * hz / sr);
          const unit = (x) => {
            let q = 0;
            for (let i = 0; i < n; i++) q += x[i] * x[i];
            const r = Math.sqrt(n / q);
            for (let i = 0; i < n; i++) x[i] *= r;
            return x;
          };
          // Two one-pole high-passes then two low-passes (0 Hz skips a
          // high-pass, Infinity a low-pass), in place, to unit rms. The chain
          // runs over the loop's last quarter second first, so it enters
          // sample 0 in the state it leaves the last one in: the output closes
          // on itself, and so does every layer below.
          const shape = (x, h1, h2, l1, l2) => {
            const a1 = coef(h1), a2 = coef(h2), b1 = coef(l1), b2 = coef(l2);
            let s1 = 0, s2 = 0, t1 = 0, t2 = 0;
            for (let i = n - (sr >> 2), j = i; i < 2 * n; i++, j = i < n ? i : i - n) {
              const v = x[j]; s1 += a1 * (v - s1); const u = v - s1; s2 += a2 * (u - s2);
              t1 += b1 * (u - s2 - t1); t2 += b2 * (t1 - t2);
              if (i >= n) x[j] = t2;
            }
            return unit(x);
          };
          // A slow movement in whole cycles of the loop: `fn` of the phase
          // 0..1, sampled every 64 frames and read back linearly.
          const slow = (fn) => {
            const m = new Float32Array((n >> 6) + 2), x = new Float32Array(n);
            for (let c = 0; c < m.length; c++) m[c] = fn(c * 64 / n);
            for (let i = 0; i < n; i++) { const c = i >> 6; x[i] = m[c] + (m[c + 1] - m[c]) * (i & 63) / 64; }
            return x;
          };
          // Drops, each a point across the stereo field, most of them faint.
          const drops = (perSecond, sound) => {
            const a = new Float32Array(n), b = new Float32Array(n);
            for (let k = perSecond * this.loopSeconds; k > 0; k--) {
              const at = Math.floor(rnd() * n), amp = Math.pow(10, -1.2 * rnd()), pan = rnd() * TAU / 4;
              sound(a, b, at, amp * Math.cos(pan), amp * Math.sin(pan));
            }
            return [a, b];
          };
          // A stereo pair into the bed at `gain`, under an optional envelope,
          // `spread` radians toward each other: 0 keeps the sides unrelated
          // (wide), more draws them toward the middle.
          const L = new Float32Array(n), R = new Float32Array(n);
          const add = (a, b, gain, spread = 0, env = null) => {
            const c = gain * Math.cos(spread), s = gain * Math.sin(spread);
            for (let i = 0; i < n; i++) {
              const k = env ? env[i] : 1;
              L[i] += k * (c * a[i] + s * b[i]); R[i] += k * (s * a[i] + c * b[i]);
            }
          };
          const gp = [rnd() * TAU, rnd() * TAU, rnd() * TAU];
          const gust = slow((t) => 0.22 * Math.sin(TAU * t + gp[0]) + 0.14 * Math.sin(2 * TAU * t + gp[1])
            + 0.07 * Math.sin(5 * TAU * t + gp[2]));

          // The sheet: the hiss of drops too many and too small to hear one
          // by one, coming in harder on the gusts.
          add(shape(white(), 450, 450, 5500, 12000), shape(white(), 450, 450, 5500, 12000),
            1, 0.1, gust.map((g) => 1 + 0.5 * g));
          // On the sand, a short dull tick.
          {
            const [a, b] = drops(200, (a, b, i, gl, gr) => {
              const tau = (0.4 + 1.6 * rnd()) * 1e-3 * sr, d = Math.exp(-1 / tau), c = coef(1200 + 3800 * rnd());
              let e = 1, y = 0;
              for (let j = Math.ceil(5 * tau); j > 0; j--, e *= d) {
                y += c * ((next() / 2147483648) * e - y);
                a[i] += gl * y; b[i] += gr * y;
                if (++i === n) i = 0;
              }
            });
            add(shape(a, 120, 0, Infinity, Infinity), shape(b, 120, 0, Infinity, Infinity), 0.4);
          }
          // On the water, a fainter plic: a few cycles of a pitch that rises
          // as the bubble the drop trapped comes up.
          {
            const [a, b] = drops(24, (a, b, i, gl, gr) => {
              const w = TAU * 1100 * Math.pow(3, rnd()) / sr, rise = 0.2 + 0.6 * rnd();
              const tau = (1.5 + 2.5 * rnd()) * 1e-3 * sr, d = Math.exp(-1 / tau), dq = Math.exp(-1 / (0.006 * sr));
              let e = 1, q = 1, ph = 0;
              for (let j = Math.ceil(5 * tau); j > 0; j--, e *= d, q *= dq) {
                ph += w * (1 + rise * (1 - q));
                const v = e * Math.sin(ph);
                a[i] += gl * v; b[i] += gr * v;
                if (++i === n) i = 0;
              }
            });
            add(unit(a), unit(b), 0.12);
          }
          // A soft wind on the same gusts: low rushing air, brighter as it blows.
          {
            const a = white(), b = white();
            const ra = shape(a.slice(), 350, 0, 1300, 1300), rb = shape(b.slice(), 350, 0, 1300, 1300);
            shape(a, 80, 0, 260, 260); shape(b, 80, 0, 260, 260);
            for (let i = 0; i < n; i++) {
              const g = 0.8 + gust[i];
              a[i] = g * a[i] + 0.3 * g * g * ra[i]; b[i] = g * b[i] + 0.3 * g * g * rb[i];
            }
            add(a, b, 0.5);
          }
          // The surf, far off: a low roar toward the middle, swelling twice a
          // loop, the second wave smaller and later than half way.
          {
            const wave = (x) => { const s = 0.5 - 0.5 * Math.cos(TAU * (x + 0.08 * Math.sin(TAU * x))); return s * s; };
            add(shape(white(), 70, 0, 150, 150), shape(white(), 70, 0, 150, 150), 0.45, 0.26,
              slow((t) => 0.35 + 0.45 * wave(t) + 0.25 * wave((t + 0.43) % 1)));
          }

          // No DC, and one fixed peak: the voice's gain sets the loudness.
          let peak = 0;
          for (const x of [L, R]) {
            let m = 0;
            for (let i = 0; i < n; i++) m += x[i];
            m /= n;
            for (let i = 0; i < n; i++) { x[i] -= m; peak = Math.max(peak, Math.abs(x[i])); }
          }
          for (let i = 0, k = 0.9 / peak; i < n; i++) { L[i] *= k; R[i] *= k; }
          buf = ctx.createBuffer(2, n, sr);
          buf.getChannelData(0).set(L);
          buf.getChannelData(1).set(R);
          this.loops.set(ctx, buf);
          return buf;
        },
        start(ctx, dest) {
          const src = ctx.createBufferSource();
          src.buffer = this.loop(ctx);
          src.loop = true;
          const out = ctx.createGain();
          out.gain.value = 0.0001;
          src.connect(out); out.connect(dest);
          src.start(ctx.currentTime);
          return {
            set(level) {
              // Under the engines and the song, at the level of the tyre beds.
              const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.045 * l, at, 0.08);
            },
            stop() {
              const at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001, at, 0.08);
              try { src.stop(at + 0.5); } catch (_) { /* already stopped */ }
            }
          };
        }
      },
    ]
  },
  {
    id: 'banana_drop',
    label: 'Banana drop',
    desc: 'A banana lands on the track behind the dropper.',
    variants: [
      {
        id: 'plop', label: 'A · plop',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter();
          tone(ctx, dest, t, { f: 320 * j, to: 130 * j, dur: 0.09, type: 'sine', vol: 0.3, a: 0.005 });
          noise(ctx, dest, t + 0.05, { dur: 0.05, f: 350, Q: 1, vol: 0.12 });
          return 0.25;
        }
      },
    ]
  },
  {
    id: 'banana_slip',
    label: 'Banana slip',
    desc: 'The comedy centrepiece — somebody hit a banana and is spinning out. (Round 2 — all of round 1 was vetoed.)',
    variants: [
      {
        id: 'dizzy', label: 'A · dizzy wah-wah',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.5);
          tremTone(ctx, dest, t, { f: 650 * j, to: 170 * j, dur: 0.7, type: 'sine', vol: 0.27, tremHz: 7.5, depth: 0.9 });
          tone(ctx, dest, t + 0.68, { f: 120 * j, dur: 0.1, type: 'sine', vol: 0.22, a: 0.005 });
          return 0.9;
        }
      }
    ]
  },
  {
    id: 'monster_inflate',
    label: 'Monster inflate',
    desc: 'A car pumps/powers up into a monster truck (pairs with the on-screen grow-in). Five physical takes — pick one. All non-musical: air, hydraulics, turbo, no stings.',
    variants: [
      {
        id: 'pump', label: 'A · air pump-up',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.4);
          noise(ctx, dest, t, { dur: 0.30, f: 280, fTo: 1500, Q: 0.8, vol: 0.16, a: 0.02, type: 'bandpass' }); // air rushing in
          tone(ctx, dest, t, { f: 150 * j, to: 470 * j, dur: 0.30, type: 'triangle', vol: 0.16, a: 0.02 });      // pressure rising
          tone(ctx, dest, t + 0.30, { f: 90, dur: 0.10, type: 'sine', vol: 0.22, a: 0.004 });                    // locked-in thump
          return 0.42;
        }
      },
      {
        id: 'hydraulic', label: 'B · hydraulic lift',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.3);
          tone(ctx, dest, t, { f: 70 * j, to: 185 * j, dur: 0.34, type: 'sawtooth', vol: 0.12, a: 0.03 }); // motor groan rising
          noise(ctx, dest, t, { dur: 0.34, f: 200, fTo: 620, Q: 1.2, vol: 0.08, a: 0.03, type: 'lowpass' });
          knock(ctx, dest, t + 0.34, 150, 0.3); // jacks up, settles
          return 0.46;
        }
      },
      {
        id: 'turbo', label: 'C · turbo spool',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.3);
          // ~0.34s total to match the grow-in animation (MONSTER_POP_TIME)
          tone(ctx, dest, t, { f: 320 * j, to: 1300 * j, dur: 0.31, type: 'triangle', vol: 0.12, a: 0.03 });  // rising whine
          noise(ctx, dest, t, { dur: 0.31, f: 500, fTo: 2600, Q: 0.7, vol: 0.13, a: 0.03, type: 'bandpass' }); // whoosh under it
          return 0.34;
        }
      },
      {
        id: 'airblast', label: 'D · air-blast lock',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.4);
          noise(ctx, dest, t, { dur: 0.16, f: 2200, fTo: 700, Q: 0.9, vol: 0.18, a: 0.004, type: 'bandpass' }); // pressurised inject
          tone(ctx, dest, t, { f: 200 * j, to: 520 * j, dur: 0.14, type: 'triangle', vol: 0.12, a: 0.004 });
          tone(ctx, dest, t + 0.16, { f: 110, dur: 0.12, type: 'sine', vol: 0.24, a: 0.003 });                  // slams into place
          noise(ctx, dest, t + 0.16, { dur: 0.05, f: 240, Q: 1.5, vol: 0.12, a: 0.002, type: 'lowpass' });
          return 0.34;
        }
      },
      {
        id: 'riser', label: 'E · power-up surge',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.3);
          noise(ctx, dest, t, { dur: 0.40, f: 120, fTo: 900, Q: 0.6, vol: 0.16, a: 0.10, type: 'lowpass' }); // broad rumble swelling
          tone(ctx, dest, t, { f: 80 * j, to: 240 * j, dur: 0.40, type: 'triangle', vol: 0.12, a: 0.10 });
          tone(ctx, dest, t + 0.40, { f: 100, dur: 0.10, type: 'sine', vol: 0.18, a: 0.004 });                // soft cap
          return 0.52;
        }
      }
    ]
  },
  {
    id: 'monster_deflate',
    label: 'Monster deflate',
    desc: 'The monster powers down + deflates back to a car (pairs with the shrink). Five physical takes — pick one. All non-musical: air release, hydraulics, wind-down.',
    variants: [
      {
        id: 'hiss', label: 'A · air sputter-down',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.4);
          // ~0.34s total to match the shrink-out animation (MONSTER_POP_TIME)
          tremTone(ctx, dest, t, { f: 430 * j, to: 120 * j, dur: 0.32, type: 'triangle', vol: 0.18, tremHz: 22, depth: 0.7 }); // sputtering descent
          noise(ctx, dest, t, { dur: 0.33, f: 1300, fTo: 280, Q: 0.8, vol: 0.13, a: 0.01, type: 'bandpass' });                  // air hissing out
          return 0.34;
        }
      },
      {
        id: 'release', label: 'B · pneumatic release',
        play(ctx, dest, t = ctx.currentTime) {
          noise(ctx, dest, t, { dur: 0.34, f: 3000, fTo: 600, Q: 0.6, vol: 0.18, a: 0.004, type: 'highpass' }); // sharp air dump
          tone(ctx, dest, t, { f: 300, to: 90, dur: 0.30, type: 'triangle', vol: 0.08, a: 0.01 });
          return 0.36;
        }
      },
      {
        id: 'hydraulicdown', label: 'C · hydraulic lower',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.3);
          tone(ctx, dest, t, { f: 170 * j, to: 60 * j, dur: 0.34, type: 'sawtooth', vol: 0.12, a: 0.02 }); // motor lowering
          noise(ctx, dest, t, { dur: 0.34, f: 500, fTo: 160, Q: 1.0, vol: 0.08, a: 0.02, type: 'lowpass' });
          knock(ctx, dest, t + 0.32, 120, 0.26); // sets down
          return 0.44;
        }
      },
      {
        id: 'raspberry', label: 'D · deflating raspberry',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.4);
          tremTone(ctx, dest, t, { f: 240 * j, to: 70 * j, dur: 0.36, type: 'sawtooth', vol: 0.16, tremHz: 14, depth: 0.9 }); // low flutter out
          return 0.38;
        }
      },
      {
        id: 'winddown', label: 'E · turbo wind-down',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.3);
          tone(ctx, dest, t, { f: 1200 * j, to: 200 * j, dur: 0.42, type: 'triangle', vol: 0.13, a: 0.02 });   // whine spinning down
          noise(ctx, dest, t, { dur: 0.42, f: 1800, fTo: 400, Q: 0.7, vol: 0.07, a: 0.02, type: 'bandpass' });
          return 0.44;
        }
      }
    ]
  },
  {
    id: 'lap',
    label: 'Lap complete',
    desc: 'A car crosses the line onto a new lap.',
    variants: [
      {
        id: 'plink2', label: 'A · two plinks up',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.5);
          pluck(ctx, dest, t, C5 * j, 0.26);
          pluck(ctx, dest, t + 0.1, G5 * j, 0.26);
          return 0.5;
        }
      },
    ]
  },
  {
    id: 'screech',
    label: 'Curb contact',
    desc: 'Riding the striped curb. Fires repeatedly while grinding — HOLD the button rhythm in your head: ~7×/s. (Round 2 — the noise-burst scrub was vetoed.)',
    variants: [
      {
        id: 'rumble', label: 'A · rumble strip',
        play(ctx, dest, t = ctx.currentTime) {
          // The curb IS a striped rumble strip — low rhythmic thuds, like a toy
          // car clattering over ridges, instead of any kind of screech.
          const j = jitter(0.5);
          for (let i = 0; i < 3; i++) {
            tone(ctx, dest, t + i * 0.045, { f: 130 * j, to: 95 * j, dur: 0.035, type: 'sine', vol: 0.24, a: 0.003 });
          }
          return 0.18;
        }
      },
    ]
  },
  {
    id: 'join',
    label: 'Player join (lobby)',
    desc: 'A phone joins the room while the lobby is up.',
    variants: [
      {
        id: 'risingtwo', label: 'A · two notes up',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.5);
          pluck(ctx, dest, t, C5 * j, 0.24);
          pluck(ctx, dest, t + 0.09, G5 * j, 0.24);
          return 0.45;
        }
      },
    ]
  },
  {
    id: 'engine_putt',
    label: 'Driving sound (engine)',
    desc: 'The shipping driving voice: a real recorded engine loop (CC0) looped and pitch-shifted by speed — higher and louder the faster you go, fading to silence at rest (the RPM=playbackRate trick every racer uses). Slider = speed. The synth experiments that lost this audition are gone; the recording is decoded by the host via loadSampleBuffers().',
    continuous: true,
    variants: [
      {
        id: 'realloop', label: 'recorded engine loop',
        start(ctx, dest) {
          // rate0/rateSpan: idle just under the recording's native pitch, climbing
          // to ~1.65× flat-out; the lowpass opens for "air" under load; gain swells
          // up from near-silent off the line. STARTING VALUES — tune by ear in
          // ?solo=1 (the clip is full-scale stereo, so the gains sit well below the
          // synth cues' levels). Gain halved (0.015/0.12 → 0.007/0.06) once the
          // background music joined the mix — the engine was burying it (Tim, 2026-06-14).
          return bakedLoopVoice(ctx, dest, (c) => sampleBuf(c, 'engine'),
            { rate0: 0.9, rateSpan: 0.75, lp0: 900, lpSpan: 5200, gain0: 0.007, gainSpan: 0.06, Q: 0.6 });
        }
      }
    ]
  },
  {
    id: 'rocket_fire',
    label: 'Rocket flight (jet)',
    desc: 'The rocket FLIGHT sound — a sustained airy jet loop held for the whole air time (starts at launch, stops on impact). CONTINUOUS: the host drives the level by distance to the nearest player (closer = louder).',
    continuous: true,
    variants: [
      {
        id: 'jet', label: 'airy jet loop',
        start(ctx, dest) {
          const src = ctx.createBufferSource(); src.buffer = noiseBuf(ctx); src.loop = true;
          const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 0.5;
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2800; lp.Q.value = 0.4;
          const out = ctx.createGain(); out.gain.value = 0.0001;
          src.connect(bp); bp.connect(lp); lp.connect(out); out.connect(dest);
          src.start(ctx.currentTime);
          return {
            set(level) { const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
              out.gain.setTargetAtTime(0.0001 + l * 0.8, at, 0.05);        // filtered noise → high gain (trimmed from 1.3, 2026-06-21: too loud)
              bp.frequency.setTargetAtTime(950 + l * 1500, at, 0.08); },   // brighter as it nears
            stop() { const at = ctx.currentTime; out.gain.setTargetAtTime(0.0001, at, 0.06); try { src.stop(at + 0.3); } catch (_) { /* stopped */ } }
          };
        }
      }
    ]
  },
  {
    id: 'land',
    label: 'Landing',
    desc: 'A car comes back down off a kicker or a hill. One-shot; the host scales it by how hard it came down and by distance to the nearest player.',
    variants: [
      {
        id: 'thud', label: 'A · thud',
        play(ctx, dest, t = ctx.currentTime) {
          const j = jitter(0.5);
          tone(ctx, dest, t, { f: 150 * j, to: 55 * j, dur: 0.12, type: 'sine', vol: 0.32, a: 0.003 });
          noise(ctx, dest, t, { dur: 0.06, f: 260, fTo: 120, Q: 0.8, vol: 0.16, a: 0.002, type: 'lowpass' });
          knock(ctx, dest, t + 0.012, 300 * j, 0.06);
          return 0.2;
        }
      }
    ]
  },
  {
    id: 'rocket_hit',
    label: 'Rocket hit',
    desc: 'A rocket detonates on a car — a real CC0 explosion recording (assets/audio/sfx). One-shot; the host scales its level by distance to the nearest player.',
    variants: [
      {
        id: 'punch', label: 'punchy explosion (CC0 sample)',
        play(ctx, dest, t = ctx.currentTime) { return playSample(ctx, dest, t, 'explosionPunch', 0.6); } // gain 0.6: the raw sample peak read too loud (2026-06-21)
      }
    ]
  }
];
