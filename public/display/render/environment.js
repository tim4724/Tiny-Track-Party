// Track-independent world dressing: sky dome, drifting clouds, horizon hills,
// the toy lighting rig, the ground plane — plus the biome-gated extras (sea ring
// with its wet-sand edge, dust banks, ambient particles, fliers, kites, the
// hot-air balloon), always built and hidden until a theme asks for them. Built
// once per renderer; returns the pieces the frame loop / per-track fitting need
// to touch — PLUS the handles (sky, hemi, hills, clouds, haze, water, ambient,
// birds, kites, balloon) that applyEnvTheme() re-dresses when the cup's biome
// changes (recolour/re-tint in place; hills also reshape on a dome↔mesa switch).
//
// All look that varies per cup lives in a THEME (see shared/themes.js): sky colours,
// ground texture, hill colours, light tint/intensity. Everything is built from the
// theme passed in (default = grass = the canonical Sunny Circuit look), so the scene
// is byte-identical to the pre-theming renderer when no biome override is attached.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeCloudTexture, makeSnowflakeTexture, makeBirdTexture, makeKiteTexture, makeLawnTexture, makeSandTexture, makeRedRockTexture, makeSnowTexture, makeWoodFloorTexture } from './textures.js';
import { THEMES } from '../../shared/themes.js';

// Lawn ground plane extent. Made FAR larger than any track (tracks span ~100-300u) so the
// plane's rectangular edge always sits thousands of units out — beyond the fog far plane
// AND past the visible horizon — so the ground dissolves into the sky with no straight
// "ground plate" seam from any camera. Exported so the grass-berm UVs (render/track.js)
// stay locked to the same texel scale. It's still ONE quad: a bigger plane just covers the
// same on-screen pixels up to the horizon, so there's no extra vertex/fill cost.
export const GROUND_SIZE = 6000;
const STRIPE_TILE = 600 / 18;  // ~33.3 world-u per mowing-stripe tile (unchanged from the old 600u/18-repeat lawn)
const SKY_R = 420;             // sky-dome radius (stored on the mesh so re-paints can re-normalise)
const HILL_DOMES = 18;         // number of squashed domes in the horizon ring

// Ground textures by theme.ground.kind, built once and cached (a handful of kinds,
// shared across every track/cup switch — never disposed, exactly as the single lawn
// texture was before theming). .repeat is overridden to tile the big ground plane at
// the same world scale the berm UVs (render/track.js) assume.
const _groundTexCache = new Map();
function groundTexture(kind = 'lawn') {
  let tex = _groundTexCache.get(kind);
  if (tex) return tex;
  tex = (kind === 'sand') ? makeSandTexture()
      : (kind === 'redrock') ? makeRedRockTexture()
      : (kind === 'snow') ? makeSnowTexture()
      : (kind === 'wood') ? makeWoodFloorTexture()
      : makeLawnTexture();
  // Tile across the big plane at the same world scale as the old 600u lawn (UVs run 0..1
  // over the plane, so repeat == tiles across it). Berm UVs in track.js use worldXZ /
  // GROUND_SIZE to match this exactly — so EVERY ground kind must share this repeat.
  tex.repeat.set(GROUND_SIZE / STRIPE_TILE, GROUND_SIZE / STRIPE_TILE);
  _groundTexCache.set(kind, tex);
  return tex;
}

// Paint the sky dome's per-vertex gradient from a theme: deeper `zenith` overhead
// easing to `horizon` (the fog colour, so distant geometry dissolves into the sky)
// then to a pale `below`-horizon haze. Re-callable on an existing geometry to recolour
// in place (sets the colour attribute's needsUpdate). The easing is the original
// hand-tuned curve — only the three colours change per biome.
function paintSky(skyGeo, theme) {
  const sp = skyGeo.attributes.position;
  let colAttr = skyGeo.attributes.color;
  if (!colAttr) {
    colAttr = new THREE.BufferAttribute(new Float32Array(sp.count * 3), 3);
    skyGeo.setAttribute('color', colAttr);
  }
  const arr = colAttr.array;
  const top = new THREE.Color(theme.sky.zenith).convertSRGBToLinear();
  const hor = new THREE.Color(theme.sky.horizon).convertSRGBToLinear();
  const low = new THREE.Color(theme.sky.below).convertSRGBToLinear();
  const c = new THREE.Color();
  for (let i = 0; i < sp.count; i++) {
    const t = sp.getY(i) / SKY_R; // -1 (nadir) .. 1 (zenith)
    if (t >= 0) c.copy(hor).lerp(top, Math.pow(t, 0.65));
    else c.copy(hor).lerp(low, Math.min(1, -t * 3));
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  colAttr.needsUpdate = true;
}

// Recolour the merged horizon-hill ring from a theme. The ring is `count` features
// concatenated in order, each `featureVerts` vertices (both stored on the mesh at
// build), so feature i owns the contiguous vertex block [i*per, (i+1)*per). Cycling
// the theme's hill colours over that block recolours in place — no rebuild, no GPU leak.
// Mesas additionally get sediment STRATA: subtle horizontal bands keyed on world
// height, so the lines align across every butte (consistent geology). Domes and
// islands stay solid — the grass ring must remain byte-identical.
function paintHills(hills, theme) {
  const colAttr = hills.geometry.attributes.color;
  const arr = colAttr.array;
  const per = hills.userData.featureVerts;
  const cols = theme.hills;
  const mesa = hills.userData.shape === 'mesa';
  const posArr = hills.geometry.attributes.position.array;
  const hc = new THREE.Color();
  for (let i = 0; i < hills.userData.count; i++) {
    hc.set(cols[i % cols.length]).convertSRGBToLinear();
    for (let k = 0; k < per; k++) {
      const v = (i * per + k) * 3;
      // ±4% alternating bands every 2.6 world units of height — visible as strata
      // through the dust haze without turning the buttes stripy.
      const f = mesa ? ((Math.floor((posArr[v + 1] + 1) / 2.6) % 2) ? 0.96 : 1.04) : 1;
      arr[v] = hc.r * f; arr[v + 1] = hc.g * f; arr[v + 2] = hc.b * f;
    }
  }
  colAttr.needsUpdate = true;
}

// Horizon-ring geometry for a biome's hill silhouette. 'dome' is the original ring of
// squashed toy spheres — every literal is the pre-theming original, so grass stays
// byte-identical. 'mesa' is a ring of flat-topped buttes (truncated cones): the crisp
// plateau edge (the caps keep their own normals) against sloped talus is what reads
// "canyon" in silhouette where a dome reads "meadow". 'island' is the coastal variant:
// FEWER, LOWER, FARTHER domes — an offshore island chain with wide sea gaps, so a
// water ring stays visible between them from a track-level camera (18 fat domes read
// as an enclosing dune wall and hide the sea entirely). Placeholder colour attribute
// on every feature — paintHills overwrites it from the theme.
function buildHillRingGeometry(shape = 'dome') {
  let proto, count;
  if (shape === 'mesa') {
    proto = new THREE.CylinderGeometry(0.58, 1, 1, 9, 1); // plateau ≈ 0.6× the talus foot
    proto.translate(0, 0.5, 0); // base at y=0 → the y scale below IS the plateau height
    count = 14; // mesas are broad — fewer fill the ring without fusing into a wall
  } else if (shape === 'block') {
    // playroom: giant toy building blocks scattered on the floor — near-cubes at
    // casual, unaligned yaws (a crisp box silhouette where a dome reads "hill")
    proto = new THREE.BoxGeometry(1, 1, 1);
    proto.translate(0, 0.5, 0); // base at y=0 → the y scale below IS the block height
    count = 10; // a scatter of big blocks with gaps — a tidy floor, not a wall
  } else if (shape === 'island') {
    proto = new THREE.SphereGeometry(1, 8, 5); // same fog-soft squashed dome as 'dome'
    count = 9; // sparse — the gaps ARE the view (open sea between headlands)
  } else {
    proto = new THREE.SphereGeometry(1, 8, 5); // far, fog-soft, non-uniformly squashed — faceting invisible at this resolution
    count = HILL_DOMES;
  }
  proto.deleteAttribute('uv');
  const featureVerts = proto.attributes.position.count;
  const geoms = [];
  const anchors = []; // per-feature {x, z, top} in AUTHORED coords (setTrack scales XZ) — landmark placement (lighthouse on an island)
  for (let i = 0; i < count; i++) {
    const g = proto.clone();
    let sy, a, r;
    if (shape === 'mesa') {
      g.rotateY((i % 7) * 0.9); // vary the facet phase so the ring doesn't read as stamped
      sy = 8 + (i % 3) * 4.5;
      g.scale(20 + (i % 4) * 8, sy, 16 + ((i + 2) % 4) * 7);
      a = (i / count) * Math.PI * 2 + (i % 5) * 0.17;
      r = 152 + (i % 3) * 20;
    } else if (shape === 'block') {
      // near-cubes (a toy block is a cube, mild wobble so they don't read stamped).
      // Scale BEFORE the yaw — yawing first would shear the box under the
      // non-uniform scale and the crisp block silhouette is the whole point.
      sy = 13 + (i % 3) * 5;
      g.scale(14 + (i % 4) * 5, sy, 14 + ((i + 2) % 4) * 5);
      g.rotateY((i % 7) * 0.85); // casually dropped, not grid-aligned
      a = (i / count) * Math.PI * 2 + (i % 5) * 0.23;
      r = 158 + (i % 3) * 22;
    } else if (shape === 'island') {
      // low + wide (a headland silhouette, not a mound) and pushed out past the
      // shoreline: the waterline cuts their sunk bases → they rise out of the sea
      sy = 3.5 + (i % 3) * 2.2;
      g.scale(28 + (i % 4) * 11, sy, 20 + ((i + 1) % 4) * 8);
      a = (i / count) * Math.PI * 2 + (i % 5) * 0.21;
      r = 172 + (i % 3) * 24;
    } else {
      sy = 7 + (i % 3) * 4;
      g.scale(26 + (i % 4) * 9, sy, 22 + ((i + 1) % 4) * 8);
      a = (i / HILL_DOMES) * Math.PI * 2 + (i % 5) * 0.13;
      r = 150 + (i % 3) * 18;
    }
    g.translate(Math.cos(a) * r, -1.0, Math.sin(a) * r); // base sunk to the ground plane
    anchors.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, top: sy - 1.0 });
    // placeholder per-vertex colour attribute (paintHills overwrites it from the theme)
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(featureVerts * 3), 3));
    geoms.push(g);
  }
  proto.dispose();
  const geometry = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose(); // copied into the merge
  return { geometry, featureVerts, count, anchors };
}

