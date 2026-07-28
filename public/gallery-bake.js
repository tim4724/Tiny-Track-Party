// A/B judging harness for the BAKED cue palette (/assets/audio/cues) against
// the LIVE WebAudio synthesis it was rendered from (/display/audio/cues.js).
//
// The bake's whole justification is "identical by construction": every cue was
// rendered by the DSP that ships, so a sample player on tvOS/Android sounds
// like the web build without anyone reimplementing 695 lines of hand-tuned
// graph. This page is where that claim gets tested by ear and by number:
//
//   - Both sides share ONE bus — master gain → DynamicsCompressor(-12/24/6) →
//     destination — the same one display/Audio.js and gallery-sounds.js build.
//     The limiter is the one part of the mix that CANNOT be baked (it acts on
//     the sum of everything), so it must not become a variable in the A/B.
//   - The baked side re-applies jitter as a playbackRate at the cue's own
//     spread, because that is what will actually ship. Baking one file per cue
//     and playing it flat would fatigue on repetition, which is exactly what
//     cues.js:24 exists to prevent.
//   - "Pin jitter" forces BOTH sides neutral (live: Math.random = () => 0.5,
//     the trick scripts/lib/bake-harness.js uses; baked: rate 1.0) and "Seed
//     live noise" fills the live context's cached noise buffer from the
//     manifest's seed. With both on, a one-shot A/B is the same render twice —
//     and the Δ button measures exactly that, offline, in 16-bit LSBs.
//
// Nothing here is used by the game. Like the rest of /gallery-*.html it is a
// dev surface: no relay, no engine, no wasm.
import { CUES, DEFAULT_PICKS, resolveVariant, loadSampleBuffers } from '/display/audio/cues.js';

const DIR = '/assets/audio/cues/';
const MANIFEST_URL = DIR + 'manifest.json';
const VOLUME_KEY = 'tinytrack_sound_volume_v1';   // shared with /gallery-sounds.html
const SEQ_GAP = 0.25;                             // A→B silence, seconds
const SPAM_N = 8, SPAM_GAP = 0.16;                // fatigue test: 8 hits at ~7/s

let manifest = null;
let ctx = null, master = null, samplesReady = null;
let pinJitter = false, seedLiveNoise = true, blind = false;

const rawWavs = new Map();    // file -> Uint8Array (kept: decodeAudioData detaches its input)
const bakedBufs = new Map();  // file -> AudioBuffer (decoded into the live context)
const cards = [];             // { stopAll() } per card, for the visibility handler

// ---- determinism helpers (mirrors of scripts/lib/bake-harness.js) ------------

// mulberry32, byte-for-byte the generator the baker seeds cues.js's noise
// buffer with. Same seed (manifest.noiseSeed) → same noise in this page's live
// context as in the committed files.
function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fill a context's cached 1 s noise buffer from the seeded stream. 'boost' is
// the primer because its start() calls noiseBuf(ctx) before it draws anything
// else, so the buffer is prng samples 0..sampleRate-1 with no offset — the same
// priming call, in the same place, as the bake.
function primeNoise(target) {
  const real = Math.random;
  try {
    Math.random = mulberry32(manifest.noiseSeed);
    const sink = target.createGain();
    sink.gain.value = 0;                       // deliberately NOT connected to the destination
    const h = resolveVariant('boost').start(target, sink);
    if (h && h.stop) h.stop();
  } finally { Math.random = real; }
}

// Run a synchronous scheduling call with jitter neutralised, if the page asks
// for it. cues.js draws every random number during play()/start(), so pinning
// around the call is enough — nothing random happens later.
function withJitterPolicy(fn) {
  if (!pinJitter) return fn();
  const real = Math.random;
  try { Math.random = () => 0.5; return fn(); } finally { Math.random = real; }
}

// The playbackRate the baked side applies: dimensionally the same multiplier
// cues.js:24 applies to oscillator frequencies.
function jitterRate(spread) {
  if (pinJitter || !spread) return 1;
  return Math.pow(2, ((Math.random() * 2 - 1) * spread) / 12);
}

// ---- audio bus --------------------------------------------------------------

function volume() {
  const raw = parseInt(localStorage.getItem(VOLUME_KEY), 10);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) / 100 : 0.6;
}

