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
// The ground shadow reproduces the in-race look (SceneRenderer._bakeCarShadow): the
// car's baked top-down SILHOUETTE, tinted warm near-black with a tight penumbra,
// laid flat under the car and parented to the turntable so it spins with the car.
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

        const scene = new THREE.Scene();
        // Toy lighting matched to SceneRenderer / capture-item-icon.js. The key only LIGHTS
        // the body now — it casts no shadow (cars don't cast the sun shadow in-race either);
        // the ground shadow below is the car's baked top-down silhouette, like the engine.
        scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa68f, 2.2));
        const key = new THREE.DirectionalLight(0xfff1d0, 1.4);
        key.position.set(6, 12, 4);
        scene.add(key);

        const gltf = await new Promise((resolve, reject) =>
          new GLTFLoader().load(`/assets/toycar/${name}.glb`, resolve, undefined, reject));
        const model = gltf.scene;

        // Centre on origin so the turntable spins in place.
        const box0 = new THREE.Box3().setFromObject(model);
        const center0 = box0.getCenter(new THREE.Vector3());
        model.position.sub(center0);

        const pivot = new THREE.Group();
        pivot.add(model);
        scene.add(pivot);

        // Ground shadow — reproduce the in-race look (SceneRenderer._bakeCarShadow). The
        // car's shadow in the game is NOT a cast shadow: it's the car's own top-down
        // SILHOUETTE (cabin + wheels) baked flat on the ground, tinted warm near-black with
        // a tight penumbra, sitting straight under the car. Bake the same silhouette here —
        // same overscan / colour / opacity / blur constants — so the lobby turntable's shadow
        // matches the one players see while racing instead of a soft offset cast blob.
        const SHADOW_OVERSCAN = 1.45;   // keep in sync with SceneRenderer.SHADOW_OVERSCAN
        const SHADOW_COLOR = 0x171513;  // SceneRenderer.UNDER_AO_COLOR (warm near-black)
        const SHADOW_OPACITY = 0.55;    // SceneRenderer.UNDER_AO_OPACITY base (no brake-dive load on a turntable)

        // Footprint of the centred model (== the engine's footW/footL: a full bbox at rest).
        const fbb = new THREE.Box3().setFromObject(model);
        const footW = (fbb.max.x - fbb.min.x) || 0.1, footL = (fbb.max.z - fbb.min.z) || 0.1;
        const fcx = (fbb.min.x + fbb.max.x) / 2, fcz = (fbb.min.z + fbb.max.z) / 2;
        const hw = (footW / 2) * SHADOW_OVERSCAN, hl = (footL / 2) * SHADOW_OVERSCAN;

        // Render a flat-white top-down mask of the model on transparent, framed to the
        // footprint × overscan, then blur it on a 2D canvas for the soft edge — exactly the
        // engine's bake. Length runs up the texture (+Z → vertical), width across (+X).
        const ocam = new THREE.OrthographicCamera(-hw, hw, hl, -hl, 0.01, (fbb.max.y - fbb.min.y) + 2);
        ocam.position.set(fcx, fbb.max.y + 1, fcz);
        ocam.up.set(0, 0, 1);
        ocam.lookAt(fcx, fbb.min.y, fcz);
        const TW = 128, TH = Math.max(16, Math.round(TW * (hl / hw)));
        const rt = new THREE.WebGLRenderTarget(TW, TH);
        const maskScene = new THREE.Scene();
        const maskModel = model.clone(true);
        maskScene.add(maskModel);
        maskScene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff }); // flat unlit → pure silhouette
        renderer.setRenderTarget(rt);
        renderer.clear();
        renderer.render(maskScene, ocam);
        const px = new Uint8Array(TW * TH * 4);
        renderer.readRenderTargetPixels(rt, 0, 0, TW, TH, px);
        renderer.setRenderTarget(null);
        rt.dispose();
        // White rgb everywhere (so blurring fades ALPHA only — no dark fringe); alpha from the
        // mask. readRenderTargetPixels reads bottom-to-top, and the overhead camera's screen-X
        // runs opposite world +X (up=+Z, looking −Y), so flip BOTH axes to land a faithful
        // top-down map in the canvas (row 0 = world +Z up, col 0 = world −X). With the quad's
        // default flipY this maps u→world +X and v→world +Z, so the silhouette lies exactly
        // over the car (no nose↔tail or left↔right swap).
        const mask = document.createElement('canvas'); mask.width = TW; mask.height = TH;
        const mctx = mask.getContext('2d');
        const img = mctx.createImageData(TW, TH);
        for (let y = 0; y < TH; y++) {
          for (let x = 0; x < TW; x++) {
            const dst = (y * TW + x) * 4, src = ((TH - 1 - y) * TW + (TW - 1 - x)) * 4;
            img.data[dst] = 255; img.data[dst + 1] = 255; img.data[dst + 2] = 255;
            img.data[dst + 3] = px[src + 3];
          }
        }
        mctx.putImageData(img, 0, 0);
        const soft = document.createElement('canvas'); soft.width = TW; soft.height = TH;
        const softctx = soft.getContext('2d');
        softctx.filter = `blur(${Math.max(2, Math.round(TW * 0.022))}px)`; // tight penumbra, same as the engine
        softctx.drawImage(mask, 0, 0);
        const shadowTex = new THREE.CanvasTexture(soft);
        shadowTex.colorSpace = THREE.SRGBColorSpace;

        // A flat quad under the wheels, sized to the footprint × overscan and parented to the
        // turntable so the silhouette spins WITH the car (stays aligned at every yaw).
        const shadow = new THREE.Mesh(
          new THREE.PlaneGeometry(footW * SHADOW_OVERSCAN, footL * SHADOW_OVERSCAN),
          new THREE.MeshBasicMaterial({
            map: shadowTex, color: SHADOW_COLOR, transparent: true, opacity: SHADOW_OPACITY,
            depthWrite: false, side: THREE.DoubleSide,
          }));
        // +π/2 lays the quad flat with local +y → world +Z and local +x → world +X, so the
        // top-down silhouette sits true under the car; DoubleSide keeps it visible from above.
        shadow.rotation.x = Math.PI / 2;
        shadow.position.set(fcx, fbb.min.y + 0.001, fcz);
        pivot.add(shadow);

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
