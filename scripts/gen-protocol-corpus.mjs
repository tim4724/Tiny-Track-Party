// Generates tests/fixtures/protocol-corpus.jsonl — the oracle for the C++ twin
// of public/shared/protocol.js (the shared wire vocabulary + game constants).
//
// protocol.js is pure data + one pure function (carStats), so the oracle is a
// MANIFEST plus a carStats table, both read straight from the real module:
//   line 1  header
//   line 2  { constants: {...} }   every table/scalar the C++ header mirrors
//   line 3+ { carIndex, result }   carStats(carIndex) — result is the resolved
//                                   stats object, or null where JS yields
//                                   undefined (non-integer wrapped index).
//
// Values compare as canonical JSON: js_number_to_string == JSON.stringify byte
// for byte (double-conversion), so a decimal round-trip pins each authored
// double exactly — a one-ulp transcription typo in the C++ header diverges.
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-protocol-corpus.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { canonicalStringify } from './oracle-lib.mjs';

const require = createRequire(import.meta.url);
const P = require('../public/shared/protocol.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/protocol-corpus.jsonl');

// The full mirror surface. RELAY_URL/STUN_URL are the shipping defaults (the
// browser <meta> override never reaches Node); the C++ header carries the same
// defaults. Objects keep authored key order — canonical compare sorts anyway.
const constants = {
  MSG: P.MSG,
  FASTLANE_TYPES: P.FASTLANE_TYPES,
  ROOM_STATE: P.ROOM_STATE,
  RELAY_URL: P.RELAY_URL,
  STUN_URL: P.STUN_URL,
  STUN_FALLBACK_URL: P.STUN_FALLBACK_URL,
  MAX_PLAYERS: P.MAX_PLAYERS,
  FIELD_SIZE: P.FIELD_SIZE,
  TOTAL_LAPS: P.TOTAL_LAPS,
  COUNTDOWN_SECONDS: P.COUNTDOWN_SECONDS,
  SCHEMATIC_EPS: P.SCHEMATIC_EPS,
  STEER: P.STEER,
  LIVENESS: P.LIVENESS,
  RANDOM_RACES: P.RANDOM_RACES,
  CAR_COLORS: P.CAR_COLORS,
  CAR_MODELS: P.CAR_MODELS,
  CAR_NAMES: P.CAR_NAMES,
  CAR_STATS: P.CAR_STATS,
};

// carStats indices: every valid slot, both wrap directions, the ==null / NaN
// fallbacks, and the non-integer index (JS array access yields undefined, which
// carStats returns verbatim — the contract, faithfully recorded).
const CAR_INDICES = [
  null, 0, 1, 2, 3,
  4, 5, 6, 7, 8,        // forward wrap
  -1, -2, -3, -4, -5,   // negative wrap
  100, 1000000000,      // large wrap
  2.0,                  // integer-valued float
  3.7, -0.5,            // non-integer -> undefined after wrap
  NaN,                  // isNaN fallback -> slot 0
];

// JSON.stringify drops NaN keys to null in an array/value slot; carIndex is
// carried explicitly so the C++ check drives car_stats with the same input.
const projIndex = (v) => (typeof v === 'number' && Number.isNaN(v)) ? { nan: true } : v;
const projResult = (r) => r === undefined ? null : r;

const lines = [];
lines.push(canonicalStringify({ kind: 'protocol', cars: P.CAR_STATS.length }));
lines.push(canonicalStringify({ constants }));
let cases = 0;
for (const idx of CAR_INDICES) {
  lines.push(canonicalStringify({ carIndex: projIndex(idx), result: projResult(P.carStats(idx)) }));
  cases++;
}

// --stdout emits instead of writing, so tests/codegen-freshness.test.js can
// re-derive this corpus and byte-compare without touching the working copy.
const text = lines.join('\n') + '\n';
// --stdout goes to a PIPE, and `process.exit()` right after a write to one
// TRUNCATES it: the write is asynchronous, exit does not flush, and the loss is
// silent at exactly the 64 KiB pipe buffer. Nothing under that size ever
// noticed. So the branch just ends here and the process exits on its own —
// gen-track-defs-header.mjs has always been written this way, which is why its
// 134 KB header survived the same test path.
if (process.argv.includes('--stdout')) {
  process.stdout.write(text);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: 1 manifest + ${cases} carStats cases`);
}