function audio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = volume();
  // The shipping master bus, verbatim (display/Audio.js). Both sides go
  // through it so the limiter is common-mode, not a difference.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 24;
  comp.ratio.value = 6;
  master.connect(comp);
  comp.connect(ctx.destination);
  if (seedLiveNoise) primeNoise(ctx);           // must run before any cue creates the buffer
  samplesReady = loadSampleBuffers(ctx);        // engine loop + explosion, for the live sample-backed cues
  paintEnv();
  return ctx;
}

// Seeding is a property of the context's cached noise buffer, so flipping it
// means a new context.
function resetAudio() {
  for (const c of cards) c.stopAll();
  bakedBufs.clear();
  const old = ctx;
  ctx = null; master = null; samplesReady = null;
  if (old) old.close().catch(() => {});
  audio();
}

// ---- baked assets -----------------------------------------------------------

async function rawWav(file) {
  if (!rawWavs.has(file)) {
    const buf = await fetch(DIR + file).then((r) => {
      if (!r.ok) throw new Error(file + ': HTTP ' + r.status);
      return r.arrayBuffer();
    });
    rawWavs.set(file, new Uint8Array(buf));
  }
  return rawWavs.get(file);
}

async function bakedBuffer(file) {
  if (!bakedBufs.has(file)) {
    const u8 = await rawWav(file);
    bakedBufs.set(file, await ctx.decodeAudioData(u8.slice().buffer));
  }
  return bakedBufs.get(file);
}

// Read the committed PCM as the integers actually in the file. decodeAudioData
// would resample it into the context (and divide by 32768), which is fine for
// listening and useless for measuring — Δ compares integers to integers.
function parseWav(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 12, fmt = null, pcm = null;
  while (off + 8 <= u8.length) {
    const id = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = { channels: dv.getUint16(off + 10, true), sampleRate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    } else if (id === 'data') {
      pcm = new Int16Array(u8.buffer.slice(u8.byteOffset + off + 8, u8.byteOffset + off + 8 + size));
    }
    off += 8 + size + (size & 1);
  }
  if (!fmt || !pcm) throw new Error('not a PCM wav');
  return { ...fmt, pcm };
}

// ---- one-shot playback ------------------------------------------------------

// A: the live graph, scheduled exactly as the race schedules it.
function playLive(cueId, method, when) {
  const v = resolveVariant(cueId);
  const dur = withJitterPolicy(() => v[method](ctx, master, when));
  return typeof dur === 'number' && dur > 0 ? dur : 0;
}

// B: the committed WAV + the jitter the synth would have applied, as a rate.
function playBaked(entry, when, rate) {
  const buf = bakedBufs.get(entry.file);
  if (!buf) return 0;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = entry.gain;
  src.connect(g);
  g.connect(master);
  src.start(when);
  return buf.duration / rate;
}

// ---- sustained playback -----------------------------------------------------

// "0.10 * l" / "0.0001 + 0.8 * l" → l => offset + scale * l. Parsed, not
// eval'd: the CSP admits no eval and no new Function, and a shell has to
// hand-implement this formula anyway — if the manifest ever grows a shape this
// can't read, that should fail loudly here rather than be quietly approximated.
function gainFn(formula) {
  const m = /^\s*(?:([\d.]+)\s*\+\s*)?([\d.]+)\s*\*\s*l\s*$/.exec(formula);
  if (!m) throw new Error('unparseable gainFormula: ' + formula);
  const off = m[1] ? parseFloat(m[1]) : 0, scale = parseFloat(m[2]);
  return (l) => off + scale * l;
}

// Which stops bracket a level, and how much of each. Linear, because every
// stop was rendered from the same seeded noise and they are sample-aligned —
// correlated signals sum by amplitude, so the weights must add to 1.
function stopMix(stops, l) {
  const w = stops.map(() => 0);
  if (l <= stops[0].level) { w[0] = 1; return w; }
  const last = stops.length - 1;
  if (l >= stops[last].level) { w[last] = 1; return w; }
  for (let i = 0; i < last; i++) {
    const a = stops[i], b = stops[i + 1];
    if (l >= a.level && l <= b.level) {
      const f = (l - a.level) / (b.level - a.level);
      w[i] = 1 - f; w[i + 1] = f;
      return w;
    }
  }
  return w;
}

