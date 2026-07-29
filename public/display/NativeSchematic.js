// NativeSchematic — the display's edge of the track-map CODEC, which is C++.
//
// The display half of the track-map codec, backed by ttp_schematic_pack
// (and ttp_track_schematic_json for a shell with no baked maps) over
// native/libttp-track/ttp/schematic.cc.
//
// WHY ONLY THE PACK IS HERE. The codec has three parts and they belong in three
// different places:
//   * trackSchematic()   runs OFFLINE. scripts/gen-track-schematics.js bakes all
//                        20 maps into shared/trackSchematics.js, and the browser
//                        reads that bake — building 20 tracks at boot to redraw
//                        data that only changes when the game ships would be work
//                        for nothing. A tvOS shell with no bake calls
//                        ttp_track_schematic_json instead; the C++ is the same.
//   * packSchematic()    is the DISPLAY's, on every boot, and is what this file
//                        wraps: the reduced maps that ride the room snapshot.
//   * unpackSchematic()  is the PHONE's, and phones stay on the JS controller on
//                        all three TV platforms — so public/display/
//                        the shared codec keeps shipping to players and stays
//                        the oracle tests/fixtures/schematic-corpus.jsonl was
//                        recorded from.

import { loadNativeRuntime } from './nativeRuntime.js';

let fn = null;

export async function init() {
  if (fn) return;
  const M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    pack: c('ttp_schematic_pack', 'string', ['string', 'number']),
    schematic: c('ttp_track_schematic_json', 'string', ['string', 'number', 'number'])
  };
}

// Simplify + quantize + base64 a schematic path for the room snapshot. `eps` is
// the RDP tolerance in viewBox units; omit it for the tuned default (0.35 —
// chosen so straights reproduce and corners do not clip, not just for size).
export function pack(d, eps = 0) {
  return fn.pack(d || '', eps);
}

// The full map for a track, built natively. Not on the browser's boot path (see
// the header) — this is here so the ABI has a JS caller at all, and for any tool
// that wants the map without the bake.
export function schematic(trackId, laps = 3, seed = 1) {
  const json = fn.schematic(trackId, laps, seed);
  return json ? JSON.parse(json) : null;
}
