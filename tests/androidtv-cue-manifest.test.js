// The Android cue bank reads the BAKE'S MANIFEST, and `org.json` will not tell it
// when it reads a key wrong.
//
// This is the `optString`-reads-null trap's cousin, and it shipped: the detune
// spread was read as `playback.optDouble("jitter", 0.0)`, but `jitter` is an
// OBJECT (`{spread, playbackRate, rateRange}`). `optDouble` cannot coerce a
// JSONObject, so it returned the fallback for all sixteen cues and this shell
// never detuned anything — `screech`, which fires about seven times a second,
// was a machine gun of one identical sample for the life of the port. Nothing
// failed, nothing logged, and NEITHER SIBLING SHELL CAN SHOW YOU IT: Swift and JS
// both read the object.
//
// So the gate is static and it runs both ways. It pins the SHAPES the Kotlin
// depends on, so a manifest that changes one fails here instead of going silent
// on a TV; and it derives the ENGINE's constants from the Kotlin itself and holds
// them to the manifest's prose, so a retuned bake cannot leave the shell playing
// last year's voicing. There is no ctest anywhere near a device half — the `audio`
// corpus covers the DECISIONS only — which is exactly why this file is worth its
// length.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const KOTLIN = join(ROOT, 'shells/androidtv/app/src/main/kotlin/com/couchgames/tinytrackparty');
const manifest = JSON.parse(
  readFileSync(join(ROOT, 'public/assets/audio/cues/manifest.json'), 'utf8'));
const cues = manifest.cues;
const cueBank = readFileSync(join(KOTLIN, 'CueBank.kt'), 'utf8');

/**
 * Kotlin with its comments removed.
 *
 * Needed rather than tidy: the files that explain a trap QUOTE the wrong code
 * while describing it, so a scan of the raw text finds the warning and reports it
 * as the offence.
 */
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const byKind = (kind) => Object.entries(cues).filter(([, e]) => e.kind === kind);

test('the manifest is the schema version CueBank says it reads', () => {
  const declared = /cue manifest is schema v\$version, this shell reads v(\d+)/.exec(cueBank);
  assert.ok(declared, 'CueBank no longer states which schema version it reads');
  assert.equal(manifest.version, Number(declared[1]),
    'the bake\'s manifest schema moved. A reader that guessed would mis-tune every '
    + 'voice silently — read the new shape and bump the version CueBank checks.');
});

test('every one-shot\'s jitter is an OBJECT with a numeric spread', () => {
  // THE SHAPE IS THE POINT. `spread` is in SEMITONES and the device applies
  // `2^(U(-spread, +spread)/12)`; a reader that takes `jitter` as a number gets
  // 0.0 from org.json and detunes nothing.
  for (const [id, entry] of byKind('one-shot')) {
    const jitter = entry.playback?.jitter;
    if (jitter === null || jitter === undefined) continue;   // rocket_hit: no detune at all
    assert.equal(typeof jitter, 'object',
      `cue '${id}': playback.jitter is ${typeof jitter}, not an object — `
      + 'CueBank reads it with optJSONObject and would silently get nothing');
    assert.equal(typeof jitter.spread, 'number',
      `cue '${id}': playback.jitter.spread is not a number`);
  }
});