// A shell-side player for a sustained voice: every stop looping in parallel,
// phase-locked (all started at the same instant), crossfaded by level, with the
// analytic gain the bake divided out re-applied continuously.
function bakedVoice(spec) {
  const stops = spec.stops;
  const gain = gainFn(spec.playback.gainFormula);
  const head = spec.playback.bakeHeadroom || 1;
  const tau = spec.playback.smoothTauSec;
  const t = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = 0.0001;
  out.connect(master);
  const lanes = stops.map((s) => {
    const src = ctx.createBufferSource();
    src.buffer = bakedBufs.get(s.file);
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g); g.connect(out);
    src.start(t);
    return { src, g };
  });
  return {
    set(level) {
      const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
      const w = stopMix(stops, l);
      for (let i = 0; i < lanes.length; i++) lanes[i].g.gain.setTargetAtTime(w[i], at, tau);
      out.gain.setTargetAtTime(gain(l) * head, at, tau);
    },
    stop() {
      const at = ctx.currentTime;
      out.gain.setTargetAtTime(0.0001, at, tau);
      for (const lane of lanes) { try { lane.src.stop(at + 0.5); } catch (_) { /* already stopped */ } }
    }
  };
}

// engine_putt is PASSTHROUGH: nothing was baked, the .ogg ships as-is and the
// lowpass stays live (playbackRate is the RPM, so it drags the filtered
// spectrum with it and no baked stop can be right at more than one rate). So
// side B here is not a sample of a sample — it is a from-scratch shell
// implementation of the DSP the manifest documents, driven by the same slider.
// Numbers transcribed from manifest.cues.engine_putt.playback.liveDsp.
const PASSTHROUGH_DSP = {
  rate0: 0.9, rateSpan: 0.75, tauRate: 0.12,
  lp0: 900, lpSpan: 5200, Q: 0.6, tauLp: 0.10,
  gain0: 0.007, gainSpan: 0.06, tauGain: 0.08,
  monster: { rateMul: 0.6, gainMul: 1.45, lpMul: 0.82 }
};

function passthroughVoice(cache) {
  const d = PASSTHROUGH_DSP;
  const src = ctx.createBufferSource();
  if (cache && cache.engine) src.buffer = cache.engine;
  src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = d.lp0; lp.Q.value = d.Q;
  const out = ctx.createGain();
  out.gain.value = 0.0001;
  src.connect(lp); lp.connect(out); out.connect(master);
  src.start(ctx.currentTime);
  return {
    set(level, mod) {
      const l = Math.max(0, Math.min(1, level)), at = ctx.currentTime;
      const rMul = (mod && mod.rateMul) || 1, gMul = (mod && mod.gainMul) || 1, fMul = (mod && mod.lpMul) || 1;
      src.playbackRate.setTargetAtTime((d.rate0 + l * d.rateSpan) * rMul, at, d.tauRate);
      lp.frequency.setTargetAtTime((d.lp0 + l * d.lpSpan) * fMul, at, d.tauLp);
      out.gain.setTargetAtTime((d.gain0 + l * d.gainSpan) * gMul, at, d.tauGain);
    },
    stop() {
      const at = ctx.currentTime;
      out.gain.setTargetAtTime(0.0001, at, d.tauGain);
      try { src.stop(at + 0.5); } catch (_) { /* already stopped */ }
    }
  };
}

// ---- Δ: the offline null test ----------------------------------------------

// Does this cue's variant play a decoded recording? Asked of the source rather
// than kept in a list here, so an edit to cues.js can't leave this rotting.
function needsSamples(cueId, method) {
  const v = resolveVariant(cueId);
  return typeof v[method] === 'function' && /playSample|sampleBuf/.test(v[method].toString());
}

