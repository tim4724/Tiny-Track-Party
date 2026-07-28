#!/usr/bin/env node
// Bake the race cue palette to samples.
//
// WHY: the game is becoming a shared-C++ engine with three shells (web, Apple
// TV, Android TV), and audio DECISIONS move to C++ with everything else. The
// audio DSP must not: public/display/audio/cues.js is ~695 lines of hand-built
// WebAudio graphs (oscillators, biquads, LFOs, envelopes) whose mix took five
// audition rounds and nine rejected engine variants to settle. Re-synthesising
// that in miniaudio would mean re-deriving every filter coefficient and every
// setTargetAtTime glide, and then re-tuning taste that is explicitly closed.
// So instead: render each cue offline through the EXISTING, APPROVED synthesis
// and ship the result. Every platform plays the same PCM. Identical by
// construction.
//
// TWO THINGS THIS SCRIPT EXISTS TO GET RIGHT:
//
//   1. IT RENDERS IN A REAL BROWSER. Playwright drives headless Chromium, which
//      imports the shipping cues.js off the dev server and renders through
//      OfflineAudioContext. A Node WebAudio polyfill would be a DIFFERENT DSP
//      implementation — different biquad coefficients, different envelope curve
//      shapes, different noise — which silently swaps the engine and destroys
//      the only property that justifies baking at all.
//
//   2. IT PRESERVES THE ANTI-FATIGUE JITTER. cues.js gives every frequent cue a
//      ±spread-semitone random detune so spamming it does not fatigue (curb
//      scrub fires up to ~7×/s). Baked naively that becomes one frozen sample
//      and the variation is gone. jitter() only ever multiplies oscillator
//      FREQUENCIES — every time argument in tone()/noise()/tremTone() is a
//      literal — so the detune is dimensionally a sample player's playbackRate.
//      The bake therefore forces jitter to exactly 1.0 (Math.random === 0.5 ⇒
//      exponent 0) and the manifest carries the spread per cue for the player to
//      re-apply as a random rate. `--verify-jitter` proves the premise rather
//      than assuming it: it re-renders at both jitter extremes and asserts the
//      rendered length does not move.
//
// One thing it CANNOT get right, and does not pretend to: a bit-identical
// re-bake. See RECHECK_MAX_LSB below — Chromium's fan-in summation order is not
// stable, so a re-render lands within one 16-bit LSB rather than on the byte.
//
// WHAT KEEPS THIS FILE HONEST ABOUT cues.js: nothing load-bearing is copied out
// of it. The sustained voices' output gain is DIVIDED OUT of the committed PCM,
// so a hand-copied `0.14 * l` that fell behind a retune would make every
// committed WAV wrong by that factor with nothing red. scripts/lib/cue-source.mjs
// therefore READS the gain expression (and its tau) out of the picked variant,
// cross-checks the filter stops in the table below against the sweeps cues.js
// actually schedules, and hashes what cannot be derived — the shared DSP prelude
// and each picked variant block — into the manifest, the same way BUILD_STAMP.json
// pins the wasm to its sources. tests/bake-cues.test.js recomputes those hashes.
//
// Usage:
//   npm run bake:cues                  # render + write WAVs and manifest.json
//   npm run bake:cues -- --check       # re-render and diff against what's committed
//   npm run bake:cues -- --verify-jitter
//   npm run bake:cues -- --crossfade-audit   # how wrong the level stops are
//   npm run bake:cues -- --check --port 4177 --headed --only pickup,roulette
//
// Output: public/assets/audio/cues/<name>.wav + manifest.json.
// This script does NOT wire anything up — Audio.js still synthesises live. The
// baked palette is judged by ear first.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import {
  LEVEL_PROBES, evalLevelExpr, rolledJitter, sourceHashes, variantBlock, voiceSet,
} from './lib/cue-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'scripts', 'lib', 'bake-harness.js');
const CUES_JS = path.join(ROOT, 'public', 'display', 'audio', 'cues.js');
const OUT_DIR = path.join(ROOT, 'public', 'assets', 'audio', 'cues');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

const SR = 48000;
// v2 added `source` (the cues.js fingerprints) and made every playback gain
// formula a verbatim quote of cues.js rather than a transcription.
const MANIFEST_VERSION = 2;

// One int32 pins every noise burst and every noise bed in the palette: the
// per-context white-noise buffer cues.js caches is filled from mulberry32(SEED)
// instead of Math.random, so a re-bake reproduces the same noise. Changing it
// re-rolls the noise in every cue that uses any. (It is not the whole story for
// reproducibility — see RECHECK_MAX_LSB — but it is the part this script owns.)
const NOISE_SEED = 0x54545031; // 'TTP1'

// Trailing-silence trim threshold: one 16-bit LSB. Anything quieter than this
// quantises to zero in the file anyway, so the trim removes only samples the
// format cannot represent — the full release tail survives by construction.
// (In practice this lands on the graph's node-stop point, because the cue
// envelopes bottom out at 0.0001 ≈ -80 dBFS ≈ 3 LSB and hold there until the
// oscillator stops.)
const TRIM_FLOOR = 1 / 32767;
// …and where the cut actually lands: the first point at which the graph has
// gone quiet, 60 dB BELOW that LSB. Not exact zero — a biquad's ringdown decays
// into denormals, whose flush-to-zero behaviour is a CPU flag rather than
// IEEE-754 arithmetic, and a bake must not depend on one.
const SILENCE_EPS = 1e-9;

const ONESHOT_SECONDS = 4;   // render window; every one-shot is trimmed back out of it
const VOICE_SECONDS = 3;     // render window for sustained voices…
const VOICE_KEEP_SECONDS = 1; // …of which the LAST second is kept as the loop

// ── the palette ───────────────────────────────────────────────────────────────

