// Generates tests/fixtures/trackbuilder-corpus.jsonl — the bit-exact oracle
// for the C++ TrackBuilder port (Track S M2b), covering ALL shipped tracks.
//
// The oracle is OUTPUT conformance on the augmented race-ready track object
// (buildRaceTrack = buildTrack + resolveFurniture + identity), independent of
// how the C++ side transports the track DEFS — so a defs-codegen bug and a
// builder bug both surface here, and the port cannot accidentally define away
// its own judge.
//
// Encoding ("hexJSON"): a canonical JSON-like text where every NUMBER is
// replaced by x<16-hex-digit big-endian IEEE-754 bit pattern> — no decimal
// formatting on either side, so the check needs no serializer. Rules:
//   number  -> x0123456789abcdef      (bit pattern, lowercase)
//   string  -> JSON string            boolean -> true|false   null -> null
//   array   -> [v,v,...]              object -> {"k":v,...} keys sorted,
//                                     undefined dropped, "_"-prefixed dropped
//   Centerline instance -> {"length":..., "samples":[...]} (public data only)
// Per track we emit ONE line:
//   { track, sampleCount,
//     keys:   { <top-level-key>: fnv1a(hexJSON(value)) },   // every key
//     chunks: [ fnv1a(hexJSON(samples[i..i+63])) ... ],     // localization
//     firstSamples: hexJSON(samples[0..1]),                  // direct anchor
//     furniture: { hazards|pads|boxes|poles|bananas|autoPoles: hexJSON } }
// The C++ check rebuilds each track from its ported defs, produces the same
// hexJSON via its own structs (field names = race-track.schema.json), and
// compares: a `keys` hash isolates the diverging field, a `chunks` hash the
// diverging 64-ring window, `firstSamples`/`furniture` diff directly.
//
// Deterministic; re-runs byte-identical. Usage:
//   node scripts/gen-trackbuilder-corpus.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRaceTrack, fnv1a } from './oracle-lib.mjs';
import { TRACKS } from '../public/display/TrackBuilder.js';
import { MATHLIB } from '../public/display/engine/math.js';

const TRACK_IDS = Object.keys(TRACKS);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/trackbuilder-corpus.jsonl');

const view = new DataView(new ArrayBuffer(8));
const numHex = (x) => {
  view.setFloat64(0, x);
  return 'x' + view.getBigUint64(0).toString(16).padStart(16, '0');
};

function hexJson(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'null';
  const t = typeof v;
  if (t === 'number') return numHex(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(hexJson).join(',') + ']';
  if (t === 'object') {
    // Centerline instance: public data only (samples + length), matching what
    // the C++ side reconstructs. Detected structurally to avoid an import.
    if (typeof v.sampleAt === 'function') {
      return hexJson({ length: v.length, samples: v.samples });
    }
    const keys = Object.keys(v)
      .filter((k) => !k.startsWith('_') && v[k] !== undefined && typeof v[k] !== 'function')
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + hexJson(v[k])).join(',') + '}';
  }
  throw new Error(`hexJson: unsupported type ${t}`);
}

const CHUNK = 64;
const lines = [];
for (const trackId of TRACK_IDS) {
  const b = buildRaceTrack(trackId, { laps: 3, seed: 1 });
  const samples = b.centerline.samples;

  const keys = {};
  for (const k of Object.keys(b).sort()) {
    if (k.startsWith('_') || b[k] === undefined || typeof b[k] === 'function') continue;
    keys[k] = fnv1a(hexJson(b[k]));
  }
  const chunks = [];
  for (let i = 0; i < samples.length; i += CHUNK) {
    chunks.push(fnv1a(hexJson(samples.slice(i, i + CHUNK))));
  }
  lines.push(JSON.stringify({
    track: trackId,
    sampleCount: samples.length,
    keys,
    chunks,
    firstSamples: hexJson(samples.slice(0, 2)),
    furniture: {
      hazards: hexJson(b.hazards), pads: hexJson(b.pads), boxes: hexJson(b.boxes),
      poles: hexJson(b.poles), bananas: hexJson(b.bananas), autoPoles: hexJson(b.autoPoles)
    }
  }));
}

const header = JSON.stringify({ tracks: TRACK_IDS.length, chunk: CHUNK, mathlib: MATHLIB });
fs.writeFileSync(OUT, header + '\n' + lines.join('\n') + '\n');
console.log(`${OUT}: ${TRACK_IDS.length} tracks, chunk=${CHUNK}`);