test('no Kotlin file reads jitter as a number', () => {
  // The exact regression, named. `optDouble("jitter")` compiles, runs, and is
  // wrong on every cue.
  const offenders = [];
  for (const f of readdirSync(KOTLIN).filter((n) => n.endsWith('.kt'))) {
    const src = codeOf(readFileSync(join(KOTLIN, f), 'utf8'));
    for (const m of src.matchAll(/opt(Double|Int|Long|String)\s*\(\s*"jitter"/g)) {
      offenders.push(`${f}: opt${m[1]}("jitter")`);
    }
  }
  assert.deepEqual(offenders, [],
    'jitter is an OBJECT — read it with optJSONObject("jitter") and take its '
    + '`spread`:\n  ' + offenders.join('\n  '));
});

test('every sustained cue carries what the stops player needs', () => {
  // `linearFormula`, transcribed from CueBank.kt. The device refuses a formula it
  // cannot parse rather than approximating it, so a manifest that grows a
  // non-linear gain makes a voice silent — catch it here instead.
  const linear = (text) => {
    let a = 0, b = 0;
    for (const term of text.split('+')) {
      const f = term.split('*').map((s) => s.trim()).filter(Boolean);
      if (f.length === 1 && f[0] === 'l') b += 1;
      else if (f.length === 1) { const v = Number(f[0]); if (!Number.isFinite(v)) return null; a += v; }
      else if (f.length === 2 && f[0] === 'l') { const v = Number(f[1]); if (!Number.isFinite(v)) return null; b += v; }
      else if (f.length === 2 && f[1] === 'l') { const v = Number(f[0]); if (!Number.isFinite(v)) return null; b += v; }
      else return null;
    }
    return [a, b];
  };

  for (const [id, entry] of byKind('sustained')) {
    const p = entry.playback ?? {};
    assert.equal(typeof p.gainFormula, 'string', `cue '${id}': no gainFormula string`);
    assert.ok(linear(p.gainFormula),
      `cue '${id}': gainFormula '${p.gainFormula}' is not linear in l, so the `
      + 'Android device cannot play it at all — it logs and goes silent');
    assert.equal(typeof p.smoothTauSec, 'number', `cue '${id}': no numeric smoothTauSec`);
    assert.equal(typeof p.levelFloor, 'number', `cue '${id}': no numeric levelFloor`);
    assert.ok(Array.isArray(entry.stops) && entry.stops.length > 0, `cue '${id}': no stops`);
    for (const s of entry.stops) {
      assert.equal(typeof s.level, 'number', `cue '${id}': a stop has no numeric level`);
      assert.equal(typeof s.file, 'string', `cue '${id}': a stop has no file`);
      // ONE read position feeds both stops of a crossfade, which is what the
      // manifest's "sample-aligned" asks for — and it is only correct while every
      // stop is the same length at the same rate.
      assert.equal(s.frames, entry.stops[0].frames,
        `cue '${id}': stop '${s.file}' is a different length from the first. The `
        + 'crossfade reads both at ONE position and would tear.');
      assert.equal(s.sampleRate, entry.stops[0].sampleRate,
        `cue '${id}': stop '${s.file}' is at a different rate from the first`);
    }
  }
});

test('the engine\'s live DSP still says what CueBank transcribed', () => {
  // The one cue whose numbers are NOT in the manifest's machine-readable half:
  // the filter cannot be baked, because playbackRate is the RPM and shifts the
  // filtered spectrum with it. So the constants live in Kotlin and the manifest
  // states them in prose — and this holds the two together. Derived from the
  // Kotlin, so nobody has to remember to update a list here.
  const block = /private val ENGINE_PROSE = listOf\(([\s\S]*?)\)\n/.exec(codeOf(cueBank));
  assert.ok(block, 'CueBank.ENGINE_PROSE has moved — this check reads it by name');
  const fragments = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(fragments.length >= 5, 'ENGINE_PROSE looks empty');

  const [id, entry] = byKind('passthrough')[0];
  const prose = entry.playback?.liveDsp ?? '';
  for (const f of fragments) {
    assert.ok(prose.includes(f),
      `cue '${id}': liveDsp no longer says '${f}'. The bake was retuned and `
      + 'CueBank\'s ENG_* constants are now last year\'s voicing — update both.');
  }
});

test('the countdown is the only cue whose file ORDER is load bearing', () => {
  // `TTP_AUD_F_GO` picks index 1, and the bank orders by NAME (`_go` last) rather
  // than trusting the array, because which one is the GO beat is a fact about the
  // file. That only works while exactly one file is tagged so.
  const [, countdown] = byKind('one-shot').find(([id]) => id === 'countdown');
  const files = countdown.files.map((f) => f.file);
  assert.equal(files.length, 2, 'the countdown no longer has exactly two beats');
  assert.equal(files.filter((f) => f.includes('_go')).length, 1,
    'exactly one countdown file must be named `_go` — the bank puts it last and '
    + 'the GO flag reads index 1');
  for (const [id, entry] of byKind('one-shot')) {
    if (id === 'countdown') continue;
    assert.equal((entry.files ?? []).length, 1,
      `cue '${id}': a one-shot other than the countdown grew a second file, which `
      + 'no code picks between');
  }
});
