// Resolved waypoints for the seeded generated tracks (generated offline by
// scripts/gen-tracks.mjs — solved crossing elevation + difficulty-profile decoration and the
// chosen start anchor baked in; pure data, no renderer). GEN_FURNITURE carries their
// auto-placed oils/pads/boxes (scripts/track-gen.mjs placeFurniture), read via genFurn()
// below — every generated track uses it, the Backyard four included (they were re-baked
// through the decorated `mid` profile and gave up their hand-tuned furniture then). Only
// the Playroom Cup's segment-DSL tracks author furniture by hand, in OILS/PADS/BOXES.
import { GEN_TRACKS, GEN_FURNITURE } from './genTracks.js';

// Auto-placed furniture for a generated track — tolerant of a not-yet-baked id, so the
// registry can name a new track BEFORE gen-tracks.mjs runs (the bake pipeline itself
// imports this module; a hard read here would deadlock that workflow).
const genFurn = (id) => GEN_FURNITURE[id] || { oils: [], pads: [], boxes: [] };
const BEACH_SAND = 1.1;

// Track catalogue — DATA ONLY, no renderer. The single source of truth for "what
// tracks exist": each track is a display name, a default road `width`, and an ordered
// list of parametric SEGMENTS (the geometry). The native TrackBuilder integrates the
// segments into a drivable centerline; the renderer sweeps the procedural road over
// it. This file is codegen'd into the wasm by scripts/gen-track-defs-header.mjs, so
// an edit here is only live once that has run (tests/codegen-freshness.test.js).
//
// Kept dependency-free so the SAME module loads everywhere: the display engine, the
// Node unit tests (imported directly), and the classic-script gallery.
//
// ── SEGMENTS ─────────────────────────────────────────────────────────────────
//   straight(length, opts?)      a run of `length` (unscaled units; ×SCALE→world).
//   arc(radius, angleDeg, opts?) a turn of `angleDeg` about `radius`; +angle = LEFT,
//                                −angle = RIGHT.
//   loop(radius, opts?)          a vertical loop. Default: a HALF-loop — 180° of a
//                                planar circle, exiting at ±2·radius (over: false
//                                dives) heading the OPPOSITE way, frame flipped.
//                                With `drift`: the FULL 360° TILTED toy loop — one
//                                circle whose plane leans sideways, landing the
//                                exit `drift` beside the entry at ground level,
//                                parallel, heading unchanged; upside down only at
//                                the top instant. The tilt couples ~75° of frame
//                                holonomy per loop — cancel it with a matching
//                                `roll` (probe it) or the stretch after the loop
//                                rides visibly rolled.
// opts (any segment): rise (Δelevation over the segment, eased), bank (peak roll°,
//   eased — corners only in practice), roll (heartline twist about the centerline,
//   eased over the segment and CUMULATIVE downstream — small rolls trim the geometric
//   holonomy of climbing/tilted elements like the spiral and the drift loops; a full
//   roll: 360 corkscrews the road around a straight line and self-cancels, e.g. a
//   barrel roll), width (number or [start,end] taper, overriding the track default),
//   pillars (stand support columns from the grass up to a raised deck — flag the
//   ramp + bridge run of an overpass).
//
// ── HOW A TRACK CLOSES ───────────────────────────────────────────────────────
// The builder walks the segments and auto-closes the loop (gap < 0.5): headings must
// net a whole number of turns and the plan must return to the origin — the shipped
// stunt tracks below get their leg lengths from scripts/compose-stunt.mjs's closure
// solver rather than by hand. Rise…fall pairs are net-flat, so elevation closes by
// construction.
//
// This module holds the tracks that SHIP — everything reachable from CUPS, i.e. the
// phone picker. Dev surfaces (the Gym) live in devTracks.js.

const RL = 4.185;     // sweeping (large) corner radius

const straight = (length, opts = {}) => ({ kind: 'straight', length, ...opts });
const arc = (radius, angle, opts = {}) => ({ kind: 'arc', radius, angle, ...opts });
const loop = (radius, opts = {}) => ({ kind: 'loop', radius, ...opts });

// ---- Helix (Expert): the double-spiral skyway. Climb a 450° spiral to a long
// pillared bridge riding the east side at height, then corkscrew back to earth through
// a SAME-hand descending spiral; the south leg home threads an S-pair of tilted toy
// loops. Same-hand spirals wind the lap to a net -1080° (3 full turns — the plan is
// still a simple rounded rectangle). Composed by
// scripts/compose-stunt.mjs: the grid/top-leg lengths are its closure solve, each
// stunt's `roll` its probe-measured holonomy trim (spiral-down needs ~none — the
// descent's twist self-cancels against the same-hand climb already trimmed upstream).
export const HELIX = [
  straight(28),                                                      // grid, north-bound
  arc(RL, -90),                                                      // NE corner (unbanked — the spirals carry the cup's lean)
  straight(26),                                                      // top leg, east-bound
  arc(RL, -450, { rise: 2.6, bank: 10, pillars: true, roll: 39.6 }), // SPIRAL UP
  straight(28, { pillars: true }),                                   // THE SKYWAY, south-bound at height
  arc(RL, -450, { rise: -2.6, bank: 10, pillars: true, roll: -0.5 }),// SPIRAL DOWN (same hand)
  straight(8),                                                       // south leg — boost — straight into
  loop(2.2, { drift: 3, roll: 52 }),                                 // TOY LOOP L
  straight(10),                                                      // beat (rings stay 20 world apart)
  loop(2.2, { drift: -3, roll: -57.1 }),                             // TOY LOOP R (the S-pair)
  straight(8),                                                       // south-west run home
  arc(RL, -90)                                                       // SW corner into the grid
];

// ---- Skyline (Expert): the big-air one. A HALF-LOOP fires the pack straight up onto
// an 8-world-high skyway ridden back over its own approach — an Immelmann: the deck
// carries the 180° righting roll, eased across the whole span (peak twist ~0.17
// rad/world, inside the helicoid test's 0.21 bound) — then a banked descending U-turn
// swings outboard and dives home past one tilted toy loop. Composed by
// scripts/compose-stunt.mjs (solved legs + probe-measured roll trims, like Helix).
export const SKYLINE = [
  straight(13.8),                                                    // grid, north-bound (+1.8 with the south-bound run
  arc(RL, 90),                                                       //  below: slides the whole stunt section 3.6 world
  straight(16),                                                      //  north of the south edge, whose deck merged with
  arc(RL, 90),                                                       //  the half-loop mouth; closure stays exact)
  straight(14),                                                      // boost approach, south-bound
  loop(2.0),                                                         // HALF-LOOP UP → 8 world, heading flipped, frame inverted
  straight(24, { roll: 180, pillars: true }),                        // SKYWAY back over the approach — rolls upright
  arc(RL, 180, { rise: -2.0, bank: 10, pillars: true, roll: 6 }),    // descending U, swings outboard
  straight(6, { rise: -2.0, pillars: true }),                        // dive to ground
  straight(6),                                                       // flat beat — boost — straight into
  loop(2.2, { drift: -3, roll: -84 }),                               // TOY LOOP
  straight(11.8),                                                    // south-bound run (+1.8, see the grid straight)
  arc(RL, 90),                                                       // SW corner
  straight(27.37),                                                   // south edge home (closure-solved)
  arc(RL, 90)                                                        // into the grid
];

// ---- Gauntlet (Expert): thread the needle. The lap fires straight THROUGH the ring
// of its own toy loop — a pillared ramp narrows as it climbs, crests dead-centre in
// the ring's opening (5.0 world; the hole faces ±lateral, so the ramp runs
// perpendicular to the loop's travel), then plunges onto a low bridge that clears the
// loop's own boost leg before dropping home. Composed by scripts/compose-stunt.mjs:
// the align solver (solveAlign + measureRing) parked the crest 0.00 world off the
// ring axis; the odd lengths are its alignment + closure solves.
export const GAUNTLET = [
  straight(14),                                                      // grid, north-bound
  arc(RL, -90),                                                      // NE corner
  straight(12),                                                      // east leg
  arc(RL, -90),                                                      // south-bound
  straight(8),                                                       // boost — straight into
  loop(2.2, { drift: 3, roll: 66 }),                                 // THE RING (opening faces ±X)
  straight(10),                                                      // south spacing
  arc(RL, -90),                                                      // west-bound
  straight(6.315),                                                   // overshoot past the ring (align-solved)
  arc(RL, -90),                                                      // north-bound
  straight(5.815),                                                   // back to ring latitude (align-solved)
  arc(RL, -90),                                                      // east — straight at the ring
  straight(9, { rise: 2.51, pillars: true, width: [2.5, 2.2] }),     // THE RAMP — narrows, crests in the ring
  straight(6, { rise: -1.61, pillars: true, width: [2.2, 2.5] }),    // THE PLUNGE through and out
  straight(8, { pillars: true }),                                    // low bridge over the boost leg
  straight(5, { rise: -0.9, pillars: true }),                        // final drop to ground
  straight(8),                                                       // east run out
  arc(RL, -90),                                                      // south-bound
  straight(9.63),                                                    // (closure-solved 7.815, then +1.815 with the home leg
  arc(RL, -90),                                                      //  below: the south edge sat only 4 world from the
  straight(44.685),                                                  //  overshoot corridor — decks merged; stretching this
  arc(RL, -90),                                                      //  anti-parallel pair slides it 3.6 world clear while
  straight(7.815)                                                    //  keeping closure exact)
];

