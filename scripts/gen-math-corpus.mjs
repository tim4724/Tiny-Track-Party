// Generates tests/fixtures/math-corpus.jsonl — the bit-exact conformance
// corpus for the deterministic mathlib (engine/math.js, fdlibm WASM).
//
// The corpus is the cross-build contract: the JS side asserts against it in
// tests/mathlib.test.js, and the native C++ build (libttp-sim's mathlib,
// compiled from the SAME vendored sources) must reproduce every line
// bit-for-bit on every platform. It catches wasm rebuild drift (new emsdk,
// changed flags) and native-compiler drift (FMA contraction, fast-math,
// libcall constant folding) alike.
//
// Values are stored as 16-hex-digit IEEE-754 bit patterns (big-endian), so
// the file is language-neutral and exact. NaN outputs are canonicalized to
// the string "nan": WASM canonicalizes NaN payloads, native hardware may
// propagate them differently, and no NaN ever reaches the sim's byte path —
// so NaN is compared as a class, never as a payload.
//
// Deterministic: adversarial cases are fixed lists, random cases are
// mulberry32-seeded. Re-running against the same WASM build reproduces the
// file byte-for-byte.
//
// Usage: node scripts/gen-math-corpus.mjs [--out=tests/fixtures/math-corpus.jsonl]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dmath from '../public/display/engine/math.js';
import { mulberry32 } from '../public/display/engine/util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6)
  || path.join(ROOT, 'tests/fixtures/math-corpus.jsonl');

const view = new DataView(new ArrayBuffer(8));
function toHex(x) {
  if (Number.isNaN(x)) return 'nan';
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}
function fromBits(hi, lo) { // build a double from 32-bit halves
  view.setUint32(0, hi >>> 0);
  view.setUint32(4, lo >>> 0);
  return view.getFloat64(0);
}
const nextAfter = (x, dir) => { // toward +/-Infinity by one ulp
  if (!Number.isFinite(x) || x === 0) return x;
  view.setFloat64(0, x);
  let bits = view.getBigUint64(0);
  const up = dir > 0;
  bits += (x > 0) === up ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
};

const PI = Math.PI;
const SPECIALS = [
  0, -0, 1, -1, 0.5, -0.5, 2, -2,
  Infinity, -Infinity, NaN,
  Number.MIN_VALUE, -Number.MIN_VALUE,           // min subnormal
  fromBits(0x000fffff, 0xffffffff),              // max subnormal
  fromBits(0x00100000, 0x00000000),              // DBL_MIN
  Number.MAX_VALUE, -Number.MAX_VALUE,
  Number.EPSILON, 1 + Number.EPSILON, 1 - Number.EPSILON / 2
];

// Near-k*(pi/2) cases: argument reduction is fdlibm's hardest path.
const nearPiHalves = [];
for (const k of [1, 2, 3, 4, 6, 100, 1001, 1e6 + 1]) {
  const x = k * (PI / 2);
  nearPiHalves.push(x, nextAfter(x, 1), nextAfter(x, -1), -x);
}
// Huge-argument reduction (multi-precision __kernel_rem_pio2 path).
const hugeArgs = [1e10, 1e16, 1e22, 1e300, 2 ** 1000, 6381956970095103 * 2 ** 797]; // last: famously worst-case reduction

function* domainCases(fn) {
  switch (fn) {
    case 'sin': case 'cos':
      yield* SPECIALS; yield* nearPiHalves; yield* hugeArgs;
      yield 1e-8; yield 0.1; yield 0.7853981633974483; // pi/4
      break;
    case 'exp': {
      yield* SPECIALS;
      // Bit-exact fdlibm thresholds, each with both ulp neighbours: o_threshold
      // (largest finite result) and u_threshold (exp = smallest subnormal;
      // note the nearest decimal literal -745.1332191019412 is 1 ulp BELOW it
      // and lands in the underflow-to-zero branch instead).
      const oThresh = fromBits(0x40862E42, 0xFEFA39EF);
      const uThresh = fromBits(0xC0874910, 0xD52D3051);
      for (const knee of [oThresh, uThresh]) {
        yield knee; yield nextAfter(knee, 1); yield nextAfter(knee, -1);
      }
      yield -708.3964185322641; // subnormal-result band
      yield 0.6931471805599453; yield 1e-10; yield -1e-10;
      break;
    }
    default:
      yield* SPECIALS;
  }
}

