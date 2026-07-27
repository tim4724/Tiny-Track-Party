// Codegen: emits native/libttp-track/generated/track_defs.h from the shipped
// track catalogue (public/shared/tracks.js — TRACKS, TRACK_LIST's source) plus
// the dev-only surfaces (public/shared/devTracks.js). This is the transport layer
// for the C++ TrackBuilder: the descriptor data is carried into C++ as PODs, and
// the native builder is the ONLY builder — nothing in the browser integrates a
// track any more.
//
// TWO COUNTS, and the difference matters. TTP_TRACK_COUNT is the SHIPPED
// catalogue, and every sweep is defined over it: catalogue_sweep races exactly
// those, probe_cli reports a row per those, trackbuilder_check diffs those
// against the 20-row frozen corpus. TTP_TRACK_TOTAL adds the dev tracks on the
// end — only id LOOKUP (find_track_def) scans that far, so `?solo&track=gym`
// resolves without a dev range ever leaking into a conformance sweep or a
// player-visible list.
//
// Design:
//   - Doubles are emitted as C++ hex-float literals, which name a binary64 value
//     exactly, so no decimal formatting/parsing sits on either side of the port
//     and the header is byte-stable across re-runs. They are also constant
//     expressions, which is what lets the tables be `constexpr`.
//   - Field PRESENCE is preserved wherever the JS distinguishes absent from 0:
//       * furniture `radius`  — `radius != null ? radius : roadWidth*FRAC`  → hasRadius flag
//       * segment  `width`    — `w == null ? default : (array ? taper : w)`  → widthKind {0,1,2}
//       * segment  `over`     — `over === false ? -1 : 1`                     → over bool (default true)
//       * waypoint `w`        — `w || trackWidth`                            → 0 sentinel means absent
//     Everything else the builder reads with `x || default` (rise/bank/roll/drift/
//     angle/lat/y) is absent-equals-0, so a plain 0 is faithful.
//   - FAILS LOUDLY on any descriptor/segment/waypoint/furniture key it does not
//     recognise: shape drift must break codegen, never silently drop data.
//
// Deterministic: iterates Object.keys(TRACKS) then Object.keys(DEV_TRACKS)
// (insertion order — the catalogue half in the exact order
// scripts/gen-trackbuilder-corpus.mjs walks), emits nothing machine-varying.
// Check the output in.
//
// Usage: node scripts/gen-track-defs-header.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACKS } from '../public/shared/tracks.js';
import { DEV_TRACKS } from '../public/shared/devTracks.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'native/libttp-track/generated/track_defs.h');

const ROAD_WIDTH = 2.5; // TrackBuilder ROAD_WIDTH — the descriptor-width fallback.

// ---- exact double -> C++ hex-float literal ----
// A hex float (0x1.<52-bit mantissa>p<exp>) names the binary64 value EXACTLY —
// no decimal formatting or parsing on either side, same guarantee the old uint64
// bit patterns gave. Unlike those, it is a constant expression, so the tables
// below are `constexpr` and land in the data segment. Fed through a memcpy-based
// bit_cast helper they could not be, and the wasm materialised all 6665 doubles
// at startup: __wasm_call_ctors was 92,534 instructions, a third of the module.
const view = new DataView(new ArrayBuffer(8));
const D = (x) => {
  if (Number.isNaN(x) || !Number.isFinite(x)) fail(`non-finite track constant ${x}`);
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const sign = (bits >> 63n) === 1n ? '-' : '';
  const exp = Number((bits >> 52n) & 0x7ffn);
  const mant = bits & 0xfffffffffffffn;
  if (exp === 0 && mant === 0n) return `${sign}0x0p+0`;             // ±0
  // Subnormals carry an implicit leading 0 and a fixed exponent; normals a 1.
  const lead = exp === 0 ? '0' : '1';
  const e = exp === 0 ? -1022 : exp - 1023;
  const frac = mant.toString(16).padStart(13, '0').replace(/0+$/, '');
  return `${sign}0x${lead}${frac ? '.' + frac : ''}p${e >= 0 ? '+' : ''}${e}`;
};
const B = (v) => (v ? 'true' : 'false');

const fail = (msg) => { throw new Error(`gen-track-defs-header: ${msg}`); };
const checkKeys = (obj, allowed, what) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`unrecognised ${what} key "${k}" (allowed: ${allowed.join(', ')})`);
};