// Sky-puff dressing defaults — the canonical fat white cumulus (all literals are the
// pre-theming constants; a theme without `clouds` gets exactly this). `scale`/`aspect`
// multiply each sprite's authored base width, so wisp biomes can stretch and thin the
// same 8 sprites instead of rebuilding them; `count` just hides the tail.
export const DEF_CLOUDS = { count: 8, opacity: 0.8, scale: 1, aspect: 0.42, tint: 0xffffff };

// ── Sea ring (theme.water) ────────────────────────────────────────────────────
// A flat ring of water surrounding the play field, starting just inside the horizon-
// hill ring (WATER_INNER < the hills' ~150 centre radius) so the hill features rise
// OUT of it as headlands/islands, and running far past the fog so it meets the sky.
// Radial vertex-colour bands sell the read: a thin bright foam line at the shore,
// a shallow turquoise band, then deepening blue. Always built (visible only when the
// theme carries `water`); fitWater() reshapes the shoreline PER TRACK — hugging just
// past the scenery band — so the sea stays visible from the low chase cam (a fixed
// radius would drown in the race fog on a large circuit) yet never floods the road.
// The authored geometry below is a plain circle; every radius is rewritten by
// fitWater, so WATER_INNER is only the baseline the band offsets are measured from.
const WATER_INNER = 135; // authored shoreline radius (fitWater rewrites it per track and per angle)
export const WATER_LIFT = 0.12; // floats just above the ground plane; unnoticeable as a step
                                // from the ~25u any camera keeps from the shore (SHORE_MARGIN),
                                // and enough depth separation to never z-fight the sand below
                                // (exported: setTrack re-bases the sheet when a track moves groundY)
// Band radii paired with a colour parameter and an alpha: colour 0..1 lerps
// foam→shallow, 1..2 shallow→deep. The last ring just extends the deep colour out
// under the fog. A band pair at nearly the same radius = a HARD edge; a wide gap =
// a gradient. Both are used deliberately below.
//
// Two things drive this table:
//
//   Alpha — water thins to nothing where it meets sand, so the SHEET'S OWN EDGE IS
//   FULLY TRANSPARENT: no hard sand/water boundary gives the polygon away, and the
//   surf fades in over ~1u of wet sand. A thin sand-through-water strip follows,
//   then it goes opaque as the water deepens.
//
//   Crispness — from the race camera the whole sea compresses into a ~60px strip, so
//   a band that dissolves over 5+ units becomes a soft wash: the shore read as a
//   pale glow, the one blurry thing in a frame of flat toy colour. The surf is FLAT
//   colour between two tight rings, and it meets the shallows in 0.4u — a crisp line
//   at any distance. Only the shallow→deep gradient is allowed to be gradual: that
//   one is depth falling away, and it reads as sea rather than blur.
const WATER_BANDS = [
  [WATER_INNER,        0,    0   ], // sheet edge — invisible; wet sand shows through untouched
  [WATER_INNER + 1.2,  0,    0.9 ], // surf fades in fast (~1u of wet sand under a thin film)
  [WATER_INNER + 4.0,  0,    0.92], // flat bright crest — same colour + alpha as above = no gradient
  [WATER_INNER + 4.4,  0.8,  0.88], // hard edge: foam gives way to water in 0.4u
  [WATER_INNER + 9,    0.9,  0.86], // the shallowest water — sand still reads through it, but only
                                    // just: warm sand under turquoise turns it green fast, and too
                                    // much of that reads as pond, not sea
  [WATER_INNER + 20,   1,    0.95],
  [WATER_INNER + 60,   1.55, 1   ], // opaque from here out
  [WATER_INNER + 180,  2,    1   ], // fully deep
  [2600,               2,    1   ],
];
// Ring segments. Fine enough that the SURF LINE keeps its crinkle (SHORE_CRINKLE) at
// the ~4u scale a track-level camera sees it at — 96 segments spread over a big island
// put ~13u between vertices and drew the waterline as a ruler edge. ~2.3k verts total
// across the bands: nothing next to the road.
const WATER_SEG = 288;

