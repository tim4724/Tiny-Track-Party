// Display — the browser's edge of the native display ABI (native/runtime/
// ttp_display.h). Owns the canvas, feeds the renderer its assets, and drives
// one frame per rAF.
//
// There is nothing per-frame in this file but a dt, and that is the point. The
// sim and the renderer are the SAME wasm module, so `ttp_display_frame` reads
// the live Game in C++ and builds the renderer's frame in place. Nothing about
// a car — pose, speed, steer, which cell it owns — is ever serialized to JS to
// be handed back. What still crosses does so ONCE PER RACE, at scene build, and
// it is now only a track ID, a biome NAME, the roster's liveries and the
// GLB/texture bytes those name — the geometry and the palette are both resolved
// on the far side.
//
// Almost none of the HUD is here. It is DOM over the canvas (Stage.js), which
// is exactly why it lives in the shell and not the renderer. The two exceptions
// are the STEER BAR and the CELL DIVIDERS: cell-anchored and textless, so they
// need none of the UI toolkit the rest of the HUD is written against and must
// not be laid out a second time. Everything crossing for them is here —
// uiScale, cellCards, dividers — and it is three latched setters, not a stream.

import { loadNativeRuntime } from '../nativeRuntime.js';
import { loadBiomes } from '../../shared/biomes.js';
import { ITEM_IDS } from '../engine/contract.js';

// Camera modes for a surface with no split-screen cells — the C side's
// TTP_CAM_* (ttp_display.h).
export const CAM = { STILL: 0, ORBIT: 1, BBOX: 2, FREE: 3 };

const MATERIALS = ['vcolor', 'vblend', 'vlit', 'vpoint', 'vground', 'vdecal',
                   'vpresent', 'vesm', 'vblur', 'vburst', 'voverlay'];

// The GLBs every scene needs whatever the track and the biome are: the track's
// own furniture, and the truck a monster item turns a car into. Exported because
// it is also the honest answer to "what does the game draw?" — the asset gallery
// lists it rather than keeping a second copy that could fall behind this one.
// (The scenery models are NOT here: those are the biome's, and C++ names them.)
export const PROP_MODELS = ['item-box', 'item-banana', 'item-cone', 'vehicle-monster-truck'];

// cellRects' "no cells" answer, so the caller's loop is the same shape either way.
const EMPTY_RECTS = new Float32Array(0);
// hud()'s, for the same reason.
const EMPTY_HUD = [];

// The packed HUD block (native/libttp-runtime/ttp_hud.h), as this reader needs
// it. Only the HEADER's size is written down: the SLOT's comes out of the block
// itself (`stride`), which is why it is carried — a decoder that baked in a
// sizeof would silently misread every slot after the day a field was added.
const HUD_VERSION = 1;       // TTP_HUD_BLOCK_VERSION
const HUD_HEADER_BYTES = 16; // sizeof(TtpHudBlock): version, slotCount, stride, flags
// finishTime's byte offset INSIDE a slot. Hardcoded where the slot's size is
// not, and the asymmetry is the point: `stride` covers a slot growing at the
// end, which is the change a block can absorb; anything moving a field this
// reader already knows bumps TTP_HUD_BLOCK_VERSION, which the guard below sees.
const HUD_SLOT_TIME = 24;
const HUD_LIVE = 1;          // TTP_HUD_SLOT_LIVE
const HUD_FINISHED = 2;      // TTP_HUD_SLOT_FINISHED
const HUD_TIMED = 4;         // TTP_HUD_SLOT_TIMED

// A held item crosses as a CODE (TTP_ITEM_*), not a string: the index in the
// sim's own roll table plus one, so 0 can mean "empty" without a sentinel that
// looks like an item. ITEM_IDS is the browser's mirror of that table, and
// tests/display-abi.test.js holds it to ttp_item_id in the shipped wasm so the
// two cannot drift apart.
//
// TTP_ITEM_UNKNOWN (-1) folds to null HERE, and only here: this block feeds the
// DRAWN slot, and a shell with no icon for an item draws an empty square. The
// phone's ITEM message — which must not call an occupied slot empty — is not
// sourced from this block.
function itemId(code) {
  return code >= 1 && code <= ITEM_IDS.length ? ITEM_IDS[code - 1] : null;
}

