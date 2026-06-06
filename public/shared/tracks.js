// Track catalogue — DATA ONLY, no Three.js. This is the single source of truth
// for "what tracks exist": each track is a display name plus an ordered list of
// TrackBuilder PIECES keys (the geometry).
//
// Kept dependency-free so the SAME module loads everywhere:
//   • the display engine (TrackBuilder turns `pieces` into drivable geometry),
//   • the Node unit tests (imported directly, no bundler),
//   • the classic-script gallery (gallery-tracks.js imports it as a plain module
//     to list tracks — it can't import TrackBuilder, which pulls in Three.js).
//
// DESIGN GOAL. Each lap should run ~40-55s for a quick driver (≈2-3 min over the
// 3-lap race), and the tracks should feel DISTINCT — varied in outline, corner
// radius, elevation, and feature density, not the same rectangle dressed
// differently. Use scripts/probe-track.js to check a layout closes and
// scripts/probe-laptime.js to check it runs the right length before shipping it.
//
// ── HOW A TRACK CLOSES ───────────────────────────────────────────────────────
// The builder chains pieces by their connector frames and auto-closes the loop
// (gap < 0.5). Every piece advances ONE span (a straight-length L) along travel;
// a 90° corner also turns the heading. There are three proven closing recipes:
//
//  1. OVAL SKELETON (a simple rectangle, e.g. Switchback). Four identical 90°
//     corners of the SAME hand (4 × 90° = a full turn) with matched OPPOSITE
//     sides. Because the four corners are identical, the lap closes as long as
//     opposite sides have equal length — so any side can be any NET-FLAT,
//     NET-STRAIGHT run of the right length. Aspect ratio (long-thin vs square)
//     and radius (large=sweeping, small=tight) are free, which is most of what
//     makes these tracks differ.
//
//  2. FIGURE-8 (a self-crossing loop, e.g. Crossover). Three right + three left
//     corners net 0° rotation and cross ONCE; swap two straights of one strand
//     for hillUp/hillDown to lift that strand into a bridge OVER the crossing
//     (a hill has the same XZ footprint as a straight, so closure is unchanged).
//
//  3. L-SHAPE (a concave hexagon, e.g. Riverside). Five left + one right corner
//     net a full turn but trace a re-entrant "boot" outline. Side lengths are
//     tuned so the run closes; found/verified with scripts/probe-track.js.
//
// NET-NEUTRAL building blocks (each spans one straight-length L, so any of them
// can stand in for a "straight" on a side without changing where it ends):
//   • straight                         — plain
//   • curve + curveR                   — a chicane (left then back); net 0 lateral
//   • bumpUp + bumpDown                — a hump then a dip; net flat
//   • hillHalfUp + hillHalfDown        — climb then descend; net flat
//   • hillUp + hillDown                — a taller climb/descent; net flat

// ---- Switchback (Hard): the tight, technical one. TIGHT (small-radius) corners
// make a compact circuit, with a chicane + rolling half-hill on the long sides
// and a quick chicane on the short sides — tight cornering AND elevation on the
// same lap. Sides 7/3/7/3 with four small left corners → closes. ----
export const SWITCHBACK = [
  // start/finish straight → chicane → half-hill                         [A: 7]
  'straight', 'curve', 'curveR', 'hillHalfUp', 'hillHalfDown', 'straight', 'straight', 'cornerL',
  // short side: tight chicane                                           [B: 3]
  'curve', 'curveR', 'straight', 'cornerL',
  // back side: chicane → half-hill                                      [C: 7, = A]
  'straight', 'curve', 'curveR', 'hillHalfUp', 'hillHalfDown', 'straight', 'straight', 'cornerL',
  // short side: tight chicane                                           [D: 3, = B]
  'curve', 'curveR', 'straight', 'cornerL'
];

