// Asset World — a free-camera scene that loads every GLB in the toy-car kit and
// lays them out at TRUE SCALE, grouped by family, each with its file name
// floating above. The point is a shared vocabulary: orbit around, read the
// names, and we can all refer to "track-road-wide-corner-small" and mean the
// same model. No relay, no game logic — just the kit on display.
//
// Alongside the files, every PROCEDURAL asset is shown too — the biome
// landmarks (gnome, windmill, cabin…), the ground-clutter kinds, the hot-air
// balloons and the sky glyphs — composed with the SAME builders the game uses
// (render/track.js buildLandmarks / CLUTTER_BUILDERS, render/environment.js),
// so what stands here is exactly what stands trackside. Animated set-pieces
// (windmill rotor, wind-up train, chimney smoke) run live.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildMonsterRig, buildMonsterChassis, MONSTER_BASE_ASSET } from '/display/render/MonsterRig.js';
import { gantryGroup } from '/display/render/FinishGate.js';
import { buildLandmarks, CLUTTER_BUILDERS } from '/display/render/track.js';
import { buildBalloon, applyBalloon } from '/display/render/environment.js';
import { makeBirdTexture, makeButterflyTexture, makePlaneTexture, makeKiteTexture } from '/display/render/textures.js';
import { THEMES } from '/shared/themes.js';

const ASSET = (name) => `/assets/toycar/${name}.glb`;

// Synthetic "monster variant" rigs — a playable car's body remounted on big
// monster wheels (see MonsterRig.js). Not files on disk: composed client-side
// and injected into the layout so the look can be eyeballed next to the kit.
// Mapping mirrors CAR_MODELS/CAR_NAMES in shared/protocol.js (the playable four).
const MONSTER_VARIANTS = [
  { key: 'monster-dash',   model: 'vehicle-racer-low' },
  { key: 'monster-bolt',   model: 'vehicle-speedster' },
  { key: 'monster-carve',  model: 'vehicle-racer' },
  { key: 'monster-rumble', model: 'vehicle-vintage-racer' },
];

// Category rules, in display order. The first matching `test` wins, so more
// specific prefixes are listed before the broader ones. `track-road-wide` (the
// family this project actually drives on) leads, in a warm highlight colour.
const CATEGORIES = [
  { key: 'road-wide',      label: 'Track · Road · WIDE',     color: '#e8913a', test: (n) => n.startsWith('track-road-wide') },
  { key: 'road-narrow',    label: 'Track · Road · narrow',   color: '#c98b53', test: (n) => n.startsWith('track-road-narrow') },
  { key: 'striped-wide',   label: 'Track · Striped · wide',  color: '#d9566c', test: (n) => n.startsWith('track-striped-wide') },
  { key: 'striped-narrow', label: 'Track · Striped · narrow', color: '#c98aa0', test: (n) => n.startsWith('track-striped-narrow') },
  { key: 'orange-wide',    label: 'Track · Orange · wide',   color: '#e0a92e', test: (n) => n.startsWith('track-wide') },
  { key: 'orange-narrow',  label: 'Track · Orange · narrow', color: '#c9b15a', test: (n) => n.startsWith('track-narrow') },
  { key: 'markers',        label: 'Gates & Markers',         color: '#d24b8f', test: (n) => n === 'gate' || n === 'gate-finish' || n.startsWith('finish-gate') },
  { key: 'supports',       label: 'Supports',                color: '#8a6f54', test: (n) => n.startsWith('supports') },
  { key: 'vehicles',       label: 'Vehicles',                color: '#3f8ddd', test: (n) => n.startsWith('vehicle') },
  { key: 'monster',        label: 'Monster Variants',        color: '#7b4fc0', test: (n) => n.startsWith('monster-') },
  { key: 'wheels',         label: 'Wheels',                  color: '#5b6b76', test: (n) => n.startsWith('wheel') },
  { key: 'items',          label: 'Items & Pickups',         color: '#4bb05a', test: (n) => n.startsWith('item') },
  { key: 'scenery',        label: 'Scenery (kit models)',    color: '#3f9b6b', test: (n) => n.startsWith('tree') || n.startsWith('palm') || n.startsWith('cactus') },
  { key: 'landmarks',      label: 'Landmarks (procedural)',  color: '#c2564b', test: (n) => n.startsWith('landmark-') },
  { key: 'clutter',        label: 'Ground clutter (procedural)', color: '#7c9a3f', test: (n) => n.startsWith('clutter-') },
  { key: 'sky',            label: 'Sky & Glyphs (procedural)', color: '#4a8fd0', test: (n) => n.startsWith('sky-') },
  { key: 'effects',        label: 'Effects',                 color: '#94a3ad', test: (n) => n === 'smoke' },
  { key: 'other',          label: 'Other',                   color: '#888888', test: () => true }
];
function categoryOf(name) { return CATEGORIES.find((c) => c.test(name)); }