// ---- segments ----
const SEG_KEYS = ['kind', 'length', 'radius', 'angle', 'rise', 'bank', 'roll', 'width', 'pillars', 'over', 'drift'];
function segInit(seg) {
  checkKeys(seg, SEG_KEYS, 'segment');
  let kindEnum;
  if (seg.kind === 'straight') kindEnum = 'SegKind::Straight';
  else if (seg.kind === 'arc') kindEnum = 'SegKind::Arc';
  else if (seg.kind === 'loop') kindEnum = 'SegKind::Loop';
  else fail(`unknown segment kind "${seg.kind}"`);
  // width: null -> default (0), number -> scalar (1), [a,b] -> taper (2)
  let widthKind = 0, w0 = 0, w1 = 0;
  if (seg.width != null) {
    if (Array.isArray(seg.width)) {
      if (seg.width.length !== 2) fail(`segment width array must have 2 entries, got ${seg.width.length}`);
      widthKind = 2; w0 = seg.width[0]; w1 = seg.width[1];
    } else if (typeof seg.width === 'number') { widthKind = 1; w0 = seg.width; }
    else fail(`segment width must be a number or [a,b], got ${typeof seg.width}`);
  }
  const over = !(seg.over === false); // over===false -> vert -1; default up
  // Field order MUST match SegDef in trackbuilder.h.
  return `{ ${kindEnum}, ${D(seg.length || 0)}, ${D(seg.radius || 0)}, ${D(seg.angle || 0)}, `
    + `${D(seg.rise || 0)}, ${D(seg.bank || 0)}, ${D(seg.roll || 0)}, ${D(seg.drift || 0)}, `
    + `${B(over)}, ${widthKind}, ${D(w0)}, ${D(w1)}, ${B(!!seg.pillars)} }`;
}

// ---- waypoints ----
const WPT_KEYS = ['x', 'z', 'y', 'w', 'bank', 'bridge'];
function wptInit(w) {
  checkKeys(w, WPT_KEYS, 'waypoint');
  if (typeof w.x !== 'number' || typeof w.z !== 'number') fail('waypoint needs numeric x,z');
  // Field order MUST match WptDef: x, z, y, w, bank, bridge.
  return `{ ${D(w.x)}, ${D(w.z)}, ${D(w.y || 0)}, ${D(w.w || 0)}, ${D(w.bank || 0)}, ${B(!!w.bridge)} }`;
}

// ---- furniture (oils allow a renderer-only `cones`, others don't) ----
function furnInit(f, allowCones) {
  checkKeys(f, allowCones ? ['u', 'lat', 'radius', 'cones'] : ['u', 'lat', 'radius'], 'furniture');
  if (typeof f.u !== 'number') fail('furniture needs numeric u');
  if (f.cones !== undefined) fail('furniture carries `cones` — the C++ hazard port does not serialize cones yet; extend Hazard + hexJson before shipping a coned oil');
  const hasR = f.radius != null;
  if (hasR && typeof f.radius !== 'number') fail(`furniture radius must be a number, got ${typeof f.radius}`);
  // Field order MUST match FurnDef: u, lat, hasRadius, radius.
  return `{ ${D(f.u)}, ${D(f.lat || 0)}, ${B(hasR)}, ${D(hasR ? f.radius : 0)} }`;
}
function bananaInit(f) {
  checkKeys(f, ['u', 'lat'], 'banana');
  if (typeof f.u !== 'number') fail('banana needs numeric u');
  return `{ ${D(f.u)}, ${D(f.lat || 0)} }`;
}

// ---- descriptor ----
const DESC_KEYS = ['name', 'difficulty', 'waypoints', 'segments', 'startU', 'width', 'oils', 'pads', 'boxes', 'poles', 'bananas'];

const out = [];
out.push('// GENERATED by scripts/gen-track-defs-header.mjs — DO NOT EDIT BY HAND.');
out.push('// Track DEFS for the C++ TrackBuilder, carried as exact hex-float literals so the');
out.push('// tables are constexpr and land in the data segment.');
out.push('// Regenerate: node scripts/gen-track-defs-header.mjs');
out.push('//');
out.push('// TTP_TRACKS holds the shipped catalogue FIRST, then the dev-only ranges.');
out.push('// Iterate TTP_TRACK_COUNT for anything catalogue-shaped (sweeps, probes, the');
out.push('// frozen conformance corpus); scan TTP_TRACK_TOTAL only to resolve an id.');
out.push('#pragma once');
out.push('');
out.push('#include <cstdint>');
out.push('#include "ttp/trackbuilder.h"');
out.push('');
out.push('namespace ttp {');
out.push('');

