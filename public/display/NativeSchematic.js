// NativeSchematic — the display's edge of the track maps, which are C++.
//
// A catalogue track's full-resolution map, read out of the bake compiled into
// the wasm (ttp_track_schematic_json over native/libttp-track/generated/
// track_maps.h): no track is built to draw one. The phones' chooser carries the
// PACKED form instead, which ttp_ui_chooser_tracks_json hands over already
// packed (NativeUiModel.chooserTracks). Unpacking stays the phone's —
// public/shared/schematicCodec.js — because phones stay on the JS controller on
// all three TV platforms.

import { loadNativeRuntime } from './nativeRuntime.js';

let fn = null;

export async function init() {
  if (fn) return;
  const M = await loadNativeRuntime();
  fn = { schematic: M.cwrap('ttp_track_schematic_json', 'string', ['string']) };
}

// {viewBox, d, start, proj} for a catalogue id, or null for any other id.
export function trackSchematic(trackId) {
  const json = fn.schematic(trackId);
  return json ? JSON.parse(json) : null;
}