// One-shots. `spread` is the jitter() spread the cue passes in cues.js and is
// what the player must re-apply as a playbackRate multiplier of
// 2^(±spread/12); it is asserted against the source below, not trusted.
const ONESHOTS = [
  { name: 'countdown_tick', cue: 'countdown', method: 'tick', spread: 0.3,
    note: 'the 3/2/1 beat. RaceSession fires onCountdownTick at 1 Hz and the 1 s spacing belongs to the sim, so the beats are baked separately and the sequence is not baked at all.' },
  { name: 'countdown_go', cue: 'countdown', method: 'go', spread: 0.3,
    note: 'the launch beat (n === 0). One j is shared by both plucks in the synth, which one playbackRate reproduces exactly.' },
  { name: 'pickup', cue: 'pickup', method: 'play', spread: 1,
    note: 'MUST stay separate from roulette: Audio.pickup() fires both for the local player but pickupPop() fires this one alone for every CPU/finished-car grab.' },
  { name: 'roulette', cue: 'roulette', method: 'play', spread: 0.5,
    note: 'baked WHOLE, not per knock: the race fires it as one atomic play() and its 0.88 s reveal pop is locked to the renderer\'s ~0.86 s chip spin.' },
  { name: 'banana_drop', cue: 'banana_drop', method: 'play', spread: 1 },
  { name: 'banana_slip', cue: 'banana_slip', method: 'play', spread: 0.5,
    note: 'also the oil-spin cue (Audio.spin) — cannot be specialised.' },
  { name: 'monster_inflate', cue: 'monster_inflate', method: 'play', spread: 0.3 },
  { name: 'monster_deflate', cue: 'monster_deflate', method: 'play', spread: 0.4 },
  { name: 'lap', cue: 'lap', method: 'play', spread: 0.5,
    note: 'also the finish chime (case \'lap\': case \'finish\') — cannot be specialised.' },
  { name: 'screech', cue: 'screech', method: 'play', spread: 0.5,
    note: 'the most repetition-exposed cue in the game (~7×/s under SCREECH_GAP_MS) and the strongest argument for keeping playback-rate jitter.' },
  { name: 'join', cue: 'join', method: 'play', spread: 0.5 },
  { name: 'rocket_hit', cue: 'rocket_hit', method: 'play', spread: 0, channels: 2,
    needsSamples: ['explosionPunch'], sampleRate: 44100,
    note: 'the shipped CC0 explosion, baked WITH playSample\'s 4 ms/60 ms de-click envelope and gain 0.6 so no shell has to reimplement them. Stereo, at the recording\'s own 44.1 kHz — resampling a shipped recording to 48 k would change it for no gain.' },
];

// Sustained voices. Each is a 1.000 s loop — the cached noise source is exactly
// ctx.sampleRate frames, so a 1 s loop reproduces the runtime's own seam, and
// both LFOs in the set are integer Hz (corner 6, brake 11) so the window closes
// at LFO phase 0.
//
// The output gain is NOT baked in: each stop is divided by the voice's analytic
// gain at its level, so the file is the unit-gain TIMBRE and the player applies
// the gain formula continuously. That decouples loudness (exact at any level)
// from spectrum (interpolated between stops), which is why so few stops are
// needed.
//
// NOTHING HERE RESTATES A NUMBER cues.js OWNS. The gain expression, its tau and
// the filter sweeps are read out of the picked variant by auditCueSource(); the
// `param` entries below are the DESCRIPTION of what each stop samples (including
// the static values a sweep parse cannot see, like Q and the gate LFO) and every
// level-varying one of them is checked against the sweep cues.js schedules.
const VOICES = {
  brake: {
    variant: 'rubber',
    levels: [1],
    levelInvariant: true,
    param: () => ({ bandpassHz: 950, Q: 3, gateLfoHz: 11, gateRange: [0.1, 1] }),
    note: 'ONE file. Nothing but the output gain moves with level — the 950 Hz Q3 bandpass and the 11 Hz gate LFO are static — so a single unit-gain loop plus the (divided-out) gain is exact, not an approximation.',
  },
  boost: {
    variant: 'smooth',
    // The lowpass sweeps 420→900 Hz, 1.1 octaves, with Q 1 — a full octave of
    // -3 dB skirt, so a blend of two neighbouring stops lands on a curve barely
    // distinguishable from the true one. Five stops measure 4.0% worst-case
    // blend error (`--crossfade-audit`). Level 0.02 is the floor at which
    // Audio._stateVoice creates the voice at all, so nothing below it is baked.
    levels: [0.02, 0.25, 0.5, 0.75, 1],
    param: (l) => ({ lowpassHz: round1(420 + l * 480), Q: 1 }),
    note: 'brightness IS the surge, so the filter needs stops; gain does not (it is exactly linear and is divided out).',
  },
  corner: {
    variant: 'squeal',
    // FIVE stops, and the reason is Q, not the sweep width. The bandpass centre
    // moves only 1200→1550 Hz (0.37 octave), which argued for three — but this
    // is the one NARROW filter in the palette (Q 5, ~275 Hz of -3 dB bandwidth),
    // so 175 Hz stop spacing straddles the resonance: a 50/50 blend of two stops
    // is two peaks either side of where the true peak sits, not a peak. Measured
    // (`--crossfade-audit`), three stops were 20.4% worst-case blend error
    // against the true synth — five times boost's, whose sweep is twice as wide.
    // Halving the spacing to 87.5 Hz brings it to 6.2% for two more 96 KB files.
    // The 6 Hz LFO completes exactly 6 cycles in the kept second, so every stop
    // is phase-aligned at the seam and stops crossfade sample-aligned.
    levels: [0.02, 0.25, 0.5, 0.75, 1],
    param: (l) => ({ bandpassHz: round1(1200 + l * 350), Q: 5, lfoHz: 6, lfoDepthHz: 70 }),
    note: 'level is steer² × speed gate, so it is heavily biased low; a spinning car is forced silent by the caller.',
  },
  rocket_fire: {
    variant: 'jet',
    // level here is the DISTANCE curve, capped at AUD_PEAK = 0.7, so the race
    // only ever spans (0.02, 0.7]. Four stops cover that (bandpass 980→2000 Hz,
    // ~1.03 octave); l = 1 is baked as a fifth so a player never extrapolates,
    // but it is reachable only from the gallery slider.
    levels: [0.02, 0.25, 0.5, 0.7, 1],
    raceMax: 0.7,
    param: (l) => ({ bandpassHz: round1(950 + l * 1500), Q: 0.5, lowpassHz: 2800, lowpassQ: 0.4 }),
    note: 'no LFO, so crossfading stops is unconstrained by phase.',
  },
};