// ---- Skysnake (Hard): a slalom IN THE SKY. The spiral climbs to 5.2 world, the road
// weaves an S-S through the clouds on pillars, then dives home past a toy loop.
// Composed by scripts/compose-stunt.mjs (solved grid leg + probe-measured roll trims).
export const SKYSNAKE = [
  straight(40.837),                                                  // grid straight (closure-solved)
  arc(RL, -90),                                                      // east
  straight(10),
  arc(RL, -450, { rise: 2.6, bank: 10, pillars: true, roll: 18 }),   // SPIRAL UP → south
  arc(RL, 45, { pillars: true }), arc(RL, -45, { pillars: true }),   // THE SKY WEAVE @5.2 world
  arc(RL, -45, { pillars: true }), arc(RL, 45, { pillars: true }),
  straight(6, { pillars: true }),
  straight(10, { rise: -2.6, pillars: true }),                       // dive to ground
  straight(5),                                                       // boost — straight into
  loop(2.2, { drift: -3, roll: -90 }),                               // TOY LOOP
  straight(8),
  arc(RL, -90),                                                      // west
  straight(7),
  arc(RL, -90)                                                       // home
];

// ---- BACKYARD CUP — four SEEDED multi-crossing tracks. Each is a procedurally-generated
// closed plan whose self-crossings are lifted into overpasses, each on a short ramp of its
// own with the rest of the lap on the ground (scripts/track-gen.mjs, gen-tracks.mjs); the resolved waypoints are baked into GEN_TRACKS and used directly
// in the registry below. To reroll or change the seed picks, edit + run that script. ----

// Oil slicks per track — FIXED hazards. Placed by `u` (fraction of the lap, 0 =
// start/finish) and `lat` (lateral offset in world units; 0 = centreline). `radius`
// and `cones` optional. Off-centre so a careful line can thread past; tune by driving.
//
// Only the Playroom Cup's segment-DSL tracks are listed in these three tables: every
// generated cup (Beach/Snow/Backyard/Canyon) carries auto-placed furniture in
// GEN_FURNITURE instead, resolved via genFurn() in the registry below.
const OILS = {
  // Auto-placed (scripts/track-gen.mjs placeFurniture on the composed geometry) — gentle
  // open ground, clear of decks, spirals and the loops. The three tracks carrying a
  // `startU` were re-placed against their moved line (u is measured from it).
  helix:      [ { u: 0.198, lat: 0.7 }, { u: 0.818, lat: -0.7 } ],
  skyline:    [ { u: 0.834, lat: 0.7 }, { u: 0.245, lat: -0.7 } ],
  gauntlet:   [ { u: 0.29, lat: 0.7 }, { u: 0.795, lat: -0.7 } ],
  skysnake:   [ { u: 0.266, lat: 0.7 }, { u: 0.827, lat: -0.7 } ]
};

// Boost pads — drive-over speed strips, position-scaled for catch-up. Place on STRAIGHTS
// (XZ curvature ≈ 0, where the boost isn't wasted mid-corner), centred (lat 0) on the
// racing line. `u` = fraction of lap. A pure climb/descent counts as straight.
const PADS = {
  // Auto-placed on the cleanest straights. No pad is authored at a loop: every looping
  // auto-places a full-width launch strip at its own mouth (see main.js /
  // TrackBuilder.loopStarts), so the pack is always fired INTO each ring on boost.
  helix:      [ { u: 0.063, lat: 0.0 }, { u: 0.443, lat: 0.0 } ],
  skyline:    [ { u: 0.103, lat: 0.0 }, { u: 0.575, lat: 0.0 } ],
  gauntlet:   [ { u: 0.105, lat: 0.0 }, { u: 0.683, lat: 0.0 } ],
  skysnake:   [ { u: 0.066, lat: 0.0 }, { u: 0.608, lat: 0.0 } ]
};

// Item boxes — drive-over pickups in rows ACROSS the lane. `u` = fraction of lap, `lat`
// = lateral offset. A row is 4 spread across the lane; each track lays down TWO rows
// ~half a lap apart so there's a fresh pickup on each side of the lap (you can only hold
// one item, so a second grab point beats clustering them). The second `u` per track sits
// on the gentlest open stretch ~0.5 lap from the first — lowest curvature/grade, off the
// bridge decks and loops (pickups are safe, so a low deck is otherwise fine).
const BOX_LANES = [-1.05, -0.35, 0.35, 1.05];
const boxRow = (u) => BOX_LANES.map((lat) => ({ u, lat }));
const boxRows = (...us) => us.flatMap(boxRow);
const BOXES = {
  helix:      boxRows(0.086, 0.705),  // auto-placed: the grid run, then the south leg past the loops
  skyline:    boxRows(0.131, 0.695),  // auto-placed: the north leg, then the flat past the toy loop
  gauntlet:   boxRows(0.128, 0.559),  // auto-placed: the east leg, then the exit run past the plunge
  skysnake:   boxRows(0.096, 0.692)   // auto-placed: the grid straight, then the flat past the toy loop
};

