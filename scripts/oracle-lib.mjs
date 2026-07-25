// oracle-lib — the ENGINE-FREE helpers the corpus generators share: canonical
// JSON, FNV-1a, and catalogue track construction.
//
// These used to live in scripts/record-trace.mjs, alongside the JS trace RECORDER.
// That recorder was retired with the JS engine (native/replay/replay_cli --record
// produces golden traces now, byte-identically — see the record_* ctest gates), but
// these three helpers depend on no engine at all and are still used by every corpus
// generator, so they live on here.
import { buildTrack, resolveFurniture, TRACKS } from '../public/display/TrackBuilder.js';

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

export function buildRaceTrack(trackId, { laps = 3, seed = 1 } = {}) {
  const def = TRACKS[trackId];
  if (!def) throw new Error(`unknown trackId '${trackId}' (known: ${Object.keys(TRACKS).join(', ')})`);
  const b = buildTrack(def);
  b.trackId = trackId;
  b.totalLaps = laps;
  b.seed = seed >>> 0; // the engine's item-roll RNG seed (Game reads track.seed)
  resolveFurniture(b, def);
  return b;
}