// Re-render one baked file from the live synthesis, offline, under the bake's
// own determinism (seeded noise + jitter pinned to 1.0), and diff it against
// the committed integers. Reports in 16-bit LSBs, because that is the unit the
// file is written in: 1 LSB is the quantisation floor and means "identical".
async function measure(cueId, method, file) {
  const { pcm, channels, sampleRate } = parseWav(await rawWav(file));
  const frames = Math.ceil(sampleRate * 4);       // the baker's ONESHOT_SECONDS window
  const octx = new OfflineAudioContext(channels, frames, sampleRate);
  if (needsSamples(cueId, method)) {
    const cache = await loadSampleBuffers(octx);
    if (!cache.explosionPunch && !cache.engine) throw new Error('sample decode failed');
  }
  primeNoise(octx);
  const real = Math.random;
  try {
    Math.random = () => 0.5;
    resolveVariant(cueId)[method](octx, octx.destination);
  } finally { Math.random = real; }
  const rendered = await octx.startRendering();

  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(rendered.getChannelData(c));
  const bakedFrames = pcm.length / channels;
  let maxLsb = 0, differing = 0;
  for (let f = 0; f < bakedFrames; f++) {
    for (let c = 0; c < channels; c++) {
      let q = Math.round(chans[c][f] * 32767);
      if (q > 32767) q = 32767; else if (q < -32768) q = -32768;
      const d = Math.abs(q - pcm[f * channels + c]);
      if (d) { differing++; if (d > maxLsb) maxLsb = d; }
    }
  }
  // Anything above the trim floor living past the end of the file would mean
  // the trim ate audible tail — the one way a bake can lose sound silently.
  let tail = 0;
  for (let f = bakedFrames; f < frames; f++) {
    for (let c = 0; c < channels; c++) if (Math.abs(chans[c][f]) >= 1 / 32767) tail = f - bakedFrames + 1;
  }
  return { maxLsb, differing, total: pcm.length, tailFrames: tail, sampleRate };
}

// ---- UI ---------------------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const ms = (s) => Math.round(s * 1000) + ' ms';
const cents = (a, b) => Math.round(1200 * Math.log2(a / b));

function chip(text, kind) { return el('span', 'chip' + (kind ? ' ' + kind : ''), text); }

// The bake reads DEFAULT_PICKS and ignores the sound gallery's localStorage
// overrides, on purpose. If cues.js's default has moved since the bake, side A
// and side B are two different cues and every judgement on the card is void —
// so say so loudly rather than let someone conclude "the bake sounds wrong".
function driftChip(card, cueId, spec) {
  const now = DEFAULT_PICKS[cueId];
  if (now === spec.variant) return;
  const chips = el('div', 'ab-chips');
  chips.appendChild(chip(`MANIFEST DRIFT — baked "${spec.variant}", cues.js now defaults to "${now}". Re-bake before judging.`, 'bad'));
  card.appendChild(chips);
}

// What the manifest says rate-jitter will drag along with the tone — the honest
// caveat of the whole playbackRate trick, per cue, from the baker's own
// source-derived analysis rather than a hand-written list.
function hazardChips(box, f) {
  const h = f.jitterHazards;
  if (!h) return;
  if (h.clean) { box.appendChild(chip('jitter-clean', 'ok')); return; }
  box.appendChild(chip('rate-jitter hazard', 'warn'));
  for (const n of h.unjitteredNoise || []) box.appendChild(chip('fixed noise ' + n, 'warn'));
  for (const l of h.unjitteredLfoHz || []) {
    box.appendChild(chip(`fixed LFO ${l.hz} Hz → ${l.atRateExtremes.map((x) => x.toFixed(2)).join('..')}`, 'warn'));
  }
  for (const o of h.unjitteredOffsetsSec || []) {
    box.appendChild(chip(`offset ${ms(o.sec)} ±${Math.max(...o.driftMs.map(Math.abs)).toFixed(1)} ms`, 'warn'));
  }
  if (h.computedRhythm) box.appendChild(chip('loop rhythm shifts', 'warn'));
}