const trackIds = Object.keys(TRACKS);
const devIds = Object.keys(DEV_TRACKS);
for (const id of devIds) {
  if (id in TRACKS) fail(`dev track "${id}" shadows a catalogue track id`);
}
const perTrack = [];

for (const id of [...trackIds, ...devIds]) {
  const desc = TRACKS[id] || DEV_TRACKS[id];
  checkKeys(desc, DESC_KEYS, `descriptor "${id}"`);
  const isSpline = Array.isArray(desc.waypoints);
  if (isSpline && Array.isArray(desc.segments)) fail(`track "${id}" has both waypoints and segments`);
  if (!isSpline && !Array.isArray(desc.segments)) fail(`track "${id}" has neither waypoints nor segments`);
  const trackWidth = (desc.width) || ROAD_WIDTH; // (desc && desc.width) || ROAD_WIDTH
  const startU = desc.startU ?? 0;                // opts.startU is never passed by the oracle

  const sym = id.replace(/[^A-Za-z0-9_]/g, '_');
  let segsRef = 'nullptr', nSegs = 0, wptsRef = 'nullptr', nWpts = 0;
  if (isSpline) {
    const arr = desc.waypoints.map(wptInit);
    out.push(`constexpr WptDef kW_${sym}[] = {`);
    for (const s of arr) out.push(`  ${s},`);
    out.push('};');
    wptsRef = `kW_${sym}`; nWpts = arr.length;
  } else {
    const arr = desc.segments.map(segInit);
    out.push(`constexpr SegDef kS_${sym}[] = {`);
    for (const s of arr) out.push(`  ${s},`);
    out.push('};');
    segsRef = `kS_${sym}`; nSegs = arr.length;
  }

  const emitFurn = (name, list, initFn) => {
    const arr = (list || []).map(initFn);
    if (arr.length === 0) return { ref: 'nullptr', n: 0 };
    out.push(`constexpr ${initFn === bananaInit ? 'BananaDef' : 'FurnDef'} k${name}_${sym}[] = {`);
    for (const s of arr) out.push(`  ${s},`);
    out.push('};');
    return { ref: `k${name}_${sym}`, n: arr.length };
  };
  const oils = emitFurn('Oils', desc.oils, (f) => furnInit(f, true));
  const pads = emitFurn('Pads', desc.pads, (f) => furnInit(f, false));
  const boxes = emitFurn('Boxes', desc.boxes, (f) => furnInit(f, false));
  const poles = emitFurn('Poles', desc.poles, (f) => furnInit(f, false));
  const bananas = emitFurn('Bananas', desc.bananas, bananaInit);
  out.push('');

  // Field order MUST match TrackDef in trackbuilder.h.
  perTrack.push(`  { ${JSON.stringify(id)}, ${B(isSpline)}, ${segsRef}, ${nSegs}, ${wptsRef}, ${nWpts}, `
    + `${D(trackWidth)}, ${D(startU)}, `
    + `${oils.ref}, ${oils.n}, ${pads.ref}, ${pads.n}, ${boxes.ref}, ${boxes.n}, `
    + `${poles.ref}, ${poles.n}, ${bananas.ref}, ${bananas.n} }`);
}

out.push('constexpr TrackDef TTP_TRACKS[] = {');
for (const line of perTrack) out.push(`${line},`);
out.push('};');
out.push('// The shipped catalogue: TTP_TRACKS[0 .. TTP_TRACK_COUNT).');
out.push(`constexpr int TTP_TRACK_COUNT = ${trackIds.length};`);
out.push('// Catalogue + the dev-only ranges. Id lookup only — never a sweep bound.');
out.push(`constexpr int TTP_TRACK_TOTAL = ${trackIds.length + devIds.length};`);
out.push('');
out.push('}  // namespace ttp');
out.push('');

// --stdout writes the header to stdout instead of the tree, so a test can
// re-derive it and byte-compare without touching the working copy.
const text = out.join('\n');
if (process.argv.includes('--stdout')) {
  process.stdout.write(text);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`${OUT}: ${trackIds.length} catalogue + ${devIds.length} dev tracks`);
}
