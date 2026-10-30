#!/usr/bin/env node
// gen-set-pieces.mjs — the per-track SET PIECES: big landmarks composed from
// Kenney kit pieces, each one GLB a track's `set` list places by name
// (public/shared/tracks.js). A set piece is what makes one circuit look unlike
// the other three in its cup; the biome's scatter cannot, since it is the same
// vocabulary on every track of the cup.
//
// Composed HERE rather than placed piece by piece from the track descriptor
// for gen-trainset.mjs's reason: a beached ship is one object to a player,
// and its arrangement is authored once, where it can be looked at. The track
// then pays for a model it places like any other — the renderer merges and
// BAKES it with the scenery (static light in the vertex colours, a simplified
// far form per cell), so a set piece costs vertices and nothing else.
//
//   node scripts/gen-set-pieces.mjs
//
// Reads the kit cache (`npm run fetch:kits`) and writes
// public/assets/toycar/set-*.glb, which ARE checked in; provenance is
// SOURCES.json. Re-run gen-kit-colors.mjs after, or the new bytes miss the
// colour table and draw live-lit (tests/codegen-freshness.test.js says so).
//
// FRAME. Every piece is authored in the frame the renderer places it in: the
// origin is the spot the track names, +Z runs ALONG the track's direction of
// travel and +X across it, y = 0 is the ground.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createComposer, readGlb } from './lib/glb-compose.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public/assets/toycar');
const PIRATE = {
  dir: path.join(ROOT, '.cache/kenney-kits/pirate/models'),
  texture: 'Textures/pirate-colormap.png',
};

function compose(kit, name, build) {
  const c = createComposer({ generator: 'ttp gen-set-pieces.mjs', texture: kit.texture });
  const loaded = new Map();
  // put('ship-pirate-large', { x, z, yaw, y, scale }) — a kit piece, loaded once.
  const put = (piece, at) => {
    if (!loaded.has(piece)) loaded.set(piece, c.load(readGlb(path.join(kit.dir, `${piece}.glb`))));
    return c.place(loaded.get(piece), { yaw: 0, ...at });
  };
  build(put);
  const file = path.join(OUT_DIR, `${name}.glb`);
  const { bytes, tris } = c.write(file);
  console.log(`${path.relative(ROOT, file)}: ${tris} tris, ${(bytes / 1024).toFixed(1)} kB`);
}

// ---- Pirate Cove (cove) ------------------------------------------------------

// The pirate ship at anchor in the shallows, its longboat alongside on the +X
// side. It stands in the sea, so nothing that belongs on land rides with it:
// the plunder and the palms are the shore pieces' (set-jetty, set-pirate-camp).
// The hull runs along +Z (the kit's long axis), so it lies parallel to the road
// at a placement yaw of 0 or 180 — 180 on the track's right turns the longboat
// to the open sea.
// Both ride the swell (set_motion.h): the ship rolls about its keel and
// lifts, the longboat bobs out of step with it. A ship rolling the 20 degrees
// a flag swings would be a storm; at its height ~7 degrees moves the masthead
// a unit and more, which reads.
compose(PIRATE, 'set-pirate-ship', (put) => {
  put('ship-pirate-large', { x: 0, z: 0, y: -0.35, yaw: 0.12, name: 'anim_sway:a=z:d=7:p=5.5+bob:h=0.25:p=4.2' });
  // tracks.js sinks the ship half a unit; the longboat floats, so it rides that back up
  put('boat-row-large', { x: 5.2, z: -4.5, y: 0.45, yaw: 0.9, name: 'anim_bob:h=0.2:p=3.1' });
});