function buildWaterGeometry() {
  const rings = WATER_BANDS.length, verts = WATER_SEG + 1;
  const pos = new Float32Array(rings * verts * 3);
  const nrm = new Float32Array(rings * verts * 3);
  for (let ri = 0; ri < rings; ri++) {
    const r = WATER_BANDS[ri][0];
    for (let si = 0; si <= WATER_SEG; si++) {
      const a = (si / WATER_SEG) * Math.PI * 2;
      const v = (ri * verts + si) * 3;
      pos[v] = Math.cos(a) * r; pos[v + 1] = 0; pos[v + 2] = Math.sin(a) * r;
      nrm[v + 1] = 1; // flat sheet, straight-up normals (built in XZ — no mesh rotation)
    }
  }
  const idx = [];
  for (let ri = 0; ri < rings - 1; ri++) {
    for (let si = 0; si < WATER_SEG; si++) {
      const a = ri * verts + si, b = a + verts;
      // CCW seen from +Y (tangential × radial = up): a → a+1 (along the ring) → b
      // (outward). The other order back-faces every camera above the sheet.
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rings * verts * 4), 4)); // itemSize 4 → vertex alpha (the shore fade)
  geo.setIndex(idx);
  return geo;
}

// Wet-sand band: a translucent dark overlay ring hugging the INSIDE of the
// shoreline, alpha-fading from nothing (dry sand) to a damp brown right at the
// foam. Built as a CHILD of the water mesh, so it rides the per-track shoreline
// fit for free. RGBA vertex colours; unlit (it's a darkening glaze over the lit,
// textured sand, like a shadow).
// It carries the transition on the SAND side, and the old numbers were too timid to
// see from a track-level camera (a 7u strip at 0.22 over bright sand): the beach ran
// dry-bright straight into the foam. Wider, and damp enough to read — the swash zone
// a real tide leaves behind. It runs OUT past the sheet edge too (which is
// transparent now), so the sand under the surf is wet, not dry sand seen through
// water.
const WET_BANDS = [ // [radius, alpha]
  [WATER_INNER - 13, 0],
  [WATER_INNER - 8.5, 0.10],
  [WATER_INNER - 8.0, 0.24], // tide line — the damp edge the last wave left, a real beach's
                             // most legible line after the surf itself (and the swash factor
                             // waves it in and out along the shore, so it's no drawn circle)
  [WATER_INNER - 2, 0.42],
  [WATER_INNER + 2.5, 0.5], // darkest right where the surf runs up, under the foam line
];

function buildWetGeometry() {
  const rings = WET_BANDS.length, verts = WATER_SEG + 1;
  const pos = new Float32Array(rings * verts * 3);
  const col = new Float32Array(rings * verts * 4);
  for (let ri = 0; ri < rings; ri++) {
    const [r, alpha] = WET_BANDS[ri];
    for (let si = 0; si <= WATER_SEG; si++) {
      const a = (si / WATER_SEG) * Math.PI * 2;
      const v = ri * verts + si;
      pos[v * 3] = Math.cos(a) * r; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = Math.sin(a) * r;
      col[v * 4 + 3] = alpha; // rgb painted by applyWater
    }
  }
  const idx = [];
  for (let ri = 0; ri < rings - 1; ri++) {
    for (let si = 0; si < WATER_SEG; si++) {
      const a = ri * verts + si, b = a + verts;
      idx.push(a, a + 1, b, a + 1, b + 1, b); // CCW from +Y (see buildWaterGeometry)
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4)); // itemSize 4 → vertex alpha
  geo.setIndex(idx);
  return geo;
}

// Re-dress the (always-built) sea ring for a biome: visibility + the three-stop
// radial gradient baked into vertex colours, plus the wet-sand child ring's tint.
// No water in the theme → hidden (children hide with the parent).
function applyWater(water, theme) {
  water.visible = !!theme.water;
  if (!theme.water) return;
  const foam = new THREE.Color(theme.water.foam).convertSRGBToLinear();
  const shallow = new THREE.Color(theme.water.shallow).convertSRGBToLinear();
  const deep = new THREE.Color(theme.water.deep).convertSRGBToLinear();
  const colAttr = water.geometry.attributes.color;
  const arr = colAttr.array;
  const verts = WATER_SEG + 1;
  const c = new THREE.Color();
  for (let ri = 0; ri < WATER_BANDS.length; ri++) {
    const t = WATER_BANDS[ri][1], alpha = WATER_BANDS[ri][2];
    if (t <= 1) c.copy(foam).lerp(shallow, t);
    else c.copy(shallow).lerp(deep, t - 1);
    for (let si = 0; si < verts; si++) {
      const v = (ri * verts + si) * 4;
      arr[v] = c.r; arr[v + 1] = c.g; arr[v + 2] = c.b; arr[v + 3] = alpha;
    }
  }
  colAttr.needsUpdate = true;
  const wet = water.userData.wet;
  if (wet) {
    c.set(theme.water.wet ?? 0x8f7c58).convertSRGBToLinear(); // damp sand, or a sensible default
    const wcol = wet.geometry.attributes.color;
    for (let v = 0; v < wcol.count; v++) { wcol.setX(v, c.r); wcol.setY(v, c.g); wcol.setZ(v, c.b); }
    wcol.needsUpdate = true;
  }
}