// Set pieces — `set`, per track: the big landmarks that make one circuit look
// unlike the rest of its cup (the biome's scatter is the same on all four). Each
// names a composed model (scripts/gen-set-pieces.mjs, or modelled in Blender by
// scripts/gen-set-prototypes.mjs) and places it by `u`
// (fraction of the lap) and `lat` (world units off the centreline; + is the
// track's RIGHT), turned `yaw` degrees from the track's heading there; `y`
// lifts or sinks it, `scale` sizes it. Visual only: the sim never sees one, so a
// piece the road passes through has to leave the deck and its berm clear.
//
// Landforms — `land`, per track: the shapes the ground itself carries (the
// renderer sums them into its terrain; visual only, like `set`). Each is
// anchored like a set piece (`u`, `lat`, `yaw`) and shaped in that frame, +Z
// along the heading, +X the track's LEFT, in world units:
//   ridge  a capsule `len` long along +Z (a round hill at len 0): radius `r`
//          (`r1` at the +Z end), height `h` (`h1`), a flat crest `top` of r
//          (a mesa); a ridge falling to a wide low end is a debris fan
//   ring   a bank round a bowl: crest radius `r`, half-width `w`, height `h`
//   plain  a capsule like a ridge, `r` wide with a `w` fade, where the ground
//          is left UNRAISED: a creek bed or valley floor, the low line the
//          raised land stands over. Nothing goes below the plain itself. With
//          `h`, a channel: a bank that tall along both sides, its crest where
//          the fade ends; reaches chained round a bend keep one floor (no
//          bank crosses another reach's floor). The floor wears the biome's
//          creek-bed tint (the renderer's groundTint).
//   pond   open water on the plain: a capsule like a plain (`len`, `r` the
//          water's reach, `w` the land's fade back), its floor kept flat a
//          little past the water and the sheet drawn on it with its own
//          outline and a pebble shore. Only under a deck on pillars well over
//          the plain, never against a low slab; the dressing keeps off it as
//          off the sea
//   paint  a capsule like a plain that shapes nothing: it only colours the
//          ground (a piste down a mountain)
//   shore  (the beach) brings the sea's waterline in through the anchor, held
//          for `len` of shore and faded back out over `r`; never nearer than
//          a few units past the road, unless `w` lets it that far inside the
//          road's reach (the road then runs over the water). It only reaches
//          road that is the island's outermost on its bearing from the origin
//          (native/renderer/CLAUDE.md, the beach).
//   clear  a capsule like a plain that shapes nothing: no seeded tree, prop,
//          clutter or landmark stands within `r` of its spine (an avenue's
//          verge, kept to its own trees)
//   street `len` of road centred on `u` running through a village: its kerb
//          a low kerbstone instead of the biome's racing kerb, so the
//          pavement and front gardens beside it show from the seat. No lat,
//          r or yaw: it is the road's, both sides
// Any but a mound, a clear or a street may carry a `tint`, 0xRRGGBB, a
// multiplier over the ground's colour where the form lies (fading with its
// flank, or a plain's or paint's `w`); the ground's grid is 9 u, so a tint is
// a broad wash.
// Ground never rises through a deck (the renderer caps it under every road),
// but a form's flank beside a bend still hides the road ahead: keep them to
// the outsides of bends and to the open side of the lap.
//
// SET_GROUND, per MODEL: the ground a set piece was modelled standing on,
// in its own frame. The renderer lays it wherever the piece is placed (and
// levels no clearing under it), and scripts/gen-set-prototypes.mjs hands the
// same numbers to the Blender builder, so the model's towers and pines stand
// on the terrain they were built on. Two extra kinds here, the ground the
// builder builds on (set_ground()), which take the land under them:
//   mound  scripts/blender/set_prototypes.py's mound(): summit at (`x`, `z`),
//          `h` tall, reaching `r` toward +X, `r1` toward -X and `rz` along Z,
//          its flank cos(t·π/2)^`shape`
//   fan    a ridge's shape (`len`, `r`/`r1`, `h`/`h1`, `top`) lying ON the
//          mounds, its rise added to theirs: a debris fan spilling off a
//          slope to a wide low end
// A form's `yaw` turns it, and its (`x`, `z`), in the piece's frame.
export const SET_GROUND = {
  // Powder's ski mountain, its summit behind the lift (in the lift's frame),
  // the valley floor at its foot toward the road where the valley station,
  // the resort's chalets and the slalom's finish stand (a plain, so the
  // ground raised toward the deck does not bury them; the mountain's foot
  // stops a grid cell short of them, where the 9 u grid's chords over the
  // foot would), and the blue run washed down it from the top station to the
  // slalom and on to the finish on the flat (faint: a groomed run is white,
  // and a deeper blue read as a stain); Avalanche's slide face, the debris
  // fan over the chute's end (stopping a grid cell short of the road, whose
  // cap would leave what lies on it floating), and the slopes its fences and
  // warning signs stand under.
  'set-ski-lift': [
    { kind: 'mound', x: -54, h: 40.5, r: 62, r1: 60.75, rz: 101.25, shape: 1.15 },
    { kind: 'plain', x: 17, len: 66, r: 4, w: 5 },
    { kind: 'paint', yaw: 105.07, x: -4.41, z: -27.75, len: 36.35, r: 4, w: 5, tint: 0xdde7f5 },
    { kind: 'paint', yaw: 48.37, x: -10.43, z: 14.69, len: 32.51, r: 4, w: 5, tint: 0xdde7f5 }
  ],
  'set-avalanche-slide': [
    { kind: 'mound', x: -58, h: 40.6, r: 66.7, r1: 58, rz: 87, shape: 1.6 },
    { kind: 'fan', yaw: 90, z: -17, len: 14, r: 11, r1: 12, h: 1.4, h1: 1.1, top: 0.35, tint: 0xc8cfdf }
  ],
  // Flurry's lake: the ice lies on the plain, unraised, in two sheets with
  // the road crossing between them on its stilts and its berm, the west one
  // round the skaters' rink and the east one filling the inside of the bend
  // the road turns round it, its ground short of the cabin beyond (a piece
  // levels its clearing to the lowest ground under it). The ice may not run
  // under the deck, so the ground there wears its blue. No bank rings the
  // lake: it would rise under the ice.
  'set-frozen-lake': [
    { kind: 'plain', z: -1.5, len: 7, r: 15.5, w: 4, tint: 0xdcecf8 },
    { kind: 'plain', x: 23, z: -7, len: 10, r: 6.2, w: 2, tint: 0xdcecf8 },
    { kind: 'plain', x: 21.5, z: 7, len: 10, r: 6, w: 2, tint: 0xdcecf8 },
    { kind: 'paint', x: 11.9, z: 1.5, len: 23, r: 3.5, w: 3, tint: 0xa9d7ee }
  ],
  // Glacier's toboggan hill: the penguins' slide comes down its long face
  // toward the road (+X) to the water hole on the flat at its foot; broad
  // enough that the ground's 9 u grid draws it as a hill, not a cone.
  'set-penguin-chute': [{ kind: 'mound', x: -19, h: 7, r: 21, r1: 17, rz: 18, shape: 1.5 }],
  // Glacier's rookery: the snow slope the colony stands up, its face to the
  // road (+X), so the crowd shows row over row instead of as a line along the
  // kerb; broad, like the ski school's nursery slope, so the grid draws a hill.
  'set-penguin-group': [{ kind: 'mound', x: -8, h: 2.6, r: 12, r1: 9, rz: 11, shape: 1.2 }],
  // Glacier's expedition camp on a snow bank of its own, flat on top like the
  // den camp's and set back from the road: a camp on the flat hid its tents
  // behind the kerb; on the bank they show over it. The camp drapes, so it lies on the slope drawn:
  // the ground's 9 u grid draws a bank this size as a dome, not a terrace.
  'set-expedition-camp': [{ kind: 'fan', x: -2, z: -0.8, len: 7, r: 10, h: 2.6, top: 0.6 }],
  // ...and its advanced camp, past the bend where a racer looks at it, on a
  // bank kept low and a footprint kept small: there the ground already rises
  // toward the snow ridge, and the base camp's bank on it tipped every tent.
  'set-advanced-camp': [{ kind: 'fan', x: -0.5, z: 0.5, len: 4, r: 7, h: 1.3, top: 0.6 }],
  // Powder's ski school: the nursery slope behind it (-X), its gentle face to
  // the road, its foot reaching under the school's hut and arch so the whole
  // school stands up on it over the kerb of the road beside it.
  'set-ski-school': [{ kind: 'mound', x: -7, h: 4.2, r: 13, r1: 10, rz: 13, shape: 1.3 }],
  'set-avalanche-fence': [{ kind: 'mound', x: -28, h: 22.4, r: 26.6, r1: 25.2, rz: 36.4, shape: 1.6 }],
  'set-warning-sign': [{ kind: 'mound', x: -28, h: 22.4, r: 25.9, r1: 25.2, rz: 36.4, shape: 1.6 }],
  // Pretzel's oak on the crest of the knoll it grew on, its summit under the
  // trunk: short toward the road (+X), the hill falling away behind it and
  // along it over the corner of the garden.
  'set-treehouse': [{ kind: 'mound', h: 2.6, r: 18, r1: 32, rz: 26, shape: 0.6 }],
  // Ribbon's church on the churchyard's own level ground, cut into the
  // terrace it stands on, the green before it: on the slope as it was, the
  // tower stood a storey deep in the hill.
  'set-village-church': [{ kind: 'fan', x: 0.5, len: 10, r: 12, h: 1.9, top: 0.6 }],
  // Pretzel's den camp on a bank of its own, the same shape.
  'set-den-camp': [{ kind: 'fan', len: 6, r: 9, h: 1.4, top: 0.6 }],
  // Cloverleaf's playground hill: a broad round top the playground stands on
  // (flat for its whole width), steeper to the road (+X), falling away behind;
  // low enough that its crest does not hide the playground from the corner.
  'set-playground': [{ kind: 'mound', h: 2.5, r: 20, r1: 34, rz: 28, shape: 0.5 }],
  // Wash's creek, the stretch by the road: the bed is the low line the raised
  // land stands over between its cut banks, the wash's own land carrying on
  // from both ends (turned 90 so the spine runs along the creek's X).
  'set-dry-creek': [{ kind: 'plain', yaw: 90, len: 76, r: 6, w: 8, h: 1.5 }],
  'set-wash-bed': [{ kind: 'plain', len: 38, r: 7, w: 8, h: 1.5 }],
  // Gulch's mine: the rock spur rising behind the adit's rock face (-X; its
  // foot just behind the face, so the face stands whole on the yard instead
  // of poking out of the slope in shards) and the yard levelled in front of
  // it, toward the road.
  'set-mine-portal': [
    { kind: 'plain', yaw: 90, len: 8, r: 4, w: 5 },
    { kind: 'ridge', x: -13, len: 30, r: 8, h: 9, top: 0.3 }
  ],
  // Its ore line (placed on the portal's own anchor), from the yard round the
  // start straight and the east bend to the headframe: the level bed it
  // lies in, one plain per chord of its route, so it never steps where the
  // land rolls; its floor wider than a cell of the ground's grid (9 u), which
  // would otherwise draw its chords over the rails and leave the line in
  // pieces with the train riding through the hill. The builder lays the
  // rails on a smooth curve through the chords' ends (set_prototypes.py
  // ore_line). A form's x/z is in its own turned frame
  // (TtpRenderer::setupTerrain).
  'set-ore-line': [
    { kind: 'plain', yaw: 71.57, x: 0.16, z: 1.9, len: 2.85, r: 6, w: 5 },
    { kind: 'plain', yaw: 21.16, x: 2.66, z: 3.66, len: 3.32, r: 6, w: 5 },
    { kind: 'plain', yaw: 11.32, x: 3.53, z: 8.42, len: 7.27, r: 6, w: 5 },
    { kind: 'plain', yaw: -22.05, x: 9.58, z: 12.33, len: 8.4, r: 6, w: 5 },
    { kind: 'plain', yaw: 2.5, x: 1.85, z: 22.35, len: 6.66, r: 6, w: 5 },
    { kind: 'plain', yaw: -39.05, x: 18.41, z: 22.88, len: 9.78, r: 6, w: 5 },
    { kind: 'plain', yaw: -11.54, x: 3.5, z: 41.33, len: 16.39, r: 6, w: 5 },
    { kind: 'plain', yaw: -1.42, x: -5.26, z: 57.47, len: 16.2, r: 6, w: 5 },
    { kind: 'plain', yaw: 31.02, x: -39.61, z: 60.12, len: 15.21, r: 6, w: 5 },
    { kind: 'plain', yaw: 38.44, x: -48.02, z: 70.02, len: 15.94, r: 6, w: 5 },
    { kind: 'plain', yaw: 67.13, x: -79.57, z: 53.39, len: 16.06, r: 6, w: 5 }
  ]
};

