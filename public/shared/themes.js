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
//   scenery: trackside prop palette consumed by buildScenery (render/track.js) — the
//            placement logic (seeded stream, corridor clearance, clustering) is shared;
//            the palette decides WHAT gets stamped, so a desert never grows oak trees:
//     trees:   [{ model, w, s }]  weighted GLB silhouettes; w's should sum to 1. s is
//              [base, spread] — a stamp's scale is base + rand()*spread (kept as the
//              raw pair so the arithmetic matches the pre-theming literals bit-for-bit)
//     bush:    { model, s, sink } the "bush" trick — a donor silhouette sunk to its
//              canopy (procedural bush shapes failed, see buildScenery) — or null
//     mix:     { tree, bush }     CUMULATIVE roll thresholds: roll < tree → tree,
//              roll < bush → bush, else rock. tree === bush means "no bushes".
//     rocks:   [c0, c1, ...]      boulder tint family (flat-shaded, per-vertex)
//     rockS:   [base, spread]     boulder radius = base + rand()*spread
//     density: 0..1               per-side spawn chance at each corridor candidate

// Green-parkland scenery, shared by every biome that keeps the grass world (grass +
// sunset — golden light over the SAME trees is the sunset look). Every value is the
// VERBATIM pre-theming constant from buildScenery; do not drift it, or grass-cup
// tracks lose their byte-identical guarantee (scenery placement is seeded, so any
// changed literal reshuffles the whole scatter).
const GRASS_SCENERY = {
  trees:   [{ model: 'tree', w: 0.65, s: [2.3, 1.1] },       // round oak — the staple
            { model: 'tree-pine', w: 0.35, s: [2.3, 1.1] }], // pine as the accent
  bush:    { model: 'tree', s: [1.1, 0.7], sink: 0.3 },
  mix:     { tree: 0.62, bush: 0.9 },
  rocks:   [0xc6cbd6, 0xb4bac8, 0x9aa1b4], // pillar-concrete family
  rockS:   [0.3, 0.45],
  density: 0.62,
};

export const THEMES = {
  // ── grass — the canonical Sunny Circuit biome. Every value here is the VERBATIM
  // constant the renderer used before theming existed; do not drift it, or the
  // Backyard cup (which resolves to grass) changes look.
  grass: {
    sky:    { zenith: 0x59a7e8, horizon: 0x8ecae6, below: 0xc8e9f2 },
    fog:    0x8ecae6,
    hemi:   { sky: 0xffffff, ground: 0x9aa68f, intensity: 2.2 },
    key:    { color: 0xfff1d0, intensity: 1.4 },
    ground: { kind: 'lawn' },
    hills:  [0x8cc578, 0x7cb86a, 0x9bce86],
    scenery: GRASS_SCENERY,
  },

  // ── sunset — golden hour over the grass world. SAME grass ground + scenery as
  // `grass` (green trees still read right), so it needs NO new ground texture or props:
  // a warm low-key sun, a peach-to-periwinkle sky over a warm apricot-haze fog, and
  // warm dusk hills. The warm key light alone turns the green grass golden.
  sunset: {
    sky:    { zenith: 0x5e74c0, horizon: 0xffb878, below: 0xffd9a8 },
    fog:    0xffb878,
    hemi:   { sky: 0xffd0a0, ground: 0x8c7a66, intensity: 2.0 },
    key:    { color: 0xffa850, intensity: 1.55 },
    ground: { kind: 'lawn' },
    hills:  [0xc69a86, 0xb98a72, 0xd0a890],
    scenery: GRASS_SCENERY,
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
    // No green trees on sand: until the palm/beach-prop asset round lands, the shore
    // is dressed with weathered sandstone boulders only, scattered sparser than
    // parkland so the beach reads open and airy.
    scenery: {
      trees:   [],
      bush:    null,
      mix:     { tree: 0, bush: 0 }, // every spawn rolls "rock"
      rocks:   [0xdccfa8, 0xcfbd90, 0xbca878],
      rockS:   [0.55, 0.75], // rocks carry the whole shore — boulder-sized, not pebbles
      density: 0.5,
    },
  },
};

// Union of every GLB the biome scenery palettes reference. The display preloads this
// whole set once (SceneRenderer.load), so switching cups/biomes in the lobby never
// waits on a model fetch — the per-model cost is tiny (the kit props are a few KB).
export const SCENERY_MODELS = [...new Set(Object.values(THEMES).flatMap((t) => [
  ...t.scenery.trees.map((e) => e.model),
  ...(t.scenery.bush ? [t.scenery.bush.model] : []),
]))];

// Cup id → biome name. Cups absent here (or an undefined cup) fall back to grass, so
// the renderer is always safe to call themeForCup() with whatever a track carries.
const CUP_BIOME = {
  backyard: 'grass',
  rooftop:  'sunset',
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
