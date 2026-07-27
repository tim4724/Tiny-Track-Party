// Renderer compare harness — the native-port judging surface (docs/native-port/
// plan.md, Track R). ONE JS sim (the display page in ?scenario=fixture inside the
// iframe) feeds TWO renderers: Three.js renders it as the shipping game, and this
// page marshals the same contract snapshot + cameras per frame into the Filament
// wasm module (FrameInput v1, ttp_runtime.h). Identical state by construction —
// any visual difference is a renderer difference.
const W = 1280, H = 720;
const HEADER_BYTES = 40, CAR_F32 = 16, VIEW_F32 = 22; // header: version, dt, 6 counts, flags, sceneT

const $ = (id) => document.getElementById(id);
const statsEl = $('stats'), statusEl = $('status'), frameNoEl = $('frame-no');
const frame = $('fixture-frame'), ttpCanvas = $('ttp-canvas'), diffCanvas = $('diff-canvas');

let Module, rt = 0, fiPtr = 0, fiCap = 0;
let fixture = null;
let playing = true;
let marshalUs = 0, marshals = 0;

// ---- fixture URL: pass ?track= / ?biome= through to the display page ------
// The compare surface judges ONE track in ONE biome at a time; both renderers
// read the same theme, so `?biome=beach` here re-themes the Three.js pane and
// the payload the wasm module meshes from in the same step.
{
  const q = new URLSearchParams(location.search);
  // A SHIPPED track by default: the sim is the C++ one now, and its registry
  // carries only the shipped set (the gate0/gym dev tracks have no native sim).
  const p = new URLSearchParams({ scenario: 'fixture', track: q.get('track') || 'ribbon', dpr: '1' });
  if (q.get('biome')) p.set('biome', q.get('biome'));
  // ?item=<id> rides through to the display's debug hook, so every box in the
  // fixture rolls the same item: the only practical way to get a monster truck
  // (or a rocket, or a shield) in front of both renderers at a known frame.
  if (q.get('item')) p.set('item', q.get('item'));
  frame.src = `/?${p}`;
}

// ---- layout: scale both 1280×720 surfaces to their pane width -------------
function rescale() {
  for (const wrap of document.querySelectorAll('.frame-wrap')) {
    const s = wrap.clientWidth / W;
    for (const el of wrap.children) el.style.transform = `scale(${s})`;
  }
}
new ResizeObserver(rescale).observe(document.body);

// ---- wasm boot ------------------------------------------------------------
function cstr(s) { return Module.stringToNewUTF8(s); }

async function provide(name, bytes) {
  const ptr = Module._malloc(bytes.length);
  Module.HEAPU8.set(bytes, ptr);
  const namePtr = cstr(name);
  const rc = Module._ttp_provide_asset(rt, namePtr, ptr, bytes.length);
  Module._free(namePtr); Module._free(ptr);
  if (rc) throw new Error(`ttp_provide_asset(${name}) failed`);
}

async function bootWasm() {
  const { default: createTtpModule } = await import('/native/ttp.js');
  Module = await createTtpModule();
  const sel = cstr('#ttp-canvas');
  rt = Module._ttp_create(sel, W, H);
  Module._free(sel);
  if (!rt) throw new Error('ttp_create failed');
  for (const name of ['vcolor', 'vblend', 'vlit', 'vpoint', 'vground', 'vdecal', 'vpresent', 'vburst']) {
    const mat = await fetch(`/native/${name}.filamat`);
    if (mat.ok) await provide(`${name}.filamat`, new Uint8Array(await mat.arrayBuffer()));
  }
}
import { buildTrackBin, resolveModelTint } from '/shared/trackBin.js';