// ---- procedural showcases ----
// Each biome landmark is built by the REAL buildLandmarks against a stub
// renderer + a straight 200u "runway" track, then re-parented into a wrapper
// group and re-centred by the layout like any other model. Animated pieces
// (windmill rotor, wind-up train, chimney smoke) register their steppers with
// the stub; we adopt them into the viewer's frame loop, so they run live here.
// Which biome a kind belongs to decides its palette (hoodoos in canyon rocks…).
const LANDMARK_HOME = {
  lighthouse: 'beach', sailboat: 'beach', umbrella: 'beach', sandcastle: 'beach',
  hoodoo: 'canyon', windmill: 'canyon',
  snowman: 'snow', cabin: 'snow',
  gnome: 'grass', doghouse: 'grass', picnic: 'grass',
  blocks: 'playroom', duck: 'playroom', ball: 'playroom',
  crayons: 'playroom', books: 'playroom', train: 'playroom',
};

const showcaseAnims = []; // adopted steppers, run in the render loop

function stubTrack(kind) {
  const samples = [];
  for (let s = 0; s <= 200; s += 3) samples.push({ pos: { x: s, y: 0, z: 0 } });
  return {
    id: 'showcase-' + kind, // deterministic per-kind rand stream
    roadWidth: 5,
    centerline: {
      samples,
      length: 200,
      sampleAt: (s) => ({ pos: { x: s, y: 0, z: 0 }, lateral: { x: 0, z: 1 }, tangent: { x: 1, z: 0 } }),
    },
  };
}

// The minimal SceneRenderer surface buildLandmarks touches. The hill anchor +
// water fit stand in for the horizon ring so the offshore pair (lighthouse,
// sailboat) has somewhere to land — the layout re-centres them anyway.
function stubRenderer() {
  return {
    ground: { position: { y: 0 } },
    trackGroup: new THREE.Group(),
    _mergedGeoms: [], _mergedMats: [], _trackAnims: [],
    _hills: { userData: { anchors: [{ x: 30, z: -20, top: 2.5 }] }, scale: { x: 1 } },
    _water: { userData: { fit: 0.2 } },
  };
}

function buildLandmarkShowcase(kind) {
  const R = stubRenderer();
  buildLandmarks(R, stubTrack(kind), { ...THEMES[LANDMARK_HOME[kind]], landmark: kind });
  if (!R.trackGroup.children.length) return null;
  const wrap = new THREE.Group();
  // Re-parent instead of re-positioning: the anim closures keep writing the
  // stub-track coordinates, which are now LOCAL to the wrapper — so moving the
  // wrapper moves the whole act (train + rails + smoke) as one.
  for (const c of [...R.trackGroup.children]) wrap.add(c);
  for (const fn of R._trackAnims) {
    fn(0, 0); // settle animated pieces into their t=0 pose BEFORE the layout measures the box (the train starts at the wrapper origin otherwise)
    showcaseAnims.push(fn);
  }
  return wrap;
}

