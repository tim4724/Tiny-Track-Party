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
const SAMPLE_URLS = { engine: '/assets/audio/engine_loop.ogg' };
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
    set(level) {
      const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
      src.playbackRate.setTargetAtTime(rate0 + l * rateSpan, at, 0.12); // RPM
      lp.frequency.setTargetAtTime(lp0 + l * lpSpan, at, 0.1);
      out.gain.setTargetAtTime(gain0 + l * gainSpan, at, 0.08);
    },
    stop() {
      const at = ctx.currentTime;
      out.gain.setTargetAtTime(0.0001, at, 0.1);
      try { src.stop(at + 0.5); } catch (_) { /* already stopped */ }
    }
  };
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
  banana_drop: 'plop',
  banana_slip: 'dizzy',
  lap: 'plink2',
  screech: 'rumble',
  join: 'risingtwo',
  engine_putt: 'realloop' // the recorded engine loop, pitch-shifted by speed (Tim, 2026-06-13)
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
  }
];