// Pass-through: already a sample, and deliberately NOT re-emitted as a WAV.
//
// Two reasons, one per voice. There is nothing to bake — no synthesis, no
// envelope — so a WAV would be a transcode, not a bake. And a transcode here
// would be actively wrong: Chromium's decodeAudioData returns 131264 frames for
// engine_loop.ogg where the file holds 130799 (measured against ffmpeg; the
// extra 465 frames align at offset 0, so they are untrimmed Vorbis padding on
// the TAIL, at ~1/5 the level of the real ending). The web build loops that
// today and lives with a 10.5 ms junk seam; baking it would export a browser
// decoder artefact to tvOS and Android. The .ogg is the artefact; each shell
// decodes it with its own decoder and gets the file's true PCM.
const PASSTHROUGH = [
  { cue: 'engine_putt', source: 'public/assets/audio/engine_loop.ogg', loop: true,
    liveDsp: 'lowpass, 2nd order, Q 0.6, cutoff (900 + 5200*l) * lpMul, tau 0.10 s; '
      + 'playbackRate (0.9 + 0.75*l) * rateMul, tau 0.12 s; gain (0.007 + 0.06*l) * gainMul, tau 0.08 s. '
      + 'monster mod = { rateMul 0.6, gainMul 1.45, lpMul 0.82 }.',
    note: 'ship the .ogg as-is. The live LOWPASS stays live and is NOT baked to stops: playbackRate is the RPM here and shifts the filtered spectrum with it, so a stop baked at one cutoff would be wrong at every rate but one. One biquad per voice is the cheaper and more faithful call.' },
];

// ── small helpers ─────────────────────────────────────────────────────────────

const round1 = (x) => Math.round(x * 10) / 10;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

function parseArgs(argv) {
  const out = { port: 4177 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--verify-jitter') out.verifyJitter = true;
    else if (a === '--crossfade-audit') out.crossfadeAudit = true;
    else if (a === '--headed') out.headed = true;
    else if (a === '--port') out.port = parseInt(argv[++i], 10);
    else if (a === '--only') out.only = new Set(argv[++i].split(',').map((s) => s.trim()));
    else if (a.startsWith('--')) throw new Error('unknown flag ' + a);
  }
  return out;
}

function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`server never came up on :${port}`));
        else setTimeout(ping, 150);
      });
    })();
  });
}

// base64 → Float32Array (copied into a fresh, aligned ArrayBuffer).
function toFloats(b64) {
  const bytes = Buffer.from(b64, 'base64');
  const ab = new ArrayBuffer(bytes.length);
  Buffer.from(ab).set(bytes);
  return new Float32Array(ab);
}

function interleave(channels) {
  const n = channels[0].length, c = channels.length;
  if (c === 1) return channels[0];
  const out = new Float32Array(n * c);
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) out[i * c + k] = channels[k][i];
  return out;
}

function quantize(floats) {
  const out = new Int16Array(floats.length);
  let clipped = 0;
  for (let i = 0; i < floats.length; i++) {
    let v = Math.round(floats[i] * 32767);
    if (v > 32767) { v = 32767; clipped++; } else if (v < -32768) { v = -32768; clipped++; }
    out[i] = v;
  }
  return { pcm: out, clipped };
}

// Every metric is measured on the QUANTISED samples, so the test can recompute
// them from the committed file and land on the same numbers exactly.
function metrics(pcm, channels, sampleRate) {
  let peak = 0, sumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
    sumSq += pcm[i] * pcm[i];
  }
  const frames = pcm.length / channels;
  // The audible body: last frame holding anything within 60 dB of the peak.
  const floor = peak * 1e-3;
  let body = 0;
  for (let f = frames - 1; f >= 0; f--) {
    let m = 0;
    for (let k = 0; k < channels; k++) m = Math.max(m, Math.abs(pcm[f * channels + k]));
    if (m > floor) { body = f + 1; break; }
  }
  return {
    frames,
    durationSec: r6(frames / sampleRate),
    body60Sec: r6(body / sampleRate),
    peak: r6(peak / 32767),
    rms: r6(Math.sqrt(sumSq / pcm.length) / 32767),
  };
}

function trimTail(floats, channels) {
  const frames = floats.length / channels;
  const mag = (f) => {
    let m = 0;
    for (let k = 0; k < channels; k++) m = Math.max(m, Math.abs(floats[f * channels + k]));
    return m;
  };
  let last = -1;
  for (let f = frames - 1; f >= 0; f--) if (mag(f) >= TRIM_FLOOR) { last = f; break; }
  if (last < 0) throw new Error('rendered nothing but silence');

  // Then run on to the end of the waveform that is still ringing. The cut must
  // not land INSIDE a half-cycle: down at the -80 dBFS floor the cue envelopes
  // settle at, individual samples dip under one LSB purely by phase, so a
  // threshold alone makes the trimmed length depend on the tone's FREQUENCY —
  // which is precisely what jitter moves (it cost screech a millisecond between
  // jitter extremes, and a length that moves with jitter would have falsified
  // the premise this whole bake rests on). Sixteen consecutive digitally silent
  // frames mean the graph's nodes have stopped, and that is the honest end.
  let end = last;
  for (let f = last + 1; f < frames; f++) {
    if (mag(f) > SILENCE_EPS) end = f;
    else if (f - end >= 16) break;
  }
  if (end >= frames - 1) throw new Error('render window too short — the cue is still sounding at the end');
  return floats.subarray(0, (end + 1) * channels);
}

function wav(pcm, channels, sampleRate) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);                              // PCM
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * channels * 2, 28);       // byte rate
  head.writeUInt16LE(channels * 2, 32);                    // block align
  head.writeUInt16LE(16, 34);                              // bits
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return { file: Buffer.concat([head, data]), pcmBytes: data };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// How close a RE-BAKE has to land to count as the same bake.
//
// Not zero, and the reason is the host rather than this script. Chromium sums a
// node's fan-in connections in HashSet order, which is pointer-hash order, which
// is heap-address order — so a cue whose graph merges several branches into one
// destination (lap, join, countdown, screech, roulette; anything with two
// overlapping plucks or a row of thuds) renders with a different float addition
// ORDER each time. Float addition is not associative, so the result moves by one
// float32 ULP: 2.98e-8 at a peak of 0.33, i.e. about -150 dBFS, on roughly 2% of
// samples. That is 60 dB below a 16-bit LSB and vanishes in quantisation — EXCEPT
// for the occasional sample sitting within 1e-3 LSB of a .5 rounding boundary,
// which flips by one. In practice that is ~1 sample across the whole palette per
// re-bake, and no rounding rule can remove it: the tie is a property of a noisy
// real, not of the tie-break.
//
// Worth being blunt about what this does and does not mean. It is NOT a
// weakness of baking: the LIVE game has exactly the same instability, because
// the same summation runs on the same graph every time a cue fires. It does mean
// "byte-identical" is the wrong claim for a re-bake, so the bar here is one LSB
// on a handful of samples. tests/bake-cues.test.js is still an EXACT hash gate —
// the committed WAVs and the committed manifest must agree bit for bit.
const RECHECK_MAX_LSB = 1;
const RECHECK_MAX_FRACTION = 1e-3;   // at most 0.1% of samples may differ at all

