// oracle-lib — the ENGINE-FREE helpers the corpus generators share: canonical
// JSON, FNV-1a, a seeded PRNG, and the mathlib stamp.
//
// These used to live in scripts/record-trace.mjs, alongside the JS trace RECORDER.
// That recorder was retired with the JS engine (native/replay/replay_cli --record
// produces golden traces now, byte-identically — see the record_* ctest gates), but
// these helpers depend on no engine at all and are still used by the corpus
// generators, so they live on here.
//
// mulberry32 and MATHLIB moved here from public/display/engine/{util,math}.js when
// the JS engine's last modules were deleted. Neither is engine LOGIC — one is a
// test-data PRNG, the other a provenance string — but both are baked into frozen
// fixtures, so they have to keep producing exactly what they produced.

// Fixed physics tick: the display's 60 Hz frame budget in ms.
export const TRACE_DT_MS = 16.667;

// ---- canonical JSON ----
// JSON.stringify with a DETERMINISTIC key order (recursive sort), so trace
// bytes never depend on object-construction order. Doubles round-trip exactly
// through JSON (shortest-representation), so parse(stringify(x)) === x.
export function canonicalStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonicalStringify(x))).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(v[k])).join(',') + '}';
}

// 32-bit FNV-1a over the UTF-8 bytes of a string, as 8 hex digits. Small,
// dependency-free, and trivial to reimplement bit-for-bit in C++.
export function fnv1a(str) {
  const bytes = new TextEncoder().encode(str);
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// mulberry32 — the seeded PRNG every corpus generator draws its cases from.
// Bit-for-bit as it was in engine/util.js: the committed fixtures ARE its output,
// so a different stream is a different corpus.
export const mulberry32 = (a) => () => {
  a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

// The transcendental implementation the fixtures were recorded against, stamped
// into corpus headers as provenance. Both sides vendor the same fdlibm.
export const MATHLIB = 'fdlibm-openlibm-0.8.7';