export class Display {
  constructor(canvas, mod) {
    this.canvas = canvas;
    this.m = mod;
    this.built = false;
    this._rectPtr = 0;       // cellRects' heap scratch, grown on demand
    this._rectBytes = 0;
    this._showcase = false;  // the asset gallery's showroom; see showcase()
    // The roster ids handed to ttp_display_build, in SLOT order. The HUD block
    // comes back indexed by slot and carries no car id (ttp_hud.h's slot
    // identity note), so this list — the one this class authored — is what maps
    // an entry back to a car. Empty whenever no scene is built, which is exactly
    // when C++ has no roster either.
    this._rosterIds = [];
    this._fn = {
      create: mod.cwrap('ttp_display_create', 'number', ['string', 'number', 'number']),
      asset: mod.cwrap('ttp_display_asset', 'number', ['string', 'number', 'number']),
      resize: mod.cwrap('ttp_display_resize', null, ['number', 'number']),
      build: mod.cwrap('ttp_display_build', 'number', ['string', 'string']),
      biome: mod.cwrap('ttp_display_biome', null, ['string']),
      showcase: mod.cwrap('ttp_display_showcase', null, ['number']),
      modelVariant: mod.cwrap('ttp_display_model_variant', null, ['string', 'number']),
      bench: mod.cwrap('ttp_display_bench', null, ['string']),
      release: mod.cwrap('ttp_display_release', null, []),
      bind: mod.cwrap('ttp_display_bind', null, ['number']),
      cells: mod.cwrap('ttp_display_cells', null, ['string']),
      cellRects: mod.cwrap('ttp_display_cell_rects', 'number', ['number', 'number']),
      cellCards: mod.cwrap('ttp_display_cell_cards', null, ['number']),
      dividers: mod.cwrap('ttp_display_dividers', null, ['number']),
      uiScale: mod.cwrap('ttp_display_ui_scale', null, ['number']),
      camera: mod.cwrap('ttp_display_camera', null, ['number']),
      look: mod.cwrap('ttp_display_look', null, ['number', 'number', 'number', 'number', 'number', 'number']),
      fog: mod.cwrap('ttp_display_fog', null, ['number']),
      shadows: mod.cwrap('ttp_display_shadows', null, ['number']),
      hold: mod.cwrap('ttp_display_hold', null, ['number']),
      frame: mod.cwrap('ttp_display_frame', 'number', ['number']),
      burst: mod.cwrap('ttp_display_burst', null, ['string', 'number', 'number']),
      profileNames: mod.cwrap('ttp_display_profile_names', 'string', [])
    };
  }

  // Boot the renderer onto `canvas`. Filament takes that canvas's WebGL2
  // context for the life of the page, so it must be a canvas nothing else
  // draws to.
  static async create(canvas) {
    const mod = await loadNativeRuntime();
    if (typeof mod._ttp_display_create !== 'function') {
      throw new Error('the runtime module was built without the renderer — '
          + 'rebuild with native/scripts/build-runtime-web.sh');
    }
    const d = new Display(canvas, mod);
    if (!d._fn.create('#' + canvas.id, canvas.width, canvas.height)) {
      throw new Error('ttp_display_create failed (no WebGL2 context?)');
    }
    await Promise.all(MATERIALS.map(async (name) => {
      const res = await fetch(`/display/engine/native/${name}.filamat`);
      if (res.ok) d.provide(`${name}.filamat`, new Uint8Array(await res.arrayBuffer()));
    }));
    return d;
  }