// ── source cross-check ────────────────────────────────────────────────────────

// Everything the bake needs to know about cues.js, derived from the file rather
// than restated here:
//
//   • the per-cue jitter spread a player will re-apply as a playbackRate (a
//     wrong number silently widens or narrows a shipped cue's detune, and unlike
//     the PCM nothing downstream would notice);
//   • each sustained voice's output gain — the number DIVIDED OUT of the
//     committed PCM, so a stale copy corrupts every one of that voice's WAVs by
//     exactly that factor;
//   • the filter sweeps the level stops exist to sample, cross-checked against
//     the `param` descriptions above;
//   • sha256 of the shared DSP prelude and of every picked variant block, for
//     the manifest — the part no parse can derive.
async function auditCueSource() {
  const { DEFAULT_PICKS } = await import(pathToFileURL(CUES_JS).href);
  const src = fs.readFileSync(CUES_JS, 'utf8');
  const blockOf = (cue, variant) => {
    const b = variantBlock(src, cue, variant);
    if (b === null) throw new Error(`cues.js: no cue '${cue}' with variant '${variant}'`);
    return b;
  };

  // Top-level helper bodies (tone/noise/pluck/knock/pop/tremTone), so a call to a
  // wrapper can be charged with the wrapper's own hard-coded frequencies.
  const helperBody = (name) => {
    const i = src.indexOf(`\nfunction ${name}(`);
    if (i < 0) return '';
    const j = src.indexOf('\n}', i + 1);            // the helper's own closing brace, column 0
    return src.slice(i, j < 0 ? src.length : j);
  };
  // Every noise() option object in a block, reporting the f/fTo values that are
  // NUMBER LITERALS — i.e. frequencies the synth never detunes. `f: f * 3` (the
  // mallet tick in pluck) is derived from the already-jittered tone and is fine.
  const literalNoise = (block) => {
    const out = [];
    for (const call of block.matchAll(/\bnoise\([^{]*\{([^}]*)\}/g)) {
      for (const key of ['f', 'fTo']) {
        const kv = call[1].match(new RegExp(`\\b${key}:\\s*([^,}]+)`));
        if (kv && /^[\d.]+$/.test(kv[1].trim())) out.push(`${key} ${kv[1].trim()} Hz`);
      }
    }
    return out;
  };
  const wrapperNoise = Object.fromEntries(
    ['pluck', 'knock', 'pop', 'tone', 'tremTone'].map((h) => [h, literalNoise(helperBody(h))]));

  const bad = [];
  const hazards = {};
  for (const job of ONESHOTS) {
    const pick = DEFAULT_PICKS[job.cue];
    const vBlock = blockOf(job.cue, pick);

    const found = rolledJitter(vBlock);
    const want = job.spread ? [job.spread] : [];
    if (JSON.stringify(found) !== JSON.stringify(want)) {
      bad.push(`${job.cue}/${pick}: cues.js calls jitter with [${found}], the bake table says [${want}]`);
    }
    if (!job.spread) continue;

    // Narrow to the METHOD actually being baked. countdown's variant also carries
    // play(), which composes the beats a whole second apart for the gallery demo —
    // charging tick() with play()'s `t + 3` would invent a 52 ms hazard in a beat
    // the race schedules itself.
    const methods = [...vBlock.matchAll(/\n {8}(\w+)\(ctx, dest/g)];
    const mi = methods.findIndex((x) => x[1] === job.method);
    if (mi < 0) { bad.push(`${job.cue}/${pick}: no ${job.method}() to bake`); continue; }
    const block = vBlock.slice(methods[mi].index,
      mi + 1 < methods.length ? methods[mi + 1].index : vBlock.length);

    // What re-applying the detune as a playbackRate will move that the SYNTH
    // holds still. Rate-shifting a baked mix shifts everything in it; the synth
    // only ever shifted oscillator frequencies. Derived, not asserted, so an
    // edit to cues.js shows up here instead of rotting in a comment.
    const noiseHz = [...literalNoise(block)];
    for (const [h, hits] of Object.entries(wrapperNoise)) {
      if (hits.length && new RegExp(`\\b${h}\\(`).test(block)) noiseHz.push(...hits.map((x) => `${h}() ${x}`));
    }
    const lfoHz = [...block.matchAll(/\btremHz:\s*([\d.]+)/g)].map((c) => parseFloat(c[1]));
    const offsets = [...new Set([...block.matchAll(/\bt \+ ([\d.]+)/g)].map((c) => parseFloat(c[1])))].sort((a, b) => a - b);
    // A loop or a running accumulator schedules beats the literal scan cannot
    // enumerate (roulette's decelerating knock ramp, screech's three thuds) — the
    // whole internal rhythm rate-shifts, so say so rather than under-report.
    const computedRhythm = /\bt \+ (?!\d)/.test(block);
    const drift = (v) => [r6((2 ** (-job.spread / 12) - 1) * v), r6((2 ** (job.spread / 12) - 1) * v)];
    hazards[job.name] = {
      clean: !noiseHz.length && !lfoHz.length,
      unjitteredNoise: noiseHz,
      unjitteredLfoHz: lfoHz.map((hz) => ({ hz, atRateExtremes: drift(hz).map((d) => r6(hz + d)) })),
      unjitteredOffsetsSec: offsets.map((s) => ({ sec: s, driftMs: drift(s * 1000) })),
      computedRhythm,
    };
  }

  // The sustained voices. Everything here is READ, not checked against a copy:
  // the gain expression and its tau become the manifest's playback contract and
  // the divisor the timbre files are normalised by.
  const voices = {};
  for (const [cue, spec] of Object.entries(VOICES)) {
    const vBlock = blockOf(cue, spec.variant);
    const set = voiceSet(vBlock, `${cue}/${spec.variant}`);
    voices[cue] = { ...set, gain: (l) => evalLevelExpr(set.gainExpr, l) };
    if (rolledJitter(vBlock).length) bad.push(`${cue}/${spec.variant}: a sustained voice must not jitter`);

    // Cross-check the stop DESCRIPTIONS both ways. A `param` key that moves with
    // level and matches no sweep cues.js schedules is a fiction; a sweep with no
    // key describing it is a stop table that has stopped covering the voice.
    // Numbers only: a stop can also describe a static range (brake's gate swing
    // is the array [0.1, 1]), and an array is never a swept frequency.
    const keys = Object.keys(spec.param(0)).filter((k) =>
      typeof spec.param(0)[k] === 'number' && spec.param(0)[k] !== spec.param(1)[k]);
    const matches = (expr, key) =>
      LEVEL_PROBES.every((l) => round1(evalLevelExpr(expr, l)) === spec.param(l)[key]);
    for (const k of keys) {
      if (!set.freqs.some((f) => matches(f.expr, k))) {
        bad.push(`${cue}: the bake table sweeps ${k}, cues.js schedules `
          + (set.freqs.map((f) => `${f.node} → ${f.expr}`).join(', ') || 'no level-driven filter at all'));
      }
    }
    for (const f of set.freqs) {
      if (!keys.some((k) => matches(f.expr, k))) {
        bad.push(`${cue}: cues.js sweeps ${f.node}.frequency to ${f.expr}, and no stop parameter describes it`);
      }
    }
  }

  if (bad.length) throw new Error('the bake table has drifted from cues.js:\n  ' + bad.join('\n  '));

  // …and the fingerprint of everything above that a parse cannot see: the shared
  // DSP the variants call, and each picked variant verbatim.
  const baked = [...ONESHOTS.map((j) => j.cue), ...Object.keys(VOICES), ...PASSTHROUGH.map((p) => p.cue)];
  const hashes = sourceHashes(src, DEFAULT_PICKS, new Set(baked));

  return { hazards, voices, hashes };
}

// ── the bake ──────────────────────────────────────────────────────────────────

// One sustained voice at one level, rendered and normalised to the unit-gain
// timbre: the last VOICE_KEEP_SECONDS of the render, divided by the analytic
// gain cues.js applies at that level. Everything about the voices — the bake,
// the crossfade audit — goes through this, so there is one definition of what a
// "stop" is.
async function timbre(page, cue, level, gain) {
  const res = await page.evaluate((j) => window.__bakeRender(j), {
    method: 'voice', cue, level, channels: 1, frames: VOICE_SECONDS * SR, seed: NOISE_SEED,
  });
  // Keep the LAST second: by then both the gain and the filter targets have
  // settled (tau ≤ 0.08 s, so 2 s ≈ 25 time constants), the loop point is a
  // whole noise-buffer period, and the LFOs are back at phase 0.
  const all = toFloats(res.channels[0]);
  const keep = all.subarray((VOICE_SECONDS - VOICE_KEEP_SECONDS) * SR, VOICE_SECONDS * SR);
  const g = gain(level);
  const out = new Float32Array(keep.length);
  for (let i = 0; i < keep.length; i++) out[i] = keep[i] / g;
  return out;
}

async function bake(page, args, voices) {
  const wanted = (name) => !args.only || args.only.has(name);
  const rendered = [];   // { name, cue, kind, floats, channels, meta }

  for (const job of ONESHOTS) {
    if (!wanted(job.name)) continue;
    const channels = job.channels || 1;
    const sampleRate = job.sampleRate || SR;
    const res = await page.evaluate((j) => window.__bakeRender(j), {
      method: job.method, cue: job.cue, channels, sampleRate,
      frames: ONESHOT_SECONDS * sampleRate, seed: NOISE_SEED, needsSamples: job.needsSamples || null,
    });
    const floats = trimTail(interleave(res.channels.map(toFloats)), channels);
    rendered.push({ ...job, kind: 'one-shot', channels, sampleRate, floats });
  }

  for (const [cue, spec] of Object.entries(VOICES)) {
    const stops = [];
    for (const level of spec.levels) {
      const name = spec.levels.length === 1 ? cue : `${cue}-l${String(Math.round(level * 100)).padStart(3, '0')}`;
      if (!wanted(name)) continue;
      const floats = await timbre(page, cue, level, voices[cue].gain);
      stops.push({ name, cue, level, floats, channels: 1, sampleRate: SR });
    }
    if (!stops.length) continue;
    // One headroom scalar for the whole cue (same for every stop, so crossfades
    // stay level-consistent), only if unit gain would clip 16-bit.
    let peak = 0;
    for (const s of stops) for (let i = 0; i < s.floats.length; i++) peak = Math.max(peak, Math.abs(s.floats[i]));
    const headroom = peak > 0.95 ? Math.ceil((peak / 0.95) * 1000) / 1000 : 1;
    for (const s of stops) {
      if (headroom !== 1) for (let i = 0; i < s.floats.length; i++) s.floats[i] /= headroom;
      rendered.push({ ...s, kind: 'sustained', spec, headroom, loop: true });
    }
  }

  return rendered;
}

// ── verification passes ───────────────────────────────────────────────────────

// HOW WRONG ARE THE LEVEL STOPS? A sustained voice is baked at a handful of
// levels and the player crossfades between them, so every level in between is an
// approximation of a filter the synth would have swept to exactly. This measures
// the approximation instead of arguing about it from the sweep width.
//
// The metric is a direct waveform difference, which is only meaningful because
// every stop is the SAME seeded noise through the same graph at the same LFO
// phase: sample i of two stops is the same excitation through two filter
// settings. So render the true synth at a level between two stops, blend those
// two stops the way a player would (linear, sample-aligned), and take
//   err = rms(blend − truth) / rms(truth).
// It is a strict metric — it charges phase error as well as spectrum — and it
// needs no FFT and no windowing choices to argue about.
//
// Sweep WIDTH is not what drives it. Q is: a wide, gentle filter blends almost
// exactly, while a narrow resonance blended from two stops either side of it
// produces two humps where the truth has one peak.
async function crossfadeAudit(page, voices) {
  const rows = [];
  for (const [cue, spec] of Object.entries(VOICES)) {
    if (spec.levels.length < 2) {
      rows.push({ cue, stops: spec.levels.length, worstErrPct: 0, worstAtLevel: '—',
        note: 'level-invariant timbre — nothing to interpolate' });
      continue;
    }
    const stops = [];
    for (const l of spec.levels) stops.push({ l, f: await timbre(page, cue, l, voices[cue].gain) });

    let worst = 0, worstAt = 0, worstSpan = '';
    for (let i = 0; i + 1 < stops.length; i++) {
      const a = stops[i], b = stops[i + 1];
      for (const w of [0.25, 0.5, 0.75]) {
        const l = a.l + w * (b.l - a.l);
        const truth = await timbre(page, cue, l, voices[cue].gain);
        let se = 0, ss = 0;
        for (let k = 0; k < truth.length; k++) {
          const blend = (1 - w) * a.f[k] + w * b.f[k];
          se += (blend - truth[k]) ** 2;
          ss += truth[k] ** 2;
        }
        const err = Math.sqrt(se / ss);
        if (err > worst) { worst = err; worstAt = l; worstSpan = `${a.l}→${b.l} @${w}`; }
      }
    }
    rows.push({ cue, stops: spec.levels.length, worstErrPct: r6(worst * 100),
      worstAtLevel: r6(worstAt), span: worstSpan });
  }
  return rows;
}

// ── the jitter premise ────────────────────────────────────────────────────────

// The bake's whole premise is that jitter shifts oscillator FREQUENCY and
// nothing else, so re-applying it as playbackRate at playback is faithful.
// Prove it: render each jittered one-shot at Math.random pinned to 0 and 1
// (jitter = 2^(∓spread/12), the extremes) and show the trimmed length does not
// move while the zero-crossing rate does.
async function verifyJitter(page) {
  const rows = [];
  for (const job of ONESHOTS) {
    if (!job.spread) continue;
    const out = [];
    for (const fixed of [0, 0.5, 1]) {
      const res = await page.evaluate((j) => window.__bakeRender(j), {
        method: job.method, cue: job.cue, channels: job.channels || 1,
        frames: ONESHOT_SECONDS * SR, seed: NOISE_SEED, needsSamples: job.needsSamples || null,
        randomFixed: fixed,
      });
      const f = trimTail(interleave(res.channels.map(toFloats)), job.channels || 1);
      let zc = 0;
      for (let i = 1; i < f.length; i++) if ((f[i - 1] < 0) !== (f[i] < 0)) zc++;
      out.push({ ms: r6((f.length / (job.channels || 1)) / SR * 1000), zcr: Math.round(zc / (f.length / SR)) });
    }
    rows.push({ cue: job.name, spread: job.spread,
      msLow: out[0].ms, msMid: out[1].ms, msHigh: out[2].ms,
      zcrLow: out[0].zcr, zcrMid: out[1].zcr, zcrHigh: out[2].zcr,
      lengthMovedMs: r6(Math.max(Math.abs(out[0].ms - out[1].ms), Math.abs(out[2].ms - out[1].ms))) });
  }
  return rows;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { hazards, voices, hashes } = await auditCueSource();

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(args.port), APP_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const killServer = () => { try { server.kill('SIGTERM'); } catch (_) { /* already gone */ } };
  process.on('exit', killServer);

  let browser;
  try {
    await waitForServer(args.port);
    browser = await chromium.launch({ headless: !args.headed });
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
    page.on('pageerror', (e) => console.error('[page]', e.message));

    // A routed same-origin stub: the document carries no CSP of its own, and the
    // real module it imports comes off the dev server, so /display/audio/cues.js
    // is the shipping file and not a copy.
    await page.route('**/__bake/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/__bake/' || p === '/__bake/index.html') {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><meta charset="utf-8"><title>cue baker</title><script src="/__bake/harness.js"></script>' });
      }
      if (p === '/__bake/harness.js') {
        return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8',
          body: fs.readFileSync(HARNESS, 'utf8') });
      }
      return route.fulfill({ status: 404, body: 'Not Found' });
    });
    await page.goto(`http://127.0.0.1:${args.port}/__bake/`);
    await page.waitForFunction(() => typeof window.__bakeRender === 'function');

    const { picks, defaults } = await page.evaluate(() => window.__bakePicks());
    for (const [id, v] of Object.entries(picks)) {
      if (v !== defaults[id]) throw new Error(`cue ${id} resolved to '${v}', not the committed default '${defaults[id]}'`);
    }

    if (args.verifyJitter) {
      const rows = await verifyJitter(page);
      console.log('\njitter is frequency-only — length at ∓spread vs neutral:');
      console.table(rows);
      const moved = rows.filter((r) => r.lengthMovedMs > 0.5);
      if (moved.length) {
        console.error('FAIL: jitter changed the rendered length for ' + moved.map((r) => r.cue).join(', '));
        process.exitCode = 1;
      } else {
        console.log('PASS: every jittered cue rendered the same length at both extremes '
          + '(zero-crossing rate moved, duration did not) — playbackRate jitter is faithful.');
      }
      if (!args.check) return;
    }

    if (args.crossfadeAudit) {
      const rows = await crossfadeAudit(page, voices);
      console.log('\nlevel-stop crossfade error — rms(blend of neighbouring stops − true synth) / rms(true synth):');
      console.table(rows);
      if (!args.check) return;
    }

    const rendered = await bake(page, args, voices);
    const version = browser.version();

    // ── assemble files + manifest ──
    const cues = {};
    const rows = [];
    const files = new Map();
    for (const r of rendered) {
      const { pcm, clipped } = quantize(r.floats);
      const m = metrics(pcm, r.channels, r.sampleRate);
      if (clipped) console.warn(`WARN ${r.name}: ${clipped} sample(s) clipped`);
      if (m.peak < 0.01) throw new Error(`${r.name} rendered essentially silent (peak ${m.peak})`);
      const { file, pcmBytes } = wav(pcm, r.channels, r.sampleRate);
      const entry = {
        file: `${r.name}.wav`, channels: r.channels, sampleRate: r.sampleRate,
        frames: m.frames, durationSec: m.durationSec, body60Sec: m.body60Sec,
        peak: m.peak, rms: m.rms, sha256: sha256(pcmBytes),
      };
      files.set(`${r.name}.wav`, file);
      rows.push({ file: entry.file, kind: r.kind, ch: r.channels, kHz: r.sampleRate / 1000,
        ms: Math.round(m.durationSec * 1000), body60ms: Math.round(m.body60Sec * 1000),
        peak: m.peak, rms: m.rms, jitter: r.spread ?? '', sha: entry.sha256.slice(0, 12) });

      if (r.kind === 'one-shot') {
        cues[r.cue] = cues[r.cue] || {
          kind: 'one-shot', files: [],
          playback: {
            gain: 1,
            // Baked with jitter neutralised; the player re-rolls it per fire as a
            // playbackRate. Rate and duration move together in a sample player
            // where the synth moved only pitch, so the drift is recorded per file.
            jitter: r.spread
              ? { spread: r.spread, playbackRate: `2^(U(-${r.spread}, +${r.spread})/12)`,
                  rateRange: [r6(2 ** (-r.spread / 12)), r6(2 ** (r.spread / 12))] }
              : null,
          },
        };
        cues[r.cue].files.push({
          ...(r.method === 'play' ? {} : { beat: r.method }),
          ...entry,
          ...(r.spread ? {
            jitterDurationDriftMs: [
              r6((2 ** (-r.spread / 12) - 1) * m.durationSec * 1000),
              r6((2 ** (r.spread / 12) - 1) * m.durationSec * 1000)],
            // What the playback rate will move that the SYNTH held fixed —
            // derived from cues.js by auditCueSource(), not hand-maintained.
            jitterHazards: hazards[r.name],
          } : {}),
          // Per FILE, not per cue: countdown bakes two beats out of one variant
          // and each carries its own reasoning.
          ...(r.note ? { note: r.note } : {}),
        });
      } else if (r.kind === 'sustained') {
        cues[r.cue] = cues[r.cue] || {
          kind: 'sustained', loop: true, variant: r.spec.variant,
          // Quoted verbatim from the picked variant's set(level), which is also
          // what was divided out of every stop below — one expression, one copy.
          playback: { gainFormula: voices[r.cue].gainExpr, smoothTauSec: voices[r.cue].gainTau,
            bakeHeadroom: r.headroom, jitter: null,
            levelFloor: 0.02, raceMaxLevel: r.spec.raceMax || 1,
            crossfade: r.spec.levels.length > 1 ? 'linear between adjacent stops, sample-aligned (all stops share the loop phase)' : null },
          stops: [],
        };
        cues[r.cue].stops.push({ level: r.level, ...entry, ...r.spec.param(r.level),
          ...(r.spec.levelInvariant ? { levelInvariant: true } : {}) });
        if (r.spec.note) cues[r.cue].note = r.spec.note;
      }
    }

    // Sample-backed cues: no WAV, just a pinned reference to the shipped file.
    for (const job of PASSTHROUGH) {
      const src = fs.readFileSync(path.join(ROOT, job.source));
      cues[job.cue] = {
        kind: 'passthrough', loop: !!job.loop, variant: picks[job.cue],
        source: job.source, bytes: src.length, sha256: sha256(src),
        playback: { jitter: null, liveDsp: job.liveDsp },
        note: job.note,
      };
      rows.push({ file: job.source.split('/').pop(), kind: 'passthrough', ch: 2, kHz: 44.1,
        ms: '', body60ms: '', peak: '', rms: '', jitter: '', sha: cues[job.cue].sha256.slice(0, 12) });
    }

    // Fill in the variant each one-shot cue was baked from, and pin every cue to
    // the exact source it was baked from. `sourceSha256` is the cue's picked
    // variant block verbatim; it is what makes a retune of cues.js turn
    // tests/bake-cues.test.js red instead of leaving stale PCM in the tree.
    for (const [id, c] of Object.entries(cues)) {
      if (!c.variant) c.variant = picks[id];
      c.sourceSha256 = hashes.variants[id];
    }

    const manifest = {
      version: MANIFEST_VERSION,
      generatedBy: 'scripts/bake-cues.mjs',
      renderer: `chromium ${version} / OfflineAudioContext`,
      sampleRate: SR, bitDepth: 16, encoding: 'pcm_s16le/wav',
      noiseSeed: NOISE_SEED,
      // WHAT THIS IS A BAKE OF. The bytes below are only correct for one state
      // of cues.js: the sustained voices have their output gain DIVIDED OUT, so
      // a retune there makes every committed stop wrong by that factor, and a
      // reworked one-shot leaves a WAV of a sound the game no longer makes.
      // Nothing downstream can tell. So the manifest carries the fingerprint of
      // what it was baked from — the shared DSP prelude (jitter, the cached
      // noise buffer, tone/noise/pluck/knock/pop/tremTone, playSample,
      // DEFAULT_PICKS) plus, per cue below, its picked variant block verbatim —
      // and tests/bake-cues.test.js recomputes both from cues.js. Same trick as
      // BUILD_STAMP.json's source hash for the wasm, and the same bluntness: a
      // comment inside a variant counts as a change and wants a re-bake.
      source: {
        file: 'public/display/audio/cues.js',
        sharedSha256: hashes.shared,
        sharedScope: 'everything above `export const CUES = [` — the helpers every variant calls',
        perCue: 'cues.<id>.sourceSha256 is that cue\'s picked variant block',
        derived: 'the sustained voices\' gainFormula/smoothTauSec are QUOTED from cues.js by the baker, '
          + 'not transcribed; the stop filter parameters are cross-checked against the sweeps it schedules.',
      },
      trimFloor: r6(TRIM_FLOOR), trimFloorDbfs: r6(20 * Math.log10(TRIM_FLOOR)),
      loopSeconds: VOICE_KEEP_SECONDS, voiceRenderSeconds: VOICE_SECONDS,
      reproducibility: 'A re-bake lands within 1 LSB, not byte-identically. Chromium sums a node\'s '
        + 'fan-in in HashSet (heap-address) order, so any cue merging several branches into one '
        + 'destination adds its branches in a different ORDER each render; float addition is not '
        + 'associative, so the result moves by one float32 ULP (~2.98e-8, about -150 dBFS) and the '
        + 'occasional sample sitting on a .5 rounding boundary flips by one LSB. The LIVE game has the '
        + 'same instability on the same graphs. `npm run bake:cues -- --check` allows '
        + `${RECHECK_MAX_LSB} LSB on ${RECHECK_MAX_FRACTION * 100}% of samples; tests/bake-cues.test.js `
        + 'is an exact hash gate on what is committed.',
      note: 'Baked from the live WebAudio synthesis in public/display/audio/cues.js with jitter '
        + 'forced to 1.0 (Math.random === 0.5) and the cached noise buffer filled from '
        + 'mulberry32(noiseSeed). Re-apply per-cue jitter at PLAYBACK as a playbackRate. '
        + 'cues.js stays the bake source and the gallery audition surface; nothing plays these yet.',
      // The one piece of DSP a per-cue bake CANNOT contain, and the one thing a
      // native mixer still has to build. It acts on the SUM of every overlapping
      // cue plus the streamed music bed, so a lone cue will match perfectly and
      // an 8-car pile-up will not. Reimplementing it is defensible in a way the
      // 695-line synthesis is not: four numbers and a standard curve, no taste.
      masterBus: {
        limiter: { node: 'DynamicsCompressor', thresholdDb: -12, kneeDb: 24, ratio: 6,
          attack: 'WebAudio default 0.003 s', release: 'WebAudio default 0.25 s' },
        source: 'public/display/Audio.js:120-125 (and gallery-sounds.js:23-27)',
        note: 'master → compressor → destination. Every cue and the music bed share it. '
          + 'Without an equivalent on the native bus, dense overlap will read louder than the web build.',
      },
      // Baking deliberately closes the gallery override path. Audio.js resolves
      // each cue through resolveVariant(cueId, localStorage picks); this bake
      // ignores those and uses DEFAULT_PICKS only, so a shipping sample player
      // must stop reading the picks key rather than silently falling back.
      variantSource: 'DEFAULT_PICKS only — localStorage picks (tinytrack_sound_picks_v1) are NOT honoured by the bake',
      cues: Object.fromEntries(Object.keys(cues).sort().map((k) => [k, cues[k]])),
    };

    if (args.check) {
      let bad = 0;
      const prev = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      let worstLsb = 0, worstFrac = 0;
      for (const [name, buf] of files) {
        const onDisk = path.join(OUT_DIR, name);
        if (!fs.existsSync(onDisk)) { console.error(`MISSING ${name}`); bad++; continue; }
        const was = fs.readFileSync(onDisk);
        if (was.equals(buf)) continue;
        if (was.length !== buf.length) { console.error(`DRIFT   ${name}: ${was.length} → ${buf.length} bytes`); bad++; continue; }
        let maxLsb = 0, differing = 0;
        for (let i = 44; i + 1 < buf.length; i += 2) {
          const d = Math.abs(was.readInt16LE(i) - buf.readInt16LE(i));
          if (d) { differing++; if (d > maxLsb) maxLsb = d; }
        }
        const frac = differing / ((buf.length - 44) / 2);
        worstLsb = Math.max(worstLsb, maxLsb);
        worstFrac = Math.max(worstFrac, frac);
        const within = maxLsb <= RECHECK_MAX_LSB && frac <= RECHECK_MAX_FRACTION;
        console[within ? 'log' : 'error'](
          `${within ? 'ripple ' : 'DRIFT  '} ${name}: ${differing} sample(s) differ, max ${maxLsb} LSB `
          + `(${(frac * 100).toFixed(4)}% of samples)`);
        if (!within) bad++;
      }
      if (worstLsb) {
        console.log(`  (a ripple is Chromium's fan-in summation order, worth ±1 float32 ULP ≈ -150 dBFS — `
          + `worst here: ${worstLsb} LSB on ${(worstFrac * 100).toFixed(4)}% of samples)`);
      }
      if (!args.only) {
        for (const name of fs.readdirSync(OUT_DIR)) {
          if (name.endsWith('.wav') && !files.has(name)) { console.error(`ORPHAN  ${name}`); bad++; }
        }
      }
      // Compare the manifest's SHAPE, not the three fields a 1-LSB ripple moves.
      // Those are reported per file above; a difference in anything else (a
      // level stop, a spread, a frame count, a filter cutoff) is real drift.
      const shape = (o) => JSON.stringify(o, (k, v) => (['sha256', 'peak', 'rms'].includes(k) ? undefined : v));
      if (shape(prev.cues) !== shape(manifest.cues)) { console.error('DRIFT   manifest.json (cues)'); bad++; }
      console.log(bad
        ? `\n${bad} artefact(s) drifted — re-run \`npm run bake:cues\`.`
        : `\nOK — ${files.size} baked artefacts reproduce${worstLsb ? ' to within ' + worstLsb + ' LSB' : ' byte-identically'}.`);
      process.exitCode = bad ? 1 : 0;
      return;
    }

    // The manifest is assembled from what was RENDERED, so a partial run would
    // write a manifest describing only those cues — silently dropping every
    // other entry (and with it every source hash). --only is an eyeballing tool;
    // pair it with --check, or do the whole palette.
    if (args.only) {
      throw new Error('--only renders a subset, and the manifest is built from what was rendered — '
        + 'writing it now would drop every other cue. Use --only with --check, or re-bake everything.');
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    // Sweep orphans first: a renamed or dropped cue must not leave a stale WAV
    // behind for the manifest test to trip over (or, worse, for a shell to ship).
    if (!args.only) {
      for (const name of fs.readdirSync(OUT_DIR)) {
        if (name.endsWith('.wav') && !files.has(name)) fs.rmSync(path.join(OUT_DIR, name));
      }
    }
    for (const [name, buf] of files) fs.writeFileSync(path.join(OUT_DIR, name), buf);
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

    console.table(rows);
    console.log(`\n${files.size} files → ${path.relative(ROOT, OUT_DIR)}`);

    // Duration drift is the cost of moving jitter from the synth (which shifted
    // FREQUENCY only) to a sample player (where rate shifts pitch and length
    // together). Report it at the ±1 semitone extreme for the shortest and
    // longest one-shot that actually carries jitter, and again at each cue's
    // REAL spread — only two cues use the full semitone.
    const jittered = rows.filter((r) => r.kind === 'one-shot' && r.jitter);
    const drift = (ms, sp) => `${r6((2 ** (-sp / 12) - 1) * ms).toFixed(1)} / +${r6((2 ** (sp / 12) - 1) * ms).toFixed(1)} ms`;
    const shortest = [...jittered].sort((a, b) => a.ms - b.ms)[0];
    const longest = [...jittered].sort((a, b) => b.ms - a.ms)[0];
    console.log(`±1 semitone drift — shortest jittered one-shot ${shortest.file} (${shortest.ms} ms): ${drift(shortest.ms, 1)}`);
    console.log(`                    longest  jittered one-shot ${longest.file} (${longest.ms} ms): ${drift(longest.ms, 1)}`);
    console.log('drift at each cue\'s ACTUAL spread:');
    for (const r of jittered) console.log(`  ${r.file.padEnd(22)} spread ±${r.jitter}  ${r.ms} ms → ${drift(r.ms, r.jitter)}`);

    console.log('\ncues where playback-rate jitter moves something the SYNTH holds fixed:');
    console.table(Object.entries(hazards).map(([name, h]) => ({
      cue: name,
      verdict: h.clean ? 'clean' : 'HAZARD',
      unjitteredNoiseHz: h.unjitteredNoise.join('; ') || '—',
      fixedLfoHz: h.unjitteredLfoHz.map((l) => `${l.hz} → ${l.atRateExtremes.join('..')}`).join('; ') || '—',
      fixedOffsetsMs: (h.unjitteredOffsetsSec.map((o) => `${o.sec * 1000}±${Math.max(...o.driftMs.map(Math.abs)).toFixed(1)}`).join(' ')
        + (h.computedRhythm ? ' +loop' : '')).trim() || '—',
    })));
  } finally {
    if (browser) await browser.close();
    killServer();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
