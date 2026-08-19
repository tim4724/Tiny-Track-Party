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
// cellCards and dividers — and it is two latched setters, not a stream. No size
// crosses: both size themselves off the cell, which C++ already owns.

import { loadNativeRuntime, nativeError } from '../nativeRuntime.js';
import { loadBiomes } from '../../shared/biomes.js';
import { assetUrl } from '../../shared/assetUrl.js';
import { ITEM_IDS } from '../engine/contract.js';

// Camera modes for a surface with no split-screen cells — the C side's
// TTP_CAM_* (ttp_display.h).
export const CAM = { STILL: 0, ORBIT: 1, BBOX: 2, FREE: 3 };

// Feature-ablation bits for debugFeatures() — the C side's TTP_FEAT_*
// (ttp_display.h). DEBUG ONLY: the per-feature GPU cost map's instrument.
export const FEAT = {
  ROAD: 0x04, TERRAIN: 0x08, DRESSING: 0x10,
  SKY: 0x20, CARS: 0x40, EFFECTS: 0x80,
  // The road shader's own channels — these shade the same deck one channel
  // shorter rather than hiding anything.
  ROAD_DECALS: 0x100, ROAD_RUBBER: 0x200, ROAD_PAINT: 0x400, ROAD_SHADOW: 0x800,
  FOG: 0x1000,
  ALL: 0x1FFC,
};

