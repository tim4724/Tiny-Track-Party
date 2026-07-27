// track.bin — the scene-build payload the native renderer meshes from.
//
// Written once per race by the display's scene build, never per frame. Pure data
// in, bytes out — no DOM and no renderer — so it also runs in Node if a fixture
// ever needs to bake one.
//
// The layout is documented alongside the reader in TtpRenderer.cpp; the version
// at the head of the buffer is the contract between them, and both sides move
// together.


// Resolve a scenery model's biome recolour into per-MATERIAL colours.
// buildScenery bakes `tint` into vertex colours for UNTEXTURED models: a plain
// hex repaints the whole model, a map is keyed by each part's AUTHORED colour
// (a palm's fronds and trunk differ). gltfio names its material instances after
// the glTF material, so the native side can apply the same recolour by name —
// resolve the authored colours HERE, where the tint tables live.
export function resolveModelTint(td, model, bytes) {
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
    // factor is LINEAR; the theme keys are authored as sRGB hex.
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
export function buildTrackBin(td) {
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
  // Every authored rock colour, not a fixed three: the playroom's toy-bit
  // palette has four, and truncating dropped the green one entirely (the
  // scatter picks by index over the FULL list, so a short list also skews
  // every other colour's share).
  const scRocks = sc.rocks || [0xaaaaaa, 0xb4a898, 0x9aa2a4];
  const scBytes = 4 * 2 + 4 * 3 + 4 + scTrees.length * 16 + 4 + (scBush ? 16 : 0)
      + 4 + scRocks.length * 4 + 2 * 4 + 4;
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
  u32(15);                                        // TRACK_BIN_VERSION
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
  // Rear-plate height on this model's back panel (trackPayload's PLATE_Y
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
  u32(scRocks.length);
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