// ── Shoreline shape (per track) ──────────────────────────────────────────────
// The island is NOT a disc. Its outline is a per-angle radius summed from three
// terms, each answering a different scale:
//
//   1. The track's own outer bound in that direction — the SUPPORT function of the
//      centreline (max of pos·dir), i.e. the convex hull's reach at that bearing.
//      An oval circuit gets an oval island, a long thin one a long thin island.
//      Convex on purpose: it can never dip inside a bend and flood the road, and it
//      stays smooth where a nearest-point-per-bin scan would come out lumpy.
//   2. SHORE_WOBBLE — the island-scale lobes, outward only (0..SHORE_WOBBLE past
//      the margin), so they can only ever add sand.
//   3. SHORE_CRINKLE — the waterline's own fine in-and-out, mean-zero: it wanders
//      BOTH ways about the lobe outline, and the inward half is the only term that
//      spends clearance.
//
// All three are periodic in θ, so the outline closes at the seam with no crease.
//
// Clearance budget: props sit ~20u beyond the farthest track point. The guaranteed
// sand between hull and water is SHORE_MARGIN less the crinkle's inward reach
// (26 - 2.6 ≈ 23u along a bearing; measured nearest-point clearance across the beach
// cup runs 28-40u), so the props still clear, and the lobe crests add the headlands.
const SHORE_MARGIN = 26;  // minimum sand between the track's hull and the foam
const SHORE_WOBBLE = 22;  // extra reach at a wobble crest (outward only)
const SHORE_CRINKLE = 2.6; // fine in-and-out of the waterline itself (±, eats into the margin)
const SHORE_FADE = 220;   // band offset over which the outline relaxes back to a circle
// [harmonic, weight] — 2 and 3 give the big lobes, 5 and 7 break up the arcs.
const SHORE_HARMONICS = [[2, 1], [3, 0.72], [5, 0.44], [7, 0.26]];
// The lobes above shape the ISLAND; these shape the WATERLINE — the metre-scale
// in-and-out you actually see standing on the beach, which the lobes are far too
// broad to give. Without it the surf line is a drawn arc. Mean-zero (it wanders both
// ways about the lobe outline), and topping out at 29 leaves ~10 segments per crest
// at WATER_SEG 288: still a curve, never a zigzag.
const SHORE_CRINKLE_HARMONICS = [[11, 1], [17, 0.62], [29, 0.34]];
// Surf width along the beach. Real swash runs further up in one stretch than the next;
// a constant-width foam ring is the giveaway that it's a drawn band. Scales the surf
// bands' offsets per bearing, so the foam is thin here and broad there.
const SWASH_HARMONICS = [[3, 1], [7, 0.55], [13, 0.3]];
const SWASH_RANGE = 0.62;  // ±62% on the surf band widths
const SWASH_ZONE = 20;     // band offset by which the swash variation has faded out

// Sum a [harmonic, weight] set at `angle` into [-1, 1].
function harmonicSum(harmonics, phases, angle) {
  let n = 0, wsum = 0;
  for (let i = 0; i < harmonics.length; i++) {
    const [k, w] = harmonics[i];
    n += w * Math.sin(k * angle + phases[i]);
    wsum += w;
  }
  return n / wsum;
}

// Per-angle shoreline for one track: { shore, swash }. `shore` is the radius of the
// water sheet's edge at a bearing — landmarks (render/track.js) anchor to the same
// curve the mesh is built from. `swash` scales the surf band widths at that bearing.
function shorelineFn(samples, trackId) {
  let seed = 2166136261 >>> 0; // FNV-1a over the track id — same track, same island
  for (const ch of String(trackId ?? '')) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const phases = SHORE_HARMONICS.map(() => rand() * Math.PI * 2);
  const crinklePhases = SHORE_CRINKLE_HARMONICS.map(() => rand() * Math.PI * 2);
  const swashPhases = SWASH_HARMONICS.map(() => rand() * Math.PI * 2);
  const shore = (angle) => {
    const cx = Math.cos(angle), cz = Math.sin(angle);
    // Floored at 0 for the bearings a track laid out to ONE SIDE of the origin never
    // reaches (support goes negative there) — that side just gets a plain margin-wide
    // nub of sand. The road is safe either way: every sample p sits at |p| = p·dir(its
    // own bearing) ≤ support(that bearing), so the shore clears it by ≥ SHORE_MARGIN
    // (less SHORE_CRINKLE) along its own ray, whether or not the hull encloses the origin.
    let support = 0;
    for (const s of samples) support = Math.max(support, s.pos.x * cx + s.pos.z * cz);
    const lobes = harmonicSum(SHORE_HARMONICS, phases, angle);
    const crinkle = harmonicSum(SHORE_CRINKLE_HARMONICS, crinklePhases, angle);
    return support + SHORE_MARGIN + SHORE_WOBBLE * (0.5 + 0.5 * lobes) + SHORE_CRINKLE * crinkle;
  };
  const swash = (angle) => 1 + SWASH_RANGE * harmonicSum(SWASH_HARMONICS, swashPhases, angle);
  return { shore, swash };
}