// `vskid` is GONE with `vdecal`, same story: the rubber layer is a CPU
// raster + upload now (TtpRenderer::renderSkids), so there is no stamp
// material to serve.
const MATERIALS = ['vcolor', 'vblend', 'vlit', 'vlitns', 'vroad', 'vglb', 'vglbfade',
                   'vpoint', 'vcloud', 'vground', 'vvis', 'vpresent', 'vesm', 'vblur',
                   'vburst', 'voverlay'];

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
    this._kitModels = [];    // …and its kit field; see kitField()
    // No slot→car-id list here anymore: the HUD block is indexed by slot and
    // hud() maps entries back to cars via ttp_display_slot_ids_json — the
    // built scene's OWN roster, not a copy this class authors.
    this._fn = {
      create: mod.cwrap('ttp_display_create', 'number', ['string', 'number', 'number']),
      asset: mod.cwrap('ttp_display_asset', 'number', ['string', 'number', 'number']),
      resize: mod.cwrap('ttp_display_resize', null, ['number', 'number']),
      scaleStep: mod.cwrap('ttp_display_scale_step', 'number',
                           ['number', 'number', 'number', 'number', 'number', 'number',
                            'number', 'number', 'number']),
      presentFloor: mod.cwrap('ttp_display_present_floor', 'number', ['number', 'number']),
      build: mod.cwrap('ttp_display_build', 'number', ['string', 'string']),
      reroster: mod.cwrap('ttp_display_reroster', 'number', ['string']),
      debugDecals: mod.cwrap('ttp_display_debug_decals', 'string', []),
      debugHideCars: mod.cwrap('ttp_display_debug_hide_cars', null, ['number']),
      debugWipeSkids: mod.cwrap('ttp_display_debug_wipe_skids', null, []),
      debugForceMaskLayer: mod.cwrap('ttp_display_debug_force_mask_layer', null, ['number']),
      debugFeatures: mod.cwrap('ttp_display_debug_features', null, ['number']),
      biome: mod.cwrap('ttp_display_biome', null, ['string']),
      showcase: mod.cwrap('ttp_display_showcase', null, ['number']),
      modelVariant: mod.cwrap('ttp_display_model_variant', null, ['string', 'number']),
      bench: mod.cwrap('ttp_display_bench', null, ['string']),
      kitField: mod.cwrap('ttp_display_kit_field', null, ['number']),
      kitLayout: mod.cwrap('ttp_display_kit_field_layout', 'string', []),
      release: mod.cwrap('ttp_display_release', null, []),
      bind: mod.cwrap('ttp_display_bind', null, ['number']),
      cells: mod.cwrap('ttp_display_cells', null, ['string']),
      cellRects: mod.cwrap('ttp_display_cell_rects', 'number', ['number', 'number']),
      cellCards: mod.cwrap('ttp_display_cell_cards', null, ['number']),
      slotIds: mod.cwrap('ttp_display_slot_ids_json', 'string', []),
      dividers: mod.cwrap('ttp_display_dividers', null, ['number']),
      camera: mod.cwrap('ttp_display_camera', null, ['number']),
      look: mod.cwrap('ttp_display_look', null, ['number', 'number', 'number', 'number', 'number', 'number']),
      fog: mod.cwrap('ttp_display_fog', null, ['number']),
      shadows: mod.cwrap('ttp_display_shadows', null, ['number']),
      hold: mod.cwrap('ttp_display_hold', null, ['number']),
      frame: mod.cwrap('ttp_display_frame', 'number', ['number']),
      burst: mod.cwrap('ttp_display_burst', null, ['string', 'number', 'number']),
      profileNames: mod.cwrap('ttp_display_profile_names', 'string', []),
      // The two GLB container reads (native/runtime/ttp_glb.h). They were JS
      // right here until the shells stopped being one: deriving a translucent
      // clone and listing a model's texture URIs names no platform API, so by
      // the placement rule they belong where all three shells reach them. The
      // ghost's chunk padding in particular is a trap that stays invisible until
      // cgltf rejects a whole model, and it is not worth having three times.
      glbGhost: mod.cwrap('ttp_glb_ghost', 'number', ['number', 'number', 'number']),
      glbImageUris: mod.cwrap('ttp_glb_image_uris', 'string', ['number', 'number'])
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
      const res = await fetch(assetUrl(`/display/engine/native/${name}.filamat`));
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
    const ok = this._fn.asset(name, ptr, bytes.length);
    m._free(ptr);
    if (!ok) throw new Error(`ttp_display_asset(${name}) failed`);
  }

  // Run `bytes` through one of the ttp_glb_* readers. Both take (ptr, len) and
  // answer out of C-owned scratch, so the shape is the same: copy in, call, copy
  // out before anything else can touch that buffer.
  _withGlb(bytes, fn) {
    const m = this.m;
    const ptr = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, ptr);
    try {
      return fn(ptr, bytes.length);
    } finally {
      m._free(ptr);
    }
  }

  // A 50%-alpha clone, for the fade instances (car ghosts, the monster's
  // occlusion twin, the item box's collect fade). Empty when the container is
  // unparseable, which the caller treats as "provide nothing" exactly as the old
  // try/catch did.
  _ghost(bytes) {
    return this._withGlb(bytes, (ptr, len) => {
      const m = this.m;
      const lenPtr = m._malloc(4);
      try {
        const out = this._fn.glbGhost(ptr, len, lenPtr);
        const n = m.HEAPU32[lenPtr >> 2];
        // slice(), not subarray(): the scratch is C-owned and the NEXT ghost
        // overwrites it, so a view would silently become the wrong model.
        return out ? m.HEAPU8.slice(out, out + n) : null;
      } finally {
        m._free(lenPtr);
      }
    });
  }

  // Every images[].uri the container references. These have to be provided
  // BEFORE the renderer parses the model, which is why they are read here rather
  // than asked of the loaded asset.
  _imageUris(bytes) {
    const json = this._withGlb(bytes, (ptr, len) => this._fn.glbImageUris(ptr, len));
    try {
      return JSON.parse(json || '[]');
    } catch {
      return [];
    }
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this._fn.resize(w, h);
  }

  // What scale to render at next, given what the last window of frames cost, and
  // the running fastest-present that feeds it. Both rules are C++'s
  // (ttp/render_scale.h) — this side measures and performs, and passes the
  // numbers over unjudged. See Stage._adaptScale.
  scaleStep(current, cost, sinceChangeSec, min, max) {
    return this._fn.scaleStep(current, cost.gpuShareP95, cost.gpuFrames, cost.presentP95Ms,
                              cost.presentFloorMs, cost.presentFrames, sinceChangeSec, min, max);
  }

  presentFloor(prevFloorMs, p05Ms) { return this._fn.presentFloor(prevFloorMs, p05Ms); }

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
  // of one prop in a row instead of the usual landmarks. Calling NEITHER is the
  // shipping scene: the picked variants are C++ defaults (TtpRenderer.h), and a
  // null/"" bench is the normal one. Latched like showcase(): they change what
  // the next setTrack meshes, not what a frame draws.
  modelVariant(model, variant) { this._fn.modelVariant(model, variant | 0); }
  bench(model) { this._fn.bench(model || ''); }

  // DEV. The asset gallery's KIT FIELD: the models to stand on clear ground
  // beyond the track, as GLB names this class fetches (`kit:<kit>/<model>` for
  // the kits the game does not ship, see assetCache). Held rather than pushed,
  // because unlike every other latch this one is a FETCH LIST — the bytes go
  // over as kit<i>.glb during setTrack, and the count only means anything once
  // they have. [] is no field, which is every caller but the gallery.
  kitField(models) { this._kitModels = Array.isArray(models) ? models : []; }

  // Where the built field put them, in the same order — footprint and spot per
  // model (ttp_display_kit_field_layout). [] until a build with a field in it.
  kitLayout() {
    try { return JSON.parse(this._fn.kitLayout()) || []; } catch (_) { return []; }
  }

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

    // Trackside prop GLBs (scattered set dressing): the same slot contract
    // one channel over, bound back as prop<i>.glb.
    const prModels = this._showcase ? biomes.showcasePropModels() : biomes.propModels(biome);
    const prBytes = await Promise.all(prModels.map((m) => assets.glb(m)));
    prBytes.forEach((b, i) => { if (b) this.provide(`prop${i}.glb`, b); });

    // The KIT FIELD's models (dev; empty in play). Fetched CONCURRENTLY because
    // there are hundreds of them — one await each would turn a field into a
    // minute of round trips — and provided in the order given, which is the
    // order the layout comes back in and the order the chrome names them by.
    const kitBytes = await Promise.all(this._kitModels.map((m) => assets.glb(m)));
    kitBytes.forEach((b, i) => { if (b) this.provide(`kit${i}.glb`, b); });
    this._fn.kitField(kitBytes.length);

    // An unparseable model answers with an empty list and just renders
    // untextured, which is what the try/catch here used to buy.
    const texUris = new Set();
    for (const bytes of [...scBytes, ...prBytes, ...kitBytes]) {
      if (bytes) for (const uri of this._imageUris(bytes)) texUris.add(uri);
    }
    texUris.add('Textures/colormap.png'); // the toy-car kit's shared palette
    await Promise.all([...texUris].map(async (uri) => {
      const bytes = await assets.raw(assetUrl(`/assets/toycar/${uri}`));
      if (bytes) this.provide(uri, bytes);
    }));

    await Promise.all([
      this._provideCars(roster, assets),
      ...PROP_MODELS.map(async (name) => {
        const bytes = await assets.glb(name);
        if (!bytes) return;
        this.provide(`${name}.glb`, bytes);
        // A BLEND clone of the box, for the collect fade. The kit material is
        // OPAQUE, so the solid instance cannot be faded at all — the renderer
        // hands the grab over to this one and ramps its alpha down. The clone's
        // baked 0.5 never shows: the renderer writes the alpha on every frame a
        // box is dissolving, and parks these instances the rest of the time.
        const ghostName = name === 'vehicle-monster-truck' ? 'monster-ghost.glb'
                        : name === 'item-box' ? 'item-box-fade.glb' : null;
        if (ghostName) {
          const ghost = this._ghost(bytes);
          if (ghost) this.provide(ghostName, ghost);
        }
      })
    ]);

    // The roster goes across whole — id, carIndex and livery, in slot order.
    // `model` stays here: it named the GLBs fetched above, which is the only
    // part of a slot this side has any business knowing. Everything else about
    // it (the livery's ABGR word) is decided by ttp/roster.h — it used to be a
    // byte buffer this file packed by hand.
    // The reason is the engine's: no surface, or a track this build does not have.
    if (!this._fn.build(trackId, JSON.stringify(this._slots(roster)))) throw nativeError(`building the scene for '${trackId}'`);
    this._slotIdCache = null; // a build is the one thing that can change slot ids
    this.built = true;
  }

  // Re-dress the BUILT scene's car slots in place (ttp_display_reroster): same
  // slots, new models/liveries. What earns it a second entry point is
  // everything setTrack would reset and this keeps — the scene meshes, the
  // baked shadows, the skid patina and the preview camera's orbit phase.
  // Whether the change IS a re-dress is C++'s decision; false means it was a
  // field change after all, and the caller performs the full setTrack.
  async reroster(roster, assets) {
    if (!this.built) return false;
    // Model swaps need their GLBs re-provided first — fetching is this side's
    // one job in the exchange, exactly as at build.
    await this._provideCars(roster, assets);
    // A re-dress keeps the id list by contract (C++ refuses id changes there),
    // so the slot-id cache stands; a refusal falls back to build, which clears it.
    return !!this._fn.reroster(JSON.stringify(this._slots(roster)));
  }

  // The per-slot car GLBs (and their 50%-alpha ghost twins), provided as
  // car<slot>.glb in roster order — the fetch half of both setTrack and
  // reroster. `model` names the file; it never crosses the ABI.
  _provideCars(roster, assets) {
    return Promise.all((roster || []).map(async (r, i) => {
      if (!r.model) return;
      const bytes = await assets.glb(r.model);
      if (!bytes) return;
      this.provide(`car${i}.glb`, bytes);
      const ghost = this._ghost(bytes);
      if (ghost) this.provide(`car${i}-ghost.glb`, ghost);
    }));
  }

  // A roster as the ABI takes it, in slot order (see setTrack on the split
  // between what crosses and what stays).
  _slots(roster) {
    return (roster || []).map((r) => ({
      id: r.id, carIndex: r.carIndex ?? 0, color: r.color || ''
    }));
  }

  release() {
    if (!this.built) return;
    this._fn.release();
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
    // Slot i's car id, off the built scene's own roster (the one owner —
    // this side used to keep a copy and a drifted index was silently skipped).
    // LATCHED per build: the list only changes when a scene is built (reroster
    // refuses id changes), so the ~6 Hz HUD poll must not re-parse JSON that
    // cannot have moved — that parse was the one JSON crossing left inside the
    // packed-readback path.
    const slotIds = this._slotIdCache || (this._slotIdCache = JSON.parse(this._fn.slotIds()));
    const rows = [];
    for (let i = 0; i < count; i++) {
      const id = slotIds[i];
      if (id === undefined) continue; // more block rows than roster: nothing to paint
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
  debugDecals() { return JSON.parse(this._fn.debugDecals() || '[]'); }
  // Decal isolation — see ttp_display.h. Hiding the bodies and wiping the laid
  // rubber is what makes a contact shadow readable at all; without it every
  // dark pixel near a car is one of three things.
  debugHideCars(on) { this._fn.debugHideCars(on ? 1 : 0); }
  debugWipeSkids() { this._fn.debugWipeSkids(); }
  debugForceMaskLayer(layer) { this._fn.debugForceMaskLayer(layer | 0); }
  // Feature ablation for the per-feature GPU cost map (TTP_FEAT_* in
  // ttp_display.h): a cleared bit hides that group of renderables, so the perf
  // HUD's timer reads what it was costing to draw. FEATURES names the bits so a
  // sweep script does not re-type them; DEBUG ONLY, nothing on a play path.
  debugFeatures(mask) { this._fn.debugFeatures(mask >>> 0); }

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
  const glb = (name) => {
    const kit = kitPath(name);
    return raw(kit ? assetUrl(kit) : assetUrl(`/assets/toycar/${name}.glb`));
  };
  return { raw, glb };
}

// DEV. `kit:<kit>/<model>` names a model from a Kenney kit the game does NOT
// ship — the asset gallery's kit browser stages candidates on the showroom grid,
// out of the local kit cache the server serves at /kits (npm run fetch:kits).
// It is spelled as a MODEL NAME because that is all a car slot's `model` is: the
// GLB to fetch, which never crosses the ABI, so nothing below this line — and
// nothing in C++ — can tell a candidate from a shipped car.
function kitPath(name) {
  const m = /^kit:([\w-]+)\/([\w.-]+)$/.exec(name);
  return m ? `/kits/${m[1]}/models/${m[2]}.glb` : null;
}