// Clone a GLB with every material set to 50% alpha blend (the monster's
// occlusion-fade ghost). GLB layout: 12-byte header, then chunks (JSON first).
function patchGlbGhost(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  for (const m of json.materials || []) {
    m.alphaMode = 'BLEND';
    m.doubleSided = false;
    const pbr = (m.pbrMetallicRoughness = m.pbrMetallicRoughness || {});
    const f = pbr.baseColorFactor || [1, 1, 1, 1];
    pbr.baseColorFactor = [f[0], f[1], f[2], 0.5];
  }
  let jsonText = JSON.stringify(json);
  while (jsonText.length % 4) jsonText += ' '; // 4-byte chunk alignment
  const jsonBytes = new TextEncoder().encode(jsonText);
  const rest = bytes.subarray(20 + jsonLen); // remaining chunks (BIN)
  const out = new Uint8Array(20 + jsonBytes.length + rest.length);
  out.set(bytes.subarray(0, 12), 0);
  const odv = new DataView(out.buffer);
  odv.setUint32(8, out.length, true);            // total length
  odv.setUint32(12, jsonBytes.length, true);     // JSON chunk length
  odv.setUint32(16, 0x4e4f534a, true);           // 'JSON'
  out.set(jsonBytes, 20);
  out.set(rest, 20 + jsonBytes.length);
  return out;
}