// The height a model's SET_GROUND mounds and fans give at (x, z) in its own
// frame, over the plain: the highest mound and the fans lying on it, as the
// renderer composes them (TtpRenderer::landforms) and the Blender builder builds on them
// (set_prototypes.py set_ground(), which cannot import this).
export function setGroundY(model, x, z) {
  let mounds = 0, fans = 0;
  for (const f of SET_GROUND[model] || []) {
    if (f.kind !== 'mound' && f.kind !== 'fan') continue;
    const a = (f.yaw || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const lx = x * c - z * s - (f.x || 0), lz = x * s + z * c - (f.z || 0);
    if (f.kind === 'mound') {
      const t = Math.hypot(lx / (lx > 0 ? f.r : f.r1), lz / f.rz);
      if (t < 1) mounds = Math.max(mounds, f.h * Math.cos(t * Math.PI / 2) ** (f.shape ?? 1));
      continue;
    }
    // a fan is debris lying on the mounds: its rise adds to theirs
    const half = (f.len || 0) / 2, cz = Math.min(half, Math.max(-half, lz));
    const at = f.len ? (cz + half) / f.len : 0;
    const t = Math.hypot(lx, lz - cz) / (f.r + ((f.r1 ?? f.r) - f.r) * at);
    if (t >= 1) continue;
    const top = f.top || 0, k = t <= top ? 0 : Math.min(1, (t - top) / (1 - top));
    fans += (f.h + ((f.h1 ?? f.h) - f.h) * at) * (1 - k * k * (3 - 2 * k));
  }
  return mounds + fans;
}
//
// Registry of named, previewable tracks. Selected in the display via ?track=<key>.
export const TRACKS = {
  // Beach Cup — SEEDED easy circuits (scan-seeds `easy` profile: sweeping corners,
  // rolling hills + hops, width play, no crossings; auto-placed furniture).
  // Every Beach track carries a sand strip beside the asphalt (plan units per side).
  tidepool: {
    name: 'Tidepool', sand: BEACH_SAND, waypoints: GEN_TRACKS.tidepool,
    oils: genFurn('tidepool').oils, pads: genFurn('tidepool').pads, boxes: genFurn('tidepool').boxes,
    // Low tide: the reef the sea left bare runs along the waterline round the
    // lap (a spine of shelves, each turned to the shore), with its big rock
    // pool where the reef comes closest to the road, people at its edge, and
    // the crab fishers' landing above the reef just before it. The pool lies
    // beside the low west run that points at it, not at the waterline: out
    // there it hid behind the hump and read as a few grey lumps. On the two
    // outer bends the sea comes in to a few strides past the kerb (the
    // `shore`s), and the reef stands in that surf, its ledges awash.
    set: [
      { model: 'set-rock-pool', u: 0.675, lat: 16.7, yaw: 4 },
      { model: 'set-reef-shelf', u: 0.172, lat: 31.5, yaw: -1 },
      { model: 'set-reef-shelf', u: 0.228, lat: 31.5, yaw: -3 },
      { model: 'set-reef-shelf', u: 0.297, lat: 18.1, yaw: -10 },
      { model: 'set-reef-shelf', u: 0.353, lat: 18.2, yaw: 3 },
      { model: 'set-reef-shelf', u: 0.429, lat: 30.3, yaw: 19 },
      { model: 'set-reef-shelf', u: 0.739, lat: 18.4, yaw: 18 },
      { model: 'set-reef-shelf', u: 0.797, lat: 18.2, yaw: -3 },
      { model: 'set-crab-pots', u: 0.64, lat: 10.2, yaw: 10 }
    ],
    land: [
      { kind: 'shore', u: 0.325, lat: 8.8, len: 60, r: 30 },
      { kind: 'shore', u: 0.79, lat: 9.7, len: 80, r: 30 }
    ]
  },
  cove: {
    name: 'Cove', sand: BEACH_SAND, waypoints: GEN_TRACKS.cove,
    oils: genFurn('cove').oils, pads: genFurn('cove').pads, boxes: genFurn('cove').boxes,
    // The pirates' cove: the sea comes in to the road past the hop (its
    // `shore`, as near as the renderer lets it come), the jetty running out
    // past the surf to its rowing boat afloat and the ship riding at anchor
    // off its head; the old wreck lies in the surf of the west bend (the
    // second `shore` brings the sea in to it), bow run up the sand, and
    // Skull Rock ends a headland between the two bends. The crew's camp
    // smokes on the sand at the first bend, where the start straight looks.
    // The sea cannot come to the start: the curve is polar about the origin,
    // which lies on the start straight, so its outer side is never the
    // road's reach (native/renderer/CLAUDE.md).
    set: [
      { model: 'set-pirate-ship', u: 0.475, lat: 28.2, yaw: 180, y: -0.3 },
      { model: 'set-jetty', u: 0.47, lat: 9.7 },
      { model: 'set-shipwreck-ribs', u: 0.795, lat: 13, yaw: 75, y: -0.2 },
      { model: 'set-pirate-camp', u: 0.09, lat: 9.7, yaw: -20 },
      { model: 'set-skull-rock', u: 0.64, lat: 20, yaw: 30 }
    ],
    // Skull Rock is the end of a headland: a ridge running out from the
    // west shore to stare at the road across the bay between the two bends,
    // a broad crest green with the scrub that holds a headland (bare and
    // peaked, a hill that size is a desert dune; the beach's own hills say
    // so, theme.cc). The tint is a wash over the ground's 9 u grid, so only
    // a crest that wide and a tint that deep reads green from the road.
    land: [
      { kind: 'ridge', u: 0.64, lat: 42, yaw: 90, len: 24, r: 13, h: 12, top: 0.45, tint: 0x84c890 },
      { kind: 'shore', u: 0.45, lat: 12.2, len: 56, r: 30 },
      { kind: 'shore', u: 0.795, lat: 11.2, len: 24, r: 18 }
    ]
  },
  driftwood: {
    name: 'Driftwood', sand: BEACH_SAND, waypoints: GEN_TRACKS.driftwood,
    oils: genFurn('driftwood').oils, pads: genFurn('driftwood').pads, boxes: genFurn('driftwood').boxes,
    // A storm beach: the sea comes up to the road on the flat stretch (its
    // `shore`), and the line the storm tide left runs along the sand above
    // it, from the great trunk to the bonfire, wandering as it goes; the
    // dunes pile up inland, inside the loop. The hops on that stretch hide
    // what lies low beyond them, so the line is long pieces with their root
    // plates reared up, and the bonfire waits past the last hop.
    set: [
      { model: 'set-driftwood-trunk', u: 0.29, lat: -9, yaw: 180 },
      { model: 'set-strand-line', u: 0.33, lat: -10.2, yaw: 176 },
      { model: 'set-strand-line', u: 0.39, lat: -9.3, yaw: -4 },
      { model: 'set-bonfire', u: 0.45, lat: -8.7, yaw: 160 }
    ],
    land: [
      { kind: 'ridge', u: 0.58, lat: 36, len: 50, r: 15, h: 5, top: 0.2 },
      { kind: 'ridge', u: 0.97, lat: 32, r: 16, h: 4.5, top: 0.15 },
      // the storm sea comes up the beach to the strand line it left
      { kind: 'shore', u: 0.37, lat: -16.2, len: 110, r: 40 }
    ]
  },
  riptide: {
    name: 'Riptide', sand: BEACH_SAND, waypoints: GEN_TRACKS.riptide,
    oils: genFurn('riptide').oils, pads: genFurn('riptide').pads, boxes: genFurn('riptide').boxes,
    // Surf patrol: the sea comes in to the east road (its `shore`), and on
    // the strip of beach between them the lifeguard's tower looks out over
    // the swimmers' water, the umbrellas either side of it and the buoy line
    // and the surfers riding the swell beyond: one piece, at the end of the
    // east straight where the road bends away and a racer looks straight at it.
    // The shore is anchored where the patrol is, so it runs along the swim
    // line's own axis, and holds that line the length of the swim line and
    // past it: the line lies on the water, a swim's width out, end to end.
    // From the hop on, the road runs out over the shallows (the second
    // `shore`, whose `w` lets the water in past the road and the sea down
    // under it), the hop on timber piles (its `trestle`, scripts/gen-tracks.mjs)
    // and then a causeway on the renderer's bents: open sea outside, a strip
    // of lagoon inside, then the beach. Where it sets out, the town's end of
    // the beach: the promenade's huts and kiosk on a boardwalk at the outer
    // kerb, facing the cars down the straight, its pier out into the sea.
    set: [
      { model: 'set-lifeguard-tower', u: 0.23, lat: -8.7 },
      { model: 'set-promenade', u: 0.393, lat: -8.2, yaw: 180 }
    ],
    land: [
      { kind: 'shore', u: 0.23, lat: -12.2, len: 90, r: 30 },
      { kind: 'shore', u: 0.53, lat: 10, len: 40, r: 30, w: 11 }
    ]
  },
  // Snow Cup — SEEDED medium circuits (the gentle end of the mid profile: low brake
  // fraction, no hairpins, roomy radii, but real crossings + hills; auto-placed furniture).
  powder: {
    name: 'Powder', waypoints: GEN_TRACKS.powder,
    oils: genFurn('powder').oils, pads: genFurn('powder').pads, boxes: genFurn('powder').boxes,
    set: [
      { model: 'set-ski-lift', u: 0.9, lat: -32.5, yaw: 180 },
      { model: 'set-ski-school', u: 0.54, lat: -10.2, yaw: 160 }
    ]
  },
  flurry: {
    name: 'Flurry', waypoints: GEN_TRACKS.flurry,
    oils: genFurn('flurry').oils, pads: genFurn('flurry').pads, boxes: genFurn('flurry').boxes,
    set: [
      { model: 'set-frozen-lake', u: 0.3355, lat: -11.4, yaw: 180 },
      // the village round the lap, close by the road where a racer reads a
      // cabin (see:landmarks): by the start, on the east loop, on the run in
      { model: 'set-log-cabin', u: 0.05, lat: 9, yaw: 30 },
      { model: 'set-log-cabin', u: 0.675, lat: -9, yaw: 150 },
      { model: 'set-log-cabin', u: 0.875, lat: 11, yaw: 75 }
    ],
    // a frozen stream runs from the village loop under the crossing down to
    // the lake; the valley is closed by mountains on the outside of the lap,
    // one off each of its four sides, open between them at both ends of its
    // long axis so it reads as a valley, not a bowl: each a long snow ridge
    // with its peaks on it, the peaks' crests tinted rock, and a dark wash of
    // forest along its foot. Their crests stand about where the fog begins,
    // and their reach stays inside the terrain's 48-cell cap.
    land: [
      { kind: 'plain', u: 0.4413, lat: 5, yaw: -142, len: 54, r: 3, w: 5, tint: 0xc8e0f6 },
      { kind: 'ridge', u: 0.15, lat: 68, len: 120, r: 28, h: 16, top: 0.15 },
      { kind: 'ridge', u: 0.15, lat: 72, z: -38, len: 8, r: 24, h: 16, top: 0.2, tint: 0x56607a },
      { kind: 'ridge', u: 0.15, lat: 70, z: 2, len: 12, r: 20, h: 11, top: 0.2, tint: 0x56607a },
      { kind: 'ridge', u: 0.15, lat: 74, z: 36, len: 6, r: 24, h: 15, top: 0.2, tint: 0x56607a },
      { kind: 'ridge', u: 0.39, lat: -70, len: 100, r: 28, h: 15, top: 0.15 },
      { kind: 'ridge', u: 0.39, lat: -74, z: -28, len: 8, r: 22, h: 14, top: 0.2, tint: 0x56607a },
      { kind: 'ridge', u: 0.39, lat: -74, z: 24, len: 6, r: 24, h: 17, top: 0.2, tint: 0x56607a },
      { kind: 'ridge', u: 0.65, lat: 68, len: 120, r: 30, h: 17, top: 0.15 },
      { kind: 'ridge', u: 0.65, lat: 72, z: -40, len: 10, r: 22, h: 13, top: 0.2, tint: 0x56607a },
      { kind: 'ridge', u: 0.65, lat: 74, z: 0, len: 6, r: 26, h: 18, top: 0.2, tint: 0x56607a },
      { kind: 'ridge', u: 0.65, lat: 72, z: 38, len: 8, r: 22, h: 12, top: 0.2, tint: 0x56607a },
      { kind: 'ridge', u: 0.92, lat: -68, len: 80, r: 28, h: 13, top: 0.15 },
      { kind: 'ridge', u: 0.92, lat: -72, z: -15, len: 8, r: 22, h: 13, top: 0.2, tint: 0x56607a },
      { kind: 'paint', u: 0.15, lat: 42, len: 120, r: 3, w: 8, tint: 0x3f6050 },
      { kind: 'paint', u: 0.39, lat: -44, len: 100, r: 3, w: 8, tint: 0x3f6050 },
      { kind: 'paint', u: 0.65, lat: 42, len: 120, r: 3, w: 8, tint: 0x3f6050 },
      { kind: 'paint', u: 0.92, lat: -42, len: 80, r: 3, w: 8, tint: 0x3f6050 }
    ]
  },
  glacier: {
    name: 'Glacier', waypoints: GEN_TRACKS.glacier,
    oils: genFurn('glacier').oils, pads: genFurn('glacier').pads, boxes: genFurn('glacier').boxes,
    set: [
      { model: 'set-snow-fort', u: 0.237, lat: -10, yaw: 0 },
      { model: 'set-expedition-camp', u: 0.738, lat: -12, yaw: 0 },
      { model: 'set-penguin-group', u: 0.7, lat: 9, yaw: 255 },
      { model: 'set-penguin-group', u: 0.39, lat: 7.5, yaw: 285 },
      { model: 'set-advanced-camp', u: 0.897, lat: -13, yaw: 328 },
      { model: 'set-penguin-chute', u: 0.97, lat: -15, yaw: 130 }
    ],
    // Each piece stands where a racer reads it from the chase camera (the
    // see:landmarks probe), not where the old sight-line score put it: the
    // fort and its igloo camp at the end of the top straight, short of the
    // corridor down the middle whose vista the box cannot also pay a fort
    // for; the rookeries close by the low road; the expedition's base camp
    // and its smaller advanced camp by the bends.
    // The glacier: a tongue of blue ice flows down from the massif in the
    // west, low in the valley between two snow ridges, into the middle of the
    // map, ending among the penguins by the long legs; the terminal moraine
    // the ice left lies at the far end of the lap, which the long legs drive
    // straight at
    land: [
      { kind: 'ridge', u: 0.0491, lat: -126.1, yaw: 151, len: 60, r: 42, h: 28 },
      { kind: 'ridge', u: 0.9954, lat: -71.7, yaw: -122, z: 7, len: 136, r: 12, r1: 9, h: 3, h1: 1.2, top: 0.5, tint: 0x8cc2f2 },
      { kind: 'ridge', u: 0.0092, lat: -51.4, yaw: -122, x: 8, z: -5, len: 80, r: 13, h: 11, h1: 3.5, top: 0.15 },
      { kind: 'ridge', u: 0.7405, lat: -55.3, yaw: -65, x: -3, z: -5, len: 80, r: 13, h: 11, h1: 3.5, top: 0.15 },
      { kind: 'ridge', u: 0.6671, lat: -18.9, yaw: -172, len: 70, r: 22, h: 4.5, top: 0.55, tint: 0xbcb8c0 }
    ]
  },
  avalanche: {
    name: 'Avalanche', waypoints: GEN_TRACKS.avalanche,
    oils: genFurn('avalanche').oils, pads: genFurn('avalanche').pads, boxes: genFurn('avalanche').boxes,
    set: [
      { model: 'set-avalanche-slide', u: 0.76, lat: 16 },
      { model: 'set-windsock', u: 0.894, lat: 7.5, yaw: 48 },
      { model: 'set-warning-sign', u: 0.277, lat: 27.3, yaw: 55 },
      { model: 'set-warning-sign', u: 0.374, lat: 22.5, yaw: 55 },
      { model: 'set-avalanche-fence', u: 0.87, lat: 16, yaw: 20 },
      { model: 'set-avalanche-fence', u: 0.1, lat: -32.5, yaw: 160 },
      // Where the road runs under the slope, on the outside of the last
      // loop, it is cut into the mountainside and roofed over: two galleries,
      // each with the cut it stands in, astride the road. The shorter on the
      // run to the slide's foot, its cut wrapping the bend before it; the
      // longer on the straight after the slide. Each piece carries the road's
      // centreline in its own frame (set_prototypes.py ROAD_A, ROAD_B), so a
      // gallery's u here and its samples there move together.
      { model: 'set-avalanche-gallery-short', u: 0.722, lat: 0 },
      { model: 'set-avalanche-gallery', u: 0.825, lat: 0 }
    ],
    // the slope the long gallery's cut is in, rising behind it: clear of the
    // slide's and the fences' mounds, which would swallow it (landforms)
    land: [
      { kind: 'ridge', u: 0.82, lat: 24, len: 44, r: 14, h: 9, top: 0.2, tint: 0xa8b2c4 }
    ]
  },
  // Backyard Cup — SEEDED multi-crossing circuits (overpasses on their own ramps,
  // decorated mid profile; auto-placed furniture).
  ribbon: {
    name: 'Ribbon', waypoints: GEN_TRACKS.ribbon,
    oils: genFurn('ribbon').oils, pads: genFurn('ribbon').pads, boxes: genFurn('ribbon').boxes,
    // The village: the church on the east terrace where the grid straight
    // looks, the maypole on its green; the long diagonal runs down the
    // village street, cottages on both sides with their doors and open front
    // lawns on a pavement at the road's own level, the kerb a kerbstone there
    // (the `street`); another row of cottages at the west bend's exit, on
    // the flat by the road (the deck's cap holds any bank there down to it),
    // washing out in the gardens; the windmill turning in the middle of the
    // south loop, closing the view down the street
    set: [
      { model: 'set-village-church', u: 0.32107, lat: 21.693, yaw: 39.34 },
      { model: 'set-village-street', u: 0.37873, lat: 4, yaw: 1 },
      { model: 'set-village-street-b', u: 0.41257, lat: 4, yaw: 0 },
      { model: 'set-village-street-b', u: 0.3812, lat: -4.05, yaw: 180 },
      { model: 'set-village-street', u: 0.4145, lat: -4, yaw: 180 },
      { model: 'set-cottage-row', u: 0.608, lat: -7.6, yaw: 176.98 },
      { model: 'set-windmill', u: 0.6, lat: 13, yaw: 0 }
    ],
    // the valley the village lies in: two terraces climbing either side of
    // the circuit, a long bank behind the north loop and a round hill to the
    // south-east
    land: [
      { kind: 'ridge', u: 0.92671, lat: 19.8, yaw: 3.97, len: 120, r: 16, h: 3, top: 0.6 },
      { kind: 'ridge', u: 0.92746, lat: 29.818, yaw: 2.68, len: 100, r: 9, h: 3, top: 0.45 },
      { kind: 'ridge', u: 0.38249, lat: 25.92, yaw: 156.65, len: 120, r: 16, h: 3, top: 0.6 },
      { kind: 'ridge', u: 0.37558, lat: 34.185, yaw: 157.64, len: 100, r: 9, h: 3, top: 0.45 },
      { kind: 'ridge', u: 0.2, lat: -46, len: 60, r: 24, h: 6, top: 0.35 },
      { kind: 'ridge', u: 0.66022, lat: -27.168, r: 24, h: 7, top: 0.15 },
      { kind: 'street', u: 0.39565, len: 32 }
    ]
  },
  pretzel: {
    name: 'Pretzel', waypoints: GEN_TRACKS.pretzel,
    oils: genFurn('pretzel').oils, pads: genFurn('pretzel').pads, boxes: genFurn('pretzel').boxes,
    // The children's summer: the treehouse oak on its knoll (SET_GROUND)
    // past the north-west corner, where the start diagonal points, its den
    // round the foot; the pitch beside the diagonal with a game on, its
    // pavilion across it from the road, standing up behind the game over the
    // kerb that hides the lines; their camp by the
    // diagonal's top, where the racer comes off the north hairpin, the fire
    // smoking; an avenue of oaks either side of the start straight from the
    // overpass to the bend, through the gantry, its verge kept to them (the
    // `clear`)
    set: [
      { model: 'set-avenue-oaks', u: 0.01011, lat: 5.5, yaw: 0 },
      { model: 'set-avenue-oaks', u: 0.01011, lat: -5.5, yaw: 180 },
      { model: 'set-treehouse', u: 0.065, lat: 23, yaw: 25.44 },
      { model: 'set-football-pitch', u: 0.91, lat: -8.6, yaw: 1.41 },
      { model: 'set-den-camp', u: 0.534, lat: 11.842, yaw: 13.39, scale: 1.4 },
      { model: 'set-swing-oak', u: 0.17, lat: 7.5, yaw: 39.71 },
      { model: 'set-swing-oak', u: 0.755, lat: -9, yaw: 142.46 }
    ],
    land: [
      { kind: 'clear', u: 0.01011, len: 28, r: 14 }
    ]
  },
  tangle: {
    name: 'Tangle', waypoints: GEN_TRACKS.tangle,
    oils: genFurn('tangle').oils, pads: genFurn('tangle').pads, boxes: genFurn('tangle').boxes,
    // The mill stream: it rises inside the north loop, winds over the east,
    // middle and north lawns and round the north-west corner into the race of
    // the watermill on its pond, straight ahead of the grid (the wheel turns
    // with the water going down the race into the pond). The road lies on
    // the lawn for most of the lap, so where they meet the stream goes under
    // it: through a stone culvert, seen coming out each side, on the run to
    // the line, and under the two bridges, where the first bridge's west span
    // stands on its piers in a pond the stream opens into (`pond`), kept off
    // the low strand beside it, ducks and a pebble shore on its open half.
    // Laid reach by reach, each reach's end circle on the next one's, each
    // turned so its willow stands clear of every deck (half round puts it on
    // the other bank at the other end).
    set: [
      { model: 'set-watermill', u: 0.09204, lat: 24.151, yaw: 35.46 },
      { model: 'set-stream-reach', u: 0.92293, lat: -28.764, yaw: -40.76 },
      { model: 'set-stream-reach', u: 0.51248, lat: 8.411, yaw: 96.74 },
      { model: 'set-stream-reach', u: 0.50012, lat: -11.456, yaw: 116.55 },
      { model: 'set-stream-reach', u: 0.1139, lat: 9.04, yaw: -171.34 },
      { model: 'set-stream-reach', u: 0.10125, lat: 10.084, yaw: -162.76 },
      { model: 'set-stream-reach', u: 0.09737, lat: 12.372, yaw: -147.02 },
      { model: 'set-stream-reach', u: 0.89136, lat: -26.405, yaw: 59.8 },
      { model: 'set-stream-reach', u: 0.86586, lat: -7.524, yaw: -121.56 },
      { model: 'set-stream-reach', u: 0.83755, lat: 10.952, yaw: 55.43 },
      { model: 'set-culvert', u: 0.84819, lat: 4.42, yaw: -33.13 },
      { model: 'set-culvert', u: 0.86152, lat: -4.515, yaw: 148 },
      { model: 'set-pond-ducks', u: 0.1474, lat: -9.43, yaw: 180 }
    ],
    // the north lawn's hump the stream bends round, and the pond under the
    // first bridge's west span
    land: [
      { kind: 'ridge', u: 0.38886, lat: -26.736, yaw: 146.41, r: 12, h: 3, top: 0.2 },
      { kind: 'pond', u: 0.1471, lat: -1.93, yaw: 89.13, len: 15, r: 5.3, w: 6 }
    ]
  },
  cloverleaf: {
    name: 'Cloverleaf', waypoints: GEN_TRACKS.cloverleaf,
    oils: genFurn('cloverleaf').oils, pads: genFurn('cloverleaf').pads, boxes: genFurn('cloverleaf').boxes,
    // Playground hill: the playground on the broad top of its hill
    // (SET_GROUND) outside the south-west corner, where the start straight
    // points, the climbing net its tallest thing, every swing, seesaw and
    // roundabout going with a child on it, the park's ice-cream van parked
    // up there with the children queueing at it; another corner of the park
    // in the S between the two decks, seen from both. Built at the toy
    // world's chunkiness, so it reads from the road. The corner stands on
    // the flat by the road: the deck's cap holds any knoll there down to it.
    // The park's railway rings the lawn inside the top loop, its line three
    // units past the start straight's kerb and on round the hairpin, the top
    // straight and the bridge's leg, so its train runs beside the racers
    set: [
      { model: 'set-playground', u: 0.082, lat: -17, yaw: 171.96, y: -0.05, scale: 1.3 },
      { model: 'set-play-corner', u: 0.4, lat: -9.5, yaw: 142.61, y: -0.1, scale: 1.45 },
      { model: 'set-park-railway', u: 0.02538, lat: 9.658, yaw: 0 }
    ],
    // the round hill beyond the south bend and a long ridge closing the west
    land: [
      { kind: 'ridge', u: 0.2, lat: -48, r: 32, h: 10, top: 0.15 },
      { kind: 'ridge', u: 0.52, lat: -50, len: 70, r: 26, h: 7, top: 0.2 }
    ]
  },
  // Canyon Cup — SEEDED hard circuits (scan-seeds `hard` profile: hairpins, stacked
  // crossings, width pinches, crest hills; auto-placed furniture).
  wash: {
    name: 'Wash', waypoints: GEN_TRACKS.wash,
    oils: genFurn('wash').oils, pads: genFurn('wash').pads, boxes: genFurn('wash').boxes,
    // A dry wash and the canyon it cut: out of the start the road drops into
    // the wash's canyon, mountainsides of banded rock rising from both verges
    // down the straight and round the outside of the bend (set-canyon-peaks,
    // set-canyon-spur and set-canyon-bend-wash, the ridges in `land` carrying
    // the range on behind them), the inside of the bend left open so the
    // road ahead stays in sight. Out on the plain the wash winds across the
    // whole map, its gravel bed laid reach by reach (set-wash-bed, each
    // bringing its channel; the far north-west reaches, out of a racer's
    // sight, are channel only, in `land`), from the north-west past the
    // hero's stretch by the north straight (tumbleweeds blowing down it),
    // across the north strand, which fords it at the bed's level, into the
    // east loop and out under the east bend's low trestle (gen-tracks SEEDS
    // `trestle`: the bend's hill stands on pillars over the bed, not on an
    // embankment across it); a side wash comes in from the south across the
    // south strand, another ford. The bed is a shallow
    // channel, so what a racer sees of the wash where the road leaves it is
    // what grows along it: saguaros, ocotillo and
    // brush on its banks (each reach brings a stand on each side), and two
    // dead cottonwoods standing bare over the start's bends, a vulture on
    // each. A desert of rock, sand and cactus: nothing green but cactus.
    set: [
      { model: 'set-dry-creek', u: 0.9221, lat: -18.5, yaw: 112 },
      { model: 'set-dead-cottonwood', u: 0.302, lat: 10.5 },
      { model: 'set-dead-cottonwood', u: 0.95, lat: -10, yaw: -180 },
      { model: 'set-wash-bed', u: 0.7086, lat: -25.2, yaw: -144 },
      { model: 'set-wash-bed', u: 0.68, lat: -3.6, yaw: 77 },
      { model: 'set-wash-bed', u: 0.5997, lat: 10.7, yaw: 116 },
      { model: 'set-wash-bed', u: 0.5941, lat: -19, yaw: -93 },
      { model: 'set-wash-bed', u: 0.5933, lat: -48.9, yaw: 95 },
      { model: 'set-wash-bed', u: 0.5397, lat: -44.4, yaw: -102 },
      { model: 'set-wash-bed', u: 0.5332, lat: -17.6, yaw: 68 },
      { model: 'set-wash-bed', u: 0.5182, lat: 8.6, yaw: -91 },
      // the canyon's mountainsides, each face toward the road: the outer
      // range (left) down the straight, round the bend and on, lower spurs
      // on the inside of the straight and after the bend, the inside of the
      // bend left open so the road ahead stays in sight
      { model: 'set-canyon-peaks-a', u: 0.0198, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-peaks-b', u: 0.0582, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-bend-wash', u: 0.101, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-peaks-c', u: 0.1449, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-spur-a', u: 0.0439, lat: 5.2 },
      { model: 'set-canyon-spur-b', u: 0.1504, lat: 5.2 }
    ],
    // the range the canyon's mountainsides belong to, rising behind them
    land: [
      { kind: 'ridge', u: 0.03, lat: -25, len: 30, r: 14, h: 9, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.1, lat: -25, len: 8, r: 14, h: 10, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.15, lat: -25, len: 14, r: 14, h: 7.5, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.044, lat: 18, len: 18, r: 11, h: 6, top: 0.4, tint: 0xc8846a },
      { kind: 'ridge', u: 0.15, lat: 18, len: 12, r: 11, h: 5.5, top: 0.4, tint: 0xc8846a },
      // the wash's far reaches north-west of the creek, its channel only
      { kind: 'plain', u: 0.9863, lat: -74.2, yaw: -112, len: 38, r: 7, w: 8, h: 1.5 },
      { kind: 'plain', u: 0.9728, lat: -54.7, yaw: 66, len: 38, r: 7, w: 8, h: 1.5 }
    ]
  },
  gulch: {
    name: 'Gulch', waypoints: GEN_TRACKS.gulch,
    oils: genFurn('gulch').oils, pads: genFurn('gulch').pads, boxes: genFurn('gulch').boxes,
    // A gold mine at its own size, reached down a canyon of mountainsides off
    // the crest (the long left-hander and the tight bend into the yard): the
    // stamp mill across the start straight, its ore tramway's buckets riding
    // over the road to the adit, a car high, cut into the rock
    // face of a spur under the long ridge north of the start straight, one
    // ore line winding out of its yard along the whole start straight (on a
    // timber trestle beside it) and round the east bend to the headframe
    // over the shaft up the east side, its wheel turning over the east
    // bend, a little train of ore riding the line from the adit to
    // the shaft; grey spoil heaps at both workings and out by the far
    // bends, timber supports round the lap.
    set: [
      { model: 'set-mine-portal', u: 0.018, lat: 16 },
      { model: 'set-ore-line', u: 0.018, lat: 16 },
      { model: 'set-headframe', u: 0.2188, lat: 22.9, yaw: 67 },
      // the gulch itself: off the crest the road drops into a canyon of
      // mountainsides, the range on the outside of the long left-hander, down
      // the straight and round the tight bend into the mine yard, a lower spur
      // on the inside until the straight (Wash's lengths reused between bends)
      { model: 'set-canyon-bend-gulch', u: 0.862, lat: 5.2 },
      { model: 'set-canyon-peaks-a', u: 0.904, lat: 5.2 },
      { model: 'set-canyon-hairpin-gulch', u: 0.937, lat: 5.2 },
      { model: 'set-canyon-spur-a', u: 0.968, lat: 5.2 },
      { model: 'set-canyon-inside-gulch', u: 0.864, lat: -5.2, yaw: 180 },
      // the stamp mill cascading down its spoil heap across the start
      // straight from the adit, its tramway's buckets riding the sagging
      // ropes over the road to the tower beside the adit
      { model: 'set-stamp-mill', u: 0.005, lat: -11, yaw: 180 }
    ],
    // the ridge the mine is in, its spoil heaps (waste rock, greyer than the land)
    land: [
      { kind: 'ridge', u: 0.0004, lat: 48, len: 80, r: 22, h: 18, top: 0.3 },
      { kind: 'ridge', u: 0.202, lat: 43.4, len: 6, r: 10, h: 6, top: 0.15, tint: 0xb0a49c },
      { kind: 'ridge', u: 0.9715, lat: 30, r: 9, h: 5, top: 0.15, tint: 0xb0a49c },
      { kind: 'ridge', u: 0.3367, lat: 22.9, len: 14, r: 11, h: 7, top: 0.15, tint: 0xb0a49c },
      { kind: 'ridge', u: 0.8963, lat: 44, len: 14, r: 11, h: 7, top: 0.15, tint: 0xb0a49c },
      // the range the gulch's mountainsides belong to
      { kind: 'ridge', u: 0.862, lat: 24, len: 22, r: 13, h: 9, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.925, lat: 23, len: 12, r: 13, h: 8.5, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.864, lat: -16, len: 10, r: 10, h: 5, top: 0.4, tint: 0xc8846a }
    ]
  },
  crag: {
    name: 'Crag', waypoints: GEN_TRACKS.crag,
    oils: genFurn('crag').oils, pads: genFurn('crag').pads, boxes: genFurn('crag').boxes,
    // A ranch in butte country: buttes stand at the bends of both loops
    // and fields of hoodoos between them (rock: big as rock is), and the
    // ranch, every building at its own size, stands on the open plain at the
    // head of the long straight: house, barn, water tower, the windpump
    // turning, the corral with cattle. Out on the range its windpumps turn
    // over their stock tanks near the road, its herds come in to them (a cow
    // alone is a speck from the road; tower, tank and herd read as one).
    // Every wheel, the ranch's included, faces the one wind: the west wind
    // that blows the sand and the clouds east (+X) across the map, its tail
    // vane downwind. Each yaw turns its pump's wheel to the world's -X; the
    // ranch's own is turned inside its piece (set_prototypes.py
    // RANCH_WIND_YAW, for the ranch as it stands here).
    set: [
      { model: 'set-ranch', u: 0.986, lat: -19, yaw: 180 },
      { model: 'set-windpump', u: 0.175, lat: 10, yaw: 90 },
      { model: 'set-windpump', u: 0.58, lat: -14, yaw: 154 },
      { model: 'set-windpump', u: 0.48, lat: 12.5, yaw: -137 },
      { model: 'set-hoodoos', u: 0.3, lat: 18 },
      { model: 'set-hoodoos', u: 0.62, lat: -16, yaw: 180 },
      { model: 'set-hoodoos', u: 0.9, lat: 16 },
      // the buttes: rock of the land's own strata standing in the talus they
      // shed (rock in slopes, not sand), on the outsides of the two loops'
      // bends where the road runs at them: a broad butte, then a pair of its
      // towers, round each loop
      { model: 'set-rimrock-butte', u: 0.32, lat: 24, yaw: 90 },
      { model: 'set-rimrock-spires', u: 0.38, lat: 23, yaw: 20 },
      { model: 'set-rimrock-butte', u: 0.8, lat: 24, yaw: -100, scale: 0.95 },
      { model: 'set-rimrock-spires', u: 0.865, lat: 23, yaw: 200, scale: 1.05 }
    ]
  },
  sidewinder: {
    name: 'Sidewinder', waypoints: GEN_TRACKS.sidewinder,
    oils: genFurn('sidewinder').oils, pads: genFurn('sidewinder').pads, boxes: genFurn('sidewinder').boxes,
    // A desert highway: the telegraph line along the long straight, a
    // filling station on its verge with its sign turning and a hawk over it,
    // a little oil field outside the north loop, its old derrick standing
    // over the tank battery, its pumpjacks nodding and tumbleweeds blowing
    // by, and mesa rims closing the west as
    // near backdrops (the north and east stay open). Past the start the
    // long straight runs into a mountain of banded rock and through it in a
    // tunnel: the massif rises off its right to a summit, throws a spur
    // across the road that falls away into the low ground inside the bend
    // beyond, and runs on off the right as a ridge of the land. Everything by the road
    // at its own size, the rock as big as rock is.
    set: [
      { model: 'set-telegraph-line', u: 0.02, lat: 9.2 },
      { model: 'set-filling-station', u: 0.972, lat: -9.5, yaw: 180 },
      { model: 'set-oil-field', u: 0.77, lat: 15 },
      { model: 'set-mountain-tunnel', u: 0.1039, lat: 0 }
    ],
    // the mesa rims: across the far end of the long straight, and south-west
    // past the south loop, no crest edge more than about 8 degrees over the
    // horizon from any point of the road; and the mountain's range running
    // on from its west end, rock-tinted
    land: [
      { kind: 'ridge', u: 0.115, lat: 58, yaw: 80, len: 40, r: 13, h: 9, top: 0.3, tint: 0xc8846a },
      { kind: 'ridge', u: 0.1784, lat: 100, yaw: 4, len: 120, r: 30, h: 13, top: 0.5 },
      { kind: 'ridge', u: 0.7313, lat: 106, yaw: 151, len: 130, r: 30, h: 14, top: 0.5 }
    ]
  },
  // Rooftop Cup — segment-DSL stunt circuits (overpass + loops).
  // `startU` moves the start/finish line a fraction of a lap along the ring (see
  // TrackBuilder.finalizeTrack). The GRID sits BEHIND the line — the cars spawn at
  // totalS -2.5…-6.5 and lap 1 opens by driving across it — and a segment walk's opening
  // straight runs FORWARD from the origin, so without this the grid backs into whatever
  // corner closes the lap. Each value here nudges the line ~8.5 world units up its own
  // opening straight, which puts the whole grid on it. The generated tracks solve the same
  // problem at bake time instead (scripts/track-gen.mjs chooseAnchor). Gauntlet needs none:
  // its walk already opens with enough straight behind the line.
  skysnake: {
    name: 'Skysnake', segments: SKYSNAKE, startU: 0.026,
    oils: OILS.skysnake, pads: PADS.skysnake, boxes: BOXES.skysnake,
    // Snakes and ladders, at the toy cars' own scale: the board stood up half
    // open past the dive's loop, outside the bend the loop runs out into, its
    // face turned to the racers coming down the dive (lying flat, it showed
    // only a sliver over the kerb), and its box stood on edge where the grid
    // straight points; the board's wooden snakes have come
    // alive, one rearing at the racers inside the bend where the south leg
    // turns for the line, two more slithering round either side of the grid
    // straight's end. The game again as a floor mat the grid straight runs
    // down the middle of, its big pawns and foam dice stood on it, and just
    // past the mat's end the racers' toy car park on the infield, its lift
    // and spiral ramp running
    set: [
      { model: 'set-floor-mat', u: 0, lat: 0 },
      { model: 'set-toy-garage', u: 0.08, lat: -10, yaw: 180 },
      { model: 'set-jointed-snake', u: 0.9754, lat: 10, yaw: 180 },
      { model: 'set-snakes-ladders', u: 0.8454, lat: 14, yaw: 45 },
      { model: 'set-game-box', u: 0.29, lat: 12 },
      { model: 'set-toy-snake-loop', u: 0.17, lat: -8 },
      { model: 'set-toy-snake-loop', u: 0.25, lat: 9, yaw: 120 }
    ]
  },
  gauntlet: {
    name: 'Gauntlet', segments: GAUNTLET,
    oils: OILS.gauntlet, pads: PADS.gauntlet, boxes: BOXES.gauntlet,
    // The toy castle siege, one set of toy knights split into two sides,
    // laid across the long home straight: the red besiegers' siege tower, a
    // rank marching before it, inside it, and a rank of the castle's blue
    // knights with their cannon, and its dragon, outside, facing them across
    // the road. The race runs through no-man's land and under the castle's
    // outer gatehouse (set-castle-gate, astride the road) toward the block
    // castle itself, where the straight points. Another blue rank stands in
    // the infield, another siege tower where the grid straight points and the
    // besiegers' trebuchet, its arm just thrown toward the castle, where the
    // south straight points (a rank alone is a speck down a long straight; a
    // tall engine reads from its far end).
    set: [
      { model: 'set-toy-soldiers', u: 0.8, lat: 6.7 },
      { model: 'set-siege-tower', u: 0.81, lat: -8.7, yaw: 180 },
      { model: 'set-toy-dragon', u: 0.825, lat: 8 },
      { model: 'set-castle-gate', u: 0.85, lat: 0 },
      { model: 'set-block-castle', u: 0.9568, lat: 16, yaw: 24 },
      { model: 'set-toy-soldiers', u: 0.4, lat: 7.5, yaw: 20 },
      { model: 'set-siege-tower', u: 0.0777, lat: 14.5, yaw: 35 },
      { model: 'set-trebuchet', u: 0.186, lat: 17.2, yaw: 270 }
    ]
  },
  helix: {
    name: 'Helix', segments: HELIX, startU: 0.020,
    oils: OILS.helix, pads: PADS.helix, boxes: BOXES.helix,
    // The marble run: the lap in small (about 50 cm of it) where the top
    // straight points, marbles up inside one tower and out of its cup, down
    // its own screw or along the high chute and down the other's (the two
    // spirals and the skyway), then home along the floor, never rolling
    // uphill in sight; more of the kit stands about the room: a marble screw
    // round a column, a slinky walking down off an alphabet block beside
    // it, where the grid straight points, and a zigzag of chutes between two columns
    // outside the raised straight and again by the loop's entry; a tin
    // humming top and a wooden one spin short of the run; and the run's high
    // chute beside the skyway inside its bend, at the deck's own height, its
    // marbles racing the cars along it
    set: [
      { model: 'set-marble-run', u: 0.2769, lat: 22, yaw: -131 },
      { model: 'set-marble-tower', u: 0.1253, lat: 14.5, yaw: -45 },
      { model: 'set-spinning-top', u: 0.215, lat: -5.5 },
      { model: 'set-marble-zigzag', u: 0.8246, lat: 9.4, yaw: 148 },
      { model: 'set-marble-zigzag', u: 0.5174, lat: 12.2, yaw: 100 },
      { model: 'set-marble-skyway', u: 0.477, lat: -5 }
    ]
  },
  skyline: {
    name: 'Skyline', segments: SKYLINE, startU: 0.024,
    oils: OILS.skyline, pads: PADS.skyline, boxes: BOXES.skyline,
    // Block city: a town of wooden blocks on a city play rug past the top
    // straight, ahead of both the grid straight and the skyway, a crane
    // turning on its building site; towers a child stacked to the skyway's
    // own height stand past where the skyway lands, where the two legs
    // beside the skyway point and where the back straight points
    set: [
      { model: 'set-block-city', u: 0.125, lat: -18, yaw: 180 },
      { model: 'set-block-towers', u: 0.5319, lat: -14.9, yaw: -138 },
      { model: 'set-block-towers', u: 0.802, lat: -13.6, yaw: -172 },
      { model: 'set-block-towers', u: 0.975, lat: -14.5, yaw: 138 }
    ]
  }
};

// Cups — curated, ordered sets of tracks (a "grand prix" grouping). Each cup lists its
// track ids easiest→hardest; the controller picker renders one labelled section per cup.
// CUPS is the SOURCE OF TRUTH for track ordering — TRACK_ORDER / TRACK_LIST below are
// derived by flattening it, so a track appears in the picker iff it's listed in a cup.
// New track: add the descriptor to TRACKS above, then drop its id into a cup here.
// Cup order IS the difficulty ladder; each cup's biome is
// mapped in native/libttp-runtime/ttp/theme.cc CUP_BIOME (Backyard keeps the
// canonical grass look), reached from here through the `cup` field
// gen-track-defs-header.mjs carries into the C++ catalogue.
//
// `difficulty` (1–4) belongs to the CUP, never to a track: it sets how well the CPU
// fill drives (ttp::aiSkillForTier). It is data only — no screen renders it — and
// the codegen refuses a cup without one.
export const CUPS = [
  { id: 'beach',    name: 'Beach Cup',    difficulty: 1, tracks: ['tidepool', 'cove', 'driftwood', 'riptide'] }, // easy: flowing sweepers + hops (beach biome)
  { id: 'snow',     name: 'Snow Cup',     difficulty: 2, tracks: ['powder', 'flurry', 'glacier', 'avalanche'] }, // medium: gentle-mid crossings, hills and jumps (snow biome)
  { id: 'backyard', name: 'Backyard Cup', difficulty: 3, tracks: ['ribbon', 'pretzel', 'tangle', 'cloverleaf'] }, // middle: seeded multi-crossing circuits (grass biome)
  { id: 'canyon',   name: 'Canyon Cup',   difficulty: 3, tracks: ['wash', 'gulch', 'crag', 'sidewinder'] },   // hard: hairpins + stacked crossings (canyon biome)
  // crazy: stunts (playroom biome — orange plastic track).
  // id stays 'rooftop' (wired into CUP_BIOME/selections); only the display name moved.
  { id: 'rooftop',  name: 'Playroom Cup', difficulty: 4, tracks: ['skysnake', 'skyline', 'helix', 'gauntlet'] }
];

// id → { cup, cupName, cupDifficulty } so each track knows its cup for the picker. Validate
// ids first (a cup naming a track absent from TRACKS would otherwise vanish silently).
const CUP_OF = {};
for (const c of CUPS) {
  for (const id of c.tracks) if (!TRACKS[id]) throw new Error(`CUPS references unknown track "${id}"`);
  for (const id of c.tracks) CUP_OF[id] = { cup: c.id, cupName: c.name, cupDifficulty: c.difficulty };
}

// Stable display order for the gallery / picker — every cup's tracks, in cup order.
const TRACK_ORDER = CUPS.flatMap((c) => c.tracks);

// Flat list — {id, name, cup, cupName, cupDifficulty, segments, waypoints,
// startU, oils, pads, boxes, poles} in cup order.
//
// The shipped game does NOT build from this list: its catalogue is codegen'd into the
// wasm from TRACKS (scripts/gen-track-defs-header.mjs → track_defs.h) and read back out
// at boot. TRACK_LIST feeds everything that previews or derives from the authored data
// instead — the display/controller TestHarnesses, the trailer editor, the schematic and
// export bakes, and the unit tests that iterate every shipped track. So a new descriptor
// field reaches the GAME only through the codegen; copy it here too, or the previews
// silently disagree with the game. `startU` and `sand` are two of those; `width` is
// deliberately absent because no descriptor sets it (the shipped width games are
// per-SEGMENT).
export const TRACK_LIST = TRACK_ORDER.map((id) => ({
  id, name: TRACKS[id].name,
  cup: CUP_OF[id].cup, cupName: CUP_OF[id].cupName, cupDifficulty: CUP_OF[id].cupDifficulty,
  segments: TRACKS[id].segments, waypoints: TRACKS[id].waypoints, startU: TRACKS[id].startU, sand: TRACKS[id].sand,
  oils: TRACKS[id].oils, pads: TRACKS[id].pads, boxes: TRACKS[id].boxes, poles: TRACKS[id].poles
}));