// Reshape the sea ring (and its wet-sand child) around `track`, and re-base it on the
// track's ground height. Rewrites vertex radii rather than scaling the mesh: the shore
// is per-angle now, so a uniform scale can't express it — and world-space band widths
// mean the foam line reads the same on a big circuit as on a small one.
// The outline fades back to a circle as the water deepens (SHORE_FADE): the shape is a
// shoreline read, and out past the fog the far rings only need to reach the sky.
export function fitWater(water, track, groundY) {
  if (!water) return;
  const { shore, swash } = shorelineFn(track.centerline.samples, track.trackId);
  const verts = WATER_SEG + 1;
  // Per-SEGMENT, so every band reuses them: bearing, its sin/cos, the shore radius
  // there and the local surf width.
  const cosA = new Float32Array(verts), sinA = new Float32Array(verts);
  const shoreR = new Float32Array(verts), swashF = new Float32Array(verts);
  let outer = 0;
  for (let si = 0; si < verts; si++) {
    // The seam vertex (si === WATER_SEG) shares the angle of si === 0 — same radius,
    // so the ring closes exactly.
    const a = (si % WATER_SEG) / WATER_SEG * Math.PI * 2;
    cosA[si] = Math.cos(a); sinA[si] = Math.sin(a);
    shoreR[si] = shore(a);
    swashF[si] = swash(a);
    outer = Math.max(outer, shoreR[si]);
  }
  const write = (geo, bands, fade) => {
    const arr = geo.attributes.position.array;
    for (let ri = 0; ri < bands.length; ri++) {
      const off = bands[ri][0] - WATER_INNER; // authored band radius → offset from the shore
      const t = fade ? Math.min(1, Math.abs(off) / SHORE_FADE) : 0; // 0 = follow the outline, 1 = circular
      // Surf bands ride the swash (their width varies along the beach); by SWASH_ZONE
      // the sea is just sea and the bands go back to their authored widths.
      const sw = Math.max(0, 1 - Math.abs(off) / SWASH_ZONE);
      for (let si = 0; si < verts; si++) {
        const r = shoreR[si] * (1 - t) + outer * t + off * (1 + (swashF[si] - 1) * sw);
        const v = (ri * verts + si) * 3;
        arr[v] = cosA[si] * r; arr[v + 2] = sinA[si] * r;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere(); // radii changed by hundreds of units — a stale sphere mis-culls
  };
  write(water.geometry, WATER_BANDS, true);
  if (water.userData.wet) write(water.userData.wet.geometry, WET_BANDS, false); // hugs the shore all the way round
  water.scale.set(1, 1, 1); // radii are absolute now (an older fit may have left a scale)
  water.position.y = groundY + WATER_LIFT;
  water.userData.shore = shore; // landmarks (render/track.js) anchor to the same curve
}

// ── Ambient particles (theme.ambient) ────────────────────────────────────────
// A single THREE.Points cloud drifting over the play field — one draw call for
// hundreds of particles (sprites would be one call each). Built once, hidden
// unless the theme asks; positions are AUTHORED around the origin (setTrack
// scales XZ with the hill push-out) and stepped by stepAmbient (fall + wind +
// bob, wrapping within the kind's height band and edge-to-edge). Kinds preset
// the motion so each biome's air reads differently from the SAME cloud:
//   flake  — lazy toy snow, full-height fall (the original snowfall, verbatim)
//   mote   — near-still golden dust hanging in a sunbeam (playroom)
//   sand   — fast low streaks of wind-blown grit (canyon)
//   pollen — light seeds drifting on a breeze (grass parkland)
const AMB_R = 170; // authored spread — matches the hill ring's reach (the step wraps against it)
const AMB_H = 34;  // full wrap height (kinds take a `band` fraction of it)

// Per-kind motion/appearance presets. `fall` scales the per-particle sink speed
// (1 = the snow fall), `wind` is the eastward drift u/s, `bob` a vertical
// wander velocity, `band` the fraction of AMB_H the particles live in.
export const AMB_KINDS = {
  flake:  { size: 0.3,  opacity: 0.85, fall: 1,    wind: 0.7, bob: 0,    band: 1 },
  mote:   { size: 0.13, opacity: 0.5,  fall: 0.05, wind: 0.4, bob: 0.4,  band: 0.5 },
  sand:   { size: 0.17, opacity: 0.4,  fall: 0,    wind: 9,   bob: 0.5,  band: 0.1 },
  pollen: { size: 0.15, opacity: 0.5,  fall: 0.1,  wind: 1.2, bob: 0.6,  band: 0.35 },
};

function buildAmbient() {
  const MAX = 2400; // roomiest biome's worth (a proper flurry); theme `count` draws a prefix (setDrawRange)
  let seed = 74747;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pos = new Float32Array(MAX * 3);
  const speed = new Float32Array(MAX);
  for (let i = 0; i < MAX; i++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * AMB_R; // sqrt → uniform over the disc
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = rand() * AMB_H;
    pos[i * 3 + 2] = Math.sin(a) * r;
    speed[i] = 1.1 + rand() * 1.4; // world units/s at fall=1 — a lazy toy-snow fall, not a blizzard
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const amb = new THREE.Points(geo, new THREE.PointsMaterial({
    map: makeSnowflakeTexture(), size: 0.3, transparent: true, opacity: 0.85,
    depthWrite: false, sizeAttenuation: true // fog default ON — far particles dissolve into the haze
  }));
  amb.userData.speed = speed;
  amb.frustumCulled = false; // the cloud spans the whole field — the sphere test always passes
  return amb;
}

// Dress the cloud for a biome (or hide it). `patch` lets a track override its
// biome's numbers — theme.ambientByTrack[trackId] (snow scales flurry density
// per track); kind/motion presets merge under both.
export function applyAmbient(amb, theme, patch) {
  const a = theme.ambient;
  amb.visible = !!a;
  if (!a) { amb.userData.cfg = null; return; }
  const cfg = { ...(AMB_KINDS[a.kind] || AMB_KINDS.flake), ...a, ...(patch || {}) };
  cfg.bandH = Math.max(2, AMB_H * cfg.band);
  amb.geometry.setDrawRange(0, Math.min(cfg.count ?? 650, amb.userData.speed.length));
  amb.material.size = cfg.size;
  amb.material.opacity = cfg.opacity;
  amb.material.color.set(cfg.tint ?? 0xffffff);
  amb.userData.cfg = cfg;
}

// Frame step: sink at fall-scaled per-particle speeds, ride the eastward wind,
// wander vertically (bob), wrapping within the kind's height band and the
// authored spread (the mesh scale handles big circuits). For the flake kind
// this is motion-identical to the original snowfall step.
export function stepAmbient(amb, dt, t) {
  const cfg = amb.userData.cfg;
  if (!amb.visible || !cfg) return;
  const attr = amb.geometry.attributes.position;
  const arr = attr.array, spd = amb.userData.speed;
  const n = Math.min(spd.length, amb.geometry.drawRange.count);
  const bandH = cfg.bandH;
  for (let i = 0; i < n; i++) {
    let y = arr[i * 3 + 1] - spd[i] * cfg.fall * dt;
    if (cfg.bob) y += Math.sin(t * 1.3 + spd[i] * 37) * cfg.bob * dt;
    if (y < 0) y += bandH; else if (y >= bandH) y -= bandH;
    arr[i * 3 + 1] = y;
    let x = arr[i * 3] + cfg.wind * dt;
    if (x > AMB_R) x -= AMB_R * 2;
    arr[i * 3] = x;
  }
  attr.needsUpdate = true;
}

// ── Fliers (theme.birds) ─────────────────────────────────────────────────────
// A few airborne silhouettes, each circling its own authored roost — gulls over
// the beach shoreline, vultures high over a canyon mesa, geese crossing the
// winter sky. Sprites like the clouds (they billboard per split-screen cell);
// the frame loop does the circling. Per-flier variety (roost angle, height
// offset, phase, speed factor) is baked at build; the theme dresses count/
// tint/size and sets the shared orbit numbers, which the loop reads from
// `birds.cfg`:
//   tints: optional per-flier colour array (cycled by index; wins over `tint`)
//   dys:   scales the per-flier altitude jitter (low kinds hug their band)
// (The playroom's paper airplane graduated from a glyph sprite to real 3D —
// see buildPaperPlane below; two glyph passes never read as a plane.)
export const DEF_BIRDS = { count: 0, tint: 0xffffff, size: 2.4, y: 18, rc: 120, rb: 22, speed: 0.2, flap: 0.8, flapHz: 1.8, dys: 1 };

function applyBirds(birds, theme) {
  const b = theme.birds ? { ...DEF_BIRDS, ...theme.birds } : null;
  birds.cfg = b; // the frame loop's one-stop config (null = nothing to step)
  birds.forEach((sprite, i) => {
    sprite.visible = !!b && i < b.count;
    if (!b) return;
    sprite.material.color.set(Array.isArray(b.tints) ? b.tints[i % b.tints.length] : b.tint);
    sprite.scale.set(b.size, b.size * 0.5, 1); // glyph texture is 2:1
  });
}

// ── Paper airplane (theme.paperPlane) ────────────────────────────────────────
// The playroom's flier as REAL 3D — a folded dart of three flat triangles
// (two dihedral-V wings + a hanging keel), gliding a lazy circle and BANKING
// into it. A billboard glyph was tried twice and never read as a plane; the
// 3D fold reads from every camera. DoubleSide (paper has two faces),
// fog:false like the other sky pieces.
export const DEF_PLANE = { tint: 0xfaf7ec, size: 3.2, y: 22, a0: 1.3, rc: 95, rb: 32, speed: 0.3, bank: 0.4 };

export function buildPaperPlane() {
  const geo = new THREE.BufferGeometry();
  // unit dart, nose +Z: wingtips swept back and RAISED (the dihedral V), keel below
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0.55,   0, 0.02, -0.5,   -0.42, 0.17, -0.5,  // left wing
    0, 0, 0.55,   0.42, 0.17, -0.5,   0, 0.02, -0.5,   // right wing
    0, 0, 0.55,   0, -0.2, -0.42,   0, 0.02, -0.5,     // keel
  ], 3));
  geo.computeVertexNormals();
  const plane = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, fog: false }));
  plane.visible = false;
  return plane;
}

