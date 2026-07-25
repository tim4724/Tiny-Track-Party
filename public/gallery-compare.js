// Renderer compare harness — the native-port judging surface (docs/native-port/
// plan.md, Track R). ONE JS sim (the display page in ?scenario=fixture inside the
// iframe) feeds TWO renderers: Three.js renders it as the shipping game, and this
// page marshals the same contract snapshot + cameras per frame into the Filament
// wasm module (FrameInput v1, ttp_runtime.h). Identical state by construction —
// any visual difference is a renderer difference.
const W = 1280, H = 720;
const HEADER_BYTES = 36, CAR_F32 = 16, VIEW_F32 = 22;

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
  const p = new URLSearchParams({ scenario: 'fixture', track: q.get('track') || 'gate0', dpr: '1' });
  if (q.get('biome')) p.set('biome', q.get('biome'));
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
  for (const name of ['vcolor', 'vblend', 'vlit']) {
    const mat = await fetch(`/native/${name}.filamat`);
    if (mat.ok) await provide(`${name}.filamat`, new Uint8Array(await mat.arrayBuffer()));
  }
}

// Resolve a scenery model's biome recolour into per-MATERIAL colours.
// buildScenery bakes `tint` into vertex colours for UNTEXTURED models: a plain
// hex repaints the whole model, a map is keyed by each part's AUTHORED colour
// (a palm's fronds and trunk differ). gltfio names its material instances after
// the glTF material, so the native side can apply the same recolour by name —
// resolve the authored colours HERE, where the tint tables live.
function resolveModelTint(td, model, bytes) {
  const sc = td.scenery || {};
  const entry = (sc.trees || []).find((e) => e.model === model)
    || (sc.bush && sc.bush.model === model ? sc.bush : null);
  const tint = entry && entry.tint;
  if (!tint || !bytes) return [];
  let json;
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLen = dv.getUint32(12, true);
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  } catch { return []; }
  const out = [];
  for (const m of json.materials || []) {
    if (typeof tint !== 'object') { out.push([m.name || '', tint]); continue; }
    // Authored colour as the six-hex-digit key the theme's map uses. The glTF
    // factor is LINEAR; the theme keys are the sRGB hex three.js reports.
    const f = (m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorFactor) || [1, 1, 1, 1];
    const toSrgb = (c) => Math.round(255 * (c <= 0.0031308 ? c * 12.92
      : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
    const key = [0, 1, 2].map((i) => toSrgb(f[i]).toString(16).padStart(2, '0')).join('');
    if (tint[key] != null) out.push([m.name || '', tint[key]]);
  }
  return out;
}

// ---- scene-build payload ---------------------------------------------------
// "track.bin" v2: the serialized built track the renderer meshes from — layout
// documented in TtpRenderer.cpp. Carries the roster colours, the RESOLVED road
// palette (theme.road with buildRoad's defaults applied, sRGB — one source of
// palette truth, the JS theme), launch-strip zones (bare-asphalt dash blanking)
// and 11×f32 per sample: pos, lateral, up, width, s. Binary — no JSON in C++.
function buildTrackBin(td) {
  const ss = td.track.centerline.samples;
  const roster = td.roster || [];
  const rd = td.road || {};
  const num = (v, d) => {
    if (v == null) return d;
    return typeof v === 'string' ? parseInt(v.replace('#', ''), 16) : v;
  };
  const pal = [
    num(rd.asphalt, 0x5a6078),
    num(rd.line, 0xc4c4d9),
    num(rd.dash ?? rd.line, 0xc4c4d9),
    num(rd.kerb ? rd.kerb[0] : null, 0xfa6b41),
    num(rd.kerb ? rd.kerb[1] : null, 0xf8f8fb),
    num(rd.skirt ?? rd.asphalt, 0x5a6078),
    num(rd.shoulder ?? rd.asphalt, 0x5a6078)
  ];
  const STRIP_MARGIN = 0.12;
  const zones = (td.track.pads || [])
    .filter((p) => p.shape === 'strip')
    .map((p) => [p.s, (p.halfLen || 0) + STRIP_MARGIN]);
  const sky = td.sky || {};
  const skyCols = [num(sky.zenith, 0x59a7e8), num(sky.horizon, 0x8ecae6), num(sky.below, 0xc8e9f2)];
  const fogCol = num(td.fog, 0x8ecae6);
  const HILL_SHAPES = { dome: 0, mesa: 1, block: 2, island: 3 };
  const hillShape = HILL_SHAPES[td.hillShape] ?? 0;
  const hillCols = (td.hills || [0x8cc578, 0x7cb86a, 0x9bce86]).map((h) => num(h, 0x8cc578));
  const envBytes = 3 * 4 + 4 + 4 + 4 + hillCols.length * 4;
  // Furniture: item-box anchors + every pad (0 = chevron disc, 1 = launch strip).
  const boxes = (td.track.boxes || []).map((b) => [b.s, b.lat || 0]);
  const pads = (td.track.pads || []).map((p) => p.shape === 'strip'
    ? [1, p.s, p.lat || 0, p.halfLen || 1, p.halfWidth || 2]
    : [0, p.s, p.lat || 0, p.radius || 0.65, 0]);
  const furnBytes = 4 + boxes.length * 8 + 4 + pads.length * 20;
  // Scenery palette (trees/bush/boulders) + the exact stream seeds. Model
  // names map to provided scenery<i>.glb assets by index.
  const sc = td.scenery || {};
  const scModels = [...new Set([...(sc.trees || []).map((e) => e.model),
                                ...(sc.bush ? [sc.bush.model] : [])])];
  const scTrees = (sc.trees || []).map((e) => [scModels.indexOf(e.model), e.w, e.s[0], e.s[1]]);
  const scBush = sc.bush ? [scModels.indexOf(sc.bush.model), sc.bush.s[0], sc.bush.s[1], sc.bush.sink || 0] : null;
  const scRocks = (sc.rocks || [0xaaaaaa, 0xb4a898, 0x9aa2a4]).slice(0, 3);
  const scBytes = 4 * 2 + 4 * 3 + 4 + scTrees.length * 16 + 4 + (scBush ? 16 : 0) + 3 * 4 + 2 * 4 + 4;
  // Landmark kinds (fixed enum shared with the C++ port) + their stream seed.
  // Enum shared with the C++ port. The C++ dispatches in buildLandmarks' SOURCE
  // order (not id order) — several kinds share one rand stream, so the draw
  // order is part of the contract.
  const LM = { gnome: 0, doghouse: 1, picnic: 2, hoodoo: 3, snowman: 4,
               blocks: 5, windmill: 6, lighthouse: 7, sailboat: 8, duck: 9,
               ball: 10, umbrella: 11, sandcastle: 12, cabin: 13, crayons: 14,
               books: 15, train: 16 };
  const lmKinds = [].concat(td.landmark || []).map((k) => LM[k]).filter((k) => k != null);
  const lmBytes = 4 + 4 + lmKinds.length * 4;
  // Ground clutter. A palette with an unported kind sends NONE — the C++ side
  // replays the same rand stream, so a silently skipped kind would diverge it.
  const CLK = { flower: 0, shell: 1, starfish: 2, driftwood: 3, drift: 4,
                scrub: 5, pebbles: 6, brick: 7, marble: 8, domino: 9 };
  const clRaw = (sc.clutter && sc.clutter.kinds) || [];
  const clOk = clRaw.every((k) => CLK[k.kind] != null);
  const clKinds = clOk ? clRaw.map((k) => [CLK[k.kind], k.w, k.tints || []]) : [];
  const clBytes = 4 + 4 + clKinds.reduce((a, [, , t]) => a + 12 + t.length * 4, 0);
  const oils = (td.track.hazards || []).map((h) => [h.s, h.lat || 0, h.radius || 0.8, h.cones || 4]);
  // Support structures (track.js buildPillars/buildPoles/buildLoopPoles) and the
  // grass BERMS lofted under raised, non-pillared deck (buildHills). Ghost poles
  // are collision proxies for supports already drawn — never meshed.
  const poles = (td.track.poles || []).filter((p) => !p.ghost)
      .map((p) => [p.s, p.lat || 0, p.radius || 0.45]);
  const pillars = (td.track.pillars || []).map((p) => [p.x, p.z, p.baseY, p.topY, p.radius]);
  const posts = (td.track.supportPosts || []).map((p) => [p.x, p.z, p.radius,
      p.contact.pos.x, p.contact.pos.y, p.contact.pos.z,
      p.contact.up.x, p.contact.up.y, p.contact.up.z]);
  const berms = (td.track.hills || []).map((run) => run.map(
      (r) => [r.cx, r.cz, r.lx, r.lz, r.halfW, r.topL, r.topR]));
  const oilBytes = 4 + oils.length * 16 + 4 + poles.length * 12
      + 4 + pillars.length * 20 + 4 + posts.length * 36
      + 4 + berms.reduce((a, run) => a + 4 + run.length * 28, 0) + 4;
  // ── theme block (v12) ─────────────────────────────────────────────────────
  // Everything the BIOME dresses beyond the road/sky/hill colours above: the
  // ground kind, the light rig, the sky/air/water furniture and the accent
  // colours. Emitted as a flat tag/value list so the size can't drift out of
  // sync with the writes (the C++ reads the identical sequence).
  const T = [];
  const tu = (v) => T.push([0, v >>> 0]);
  const tf = (v) => T.push([1, v]);
  const tcol = (v, d) => tu(num(v, d));
  const GROUND_KINDS = { lawn: 0, sand: 1, redrock: 2, snow: 3, wood: 4 };
  tu(GROUND_KINDS[(td.ground && td.ground.kind) || 'lawn'] ?? 0);
  tf(td.fogTune ?? 1);
  tcol(td.key && td.key.color, 0xfff1d0);
  tf((td.key && td.key.intensity) ?? 1.4);
  tcol(td.hemi && td.hemi.sky, 0xffffff);
  tcol(td.hemi && td.hemi.ground, 0x9aa68f);
  tf((td.hemi && td.hemi.intensity) ?? 2.2);
  const cl = td.clouds || {};
  tu(cl.count ?? 8); tf(cl.opacity ?? 0.8); tf(cl.scale ?? 1);
  tf(cl.aspect ?? 0.42); tcol(cl.tint, 0xffffff);
  tcol(td.gate, 0xffffff);
  // FinishGate's DEFAULT_GANTRY is { pylon: RED, finial: PAPER }; `rings` is
  // OPTIONAL (its presence switches the pylon to lighthouse bands), so it
  // carries a flag rather than a default.
  const gy = td.gantry || {};
  tcol(gy.pylon, 0xff5040); tcol(gy.finial, 0xfff6eb);
  tu(gy.rings != null ? 1 : 0); tcol(gy.rings, 0xff5040);
  tcol(td.boost, 0x22c9b6);
  const wa = td.water;
  tu(wa ? 1 : 0);
  if (wa) {
    tcol(wa.foam, 0xffffff); tcol(wa.shallow, 0x62d3c8);
    tcol(wa.deep, 0x2596c8); tcol(wa.wet, 0x7d5f34);
    // shorelineFn's per-track seed: FNV-1a over the track id, so the island's
    // lobes/crinkle/swash come out identical on both renderers.
    let seed = 2166136261 >>> 0;
    for (const ch of String(td.trackId ?? '')) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
    tu(seed);
  }
  const hz = td.haze || {};
  tu(hz.count ?? 0); tf(hz.opacity ?? 0.16); tcol(hz.tint, 0xffffff); tf(hz.scale ?? 1);
  const AMB_KINDS = { pollen: 1, mote: 2, sand: 3, flake: 4 };
  const am = td.ambient;
  tu(am ? (AMB_KINDS[am.kind] ?? 0) : 0);
  tu(am ? (am.count ?? 650) : 0);
  tf((am && am.size) ?? 0.3); tf((am && am.opacity) ?? 0.85);
  tcol(am && am.tint, 0xffffff);
  tf((am && am.fall) ?? 1); tf((am && am.wind) ?? 0.7);
  tf((am && am.bob) ?? 0); tf((am && am.band) ?? 1);
  const bi = td.birds || {};
  tu(bi.count ?? 0); tcol(bi.tint, 0xffffff);
  tf(bi.size ?? 2.4); tf(bi.y ?? 18); tf(bi.rc ?? 120); tf(bi.rb ?? 22);
  tf(bi.speed ?? 0.2); tf(bi.flap ?? 0.8); tf(bi.flapHz ?? 1.8); tf(bi.dys ?? 1);
  const ki = td.kites || {};
  tu(ki.count ?? 0); tf(ki.size ?? 2.8); tf(ki.y ?? 13);
  const kiTints = ki.tints || [];
  tu(kiTints.length);
  for (const t of kiTints) tcol(t, 0xffffff);
  const pp = td.paperPlane;
  tu(pp ? 1 : 0);
  if (pp) {
    tcol(pp.tint, 0xfaf7ec);
    tf(pp.size ?? 3.2); tf(pp.y ?? 22); tf(pp.a0 ?? 1.3);
    tf(pp.rc ?? 95); tf(pp.rb ?? 32); tf(pp.speed ?? 0.3); tf(pp.bank ?? 0.4);
  }
  const ba = td.balloon;
  const baPanels = (ba && ba.panels) || [];
  tu(baPanels.length);
  for (const p of baPanels) tcol(p, 0xffffff);
  tf((ba && ba.y) ?? 44); tf((ba && ba.size) ?? 6);
  const ic = td.ice;
  tu(ic ? 1 : 0);
  if (ic) { tcol(ic.sheet, 0xa9d7ee); tcol(ic.frost, 0xf0f8fd); }
  // Per-scenery-model recolour, resolved to (material name, sRGB) pairs.
  const mt = td.modelTints || [];
  tu(mt.length);
  for (const pairs of mt) {
    tu(pairs.length);
    for (const [name, rgb] of pairs) {
      const nm = String(name).slice(0, 16);
      for (let i = 0; i < 16; i += 4) {
        tu((nm.charCodeAt(i) & 0xff) | ((nm.charCodeAt(i + 1) & 0xff) << 8)
          | ((nm.charCodeAt(i + 2) & 0xff) << 16) | ((nm.charCodeAt(i + 3) & 0xff) << 24));
      }
      tcol(rgb, 0xffffff);
    }
  }
  const themeBytes = T.length * 4;
  const headerBytes = 28 + roster.length * 16 + pal.length * 4 + 12 + 4 + zones.length * 8 + envBytes + furnBytes + scBytes + lmBytes + clBytes + oilBytes + themeBytes;
  const buf = new ArrayBuffer(headerBytes + ss.length * 11 * 4);
  const dv = new DataView(buf);
  let o = 0;
  const u32 = (v) => { dv.setUint32(o, v, true); o += 4; };
  const f32 = (v) => { dv.setFloat32(o, v, true); o += 4; };
  u32(14);                                        // TRACK_BIN_VERSION
  u32(ss.length);
  f32(td.track.roadWidth);
  f32(td.track.groundY ?? 0);
  f32(td.track.length);
  u32(td.track.closed ? 1 : 0);
  u32(roster.length);
  for (const r of roster) {                       // '#rrggbb' → ABGR u32
    const n = parseInt((r.color || '#888888').slice(1), 16);
    u32(0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16));
  }
  for (const r of roster) {                       // name, 8 ASCII bytes (rear plates)
    const name = String(r.name || ''); // as authored — the plate face is mixed case
    for (let i = 0; i < 8; i++) {
      dv.setUint8(o, i < name.length ? name.charCodeAt(i) & 0x7f : 0); o += 1;
    }
  }
  // Rear-plate height on this model's back panel (SceneRenderer's PLATE_Y
  // override); < 0 = fall back to the fixed fraction of the body's height.
  for (const r of roster) f32(r.plateY == null ? -1 : r.plateY);
  for (const p of pal) u32(p);                    // sRGB 0xrrggbb
  f32(rd.kerbW ?? 0.22);
  f32(rd.kerbH ?? 0.20);
  u32(rd.edgeLines !== false ? 1 : 0);
  u32(zones.length);
  for (const [s, half] of zones) { f32(s); f32(half); }
  for (const c of skyCols) u32(c);                // sky zenith/horizon/below (sRGB)
  u32(fogCol);
  u32(hillShape);
  u32(hillCols.length);
  for (const c of hillCols) u32(c);
  u32(boxes.length);
  for (const [s, lat] of boxes) { f32(s); f32(lat); }
  u32(pads.length);
  for (const [k, s, lat, a, b] of pads) { u32(k); f32(s); f32(lat); f32(a); f32(b); }
  u32((td.scenerySeeds || [0, 0])[0]);
  u32((td.scenerySeeds || [0, 0])[1]);
  f32(sc.density ?? 0);
  f32((sc.mix && sc.mix.tree) ?? 0);
  f32((sc.mix && sc.mix.bush) ?? 0);
  u32(scTrees.length);
  for (const [m, w, s0, s1] of scTrees) { u32(m); f32(w); f32(s0); f32(s1); }
  u32(scBush ? 1 : 0);
  if (scBush) { u32(scBush[0]); f32(scBush[1]); f32(scBush[2]); f32(scBush[3]); }
  for (const r of scRocks) u32(num(r, 0xaaaaaa));
  f32((sc.rockS || [0.3, 0.45])[0]);
  f32((sc.rockS || [0.3, 0.45])[1]);
  u32(scModels.length);
  u32((td.scenerySeeds || [0, 0, 0])[2]);
  u32(lmKinds.length);
  for (const k of lmKinds) u32(k);
  f32((sc.clutter && sc.clutter.density) || 0);
  u32(clKinds.length);
  for (const [k, w, tints] of clKinds) {
    u32(k); f32(w); u32(tints.length);
    for (const t of tints) u32(num(t, 0xffffff));
  }
  u32(oils.length);
  for (const [s, lat, r, cones] of oils) { f32(s); f32(lat); f32(r); u32(cones); }
  u32(poles.length);
  for (const [s, lat, r] of poles) { f32(s); f32(lat); f32(r); }
  u32(pillars.length);
  for (const p of pillars) for (const v of p) f32(v);
  u32(posts.length);
  for (const p of posts) for (const v of p) f32(v);
  u32(berms.length);
  for (const run of berms) { u32(run.length); for (const r of run) for (const v of r) f32(v); }
  u32(num(td.structure, 0x9aa1b4));               // support-structure tint
  for (const [tag, v] of T) { if (tag) f32(v); else u32(v); } // theme block
  for (const s of ss) {
    f32(s.pos.x); f32(s.pos.y); f32(s.pos.z);
    f32(s.lateral.x); f32(s.lateral.y); f32(s.lateral.z);
    f32(s.up.x); f32(s.up.y); f32(s.up.z);
    f32(s.width); f32(s.s);
  }
  return new Uint8Array(buf);
}

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
  fixture.drainEvents(); // v1 carries no events yet; drain so the buffer can't grow unbounded
  const cars = snap.cars;
  const boxes = snap.boxes || [];
  const bananas = snap.bananas || [];
  const rockets = snap.rockets || [];
  const bytes = HEADER_BYTES + cars.length * CAR_F32 * 4 + views.length * VIEW_F32 * 4
      + boxes.length * 4 + bananas.length * 8 + rockets.length * 8;
  ensureBuffer(bytes);
  // Views detach on wasm memory growth — re-derive per frame.
  const dv = new DataView(Module.HEAPU8.buffer, fiPtr, bytes);
  dv.setUint32(0, 8, true);            // TTP_FRAME_INPUT_VERSION
  dv.setFloat32(4, dt, true);
  dv.setUint32(8, cars.length, true);
  dv.setUint32(12, views.length, true);
  dv.setUint32(16, boxes.length, true);
  dv.setUint32(20, bananas.length, true);
  dv.setUint32(24, rockets.length, true);
  dv.setUint32(28, 0, true);           // flags (reserved)
  // The JS scene's env clock (_birdT): the phase source for every wall-clock
  // cosmetic, so both panes' boxes/clouds/balloon animate in the same phase.
  const sceneWin = document.getElementById('fixture-frame')?.contentWindow;
  dv.setFloat32(32, sceneWin?.__scene?._birdT ?? 0, true);
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