  // Hand the renderer an asset's bytes. The name marshals through cwrap; the
  // bytes go through the heap, since cwrap has no array type — the renderer
  // copies them before this returns, so the scratch is freed immediately.
  provide(name, bytes) {
    const m = this.m;
    const ptr = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, ptr);
    const rc = this._fn.asset(name, ptr, bytes.length);
    m._free(ptr);
    if (rc) throw new Error(`ttp_display_asset(${name}) failed`);
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this._fn.resize(w, h);
  }

  // Build every scene from here on as the ASSET GALLERY's showroom: the picked
  // biome's palette carrying every biome's vocabulary (ttp_display_showcase).
  // Latched, and set before setTrack — it changes both what the build resolves
  // and which scenery bytes this class has to fetch.
  showcase(on) {
    this._showcase = on !== false;
    this._fn.showcase(this._showcase ? 1 : 0);
  }

  // DEV. Which take on a procedural prop ("rocket" | "gnome" | "train") later
  // scenes are meshed with, and the asset gallery's MODEL BENCH — every variant
  // of one prop in a row instead of the usual landmarks. Variant 0 ships, and a
  // null/"" bench is the normal scene, so leaving both alone is the status quo.
  // Latched like showcase(): they change what the next setTrack meshes.
  modelVariant(model, variant) { this._fn.modelVariant(model, variant | 0); }
  bench(model) { this._fn.bench(model || ''); }

  // Build (or REBUILD) the scene for a track. Every race start comes through
  // here — a Grand Prix chains four tracks, and even a restart wants the skid
  // ribbons, kicked cones and collected boxes back at their opening state.
  //
  // A track ID and a BIOME NAME, not a scene description. The geometry is built
  // C++-side from the id (the same ttp::RaceTrack a session on it races on) and
  // the palette is resolved C++-side from the name, so what this method
  // actually does is FETCH: the GLBs and textures the two of them name, which
  // is the one part of a scene build that is a platform job.
  //
  // `roster` is in SLOT order, and the ids go across with it: the renderer bakes
  // each car's model and livery into its slot here, and every later frame puts a
  // car back in its own slot by identity.
  async setTrack(trackId, biome, roster, assets) {
    if (this.built) this._fn.release();
    this.built = false;
    // Released, so C++ holds no roster either: the two lists go empty together
    // and the HUD reads as "nothing to say yet" for the length of the rebuild,
    // rather than mapping this race's slots onto last race's ids.
    this._rosterIds = [];
    // The look, before anything is fetched: the scenery model list is a
    // function of it, and so is the scene the build call will produce.
    this._fn.biome(biome);

    // Scenery GLBs, in the slot order C++ named them in: the renderer binds its
    // instanced props by that index, and the biome's recolour — which keys on
    // each model's own authored material colours — reads these same bytes back
    // out on the C++ side.
    //
    // In SHOWCASE mode the list is the union of every biome's (the same one for
    // all of them, which is why it takes no biome argument) — see showcase().
    const biomes = await loadBiomes();
    const scModels = this._showcase ? biomes.showcaseModels() : biomes.sceneryModels(biome);
    const scBytes = await Promise.all(scModels.map((m) => assets.glb(m)));
    scBytes.forEach((b, i) => { if (b) this.provide(`scenery${i}.glb`, b); });

    const texUris = new Set();
    for (const bytes of scBytes) {
      if (!bytes) continue;
      try {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
        for (const img of json.images || []) if (img.uri) texUris.add(img.uri);
      } catch { /* an unparseable model just renders untextured */ }
    }
    texUris.add('Textures/colormap.png'); // the toy-car kit's shared palette
    await Promise.all([...texUris].map(async (uri) => {
      const bytes = await assets.raw(`/assets/toycar/${uri}`);
      if (bytes) this.provide(uri, bytes);
    }));

    await Promise.all([
      ...(roster || []).map(async (r, i) => {
        if (!r.model) return;
        const bytes = await assets.glb(r.model);
        if (!bytes) return;
        this.provide(`car${i}.glb`, bytes);
        this.provide(`car${i}-ghost.glb`, ghostGlb(bytes));
      }),
      ...PROP_MODELS.map(async (name) => {
        const bytes = await assets.glb(name);
        if (!bytes) return;
        this.provide(`${name}.glb`, bytes);
        if (name === 'vehicle-monster-truck') this.provide('monster-ghost.glb', ghostGlb(bytes));
        // A BLEND clone of the box, for the collect fade. The kit material is
        // OPAQUE, so the solid instance cannot be faded at all — the renderer
        // hands the grab over to this one and ramps its alpha down. ghostGlb's
        // 0.5 never shows: the renderer writes the alpha on every frame a box
        // is dissolving, and parks these instances the rest of the time.
        if (name === 'item-box') this.provide('item-box-fade.glb', ghostGlb(bytes));
      })
    ]);

    // The roster goes across whole — id, name, carIndex and livery, in slot
    // order. `model` stays here: it named the GLBs fetched above, which is the
    // only part of a slot this side has any business knowing. Everything else
    // about it (the livery's ABGR word, the name plate's 8 chars, how high that
    // plate sits on this model's back panel) is decided by ttp/roster.h — it
    // used to be a byte buffer this file packed by hand.
    const ids = (roster || []).map((r) => r.id);
    const slots = (roster || []).map((r) => ({
      id: r.id, name: r.name || '', carIndex: r.carIndex ?? 0, color: r.color || ''
    }));
    if (this._fn.build(trackId, JSON.stringify(slots))) throw new Error(`ttp_display_build(${trackId}) failed`);
    this._rosterIds = ids; // slot i is this car, for the HUD readback
    this.built = true;
  }

  release() {
    if (!this.built) return;
    this._fn.release();
    this._rosterIds = [];
    this.built = false;
  }

  // The session whose cars get drawn (0 = an empty track, which is what the
  // lobby's preview is before the attract race starts).
  bind(session) { this._fn.bind(session | 0); }

  // The cars that own a split-screen cell, in cell order. Empty = one overview
  // camera over the whole surface.
  cells(ids) { this._fn.cells(JSON.stringify(ids || [])); }

  // WHERE those cells are, as a flat [x, y, w, h, x, y, w, h, …] in cell order —
  // the rects the renderer splits its own viewports into, read back rather than
  // recomputed here (the shell has no opinion on split-screen layout any more).
  //
  // Values are DRAWING-BUFFER pixels, like every other number this class passes
  // (resize, create); the caller scales to CSS pixels, since the DPR is its own.
  // Packed floats over JSON because the HUD reads this every frame: one cwrap
  // call and a heap read, no parse and no garbage. The returned array is a VIEW
  // over a scratch buffer reused by the next call — read it now, don't keep it.
  cellRects(maxCells) {
    const n = Math.max(0, maxCells | 0);
    if (!n) return EMPTY_RECTS;
    const bytes = n * 4 * 4; // 4 floats per cell
    if (!this._rectPtr || this._rectBytes < bytes) {
      if (this._rectPtr) this.m._free(this._rectPtr);
      this._rectPtr = this.m._malloc(bytes);
      this._rectBytes = bytes;
    }
    const got = this._fn.cellRects(this._rectPtr, n);
    // HEAPF32 is re-read every call: ALLOW_MEMORY_GROWTH swaps the buffer out
    // from under any view held across an allocation.
    return this.m.HEAPF32.subarray(this._rectPtr >> 2, (this._rectPtr >> 2) + got * 4);
  }

  // WHAT the HUD says: place, lap, total laps, the held item, finished and the
  // finish time, per car — read out of the packed block ttp_display_hud points
  // at (ttp_hud.h) rather than out of a serialized race state. Those six values
  // used to cost a JSON.stringify of the whole field in C++ and a JSON.parse of
  // it here, every one of which was thrown away but these.
  //
  // A READ, not a frame: since the steer bar moved into the renderer nothing in
  // the HUD changes faster than a place does, so the shell calls this at its own
  // ~6 Hz cadence. Rows come back in the shape uiModel.hudRows used to produce
  // — that function is now the CORPUS ORACLE only, and this is the runtime path.
  //
  // A slot no live car claims is SKIPPED rather than reported as zeroes, so a
  // Grand Prix swapping tracks underneath the HUD (or the async gap between a
  // field change and the scene rebuild that lands it) leaves each cell's chrome
  // alone instead of painting it "0th, lap 0".
  hud() {
    const ptr = this.m._ttp_display_hud();
    if (!ptr) return EMPTY_HUD;
    // Both views are re-read every call, for cellRects' reason: memory growth
    // detaches any view held across an allocation.
    const u32 = this.m.HEAPU32;
    const i32 = this.m.HEAP32;
    const head = ptr >> 2;
    if (u32[head] !== HUD_VERSION) {
      // Unreachable while the wasm and this file ship in one repo, which is why
      // it is a one-shot log and an empty HUD rather than a throw on a polling
      // path: a stale checked-in artifact should be legible, not a stack trace
      // six times a second.
      if (!this._hudVersionLogged) {
        this._hudVersionLogged = true;
        console.error(`[display] HUD block v${u32[head]}, expected v${HUD_VERSION} —`
            + ' rebuild with native/scripts/build-runtime-web.sh');
      }
      return EMPTY_HUD;
    }
    const count = u32[head + 1];
    const stride = u32[head + 2];
    const rows = [];
    for (let i = 0; i < count; i++) {
      const id = this._rosterIds[i];
      if (id === undefined) continue; // a slot this side never named: nothing to paint
      const off = ptr + HUD_HEADER_BYTES + i * stride;
      const at = off >> 2;
      const flags = u32[at + 4];
      if (!(flags & HUD_LIVE)) continue;
      rows.push({
        id,
        position: i32[at],
        lap: i32[at + 1],
        totalLaps: i32[at + 2],
        item: itemId(i32[at + 3]),
        finished: !!(flags & HUD_FINISHED),
        // The JSON null distinction, kept: a car can be finished with no
        // recorded time (a forfeit resolved at the flag), and the card prints an
        // empty string for that rather than "0.0s".
        finishTime: (flags & HUD_TIMED) ? this.m.HEAPF64[(off + HUD_SLOT_TIME) >> 3] : null
      });
    }
    return rows;
  }

  // Physical pixels per CSS pixel — devicePixelRatio, capped by Stage. The
  // renderer needs it for the one thing it draws whose size is authored in the
  // UI's units rather than the world's: the steer bar (34 CSS px tall, 4 px
  // border). Points on tvOS and density on Android are the same idea, which is
  // why this number can cross where a CSS pixel could not.
  uiScale(k) { this._fn.uiScale(k); }

  // Which cells have a centred card over them (bit i = cell i), which is where
  // the steer bar must not be. The card itself stays in the DOM — it carries
  // type — so this is one bit per cell, not a description of it.
  cellCards(mask) { this._fn.cellCards(mask >>> 0); }

  // The ink rules on the split-screen seams (?dividers=0 turns them off).
  dividers(on) { this._fn.dividers(on ? 1 : 0); }

  camera(mode) { this._fn.camera(mode); }
  look(eye, target) { this._fn.look(eye.x, eye.y, eye.z, target.x, target.y, target.z); }
  fog(on) { this._fn.fog(on ? 1 : 0); }

  // The sun's baked shadow map, from the next setTrack onwards. Only the E2E
  // suite turns it off (Stage.js, on navigator.webdriver): the bake is a heavy
  // one-off frame under software GL, and no test looks at a shadow.
  shadows(on) { this._fn.shadows(on ? 1 : 0); }

  // Hold the field where it is, at rest — the pause overlay and the end-of-race
  // fast-forward, where the engine's live state is not what should be on screen.
  hold(on) { this._fn.hold(on ? 1 : 0); }

  // One frame. Returns false when the renderer skipped it and the canvas still
  // holds the previous one.
  frame(dt) { return !!this._fn.frame(dt); }

  // Re-present the LAST frame unchanged (dt 0 steps nothing and fires no queued
  // burst). Used by the lobby crossfade's still capture: a canvas readback only
  // sees pixels while the frame is still in the drawing buffer, i.e. in the task
  // that drew it.
  repaint() { return this.built && this.frame(0); }

  // A rocket detonation, drawn on the next frame. The renderer cannot infer it:
  // a rocket that HIT a car detonates ON that car and rides it out, while a
  // whiff self-destructs at a track point.
  burstOn(id) { this._fn.burst(JSON.stringify(id), 0, 0); }
  burstAt(s, lat) { this._fn.burst(null, s, lat); }

  // The profile's section names, fixed for the life of the module and so
  // marshalled across once: profileTotal() runs every frame while the perf HUD
  // is up, and cwrap would rebuild the string on each call.
  _profileNames() {
    return this._profNames || (this._profNames = this._fn.profileNames().split(','));
  }

  // Last frame's per-section wall clock, as { section: ms }.
  profile() {
    const ptr = this.m._ttp_display_profile();
    if (!ptr) return null;
    const out = {};
    this._profileNames().forEach((n, i) => { out[n] = this.m.HEAPF64[(ptr >> 3) + i]; });
    return out;
  }

  // Just the frame total, in ms — one heap read, no object. This is the CPU cost
  // of building and submitting the frame; what the GPU then does with it is a
  // different (larger) number, which is why the perf HUD shows both.
  profileTotal() {
    const ptr = this.m._ttp_display_profile();
    if (!ptr) return null;
    const i = this._profileNames().indexOf('total');
    return i < 0 ? null : this.m.HEAPF64[(ptr >> 3) + i];
  }
}