export function applyPaperPlane(plane, theme) {
  const p = theme.paperPlane ? { ...DEF_PLANE, ...theme.paperPlane } : null;
  plane.userData.cfg = p;
  plane.visible = !!p;
  if (!p) return;
  plane.material.color.set(p.tint);
  plane.scale.setScalar(p.size);
}

const _planeYawQ = new THREE.Quaternion();
const _planeRollQ = new THREE.Quaternion();
const _YAXIS = new THREE.Vector3(0, 1, 0);
const _ZAXIS = new THREE.Vector3(0, 0, 1);

export function stepPaperPlane(plane, dt, t, sf) {
  const cfg = plane.userData.cfg;
  if (!cfg) return;
  const ph = t * cfg.speed;
  const cx = Math.cos(cfg.a0) * cfg.rc * sf, cz = Math.sin(cfg.a0) * cfg.rc * sf; // roost follows the hill push-out
  plane.position.set(
    cx + Math.cos(ph) * cfg.rb,
    cfg.y + Math.sin(ph * 2.1) * 1.1, // long shallow swoops
    cz + Math.sin(ph) * cfg.rb
  );
  // nose along the orbit tangent, rolled into the turn (plus a light wobble)
  const yaw = Math.atan2(-Math.sin(ph), Math.cos(ph));
  _planeYawQ.setFromAxisAngle(_YAXIS, yaw);
  _planeRollQ.setFromAxisAngle(_ZAXIS, cfg.bank + Math.sin(t * 0.7) * 0.12);
  plane.quaternion.copy(_planeYawQ).multiply(_planeRollQ);
}

// ── Kites (theme.kites) ──────────────────────────────────────────────────────
// One or two bright kites bobbing on an implied string over the shore — an
// ANCHORED flier: each wanders around its authored spot instead of orbiting.
// Always 2 sprites built; the theme dresses count/tints/size/height and
// stepKites does the bobbing (plus a gentle sprite-rotation sway).
const DEF_KITES = { count: 0, tints: [0xd94f3d, 0x3f8fd1], size: 2.6, y: 12 };

function applyKites(kites, theme) {
  const k = theme.kites ? { ...DEF_KITES, ...theme.kites } : null;
  kites.cfg = k;
  kites.forEach((sprite, i) => {
    sprite.visible = !!k && i < k.count;
    if (!k) return;
    sprite.material.color.set(k.tints[i % k.tints.length]);
    sprite.scale.set(k.size, k.size, 1); // kite glyph is square (diamond + tail)
  });
}

export function stepKites(kites, dt, t, sf) {
  const cfg = kites.cfg;
  if (!cfg) return;
  for (const sprite of kites) {
    if (!sprite.visible) continue;
    const u = sprite.userData;
    sprite.position.set(
      Math.cos(u.a0) * u.r * sf + Math.sin(t * 0.55 + u.ph) * 2.2,
      cfg.y + Math.sin(t * 0.85 + u.ph * 2) * 1.6 + Math.sin(t * 2.1 + u.ph) * 0.35,
      Math.sin(u.a0) * u.r * sf + Math.cos(t * 0.5 + u.ph) * 2.2
    );
    sprite.material.rotation = Math.sin(t * 0.9 + u.ph) * 0.14; // tugging on the string
  }
}

// ── Hot-air balloon (theme.balloon) ──────────────────────────────────────────
// A mid-field hero: one gored balloon drifting a very slow circle at cloud
// height (grass/sunset). Real 3D: a panelled envelope painted per-face by
// longitude (the play-ball trick), a rigging frustum, and a hanging basket.
// Lambert with fog OFF, like the clouds/fliers — at hill distance the race fog
// greyed the gores into an unreadable blob, and the whole point of a balloon is
// its colour. Kept nearer than the hill ring for the same reason.
// applyBalloon repaints the gores; stepBalloon drifts it.
const DEF_BALLOON = { panels: [0xd94f3d, 0xf5f0e2], y: 42, r: 112, size: 6, bearing: 2.4, speed: 0.012 };

// Exported (with applyBalloon) for the Asset World gallery, which shows one of
// each biome's balloon liveries alongside the kit models.
export function buildBalloon() {
  const group = new THREE.Group();
  // envelope: unit sphere, slightly stretched — per-face gore colours painted by
  // applyBalloon. widthSegments MUST be a multiple of the gore count (8) so the
  // colour seams land on the sphere's own meridian lines — else they saw-tooth
  // (the play-ball lesson, see render/track.js).
  const env = new THREE.SphereGeometry(1, 16, 12).toNonIndexed();
  env.deleteAttribute('uv');
  env.scale(1, 1.08, 1);
  env.setAttribute('color', new THREE.BufferAttribute(new Float32Array(env.attributes.position.count * 3), 3));
  const envelope = new THREE.Mesh(env, new THREE.MeshLambertMaterial({ vertexColors: true, fog: false }));
  group.add(envelope);
  group.userData.envelope = envelope;
  // rigging + basket: static warm-brown parts, vertex-tinted into one mesh
  const tintPart = (g, hex) => {
    const gg = g.index ? g.toNonIndexed() : g;
    if (gg !== g) g.dispose();
    gg.deleteAttribute('uv');
    const c = new THREE.Color(hex).convertSRGBToLinear();
    const n = gg.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    gg.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return gg;
  };
  const rig = new THREE.CylinderGeometry(0.55, 0.2, 0.55, 8, 1, true);
  rig.translate(0, -1.18, 0);
  const basket = new THREE.BoxGeometry(0.42, 0.32, 0.42);
  basket.translate(0, -1.6, 0);
  const parts = mergeGeometries([tintPart(rig, 0x6f5a40), tintPart(basket, 0x8a6f4d)], false);
  group.add(new THREE.Mesh(parts, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false })));
  return group;
}

export function applyBalloon(balloon, theme) {
  const b = theme.balloon ? { ...DEF_BALLOON, ...theme.balloon } : null;
  balloon.visible = !!b;
  balloon.userData.cfg = b;
  if (!b) return;
  balloon.scale.setScalar(b.size);
  // paint the envelope's gores: alternate the panel colours by face-centroid
  // longitude — 8 gores, seams landing on the sphere's own meridian lines
  const GORES = 8;
  const cols = b.panels.map((h) => new THREE.Color(h).convertSRGBToLinear());
  const geo = balloon.userData.envelope.geometry;
  const p = geo.attributes.position, col = geo.attributes.color.array;
  for (let t = 0; t < p.count; t += 3) {
    const cx = (p.getX(t) + p.getX(t + 1) + p.getX(t + 2)) / 3;
    const cz = (p.getZ(t) + p.getZ(t + 1) + p.getZ(t + 2)) / 3;
    const gore = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (2 * Math.PI)) * GORES) % GORES;
    const c = cols[gore % cols.length];
    for (let v = t; v < t + 3; v++) { col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; }
  }
  geo.attributes.color.needsUpdate = true;
}