// ---- Crossover (Hard): a figure-8 that passes OVER ITSELF. The lap runs up a
// long spine, loops the top (clockwise), runs down the far side, then a
// west-bound straight CLIMBS onto a bridge and crosses 90° OVER the spine before
// descending and looping the bottom (counter-clockwise) back to start. The two
// strands meet at one point in plan view but ~2 world units apart in height, so
// one bridges cleanly over the other.
//
// HOW IT STAYS VALID. The plan is a closed single-crossing figure-8 (3 right + 3
// left corners → net 0° rotation; symmetric layout found by scripts/probe-cross.js
// and the figure-8 search). The overpass is added by swapping two straights of
// the bridge strand for hillUp/hillDown — a hill has the SAME XZ footprint as a
// straight, so the crossing point and the closure are unchanged; it just lifts
// the deck over the crossing. Net climb is zero (one up, one down), so the lap
// returns to ground. The renderer's nearest-to-centreline ground probe keeps
// cars on the correct deck at the crossing (upper on the bridge, lower
// underneath). ----
export const CROSSOVER = [
  // spine: straight up from the start/finish (gate here)         [N]
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight',
  // top loop, clockwise                                          [E → S]
  'cornerLargeR', 'straight', 'cornerLargeR',
  // down the far side                                            [S]
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight', 'straight',
  // turn west, then BRIDGE: climb up, cross over, come back down [W, elevated]
  'cornerLargeR', 'hillUp', 'straight', 'straight', 'straight', 'straight', 'hillDown',
  // bottom loop, counter-clockwise, back to the spine            [S → N]
  'cornerLargeL', 'straight', 'straight', 'straight', 'cornerLargeL', 'straight', 'straight', 'straight', 'cornerLargeL',
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight'
];

// ---- Riverside (Medium): the long grand tour. An L-SHAPED circuit (a concave
// "boot" — five left corners and one right, so the lap bends back on itself
// instead of tracing a plain rectangle) packed with every flat-and-rolling
// feature: chicanes, full + half hills, speed bumps. The longest lap in the set.
// Sides A9/B3/C3/D4/E4/F9 with turns L,L,R,L,L,L (the single right corner is the
// re-entrant elbow); side lengths tuned so it auto-closes (probe-track.js). ----
export const RIVERSIDE = [
  // start/finish straight → chicane → full hill → run to the first bend [A: 9]
  'straight', 'curve', 'curveR', 'hillUp', 'hillDown', 'straight', 'straight', 'straight', 'straight', 'cornerLargeL',
  // short leg: half-hill                                                 [B: 3]
  'straight', 'hillHalfUp', 'hillHalfDown', 'cornerLargeL',
  // the elbow ledge: speed bumps into the re-entrant RIGHT corner        [C: 3]
  'straight', 'bumpUp', 'bumpDown', 'cornerLargeR',
  // inner leg: half-hill → straights                                     [D: 4]
  'hillHalfUp', 'hillHalfDown', 'straight', 'straight', 'cornerLargeL',
  // chicane → full hill                                                  [E: 4]
  'curve', 'curveR', 'hillUp', 'hillDown', 'cornerLargeL',
  // long home leg: chicane → half-hill → bumps → run to the line         [F: 9]
  'straight', 'straight', 'curve', 'curveR', 'hillHalfUp', 'hillHalfDown', 'bumpUp', 'bumpDown', 'straight', 'cornerLargeL'
];

// Registry of named, previewable tracks: `name` is the display label and
// `pieces` is the layout the builder chains. Selected in the display via
// ?track=<key> (see display/main.js).
export const TRACKS = {
  switchback: {
    name: 'Switchback',
    pieces: SWITCHBACK
  },
  crossover: {
    name: 'Crossover',
    pieces: CROSSOVER
  },
  riverside: {
    name: 'Riverside',
    pieces: RIVERSIDE
  }
};

// Stable display order for the gallery / picker (object key order is reliable in
// practice, but an explicit list keeps presentation independent of TRACKS edits).
export const TRACK_ORDER = ['switchback', 'crossover', 'riverside'];

// Flat list of tracks — {id, name, pieces} in display order — used by main.js and
// the track-picker UI. The display builds each track and computes its schematic SVG
// from the geometry (see display/trackSchematic.js), so the picker needs no per-track art.
export const TRACK_LIST = TRACK_ORDER.map((id) => ({ id, name: TRACKS[id].name, pieces: TRACKS[id].pieces }));