// One little diorama per clutter kind: a couple of instances via the shared
// CLUTTER_BUILDERS, with the tint family the biome palettes actually use.
const CLUTTER_TINTS = {};
for (const t of Object.values(THEMES)) {
  for (const e of ((t.scenery.clutter && t.scenery.clutter.kinds) || [])) {
    if (!CLUTTER_TINTS[e.kind]) CLUTTER_TINTS[e.kind] = e.tints;
  }
}

function buildClutterShowcase(kind, tints) {
  let seed = 48271;
  for (let i = 0; i < kind.length; i++) seed = ((seed ^ kind.charCodeAt(i)) * 16777619) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const geoms = [];
  const ctx = {
    rand,
    groundY: 0,
    pick: (t) => t[Math.floor(rand() * t.length)],
    put: (g, hex, shade = 1) => { // the buildScenery tint idiom: non-indexed, uv-free, vertex-coloured
      const gg = g.index ? g.toNonIndexed() : g;
      if (gg !== g) g.dispose();
      gg.deleteAttribute('uv');
      const c = new THREE.Color(hex).convertSRGBToLinear().multiplyScalar(shade);
      const n = gg.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      gg.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      geoms.push(gg);
    },
  };
  const build = CLUTTER_BUILDERS[kind];
  if (!build) return null;
  build(ctx, 0, 0, tints);
  build(ctx, 1.7, 1.0, tints); // a second instance so patch-kinds read as they scatter
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  return new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
}

// Flier/kite glyphs as billboards, tinted the way their biomes fly them.
function buildGlyphShowcase(tex, tint, aspect) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.material.color.set(tint);
  sprite.scale.set(3, 3 * aspect, 1); // the layout rests its bounding box on the ground
  return sprite;
}

const COLS_MAX = 7;        // widest grid row before wrapping
const CELL_GAP = 2.2;      // padding added to a category's largest footprint
const CATEGORY_GAP = 5.0;  // empty band between category blocks (along +Z)

// ---- scene ----
const container = document.getElementById('world');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8ecae6);
// Gentle distance haze only — kept far out so an inspector can still read the
// back rows (the game uses much tighter fog, but here we want to see everything).
scene.fog = new THREE.Fog(0x8ecae6, 260, 900);

// Flat toy lighting (matches the game): soft sky/ground hemisphere, plus a gentle
// directional for a little form so models don't read as silhouettes.
scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa68f, 2.6));
const sun = new THREE.DirectionalLight(0xffffff, 0.7);
sun.position.set(40, 80, 30);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(2000, 2000),
  new THREE.MeshStandardMaterial({ color: 0x6aa84f })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02; // a hair below 0 so models resting on 0 don't z-fight
scene.add(ground);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 2000);

// ---- first-person look ----
// Drag rotates the camera IN PLACE — around its own position, like an FPS — not
// an orbit around a distant pivot. Orientation is held as yaw (about world up) +
// pitch (about the local right axis) and the quaternion is rebuilt from a YXZ
// euler each move, so there's never any roll. WASD (below) then flies along
// wherever you're looking.
const look = { yaw: 0, pitch: 0 };
const PITCH_LIMIT = Math.PI / 2 - 0.02; // a hair shy of straight up/down (no flip)
const LOOK_SENS = 0.0026;               // radians per pixel dragged
function applyLook() {
  look.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, look.pitch));
  camera.quaternion.setFromEuler(new THREE.Euler(look.pitch, look.yaw, 0, 'YXZ'));
}
// Aim at a world point, then adopt that heading as the yaw/pitch state.
function lookAtPoint(target) {
  camera.lookAt(target);
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  look.yaw = e.y; look.pitch = e.x;
  applyLook();
}

