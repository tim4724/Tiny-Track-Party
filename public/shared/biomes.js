// The browser's edge of the biome ABI (native/runtime/ttp_theme.h).
//
// The palette itself is not here and cannot be got at from here. Six biomes'
// worth of sky, fog, light rig, road, scenery, air and furniture — what used to
// be shared/themes.js + render/trackPayload.js — is C++ data now, resolved
// inside ttp_display_build from the track's own cup, and no colour of it is ever
// handed back to JS. That is the point: three shells, one palette.
//
// What crosses is what a shell genuinely draws or names for itself: the biome
// NAME (the race-music pool key, the ?biome= override list) and two colours for
// two 2D widgets the renderer does not draw — the HUD boost chip's stroke and
// the music gallery's per-cup swatch. Plus the scenery model list, because
// fetching bytes is a platform job.
//
// If you find yourself wanting another getter to reproduce part of the look in
// the DOM, the look belongs in the renderer instead.
import { loadNativeRuntime } from '../display/nativeRuntime.js';

let api = null;

// Bind the biome ABI (idempotent; joins the in-flight module load). Callers that
// need it synchronously later read biomes() once this has settled.
export async function loadBiomes() {
  if (api) return api;
  const m = await loadNativeRuntime();
  const count = m.cwrap('ttp_theme_biome_count', 'number', []);
  const nameAt = m.cwrap('ttp_theme_biome_name', 'string', ['number']);
  const has = m.cwrap('ttp_theme_has_biome', 'number', ['string']);
  const forCup = m.cwrap('ttp_theme_biome_for_cup', 'string', ['string']);
  const forTrack = m.cwrap('ttp_theme_biome_for_track', 'string', ['string']);
  const boostIcon = m.cwrap('ttp_theme_boost_icon', 'number', ['string']);
  const hill = m.cwrap('ttp_theme_hill_color', 'number', ['string', 'number']);
  const models = m.cwrap('ttp_theme_scenery_models', 'string', ['string']);
  // The name list is fixed for the life of the module, and its ORDER is
  // user-visible (the ?biome= dropdown), so it is read across once.
  const names = [];
  for (let i = 0, n = count(); i < n; i++) names.push(nameAt(i));
  api = {
    names,
    // Is this a biome name? The ?biome= contract is that an unknown one is
    // ignored (the cup decides) rather than an error.
    has: (name) => !!name && has(name) === 1,
    // Cup id / track id → biome name. Both fall back to 'grass'.
    forCup,
    forTrack,
    // boostShades().icon for a biome, as 0xRRGGBB — the HUD item chip's stroke.
    boostIcon: (biome) => boostIcon(biome) >>> 0,
    // hills[0] is a biome's identity swatch (the music gallery's dot).
    hill: (biome, index) => hill(biome, index) >>> 0,
    // The scenery GLBs this biome stamps, in SLOT order: index i is handed back
    // to the renderer as scenery<i>.glb, and it binds its instanced props by
    // that index.
    sceneryModels: (biome) => JSON.parse(models(biome)),
  };
  return api;
}

// The bound API, or null before loadBiomes() has settled.
export const biomes = () => api;

// Format a 0xRRGGBB number as a '#rrggbb' string, for the two DOM widgets above.
export const cssHex = (h) => '#' + (h & 0xffffff).toString(16).padStart(6, '0');
