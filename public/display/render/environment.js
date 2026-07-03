// Track-independent world dressing: sky dome, drifting clouds, horizon hills,
// the toy lighting rig and the ground plane. Built once per renderer; returns the
// pieces the frame loop / per-track fitting need to touch — PLUS the handles
// (sky, hemi, hills) that applyEnvTheme() recolours when the cup's biome changes.
//
// All look that varies per cup lives in a THEME (see shared/themes.js): sky colours,
// ground texture, hill colours, light tint/intensity. Everything is built from the
// theme passed in (default = grass = the canonical Sunny Circuit look), so the scene
// is byte-identical to the pre-theming renderer when no biome override is attached.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeCloudTexture, makeLawnTexture, makeSandTexture, makeRedRockTexture } from './textures.js';
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

// Recolour the merged horizon-hill ring from a theme. The ring is HILL_DOMES domes
// concatenated in order, each `domeVerts` vertices (stored on the mesh at build), so
// dome i owns the contiguous vertex block [i*domeVerts, (i+1)*domeVerts). Cycling the
// theme's hill colours over that block recolours in place — no rebuild, no GPU leak.
function paintHills(hills, theme) {
  const colAttr = hills.geometry.attributes.color;
  const arr = colAttr.array;
  const per = hills.userData.domeVerts;
  const cols = theme.hills;
  const hc = new THREE.Color();
  for (let i = 0; i < HILL_DOMES; i++) {
    hc.set(cols[i % cols.length]).convertSRGBToLinear();
    for (let k = 0; k < per; k++) {
      const v = (i * per + k) * 3;
      arr[v] = hc.r; arr[v + 1] = hc.g; arr[v + 2] = hc.b;
    }
  }
  colAttr.needsUpdate = true;
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
  // because they live past the fog's far end. Drift is stepped in _loop.
  const clouds = [];
  {
    const cloudTex = makeCloudTexture();
    for (let i = 0; i < 8; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: 0.8, fog: false, depthWrite: false
      }));
      const a = (i / 8) * Math.PI * 2 + (i % 3) * 0.45;
      const r = 180 + (i % 4) * 38;
      sprite.position.set(Math.cos(a) * r, 42 + (i % 3) * 16, Math.sin(a) * r);
      const w = 50 + (i % 3) * 20;
      sprite.scale.set(w, w * 0.42, 1);
      clouds.push(sprite);
      scene.add(sprite);
    }
  }

  // Horizon hills: one merged ring of squashed toy domes, far outside any track and
  // deep in the fog tail, so they render as soft pale silhouettes — depth for the
  // diorama without competing with it. Colours come from the theme (paintHills); the
  // per-dome vertex count is stashed so a biome swap can recolour in place.
  let hills;
  {
    const hillProto = new THREE.SphereGeometry(1, 8, 5); // far, fog-soft, non-uniformly squashed — faceting invisible at this resolution
    hillProto.deleteAttribute('uv');
    const domeVerts = hillProto.attributes.position.count;
    const geoms = [];
    for (let i = 0; i < HILL_DOMES; i++) {
      const g = hillProto.clone();
      g.scale(26 + (i % 4) * 9, 7 + (i % 3) * 4, 22 + ((i + 1) % 4) * 8);
      const a = (i / HILL_DOMES) * Math.PI * 2 + (i % 5) * 0.13;
      const r = 150 + (i % 3) * 18;
      g.translate(Math.cos(a) * r, -1.0, Math.sin(a) * r); // base sunk to the grass plane
      // placeholder per-vertex colour attribute (paintHills overwrites it from the theme)
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(domeVerts * 3), 3));
      geoms.push(g);
    }
    hillProto.dispose();
    hills = new THREE.Mesh(
      mergeGeometries(geoms, false),
      new THREE.MeshLambertMaterial({ vertexColors: true }) // matte fog-soft domes — Lambert skips the unused PBR specular/GGX path
    );
    for (const g of geoms) g.dispose(); // copied into the merge
    hills.userData.domeVerts = domeVerts;
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

  return { clouds, key, hemi, ground, hills, sky };
}

// Re-skin the (already built) environment for a new biome: recolour the sky gradient
// and hill ring in place, swap the ground texture, and retint both lights. Cheap and
// allocation-light (no mesh rebuilds, textures are cached) so the host can switch cups
// in the lobby with no hitch. Fog + scene.background colour are the renderer's job
// (it owns the three fog profiles); this handles only the world dressing.
export function applyEnvTheme(env, theme) {
  paintSky(env.sky.geometry, theme);
  paintHills(env.hills, theme);
  env.ground.material.map = groundTexture(theme.ground.kind);
  env.ground.material.needsUpdate = true;
  env.hemi.color.set(theme.hemi.sky);
  env.hemi.groundColor.set(theme.hemi.ground);
  env.hemi.intensity = theme.hemi.intensity;
  env.key.color.set(theme.key.color);
  env.key.intensity = theme.key.intensity;
}
