// Codegen: emits native/libttp-track/generated/track_defs.h from the shipped
// track catalogue (TRACKS = TRACK_LIST's source, re-exported by TrackBuilder.js).
// This is the transport layer for the C++ TrackBuilder port (Track S M2b): the
// SAME descriptor data buildTrack + resolveFurniture read on the JS side, carried
// into C++ as PODs.
//
// Design:
//   - Doubles are emitted as their exact IEEE-754 bit patterns (uint64 hex) fed
//     through a bit_cast helper `bc()`, so no decimal formatting/parsing sits on
//     either side of the port and the header is byte-stable across re-runs.
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
// Deterministic: iterates Object.keys(TRACKS) (insertion order — the exact order
// scripts/gen-trackbuilder-corpus.mjs walks), emits nothing machine-varying.
// Check the output in (like engine/math.js embeds its wasm).
//
// Usage: node scripts/gen-track-defs-header.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACKS } from '../public/display/TrackBuilder.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'native/libttp-track/generated/track_defs.h');

const ROAD_WIDTH = 2.5; // TrackBuilder ROAD_WIDTH — the descriptor-width fallback.

// ---- exact double -> bit pattern ----
const view = new DataView(new ArrayBuffer(8));
const hx = (x) => { view.setFloat64(0, x); return '0x' + view.getBigUint64(0).toString(16).padStart(16, '0'); };
const D = (x) => `bc(${hx(x)})`;      // a double literal, bit-exact
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
out.push('// Track catalogue DEFS for the C++ TrackBuilder port (Track S M2b), carried as');
out.push('// exact IEEE-754 bit patterns. Regenerate: node scripts/gen-track-defs-header.mjs');
out.push('#pragma once');
out.push('');
out.push('#include <cstdint>');
out.push('#include <cstring>');
out.push('');
out.push('#include "ttp/trackbuilder.h"');
out.push('');
out.push('namespace ttp {');
out.push('namespace track_defs_detail {');
out.push('// bit-exact uint64 -> double (the header carries raw IEEE-754 patterns).');
out.push('inline double bc(uint64_t b) { double d; std::memcpy(&d, &b, 8); return d; }');
out.push('}  // namespace track_defs_detail');
out.push('using track_defs_detail::bc;');
out.push('');

const trackIds = Object.keys(TRACKS);
const perTrack = [];

for (const id of trackIds) {
  const desc = TRACKS[id];
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
    out.push(`static const WptDef kW_${sym}[] = {`);
    for (const s of arr) out.push(`  ${s},`);
    out.push('};');
    wptsRef = `kW_${sym}`; nWpts = arr.length;
  } else {
    const arr = desc.segments.map(segInit);
    out.push(`static const SegDef kS_${sym}[] = {`);
    for (const s of arr) out.push(`  ${s},`);
    out.push('};');
    segsRef = `kS_${sym}`; nSegs = arr.length;
  }

  const emitFurn = (name, list, initFn) => {
    const arr = (list || []).map(initFn);
    if (arr.length === 0) return { ref: 'nullptr', n: 0 };
    out.push(`static const ${initFn === bananaInit ? 'BananaDef' : 'FurnDef'} k${name}_${sym}[] = {`);
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

out.push('const TrackDef TTP_TRACKS[] = {');
for (const line of perTrack) out.push(`${line},`);
out.push('};');
out.push(`const int TTP_TRACK_COUNT = ${trackIds.length};`);
out.push('');
out.push('}  // namespace ttp');
out.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n'));
console.log(`${OUT}: ${trackIds.length} tracks`);
