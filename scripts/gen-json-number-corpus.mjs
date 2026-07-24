// Generates tests/fixtures/json-number-corpus.jsonl — the oracle for the C++
// canonical serializer (Track S M3). The replay CLI must reproduce
// JSON.stringify's number formatting BYTE-exactly (ECMA-262 Number::toString:
// shortest round-tripping decimal, integer forms without ".0", exponent form
// only outside [1e-6, 1e21)) or every canonical-JSON snapshot hash diverges.
// The C++ side implements this over vendored google/double-conversion and
// replays this corpus bit-for-bit before the sim port ever runs.
//
// Line format: {"i":"<hex64 bit pattern>","o":"<JSON.stringify output>"}
//
// Inputs: every distinct double appearing in the committed trace fixtures and
// the trackbuilder corpus inputs (the REAL serialization surface), plus
// adversarial forms: ±0, integer-valued doubles, the 1e-6/1e21 exponent-form
// thresholds ±ulp, subnormals, MAX_VALUE, 2^53±1, classic shortest-repr
// torture values, and seeded random full-range doubles.
//
// Deterministic: re-runs byte-identical against the same fixture set.
// Usage: node scripts/gen-json-number-corpus.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../public/display/engine/util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/json-number-corpus.jsonl');
const TRACE_DIR = path.join(ROOT, 'tests/fixtures/traces');

const view = new DataView(new ArrayBuffer(8));
const toHex = (x) => {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
const nextAfter = (x, dir) => {
  view.setFloat64(0, x);
  let bits = view.getBigUint64(0);
  bits += (x > 0) === (dir > 0) ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
};

const values = new Map(); // hex -> number (dedup on bit pattern: keeps -0 distinct)
const add = (x) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) return; // JSON has no NaN/Inf
  const h = toHex(x);
  if (!values.has(h)) values.set(h, x);
};
const walk = (v) => {
  if (typeof v === 'number') add(v);
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
};

// 1. The real surface: every number in every committed trace fixture.
for (const f of fs.readdirSync(TRACE_DIR).filter((f) => f.endsWith('.jsonl'))) {
  for (const line of fs.readFileSync(path.join(TRACE_DIR, f), 'utf8').split('\n')) {
    if (line.trim()) walk(JSON.parse(line));
  }
}

// 2. Adversarial forms.
[0, -0, 1, -1, 0.5, 0.1, 2 / 3,
  Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, 2 ** 53, 2 ** 53 + 2,
  Number.MAX_VALUE, Number.MIN_VALUE, 5e-324, 2.225073858507201e-308,
  9007199254740993, 4.35, 1.005, 765.4321e-24, 5.960464477539063e-8,
  1e21, nextAfter(1e21, -1), nextAfter(1e21, 1),
  1e-6, nextAfter(1e-6, -1), nextAfter(1e-6, 1),
  1e-7, 0.000001, 0.0000001, 123456789012345678901, 1e300, -1e300,
  16.667, 16.667 / 1000, 0.05, 1 / 3, 1 / 7].forEach(add);

// 3. Seeded random sweep: full exponent range + integer-valued + small-frac.
const rand = mulberry32(0x5EED5EED);
for (let i = 0; i < 3000; i++) {
  const m = rand() * 2 - 1;
  const e = Math.floor(rand() * 640) - 320;
  add(m * 2 ** e);
  if (i % 3 === 0) add(Math.floor(rand() * 2 ** 40) * (rand() < 0.5 ? -1 : 1));
  if (i % 5 === 0) add(Math.floor(rand() * 1e6) / 1000);
}

const hexes = [...values.keys()].sort();
const lines = hexes.map((h) => JSON.stringify({ i: h, o: JSON.stringify(values.get(h)) }));
const header = JSON.stringify({ cases: lines.length, note: 'ECMA-262 Number::toString via JSON.stringify; -0 serializes as "0"' });
fs.writeFileSync(OUT, header + '\n' + lines.join('\n') + '\n');
console.log(`${OUT}: ${lines.length} cases`);
