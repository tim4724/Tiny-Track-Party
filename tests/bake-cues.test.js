'use strict';
// The baked cue palette is a CHECKED-IN ARTEFACT, like the wasm runtime: nothing
// in the repo regenerates it on demand, and regenerating it needs Playwright, a
// dev server and headless Chromium (`npm run bake:cues`). So this file is the
// gate that a drifted or hand-edited bake cannot slip through — it re-derives
// every number the manifest claims straight from the committed PCM.
//
// What it CANNOT prove by itself, and deliberately does not pretend to: that the
// PCM is what cues.js would synthesise TODAY. Only a re-bake settles that
// (`npm run bake:cues -- --check`, which re-renders in a real browser and demands
// byte identity). What it can do — and does, below — is notice that cues.js has
// MOVED since the bake, which is the failure that would otherwise be silent.
//
// Three things it pins against cues.js, all of them numbers that live on both
// sides of the bake and would drift without a word:
//
//   • THE SOURCE ITSELF. manifest.source.sharedSha256 plus each cue's
//     sourceSha256 fingerprint the shared DSP prelude and the picked variant
//     block the bake rendered. Retune a cue and this goes red. Same mechanism as
//     BUILD_STAMP.json for the wasm, and the same bluntness — an edit inside a
//     variant counts even if it turns out to be inaudible, because a hash cannot
//     tell and the alternative is trusting that someone noticed.
//   • THE VOICE GAIN. The sustained voices ship as unit-gain TIMBRES: the
//     analytic gain is DIVIDED OUT of the PCM and the player re-applies
//     `gainFormula` live. So a manifest promising 0.14*l for PCM divided by
//     0.10*l is wrong by 40% at every level, and every metric in this file would
//     still agree with itself. Re-derived from cues.js here.
//   • THE JITTER SPREAD. The baked one-shots carry no detune; a player re-rolls
//     it per fire as a playbackRate of 2^(±spread/12). If cues.js changes its
//     jitter() argument without a re-bake, every shipped fire of that cue gets
//     the wrong amount of variation.
//
// All three read cues.js through scripts/lib/cue-source.mjs — the same module
// the baker derives them with, so this is a re-derivation and not a second
// opinion about how to slice the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIR = path.join(__dirname, '..', 'public', 'assets', 'audio', 'cues');
const MANIFEST = path.join(DIR, 'manifest.json');
const CUES_JS = path.join(__dirname, '..', 'public', 'display', 'audio', 'cues.js');
const ROOT = path.join(__dirname, '..');
const CUE_SOURCE = path.join(ROOT, 'scripts', 'lib', 'cue-source.mjs');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const cueSrc = () => fs.readFileSync(CUES_JS, 'utf8');
const cueSource = () => import(pathToFileURL(CUE_SOURCE).href);

// Every file the manifest describes, flattened out of one-shots and voice stops.
function allFiles() {
  const out = [];
  for (const [id, cue] of Object.entries(manifest.cues)) {
    for (const f of cue.files || []) out.push({ id, cue, ...f });
    for (const s of cue.stops || []) out.push({ id, cue, ...s });
  }
  return out;
}

// Minimal RIFF reader — walks the chunk list rather than assuming a 44-byte
// header, so a re-encoded file (an extra LIST/fact chunk, say) is read correctly
// instead of silently hashing the wrong bytes.
function readWav(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('latin1', 0, 4), 'RIFF', `${path.basename(file)}: not RIFF`);
  assert.equal(buf.toString('latin1', 8, 12), 'WAVE', `${path.basename(file)}: not WAVE`);
  let fmt = null, data = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = buf.subarray(at + 8, at + 8 + size);
    if (id === 'fmt ') fmt = body;
    else if (id === 'data') data = body;
    at += 8 + size + (size & 1);        // chunks are word-aligned
  }
  assert.ok(fmt && data, `${path.basename(file)}: missing fmt/data chunk`);
  return {
    format: fmt.readUInt16LE(0),
    channels: fmt.readUInt16LE(2),
    sampleRate: fmt.readUInt32LE(4),
    bits: fmt.readUInt16LE(14),
    data,
  };
}

