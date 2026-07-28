// What the baked cue palette is a bake OF — read straight out of
// public/display/audio/cues.js, by ONE piece of code that both the baker and
// tests/bake-cues.test.js call.
//
// WHY THIS FILE EXISTS. The bake divides each sustained voice's analytic gain
// out of the committed PCM (the file is the unit-gain TIMBRE; the player
// re-applies the gain continuously). That means the numbers `0.14 * l`,
// `420 + l * 480`, `1200 + l * 350` and their taus are LOAD-BEARING on the
// bytes, and until this file existed they were hand-copied into a table in
// scripts/bake-cues.mjs. Retune a voice in cues.js and the committed WAVs are
// wrong by exactly that factor, with nothing red: the baker's audit only
// checked jitter spreads, and the test re-derives its metrics FROM the PCM, so
// both agree with each other about a wrong answer.
//
// Two mechanisms fix that class, not the instance:
//
//   1. DERIVE, don't copy. `voiceSet()` parses the picked variant's set(level)
//      body and returns the gain expression, its tau, and every filter target
//      that moves with level. The baker divides by the expression it just read
//      out of cues.js, so there is no second copy of it to drift.
//
//   2. HASH what cannot be derived. `sourceHashes()` fingerprints the shared
//      DSP prelude (jitter, noiseBuf, tone/noise/pluck/knock/pop/tremTone,
//      playSample, DEFAULT_PICKS) plus each baked cue's PICKED VARIANT block,
//      and the baker writes those into manifest.json. The test recomputes them
//      from cues.js and demands the manifest's. This is the same trick the wasm
//      uses (BUILD_STAMP.json's source hash) and it has the same bluntness:
//      a comment or a label edit inside a variant block counts as a change and
//      wants a re-bake. That is the deliberate trade — a hash cannot know which
//      edits are audible, and the failure it is guarding against is silent.
//
// Everything here is a pure function of the file's TEXT. No cues.js import, no
// evaluation of the module: a parse that runs the synthesis to inspect it would
// need WebAudio, which is the whole reason baking needs a browser.

import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// Where the cue table starts. Everything above it is the shared DSP every
// variant calls; everything below is per-cue and gets sliced per variant.
const TABLE_MARKER = '\nexport const CUES = [';

// Cue ids sit at 4 spaces of indent, variant ids at 8 — enough to slice the
// file into "this cue" and then "this variant" without parsing JS.
function spans(src, indent) {
  const out = [];
  const re = new RegExp(`\\n {${indent}}id: '([a-z_0-9]+)'`, 'g');
  let m;
  while ((m = re.exec(src))) out.push({ id: m[1], at: m.index });
  return out;
}

function sliceOf(list, id, from, to) {
  const i = list.findIndex((s) => s.id === id && s.at >= from && s.at < to);
  if (i < 0) return null;
  const next = list[i + 1];
  return { from: list[i].at, to: Math.min(next ? next.at : to, to) };
}

// The picked variant's block, as text. `null` when either id is missing, so
// callers can report which one rather than crashing on an undefined slice.
export function variantBlock(src, cueId, variantId) {
  const cue = sliceOf(spans(src, 4), cueId, 0, src.length);
  if (!cue) return null;
  const v = sliceOf(spans(src, 8), variantId, cue.from, cue.to);
  if (!v) return null;
  return src.slice(v.from, v.to);
}

// Everything above the cue table: the note palette, jitter(), the cached noise
// buffer, sample loading/playback, every synthesis helper, and DEFAULT_PICKS.
// A variant block is meaningless without it — `pluck(ctx, dest, t, E5, 0.3)`
// says nothing about what pluck sounds like.
export function sharedPrelude(src) {
  const i = src.indexOf(TABLE_MARKER);
  if (i < 0) throw new Error('cues.js: no `export const CUES = [` — the slicer is out of date');
  return src.slice(0, i);
}

// { shared, variants: { cueId: sha } } for the cues asked about. `picks` is
// DEFAULT_PICKS (the bake ignores the gallery's localStorage overrides).
export function sourceHashes(src, picks, cueIds) {
  const variants = {};
  const missing = [];
  for (const id of [...cueIds].sort()) {
    const block = variantBlock(src, id, picks[id]);
    if (block === null) { missing.push(`${id}/${picks[id]}`); continue; }
    variants[id] = sha256(block);
  }
  if (missing.length) throw new Error('cues.js: no such cue/variant: ' + missing.join(', '));
  return { shared: sha256(sharedPrelude(src)), variants };
}

// The jitter() spreads a variant block rolls, deduped and sorted. [] means the
// cue never detunes, which the manifest must agree with.
export function rolledJitter(block) {
  return [...new Set([...block.matchAll(/jitter\(([^)]*)\)/g)]
    .map((c) => (c[1].trim() === '' ? 1 : parseFloat(c[1]))))].sort((a, b) => a - b);
}

// ── sustained voices: what set(level) actually does ──────────────────────────

// Arithmetic over `l` only. Everything a cue's set() has ever contained is a
// literal-and-l expression, and anything else must fail loudly rather than be
// silently mis-transcribed — so the character class is the gate, not a
// best-effort parse.
const SAFE_EXPR = /^[-+*/(). \t0-9l]+$/;

export function evalLevelExpr(expr, l) {
  if (!SAFE_EXPR.test(expr)) throw new Error(`cues.js: level expression is not plain arithmetic: ${expr}`);
  return Function('l', `"use strict"; return (${expr});`)(l);
}

// Parse the picked variant's set(level) body.
//
// Returns { gainExpr, gainTau, freqs: [{ node, expr, tau }] }. The gain is the
// one the bake DIVIDES OUT, so a missing or unparseable one is fatal; the
// frequency targets are what the level stops exist to sample, and are returned
// so the caller can cross-check its own stop table against them.
export function voiceSet(block, cueId = 'cue') {
  const start = block.indexOf('set(level)');
  if (start < 0) throw new Error(`${cueId}: the picked variant has no set(level) — is it a sustained voice?`);
  // stop() closes the returned handle; a gain ramp lives in both, and only
  // set()'s is level-driven.
  const stop = block.indexOf('stop()', start);
  const body = block.slice(start, stop < 0 ? block.length : stop);

  const g = body.match(/\bout\.gain\.setTargetAtTime\(\s*([^;]*?)\s*,\s*at\s*,\s*([0-9.]+)\s*\)/);
  if (!g) throw new Error(`${cueId}: could not read out.gain.setTargetAtTime(...) out of set(level)`);

  const freqs = [];
  for (const m of body.matchAll(/\b(\w+)\.frequency\.setTargetAtTime\(\s*([^;]*?)\s*,\s*at\s*,\s*([0-9.]+)\s*\)/g)) {
    freqs.push({ node: m[1], expr: m[2], tau: parseFloat(m[3]) });
  }
  return { gainExpr: g[1], gainTau: parseFloat(g[2]), freqs };
}

// Probe levels for comparing two expressions of level. Spans the whole domain
// including both ends, so an offset and a slope both show up.
export const LEVEL_PROBES = [0, 0.02, 0.25, 0.5, 0.7, 0.75, 1];

// Does `expr` agree with `fn` at every probe? Used both ways round: the baker
// checks its filter-stop table against cues.js, the test checks the manifest's
// gainFormula against cues.js.
export function agrees(expr, fn, eps = 1e-9) {
  return LEVEL_PROBES.every((l) => Math.abs(evalLevelExpr(expr, l) - fn(l)) <= eps);
}
