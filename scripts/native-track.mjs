// native-track — build a track in Node, through the SHIPPED wasm.
//
// This is how everything outside the browser reads track geometry: the authoring
// tools, the geometry audit, the difficulty report card, the schematic codegen.
// It used to be `import { buildTrack } from '../public/display/TrackBuilder.js'`
// — a second implementation of the builder, maintained in JS alongside the C++
// one the game actually races on. There is one builder now, and this reaches it.
//
// It loads public/display/engine/native/ttp_runtime.{mjs,wasm}: the same bytes
// the browser downloads, not a fresh build, so a tool measuring a track and the
// game racing it cannot disagree. If those artifacts are stale against native/,
// tests/native-artifact.test.js is the gate that says so; it is deliberately not
// re-checked here, since these scripts are usually run mid-iteration.
//
// ASYNC ONCE, THEN SYNCHRONOUS. `await init()` at the top of a script; every
// buildTrack() after that is an ordinary synchronous call, because loading the
// module is the only asynchronous part and the ABI itself is not. That matters:
// the generators are deep synchronous pipelines (a closure solver calling a
// measurer calling a builder), and making the leaf async would have rippled
// through all of it for no reason.
//
// SHAPE. buildTrack returns exactly what the retired JS buildTrack returned: the
// augmented race-track object of docs/native-port/contract/race-track.schema.json
// (minus `cup`, which was always the host's tag rather than the builder's
// output). One difference: `centerline` is plain data — { length, samples } —
// rather than a class, so it has no sampleAt()/nearest() methods. Callers that
// need a frame between samples ask the engine (ttp_track_supports_json returns
// reconstructed world positions; a session offers ttp_track_point).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');

let fn = null;

// Load the module and cwrap its track exports. Idempotent; call it once at the
// top of a script and ignore the result.
export async function init() {
  if (fn) return;
  if (!fs.existsSync(MJS)) {
    throw new Error(`native runtime not built: ${MJS}\n`
      + '  build it with native/scripts/build-runtime-web.sh');
  }
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const mod = await factory();
  fn = {
    byId: mod.cwrap('ttp_track_json', 'string', ['string', 'number', 'number']),
    byDescriptor: mod.cwrap('ttp_track_build_json', 'string', ['string', 'number', 'number']),
    supports: mod.cwrap('ttp_track_supports_json', 'string', ['string']),
    sweep: mod.cwrap('ttp_track_sweep_json', 'string', ['string', 'number']),
    frames: mod.cwrap('ttp_track_frames_json', 'string', ['string', 'string']),
    schematic: mod.cwrap('ttp_track_schematic_json', 'string', ['string', 'number', 'number'])
  };
}

const ready = () => {
  if (!fn) throw new Error('native-track: call `await init()` before building a track');
  return fn;
};

// The plan→world scale the builder applies to authored coordinates. Authoring
// tools plan in unscaled units and have to agree with it exactly; it is asserted
// against the engine on the first build below rather than trusted.
export const SCALE = 2;
let scaleChecked = false;

// A BOUNDED memo. A built circuit is a few hundred KB of parsed JSON, and the two
// access patterns pull in opposite directions: a test re-builds the same handful
// of catalogue tracks over and over (all hits), while a seed scan builds thousands
// of DISTINCT candidates (all misses). Unbounded, the scan retained ~320 MB for
// nothing. Small and oldest-first-evicted serves the first pattern and costs the
// second only its insertion.
const MEMO_MAX = 24;
const memo = new Map();

function memoSet(key, built) {
  memo.set(key, built);
  // Map iterates in insertion order, so the first key is the oldest.
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
}

// Build a track from a DESCRIPTOR (a public/shared/tracks.js entry, a generated
// candidate, or a bare segment array) or from a catalogue/dev track ID.
//
// `laps` and `seed` only stamp totalLaps/seed on the result — no geometry
// depends on them — so the defaults suit every caller that just wants a shape.
export function buildTrack(defOrId, { laps = 3, seed = 1, memoize = true } = {}) {
  const f = ready();

  // A bare segment array is a descriptor with only segments: the JS builder
  // accepted one, and the authoring scripts lean on that heavily.
  const desc = Array.isArray(defOrId) ? { segments: defOrId } : defOrId;
  const key = memoize ? `${laps}|${seed}|${typeof desc === 'string' ? desc : stableKey(desc)}` : null;
  if (key !== null && memo.has(key)) {
    // Refresh its position so a hot key is not evicted by a burst of misses.
    const hit = memo.get(key);
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }

  let json;
  if (typeof desc === 'string') {
    json = f.byId(desc, laps, seed);
    if (!json) throw new Error(`unknown trackId '${desc}'`);
  } else {
    if (!desc || typeof desc !== 'object') {
      throw new Error('buildTrack: expected a descriptor, a segment array or a track id');
    }
    json = f.byDescriptor(JSON.stringify(stripAuthoring(desc)), laps, seed);
    if (!json) {
      throw new Error('buildTrack: the native builder refused this descriptor '
        + '(neither/both of segments+waypoints, an unknown segment kind, or furniture missing `u`)');
    }
  }
  const built = JSON.parse(json);

  // One-time agreement check on SCALE. A track with no authored width builds at
  // the 2.5 default × SCALE; if the engine's factor ever moves, every plan-space
  // closure solve in the authoring tools silently aims at the wrong size.
  if (!scaleChecked) {
    scaleChecked = true;
    const probe = JSON.parse(f.byDescriptor(JSON.stringify(
      { segments: [{ kind: 'straight', length: 20 }, { kind: 'arc', radius: 5, angle: 180 },
                    { kind: 'straight', length: 20 }, { kind: 'arc', radius: 5, angle: 180 }],
        width: 1 }), 3, 1));
    if (probe.roadWidth !== SCALE) {
      throw new Error(`native-track: SCALE is ${SCALE} here but the engine builds a `
        + `width-1 track ${probe.roadWidth} wide — the plan→world factor has drifted`);
    }
  }

  if (key !== null) memoSet(key, built);
  return built;
}

