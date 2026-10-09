#!/usr/bin/env node
// gen-trainset.mjs — the playroom's toy train set, composed from Kenney kit
// pieces into ONE model the scene can place like any other prop.
//
// WHY COMPOSE RATHER THAN PLACE. A rail loop with a train on it is one object to
// a player and a dozen to a scatter: dropped into the prop channel the pieces
// would land independently, which is a floor strewn with rails, not a train set.
// The arrangement is authored HERE, once, where it can be looked at — and the
// scene then pays for one model with no per-frame cost and no new renderer path.
//
// The ring is short STRAIGHTS around a circle rather than the kit's own bend
// pieces. The bends DO close exactly — four of them are a circle — but only at
// the radius their geometry is cut for, which is under half of this one, and a
// locomotive is a RIGID body: on a ring that tight it spans enough arc to hang
// off the rails at both ends. Scaling the bends up scales their gauge past the
// train. So the radius is chosen for the TRAIN, and the ring is a polygon of
// straights whose chord is under a percent off the arc.
//
// The circle is also a CONTRACT, not a shape choice: the whole train moves by
// one rotation of SPIN_NODE, so anything but a circle cannot be driven at all.
//
//   node scripts/gen-trainset.mjs
//
// Reads the kit cache (`npm run fetch:kits` — the kits are not in the tree) and
// writes public/assets/toycar/trainset.glb, which IS checked in. Its provenance
// is SOURCES.json, like every other model beside it.
//
// The output references Textures/holiday-colormap.png, which the game already
// ships for the snow trees: every piece here is Holiday Kit, so one palette
// covers the whole set (see scripts/fetch-kits.mjs on why that URI, not the
// toy-car one).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createComposer, readGlb as readGlbFile } from './lib/glb-compose.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(ROOT, '.cache/kenney-kits/holiday/models');
const OUT = path.join(ROOT, 'public/assets/toycar/trainset.glb');
const TEXTURE = 'Textures/holiday-colormap.png';

// The set. RADIUS is the rail centreline; a straight is 0.5 long and 0.3 wide,
// and the train pieces are ~0.35-0.7 long, so this is a toy about 3.5 units
// across at scale 1. The theme scales the whole set up (theme.cc), so pick
// sizes here for the train, not for the floor.
const RADIUS = 1.6;
const RAIL = 'trainset-rail-detailed-straight';
const RAIL_LEN = 0.5;
const RAIL_TOP = 0.036;   // the rail's own thickness: the train stands on it
// Locomotive first, then what it pulls, each measured along its own +x.
const TRAIN = [
  { file: 'train-locomotive', len: 0.67 },
  { file: 'train-tender', len: 0.346 },
  { file: 'train-wagon-short', len: 0.37 },
];
const COUPLING = 0.06;
// What the renderer turns to drive the train round the rails. A prop model may
// name ONE node this, and nothing else in the game does. It turns the ring
// FORWARD, in the +angle direction — so that is the way the locomotive faces.
const SPIN_NODE = 'spin';

// Where a piece sits on the ring, and which way it points.
//
// EVERY PIECE HERE RUNS ALONG ITS OWN +X — measured, not assumed: the straight's
// two rail heads are 0.15 apart in z and continuous in x, and the locomotive's
// cab is the tall block at -x with the chimney ahead of it.
//
// A yaw about +y sends local +x to (cos yaw, -sin yaw) in (x, z), and the ring's
// tangent at angle `a` is (-sin a, cos a). Those meet at -a - PI/2 and nowhere
// else; -a is the RADIAL direction, which lays the straights out as spokes and
// the train broadside across them.
const ringAt = (a) => ({ x: Math.cos(a) * RADIUS, z: Math.sin(a) * RADIUS, yaw: -a - Math.PI / 2 });

const readGlb = (name) => readGlbFile(path.join(KIT, `${name}.glb`));
const { load, place, group, write } = createComposer({ generator: 'ttp gen-trainset.mjs', texture: TEXTURE });

const rail = load(readGlb(RAIL));
// One straight per chord of RAIL_LEN, laid along its own tangent. CEIL, not
// round: it makes the chord shorter than the piece, so consecutive straights
// overlap at the centreline rather than leaving a sliver of floor between them.
// The ring is a polygon, so each join is a visible kink — at this piece count a
// shallow one, and the overlap keeps the sleepers reading as continuous track.
const count = Math.max(4, Math.ceil((2 * Math.PI * RADIUS) / RAIL_LEN));
for (let i = 0; i < count; i++) place(rail, ringAt((i / count) * 2 * Math.PI));

// The train, nose to tail along the same circle, its locomotive a quarter turn
// round so the set reads as travelling rather than parked at the seam. The
// consist runs BACKWARDS from the loco — each following car a half-length, a
// coupling and a half-length further against the direction of travel — because
// the loco pulls: stepping forward instead put the wagons out in front of it.
//
// Under a PIVOT at the ring's centre, named so the renderer can find it: turning
// that one node walks the whole train round the rails, which is the only moving
// part of the set and costs one transform a frame. The name is the contract —
// see TtpRenderer::buildProps.
const carriages = [];
let arc = Math.PI * 0.5;
for (const car of TRAIN) {
  arc -= (car.len / 2) / RADIUS;
  carriages.push(place(load(readGlb(car.file)),
    { ...ringAt(arc), y: RAIL_TOP, scene: false }));
  arc -= (car.len / 2 + COUPLING) / RADIUS;
}
group(SPIN_NODE, carriages);

const { bytes, tris } = write(OUT);
console.log(`${path.relative(ROOT, OUT)}: ${count} rails + ${TRAIN.length} carriages, `
  + `${tris} tris, ${(bytes / 1024).toFixed(1)} kB`);