export function stepBalloon(balloon, dt, t, sf) {
  const cfg = balloon.userData.cfg;
  if (!cfg) return;
  const a = cfg.bearing + t * cfg.speed; // a full lap of the horizon takes ~9 min
  balloon.position.set(
    Math.cos(a) * cfg.r * sf,
    cfg.y + Math.sin(t * 0.11) * 1.4, // thermals — a slow breathe, not a bounce
    Math.sin(a) * cfg.r * sf
  );
}

// ── Dust banks (theme.haze) ──────────────────────────────────────────────────
// The cloud sprites' ground-level sibling: a few very wide, very flat, tinted banks
// drifting at hill height. Distance fog gives uniform haze; these give the haze
// STRUCTURE — dust blowing across the mesas. Hidden for clear-air biomes (count 0).
// Authored positions sit around the hill ring; setTrack scales them outward with the
// same factor as the hills so they never hang over a big circuit.
const DEF_HAZE = { count: 0, opacity: 0.15, tint: 0xffffff, scale: 1 };
const HAZE_ASPECT = 0.14; // banks, not puffs — far flatter than any cloud

function applyHaze(haze, theme) {
  const h = { ...DEF_HAZE, ...(theme.haze || {}) };
  haze.forEach((sprite, i) => {
    sprite.visible = i < h.count;
    sprite.material.opacity = h.opacity;
    sprite.material.color.set(h.tint);
    const w = sprite.userData.w * h.scale;
    sprite.scale.set(w, w * HAZE_ASPECT, 1);
  });
}

// Re-dress the (already built) cloud sprites for a biome. Sprites are never created
// or destroyed on a theme switch — visibility, opacity, tint and scale are the knobs.
function applyClouds(clouds, theme) {
  const c = { ...DEF_CLOUDS, ...(theme.clouds || {}) };
  clouds.forEach((sprite, i) => {
    sprite.visible = i < c.count;
    sprite.material.opacity = c.opacity;
    sprite.material.color.set(c.tint);
    const w = sprite.userData.w * c.scale;
    sprite.scale.set(w, w * c.aspect, 1);
  });
}