// ---- fixture handshake ----------------------------------------------------
async function waitFixture() {
  for (let i = 0; i < 120; i++) {
    const f = frame.contentWindow && frame.contentWindow.__fixture;
    if (f) return f;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('fixture iframe never exposed __fixture');
}

// ---- FrameInput v1 marshalling -------------------------------------------
function ensureBuffer(bytes) {
  if (bytes <= fiCap) return;
  if (fiPtr) Module._free(fiPtr);
  fiCap = Math.max(bytes, 4096);
  fiPtr = Module._malloc(fiCap);
}

function submitFrame(dt) {
  const t0 = performance.now();
  const snap = fixture.getSnapshot();
  const views = fixture.getViews();
  const snapIndexOf = (id) => snap.cars.findIndex((c) => c.id === id);
  // Detonations: the fixture's own event stream, mapped to the burst channel so
  // the compare pane shows the same explosion the game does (a hit rides the car
  // it hit, a whiff detonates at its track point).
  const bursts = [];
  for (const ev of fixture.drainEvents()) {
    if (ev.type === 'spin' && ev.cause === 'rocket') {
      const i = snapIndexOf(ev.id);
      if (i >= 0) bursts.push({ car: i, s: 0, lat: 0 });
    } else if (ev.type === 'rocket_expire') {
      bursts.push({ car: -1, s: ev.s, lat: ev.lat });
    }
  }
  const cars = snap.cars;
  const boxes = snap.boxes || [];
  const bananas = snap.bananas || [];
  const rockets = snap.rockets || [];
  const bytes = HEADER_BYTES + cars.length * CAR_F32 * 4 + views.length * VIEW_F32 * 4
      + boxes.length * 4 + bananas.length * 8 + rockets.length * 8 + bursts.length * 12;
  ensureBuffer(bytes);
  // Views detach on wasm memory growth — re-derive per frame.
  const dv = new DataView(Module.HEAPU8.buffer, fiPtr, bytes);
  dv.setUint32(0, 9, true);            // TTP_FRAME_INPUT_VERSION
  dv.setFloat32(4, dt, true);
  dv.setUint32(8, cars.length, true);
  dv.setUint32(12, views.length, true);
  dv.setUint32(16, boxes.length, true);
  dv.setUint32(20, bananas.length, true);
  dv.setUint32(24, rockets.length, true);
  dv.setUint32(28, bursts.length, true);
  dv.setUint32(32, 0, true);           // flags (reserved)
  // The JS scene's env clock (_birdT): the phase source for every wall-clock
  // cosmetic, so both panes' boxes/clouds/balloon animate in the same phase.
  const sceneWin = document.getElementById('fixture-frame')?.contentWindow;
  dv.setFloat32(36, sceneWin?.__scene?._birdT ?? 0, true);
  let o = HEADER_BYTES;
  const f32 = (v) => { dv.setFloat32(o, v, true); o += 4; };
  const u32 = (v) => { dv.setUint32(o, v, true); o += 4; };
  for (const c of cars) {
    f32(c.pose.pos.x); f32(c.pose.pos.y); f32(c.pose.pos.z);
    f32(c.pose.forward.x); f32(c.pose.forward.y); f32(c.pose.forward.z);
    f32(c.pose.up.x); f32(c.pose.up.y); f32(c.pose.up.z);
    f32(c.spd); f32(c.steer); f32(c.brake ? 1 : 0); f32(c.boostMul || 1);
    f32(c.monster ? 1 : 0);
    f32(c.spin || 0); f32(c.onWall ? 1 : 0);
  }
  for (const v of views) {
    for (let i = 0; i < 16; i++) f32(v.world[i]);
    f32(v.fov); f32(v.aspect); f32(v.near); f32(v.far);
    f32(v.fogNear || 0); f32(v.fogFar || 0);
  }
  for (const b of boxes) u32(b ? 1 : 0);
  for (const b of bananas) { f32(b.s); f32(b.lat); }
  for (const r of rockets) { f32(r.s); f32(r.lat); }
  for (const b of bursts) { dv.setInt32(o, b.car, true); o += 4; f32(b.s); f32(b.lat); }
  const rendered = Module._ttp_submit_frame(rt, fiPtr);
  marshalUs += (performance.now() - t0) * 1000;
  marshals++;
  return rendered === 1;
}

// ---- main loop ------------------------------------------------------------
let statClock = 0, lastT = 0;
function loop(t) {
  requestAnimationFrame(loop);
  if (!fixture || !rt) return;
  const dt = lastT ? (t - lastT) / 1000 : 1 / 60;
  lastT = t;
  submitFrame(dt);
  frameNoEl.textContent = `frame ${fixture.frame()}`;
  statClock += dt;
  if (statClock >= 0.5 && marshals) {
    statsEl.textContent =
        `marshal+submit ${(marshalUs / marshals).toFixed(1)} µs/frame · ` +
        `${fixture.getSnapshot().cars.length} cars · ${fixture.getViews().length} views · ` +
        `sim ${fixture.isRunning() ? 'running' : 'paused'}`;
    statClock = 0; marshalUs = 0; marshals = 0;
  }
}

// ---- controls -------------------------------------------------------------
function setPlaying(on) {
  playing = on;
  if (on) fixture.play(); else fixture.pause();
  $('play').textContent = on ? '❚❚ pause' : '▶ play';
}
$('play').addEventListener('click', () => setPlaying(!playing));
$('step1').addEventListener('click', async () => { setPlaying(false); await fixture.step(); });
$('step10').addEventListener('click', async () => { setPlaying(false); for (let i = 0; i < 10; i++) await fixture.step(); });
$('reset').addEventListener('click', () => { fixture.reset(); diffCanvas.style.display = 'none'; });

const row = $('row'), paneLeft = $('pane-left'), paneRight = $('pane-right');
function applyMode() {
  const mode = $('mode').value;
  const overlay = mode === 'wipe' || mode === 'onion';
  row.classList.toggle('is-overlay', overlay);
  if (overlay) paneLeft.querySelector('.frame-wrap').appendChild(ttpCanvas);
  else paneRight.querySelector('.frame-wrap').appendChild(ttpCanvas);
  ttpCanvas.style.opacity = mode === 'onion' ? '0.5' : '1';
  ttpCanvas.style.clipPath = mode === 'wipe' ? `inset(0 0 0 ${$('wipe').value}%)` : '';
  ttpCanvas.style.zIndex = overlay ? '1' : '';
  diffCanvas.style.display = mode === 'diff' ? 'block' : 'none';
  paneRight.style.display = overlay ? 'none' : '';
  rescale();
}
$('mode').addEventListener('change', applyMode);
// Camera mode. The chase grid is what the game shows, but four car close-ups
// hide almost everything a renderer port gets wrong at track scale (cast
// shadows, ground blending, scenery placement) — the overview is one static
// wide shot of the whole circuit, fed to BOTH renderers from the same camera.
$('cam').addEventListener('change', async () => {
  fixture.setCamera($('cam').value);
  if (!playing) await fixture.step(0); // re-present the three side on the new camera
});
$('wipe').addEventListener('input', () => { if ($('mode').value === 'wipe') ttpCanvas.style.clipPath = `inset(0 0 0 ${$('wipe').value}%)`; });

// Capture a synchronized pair at the CURRENT (paused) frame: the presented
// Three.js pixels via the fixture's post-present hook, our own canvas after a
// fresh same-state present, plus the |Δ| image and its mean.
async function capturePair() {
  const leftURL = await fixture.capture();
  const leftImg = new Image();
  await new Promise((res, rej) => { leftImg.onload = res; leftImg.onerror = rej; leftImg.src = leftURL; });
  // Fresh present of the identical state, same task as the readback below.
  // beginFrame backpressure can SKIP a submit (leaving the canvas one frame
  // stale — a camera-level desync in fast resim captures), so resubmit until
  // the wasm side reports a real render, letting the compositor drain between
  // tries.
  for (let tries = 0; !submitFrame(0) && tries < 20; tries++) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  };
  const leftC = mk(), rightC = mk(), diffC = mk();
  leftC.getContext('2d').drawImage(leftImg, 0, 0, W, H);
  rightC.getContext('2d').drawImage(ttpCanvas, 0, 0, W, H);
  const lD = leftC.getContext('2d').getImageData(0, 0, W, H);
  const rD = rightC.getContext('2d').getImageData(0, 0, W, H);
  const out = diffC.getContext('2d').createImageData(W, H);
  let sum = 0;
  for (let i = 0; i < lD.data.length; i += 4) {
    const d = (Math.abs(lD.data[i] - rD.data[i])
             + Math.abs(lD.data[i + 1] - rD.data[i + 1])
             + Math.abs(lD.data[i + 2] - rD.data[i + 2])) / 3;
    sum += d;
    // heat ramp: dark → orange → white keeps small deltas readable
    out.data[i] = Math.min(255, d * 3);
    out.data[i + 1] = Math.min(255, Math.max(0, d * 3 - 130));
    out.data[i + 2] = Math.min(255, Math.max(0, d * 3 - 220));
    out.data[i + 3] = 255;
  }
  diffC.getContext('2d').putImageData(out, 0, 0);
  return { leftC, rightC, diffC, mean: sum / (lD.data.length / 4) };
}

