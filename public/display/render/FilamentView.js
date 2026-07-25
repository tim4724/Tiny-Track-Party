// The native renderer as a drop-in for the Three.js one (?renderer=filament).
//
// SceneRenderer still owns the world: poses, chase cameras, cell layout, props.
// This just hands that state to libttp-renderer once per frame and lets Filament
// draw it. The HUD is untouched — it is DOM over the canvas, which is exactly
// why the HUD lives in the shell (docs/native-port/architecture.md).
//
// COST. There are two wasm modules in play (the sim and the renderer) and they
// do not share memory, so the frame state has to cross JS once. That crossing is
// kept as thin as it can be: one buffer, malloc'd once and grown only when the
// car/prop counts do, written through a Float32Array view with no per-frame
// allocation and no JSON. The snapshot itself is NOT extra cost — the display
// already reads it every frame for the HUD, audio and race logic.
//
// The endgame in the port plan is one module, where libttp-runtime steps the sim
// and calls the renderer in C++ and nothing crosses at all. This is the shape
// that gets there: everything below the submit() call is already the ABI.

const HEADER_F32 = 9;   // version, dt, 5 counts, flags, sceneT
const CAR_F32 = 16;
const VIEW_F32 = 22;

export class FilamentView {
  constructor(canvas) {
    this.canvas = canvas;
    this.mod = null;
    this.rt = 0;
    this._ptr = 0;
    this._cap = 0;
    this._built = false;
    this._sceneT = 0;
  }

  // Boot the module onto our own canvas. Filament owns that GL context, so it
  // cannot be the one three.js is holding — the caller gives us a second canvas
  // in the same container and hides three's.
  static async create(canvas) {
    const view = new FilamentView(canvas);
    const { default: createTtpModule } = await import('/native/ttp.js');
    view.mod = await createTtpModule();
    const sel = view.mod.stringToNewUTF8('#' + canvas.id);
    view.rt = view.mod._ttp_create(sel, canvas.width, canvas.height);
    view.mod._free(sel);
    if (!view.rt) throw new Error('ttp_create failed');
    for (const name of ['vcolor', 'vblend', 'vlit', 'vpoint']) {
      const res = await fetch(`/native/${name}.filamat`);
      if (res.ok) await view.provide(`${name}.filamat`, new Uint8Array(await res.arrayBuffer()));
    }
    return view;
  }

