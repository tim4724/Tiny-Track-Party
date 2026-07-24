// Augmented-track EXPORTER for the native-port conformance oracle.
//
// Dumps, for every shipped track (or one via --track=<id>), the full RACE-READY
// augmented track object the sim consumes — buildTrack() geometry PLUS the host's
// game-side layer (resolved furniture + identity + per-race inputs) — as canonical
// JSON. Schema: docs/native-port/contract/race-track.schema.json.
//
// This is the fixture the C++ TrackBuilder + resolveFurniture port diffs against
// byte-for-byte, so determinism is the whole point:
//   - no wall clock, no Math.random (buildTrack/resolveFurniture are pure);
//   - the per-race `seed` and `totalLaps` — the only host-injected, machine-varying
//     inputs in a live race — are PINNED here (default seed 1, laps 3), overridable
//     with --seed/--laps so a fixture set can pin any value;
//   - JSON key order is fixed by a local recursive-sort stringify (mirroring
//     record-trace.mjs's canonicalStringify semantics, reimplemented here so the two
//     scripts don't couple);
//   - the centerline is projected to its serializable DATA ({samples, length}) so the
//     live class's scratch buffers never leak into the bytes.
// Same machine or any machine, same flags in -> byte-identical bytes out.
//
// CLI:
//   node scripts/export-track-data.mjs [--track=<id>] [--seed=1] [--laps=3] [--out=<dir>]
//     no --out  : canonical JSON to stdout — one track's object for --track,
//                 else a {trackId: augmentedTrack} object over every shipped track.
//     --out=dir : one <trackId>.json file per track (trailing newline), dir created.
//
// Importable: buildAugmentedTrack(entry, {laps, seed}), serializableTrack(track),
// canonicalStringify, SHIPPED_TRACKS.

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { buildTrack, resolveFurniture, TRACK_LIST } from '../public/display/TrackBuilder.js';
import { CONTRACT_VERSION } from '../public/display/engine/Game.js';

// The shipped catalogue in stable cup order (main.js builds from exactly this list).
export const SHIPPED_TRACKS = TRACK_LIST;

// ---- canonical JSON ----
// JSON.stringify with a DETERMINISTIC key order (recursive sort) and undefined
// keys/elements dropped, so bytes never depend on object-construction order. Same
// semantics as record-trace.mjs's canonicalStringify, reimplemented locally on
// purpose: the exporter must not couple to the recorder. Doubles round-trip exactly
// through JSON (shortest representation).
export function canonicalStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonicalStringify(x))).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(v[k])).join(',') + '}';
}

// ---- augmentation ----
// Assemble the RACE-READY track exactly as the host does: buildTrack() geometry,
// then the identity (cup + trackId) and the SHARED furniture resolve
// (TrackBuilder.resolveFurniture — the same code buildEntry and buildRaceTrack run,
// so the game, the oracle, and this export can't drift), then the per-race inputs
// (totalLaps + seed). The engine reads centerline/length/roadWidth/totalLaps/
// hazards/pads/boxes/poles/bananas/seed; cup + trackId are identity for theming.
export function buildAugmentedTrack(entry, { laps = 3, seed = 1 } = {}) {
  const b = buildTrack(entry);
  b.cup = entry.cup;      // biome theming id (renderer-side identity)
  b.trackId = entry.id;   // registry id — theme patches + deterministic scatter seed
  resolveFurniture(b, entry);
  b.totalLaps = laps;
  b.seed = seed >>> 0;    // the engine's item-roll RNG seed (Game reads track.seed)
  return b;
}

// The centerline is a live Centerline class instance carrying scratch buffers
// (_mB/_mC/_d/_scratch) alongside its DATA. Project to just {samples, length} — the
// serializable shape race-track.schema.json describes — so nothing machine-internal
// reaches the bytes. Sample Vec3s serialize to plain {x, y, z} (their only own keys).
export function serializableTrack(track) {
  return { ...track, centerline: { samples: track.centerline.samples, length: track.centerline.length } };
}

// ---- CLI ----
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unrecognised argument: ${a}`);
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const laps = Number(a.laps ?? 3);
  const seed = Number(a.seed ?? 1);
  if (!Number.isInteger(laps) || laps < 1) { console.error('--laps must be a positive integer'); process.exit(2); }
  if (!Number.isInteger(seed) || seed < 0) { console.error('--seed must be a non-negative integer'); process.exit(2); }

  let entries = SHIPPED_TRACKS;
  if (a.track && a.track !== true) {
    entries = SHIPPED_TRACKS.filter((t) => t.id === a.track);
    if (entries.length === 0) {
      console.error(`unknown --track '${a.track}' (shipped: ${SHIPPED_TRACKS.map((t) => t.id).join(', ')})`);
      process.exit(2);
    }
  }

  const built = entries.map((t) => ({ id: t.id, obj: serializableTrack(buildAugmentedTrack(t, { laps, seed })) }));

  if (a.out && a.out !== true) {
    fs.mkdirSync(a.out, { recursive: true });
    let bytes = 0;
    for (const { id, obj } of built) {
      const text = canonicalStringify(obj) + '\n';
      fs.writeFileSync(path.join(a.out, `${id}.json`), text);
      bytes += Buffer.byteLength(text);
    }
    console.error(`wrote ${built.length} track file(s) to ${a.out} (contract v${CONTRACT_VERSION}, seed ${seed}, laps ${laps}, ${bytes} bytes)`);
  } else if (built.length === 1) {
    process.stdout.write(canonicalStringify(built[0].obj) + '\n');
  } else {
    const byId = {};
    for (const { id, obj } of built) byId[id] = obj;
    process.stdout.write(canonicalStringify(byId) + '\n');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
