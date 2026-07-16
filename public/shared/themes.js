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
//                                       'lawn' | 'sand' | 'redrock' | 'snow' | 'wood')
//   hills:  [c0, c1, c2]                horizon-ring colours, cycled i%len
//   hillShape: (optional)               horizon-ring silhouette: 'dome' (default — soft
//                                       meadow mounds) | 'mesa' (flat-topped buttes) |
//                                       'island' (sparse low offshore chain, for watery
//                                       biomes — wide sea gaps between features) |
//                                       'block' (giant toy building blocks scattered on
//                                       the floor — the playroom's "horizon");
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
//   ice: (optional)                     { sheet, frost } — reskin the road OIL slicks as
//                                       frozen ICE sheets (TrackProps._buildHazards):
//                                       `sheet` tints the glassy translucent disc, `frost`
//                                       the rime ring at its edge. Visual only — the
//                                       spin-out mechanic and warning cones are untouched
//                                       (black oil reads wrong on ploughed snow; a biome
//                                       with `water` gets puddles + signs instead)
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
//   ambient: (optional)                 { kind, count ≤1400, size?, tint?, opacity?,
//                                       fall?, wind?, bob?, band? } — one Points cloud
//                                       of ambient particles over the play field; the
//                                       KIND presets the motion (environment.js
//                                       AMB_KINDS), explicit fields override:
//                                       'flake' (lazy falling snow) | 'mote' (golden
//                                       sunbeam dust, near-still) | 'sand' (fast low
//                                       wind-blown grit) | 'pollen' (light seeds on a
//                                       breeze). Omit for still air.
//   ambientByTrack: (optional)          { trackId: {…} } per-track ambient overrides
//                                       merged over `ambient` (the snow cup scales its
//                                       flurry per track: a glacier is sparse, a
//                                       whiteout track dense)
//   landmark: (optional)                hero set-piece kind or array of kinds, placed
//                                       by rule per track (render/track.js build-
//                                       Landmarks): 'lighthouse' (on the lowest off-
//                                       shore island) | 'sailboat' (anchored in the
//                                       shallows) | 'umbrella' (beach umbrella + towel
//                                       + cooler) | 'sandcastle' (bucket-castle) |
//                                       'hoodoo' (balanced-rock family trackside —
//                                       skipped if no safe spot exists) | 'windmill'
//                                       (western water-pump tower, rotor SPINS) |
//                                       'snowman' (trackside greeter) | 'cabin' (log
//                                       cabin, chimney smoke DRIFTS) | 'blocks'
//                                       (stacked giant alphabet blocks) | 'duck'
//                                       (bath-toy duck watching the race) | 'ball'
//                                       (panelled play ball) | 'gnome' (garden gnome)
//                                       | 'doghouse' (kennel) | 'picnic' (checkered
//                                       blanket + basket + cooler) | 'crayons'
//                                       (spilled crayons) | 'books' (stacked picture
//                                       books) | 'train' (wind-up toy train circling
//                                       the floor). Procedural toy geometry, no assets.
//   birds: (optional)                   { kind?, count ≤4, tint | tints[], size, y, rc,
//                                       rb, speed, flap, flapHz, dys?, bank? } —
//                                       airborne silhouettes, each circling its own
//                                       roost on a ring of radius rc (orbit radius rb,
//                                       height y). kind picks the glyph: 'bird'
//                                       (default) | 'plane'. flap = wing-beat depth
//                                       (1 = busy gull, ~0.15 = soaring vulture) at
//                                       flapHz beats/s; tints cycles per flier; dys
//                                       scales the per-flier altitude jitter; bank
//                                       rolls the sprite into its turn (the paper
//                                       plane — flapping kinds leave it 0)
//   kites: (optional)                   { count ≤2, tints, size, y } — bright kites
//                                       bobbing on implied strings over the shore;
//                                       anchored wander, not an orbit (beach)
//   balloon: (optional)                 { panels: [a, b], y, size } — one far-field
//                                       hot-air balloon drifting a very slow lap of
//                                       the horizon at cloud height; gored envelope
//                                       alternates the two panel colours (grass/sunset)
//   gate: (optional)                    near-white colour-grade multiplied onto the
//                                       start/finish gate's colours (sun-bleach /
//                                       heat / cold) — a tint, not a repaint
//   gantry: (optional)                  finish-gantry plastic colours (render/
//                                       FinishGate.js): { pylon, finial, rings? }.
//                                       rings wraps lighthouse bands (rings colour
//                                       over pylon colour) around the posts. Default
//                                       is celebration red posts + paper domes; the
//                                       chequer banner is always ink/paper.
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
//     clutter: (optional)         small ground detail scattered DENSER and CLOSER to
//              the road than the props above — the near-field pass the chase cam
//              actually sees. { kinds: [{ kind, w, tints }], density }; kinds are
//              procedural (render/track.js CLUTTER_BUILDERS): 'flower' | 'shell' |
//              'starfish' | 'driftwood' | 'drift' (snow heap) | 'scrub' |
//              'pebbles' | 'brick' (studded toy brick) | 'marble' | 'domino'.
//              Placement draws from its OWN seeded stream, so adding or tuning
//              clutter NEVER reshuffles the tree/rock scatter.

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
  // Near-field pass (own rand stream — the scatter above is untouched): wildflower
  // patches on the verge. Soft meadow colours, no chrome-yellow neon — poppy red,
  // daisy cream, cornflower, and a warm gold.
  clutter: {
    kinds: [{ kind: 'flower', w: 1, tints: [0xe4604a, 0xf5f0e2, 0x6f8fd8, 0xe8b84a] }],
    density: 0.3,
  },
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
    // The Backyard finally becomes a PLACE, not the default: garden clutter
    // trackside (gnome/kennel/picnic), drifting pollen in the sun, and a
    // hot-air balloon over the meadow. (Butterfly fliers were tried here and
    // removed on review 2026-07-16.)
    ambient: { kind: 'pollen', count: 140, tint: 0xfff2c4 },
    balloon: { panels: [0xd94f3d, 0xf5f0e2], y: 44, size: 6 },
    landmark: ['gnome', 'doghouse', 'picnic'],
    scenery: GRASS_SCENERY,
  },

  // ── sunset — golden hour over the grass world (no cup since the stunt cup went
  // playroom; reachable via ?biome=sunset). SAME grass ground + scenery as
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
    // Golden-hour air: backlit seeds drifting through the low sun, and the
    // evening balloon ride — dusk gold + violet gores against the peach sky.
    ambient: { kind: 'pollen', count: 160, tint: 0xffd9a0 },
    balloon: { panels: [0xf2c14e, 0x8a76d8], y: 46, size: 6 },
    landmark: ['gnome', 'doghouse', 'picnic'], // the same backyard, later in the day
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
    landmark: ['lighthouse', 'sailboat', 'umbrella', 'sandcastle'], // offshore pair + a day-at-the-beach pair trackside
    birds: { count: 4, tint: 0x51616d, size: 3.0, y: 13, rc: 100, rb: 32, speed: 0.26, flap: 1, flapHz: 2.1 }, // gulls working the shoreline, flapping busily
    kites: { count: 2, tints: [0xd94f3d, 0x3f8fd1], size: 2.8, y: 13 }, // bright diamonds tugging over the shore
    gate: 0xfff1de, // sun-bleached gate grade
    gantry: { pylon: 0xfff6eb, rings: 0xff5040, finial: 0xff5040 }, // lighthouse posts — echoes the beacon landmark
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
      // Tide-line finds close to the road: shells, a starfish here and there,
      // a bleached driftwood branch. Coral/cream — the beach's warm family.
      clutter: {
        kinds: [{ kind: 'shell',     w: 0.45, tints: [0xf5ead8, 0xecc8b4, 0xd9b8c4] },
                { kind: 'starfish',  w: 0.3,  tints: [0xe4784f, 0xd95f6a] },
                { kind: 'driftwood', w: 0.25, tints: [0xcbb794, 0xb8a686] }],
        density: 0.28,
      },
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
    // Grit on the wind: fast low sand streaks under the drifting dust banks.
    ambient: { kind: 'sand', count: 180, tint: 0xe9c9a0 },
    structure: 0xb4714d, // supports read as red-rock columns, not city concrete
    landmark: ['hoodoo', 'windmill'], // balanced rocks + a spinning water-pump tower (a road-spanning arch was rejected)
    birds: { count: 2, tint: 0x3a322c, size: 3.6, y: 36, rc: 150, rb: 20, speed: 0.1, flap: 0.15, flapHz: 0.5 }, // vultures riding a thermal — soaring, barely a wing-beat
    gate: 0xffdec2, // hot dusty gate grade
    gantry: { pylon: 0x8a5f3e, finial: 0xfff6eb }, // weathered timber posts — desert-highway signage
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
      // Roadside detail stays dry and sparse: sage scrub tufts, sun-bleached
      // branches, little clusters of rust pebbles.
      clutter: {
        kinds: [{ kind: 'scrub',     w: 0.5,  tints: [0x8a8f56, 0x7c8a4e, 0x9c9460] },
                { kind: 'driftwood', w: 0.22, tints: [0xd8c8a8, 0xc4b494] },
                { kind: 'pebbles',   w: 0.28, tints: [0xc07a55, 0xa8623f, 0xd39a70] }],
        density: 0.25,
      },
    },
  },

  // ── snow — winter alpine (the Snow cup's biome — the Medium rung of the ladder).
  // Cold pale light under a flat overcast: an ice-haze horizon, white
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
      // Verge detail: wind-blown snow heaps hugging the snowbanks. (Pinecones
      // were tried here and removed on review 2026-07-16 — too small to read.)
      clutter: {
        kinds: [{ kind: 'drift', w: 1, tints: [0xf3f7fb, 0xe9eff6] }],
        density: 0.3,
      },
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
    ambient: { kind: 'flake', count: 650, size: 0.3, tint: 0xffffff }, // lazy drifting flakes — one Points draw call
    // Weather varies ACROSS the cup: each track patches the flake cloud, so the
    // four races read as four different winter days, not one repeated snow globe.
    ambientByTrack: {
      powder:    { count: 520, size: 0.28 },            // fresh powder — settled, light fall
      flurry:    { count: 1150 },                       // the name track: a proper flurry
      glacier:   { count: 240, size: 0.22 },            // high, cold, clear — fine sparse ice dust
      avalanche: { count: 950, size: 0.36, wind: 1.6 }, // big wind-driven flakes, the heaviest sky
    },
    birds: { count: 2, tint: 0x555b66, size: 3.4, y: 32, rc: 140, rb: 24, speed: 0.12, flap: 0.7, flapHz: 1.3 }, // a pair of geese crossing high
    // Oil slicks read as black stains on ploughed snow — reskin them as ICE sheets:
    // a glassy pale-blue glaze with a near-white frost rim. Same spin-out, same cones.
    ice: { sheet: 0xa9d7ee, frost: 0xf0f8fd },
    gate: 0xdfe9f6, // cold-cast gate grade
    gantry: { pylon: 0x3f7bd9, finial: 0xfff6eb }, // ski-gate blue — pops against the white world
    landmark: ['snowman', 'cabin'], // trackside greeter + a log cabin with smoke curling from the chimney
  },

  // ── playroom — the stunt cup's biome: a toy racetrack set up on a sunlit
  // playroom floor. The loops/corkscrews/launch ramps ARE the classic snap-together
  // toy stunt set, so the road finally admits it: bright orange moulded-plastic
  // deck between solid blue clip-on rails (no painted edge lines — plastic isn't
  // painted; the cream centre dash stays as a printed decal, keeping its
  // speedometer job). Indoors, but still broad daylight — afternoon sun through a
  // window (readability rule: no dark scenes) — over a honey floorboard "ground",
  // with giant pastel building blocks as the horizon and toy-bit clutter trackside.
  playroom: {
    sky:    { zenith: 0x8cbcea, horizon: 0xf3e3c3, below: 0xfaf0da }, // pale nursery-blue wall up top, warm window-glow at the skirting
    fog:    0xf3e3c3,
    hemi:   { sky: 0xfff2dc, ground: 0xa88860, intensity: 2.2 },     // warm room light, wood-floor bounce
    key:    { color: 0xffeac2, intensity: 1.5 },                     // low afternoon sun through the window
    ground: { kind: 'wood' },
    // Giant toy blocks scattered on the floor past the fog: soft plastic
    // primaries. hills[0] also tints the controller's cup panel (trackPicker) —
    // the warm red keeps the playroom distinct from beach sand / canyon clay.
    hills:  [0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c],
    hillShape: 'block',
    // Indoors: no cumulus. A few faint warm puffs stay as drifting sunbeam
    // bloom so the (very visible — stunt tracks are tall) sky isn't a flat wall.
    clouds: { count: 3, opacity: 0.22, scale: 1.3, aspect: 0.3, tint: 0xffedd2 },
    fogTune: 1.25, // clear indoor air — the tall stunt structures must read from track level
    // The star: orange moulded-plastic track. Deck + shoulder are one clean
    // injection-moulded orange (edgeLines off — no paint on plastic), the kerbs
    // become chunky solid-blue clip-on rails (whisper two-tone so edge distance
    // still reads), and the underside is a darker moulded orange.
    road: {
      asphalt: 0xe8731f,           // toy-track orange (bright, not neon — soft-toy rule)
      dash:    0xfdf4de,           // printed cream lane decal — keeps the speedometer read
      edgeLines: false,            // moulded plastic has no painted lines
      kerb:  [0x3e6ed8, 0x4677e0], // solid blue snap-on rails (whisper contrast pair)
      kerbW: 0.26, kerbH: 0.26,    // beefier rail profile — visual only, physics untouched
      skirt: 0xc25e14,             // darker plastic underside/sides
    },
    // Dust motes hanging in the window sunbeams — the indoor-afternoon icon —
    // and a paper airplane on a long lazy glide around the room.
    ambient: { kind: 'mote', count: 240, tint: 0xffdf9e },
    birds: { kind: 'plane', count: 1, tint: 0xfaf7ec, size: 4.4, y: 24, rc: 100, rb: 34, speed: 0.28, flap: 0, bank: 0.4 },
    structure: 0x4a6fc4, // support columns read as the kit's blue connector pieces
    landmark: ['blocks', 'duck', 'ball', 'crayons', 'books', 'train'], // toy clutter + a wind-up train circling the floor
    gate: 0xfff3e2, // warm indoor-light gate grade
    gantry: { pylon: 0x5cb168, finial: 0xff5040 }, // green toy plastic + red dome — a third primary next to the orange deck / blue rails
    scenery: {
      // No trees indoors — the "boulder" channel does all the work: faceted
      // toy bits (dice/gems/beanbags) in the same plastic primaries as the
      // horizon blocks, scattered sparse — floors are tidier than meadows.
      trees:   [],
      bush:    null,
      mix:     { tree: 0, bush: 0 }, // everything rolls "rock"
      rocks:   [0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c],
      rockS:   [0.5, 0.7], // chunky toy-piece scale
      density: 0.35,
      // Floor detail: stray studded bricks, a marble or two, a fallen domino —
      // the small stuff a tidy-up always misses.
      clutter: {
        kinds: [{ kind: 'brick',  w: 0.5,  tints: [0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c] },
                { kind: 'marble', w: 0.3,  tints: [0x7db8e8, 0xe89a8a, 0x9cd89c] },
                { kind: 'domino', w: 0.2,  tints: [0xf5f2ea] }],
        density: 0.22,
      },
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
  beach:    'beach',
  snow:     'snow',
  backyard: 'grass',
  canyon:   'canyon',
  rooftop:  'playroom', // the stunt cup — displayed as "Playroom Cup"; id kept for wiring
};

// Resolve a cup id to its biome object. Returns a STABLE reference per biome, so the
// renderer can guard re-theming with a cheap identity check (theme !== current).
export function themeForCup(cupId) {
  return THEMES[CUP_BIOME[cupId]] || THEMES.grass;
}

// The biome NAME for a cup — for callers keyed by name rather than theme object
// (the per-biome race-music map in display/Audio.js). Same grass fallback.
export function biomeNameForCup(cupId) {
  return THEMES[CUP_BIOME[cupId]] ? CUP_BIOME[cupId] : 'grass';
}

// Look a biome up by name (for the `?biome=<name>` inspector override). Unknown → null.
export function themeByName(name) {
  return THEMES[name] || null;
}

// Biome names, for the debug panel's biome-override dropdown (kept in sync with THEMES).
export const BIOME_NAMES = Object.keys(THEMES);