// A 50%-alpha clone of a GLB, for the monster's occlusion fade. GLB layout:
// 12-byte header, then chunks (JSON first).
function ghostGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  for (const mat of json.materials || []) {
    mat.alphaMode = 'BLEND';
    mat.doubleSided = false;
    const pbr = (mat.pbrMetallicRoughness = mat.pbrMetallicRoughness || {});
    const f = pbr.baseColorFactor || [1, 1, 1, 1];
    pbr.baseColorFactor = [f[0], f[1], f[2], 0.5];
  }
  // Pad the chunk to a 4-byte boundary, measured in BYTES rather than UTF-16
  // units — a non-ASCII material name encodes wider than it measures, and a
  // misaligned JSON chunk makes cgltf reject the whole file.
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  if (jsonBytes.length % 4) {
    const padded = new Uint8Array(jsonBytes.length + 4 - (jsonBytes.length % 4));
    padded.set(jsonBytes);
    padded.fill(0x20, jsonBytes.length); // trailing spaces, per the GLB spec
    jsonBytes = padded;
  }
  const rest = bytes.subarray(20 + jsonLen);
  const out = new Uint8Array(20 + jsonBytes.length + rest.length);
  out.set(bytes.subarray(0, 12), 0);
  const odv = new DataView(out.buffer);
  odv.setUint32(8, out.length, true);
  odv.setUint32(12, jsonBytes.length, true);
  odv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  out.set(rest, 20 + jsonBytes.length);
  return out;
}

// Fetch-and-cache for the GLBs and textures the renderer needs. It wants the
// BYTES — nothing in the browser decodes a model any more.
export function assetCache() {
  const cache = new Map();
  const raw = async (url) => {
    if (cache.has(url)) return cache.get(url);
    const p = fetch(url).then((r) => (r.ok ? r.arrayBuffer().then((b) => new Uint8Array(b)) : null));
    cache.set(url, p);
    return p;
  };
  return { raw, glb: (name) => raw(`/assets/toycar/${name}.glb`) };
}