const canvas = renderer.domElement;
canvas.style.touchAction = 'none';
canvas.style.cursor = 'grab';
let dragging = false, dragPtr = null, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true; dragPtr = e.pointerId; lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || e.pointerId !== dragPtr) return;
  look.yaw   -= (e.clientX - lastX) * LOOK_SENS;
  look.pitch -= (e.clientY - lastY) * LOOK_SENS;
  lastX = e.clientX; lastY = e.clientY;
  applyLook();
});
function endDrag(e) {
  if (e.pointerId !== dragPtr) return;
  dragging = false; dragPtr = null; canvas.style.cursor = 'grab';
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// Scroll dollies along the view direction (toward whatever you're looking at).
// Normalise deltaMode so line/page-mode wheels (Firefox) move like pixel ones.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? innerHeight : 1);
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
  camera.position.addScaledVector(fwd, -e.deltaY * unit * 0.05); // wheel up = forward
}, { passive: false });

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- WASD fly movement ----
// The mouse aims (first-person look, above); the keyboard TRANSLATES the camera
// so you fly across the spread-out layout. Forward follows the look heading
// flattened to horizontal, so W/S stay level even while looking up or down.
// A/D strafe, E/Q (or Space/Shift-Space) up/down, Shift = sprint.
const keys = new Set();
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space']);
addEventListener('keydown', (e) => {
  if (MOVE_KEYS.has(e.code)) { keys.add(e.code); e.preventDefault(); }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.add('Shift');
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.delete('Shift');
});
addEventListener('blur', () => keys.clear()); // don't get stuck moving if focus leaves

const FLY_SPEED = 26; // units/sec (layout spans ~150 units)
let _lastT = performance.now();
function flyStep() {
  const now = performance.now();
  const dt = Math.min((now - _lastT) / 1000, 0.05);
  _lastT = now;
  if (!keys.size) return;
  const speed = FLY_SPEED * (keys.has('Shift') ? 3 : 1) * dt;
  // horizontal forward (view dir flattened) + horizontal right + world up
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const move = new THREE.Vector3();
  if (keys.has('KeyW')) move.add(fwd);
  if (keys.has('KeyS')) move.sub(fwd);
  if (keys.has('KeyD')) move.add(right);
  if (keys.has('KeyA')) move.sub(right);
  if (keys.has('KeyE') || keys.has('Space')) move.y += 1;
  if (keys.has('KeyQ')) move.y -= 1;
  if (move.lengthSq() === 0) return;
  move.normalize().multiplyScalar(speed);
  camera.position.add(move); // pure translation — orientation is owned by the look state
}

// ---- floating text labels (camera-facing sprites) ----
// Crisp via devicePixelRatio; sized in WORLD units by `worldHeight` so labels
// stay a constant on-model height regardless of name length.
function makeLabel(text, { worldHeight = 0.5, fontPx = 44, bold = false, bg = '#222', fg = '#fff', maxAspect = Infinity } = {}) {
  const dpr = Math.min(devicePixelRatio, 2);
  const measure = document.createElement('canvas').getContext('2d');
  const font = `${bold ? '700 ' : ''}${fontPx}px system-ui, sans-serif`;
  measure.font = font;
  const padX = fontPx * 0.45, padY = fontPx * 0.30;
  const textW = measure.measureText(text).width;
  const cw = Math.ceil(textW + padX * 2), ch = Math.ceil(fontPx + padY * 2);

  const cv = document.createElement('canvas');
  cv.width = Math.ceil(cw * dpr); cv.height = Math.ceil(ch * dpr);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const r = ch * 0.30;
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(0, 0, cw, ch, r); ctx.fill();
  ctx.font = font; ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cw / 2, ch / 2 + 1);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }));
  let aspect = cw / ch;
  let h = worldHeight;
  if (aspect > maxAspect) { h = worldHeight * (maxAspect / aspect); aspect = maxAspect; } // shrink over-long labels
  sprite.scale.set(h * aspect, h, 1);
  return sprite;
}

// ---- load + lay out ----
const loader = new GLTFLoader();
function loadModel(name) {
  return new Promise((resolve) => {
    loader.load(ASSET(name), (gltf) => resolve(gltf.scene), undefined, (e) => {
      console.warn('failed to load', name, e);
      resolve(null);
    });
  });
}