  async provide(name, bytes) {
    const m = this.mod;
    const ptr = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, ptr);
    const namePtr = m.stringToNewUTF8(name);
    const rc = m._ttp_provide_asset(this.rt, namePtr, ptr, bytes.length);
    m._free(namePtr);
    m._free(ptr);
    if (rc) throw new Error(`ttp_provide_asset(${name}) failed`);
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.rt) this.mod._ttp_resize(this.rt, w, h);
  }

  // Build (or REBUILD) the scene for a track. Every race start comes through
  // here — a Grand Prix chains four tracks, and even a restart wants the skid
  // ribbons, kicked cones and collected boxes back at their opening state.
  async setTrack(payload, assets) {
    const { buildTrackBin, resolveModelTint } = await import('/shared/trackBin.js');
    if (this._built) this.mod._ttp_release_scene(this.rt);
    this._built = false;
    this._sceneT = 0;

    // Scenery GLBs first: their authored material colours are what the biome's
    // tint map keys on, and each kit may want its own colormap texture.
    const scModels = [...new Set([...((payload.scenery || {}).trees || []).map((e) => e.model),
                                  ...((payload.scenery || {}).bush ? [payload.scenery.bush.model] : [])])];
    const scBytes = await Promise.all(scModels.map((m) => assets.glb(m)));
    payload.modelTints = scModels.map((m, i) => resolveModelTint(payload, m, scBytes[i]));
    await this.provide('track.bin', buildTrackBin(payload));
    await Promise.all(scBytes.map((b, i) => (b ? this.provide(`scenery${i}.glb`, b) : null)));
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
      if (bytes) await this.provide(uri, bytes);
    }));

    await Promise.all([
      ...(payload.roster || []).map(async (r, i) => {
        if (!r.model) return;
        const bytes = await assets.glb(r.model);
        if (!bytes) return;
        await this.provide(`car${i}.glb`, bytes);
        await this.provide(`car${i}-ghost.glb`, ghostGlb(bytes));
      }),
      ...['item-box', 'item-banana', 'item-cone', 'vehicle-monster-truck'].map(async (name) => {
        const bytes = await assets.glb(name);
        if (!bytes) return;
        await this.provide(`${name}.glb`, bytes);
        if (name === 'vehicle-monster-truck') await this.provide('monster-ghost.glb', ghostGlb(bytes));
      }),
    ]);
    if (this.mod._ttp_build_scene(this.rt)) throw new Error('ttp_build_scene failed');
    this._built = true;
  }

  // One frame. `cars` and `views` are read straight off SceneRenderer's own
  // per-car state, so nothing is recomputed here.
  submit(dt, cars, views, boxes, bananas, rockets) {
    if (!this._built) return;
    const m = this.mod;
    const f32 = (HEADER_F32 + cars.length * CAR_F32 + views.length * VIEW_F32
        + boxes.length + bananas.length * 2 + rockets.length * 2);
    const bytes = f32 * 4;
    if (bytes > this._cap) {
      if (this._ptr) m._free(this._ptr);
      this._cap = Math.max(bytes, 4096);
      this._ptr = m._malloc(this._cap);
    }
    this._sceneT += dt;
    // Views detach on memory growth, so re-derive them each frame (cheap: it is
    // a subarray over the module's existing heap, not a copy).
    const buf = m.HEAPU8.buffer; // the only heap view the module always exports
    const F = new Float32Array(buf, this._ptr, f32);
    const U = new Uint32Array(buf, this._ptr, f32);
    U[0] = 8;                 // TTP_FRAME_INPUT_VERSION
    F[1] = dt;
    U[2] = cars.length;
    U[3] = views.length;
    U[4] = boxes.length;
    U[5] = bananas.length;
    U[6] = rockets.length;
    U[7] = 0;                 // flags (reserved)
    F[8] = this._sceneT;
    let o = HEADER_F32;
    for (const c of cars) {
      const p = c.pose;
      F[o++] = p.pos.x; F[o++] = p.pos.y; F[o++] = p.pos.z;
      F[o++] = p.forward.x; F[o++] = p.forward.y; F[o++] = p.forward.z;
      F[o++] = p.up.x; F[o++] = p.up.y; F[o++] = p.up.z;
      F[o++] = c.spd; F[o++] = c.steer; F[o++] = c.brake ? 1 : 0; F[o++] = c.boostMul || 1;
      F[o++] = c.monster ? 1 : 0;
      F[o++] = c.spin || 0; F[o++] = c.onWall ? 1 : 0;
    }
    for (const v of views) {
      const e = v.world;
      for (let i = 0; i < 16; i++) F[o++] = e[i];
      F[o++] = v.fov; F[o++] = v.aspect; F[o++] = v.near; F[o++] = v.far;
      F[o++] = v.fogNear; F[o++] = v.fogFar;
    }
    for (const b of boxes) U[o++] = b ? 1 : 0;
    for (const b of bananas) { F[o++] = b.s; F[o++] = b.lat || 0; }
    for (const r of rockets) { F[o++] = r.s; F[o++] = r.lat || 0; }
    m._ttp_submit_frame(this.rt, this._ptr);
  }

  // Re-present the LAST submitted frame, unchanged (dt 0, so nothing steps).
  // The buffer still holds it, so this costs one draw and no marshalling. Used
  // by SceneRenderer.snapshot(): a canvas readback only sees pixels while the
  // frame is still in the drawing buffer, i.e. in the task that drew it.
  repaint() {
    if (!this._built || !this._ptr) return false;
    new Float32Array(this.mod.HEAPU8.buffer, this._ptr, 2)[1] = 0; // dt
    return !!this.mod._ttp_submit_frame(this.rt, this._ptr);
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
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
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

// Fetch-and-cache for the GLBs/textures the renderer needs. The display already
// has these decoded for three.js, but the renderer wants the BYTES, and the
// browser cache means the second fetch is free.
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
