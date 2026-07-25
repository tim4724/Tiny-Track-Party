// Generates tests/fixtures/track-sampler-corpus.jsonl — the bit-exact oracle
// for the C++ Centerline port (libttp-track), per docs/native-port/plan.md
// Track S step 2: track-math mismatches must isolate in a standalone sampler
// harness before whole-race trace replay ever runs.
//
// Format (all doubles as 16-hex-digit big-endian bit patterns, like
// math-corpus.jsonl, so the C++ check needs no JSON number parsing or
// serialization — decouples this gate from the double-conversion milestone):
//
//   line 1   {"tracks":[...], "cases": N, "mathlib": ...}
//   then per track ONE line:
//     {"track": id, "length": hex, "samples":[[pos3,tangent3,up3,lateral3,
//       width,s] as flat hex arrays...]}   — the Centerline INPUT, verbatim
//   then case lines:
//     {"track": id, "q":"sample",  "s": hex, "out":[pos3,tangent3,up3,
//       lateral3, width] flat hex}
//     {"track": id, "q":"width",   "s": hex, "out":[width]}
//     {"track": id, "q":"project", "p": hex3, "sHint": hex, "maxStep": hex,
//       "out":[s, lat]}
//
// Adversarial s coverage: exact knot arclengths (binary-search tie edges),
// ±1 ulp around knots, the wrap seam (0, length, ±ulp), negative s, many-lap
// wraps, and projectNear with clamping windows (maxStep small enough to
// engage the strand clamp) — the exact cases plan.md names.
//
// Deterministic: mulberry32-seeded; re-runs are byte-identical.
//
// Usage: node scripts/gen-track-sampler-corpus.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRaceTrack } from './oracle-lib.mjs';
import { mulberry32 } from '../public/display/engine/util.js';
import { MATHLIB } from '../public/display/engine/math.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/track-sampler-corpus.jsonl');

// One representative per track family, matching the trace-fixture set: flat
// catalogue (tidepool), stunt/loop (helix), long endgame (skysnake). Full
// every-track coverage arrives with buildTrack byte-conformance (the
// export-track-data dumps); this corpus pins the SAMPLER math.
const TRACK_IDS = ['tidepool', 'helix', 'skysnake'];

const view = new DataView(new ArrayBuffer(8));
const toHex = (x) => {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
const nextAfter = (x, dir) => {
  if (!Number.isFinite(x) || x === 0) return x;
  view.setFloat64(0, x);
  let bits = view.getBigUint64(0);
  bits += (x > 0) === (dir > 0) ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
};
const vec = (v) => [toHex(v.x), toHex(v.y), toHex(v.z)];
const frameOut = (f) => [...vec(f.pos), ...vec(f.tangent), ...vec(f.up), ...vec(f.lateral), toHex(f.width)];

const lines = [];
const trackLines = [];
let cases = 0;

for (const trackId of TRACK_IDS) {
  const track = buildRaceTrack(trackId, { laps: 3, seed: 1 });
  const cl = track.centerline;
  const len = cl.length;
  const n = cl.samples.length;

  trackLines.push(JSON.stringify({
    track: trackId,
    length: toHex(len),
    samples: cl.samples.map((sm) => [
      ...vec(sm.pos), ...vec(sm.tangent), ...vec(sm.up), ...vec(sm.lateral),
      toHex(sm.width), toHex(sm.s)
    ])
  }));

  const rand = mulberry32(0xBADC0DE ^ trackId.length * 2654435761);
  const emit = (obj) => { lines.push(JSON.stringify(obj)); cases++; };

  // sampleAt: knots, knot ulp-neighbours, seams, wraps, uniform randoms.
  const sValues = [];
  for (let k = 0; k < 40; k++) sValues.push(cl.samples[Math.floor(rand() * n)].s); // exact knots (tie edges)
  for (let k = 0; k < 10; k++) {
    const s = cl.samples[Math.floor(rand() * n)].s;
    sValues.push(nextAfter(s, 1), nextAfter(s, -1));
  }
  sValues.push(0, -0, len, nextAfter(len, 1), nextAfter(len, -1), 1e-9, -1e-9,
    -len * 0.3, len * 2.5, len * 1000 + 7.25, -len * 41 - 3.5);
  for (let k = 0; k < 60; k++) sValues.push(rand() * len);
  for (const s of sValues) {
    emit({ track: trackId, q: 'sample', s: toHex(s), out: frameOut(cl.sampleAt(s)) });
  }

  // widthAt through the pooled probe (same math, width-only surface).
  for (let k = 0; k < 20; k++) {
    const s = rand() * len;
    emit({ track: trackId, q: 'width', s: toHex(s), out: [toHex(cl.widthAt(s))] });
  }

  // projectNear: points offset laterally (and slightly off-plane) from known
  // frames; hints displaced up to ±2 units; maxStep windows chosen so the
  // clamp genuinely engages on some cases (0.5, 1e-3) and not on others (4).
  const MAX_STEPS = [4, 0.5, 1e-3];
  for (let k = 0; k < 60; k++) {
    const s0 = rand() * len;
    const f = cl.sampleAt(s0);
    const lat = (rand() * 2 - 1) * 2.2;
    const bump = (rand() * 2 - 1) * 0.15;
    const p = f.pos.clone().addScaledVector(f.lateral, lat).addScaledVector(f.up, bump);
    const sHint = s0 + (rand() * 2 - 1) * 2;
    const maxStep = MAX_STEPS[k % MAX_STEPS.length];
    const r = cl.projectNear(p, sHint, maxStep);
    emit({
      track: trackId, q: 'project',
      p: vec(p), sHint: toHex(sHint), maxStep: toHex(maxStep),
      out: [toHex(r.s), toHex(r.lat)]
    });
  }
  // The seam: project from just before/after the lap line with an unwrapped
  // hint several laps in (lap counters accumulate s, never wrap).
  for (const [sPoint, sHint] of [[0.05, len * 3 + 0.02], [len - 0.05, len * 3 - 0.02], [0.05, -len + 0.1]]) {
    const f = cl.sampleAt(sPoint);
    const p = f.pos.clone().addScaledVector(f.lateral, 0.8);
    const r = cl.projectNear(p, sHint, 4);
    emit({
      track: trackId, q: 'project',
      p: vec(p), sHint: toHex(sHint), maxStep: toHex(4),
      out: [toHex(r.s), toHex(r.lat)]
    });
  }
}

const header = JSON.stringify({ tracks: TRACK_IDS, cases, mathlib: MATHLIB });
fs.writeFileSync(OUT, [header, ...trackLines, ...lines].join('\n') + '\n');
console.log(`${OUT}: ${cases} cases over ${TRACK_IDS.join(', ')} (${trackLines.map((l) => l.length).reduce((a, b) => a + b, 0)} bytes of sample data)`);