async function main() {
  let names = [];
  try {
    const res = await fetch('/api/assets');
    names = (await res.json()).assets || [];
  } catch (e) {
    console.error('could not fetch asset manifest', e);
  }

  const scenes = await Promise.all(names.map(loadModel));
  const byName = new Map(names.map((n, i) => [n, scenes[i]]));

  // The procedural finish gantry, once per biome (it's not a file on disk) — injected
  // as an extra "model" so the rest of the pipeline (bucketing, layout, labels,
  // legend) shows each labelled in the Gates & Markers block wearing its theme's
  // plastic colours + colour grade.
  for (const [biome, theme] of Object.entries(THEMES)) {
    byName.set(`finish-gate-${biome}`, gantryGroup(theme, { dropDepth: 0.24 }));
    names.push(`finish-gate-${biome}`);
  }

  // Compose the monster variants from the loaded car bodies + the monster-truck
  // chassis, and inject them the same way.
  const monsterBase = byName.get(MONSTER_BASE_ASSET);
  if (monsterBase) {
    // The bare chassis (cab removed, recoloured) on its own, first in the block.
    byName.set('monster-chassis', buildMonsterChassis(monsterBase));
    names.push('monster-chassis');
    for (const v of MONSTER_VARIANTS) {
      const car = byName.get(v.model);
      if (!car) continue;
      byName.set(v.key, buildMonsterRig(car, monsterBase));
      names.push(v.key);
    }
  }

  // Procedural set-pieces — not files on disk: composed with the game's own
  // builders and injected like the monster variants. Animated ones (windmill,
  // train, chimney smoke) registered their steppers in showcaseAnims above.
  const inject = (name, obj) => {
    if (!obj) return;
    byName.set(name, obj);
    names.push(name);
  };
  for (const kind of Object.keys(LANDMARK_HOME)) inject('landmark-' + kind, buildLandmarkShowcase(kind));
  for (const [kind, tints] of Object.entries(CLUTTER_TINTS)) inject('clutter-' + kind, buildClutterShowcase(kind, tints));
  for (const theme of ['grass', 'sunset']) {
    const b = buildBalloon();
    applyBalloon(b, THEMES[theme]);
    inject('sky-balloon-' + (theme === 'grass' ? 'meadow' : 'dusk'), b);
  }
  inject('sky-glyph-bird',      buildGlyphShowcase(makeBirdTexture(),      0x51616d, 0.5));
  inject('sky-glyph-butterfly', buildGlyphShowcase(makeButterflyTexture(), 0xe66a5a, 0.5));
  inject('sky-glyph-plane',     buildGlyphShowcase(makePlaneTexture(),     0xf6f2e2, 0.5));
  inject('sky-glyph-kite',      buildGlyphShowcase(makeKiteTexture(),      0xd94f3d, 1));

  // Bucket by category, preserving the category display order.
  const buckets = new Map(CATEGORIES.map((c) => [c.key, []]));
  for (const n of names) buckets.get(categoryOf(n).key).push(n);

  const worldBox = new THREE.Box3();
  // Which category block to open framed on: ?focus=<category key> (see CATEGORIES).
  const focusKey = new URLSearchParams(location.search).get('focus') || 'monster';
  let focusBox = null;
  const tmp = new THREE.Box3();
  let cursorZ = 0;

  for (const cat of CATEGORIES) {
    const items = buckets.get(cat.key);
    if (!items.length) continue;
    const catBox = new THREE.Box3();

    // Per-category cell pitch from the largest footprint in the group, so big
    // pieces (corners, ramps) don't collide and tiny ones (coins) aren't lost.
    let maxFoot = 1;
    const sizes = new Map();
    for (const name of items) {
      const obj = byName.get(name);
      if (!obj) continue;
      const size = tmp.setFromObject(obj).getSize(new THREE.Vector3());
      sizes.set(name, { box: tmp.clone(), size });
      maxFoot = Math.max(maxFoot, size.x, size.z);
    }
    const pitch = maxFoot + CELL_GAP;
    const cols = Math.min(items.length, COLS_MAX);
    const rows = Math.ceil(items.length / cols);
    const startX = -(cols - 1) * pitch / 2; // centre the block on X = 0

    // Category header sprite, in front of (−Z of) the block.
    const header = makeLabel(cat.label, { worldHeight: 1.5, fontPx: 64, bold: true, bg: cat.color, fg: '#fff' });
    header.position.set(0, 1.9, cursorZ - pitch * 0.62);
    scene.add(header);
    worldBox.expandByPoint(header.position);

    items.forEach((name, i) => {
      const obj = byName.get(name);
      const info = sizes.get(name);
      if (!obj || !info) return;
      const col = i % cols, row = Math.floor(i / cols);
      const x = startX + col * pitch;
      const z = cursorZ + row * pitch;

      const center = info.box.getCenter(new THREE.Vector3());
      // Centre on the cell in X/Z, and drop so the model rests on the ground.
      obj.position.set(x - center.x, -info.box.min.y, z - center.z);
      scene.add(obj);

      const label = makeLabel(name, {
        worldHeight: 0.46, fontPx: 40, bg: cat.color + 'ee', fg: '#fff',
        maxAspect: (pitch * 1.5) / 0.46
      });
      label.position.set(x, info.size.y + 0.7, z);
      scene.add(label);

      for (const corner of [
        [x - pitch / 2, 0, z - pitch / 2], [x + pitch / 2, info.size.y + 1, z + pitch / 2]
      ]) { worldBox.expandByPoint(new THREE.Vector3(...corner)); catBox.expandByPoint(new THREE.Vector3(...corner)); }
    });

    if (cat.key === focusKey) focusBox = catBox;
    cursorZ += rows * pitch + CATEGORY_GAP;
  }

  // Open looking right at the focused block. The default (Monster Variants) uses a
  // LOW front framing so its category header floats above the trucks — but that
  // framing backs the camera into the neighbouring blocks on wide categories, so
  // any other ?focus target takes the generic 3/4 overhead instead.
  if (focusBox && focusKey !== 'monster') {
    frameOn(focusBox);
  } else if (focusBox) {
    const center = focusBox.getCenter(new THREE.Vector3());
    const size = focusBox.getSize(new THREE.Vector3());
    const halfW = Math.max(size.x, 4) / 2;
    const hfov = 2 * Math.atan(Math.tan((camera.fov * Math.PI / 180) / 2) * camera.aspect);
    const dist = (halfW / Math.tan(hfov / 2)) * 1.15; // fit the row width + a margin
    camera.position.set(center.x, center.y + 0.7, center.z - dist);
    lookAtPoint(new THREE.Vector3(center.x, center.y + 0.15, center.z));
  } else {
    frameOn(worldBox);
  }

  buildLegend();
  // One frame, then reveal — avoids a flash of an empty scene.
  renderer.render(scene, camera);
  document.getElementById('loading').classList.add('done');
  // Expose internals for debugging / scripted framing.
  window.__viewer = { scene, camera, look, worldBox, focusBox, frameOn };
}

