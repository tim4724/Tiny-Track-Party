'use strict';
// Browser half of scripts/bake-cues.mjs — served to a Playwright page, never
// required by Node (unlike its neighbours here, which are CommonJS helpers).
//
// It is a CLASSIC script that dynamically imports the shipping cue module, for
// the same reason gallery-common.js is: the page it runs on is a routed stub
// with no importmap, and a classic <script src> + import() needs neither. What
// matters is that /display/audio/cues.js is the REAL module off the dev server —
// the whole point of baking in a browser is that the DSP doing the rendering is
// the DSP that ships. A Node WebAudio polyfill would be a different engine with
// different biquad coefficients and different envelope curves, which would make
// "identical by construction" a lie.
//
// Two pieces of determinism live here, and both are Math.random substitutions
// around the render (restored in a finally, so the page's own randomness is
// untouched between jobs):
//
//   1. THE NOISE BUFFER. cues.js caches 1 s of white noise per AudioContext,
//      filled from Math.random on first use. Left alone that is a fresh buffer
//      every bake, so no two bakes would carry the same noise at all. A SEEDED
//      mulberry32 is installed before the buffer is created, primed by a call
//      whose first act is noiseBuf(ctx) so nothing else has drawn from the
//      stream yet.
//   2. JITTER. cues.js:24 jitter(spread) = 2^(((random*2-1)*spread)/12).
//      random === 0.5 makes the exponent EXACTLY 0 for every spread, so
//      jitter() returns exactly 1.0 and the bake carries no detune. The random
//      ±1 semitone comes back at playback as a sample playbackRate, which is
//      dimensionally the same multiplier.
//
// `randomFixed` overrides (2) for the verification pass: pinning it to 0 or 1
// forces jitter to its -spread / +spread extremes so the caller can prove the
// rendered DURATION does not move (i.e. jitter really is frequency-only).

(function () {
  const SR = 48000;
  const CUES_URL = '/display/audio/cues.js';

  let mod = null;
  async function cues() {
    if (!mod) mod = await import(CUES_URL);
    return mod;
  }

  // mulberry32 — small, exactly reproducible, and its state is a single int32,
  // so a bake is pinned by one number in the manifest.
  function mulberry32(a) {
    let s = a >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function b64(u8) {
    let out = '';
    const CHUNK = 0x8000;                       // fromCharCode blows the stack past ~100k args
    for (let i = 0; i < u8.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(out);
  }

  function dump(buf) {
    const channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const f = buf.getChannelData(c);
      channels.push(b64(new Uint8Array(f.buffer, f.byteOffset, f.length * 4)));
    }
    return { sampleRate: buf.sampleRate, length: buf.length, channels };
  }

  // job: { method, cue, level, frames, channels, sampleRate, seed, needsSamples,
  //        sample, randomFixed }
  async function render(job) {
    const m = await cues();
    // sampleRate defaults to 48 kHz for the synthesised cues; the two
    // sample-backed ones render at their recording's own rate, because
    // decodeAudioData resamples into the context and resampling a shipped
    // recording gains nothing (and lengthens the engine LOOP by the
    // resampler's tail, which would move its seam).
    const ctx = new OfflineAudioContext(job.channels || 1, job.frames, job.sampleRate || SR);

    // rocket_hit plays a decoded recording, so its buffer has to land before the
    // graph is built or the cue renders silence (playSample is inert until then).
    if (job.needsSamples) {
      const cache = await m.loadSampleBuffers(ctx);
      for (const name of job.needsSamples) {
        if (!cache[name]) throw new Error('sample failed to decode: ' + name);
      }
    }

    const realRandom = Math.random;
    try {
      Math.random = mulberry32(job.seed);
      // Prime the per-context noise buffer from the seeded stream. 'boost' is the
      // primer because its start() calls noiseBuf(ctx) before it draws anything
      // else, so the buffer is prng samples 0..sampleRate-1 with no offset. The
      // voice itself lands in a gain node that is deliberately NOT connected to
      // the destination, so it contributes exactly nothing to the render.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      m.resolveVariant('boost').start(ctx, sink);

      Math.random = job.randomFixed === undefined ? () => 0.5 : () => job.randomFixed;

      const v = m.resolveVariant(job.cue);
      if (!v) throw new Error('no variant resolved for cue ' + job.cue);
      if (job.method === 'voice') {
        if (typeof v.start !== 'function') throw new Error(job.cue + ' is not a sustained voice');
        v.start(ctx, ctx.destination).set(job.level);
      } else {
        if (typeof v[job.method] !== 'function') throw new Error(job.cue + ' has no ' + job.method + '()');
        v[job.method](ctx, ctx.destination);
      }
    } finally {
      Math.random = realRandom;
    }

    return dump(await ctx.startRendering());
  }

  // Which variant each cue resolves to, straight from DEFAULT_PICKS. The bake
  // deliberately ignores the gallery's localStorage overrides — a baked palette
  // is the committed one, and a dev machine's starred pick must not leak into a
  // shipped asset.
  async function picks() {
    const m = await cues();
    const out = {};
    for (const c of m.CUES) out[c.id] = m.resolveVariant(c.id).id;
    return { picks: out, defaults: m.DEFAULT_PICKS };
  }

  window.__bakeRender = render;
  window.__bakePicks = picks;
})();