// Re-derive the manifest's own metrics from the PCM. The baker measures them on
// the QUANTISED samples for exactly this reason: the numbers are reproducible
// here to the last digit rather than to a tolerance, so a hand-tweaked manifest
// value fails instead of hiding inside an epsilon.
function metrics(data, channels) {
  const n = data.length / 2;
  let peak = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = data.readInt16LE(i * 2);
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  const frames = n / channels;
  const floor = peak * 1e-3;
  let body = 0;
  for (let f = frames - 1; f >= 0; f--) {
    let m = 0;
    for (let k = 0; k < channels; k++) m = Math.max(m, Math.abs(data.readInt16LE((f * channels + k) * 2)));
    if (m > floor) { body = f + 1; break; }
  }
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return { frames, peak: r6(peak / 32767), rms: r6(Math.sqrt(sumSq / n) / 32767), body };
}

test('every baked WAV matches the hash and the metrics its manifest entry claims', () => {
  const files = allFiles();
  assert.ok(files.length >= 25, `expected the whole palette, got ${files.length} files`);

  for (const f of files) {
    const p = path.join(DIR, f.file);
    assert.ok(fs.existsSync(p), `${f.file} is in the manifest but not on disk`);
    const wav = readWav(p);

    assert.equal(wav.format, 1, `${f.file}: must be uncompressed PCM`);
    assert.equal(wav.bits, manifest.bitDepth, `${f.file}: bit depth`);
    assert.equal(wav.channels, f.channels, `${f.file}: channel count`);
    assert.equal(wav.sampleRate, f.sampleRate, `${f.file}: sample rate`);

    // THE gate: the PCM is byte-for-byte the PCM that was measured.
    assert.equal(crypto.createHash('sha256').update(wav.data).digest('hex'), f.sha256,
      `${f.file}: PCM hash drifted from the manifest — re-run \`npm run bake:cues\``);

    const m = metrics(wav.data, wav.channels);
    assert.equal(m.frames, f.frames, `${f.file}: frame count`);
    assert.equal(m.peak, f.peak, `${f.file}: peak`);
    assert.equal(m.rms, f.rms, `${f.file}: rms`);
    assert.equal(Math.round(f.durationSec * f.sampleRate), f.frames, `${f.file}: durationSec vs frames`);
    assert.equal(Math.round(f.body60Sec * f.sampleRate), m.body, `${f.file}: body60Sec`);
  }
});

test('the bake directory holds exactly the manifest and nothing stale', () => {
  const onDisk = fs.readdirSync(DIR).filter((n) => n.endsWith('.wav')).sort();
  const declared = allFiles().map((f) => f.file).sort();
  assert.deepEqual(onDisk, declared,
    'a WAV on disk is not in the manifest (or vice versa) — a renamed cue left an orphan');
});

test('every cue is audible, unclipped, and the sustained voices loop cleanly', () => {
  for (const f of allFiles()) {
    // Silence here would mean a cue rendered into a disconnected graph — the
    // exact failure the baker's noise priming risks if it ever stops priming.
    assert.ok(f.peak > 0.05, `${f.file}: peak ${f.peak} — did this render silence?`);
    assert.ok(f.peak < 1, `${f.file}: peak ${f.peak} — clipped`);
    assert.ok(f.rms > 0.005, `${f.file}: rms ${f.rms} — essentially empty`);
  }
  // The four noise-bed voices all run off cues.js's cached 1 s noise buffer, and
  // their LFOs (corner 6 Hz, brake 11 Hz) are integer Hz. A loop of exactly
  // ctx.sampleRate frames therefore closes on both the buffer period AND LFO
  // phase 0 — which is the whole reason these bake to seamless loops at all. Any
  // other length would click on every repeat.
  for (const [id, cue] of Object.entries(manifest.cues)) {
    if (cue.kind !== 'sustained') continue;
    assert.equal(cue.loop, true, `${id}: sustained voices loop`);
    for (const s of cue.stops) {
      assert.equal(s.frames, s.sampleRate * manifest.loopSeconds,
        `${id}/${s.file}: a loop must be a whole number of seconds or its LFO phase jumps at the seam`);
      assert.equal(s.channels, 1, `${id}/${s.file}: the noise beds are mono`);
    }
  }
});