// Two-argument adversarial grids.
function* pairCases(fn) {
  if (fn === 'atan2') {
    for (const y of [0, -0, 1, -1, Infinity, -Infinity, NaN, Number.MIN_VALUE, 1e300])
      for (const x of [0, -0, 1, -1, Infinity, -Infinity, NaN, Number.MIN_VALUE, 1e300])
        yield [y, x];
  } else if (fn === 'pow') {
    const xs = [0, -0, 1, -1, 2, -2, 0.5, -0.5, 10, Infinity, -Infinity, NaN,
      1 + Number.EPSILON, 1 - Number.EPSILON / 2, Number.MAX_VALUE, Number.MIN_VALUE];
    const ys = [0, -0, 1, -1, 2, 3, -2, 0.5, -0.5, 1.5, 100, -100, 1e15, -1e15,
      Infinity, -Infinity, NaN, Number.EPSILON];
    for (const x of xs) for (const y of ys) yield [x, y];
  } else if (fn === 'hypot') {
    const vs = [0, -0, 3, 4, 1e-300, 1e300, 1.3e308, Number.MIN_VALUE, Number.MAX_VALUE,
      Infinity, -Infinity, NaN, 1, Number.EPSILON];
    for (const a of vs) for (const b of vs) yield [a, b];
  }
}

// Seeded random sweeps: full-exponent-range doubles plus domain-typical values.
function randDouble(rand, expLo, expHi) {
  const m = rand() * 2 - 1;
  const e = Math.floor(expLo + rand() * (expHi - expLo));
  return m * 2 ** e;
}
function* randomCases(fn, n) {
  const rand = mulberry32(0xD37E12A9 ^ fn.length * 2654435761);
  for (let i = 0; i < n; i++) {
    switch (fn) {
      case 'sin': case 'cos': {
        const pick = i % 3;
        yield pick === 0 ? rand() * 4 * PI - 2 * PI
          : pick === 1 ? randDouble(rand, -30, 30)
          : randDouble(rand, 30, 1000);
        break;
      }
      case 'exp': yield rand() * 1500 - 750; break;
      case 'atan2': yield [randDouble(rand, -300, 300), randDouble(rand, -300, 300)]; break;
      case 'pow': {
        const x = Math.abs(randDouble(rand, -60, 60));
        const y = rand() * 200 - 100;
        yield [x, i % 4 === 0 ? Math.round(y) : y];
        break;
      }
      case 'hypot': yield [randDouble(rand, -520, 520), randDouble(rand, -520, 520)]; break;
    }
  }
}

const ONE_ARG = { sin: 1, cos: 1, exp: 1 };
const RANDOM_N = 600;
const lines = [];
for (const fn of ['sin', 'cos', 'atan2', 'exp', 'pow', 'hypot']) {
  const seen = new Set();
  const emit = (args) => {
    const ins = args.map(toHex);
    const key = ins.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    const out = toHex(dmath[fn](...args));
    lines.push(JSON.stringify({ f: fn, i: ins, o: out }));
  };
  if (ONE_ARG[fn]) {
    for (const x of domainCases(fn)) emit([x]);
    for (const x of randomCases(fn, RANDOM_N)) emit([x]);
  } else {
    for (const p of pairCases(fn)) emit(p);
    for (const p of randomCases(fn, RANDOM_N)) emit(p);
  }
}

const header = JSON.stringify({ mathlib: dmath.MATHLIB, cases: lines.length, format: 'hex64 big-endian; nan = canonical NaN class' });
fs.writeFileSync(OUT, header + '\n' + lines.join('\n') + '\n');
console.log(`${OUT}: ${lines.length} cases (${dmath.MATHLIB})`);
