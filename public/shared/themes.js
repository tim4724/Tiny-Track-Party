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
//                                       'lawn' | 'sand' | 'redrock' | 'snow')
//   hills:  [c0, c1, c2]                horizon-ring colours, cycled i%len
//   hillShape: (optional)               horizon-ring silhouette: 'dome' (default — soft
//                                       meadow mounds) | 'mesa' (flat-topped buttes) |
//                                       'island' (sparse low offshore chain, for watery
//                                       biomes — wide sea gaps between features);
//                                       a shape change rebuilds the ring (environment.js)
//   clouds: (optional)                  { count ≤8, opacity, scale, aspect, tint } sky-puff
//                                       dressing; omit for the canonical fat white cumulus
//                                       (8 × opacity .8). scale/aspect stretch the sprites
//                                       (wisps = wider, flatter), tint warms/cools them
//   water: (optional)                   { foam, shallow, deep, wet? } — a sea ring past
//                                       the horizon hills (built once, hidden for land-
//                                       locked biomes): a foam line at the shore, shallow
//                                       → deep radial gradient out to the fog. The hills
//                                       rise out of it as headlands/islands. Fitted per
//                                       track alongside the hill push-out, so the tide
//                                       never floods a large circuit; `wet` tints the
//                                       damp-sand band hugging the waterline.
//   haze: (optional)                    { count ≤5, opacity, tint, scale } low, wide
//                                       dust/mist banks drifting at hill height (the
//                                       cloud sprites' ground-level sibling); omit for
//                                       clear air (count 0). Reads as blowing dust
//                                       (canyon) — structure the uniform fog can't give
//   fogTune: (optional)                 scalar on the RACE + lobby-perimeter fog
//                                       distances (1 = clear default). <1 pulls the fog
//                                       in — thick dusty air. The gallery/overview fog
//                                       is untouched (framing the whole track stays
//                                       readable in the picker)
//   road: (optional)                    ribbon-road palette (buildRibbonRoad, render/
//                                       track.js). Omit for the canonical circuit look —
//                                       the defaults live in track.js as the verbatim
//                                       pre-theming literals, so grass/sunset carry no
//                                       entry. All fields optional:
//     asphalt:   deck colour            (default 0x5a6078 — Kenney blue-grey plastic)
//     line:      painted edge-line/dash colour (default 0xc4c4d9)
//     dash:      centre-dash override — canyon paints it highway yellow while the
//                edge treatment differs (defaults to `line`)
//     kerb:      [a, b] kerb band pair (default red/white); a ≈ b = unstriped banks
//     kerbW/kerbH: kerb cross-section overrides (snow widens + raises the kerb into
//                a ploughed snowbank; visual only — the physics corridor is untouched)
//     edgeLines: false drops the painted side lines; their strips (plus the kerb gap)
//                read as `shoulder` instead — desert roads aren't crisply lined
//     shoulder:  dusty edge tint for the dropped-lines case (defaults to asphalt)
//     skirt:     deck side/belly colour (defaults to asphalt — timber for a boardwalk)
//     planks:    { period, tones: [...], seam } repaints the deck as boardwalk
//                planks (no shipped theme uses this today — beach tried and retired
//                it; kept for the planned wooden Tabletop biome). A full-width
//                plank every `period` along the lap, `seam` =
//                the groove band between planks (it also interrupts the painted
//                lines/dash — paint sits ON the boards), and the rings beside a
//                seam get a bevel highlight/shade so each plank reads as a
//                chamfered 3D piece. Keep `tones` at whisper contrast: the seams
//                are the wood cue; visible tone steps read as painted patchwork.
//                The dash keeps its speedometer job in every variant.
//   structure: (optional)               support pillars/poles/loop-shaft tint (default
//                                       0x9aa1b4 toy concrete) — timber piles under a
//                                       beach overpass, red-rock columns in the canyon
//   snowfall: (optional)                { count ≤900, size, tint } — falling flakes
//                                       (one Points cloud) drifting over the play field;
//                                       omit for dry biomes
//   landmark: (optional)                hero set-piece kind or array of kinds, placed
//                                       by rule per track (render/track.js build-
//                                       Landmarks): 'lighthouse' (on the lowest off-
//                                       shore island) | 'sailboat' (anchored in the
//                                       shallows) | 'hoodoo' (balanced-rock family
//                                       trackside — skipped if no safe spot exists) |
//                                       'snowman' (trackside greeter). Procedural toy
//                                       geometry, no assets.
//   birds: (optional)                   { count ≤4, tint, size, y, rc, rb, speed,
//                                       flap, flapHz } — soaring silhouettes, each
//                                       circling its own roost on a ring of radius rc
//                                       (orbit radius rb, height y). flap = wing-beat
//                                       depth (1 = busy gull, ~0.15 = soaring vulture)
//                                       at flapHz beats/s
//   gate: (optional)                    near-white colour-grade multiplied onto the
//                                       start/finish gate's colormap (sun-bleach /
//                                       heat / cold) — a tint, not a repaint
//   scenery: trackside prop palette consumed by buildScenery (render/track.js) — the
//            placement logic (seeded stream, corridor clearance, clustering) is shared;
//            the palette decides WHAT gets stamped, so a desert never grows oak trees:
//     trees:   [{ model, w, s, tint? }]  weighted GLB silhouettes; w's should sum to 1.
//              s is [base, spread] — a stamp's scale is base + rand()*spread (kept as
//              the raw pair so the arithmetic matches the pre-theming literals
//              bit-for-bit). tint applies ONLY to untextured models (e.g. the
//              Nature-Kit cacti/palms): baked into vertex colours. A hex recolours
//              the whole model; a { 'authoredHex': newHex } map recolours per part
//              (palms: fronds + trunk carry different authored colours). Colormap-
//              textured kit models ignore it. Within one biome all TEXTURED models
//              must share a single colormap (they merge into one mesh/material).
//     bush:    { model, s, sink, tint? } the "bush" trick — a donor silhouette sunk to
//              its canopy (procedural bush shapes failed, see buildScenery) — or null.
//              tint as in trees, for untextured donors
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
  // horizon over a turquoise-haze fog; warm sand ground; and the thing that makes
  // it a BEACH rather than a desert: the sea. A turquoise water ring surrounds the
  // sand past the dunes (foam line at the shore, shallow → deep out to the fog),
  // and the dune hills rise out of it as headlands — every long view ends in water.
  beach: {
    sky:    { zenith: 0x37b4e6, horizon: 0xbfe7ec, below: 0xcdeef0 }, // below-horizon haze aqua, not sand — it now sits over water
    fog:    0xbfe7ec,
    hemi:   { sky: 0xffffff, ground: 0xd2bd8a, intensity: 2.35 },
    key:    { color: 0xfff0cf, intensity: 1.55 },
    ground: { kind: 'sand' },
    // Two dune tones + one scrub-grass green: a vegetated headland every third
    // feature keeps the coast from reading as bare desert dunes.
    hills:  [0xe6d29a, 0xefe2b3, 0x9fc48e],
    hillShape: 'island', // sparse offshore chain — the sea must show BETWEEN the hills
    water:  { foam: 0xf2fbf5, shallow: 0x62d3c8, deep: 0x2596c8, wet: 0x8f7c58 },
    fogTune: 1.3, // clear seaside air: push the chase-cam fog out so the water reads from track level
    // Sun-bleached coastal asphalt — the CANONICAL circuit road (white lines, dash,
    // the classic coral-red/white kerbs, which already read seaside), just lighter
    // and warmer, as if years of salt sun baked it. The road stays in the same
    // family as every other biome's; the sea, sand and palms do the theming.
    // (A wooden boardwalk deck was built and iterated three times here — it always
    // read as the odd one out against the other biomes' asphalt. Don't revive it.)
    road: {
      asphalt: 0x6c6a74,
    },
    structure: 0x9a7b55, // overpass supports stay timber piles — pier flavour without touching the road read
    landmark: ['lighthouse', 'sailboat'], // beacon on the lowest island + a boat in the shallows
    birds: { count: 4, tint: 0x51616d, size: 3.0, y: 13, rc: 100, rb: 32, speed: 0.26, flap: 1, flapHz: 2.1 }, // gulls working the shoreline, flapping busily
    gate: 0xfff1de, // sun-bleached gate grade
    // Palms (Nature Kit, untextured — the tint maps recolour authored teal fronds /
    // peach trunk to tropical green / sun-bleached tan) over weathered sandstone
    // boulders, scattered sparser than parkland so the beach reads open and airy.
    scenery: {
      trees:   [{ model: 'palm-tall', w: 0.55, s: [1.6, 0.6],
                  tint: { '70e6d6': 0x4fae6b, 'f2be9e': 0xc09a72 } },
                { model: 'palm-bend', w: 0.45, s: [1.5, 0.6],
                  tint: { '70e6d6': 0x54b573, 'f2be9e': 0xb8926c } }],
      bush:    null,
      mix:     { tree: 0.45, bush: 0.45 }, // no bushes; the rest rolls "rock"
      rocks:   [0xdccfa8, 0xcfbd90, 0xbca878],
      rockS:   [0.55, 0.75], // boulder-sized, not pebbles
      density: 0.5,
    },
  },

  // ── canyon — hot red-rock badlands (the Hard cup's biome; dormant until the canyon
  // cup lands in tracks.js, meanwhile reachable via ?biome=canyon). A dusty near-white
  // horizon haze over terracotta ground, rust mesa-coloured buttes, and a hot slightly
  // orange sun — bleached desert light rather than sunset gold. The air itself is the
  // signature: fogTune pulls the chase-cam fog in (sand haze, not clear alpine air)
  // and low dust banks drift across the mesas.
  canyon: {
    sky:    { zenith: 0x4292d4, horizon: 0xe8c8a2, below: 0xf4e3c6 },
    fog:    0xe8c8a2,
    hemi:   { sky: 0xffeedd, ground: 0xb9825e, intensity: 2.15 },
    key:    { color: 0xffdca6, intensity: 1.6 },
    ground: { kind: 'redrock' },
    hills:  [0xc47a52, 0xa96545, 0xd68f62],
    hillShape: 'mesa', // flat-topped buttes on the horizon, not meadow mounds
    // Bone-dry air: no fat cumulus. A few high, stretched, barely-there wisps with a
    // warm dust tint — enough to keep the sky from reading empty on a long straight.
    clouds: { count: 3, opacity: 0.3, scale: 1.35, aspect: 0.2, tint: 0xfff2e2 },
    fogTune: 0.72, // sand-fog: the dusty horizon starts noticeably closer than clear air
    // Blowing dust: wide sand-tinted banks at mesa height, drifting with the clouds.
    haze: { count: 4, opacity: 0.16, tint: 0xe9c9a0, scale: 1 },
    // Desert highway: sun-baked warm asphalt, NO painted edge lines (a dusty shoulder
    // fades to the kerb instead), a faded-yellow centre dash — the instantly readable
    // "desert road" trope, and the dash keeps its near-field speedometer job.
    road: {
      asphalt: 0x6e6560,           // warm sun-baked grey (stock deck is cool blue-grey)
      dash:    0xd9b054,           // faded highway yellow
      edgeLines: false,
      shoulder: 0x7d6f5f,          // dusty edge band where the lines would be
      kerb:  [0xc06a42, 0xe3cfa4], // rust / sand
    },
    structure: 0xb4714d, // supports read as red-rock columns, not city concrete
    landmark: 'hoodoo', // balanced-rock family at one clear roadside stretch (a road-spanning arch was rejected)
    birds: { count: 2, tint: 0x3a322c, size: 3.6, y: 36, rc: 150, rb: 20, speed: 0.1, flap: 0.15, flapHz: 0.5 }, // vultures riding a thermal — soaring, barely a wing-beat
    gate: 0xffdec2, // hot dusty gate grade
    scenery: {
      // Saguaros as the signature silhouette, barrel cacti as the low accent — both
      // are the Nature Kit's untextured models (CC0, same low-poly language as the
      // toy-car kit), so `tint` picks their green: dusty sage, not lawn green.
      trees:   [{ model: 'cactus-tall',  w: 0.6, s: [2.3, 0.7],   tint: 0x6da85c },
                { model: 'cactus-short', w: 0.4, s: [1.15, 0.55], tint: 0x7cb464 }],
      bush:    null,
      mix:     { tree: 0.4, bush: 0.4 }, // no bushes; the rest rolls "rock"
      rocks:   [0xc07a55, 0xa8623f, 0xd39a70], // rust → dusty ochre family
      rockS:   [0.6, 0.9],  // canyon-scale boulders
      density: 0.45,        // sparser than the shore; deserts read empty on purpose
    },
  },

  // ── snow — winter alpine (no cup yet; reachable via ?biome=snow, ready for a future
  // ladder slot). Cold pale light under a flat overcast: an ice-haze horizon, white
  // hill domes (snowed-over mounds — the dome silhouette is right here), grey-white
  // flattened cloud deck, and a near-white sun kept bright enough for TV readability.
  // Scenery leans on one trick: PINES ONLY. Dropping the round oak (bare in winter)
  // and bushes makes the same kit assets read "winter forest" with zero new models.
  snow: {
    sky:    { zenith: 0x6f9fd4, horizon: 0xdfe9f2, below: 0xf3f8fc },
    fog:    0xdfe9f2,
    hemi:   { sky: 0xedf3fc, ground: 0xb2bdcc, intensity: 2.25 },
    key:    { color: 0xf4f8ff, intensity: 1.45 },
    ground: { kind: 'snow' },
    hills:  [0xeef4f9, 0xdfe9f2, 0xf7fafc],
    clouds: { count: 6, opacity: 0.55, scale: 1.25, aspect: 0.3, tint: 0xe9edf2 }, // low flat overcast
    scenery: {
      // Snow-capped pines from the Holiday Kit (textured — all three share its
      // colormap, satisfying the one-colormap rule; native ~1.9 tall vs the toy-car
      // pine's 0.83, hence the smaller s). Three variants so a treeline never
      // reads as stamped clones.
      trees:   [{ model: 'tree-snow-a', w: 0.4,  s: [1.05, 0.4] },
                { model: 'tree-snow-b', w: 0.35, s: [1.05, 0.4] },
                { model: 'tree-snow-c', w: 0.25, s: [1.05, 0.4] }],
      bush:    null,
      mix:     { tree: 0.55, bush: 0.55 }, // no bushes; the rest rolls "rock"
      rocks:   [0xcdd4e0, 0xb9c1d0, 0x9fa8ba], // cold blue-grey granite
      rockS:   [0.4, 0.6], // a touch bigger than parkland — reads as snow-shouldered
      density: 0.55,
    },
    // Wet ploughed asphalt between snowbanks: a darker, colder deck (free contrast
    // against the white ground — the readability risk of this biome), ice-tinted
    // paint, and the kerbs become plain white banks — wider and taller than a racing
    // kerb, with only a whisper of two-tone banding so edge distance still reads.
    road: {
      asphalt: 0x494f5e,           // wet cold asphalt
      line:  0xc2d6e6,             // ice-blue paint
      kerb:  [0xeff4f9, 0xdde7f0], // near-white bank pair (whisper contrast)
      kerbW: 0.55, kerbH: 0.3,     // squat ploughed bank, not a kerb
    },
    snowfall: { count: 650, size: 0.3, tint: 0xffffff }, // lazy drifting flakes — one Points draw call
    gate: 0xdfe9f6, // cold-cast gate grade
    landmark: 'snowman', // trackside greeter just off the racing line
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
  canyon:   'canyon',
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