// One row per baked file: the A/B toggle, PLAY, the sequence, the fatigue
// test, and Δ.
function oneShotRow(cueId, spec, f) {
  const method = f.beat || 'play';                       // countdown bakes tick()/go() separately
  const jit = spec.playback.jitter;
  const spread = jit ? jit.spread : 0;
  const entry = { file: f.file, gain: spec.playback.gain === undefined ? 1 : spec.playback.gain };

  const wrap = el('div', 'ab-file');
  const name = el('div', 'ab-file-name');
  name.appendChild(el('span', null, f.file));
  name.appendChild(el('span', 'sub', `  ·  ${ms(f.durationSec)} · ${f.channels === 2 ? 'stereo' : 'mono'} ${f.sampleRate / 1000} k`
    + (spread ? ` · jitter ±${spread} st` : ' · no jitter')));
  wrap.appendChild(name);

  const chips = el('div', 'ab-chips');
  hazardChips(chips, f);
  // The one file that is not at the palette's rate. Both sides get resampled
  // into this page's context, so the A/B is still fair — but a native shell
  // plays the 44.1 kHz file untouched, and this page cannot show you that.
  if (f.sampleRate !== manifest.sampleRate) {
    chips.appendChild(chip(`${f.sampleRate / 1000} kHz — resampled into this context`, 'warn'));
  }
  if (f.note) chips.title = f.note;
  wrap.appendChild(chips);

  const row = el('div', 'ab-controls');
  const seg = el('div', 'seg');
  const aBtn = el('button', 'on', 'A live');
  const bBtn = el('button', 'b', 'B baked');
  seg.appendChild(aBtn); seg.appendChild(bBtn);
  let side = 'a';
  function paintSeg() {
    aBtn.classList.toggle('on', side === 'a');
    bBtn.classList.toggle('on', side === 'b');
    seg.classList.toggle('blind', blind);
  }
  aBtn.addEventListener('click', () => { side = 'a'; paintSeg(); });
  bBtn.addEventListener('click', () => { side = 'b'; paintSeg(); });
  row.appendChild(seg);

  const play = el('button', 'card-btn ab-play', '▶ PLAY');
  const seq = el('button', 'card-btn', 'A → B');
  const spam = el('button', 'card-btn', '×' + SPAM_N);
  spam.title = `Fire the selected side ${SPAM_N} times at ~7/s — the fatigue test the jitter exists for`;
  const readout = el('span', 'ab-rate', '');
  row.appendChild(play); row.appendChild(seq); row.appendChild(spam); row.appendChild(readout);

  let lastRate = 1;
  async function ready() {
    audio();
    await bakedBuffer(f.file);
    if (needsSamples(cueId, method)) await samplesReady;
  }
  function fire(which, when) {
    if (which === 'a') return playLive(cueId, method, when) || f.durationSec;
    lastRate = jitterRate(spread);
    return playBaked(entry, when, lastRate);
  }
  function flash(sec) {
    play.classList.add('playing');
    setTimeout(() => play.classList.remove('playing'), Math.max(120, sec * 1000));
  }
  function say(which, extra) {
    const label = blind ? '?' : (which === 'a' ? 'A live' : 'B baked');
    const rateTxt = which === 'b' && lastRate !== 1
      ? ` · rate ${lastRate.toFixed(4)} (${(1200 * Math.log2(lastRate) / 100).toFixed(2)} st)` : '';
    readout.textContent = label + (blind ? '' : rateTxt) + (extra || '');
    readout.dataset.side = which;
  }

  play.addEventListener('click', async () => {
    await ready();
    const which = blind ? (Math.random() < 0.5 ? 'a' : 'b') : side;
    const dur = fire(which, ctx.currentTime + 0.02);
    flash(dur);
    say(which);
  });
  readout.addEventListener('click', () => {
    if (!blind || !readout.dataset.side) return;
    readout.textContent = 'was ' + (readout.dataset.side === 'a' ? 'A live' : 'B baked');
  });
  seq.addEventListener('click', async () => {
    await ready();
    const t0 = ctx.currentTime + 0.05;
    const aDur = fire('a', t0) || f.durationSec;
    fire('b', t0 + aDur + SEQ_GAP);
    flash(aDur + SEQ_GAP + f.durationSec);
    readout.textContent = blind ? 'A → B' : `A → ${SEQ_GAP * 1000} ms → B`;
    readout.dataset.side = '';
  });
  spam.addEventListener('click', async () => {
    await ready();
    const which = blind ? (Math.random() < 0.5 ? 'a' : 'b') : side;
    const t0 = ctx.currentTime + 0.05;
    for (let i = 0; i < SPAM_N; i++) fire(which, t0 + i * SPAM_GAP);
    flash(SPAM_N * SPAM_GAP);
    say(which, ` ×${SPAM_N}`);
  });

  const dBtn = el('button', 'card-btn', 'Δ');
  dBtn.title = 'Re-render this cue offline from the live synthesis and diff it against the committed PCM';
  const dOut = el('span', 'ab-delta', '');
  dBtn.addEventListener('click', () => runMeasure());
  row.appendChild(dBtn); row.appendChild(dOut);

  async function runMeasure() {
    dOut.className = 'ab-delta';
    dOut.textContent = '…';
    try {
      const r = await measure(cueId, method, f.file);
      const pct = (100 * r.differing / r.total).toFixed(2);
      const db = r.maxLsb ? (20 * Math.log10(r.maxLsb / 32767)).toFixed(0) + ' dBFS' : 'silent';
      dOut.textContent = `max ${r.maxLsb} LSB (${db}) · ${pct}% differ`
        + (r.tailFrames ? ` · TAIL LOST ${ms(r.tailFrames / r.sampleRate)}` : '');
      dOut.classList.add(r.maxLsb <= 1 && !r.tailFrames ? 'ok' : 'bad');
    } catch (err) {
      dOut.classList.add('bad');
      dOut.textContent = 'failed: ' + err.message;
    }
  }

  wrap.appendChild(row);
  paintSeg();
  return { node: wrap, runMeasure, repaint: paintSeg };
}