export function buildEnvironment(scene, theme = THEMES.grass) {
  // Sky dome: a vertex-coloured backdrop (see paintSky). fog:false (the dome IS the
  // backdrop) and depthWrite:false + renderOrder -1 so it always paints first and
  // everything draws over it.
  let sky;
  {
    const skyGeo = new THREE.SphereGeometry(SKY_R, 16, 10); // fewer segments — no visible faceting on the smooth gradient
    paintSky(skyGeo, theme);
    sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false
    }));
    sky.renderOrder = -1;
    sky.frustumCulled = false; // radius-420 BackSide dome centred on origin: every camera sits inside it, so the cull always passes — skip the per-cell test
    scene.add(sky);
  }

  // Clouds: a handful of soft sprite puffs drifting slowly. Sprites billboard
  // per camera, so they read correctly in every split-screen cell; fog:false
  // because they live past the fog's far end. Drift is stepped in _loop. Always
  // 8 sprites built (the roomiest biome's worth); the theme dresses them —
  // count/opacity/tint/stretch via applyClouds — so a biome swap never rebuilds.
  const clouds = [];
  const haze = [];
  {
    const cloudTex = makeCloudTexture();
    for (let i = 0; i < 8; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: 0.8, fog: false, depthWrite: false
      }));
      const a = (i / 8) * Math.PI * 2 + (i % 3) * 0.45;
      const r = 180 + (i % 4) * 38;
      sprite.position.set(Math.cos(a) * r, 42 + (i % 3) * 16, Math.sin(a) * r);
      sprite.userData.w = 50 + (i % 3) * 20; // authored base width — applyClouds scales from this
      clouds.push(sprite);
      scene.add(sprite);
    }
    applyClouds(clouds, theme);

    // Dust banks: same soft texture, but low (hill height), huge and bank-flat.
    // Always 5 built; the theme dresses them (applyHaze) — most biomes hide all 5.
    // Authored positions are remembered so setTrack can push them out with the hills.
    for (let i = 0; i < 5; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: 0.15, fog: false, depthWrite: false
      }));
      const a = (i / 5) * Math.PI * 2 + (i % 2) * 0.7;
      const r = 132 + (i % 3) * 34;
      const home = { x: Math.cos(a) * r, y: 9 + (i % 3) * 7, z: Math.sin(a) * r };
      sprite.position.set(home.x, home.y, home.z);
      sprite.userData.home = home;             // authored spot — setTrack rescales XZ from this
      sprite.userData.w = 95 + (i % 3) * 28;   // authored base width — applyHaze scales from this
      haze.push(sprite);
      scene.add(sprite);
    }
    applyHaze(haze, theme);
  }

  // Sea ring: built once, shown only by watery biomes (applyWater). Lambert like the
  // ground — the flat sheet takes the biome's light tint, and vertex colours carry
  // the shore-to-deep gradient. Distance fog dissolves it into the sky as usual.
  // The wet-sand band rides along as a child (it fits + breathes with the shoreline).
  // Transparent: the vertex alpha thins the sheet to nothing at the shore (see
  // WATER_BANDS), so the sand reads through the shallows and the sheet has no visible
  // edge. depthWrite stays ON — the sheet is flat and never overlaps itself, and the
  // sailboat/headlands need to depth-test against it.
  let water;
  {
    water = new THREE.Mesh(
      buildWaterGeometry(),
      new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true })
    );
    water.position.y = -1.0 + WATER_LIFT; // follows the ground plane; setTrack re-bases on groundY moves
    const wet = new THREE.Mesh(
      buildWetGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })
    );
    wet.position.y = -0.05; // just below the water sheet, still clear of the sand below
    // Order within the transparent pass, which the two sheets now belong to. Both
    // share a centre, so three's back-to-front sort can't separate them: pin it.
    // NEGATIVE, so the sea draws FIRST — before the gulls, kites and clouds, which
    // are depthWrite:false sprites at the default order. An opaque sea used to be
    // drawn in the opaque pass (i.e. before all of them) for free; a transparent one
    // ordered after them would paint straight over any flier crossing the water.
    wet.renderOrder = -3;   // damp sand, under everything
    water.renderOrder = -2; // sea blended over it, still behind every flier
    water.add(wet);
    water.userData.wet = wet;
    applyWater(water, theme);
    scene.add(water);
  }

  // Ambient particles: one Points cloud, hidden unless the theme carries
  // `ambient`; stepAmbient steps it (from SceneRenderer._loop) and setTrack
  // scales its spread (plus applies any per-track patch).
  const ambient = buildAmbient();
  ambient.position.y = -1.0; // particles' authored y is height above the ground plane
  applyAmbient(ambient, theme);
  scene.add(ambient);

  // Fliers: 4 sprites built (the roomiest biome's worth), dressed by applyBirds
  // (tint/size) and circled by the frame loop. fog:false like the clouds —
  // they live in clear sky.
  const birds = [];
  {
    const birdTex = makeBirdTexture();
    for (let i = 0; i < 4; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: birdTex, transparent: true, fog: false, depthWrite: false
      }));
      sprite.userData = {
        a0: (i / 4) * Math.PI * 2 + (i % 3) * 0.8, // roost bearing on the ring
        dy: (i % 3) * 2.5,                          // per-flier altitude offset (scaled by cfg.dys)
        ph: i * 2.1,                                // orbit phase offset
        sp: 0.82 + (i % 4) * 0.12,                  // per-flier speed factor
      };
      birds.push(sprite);
      scene.add(sprite);
    }
    applyBirds(birds, theme);
  }

  // Kites: 2 sprites, anchored bobbers over the shore (beach). Dressed by
  // applyKites, stepped by stepKites. fog:false — bright toy colours must not
  // grey out over the water.
  const kites = [];
  {
    const kiteTex = makeKiteTexture();
    for (let i = 0; i < 2; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: kiteTex, transparent: true, fog: false, depthWrite: false
      }));
      sprite.userData = {
        a0: 0.9 + i * 2.6,   // authored anchor bearing
        r: 105 + i * 18,     // anchor radius (scaled with the hill push-out)
        ph: i * 1.7,         // bob phase
      };
      kites.push(sprite);
      scene.add(sprite);
    }
    applyKites(kites, theme);
  }

  // Hot-air balloon: one far-field drifter (grass/sunset). Built once, hidden
  // unless the theme asks; applyBalloon paints the gores, stepBalloon drifts it.
  const balloon = buildBalloon();
  applyBalloon(balloon, theme);
  scene.add(balloon);

  // Paper airplane: the playroom's 3D flier, gliding + banking (stepPaperPlane).
  const paperPlane = buildPaperPlane();
  applyPaperPlane(paperPlane, theme);
  scene.add(paperPlane);

  // Horizon hills: one merged ring of far silhouettes deep in the fog tail — depth
  // for the diorama without competing with it. Shape comes from the theme (domes vs
  // mesas — buildHillRingGeometry), colours from paintHills; the per-feature vertex
  // count/total are stashed so a biome swap can recolour (or reshape) in place.
  let hills;
  {
    const ring = buildHillRingGeometry(theme.hillShape);
    hills = new THREE.Mesh(
      ring.geometry,
      new THREE.MeshLambertMaterial({ vertexColors: true }) // matte fog-soft silhouettes — Lambert skips the unused PBR specular/GGX path
    );
    hills.userData.featureVerts = ring.featureVerts;
    hills.userData.count = ring.count;
    hills.userData.shape = theme.hillShape || 'dome';
    hills.userData.anchors = ring.anchors;
    paintHills(hills, theme);
    scene.add(hills);
  }

  // Toy lighting: a soft sky/ground hemisphere for even fill, PLUS a warm key light
  // that also casts the "Sunny Circuit" shadow. The key's specular highlight is the
  // "shiny plastic" dot that sells the injection-moulded-toy read; the hemisphere
  // keeps shadowed sides from going black. Both tints/intensities come from the theme.
  const hemi = new THREE.HemisphereLight(theme.hemi.sky, theme.hemi.ground, theme.hemi.intensity);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(theme.key.color, theme.key.intensity);
  key.position.set(2, 12, 1.5); // near-overhead, slightly raked → gloss highlight + a near-straight-down track shadow (MUST match `dir` in SceneRenderer.setTrack)
  // The shadow map is BAKED ONCE per track and frozen (see SceneRenderer.setTrack/_loop):
  // cars/props no longer cast it (they carry centred ground blobs), so the ONLY caster is
  // the fixed track geometry. 2048² is plenty now — the old 4096² existed only to keep
  // MOVING car-shadow edges from shimmering on coarse texels, and with nothing dynamic in
  // the map there's nothing left to shimmer. Halving the side is a 4× VRAM + per-fragment
  // PCF-sampling win on weak hardware (the per-frame whole-track re-raster is already gone).
  // Under headless automation (E2E, SwiftShader software GL) skip the caster entirely: the
  // one-time bake of the whole track is still a heavy frame at load that can stall the
  // wall-clock race countdown, and no test inspects shadows. See CLAUDE.md / display-perf.
  const automation = (typeof navigator !== 'undefined' && navigator.webdriver);
  key.castShadow = !automation;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.06; // curved road → bias along the normal kills acne; setTrack refits this to the track's shadow texel size
  scene.add(key);
  scene.add(key.target);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
    // Ground texture (mowing stripes / sand grit) carries the colour, so the material
    // tint stays white; swapped per-biome by applyEnvTheme (the plane geometry is reused).
    // Lambert: this huge full-screen matte fill never receives shadows, so it drops the
    // PBR per-fragment cost over the biggest surface in the scene.
    new THREE.MeshLambertMaterial({ map: groundTexture(theme.ground.kind) })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.0;
  // The grass does NOT receive shadows. Cars only ever drive on road tiles (which
  // do receive), so on-track shadows are unaffected — but an ELEVATED car on an
  // overpass would otherwise cast a detached blob onto the grass far below the
  // narrow deck (the light is raked, so the shadow lands off the deck edge). With
  // the grass opted out, that car's shadow stays on the deck under it; only the
  // part that would spill past the deck onto grass is clipped (invisible anyway).
  ground.receiveShadow = false;
  scene.add(ground);

  return { clouds, haze, water, ambient, birds, kites, balloon, paperPlane, key, hemi, ground, hills, sky };
}

// Re-skin the (already built) environment for a new biome: recolour the sky gradient
// and hill ring in place, re-dress the cloud sprites, swap the ground texture, and
// retint both lights. Cheap and allocation-light (textures cached, no sprite churn) so
// the host can switch cups in the lobby with no hitch. The one exception: a hill-SHAPE
// change (dome ↔ mesa) rebuilds the ring geometry — 14–18 low-poly features, still
// hitchless, and only paid when the silhouette actually differs. Fog + background
// colour are the renderer's job (it owns the three fog profiles); this handles only
// the world dressing.
export function applyEnvTheme(env, theme) {
  paintSky(env.sky.geometry, theme);
  const shape = theme.hillShape || 'dome';
  if (env.hills.userData.shape !== shape) {
    env.hills.geometry.dispose();
    const ring = buildHillRingGeometry(shape);
    env.hills.geometry = ring.geometry;
    env.hills.userData.featureVerts = ring.featureVerts;
    env.hills.userData.count = ring.count;
    env.hills.userData.shape = shape;
    env.hills.userData.anchors = ring.anchors;
  }
  paintHills(env.hills, theme);
  applyClouds(env.clouds, theme);
  applyHaze(env.haze, theme);
  applyWater(env.water, theme);
  applyAmbient(env.ambient, theme);
  applyBirds(env.birds, theme);
  applyKites(env.kites, theme);
  applyBalloon(env.balloon, theme);
  applyPaperPlane(env.paperPlane, theme);
  env.ground.material.map = groundTexture(theme.ground.kind);
  env.ground.material.needsUpdate = true;
  env.hemi.color.set(theme.hemi.sky);
  env.hemi.groundColor.set(theme.hemi.ground);
  env.hemi.intensity = theme.hemi.intensity;
  env.key.color.set(theme.key.color);
  env.key.intensity = theme.key.intensity;
}
