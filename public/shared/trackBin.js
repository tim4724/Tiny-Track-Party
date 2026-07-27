// track.bin — the roster's liveries, and nothing else.
//
// This file has been shrinking for two versions, and what is gone from it says
// more than what is left. Up to v15 it serialized the whole built track, which
// meant the browser ran a second implementation of the track builder on every
// race purely to feed the renderer; v16 dropped that (the renderer meshes from
// the ttp::RaceTrack the sim is racing on) and carried the resolved biome
// instead. v17 drops the biome too: the palette is C++ data now
// (native/libttp-runtime/ttp/theme.h), resolved from the track's own cup inside
// ttp_display_build, so the look is authored once for three shells rather than
// once per shell.
//
// What is left is the only part the SHELL genuinely knows: who is in this race
// and what their cars look like. Written once per race by the display's scene
// build, never per frame. Pure data in, bytes out — no DOM and no renderer.
//
// The layout is documented alongside the reader in TtpRenderer.cpp; the version
// at the head of the buffer is the contract between them, and both sides move
// together.

// Per-model plate height (world Y on the rear face), indexed by CAR_MODELS
// position. Hand-tuned per model so the rear name plate sits on each car's flat
// rear surface; the renderer can't raycast for it the way a scene graph could.
// Order: racer, speedster, racer-low, vintage-racer.
const PLATE_Y = [0.157, 0.245, 0.156, 0.134];

// The renderer's slot record for one car: its livery, its rear name plate, and
// which GLB to dress it in. The roster is in SLOT order, and the renderer bakes
// each entry into its slot at build time — which is what lets every later frame
// put a car back in ITS slot by identity rather than by position in some
// separately maintained list.
export function rosterEntry(id, name, carIndex, color, models) {
  const list = models || [];
  return {
    id, name, carIndex, color,
    plateY: PLATE_Y[carIndex % PLATE_Y.length] ?? null,
    model: list[carIndex % (list.length || 1)] || null,
  };
}

// "track.bin" v17: the roster's liveries. Binary — no JSON in C++.
export function buildTrackBin(roster) {
  const rs = roster || [];
  const totalBytes = 8 + rs.length * 16;
  const buf = new ArrayBuffer(totalBytes);
  const dv = new DataView(buf);
  let o = 0;
  const u32 = (v) => { dv.setUint32(o, v, true); o += 4; };
  const f32 = (v) => { dv.setFloat32(o, v, true); o += 4; };
  u32(17);                                        // TRACK_BIN_VERSION
  u32(rs.length);
  for (const r of rs) {                           // '#rrggbb' → ABGR u32
    const n = parseInt((r.color || '#888888').slice(1), 16);
    u32(0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16));
  }
  for (const r of rs) {                           // name, 8 ASCII bytes (rear plates)
    const name = String(r.name || ''); // as authored — the plate face is mixed case
    for (let i = 0; i < 8; i++) {
      dv.setUint8(o, i < name.length ? name.charCodeAt(i) & 0x7f : 0); o += 1;
    }
  }
  // Rear-plate height on this model's back panel; < 0 = fall back to the fixed
  // fraction of the body's height.
  for (const r of rs) f32(r.plateY == null ? -1 : r.plateY);
  if (o !== totalBytes) throw new Error(`track.bin: wrote ${o} of ${totalBytes} bytes`);
  return new Uint8Array(buf);
}