// The oracle's buildRaceTrack(trackId, {laps, seed}) signature, kept for callers
// that used it by that name.
export function buildRaceTrack(trackId, { laps = 3, seed = 1 } = {}) {
  return buildTrack(trackId, { laps, seed });
}

// Support-structure measurements for a built track (see ttp_runtime.h):
//   { posts: [{ kind, x, z, radius, intrusion, s }],
//     autoPoles: [{ s, lat, radius, x, z }] }
// The builder's OWN corridor gate and centreline sampler, so the geometry audit
// measures with the same function that placed the poles rather than a copy.
export function trackSupports(defOrId) {
  const f = ready();
  const json = f.supports(idOrDescriptorArg(defOrId));
  if (!json) throw new Error('trackSupports: the native builder refused this track');
  return JSON.parse(json);
}

// A uniform sweep of interpolated frames along a built track: s = 0, step, 2·step,
// … up to and including the lap line, each { s, pos, tangent, up, lateral, width }.
//
// Through the builder's own Centerline, so a frame BETWEEN knots is the same cubic
// the sim and the renderer read. One call rather than one per point: the smoothness
// gate walks thousands of frames per candidate and hundreds of candidates per scan.
export function trackSweep(defOrId, step) {
  const f = ready();
  const json = f.sweep(idOrDescriptorArg(defOrId), step);
  if (!json) throw new Error(`trackSweep: refused (step=${step})`);
  return JSON.parse(json);
}

// Frames at an EXPLICIT list of arclengths, same shape as trackSweep's. For a
// caller with particular points to ask about rather than a uniform walk.
export function trackFrames(defOrId, sList) {
  const f = ready();
  const json = f.frames(idOrDescriptorArg(defOrId), JSON.stringify([...sList]));
  if (!json) throw new Error('trackFrames: refused (bad track or arclength list)');
  return JSON.parse(json);
}

// One frame, for the occasional point lookup.
export function trackFrameAt(defOrId, s) { return trackFrames(defOrId, [s])[0]; }

// The track's top-down schematic — {viewBox, d, start, proj} — projected into the
// 256-unit square by libttp-track's own ttp::schematic. Laps and seed touch
// furniture, never the centreline the map is drawn from, so any values give the
// same map.
//
// THE KEY ORDER IS RESPELLED, and it is not cosmetic fussiness. The ABI emits
// canonical (sorted) JSON, but public/shared/trackSchematics.js is a GENERATED
// SOURCE FILE whose bytes were written by the JS projection this replaced
// (display/trackSchematic.js, retired once tests/fixtures/schematic-corpus.jsonl
// had frozen its output for all 20 tracks). Re-baking in sorted order would
// rewrite every line of a shipped file to say exactly what it already said. So
// the historical order is restored here, and the bake stays byte-identical —
// which is also what keeps `node scripts/gen-track-schematics.js` an honest
// no-op check rather than a diff.
export function trackSchematic(trackId, { laps = 3, seed = 1 } = {}) {
  const { viewBox, d, start, proj } = JSON.parse(fn.schematic(trackId, laps, seed));
  const { minX, minZ, scale, offX, offZ } = proj;
  return { viewBox, d, start, proj: { minX, minZ, scale, offX, offZ } };
}

function idOrDescriptorArg(defOrId) {
  return typeof defOrId === 'string'
    ? defOrId
    : JSON.stringify(stripAuthoring(Array.isArray(defOrId) ? { segments: defOrId } : defOrId));
}

// Descriptors carry authoring metadata the builder has no opinion about (name,
// difficulty, cup tags, generator bookkeeping). The native side refuses what it
// cannot read, which is the right default for a typo but the wrong one for a
// field that was never geometry, so the known-inert keys are dropped here.
const BUILD_KEYS = ['id', 'width', 'startU', 'segments', 'waypoints',
                    'oils', 'pads', 'boxes', 'poles', 'bananas'];
function stripAuthoring(desc) {
  const out = {};
  for (const k of BUILD_KEYS) if (desc[k] !== undefined) out[k] = desc[k];
  return out;
}

// Memo key over the fields that actually reach the builder. JSON.stringify of
// the stripped descriptor is stable because BUILD_KEYS fixes the order.
function stableKey(desc) {
  return JSON.stringify(stripAuthoring(desc));
}
