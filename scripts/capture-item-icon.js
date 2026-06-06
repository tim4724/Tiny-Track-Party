'use strict';

// Bake a 2D PNG icon of a Kenney item GLB for the HUD item slot — the same
// "render the real asset offline, ship a plain <img>" approach the car picker
// uses (see public/shared/carThumbs.js). The held-item slot can then show the
// actual banana model instead of a hand-drawn SVG, with no per-frame WebGL on
// the HUD.
//
// It reuses the live origin (so the vendored Three.js + importmap resolve and
// the CSP is satisfied) but renders into its OWN transparent renderer with the
// game's toy lighting (HemisphereLight + warm key), framed front-3/4, then reads
// the canvas back as a PNG data URL.
//
//   node scripts/capture-item-icon.js                       # → item-banana.png
//   node scripts/capture-item-icon.js --name item-cone      # any item GLB
//   node scripts/capture-item-icon.js --yaw 35 --pitch 18   # tweak the hero angle
//   node scripts/capture-item-icon.js --size 512 --out public/assets/toycar/thumbs/item-banana.png
//
// Flags (all optional): --name (GLB basename under assets/toycar), --out,
// --size (square px before DPR), --yaw/--pitch (degrees), --port, --headed.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');

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
const NAME = args.name || 'item-banana';
const SIZE = parseInt(args.size, 10) || 512;
const YAW = args.yaw !== undefined ? parseFloat(args.yaw) : 90;   // turntable angle (90 = front-on)
const PITCH = args.pitch !== undefined ? parseFloat(args.pitch) : 10; // look-down tilt
const PORT = parseInt(args.port, 10) || 4321;
const OUT = path.resolve(ROOT, args.out || `public/assets/toycar/thumbs/${NAME}.png`);

function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`server never came up on :${port}`));
        else setTimeout(ping, 150);
      });
    })();
  });
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

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

    // The display page carries the importmap + CSP nonce, so same-origin dynamic
    // import('three') resolves there. We don't need its scene — just the origin.
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

    const dataUrl = await page.evaluate(async ({ name, size, yaw, pitch }) => {
      const THREE = await import('/vendor/three/three.module.js');
      const { GLTFLoader } = await import('/vendor/three/addons/loaders/GLTFLoader.js');

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(dpr);
      renderer.setSize(size, size, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setClearColor(0x000000, 0); // transparent — the slot supplies its own white card

      const scene = new THREE.Scene();
      // Toy lighting, matched to SceneRenderer: soft sky/ground fill + a warm key
      // for the injection-moulded-plastic gloss.
      scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa68f, 2.2));
      const key = new THREE.DirectionalLight(0xfff1d0, 1.4);
      key.position.set(6, 12, 4);
      scene.add(key);

      const gltf = await new Promise((resolve, reject) =>
        new GLTFLoader().load(`/assets/toycar/${name}.glb`, resolve, undefined, reject));
      const model = gltf.scene;

      // Centre the model on the origin (in its own orientation) so the turntable
      // yaw spins it in place and framing is rotation-independent.
      const center0 = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
      model.position.sub(center0);

      const pivot = new THREE.Group();
      pivot.add(model);
      pivot.rotation.y = (yaw * Math.PI) / 180;
      scene.add(pivot);
      pivot.updateMatrixWorld(true);

      // Back a camera off along a pitched-down 3/4 ray, far enough that the bounding
      // sphere fits the vertical FOV (with a small margin).
      const sphere = new THREE.Box3().setFromObject(pivot).getBoundingSphere(new THREE.Sphere());
      const fov = 32;
      const cam = new THREE.PerspectiveCamera(fov, 1, 0.01, 100);
      const dist = (sphere.radius / Math.sin((fov / 2) * Math.PI / 180)) * 1.08; // 8% margin
      const p = (pitch * Math.PI) / 180;
      cam.position.set(
        sphere.center.x,
        sphere.center.y + Math.sin(p) * dist,
        sphere.center.z + Math.cos(p) * dist);
      cam.lookAt(sphere.center);

      renderer.render(scene, cam);

      // The object's aspect rarely matches the square slot, so a raw fit leaves
      // big margins. Crop tightly to the rendered alpha, recentre as a square, and
      // pad to ~10% so the banana fills the slot consistently regardless of pose.
      const src = renderer.domElement;
      const sctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      sctx.canvas.width = src.width; sctx.canvas.height = src.height;
      sctx.drawImage(src, 0, 0);
      const { data, width: W, height: H } = sctx.getImageData(0, 0, src.width, src.height);
      let minX = W, minY = H, maxX = -1, maxY = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (data[(y * W + x) * 4 + 3] > 12) { // alpha threshold
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return src.toDataURL('image/png'); // nothing drawn — bail uncropped
      const cw = maxX - minX + 1, ch = maxY - minY + 1;
      const side = Math.max(cw, ch);
      const pad = Math.round(side * 0.12);
      const outSide = side + pad * 2;
      const out = document.createElement('canvas');
      out.width = out.height = outSide;
      const octx = out.getContext('2d');
      octx.drawImage(src, minX, minY, cw, ch, pad + (side - cw) / 2, pad + (side - ch) / 2, cw, ch);
      return out.toDataURL('image/png');
    }, { name: NAME, size: SIZE, yaw: YAW, pitch: PITCH });

    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
    console.log(`Captured ${NAME} → ${path.relative(ROOT, OUT)} (${SIZE}px @2x, transparent)`);
  } finally {
    if (browser) await browser.close();
    killServer();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