test('the sample-backed cues point at the shipped recordings, unaltered', () => {
  for (const [id, cue] of Object.entries(manifest.cues)) {
    if (cue.kind !== 'passthrough') continue;
    const src = path.join(ROOT, cue.source);
    assert.ok(fs.existsSync(src), `${id}: ${cue.source} is gone`);
    const buf = fs.readFileSync(src);
    assert.equal(buf.length, cue.bytes, `${id}: ${cue.source} changed size`);
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), cue.sha256,
      `${id}: ${cue.source} changed — the manifest describes a different recording`);
    // These are not baked, so a shell has to run their level curves live. Losing
    // that description is losing the cue.
    assert.ok(cue.playback.liveDsp, `${id}: passthrough cues must describe the DSP that stays live`);
  }
});

test('the manifest was baked from DEFAULT_PICKS, not a gallery override', async () => {
  const { DEFAULT_PICKS, CUES } = await import(pathToFileURL(CUES_JS).href);
  // Baking closes the localStorage override path deliberately: a dev machine's
  // starred audition pick must never reach a shipped sample.
  for (const [id, cue] of Object.entries(manifest.cues)) {
    assert.equal(cue.variant, DEFAULT_PICKS[id],
      `${id}: baked variant '${cue.variant}' is not the committed default '${DEFAULT_PICKS[id]}'`);
  }
  // And the palette is whole — a cue in cues.js with no manifest entry is a cue
  // the native shells would simply have no sound for.
  for (const c of CUES) {
    assert.ok(manifest.cues[c.id], `cue '${c.id}' exists in cues.js but was never baked`);
  }
});

test('the jitter spread the manifest promises is the spread cues.js actually rolls', async () => {
  const { DEFAULT_PICKS } = await import(pathToFileURL(CUES_JS).href);
  const { variantBlock, rolledJitter } = await cueSource();
  const src = cueSrc();

  for (const [id, cue] of Object.entries(manifest.cues)) {
    const block = variantBlock(src, id, DEFAULT_PICKS[id]);
    assert.ok(block !== null, `${id}/${DEFAULT_PICKS[id]}: not found in cues.js`);
    const rolled = rolledJitter(block);
    const promised = cue.playback.jitter ? cue.playback.jitter.spread : null;
    if (promised === null) {
      assert.equal(rolled.length, 0,
        `${id}: cues.js jitters by ±${rolled} but the manifest declares none — baked fires would never vary`);
    } else {
      assert.deepEqual(rolled, [promised],
        `${id}: cues.js jitters by ±${rolled}, the manifest promises ±${promised} — re-bake`);
      // The rate range is what a player multiplies by; it must be the spread.
      assert.deepEqual(cue.playback.jitter.rateRange.map((x) => Math.round(x * 1e6) / 1e6),
        [-promised, promised].map((s) => Math.round(2 ** (s / 12) * 1e6) / 1e6),
        `${id}: rateRange does not match spread ±${promised}`);
    }
  }
});