// The countdown is the one cue whose SEQUENCE belongs to the sim (RaceSession
// fires onCountdownTick at 1 Hz), so the beats are baked separately and the
// rhythm is never baked at all. Judge it as the race plays it.
function countdownSequenceRow(spec) {
  const wrap = el('div', 'ab-file');
  wrap.appendChild(el('div', 'ab-file-name', '3 · 2 · 1 · GO (the sim owns the 1 s spacing)'));
  const row = el('div', 'ab-controls');
  const byBeat = {};
  for (const f of spec.files) byBeat[f.beat] = f;
  const spread = spec.playback.jitter.spread;

  async function ready() {
    audio();
    for (const f of spec.files) await bakedBuffer(f.file);
  }
  function schedule(which, t0) {
    for (let i = 0; i < 4; i++) {
      const beat = i === 3 ? 'go' : 'tick';
      const at = t0 + i;
      if (which === 'a') playLive('countdown', beat, at);
      else playBaked({ file: byBeat[beat].file, gain: 1 }, at, jitterRate(spread));
    }
  }
  for (const [label, which] of [['▶ A live', 'a'], ['▶ B baked', 'b']]) {
    const b = el('button', 'card-btn', label);
    b.addEventListener('click', async () => { await ready(); schedule(which, ctx.currentTime + 0.05); });
    row.appendChild(b);
  }
  const both = el('button', 'card-btn', 'A → B');
  both.addEventListener('click', async () => {
    await ready();
    const t0 = ctx.currentTime + 0.05;
    schedule('a', t0);
    schedule('b', t0 + 4 + SEQ_GAP);
  });
  row.appendChild(both);
  wrap.appendChild(row);
  return wrap;
}

