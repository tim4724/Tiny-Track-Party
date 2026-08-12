// The HUD item chips' artwork: one SVG file per item id under /assets/items/,
// fetched once and handed back as inline-able text. Files rather than JS
// strings because every shell draws the same four chips — the web inlines them
// into the DOM, and a TV shell rasterizes the same bytes (see
// docs/native-port/shells.md, "Asset bytes"). Two CSS custom properties are
// the recolour seams, with baked fallbacks a plain <img> renders as-is:
// --icon-accent (the boost chevrons — the biome's boost accent) and
// --icon-car (the monster cab — the body colour of the car model the player
// drives, matching the in-race graft; a livery never repaints a car body).
import { ITEM_IDS } from '../display/engine/contract.js';

// The four car models' painted body tones, parallel to CAR_MODELS
// (shared/protocol.js). The paint itself lives in the kit GLBs — these are the
// dominant body tones sampled from the baked thumbnails, and they exist ONLY
// to tint the monster chip's cab like the model it grafts. Cosmetic: nothing
// races on them.
export const CAR_BODY_COLORS = [
  '#5cbb80', // vehicle-racer-low · Dash
  '#dd5533', // vehicle-speedster · Bolt
  '#6688cc', // vehicle-racer · Carve
  '#aa77dd'  // vehicle-vintage-racer · Rumble
];

let icons = null;

// Fetch (or join the in-flight fetch of) all the icons: { id: '<svg…>' }.
export function loadItemIcons() {
  if (!icons) {
    icons = Promise.all(ITEM_IDS.map(async (id) => {
      const res = await fetch(`/assets/items/${id}.svg`);
      if (!res.ok) throw new Error(`item icon ${id}: HTTP ${res.status}`);
      return [id, await res.text()];
    })).then(Object.fromEntries)
       .catch((e) => { icons = null; throw e; }); // a failed load may retry
  }
  return icons;
}
