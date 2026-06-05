// Asset World — a free-camera scene that loads every GLB in the toy-car kit and
// lays them out at TRUE SCALE, grouped by family, each with its file name
// floating above. The point is a shared vocabulary: orbit around, read the
// names, and we can all refer to "track-road-wide-corner-small" and mean the
// same model. No relay, no game logic — just the kit on display.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const ASSET = (name) => `/assets/toycar/${name}.glb`;

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
  { key: 'markers',        label: 'Gates & Markers',         color: '#d24b8f', test: (n) => n === 'gate' || n === 'gate-finish' },
  { key: 'supports',       label: 'Supports',                color: '#8a6f54', test: (n) => n.startsWith('supports') },
  { key: 'vehicles',       label: 'Vehicles',                color: '#3f8ddd', test: (n) => n.startsWith('vehicle') },
  { key: 'wheels',         label: 'Wheels',                  color: '#5b6b76', test: (n) => n.startsWith('wheel') },
  { key: 'items',          label: 'Items & Pickups',         color: '#4bb05a', test: (n) => n.startsWith('item') },
  { key: 'scenery',        label: 'Scenery',                 color: '#3f9b6b', test: (n) => n === 'tree' || n === 'tree-pine' },
  { key: 'effects',        label: 'Effects',                 color: '#94a3ad', test: (n) => n === 'smoke' },
  { key: 'other',          label: 'Other',                   color: '#888888', test: () => true }
];
function categoryOf(name) { return CATEGORIES.find((c) => c.test(name)); }

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
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495; // can't dive under the ground

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- WASD fly movement ----
// Mouse still orbits/zooms (OrbitControls); the keyboard TRANSLATES the whole
// rig — move camera and orbit target by the same delta so orientation is kept
// and you fly across the spread-out layout. W/S forward/back (horizontal),
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
  camera.position.add(move);
  controls.target.add(move); // move the orbit pivot too → translate, don't orbit
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

  // Bucket by category, preserving the category display order.
  const buckets = new Map(CATEGORIES.map((c) => [c.key, []]));
  for (const n of names) buckets.get(categoryOf(n).key).push(n);

  const scenes = await Promise.all(names.map(loadModel));
  const byName = new Map(names.map((n, i) => [n, scenes[i]]));

  const worldBox = new THREE.Box3();
  let focusBox = null; // the wide-road block — what we open framed on
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

    if (cat.key === 'road-wide') focusBox = catBox;
    cursorZ += rows * pitch + CATEGORY_GAP;
  }

  // Open framed on the wide-road family (the focus of the project); the rest of
  // the kit recedes behind it for context. Fall back to the whole layout.
  frameOn(focusBox || worldBox);
  // Let a zoom-out reach the far end of the whole layout.
  controls.maxDistance = worldBox.getSize(new THREE.Vector3()).length() * 1.2;
  controls.update();

  buildLegend();
  // One frame, then reveal — avoids a flash of an empty scene.
  renderer.render(scene, camera);
  document.getElementById('loading').classList.add('done');
  // Expose internals for debugging / scripted framing.
  window.__viewer = { scene, camera, controls, worldBox, focusBox, frameOn };
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
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, dist);
}

function buildLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = '<div class="row muted">Families</div>' + CATEGORIES
    .filter((c) => c.key !== 'other')
    .map((c) => `<div class="row"><span class="sw" style="background:${c.color}"></span>${c.label}</div>`)
    .join('');
}

renderer.setAnimationLoop(() => {
  flyStep();
  controls.update();
  renderer.render(scene, camera);
});

main();