function sustainedCard(cueId, spec, cue) {
  const card = el('div', 'card ab-card');
  const head = el('div', 'card-title');
  head.appendChild(el('span', null, cue ? cue.label : cueId));
  head.appendChild(el('span', 'tag', `${cueId} · ${spec.variant} · ${spec.kind}`));
  card.appendChild(head);
  if (cue) card.appendChild(el('p', 'ab-desc', cue.desc));
  driftChip(card, cueId, spec);

  const chips = el('div', 'ab-chips');
  const passthrough = spec.kind === 'passthrough';
  if (passthrough) {
    chips.appendChild(chip('not baked — .ogg ships as-is', 'warn'));
    chips.appendChild(chip('B = shell reimplementation of the documented DSP'));
  } else {
    chips.appendChild(chip(`${spec.stops.length} stop${spec.stops.length > 1 ? 's' : ''}`));
    chips.appendChild(chip('gain ' + spec.playback.gainFormula + ' (divided out of the file)'));
    if (spec.playback.raceMaxLevel < 1) chips.appendChild(chip('race caps level at ' + spec.playback.raceMaxLevel, 'warn'));
    if (spec.stops.length === 1) chips.appendChild(chip('level-invariant timbre — exact, not interpolated', 'ok'));
  }
  card.appendChild(chips);
  if (spec.note) card.appendChild(el('p', 'ab-note', spec.note));

  const lvlRow = el('div', 'ab-level');
  lvlRow.appendChild(el('span', 'ab-rate', 'level'));
  const slider = el('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = '30';
  const val = el('span', 'val', '0.30');
  lvlRow.appendChild(slider); lvlRow.appendChild(val);
  card.appendChild(lvlRow);

  const stopsLine = el('div', 'ab-stops', '');
  card.appendChild(stopsLine);

  const row = el('div', 'ab-controls');
  const aBtn = el('button', 'card-btn ab-side-live', '▶ A live');
  const bBtn = el('button', 'card-btn ab-side-baked', '▶ B baked');
  const swap = el('button', 'card-btn', '⇄ swap');
  swap.title = 'Switch sides without touching the level — the honest way to hear the filter stops';
  row.appendChild(aBtn); row.appendChild(bBtn); row.appendChild(swap);
  let monster = null;
  if (passthrough) {
    const lab = el('label', 'checkbox-label');
    const cb = el('input'); cb.type = 'checkbox';
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' monster mod'));
    lab.title = 'The big-truck growl the race applies while a car is a monster truck';
    row.appendChild(lab);
    monster = cb;
    cb.addEventListener('change', () => apply());
  }
  card.appendChild(row);

  let live = null, baked = null;
  const level = () => Number(slider.value) / 100;
  const mod = () => (monster && monster.checked ? PASSTHROUGH_DSP.monster : undefined);

  function apply() {
    const l = level();
    val.textContent = l.toFixed(2);
    if (live) live.set(l, mod());
    if (baked) baked.set(l, mod());
    paintStops(l);
  }
  function paintStops(l) {
    if (passthrough) {
      const d = PASSTHROUGH_DSP, m = mod() || {};
      const rM = m.rateMul || 1, fM = m.lpMul || 1;
      stopsLine.textContent = `rate ${((d.rate0 + l * d.rateSpan) * rM).toFixed(3)} · lowpass `
        + `${Math.round((d.lp0 + l * d.lpSpan) * fM)} Hz · gain ${((d.gain0 + l * d.gainSpan) * ((m.gainMul) || 1)).toFixed(4)}`;
      return;
    }
    const w = stopMix(spec.stops, l);
    const parts = [];
    for (let i = 0; i < w.length; i++) {
      if (w[i] <= 0.0005) continue;
      parts.push(`l=${spec.stops[i].level} (${hzOf(spec.stops[i])} Hz) ${(w[i] * 100).toFixed(0)}%`);
    }
    // Every filter parameter in these voices is linear in level, so the true
    // cutoff at any l is that same line through the stops — which turns "is
    // five stops enough for a 1.1 octave sweep" into a number on screen
    // instead of an argument.
    let line = parts.join('  ⇄  ');
    const exact = exactHz(spec.stops, l);
    if (exact) {
      const nearest = spec.stops.reduce((best, s) =>
        (Math.abs(cents(hzOf(s), exact)) < Math.abs(cents(hzOf(best), exact)) ? s : best), spec.stops[0]);
      line += `   ·   exact ${exact.toFixed(0)} Hz — snapping to the nearest stop would be `
        + `${Math.abs(cents(hzOf(nearest), exact))} cents off, the crossfade sits between`;
    }
    stopsLine.textContent = line;
  }
  // The filter that MOVES with level. rocket_fire carries both a swept bandpass
  // and a fixed 2800 Hz lowpass, so "whichever key exists" would report the
  // constant and hide the whole question.
  const hzKey = (() => {
    for (const k of ['bandpassHz', 'lowpassHz']) {
      if (spec.stops && spec.stops.some((s) => s[k] !== undefined && s[k] !== spec.stops[0][k])) return k;
    }
    return spec.stops && spec.stops[0] && spec.stops[0].bandpassHz !== undefined ? 'bandpassHz' : 'lowpassHz';
  })();
  const hzOf = (s) => s[hzKey] || 0;
  function exactHz(stops, l) {
    if (stops.length < 2) return 0;
    const a = stops[0], b = stops[stops.length - 1];
    return hzOf(a) + (hzOf(b) - hzOf(a)) * (l - a.level) / (b.level - a.level);
  }

  async function ready() {
    audio();
    if (passthrough) return await samplesReady;
    for (const s of spec.stops) await bakedBuffer(s.file);
    return null;
  }
  function paintBtns() {
    aBtn.classList.toggle('playing', !!live);
    bBtn.classList.toggle('playing', !!baked);
  }
  function stopAll() {
    if (live) { live.stop(); live = null; }
    if (baked) { baked.stop(); baked = null; }
    paintBtns();
  }
  async function start(which) {
    const cache = await ready();
    if (which === 'a') {
      if (baked) { baked.stop(); baked = null; }
      live = resolveVariant(cueId).start(ctx, master);
    } else {
      if (live) { live.stop(); live = null; }
      baked = passthrough ? passthroughVoice(cache) : bakedVoice(spec);
    }
    apply();
    paintBtns();
  }
  aBtn.addEventListener('click', () => { if (live) { stopAll(); } else start('a'); });
  bBtn.addEventListener('click', () => { if (baked) { stopAll(); } else start('b'); });
  swap.addEventListener('click', () => { if (live) start('b'); else if (baked) start('a'); else start('a'); });
  slider.addEventListener('input', apply);

  apply();
  cards.push({ stopAll, repaint() {} });
  return card;
}

