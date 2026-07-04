// Track-independent world dressing: sky dome, drifting clouds, horizon hills,
// the toy lighting rig, the ground plane — plus the biome-gated extras (sea ring
// with its wet-sand edge, dust banks, snowfall), always built and hidden until a
// theme asks for them. Built once per renderer; returns the pieces the frame loop /
// per-track fitting need to touch — PLUS the handles (sky, hemi, hills, clouds,
// haze, water, snowfall, birds) that applyEnvTheme() re-dresses when the cup's biome
// changes (recolour/re-tint in place; hills also reshape on a dome↔mesa switch).
//
// All look that varies per cup lives in a THEME (see shared/themes.js): sky colours,
// ground texture, hill colours, light tint/intensity. Everything is built from the
// theme passed in (default = grass = the canonical Sunny Circuit look), so the scene
// is byte-identical to the pre-theming renderer when no biome override is attached.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeCloudTexture, makeSnowflakeTexture, makeBirdTexture, makeLawnTexture, makeSandTexture, makeRedRockTexture, makeSnowTexture } from './textures.js';
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
const DEF_CLOUDS = { count: 8, opacity: 0.8, scale: 1, aspect: 0.42, tint: 0xffffff };

// ── Sea ring (theme.water) ────────────────────────────────────────────────────
// A flat ring of water surrounding the play field, starting just inside the horizon-
// hill ring (WATER_INNER < the hills' ~150 centre radius) so the hill features rise
// OUT of it as headlands/islands, and running far past the fog so it meets the sky.
// Radial vertex-colour bands sell the read: a thin bright foam line at the shore,
// a shallow turquoise band, then deepening blue. Always built (visible only when the
// theme carries `water`); setTrack refits the shoreline PER TRACK — hugging just past
// the scenery band — so the sea stays visible from the low chase cam (a fixed radius
// would drown in the race fog on a large circuit) yet never floods the road.
export const WATER_INNER = 135; // authored shoreline radius (exported: setTrack refits it per track)
export const WATER_LIFT = 0.12; // floats just above the ground plane; unnoticeable as a step
                                // from the ≥30u any camera keeps from the shore, and enough
                                // depth separation to never z-fight the sand below (exported:
                                // setTrack re-bases the sheet when a track moves groundY)
// Band radii paired with a colour parameter: 0..1 lerps foam→shallow, 1..2
// shallow→deep. The last ring just extends the deep colour out under the fog.
const WATER_BANDS = [
  [WATER_INNER,        0], // shoreline — pure foam
  [WATER_INNER + 3,    0], // foam line (thin, bright)
  [WATER_INNER + 8,    1], // foam dissolves into the shallows fast
  [WATER_INNER + 60,   1.55],
  [WATER_INNER + 180,  2], // fully deep
  [2600,               2],
];
const WATER_SEG = 96; // ring segments — the shoreline circle reads smooth at any radius

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
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rings * verts * 3), 3));
  geo.setIndex(idx);
  return geo;
}