// Pixel diff on demand at the current frame.
$('diff-now').addEventListener('click', async () => {
  setPlaying(false);
  const pair = await capturePair();
  diffCanvas.getContext('2d').drawImage(pair.diffC, 0, 0);
  $('mode').value = 'diff';
  applyMode();
  statusEl.textContent = `mean |Δ| = ${pair.mean.toFixed(2)} / 255 (diff pane on the left)`;
});

// Canonical-frame catalogue: deterministic resim to a fixed set of judging
// moments, a captured pair + heatmap + score per row — Track R's screenshot
// checkpoints, human-judgeable and regression-visible in one strip.
// Transient FX (impact bursts) animate on WALL time in both renderers — they
// align in live play but not in a fast resim, so catalogue frames sit clear
// of them (#545: the whiff burst has expired on both sides).
const CATALOGUE_FRAMES = [
  [45, 'grid + gantry'], [150, 'first corner'], [300, 'monster active'],
  [600, 'post-rocket'], [700, 'backstretch'], [900, 'oil + cones'],
  [1080, 'crest pad'], [1300, 'loop lap 2'],
];
$('catalogue').addEventListener('click', async () => {
  setPlaying(false);
  const strip = $('catalogue-strip');
  strip.innerHTML = '<div>running catalogue…</div>';
  fixture.reset();
  const rows = [];
  let cur = 0, total = 0;
  for (const [target, label] of CATALOGUE_FRAMES) {
    while (cur < target) { await fixture.step(); cur++; }
    const pair = await capturePair();
    total += pair.mean;
    rows.push({ label, target, pair });
  }
  strip.innerHTML = '';
  const head = document.createElement('div');
  head.textContent = `catalogue mean |Δ| = ${(total / CATALOGUE_FRAMES.length).toFixed(2)} / 255 — three.js | filament | heat`;
  head.style.color = '#9c9';
  strip.appendChild(head);
  for (const r of rows) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; align-items:center;';
    const cap = document.createElement('div');
    cap.style.cssText = 'width:150px; flex:none;';
    cap.textContent = `#${r.target} ${r.label} — ${r.pair.mean.toFixed(1)}`;
    row.appendChild(cap);
    for (const c of [r.pair.leftC, r.pair.rightC, r.pair.diffC]) {
      c.style.cssText = 'width:320px; height:180px;';
      row.appendChild(c);
    }
    strip.appendChild(row);
  }
});