function oneShotCard(cueId, spec, cue) {
  const card = el('div', 'card ab-card');
  const head = el('div', 'card-title');
  head.appendChild(el('span', null, cue ? cue.label : cueId));
  head.appendChild(el('span', 'tag', `${cueId} · ${spec.variant} · one-shot`));
  card.appendChild(head);
  if (cue) card.appendChild(el('p', 'ab-desc', cue.desc));

  driftChip(card, cueId, spec);

  const rows = spec.files.map((f) => oneShotRow(cueId, spec, f));
  for (const r of rows) card.appendChild(r.node);
  if (cueId === 'countdown') card.appendChild(countdownSequenceRow(spec));

  cards.push({ stopAll() {}, repaint() { for (const r of rows) r.repaint(); }, measures: rows.map((r) => r.runMeasure) });
  return card;
}

function paintEnv() {
  const line = document.getElementById('env-line');
  const bits = [`manifest v${manifest.version} · ${manifest.renderer} · noise seed 0x${(manifest.noiseSeed >>> 0).toString(16).toUpperCase()}`];
  if (ctx) {
    bits.push(`this context: ${ctx.sampleRate / 1000} kHz`);
    if (ctx.sampleRate !== manifest.sampleRate) {
      bits.push(`⚠ the bake is ${manifest.sampleRate / 1000} kHz, so the browser resamples every baked file before you hear it — Δ is unaffected (it reads the file's own integers), but the ear test is one resampler away from what ships on a ${manifest.sampleRate / 1000} kHz device.`);
    }
  }
  line.textContent = bits.join('  ·  ');
  line.classList.toggle('ab-warn', !!ctx && ctx.sampleRate !== manifest.sampleRate);
}

async function init() {
  manifest = await fetch(MANIFEST_URL).then((r) => r.json());
  const grid = document.getElementById('ab-grid');
  const byId = new Map(CUES.map((c) => [c.id, c]));
  // cues.js order, so this page reads like the sound gallery next door.
  const ids = CUES.map((c) => c.id).filter((id) => manifest.cues[id]);
  for (const id of Object.keys(manifest.cues)) if (!ids.includes(id)) ids.push(id);
  for (const id of ids) {
    const spec = manifest.cues[id];
    grid.appendChild(spec.kind === 'one-shot' ? oneShotCard(id, spec, byId.get(id)) : sustainedCard(id, spec, byId.get(id)));
  }
  paintEnv();

  const vol = document.getElementById('master-volume');
  vol.value = String(Math.round(volume() * 100));
  vol.addEventListener('input', () => {
    try { localStorage.setItem(VOLUME_KEY, vol.value); } catch (_) { /* private mode */ }
    if (master) master.gain.setTargetAtTime(vol.value / 100, ctx.currentTime, 0.02);
  });

  const pin = document.getElementById('pin-jitter');
  pin.addEventListener('change', () => { pinJitter = pin.checked; });
  const seed = document.getElementById('seed-noise');
  seed.addEventListener('change', () => { seedLiveNoise = seed.checked; if (ctx) resetAudio(); });
  const bl = document.getElementById('blind');
  bl.addEventListener('change', () => { blind = bl.checked; for (const c of cards) c.repaint(); });

  const all = document.getElementById('measure-all');
  all.addEventListener('click', async () => {
    all.disabled = true;
    all.textContent = 'measuring…';
    for (const c of cards) for (const m of c.measures || []) await m();
    all.textContent = 'Δ measure all';
    all.disabled = false;
  });

  // A forgotten sustained voice droning behind a hidden tab is exactly the
  // annoyance the sound gallery already guards against.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) for (const c of cards) c.stopAll();
  });
}

init().catch((err) => {
  document.getElementById('env-line').textContent = 'failed to load ' + MANIFEST_URL + ': ' + err.message;
});