// Wet-sand band: a translucent dark overlay ring hugging the INSIDE of the
// shoreline, alpha-fading from nothing (dry sand) to a damp brown right at the
// foam. Built as a CHILD of the water mesh, so it rides the per-track shoreline
// fit for free. RGBA vertex colours; unlit (it's a darkening glaze over the lit,
// textured sand, like a shadow).
const WET_BANDS = [ // [radius, alpha]
  [WATER_INNER - 7, 0],
  [WATER_INNER - 2.5, 0.22],
  [WATER_INNER + 0.6, 0.34], // tucks just under the foam edge
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
    const t = WATER_BANDS[ri][1];
    if (t <= 1) c.copy(foam).lerp(shallow, t);
    else c.copy(shallow).lerp(deep, t - 1);
    for (let si = 0; si < verts; si++) {
      const v = (ri * verts + si) * 3;
      arr[v] = c.r; arr[v + 1] = c.g; arr[v + 2] = c.b;
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

// ── Snowfall (theme.snowfall) ────────────────────────────────────────────────
// A single THREE.Points cloud of soft flakes drifting down over the play field —
// one draw call for hundreds of flakes (sprites would be one call each). Built
// once, hidden unless the theme asks; positions are AUTHORED around the origin
// (setTrack scales XZ with the hill push-out) and stepped in the frame loop
// (fall + the clouds' eastward wind, wrapping top-to-bottom and edge-to-edge).
export const SNOW_R = 170; // authored spread — matches the hill ring's reach (exported: the frame loop wraps against both)
export const SNOW_H = 34;  // wrap height

function buildSnowfall() {
  const MAX = 900; // roomiest biome's worth; theme `count` draws a prefix (setDrawRange)
  let seed = 74747;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pos = new Float32Array(MAX * 3);
  const speed = new Float32Array(MAX);
  for (let i = 0; i < MAX; i++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * SNOW_R; // sqrt → uniform over the disc
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = rand() * SNOW_H;
    pos[i * 3 + 2] = Math.sin(a) * r;
    speed[i] = 1.1 + rand() * 1.4; // world units/s — a lazy toy-snow fall, not a blizzard
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const snow = new THREE.Points(geo, new THREE.PointsMaterial({
    map: makeSnowflakeTexture(), size: 0.3, transparent: true, opacity: 0.85,
    depthWrite: false, sizeAttenuation: true // fog default ON — far flakes dissolve into the haze
  }));
  snow.userData.speed = speed;
  snow.frustumCulled = false; // the cloud spans the whole field — the sphere test always passes
  return snow;
}

function applySnowfall(snow, theme) {
  const s = theme.snowfall;
  snow.visible = !!s;
  if (!s) return;
  snow.geometry.setDrawRange(0, Math.min(s.count ?? 650, snow.userData.speed.length));
  snow.material.size = s.size ?? 0.3;
  snow.material.color.set(s.tint ?? 0xffffff);
}

// ── Birds (theme.birds) ──────────────────────────────────────────────────────
// A few soaring silhouettes, each circling its own authored roost — gulls over the
// beach shoreline, vultures high over a canyon mesa. Sprites like the clouds (they
// billboard per split-screen cell); the frame loop does the circling. Per-bird
// variety (roost angle, height offset, phase, speed factor) is baked at build; the
// theme dresses count/tint/size and sets the shared orbit numbers, which the loop
// reads from `birds.cfg`.
const DEF_BIRDS = { count: 0, tint: 0xffffff, size: 2.4, y: 18, rc: 120, rb: 22, speed: 0.2 };

function applyBirds(birds, theme) {
  const b = theme.birds ? { ...DEF_BIRDS, ...theme.birds } : null;
  birds.cfg = b; // the frame loop's one-stop config (null = nothing to step)
  birds.forEach((sprite, i) => {
    sprite.visible = !!b && i < b.count;
    if (!b) return;
    sprite.material.color.set(b.tint);
    sprite.scale.set(b.size, b.size * 0.5, 1); // glyph texture is 2:1
  });
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
  let water;
  {
    water = new THREE.Mesh(
      buildWaterGeometry(),
      new THREE.MeshLambertMaterial({ vertexColors: true })
    );
    water.position.y = -1.0 + WATER_LIFT; // follows the ground plane; setTrack re-bases on groundY moves
    const wet = new THREE.Mesh(
      buildWetGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })
    );
    wet.position.y = -0.05; // just below the water sheet, still clear of the sand below
    water.add(wet);
    water.userData.wet = wet;
    applyWater(water, theme);
    scene.add(water);
  }

  // Snowfall: one Points cloud, hidden unless the theme carries `snowfall`; the
  // frame loop steps it (SceneRenderer._loop) and setTrack scales its spread.
  const snowfall = buildSnowfall();
  snowfall.position.y = -1.0; // flakes' authored y is height above the ground plane
  applySnowfall(snowfall, theme);
  scene.add(snowfall);

  // Birds: 4 sprites built (the roomiest biome's worth), dressed by applyBirds and
  // circled by the frame loop. fog:false like the clouds — they live in clear sky.
  const birds = [];
  {
    const birdTex = makeBirdTexture();
    for (let i = 0; i < 4; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: birdTex, transparent: true, fog: false, depthWrite: false
      }));
      sprite.userData = {
        a0: (i / 4) * Math.PI * 2 + (i % 3) * 0.8, // roost bearing on the ring
        dy: (i % 3) * 2.5,                          // per-bird soaring altitude offset
        ph: i * 2.1,                                // orbit phase offset
        sp: 0.82 + (i % 4) * 0.12,                  // per-bird speed factor
      };
      birds.push(sprite);
      scene.add(sprite);
    }
    applyBirds(birds, theme);
  }

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
  key.shadow.normalBias = 0.06; // curved road → bias along the normal kills acne (a hair more for the coarser 2048² texel)
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

  return { clouds, haze, water, snowfall, birds, key, hemi, ground, hills, sky };
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
  applySnowfall(env.snowfall, theme);
  applyBirds(env.birds, theme);
  env.ground.material.map = groundTexture(theme.ground.kind);
  env.ground.material.needsUpdate = true;
  env.hemi.color.set(theme.hemi.sky);
  env.hemi.groundColor.set(theme.hemi.ground);
  env.hemi.intensity = theme.hemi.intensity;
  env.key.color.set(theme.key.color);
  env.key.intensity = theme.key.intensity;
}