// THE GATE THIS FILE WAS MISSING. Everything above re-derives the manifest from
// the PCM, so a bake and a manifest that were made together always agree —
// including about a cue cues.js no longer makes. The bake is only valid for one
// state of cues.js, and that state is recorded as a hash, exactly the way
// BUILD_STAMP.json records the wasm's sources.
//
// If this goes red the samples are STALE, not corrupt: someone retuned a cue (or
// a shared helper) and the committed WAVs are still the old sound. `npm run
// bake:cues` is the fix. It is deliberately blunt — a comment or a label inside a
// picked variant block counts as a change — because a hash cannot know which
// edits are audible, and the failure it replaces was silent.
test('the manifest is a bake of the cues.js that is in the tree', async () => {
  const { DEFAULT_PICKS } = await import(pathToFileURL(CUES_JS).href);
  const { sourceHashes } = await cueSource();

  assert.ok(manifest.source, 'manifest.source is missing — re-bake (this is a v2 manifest field)');
  assert.equal(manifest.source.file, 'public/display/audio/cues.js');

  const now = sourceHashes(cueSrc(), DEFAULT_PICKS, Object.keys(manifest.cues));
  assert.equal(now.shared, manifest.source.sharedSha256,
    'the shared DSP in cues.js (jitter, the noise buffer, tone/noise/pluck/knock/pop/tremTone, '
    + 'playSample, DEFAULT_PICKS) changed since the bake — every WAV in the palette is stale. '
    + 'Re-run `npm run bake:cues`.');
  for (const [id, cue] of Object.entries(manifest.cues)) {
    assert.equal(now.variants[id], cue.sourceSha256,
      `${id}: its picked variant '${cue.variant}' changed in cues.js since the bake — the committed `
      + `sample is a sound the game no longer makes. Re-run \`npm run bake:cues\`.`);
  }
});

// The sustained voices ship as unit-gain TIMBRES: the baker divides the voice's
// analytic gain out of the PCM and the manifest tells the player to re-apply it.
// That is the one number whose drift is invisible to every other check here —
// the PCM stays self-consistent, the metrics still reproduce, and every stop is
// simply the wrong loudness. So re-read it from cues.js, and compare NUMERICALLY
// rather than textually: `0.0001 + l * 0.8` and `0.0001 + 0.8 * l` are the same
// contract and a string compare would fight the source's formatting.
test('each sustained voice re-applies exactly the gain the bake divided out', async () => {
  const { DEFAULT_PICKS } = await import(pathToFileURL(CUES_JS).href);
  const { variantBlock, voiceSet, evalLevelExpr, LEVEL_PROBES } = await cueSource();
  const src = cueSrc();
  const round1 = (x) => Math.round(x * 10) / 10;

  let seen = 0;
  for (const [id, cue] of Object.entries(manifest.cues)) {
    if (cue.kind !== 'sustained') continue;
    seen++;
    const set = voiceSet(variantBlock(src, id, DEFAULT_PICKS[id]), id);

    for (const l of LEVEL_PROBES) {
      assert.ok(Math.abs(evalLevelExpr(cue.playback.gainFormula, l) - evalLevelExpr(set.gainExpr, l)) < 1e-12,
        `${id}: the manifest tells a player to apply '${cue.playback.gainFormula}' but cues.js applies `
        + `'${set.gainExpr}' — at level ${l} every committed stop is the wrong loudness by that ratio`);
    }
    assert.equal(cue.playback.smoothTauSec, set.gainTau,
      `${id}: gain smoothing is ${set.gainTau}s in cues.js, ${cue.playback.smoothTauSec}s in the manifest`);

    // …and the stops themselves: each level stop claims a filter setting, and
    // that claim is what tells a player which two stops to crossfade. It has to
    // be the sweep cues.js schedules, sampled at that stop's level.
    for (const f of set.freqs) {
      const describedBy = Object.keys(cue.stops[0]).filter((k) => typeof cue.stops[0][k] === 'number'
        && cue.stops.every((s) => s[k] === round1(evalLevelExpr(f.expr, s.level))));
      assert.ok(describedBy.length,
        `${id}: cues.js sweeps ${f.node}.frequency to '${f.expr}', and no stop parameter tracks it — `
        + `the stops describe a filter the voice does not have`);
    }
  }
  assert.ok(seen >= 4, `expected every sustained voice, saw ${seen}`);
});
