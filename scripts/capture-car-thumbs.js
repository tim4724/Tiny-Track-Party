'use strict';

// Bake the lobby car-picker thumbnails for each roster car: a front-3/4 hero
// still plus a 24-frame turntable sprite strip, both as plain transparent PNGs
// (see public/shared/carThumbs.js — phones show <img>s, never WebGL).
//
//   <model>.png        — front-3/4 hero still (== strip frame 0)
//   <model>.strip.png  — horizontal sprite strip, SPIN_FRAMES cells wide
//
// Same "render the real GLB offline" pipeline as capture-item-icon.js: reuse the
// live origin so the vendored Three.js + importmap + CSP resolve, render into an
// own transparent renderer with the game's toy lighting, then read PNGs back.
//
// Framing is fixed from the model's bounding SPHERE (rotation-invariant), so the
// car holds the same size/position through the whole spin instead of jittering.
// A ShadowMaterial ground catches a soft contact shadow that turns with the car.
//
//   node scripts/capture-car-thumbs.js                    # all roster cars
//   node scripts/capture-car-thumbs.js --name vehicle-racer-low
//   node scripts/capture-car-thumbs.js --yaw 215 --pitch 22 --margin 1.18
//
// Flags: --name (one GLB basename, else all roster), --frames (24), --size (256
// final px/frame), --yaw/--pitch (deg), --margin (sphere-fit slack), --port,
// --headed.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');

// Roster (parallels CAR_MODELS in public/shared/protocol.js — Dash/Bolt/Carve/Rumble).
const ROSTER = ['vehicle-racer', 'vehicle-speedster', 'vehicle-racer-low', 'vehicle-vintage-racer'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'headed') { out.headed = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const MODELS = args.name ? [args.name] : ROSTER;
const FRAMES = parseInt(args.frames, 10) || 24;   // keep in sync with SPIN_FRAMES (carThumbs.js)
const SIZE = parseInt(args.size, 10) || 256;       // final px per square frame
const YAW = args.yaw !== undefined ? parseFloat(args.yaw) : 305;   // hero turntable angle (deg) — front-3/4 from the right
const PITCH = args.pitch !== undefined ? parseFloat(args.pitch) : 23; // look-down tilt (deg)
const MARGIN = args.margin !== undefined ? parseFloat(args.margin) : 1.0; // sphere-fit slack
const PORT = parseInt(args.port, 10) || 4322;
const OUTDIR = path.resolve(ROOT, 'public/assets/toycar/thumbs');

function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`server never came up on :${port}`));
        else setTimeout(ping, 150);
      });
    })();
  });
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const killServer = () => { try { server.kill('SIGTERM'); } catch (_) {} };
  process.on('exit', killServer);

  let browser;
  try {
    await waitForServer(PORT);
    browser = await chromium.launch({ headless: !args.headed });
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 2 });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

    for (const name of MODELS) {
      const { strip, still } = await page.evaluate(async ({ name, size, frames, yaw0, pitch, margin }) => {
        const THREE = await import('/vendor/three/three.module.js');
        const { GLTFLoader } = await import('/vendor/three/addons/loaders/GLTFLoader.js');

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(dpr);
        renderer.setSize(size, size, false);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setClearColor(0x000000, 0);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        const scene = new THREE.Scene();
        // Toy lighting matched to SceneRenderer / capture-item-icon.js.
        scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa68f, 2.2));
        const key = new THREE.DirectionalLight(0xfff1d0, 1.4);
        key.position.set(6, 12, 4);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.near = 0.5; key.shadow.camera.far = 60;
        const s = 0.9;
        Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
        key.shadow.bias = -0.0008;
        scene.add(key);

        const gltf = await new Promise((resolve, reject) =>
          new GLTFLoader().load(`/assets/toycar/${name}.glb`, resolve, undefined, reject));
        const model = gltf.scene;
        model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });

        // Centre on origin so the turntable spins in place.
        const box0 = new THREE.Box3().setFromObject(model);
        const center0 = box0.getCenter(new THREE.Vector3());
        model.position.sub(center0);

        const pivot = new THREE.Group();
        pivot.add(model);
        scene.add(pivot);

        // Ground shadow-catcher just under the wheels (model recentred → minY shifts).
        const minY = box0.min.y - center0.y;
        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(8, 8),
          new THREE.ShadowMaterial({ opacity: 0.26 }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = minY + 0.001;
        ground.receiveShadow = true;
        scene.add(ground);

        // Fixed framing from the bounding sphere (rotation-invariant).
        const sphere = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
        const fov = 32;
        const cam = new THREE.PerspectiveCamera(fov, 1, 0.01, 100);
        const dist = (sphere.radius / Math.sin((fov / 2) * Math.PI / 180)) * margin;
        const p = (pitch * Math.PI) / 180;
        // Bias the look-at slightly up so the contact shadow sits low in frame.
        const look = new THREE.Vector3(sphere.center.x, sphere.center.y + sphere.radius * 0.06, sphere.center.z);
        cam.position.set(look.x, look.y + Math.sin(p) * dist, look.z + Math.cos(p) * dist);
        cam.lookAt(look);

        const strip = document.createElement('canvas');
        strip.width = size * frames; strip.height = size;
        const sctx = strip.getContext('2d');
        const cell = document.createElement('canvas');
        cell.width = cell.height = size;
        const cctx = cell.getContext('2d');

        let still = null;
        for (let f = 0; f < frames; f++) {
          pivot.rotation.y = ((yaw0 + (f * 360) / frames) * Math.PI) / 180;
          pivot.updateMatrixWorld(true);
          renderer.render(scene, cam);
          // Downscale the @2x backing buffer into a crisp size×size cell.
          cctx.clearRect(0, 0, size, size);
          cctx.drawImage(renderer.domElement, 0, 0, size, size);
          sctx.drawImage(cell, f * size, 0);
          if (f === 0) still = cell.toDataURL('image/png');
        }
        return { strip: strip.toDataURL('image/png'), still };
      }, { name, size: SIZE, frames: FRAMES, yaw0: YAW, pitch: PITCH, margin: MARGIN });

      const write = (dataUrl, file) => {
        const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(path.join(OUTDIR, file), Buffer.from(b64, 'base64'));
      };
      write(still, `${name}.png`);
      write(strip, `${name}.strip.png`);
      console.log(`Baked ${name}: ${name}.png (${SIZE}px) + ${name}.strip.png (${SIZE * FRAMES}×${SIZE})`);
    }
  } finally {
    if (browser) await browser.close();
    killServer();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