// ---- boot -----------------------------------------------------------------
try {
  statusEl.textContent = 'loading wasm module…';
  await bootWasm();
  statusEl.textContent = 'waiting for fixture sim…';
  fixture = await waitFixture();
  // Hand the renderer its one-time scene-build payload: the serialized built
  // track + roster colours, plus each roster car's GLB ("shells fetch, the
  // runtime consumes bytes" — same path the Swift/Kotlin shells will use).
  const td = fixture.getTrackData();
  // Scenery GLBs come first: the untextured Nature-Kit models (palms, cacti)
  // are recoloured by the biome's `tint`, and resolving that needs each
  // model's AUTHORED material colours — so fetch the bytes, read their
  // materials, and fold the resolved per-material tints into track.bin.
  const scModelNames = [...new Set([...((td.scenery || {}).trees || []).map((e) => e.model),
                                    ...((td.scenery || {}).bush ? [td.scenery.bush.model] : [])])];
  const scBytes = await Promise.all(scModelNames.map(async (model) => {
    const res = await fetch(`/assets/toycar/${model}.glb`);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  }));
  td.modelTints = scModelNames.map((model, i) => resolveModelTint(td, model, scBytes[i]));
  // The kit GLBs reference their palette texture by EXTERNAL uri, and not every
  // model shares one map (the Holiday Kit pines carry their own) — ship whatever
  // each scenery model actually asks for, under that exact name.
  const texUris = new Set();
  for (const bytes of scBytes) {
    if (!bytes) continue;
    try {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
      for (const img of json.images || []) if (img.uri) texUris.add(img.uri);
    } catch { /* a model we can't parse just renders untextured */ }
  }
  await Promise.all([...texUris].map(async (uri) => {
    const res = await fetch(`/assets/toycar/${uri}`);
    if (res.ok) await provide(uri, new Uint8Array(await res.arrayBuffer()));
  }));
  await provide('track.bin', buildTrackBin(td));
  await Promise.all(scBytes.map((bytes, i) =>
    bytes ? provide(`scenery${i}.glb`, bytes) : null));
  // The kit GLBs reference their palette texture by EXTERNAL uri — ship it under
  // that exact name so the C++ ResourceLoader can resolve it (no filesystem).
  const tex = await fetch('/assets/toycar/Textures/colormap.png');
  if (tex.ok) await provide('Textures/colormap.png', new Uint8Array(await tex.arrayBuffer()));
  await Promise.all([
    ...(td.roster || []).map(async (r, i) => {
      if (!r.model) return;
      const res = await fetch(`/assets/toycar/${r.model}.glb`);
      if (!res.ok) return; // box-marker fallback on the wasm side
      const bytes = new Uint8Array(await res.arrayBuffer());
      await provide(`car${i}.glb`, bytes);
      // 50%-alpha ghost variant — the monster occlusion fade dims the WHOLE
      // grafted rig in the JS (chassis AND the player's car body), so the
      // native side needs a ghost body to swap in alongside the ghost chassis.
      if (!location.search.includes('noghost')) await provide(`car${i}-ghost.glb`, patchGlbGhost(bytes));
    }),
    ...['item-box', 'item-banana', 'item-cone', 'vehicle-monster-truck'].map(async (name) => {
      const res = await fetch(`/assets/toycar/${name}.glb`);
      if (!res.ok) return;
      const bytes = new Uint8Array(await res.arrayBuffer());
      await provide(`${name}.glb`, bytes);
      if (name === 'vehicle-monster-truck') {
        // Ghost variant for the occlusion fade: same GLB with its materials
        // patched to 50% alpha blend (the renderer swaps chassis → ghost
        // while the truck blocks a cell's view — MONSTER_FADE_OPACITY).
        await provide('monster-ghost.glb', patchGlbGhost(bytes));
      }
    }),
  ]);
  if (Module._ttp_build_scene(rt)) throw new Error('ttp_build_scene failed');
  fixture.play();
  statusEl.textContent = '';
  applyMode();
  rescale();
  // Scene lifecycle, exercisable from the console: the game rebuilds through
  // this pair on every race start (a GP chains four tracks).
  window.__compare = {
    fixture: () => fixture,
    Module: () => Module,
    rebuild: async () => {
      Module._ttp_release_scene(rt);
      await provide('track.bin', buildTrackBin(fixture.getTrackData()));
      if (Module._ttp_build_scene(rt)) throw new Error('ttp_build_scene failed');
    },
  };
  requestAnimationFrame(loop);
} catch (e) {
  statusEl.textContent = `BOOT FAILED: ${e.message} (run scripts/build-wasm.sh?)`;
  throw e;
}
