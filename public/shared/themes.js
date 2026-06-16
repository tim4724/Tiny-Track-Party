// Per-cup visual BIOMES — DATA ONLY (no Three.js), so this module loads in the
// browser display, the gallery, and Node alike (a sibling of genTracks.js/tracks.js).
// A biome is resolved from a track's CUP id; unknown or unlisted cups fall back to
// `grass` (the canonical "Sunny Circuit" look), so existing cups render byte-for-byte
// identically until a cup is explicitly given its own biome.
//
// Each biome is a flat bag of colours/intensities consumed by render/environment.js
// (buildEnvironment / applyEnvTheme) and SceneRenderer (fog + background colour):
//   sky:    { zenith, horizon, below }  vertex-gradient sky-dome colours (overhead →
//                                       horizon → below-horizon haze). horizon SHOULD
//                                       match `fog` so the ground dissolves seamlessly.
//   fog:    one colour shared by the race / overview / perimeter fogs AND scene.background
//   hemi:   { sky, ground, intensity }  hemisphere fill light (sky tint / bounce tint)
//   key:    { color, intensity }        warm directional "sun" (the plastic shine)
//   ground: { kind }                    procedural ground texture id (see textures.js:
//                                       'lawn' | 'sand')
//   hills:  [c0, c1, c2]                horizon-dome ring colours, cycled i%len

export const THEMES = {
  // ── grass — the canonical Sunny Circuit biome. Every value here is the VERBATIM
  // constant the renderer used before theming existed; do not drift it, or the
  // Backyard/Rooftop cups (which resolve to grass) change look.
  grass: {
    sky:    { zenith: 0x59a7e8, horizon: 0x8ecae6, below: 0xc8e9f2 },
    fog:    0x8ecae6,
    hemi:   { sky: 0xffffff, ground: 0x9aa68f, intensity: 2.2 },
    key:    { color: 0xfff1d0, intensity: 1.4 },
    ground: { kind: 'lawn' },
    hills:  [0x8cc578, 0x7cb86a, 0x9bce86],
  },

  // ── beach — the Easy on-ramp biome. Brighter, warmer sun; a paler turquoise
  // horizon over a turquoise-haze fog; warm sand ground; pale dune hills. The
  // biggest possible departure from grass, on purpose (it stress-tests theming).
  beach: {
    sky:    { zenith: 0x37b4e6, horizon: 0xbfe7ec, below: 0xf2efd7 },
    fog:    0xbfe7ec,
    hemi:   { sky: 0xffffff, ground: 0xd2bd8a, intensity: 2.35 },
    key:    { color: 0xfff0cf, intensity: 1.55 },
    ground: { kind: 'sand' },
    hills:  [0xe6d29a, 0xefe2b3, 0xd9c187],
  },
};

// Cup id → biome name. Cups absent here (or an undefined cup) fall back to grass, so
// the renderer is always safe to call themeForCup() with whatever a track carries.
const CUP_BIOME = {
  backyard: 'grass',
  rooftop:  'grass',
  beach:    'beach',
};

// Resolve a cup id to its biome object. Returns a STABLE reference per biome, so the
// renderer can guard re-theming with a cheap identity check (theme !== current).
export function themeForCup(cupId) {
  return THEMES[CUP_BIOME[cupId]] || THEMES.grass;
}

// Look a biome up by name (for the `?biome=<name>` inspector override). Unknown → null.
export function themeByName(name) {
  return THEMES[name] || null;
}

// Biome names, for the debug panel's biome-override dropdown (kept in sync with THEMES).
export const BIOME_NAMES = Object.keys(THEMES);
