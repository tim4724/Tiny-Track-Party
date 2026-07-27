// Display — the browser's edge of the native display ABI (native/runtime/
// ttp_display.h). Owns the canvas, feeds the renderer its assets, and drives
// one frame per rAF.
//
// There is nothing per-frame in this file but a dt, and that is the point. The
// sim and the renderer are the SAME wasm module, so `ttp_display_frame` reads
// the live Game in C++ and builds the renderer's frame in place. Nothing about
// a car — pose, speed, steer, which cell it owns — is ever serialized to JS to
// be handed back. What still crosses does so ONCE PER RACE, at scene build:
// the track payload and the GLB/texture bytes.
//
// The HUD is not here. It is DOM over the canvas (Stage.js), which is exactly
// why it lives in the shell and not the renderer.

import { loadNativeRuntime } from '../nativeRuntime.js';

// Camera modes for a surface with no split-screen cells — the C side's
// TTP_CAM_* (ttp_display.h).
export const CAM = { STILL: 0, ORBIT: 1, BBOX: 2, FREE: 3 };

const MATERIALS = ['vcolor', 'vblend', 'vlit', 'vpoint', 'vground', 'vdecal',
                   'vpresent', 'vesm', 'vblur', 'vburst'];

export class Display {
  constructor(canvas, mod) {
    this.canvas = canvas;
    this.m = mod;
    this.built = false;
    this._fn = {
      create: mod.cwrap('ttp_display_create', 'number', ['string', 'number', 'number']),
      asset: mod.cwrap('ttp_display_asset', 'number', ['string', 'number', 'number']),
      resize: mod.cwrap('ttp_display_resize', null, ['number', 'number']),
      build: mod.cwrap('ttp_display_build', 'number', ['string']),
      release: mod.cwrap('ttp_display_release', null, []),
      bind: mod.cwrap('ttp_display_bind', null, ['number']),
      cells: mod.cwrap('ttp_display_cells', null, ['string']),
      camera: mod.cwrap('ttp_display_camera', null, ['number']),
      look: mod.cwrap('ttp_display_look', null, ['number', 'number', 'number', 'number', 'number', 'number']),
      fog: mod.cwrap('ttp_display_fog', null, ['number']),
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

  // Build (or REBUILD) the scene for a track. Every race start comes through
  // here — a Grand Prix chains four tracks, and even a restart wants the skid
  // ribbons, kicked cones and collected boxes back at their opening state.
  //
  // `payload.roster` is in SLOT order, and the ids go across with it: the
  // renderer bakes each car's model and livery into its slot here, and every
  // later frame puts a car back in its own slot by identity.
  async setTrack(payload, assets) {
    const { buildTrackBin, resolveModelTint } = await import('/shared/trackBin.js');
    if (this.built) this._fn.release();
    this.built = false;

    // Scenery GLBs first: their authored material colours are what the biome's
    // tint map keys on, and each kit may want its own colormap texture.
    const scModels = [...new Set([...((payload.scenery || {}).trees || []).map((e) => e.model),
                                  ...((payload.scenery || {}).bush ? [payload.scenery.bush.model] : [])])];
    const scBytes = await Promise.all(scModels.map((m) => assets.glb(m)));
    payload.modelTints = scModels.map((m, i) => resolveModelTint(payload, m, scBytes[i]));
    this.provide('track.bin', buildTrackBin(payload));
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
      ...(payload.roster || []).map(async (r, i) => {
        if (!r.model) return;
        const bytes = await assets.glb(r.model);
        if (!bytes) return;
        this.provide(`car${i}.glb`, bytes);
        this.provide(`car${i}-ghost.glb`, ghostGlb(bytes));
      }),
      ...['item-box', 'item-banana', 'item-cone', 'vehicle-monster-truck'].map(async (name) => {
        const bytes = await assets.glb(name);
        if (!bytes) return;
        this.provide(`${name}.glb`, bytes);
        if (name === 'vehicle-monster-truck') this.provide('monster-ghost.glb', ghostGlb(bytes));
      })
    ]);

    const ids = JSON.stringify((payload.roster || []).map((r) => r.id));
    if (this._fn.build(ids)) throw new Error('ttp_display_build failed');
    this.built = true;
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

  camera(mode) { this._fn.camera(mode); }
  look(eye, target) { this._fn.look(eye.x, eye.y, eye.z, target.x, target.y, target.z); }
  fog(on) { this._fn.fog(on ? 1 : 0); }

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

  // Last frame's per-section wall clock, as { section: ms }.
  profile() {
    const ptr = this.m._ttp_display_profile();
    if (!ptr) return null;
    const names = this._fn.profileNames().split(',');
    const out = {};
    names.forEach((n, i) => { out[n] = this.m.HEAPF64[(ptr >> 3) + i]; });
    return out;
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
