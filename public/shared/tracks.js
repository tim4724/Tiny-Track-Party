// Resolved waypoints for the seeded generated tracks (generated offline by
// scripts/gen-tracks.mjs — solver-placed elevation + difficulty-profile decoration and the
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
// closed plan whose self-crossings are lifted into overpasses by a solved elevation profile
// (scripts/gen-tracks.mjs); the resolved waypoints are baked into GEN_TRACKS and used directly
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
//   paint  a capsule like a plain that shapes nothing: it only colours the
//          ground (a piste down a mountain)
// Any of them but a mound may carry a `tint`, 0xRRGGBB, a multiplier over the
// ground's colour where the form lies (fading with its flank, or a plain's or
// paint's `w`); the ground's grid is 9 u, so a tint is a broad wash.
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
  // Powder's ski mountain, its summit behind the lift (the lift's frame, grown
  // 1.35 by its builder), and the blue run washed down it from the top
  // station to the slalom and on to the finish on the flat; Avalanche's slide
  // face, the debris fan over the chute's end (stopping a grid cell short of
  // the road, whose cap would leave what lies on it floating), and its
  // fences' slopes.
  'set-ski-lift': [
    { kind: 'mound', x: -54, h: 40.5, r: 74.25, r1: 60.75, rz: 101.25, shape: 1.15 },
    { kind: 'paint', yaw: 105.07, x: -4.41, z: -27.75, len: 36.35, r: 4, w: 5, tint: 0xb4cdf2 },
    { kind: 'paint', yaw: 48.37, x: -10.43, z: 14.69, len: 32.51, r: 4, w: 5, tint: 0xb4cdf2 }
  ],
  'set-avalanche-slide': [
    { kind: 'mound', x: -58, h: 40.6, r: 66.7, r1: 58, rz: 87, shape: 1.6 },
    { kind: 'fan', yaw: 90, z: -17, len: 14, r: 11, r1: 12, h: 1.4, h1: 1.1, top: 0.35, tint: 0xc8cfdf }
  ],
  // Flurry's lake: the ice lies on the plain, unraised, and the snow banks up
  // round it (the road crosses its east edge on stilts).
  'set-frozen-lake': [
    { kind: 'plain', r: 15.5, w: 4, tint: 0xdcecf8 },
    { kind: 'ring', r: 21, w: 6, h: 3.5 }
  ],
  'set-avalanche-fence': [{ kind: 'mound', x: -28, h: 22.4, r: 26.6, r1: 25.2, rz: 36.4, shape: 1.6 }],
  // Pretzel's oak on the crest of the hill it grew on, its summit under the
  // trunk: short toward the road (+X), the hill falling away behind it and
  // along it across the north-east corner of the garden.
  'set-treehouse': [{ kind: 'mound', h: 3.0, r: 17, r1: 40, rz: 28, shape: 1.4 }],
  // Wash's creek, the stretch by the road: the bed is the low line the raised
  // land stands over between its cut banks, the wash's own land carrying on
  // from both ends (turned 90 so the spine runs along the creek's X).
  'set-dry-creek': [{ kind: 'plain', yaw: 90, len: 76, r: 6, w: 8, h: 3 }],
  'set-wash-bed': [{ kind: 'plain', len: 38, r: 7, w: 8, h: 3 }],
  // Gulch's mine: the rock spur the adit is cut into (behind it, -X) and the
  // yard levelled in front of it, toward the road.
  'set-mine-portal': [
    { kind: 'plain', yaw: 90, z: 5, len: 16, r: 6, w: 6 },
    { kind: 'ridge', x: -14, len: 34, r: 10, h: 10, top: 0.3 }
  ],
  // Its ore line (placed on the portal's own anchor), from the yard round the
  // start straight and the east bend to the headframe: the shallow cutting it
  // lies in, one plain per chord of its route, so it never steps where the
  // land rolls. The builder lays the rails on a smooth curve through the
  // chords' ends (set_prototypes.py ore_line). A form's x/z is in its own
  // turned frame (TtpRenderer::setupTerrain).
  'set-ore-line': [
    { kind: 'plain', yaw: 71.57, x: 0.16, z: 1.9, len: 2.85, r: 6, w: 6, h: 1.2 },
    { kind: 'plain', yaw: 21.16, x: 2.66, z: 3.66, len: 3.32, r: 6, w: 6, h: 1.2 },
    { kind: 'plain', yaw: 11.32, x: 3.53, z: 8.42, len: 7.27, r: 6, w: 6, h: 1.2 },
    { kind: 'plain', yaw: -22.05, x: 9.58, z: 12.33, len: 8.4, r: 6, w: 6, h: 1.2 },
    { kind: 'plain', yaw: 2.5, x: 1.85, z: 22.35, len: 6.66, r: 6, w: 6, h: 1.2 },
    { kind: 'plain', yaw: -39.05, x: 18.41, z: 22.88, len: 9.78, r: 6, w: 6, h: 1.2 },
    { kind: 'plain', yaw: -11.54, x: 3.5, z: 41.33, len: 16.39, r: 6, w: 6, h: 1.2 },
    { kind: 'plain', yaw: -1.42, x: -5.26, z: 57.47, len: 16.2, r: 6, w: 6, h: 1.2 },
    { kind: 'plain', yaw: 31.02, x: -39.61, z: 60.12, len: 15.21, r: 6, w: 6, h: 1.2 },
    { kind: 'plain', yaw: 38.44, x: -48.02, z: 70.02, len: 15.94, r: 6, w: 6, h: 1.2 },
    { kind: 'plain', yaw: 67.13, x: -79.57, z: 53.39, len: 16.06, r: 6, w: 6, h: 1.2 }
  ],
  // Crag's flank the sauropod weathers out of, its summit behind (-X).
  'set-sauropod': [{ kind: 'mound', x: -18, h: 17, r: 24, r1: 26, rz: 48, shape: 1.3 }]
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
  tidepool: {
    name: 'Tidepool', waypoints: GEN_TRACKS.tidepool,
    oils: genFurn('tidepool').oils, pads: genFurn('tidepool').pads, boxes: genFurn('tidepool').boxes,
    // Low tide: the reef the sea left bare runs along the waterline round the
    // lap (a spine of shelves, each turned to the shore), with its big rock
    // pool where the reef comes closest to the road, people at its edge, and
    // the crab fishers' landing above the reef.
    set: [
      { model: 'set-rock-pool', u: 0.866, lat: 27, yaw: 4 },
      { model: 'set-reef-shelf', u: 0.172, lat: 31.5, yaw: -1 },
      { model: 'set-reef-shelf', u: 0.228, lat: 31.5, yaw: -3 },
      { model: 'set-reef-shelf', u: 0.297, lat: 30, yaw: -10 },
      { model: 'set-reef-shelf', u: 0.353, lat: 30, yaw: 3 },
      { model: 'set-reef-shelf', u: 0.429, lat: 30.3, yaw: 19 },
      { model: 'set-reef-shelf', u: 0.683, lat: 32.5, yaw: -5 },
      { model: 'set-reef-shelf', u: 0.739, lat: 29.5, yaw: 18 },
      { model: 'set-reef-shelf', u: 0.797, lat: 29.5, yaw: -3 },
      { model: 'set-reef-shelf', u: 0.928, lat: 32.8, yaw: -23 },
      { model: 'set-crab-pots', u: 0.7, lat: 5.5, yaw: 10 }
    ]
  },
  cove: {
    name: 'Cove', waypoints: GEN_TRACKS.cove,
    oils: genFurn('cove').oils, pads: genFurn('cove').pads, boxes: genFurn('cove').boxes,
    // The pirates' cove: the sea comes in to the road past the hop (its
    // `shore`), the ship riding at anchor off the end of the jetty; the old
    // wreck lies run up the beach after the start, the crew's camp smokes
    // before it, and Skull Rock ends a headland between the two bends.
    set: [
      { model: 'set-pirate-ship', u: 0.45, lat: 22, yaw: 180, y: -0.3 },
      { model: 'set-jetty', u: 0.43, lat: 8 },
      { model: 'set-shipwreck-ribs', u: 0.1, lat: 11, yaw: 90 },
      { model: 'set-pirate-camp', u: 0.82, lat: 7.5, yaw: 20 },
      { model: 'set-skull-rock', u: 0.64, lat: 20, yaw: 30 }
    ],
    // Skull Rock is the end of a headland: a rocky ridge running out from the
    // west shore to stare at the road across the bay between the two bends
    land: [
      { kind: 'ridge', u: 0.64, lat: 42, yaw: 90, len: 24, r: 13, h: 12, top: 0.2 },
      { kind: 'shore', u: 0.45, lat: 14, len: 56, r: 30 }
    ]
  },
  driftwood: {
    name: 'Driftwood', waypoints: GEN_TRACKS.driftwood,
    oils: genFurn('driftwood').oils, pads: genFurn('driftwood').pads, boxes: genFurn('driftwood').boxes,
    // A storm beach: the sea comes up to the road on the flat stretch (its
    // `shore`), and the line the storm tide left runs along the sand above
    // it, from the great trunk to the bonfire, wandering as it goes; the
    // dunes pile up inland, inside the loop.
    set: [
      { model: 'set-driftwood-trunk', u: 0.29, lat: -6, yaw: 180 },
      { model: 'set-strand-line', u: 0.316, lat: -6.5, yaw: 172 },
      { model: 'set-strand-line', u: 0.344, lat: -8.5, yaw: 8 },
      { model: 'set-strand-line', u: 0.372, lat: -6.5, yaw: 186 },
      { model: 'set-strand-line', u: 0.4, lat: -7, yaw: -6 },
      { model: 'set-bonfire', u: 0.43, lat: -6.5, yaw: 160 }
    ],
    land: [
      { kind: 'ridge', u: 0.58, lat: 36, len: 50, r: 15, h: 5, top: 0.2 },
      { kind: 'ridge', u: 0.97, lat: 32, r: 16, h: 4.5, top: 0.15 },
      // the storm sea comes up the beach to the strand line it left
      { kind: 'shore', u: 0.37, lat: -14, len: 110, r: 40 }
    ]
  },
  riptide: {
    name: 'Riptide', waypoints: GEN_TRACKS.riptide,
    oils: genFurn('riptide').oils, pads: genFurn('riptide').pads, boxes: genFurn('riptide').boxes,
    // Surf patrol: the sea comes in to the east road (its `shore`), and on
    // the strip of beach between them the lifeguard's tower looks out over
    // the swimmers' water, the umbrellas either side of it and the buoy line
    // and the surfers riding the swell beyond.
    set: [
      { model: 'set-lifeguard-tower', u: 0.19, lat: -6.5 },
      { model: 'set-buoy-line', u: 0.19, lat: -17 },
      { model: 'set-parasol', u: 0.165, lat: -6 },
      { model: 'set-parasol', u: 0.215, lat: -6.5, yaw: 15 }
    ],
    land: [
      { kind: 'shore', u: 0.19, lat: -10, len: 60, r: 30 }
    ]
  },
  // Snow Cup — SEEDED medium circuits (the gentle end of the mid profile: low brake
  // fraction, no hairpins, roomy radii, but real crossings + climb; auto-placed furniture).
  powder: {
    name: 'Powder', waypoints: GEN_TRACKS.powder,
    oils: genFurn('powder').oils, pads: genFurn('powder').pads, boxes: genFurn('powder').boxes,
    set: [
      { model: 'set-ski-lift', u: 0.9, lat: -32.5, yaw: 180 },
      { model: 'set-ski-rack', u: 0.695, lat: 22.5, yaw: 20 },
      { model: 'set-piste-fence', u: 0.96, lat: -7, yaw: 180 },
      { model: 'set-piste-fence', u: 0.06, lat: 7.5 },
      { model: 'set-ski-rack', u: 0.03, lat: 9, yaw: 20 },
      { model: 'set-ski-rack', u: 0.55, lat: -7.2, yaw: 160 }
    ]
  },
  flurry: {
    name: 'Flurry', waypoints: GEN_TRACKS.flurry,
    oils: genFurn('flurry').oils, pads: genFurn('flurry').pads, boxes: genFurn('flurry').boxes,
    set: [
      { model: 'set-frozen-lake', u: 0.3355, lat: -11.4, yaw: 172 },
      { model: 'set-log-cabin', u: 0.6, lat: -20, yaw: 160 },
      { model: 'set-log-pile', u: 0.3719, lat: -9.2, yaw: -169 }
    ],
    // a frozen stream runs from the village loop under the crossing down to
    // the lake
    land: [
      { kind: 'plain', u: 0.4413, lat: 5, yaw: -142, len: 54, r: 3, w: 5, tint: 0xc8e0f6 }
    ]
  },
  glacier: {
    name: 'Glacier', waypoints: GEN_TRACKS.glacier,
    oils: genFurn('glacier').oils, pads: genFurn('glacier').pads, boxes: genFurn('glacier').boxes,
    set: [
      { model: 'set-snow-fort', u: 0.663, lat: -18, yaw: 180 },
      { model: 'set-igloo', u: 0.12, lat: -14, yaw: 160 },
      { model: 'set-expedition-camp', u: 0.01, lat: 10.5, yaw: 20 },
      { model: 'set-ice-chunks', u: 0.7, lat: 14.5, yaw: 247 },
      { model: 'set-ice-chunks', u: 0.94, lat: -9.2, yaw: 55 },
      { model: 'set-ice-chunks', u: 0.24, lat: -14.5, yaw: 135 },
      { model: 'set-ice-chunks', u: 0.48, lat: 10.5, yaw: 74 },
      { model: 'set-expedition-camp', u: 0.88, lat: -14.5, yaw: 160 },
      { model: 'set-ice-chunks', u: 0.13, lat: 10.5, yaw: 116 },
      { model: 'set-penguin-chute', u: 0.36, lat: 17, yaw: 40 }
    ],
    // the glacier: a tongue of blue ice flows down from the massif in the
    // west, low in the valley between two snow ridges, into the middle of the map,
    // ending among the penguins by the long legs; the fort stands on the
    // terminal moraine the ice left behind at the far end of the lap, which
    // the long legs drive straight at
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
      { model: 'set-windsock', u: 0.124, lat: 10.5, yaw: 20 },
      { model: 'set-warning-sign', u: 0.277, lat: 27.3, yaw: 55 },
      { model: 'set-warning-sign', u: 0.374, lat: 22.5, yaw: 55 },
      { model: 'set-avalanche-fence', u: 0.87, lat: 16, yaw: 20 },
      { model: 'set-avalanche-fence', u: 0.1, lat: -32.5, yaw: 160 }
    ]
  },
  // Backyard Cup — SEEDED multi-crossing circuits (overpasses + solver-placed elevation,
  // decorated mid profile; auto-placed furniture).
  ribbon: {
    name: 'Ribbon', waypoints: GEN_TRACKS.ribbon,
    oils: genFurn('ribbon').oils, pads: genFurn('ribbon').pads, boxes: genFurn('ribbon').boxes,
    // Washing day: four lines strung right across the circuit from the
    // terraces on the west to the terraces on the east, each placed along the
    // line it was measured on (scripts/blender/set_prototypes.py washing_span)
    set: [
      { model: 'set-washing-line', u: 0.01404, lat: -17.023, yaw: 16.88 },
      { model: 'set-laundry-basket', u: 0.92311, lat: 24.442, yaw: 10.44 },
      { model: 'set-washing-line-n', u: 0.23239, lat: -0.15, yaw: -91.93 },
      { model: 'set-washing-line-b', u: 0.46839, lat: -14.842, yaw: -122.87 },
      { model: 'set-washing-line-s', u: 0.54757, lat: 3.799, yaw: -114 }
    ],
    // the garden climbs in two terraces either side of the circuit, the posts
    // on the lower step; a long bank behind the north loop and a rounded hill
    // to the south-east close the ends
    land: [
      { kind: 'ridge', u: 0.92656, lat: 25.874, yaw: 4.23, len: 120, r: 16, h: 3, top: 0.6 },
      { kind: 'ridge', u: 0.92705, lat: 35.91, yaw: 3.39, len: 100, r: 9, h: 3, top: 0.45 },
      { kind: 'ridge', u: 0.37785, lat: 31.449, yaw: 157.23, len: 120, r: 16, h: 3, top: 0.6 },
      { kind: 'ridge', u: 0.37196, lat: 39.797, yaw: 158.48, len: 100, r: 9, h: 3, top: 0.45 },
      { kind: 'ridge', u: 0.2, lat: -46, len: 60, r: 24, h: 6, top: 0.35 },
      { kind: 'ridge', u: 0.66, lat: -46, r: 28, h: 8, top: 0.15 }
    ]
  },
  pretzel: {
    name: 'Pretzel', waypoints: GEN_TRACKS.pretzel,
    oils: genFurn('pretzel').oils, pads: genFurn('pretzel').pads, boxes: genFurn('pretzel').boxes,
    // The treehouse oak on the crest of its hill (SET_GROUND, about three
    // over the nearest deck, the hill running on behind it over the corner of
    // the garden) where the long diagonal points, the tyre swinging; the
    // paddling pool at the hill's foot, the trampoline and the pitch round
    // the lap
    set: [
      { model: 'set-treehouse', u: 0.06511, lat: 31.614, yaw: -21.74, scale: 1.6 },
      { model: 'set-paddling-pool', u: 0.053, lat: 14.5 },
      { model: 'set-trampoline', u: 0.77, lat: -14, yaw: 160 },
      { model: 'set-football-pitch', u: 0.772, lat: -32.5, yaw: 160 }
    ]
  },
  tangle: {
    name: 'Tangle', waypoints: GEN_TRACKS.tangle,
    oils: genFurn('tangle').oils, pads: genFurn('tangle').pads, boxes: genFurn('tangle').boxes,
    // The tangled hose: from the tap on the east lawn under both bridges and
    // round the middle to the one big sprinkler on the west lawn, ahead of the
    // grid. The hose is placed at heading 0 (its builder's PATH is in the
    // world's axes).
    set: [
      { model: 'set-sprinkler', u: 0.09052, lat: 21.121, yaw: 135.17, scale: 1.3 },
      { model: 'set-garden-hose', u: 0.44592, lat: -4.334, yaw: -134.44 }
    ],
    // the lawn humps where the hose runs over it, north of the first bridge
    // and in the middle
    land: [
      { kind: 'ridge', u: 0.12122, lat: 21.88, r: 12, h: 3, top: 0.2 },
      { kind: 'ridge', u: 0.04252, lat: -12.384, r: 9, h: 2.2, top: 0.2 }
    ]
  },
  cloverleaf: {
    name: 'Cloverleaf', waypoints: GEN_TRACKS.cloverleaf,
    oils: genFurn('cloverleaf').oils, pads: genFurn('cloverleaf').pads, boxes: genFurn('cloverleaf').boxes,
    // Playground hill: the playground on the flat top of the hill south-west
    // of the circuit, where the start straight points, swings, seesaw and
    // roundabout going; a picnic, a barbecue and the bird bath round the lap
    set: [
      { model: 'set-playground', u: 0.09518, lat: -26.765, yaw: -173.21, scale: 1.4 },
      { model: 'set-picnic-blanket', u: 0.478, lat: 7.5, yaw: 20 },
      { model: 'set-barbecue', u: 0.075, lat: -7.5, yaw: 160 },
      { model: 'set-bird-bath', u: 0.84, lat: 14.5, yaw: 20 }
    ],
    // the playground's hill, its top levelled at about the height of the
    // decks beside it; the round hill beyond the south bend and a long ridge
    // closing the west
    land: [
      { kind: 'ridge', u: 0.09518, lat: -26.765, yaw: -173.21, len: 12, r: 20, h: 5.5, top: 0.6 },
      { kind: 'ridge', u: 0.2, lat: -48, r: 32, h: 10, top: 0.15 },
      { kind: 'ridge', u: 0.52, lat: -50, len: 70, r: 26, h: 7, top: 0.2 }
    ]
  },
  // Canyon Cup — SEEDED hard circuits (scan-seeds `hard` profile: hairpins, stacked
  // crossings, width pinches, crest hills; auto-placed furniture).
  wash: {
    name: 'Wash', waypoints: GEN_TRACKS.wash,
    oils: genFurn('wash').oils, pads: genFurn('wash').pads, boxes: genFurn('wash').boxes,
    // A dry-wash ranch: the wash winds across the whole map, its gravel bed
    // laid reach by reach (set-wash-bed, each bringing its channel), from the
    // north-west past the hero's stretch by the north straight (tumbleweeds
    // blowing down it), under the north strand's low culvert into the east
    // loop and out under the east bend's high trestle; a side wash comes in
    // from the south under the south strand. Cottonwoods died on its banks;
    // the corral is by the water that is not there.
    set: [
      { model: 'set-dry-creek', u: 0.9221, lat: -18.5, yaw: 112 },
      { model: 'set-dead-cottonwood', u: 0.4916, lat: 12.7 },
      { model: 'set-dead-cottonwood', u: 0.7061, lat: -35.3, yaw: -180 },
      { model: 'set-ranch-fence', u: 0.742, lat: -10.5, yaw: 180 },
      { model: 'set-wash-bed', u: 0.9863, lat: -74.2, yaw: -112 },
      { model: 'set-wash-bed', u: 0.9728, lat: -54.7, yaw: 66 },
      { model: 'set-wash-bed', u: 0.7086, lat: -25.2, yaw: -144 },
      { model: 'set-wash-bed', u: 0.68, lat: -3.6, yaw: 77 },
      { model: 'set-wash-bed', u: 0.5997, lat: 10.7, yaw: 116 },
      { model: 'set-wash-bed', u: 0.5941, lat: -19, yaw: -93 },
      { model: 'set-wash-bed', u: 0.5933, lat: -48.9, yaw: 95 },
      { model: 'set-wash-bed', u: 0.5397, lat: -44.4, yaw: -102 },
      { model: 'set-wash-bed', u: 0.5332, lat: -17.6, yaw: 68 },
      { model: 'set-wash-bed', u: 0.5182, lat: 8.6, yaw: -91 }
    ]
  },
  gulch: {
    name: 'Gulch', waypoints: GEN_TRACKS.gulch,
    oils: genFurn('gulch').oils, pads: genFurn('gulch').pads, boxes: genFurn('gulch').boxes,
    // A gold mine: the adit cut into a spur under the long ridge north of
    // the start straight, one ore line winding out of its yard along the
    // whole start straight and round the east bend to the headframe over the
    // shaft up the east side, its wheel turning, carts of ore riding the line
    // from the adit to the shaft; spoil heaps at both workings and out by the
    // far bends, timber supports round the lap.
    set: [
      { model: 'set-mine-portal', u: 0.018, lat: 26 },
      { model: 'set-ore-line', u: 0.018, lat: 26 },
      { model: 'set-headframe', u: 0.2113, lat: 24.8, yaw: 77 }
    ],
    // the ridge the mine is in, its spoil heaps
    land: [
      { kind: 'ridge', u: 0.0004, lat: 60, len: 80, r: 24, h: 20, top: 0.3 },
      { kind: 'ridge', u: 0.202, lat: 43.4, len: 6, r: 10, h: 6, top: 0.15 },
      { kind: 'ridge', u: 0.9715, lat: 23.9, r: 9, h: 5, top: 0.15 },
      { kind: 'ridge', u: 0.3367, lat: 22.9, len: 14, r: 11, h: 7, top: 0.15 },
      { kind: 'ridge', u: 0.8963, lat: 22.6, len: 14, r: 11, h: 7, top: 0.15 }
    ]
  },
  crag: {
    name: 'Crag', waypoints: GEN_TRACKS.crag,
    oils: genFurn('crag').oils, pads: genFurn('crag').pads, boxes: genFurn('crag').boxes,
    // A dinosaur crag: a sauropod's skeleton weathering out of the crag's
    // flank past the end of the long straight, lying broadside to it so the
    // whole run down the straight looks at it; the dig that found its leg
    // below the east crag. Still, as a fossil is.
    set: [
      { model: 'set-sauropod', u: 0.1012, lat: -15.8, yaw: 163 },
      { model: 'set-dino-dig', u: 0.325, lat: 14 }
    ],
    // the crag itself: the west crag running down from the skeleton's flank
    // along the long straight, the east crag behind the dig, the south crag
    // past the far loop
    land: [
      { kind: 'ridge', u: 0.0601, lat: -46.5, yaw: 147, len: 50, r: 16, h: 13, top: 0.25 },
      { kind: 'ridge', u: 0.3353, lat: 33.6, yaw: -171, len: 60, r: 18, h: 9, top: 0.2 },
      { kind: 'ridge', u: 0.8066, lat: 34.3, yaw: 25, len: 50, r: 14, h: 11, top: 0.2 }
    ]
  },
  sidewinder: {
    name: 'Sidewinder', waypoints: GEN_TRACKS.sidewinder,
    oils: genFurn('sidewinder').oils, pads: genFurn('sidewinder').pads, boxes: genFurn('sidewinder').boxes,
    // A desert highway: the telegraph line along the long straight, the
    // rattlesnake on the verge, route signs, and mesa rims closing the west
    // as near backdrops (the north and east stay open).
    set: [
      { model: 'set-telegraph-line', u: 0.02, lat: 9.2 },
      { model: 'set-rattlesnake', u: 0.24, lat: 10.2 },
      { model: 'set-cow-skull', u: 0.282, lat: -14.3, yaw: 160 },
      { model: 'set-cow-skull', u: 0.72, lat: 14.5, yaw: 20 },
      { model: 'set-route-sign', u: 0.012, lat: -5.5, yaw: 110 },
      { model: 'set-route-sign', u: 0.81, lat: 10, yaw: 70 }
    ],
    // the mesa rims: across the far end of the long straight, and south-west
    // past the south loop, no crest edge more than about 8 degrees over the
    // horizon from any point of the road
    land: [
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
    // Snakes and ladders: the board fills the infield, a ladder running off
    // it toward the spiral climb; the game's box stands where the grid
    // straight points, a ladder leant on it; and below the dive (the lap's
    // snake) the board's snake has come alive, huge, rearing at the racers
    set: [
      { model: 'set-jointed-snake', u: 0.9306, lat: 15.6, yaw: 180, scale: 1.5 },
      { model: 'set-snakes-ladders', u: 0.113, lat: -17 },
      { model: 'set-game-box', u: 0.29, lat: 12 }
    ]
  },
  gauntlet: {
    name: 'Gauntlet', segments: GAUNTLET,
    oils: OILS.gauntlet, pads: PADS.gauntlet, boxes: BOXES.gauntlet,
    // The toy castle siege: the block castle on its cushion fort where the
    // long home straight points, its soldiers drawn up before the gate and
    // the wind-up robot marching its beat beside the straight; the besiegers'
    // ranks stand out across the floor, on the far bends of the lap
    set: [
      { model: 'set-block-castle', u: 0.9568, lat: 25.2, yaw: 24, scale: 1.3 },
      { model: 'set-toy-soldiers', u: 0.9398, lat: 10.5, yaw: 76 },
      { model: 'set-toy-robot', u: 0.8864, lat: 10, yaw: 0 },
      { model: 'set-toy-soldiers', u: 0.65, lat: 12, yaw: 20 },
      { model: 'set-toy-soldiers', u: 0.15, lat: 12, yaw: 20 }
    ]
  },
  helix: {
    name: 'Helix', segments: HELIX, startU: 0.020,
    oils: OILS.helix, pads: PADS.helix, boxes: BOXES.helix,
    // The marble run: the lap in small beside the spiral climb, where the top
    // straight points, marbles climbing one tower's screw, along the high
    // chute and down the other's (the two spirals and the skyway), then home
    // along the floor
    set: [
      { model: 'set-marble-run', u: 0.2769, lat: 25, yaw: -131, scale: 1.3 },
      { model: 'set-slinky', u: 0.633, lat: 14.5 },
      { model: 'set-spinning-top', u: 0.145, lat: 10.5 },
      { model: 'set-marbles', u: 0.08, lat: -10, yaw: 180 }
    ]
  },
  skyline: {
    name: 'Skyline', segments: SKYLINE, startU: 0.024,
    oils: OILS.skyline, pads: PADS.skyline, boxes: BOXES.skyline,
    // Flight from the desk: the skyway flies straight at a desk standing at
    // its own height past the U-turn, a toy plane circling its tether over a
    // paper runway on it, a rocket steaming on its pad, a globe turning; the
    // cardboard box by the grid is the hangar
    set: [
      { model: 'set-flight-desk', u: 0.4846, lat: -26.1, yaw: 138, scale: 1.5 },
      { model: 'set-cardboard-box', u: 0.971, lat: 12, scale: 1.4 }
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
  { id: 'snow',     name: 'Snow Cup',     difficulty: 2, tracks: ['powder', 'flurry', 'glacier', 'avalanche'] }, // medium: gentle-mid crossings + climb (snow biome)
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
// silently disagree with the game. `startU` is one of those; `width` is deliberately
// absent because no descriptor sets it (the shipped width games are per-SEGMENT).
export const TRACK_LIST = TRACK_ORDER.map((id) => ({
  id, name: TRACKS[id].name,
  cup: CUP_OF[id].cup, cupName: CUP_OF[id].cupName, cupDifficulty: CUP_OF[id].cupDifficulty,
  segments: TRACKS[id].segments, waypoints: TRACKS[id].waypoints, startU: TRACKS[id].startU,
  oils: TRACKS[id].oils, pads: TRACKS[id].pads, boxes: TRACKS[id].boxes, poles: TRACKS[id].poles
}));