// Aim the camera at a box from a 3/4 overhead angle, pulled back so the box
// fits the vertical FOV (with margin), looking forward down the +Z block run.
function frameOn(box) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = 0.5 * Math.max(size.x, size.z, 4);
  const fitH = radius / Math.tan((camera.fov * Math.PI / 180) / 2);
  const dist = fitH * 1.35;
  const dir = new THREE.Vector3(0.05, 0.5, -1).normalize(); // mostly forward, tilted down
  camera.position.copy(center).addScaledVector(dir, dist);
  lookAtPoint(center);
}

function buildLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = '<div class="row muted">Families</div>' + CATEGORIES
    .filter((c) => c.key !== 'other')
    .map((c) => `<div class="row"><span class="sw" style="background:${c.color}"></span>${c.label}</div>`)
    .join('');
}

let _animT = 0, _animLast = performance.now();
renderer.setAnimationLoop(() => {
  // step the adopted landmark animations (windmill rotor, wind-up train,
  // chimney smoke) on the same clamped clock the game loop uses
  const now = performance.now();
  const dt = Math.min((now - _animLast) / 1000, 0.05);
  _animLast = now;
  _animT += dt;
  for (const fn of showcaseAnims) fn(dt, _animT);
  flyStep();
  renderer.render(scene, camera);
});

main();
