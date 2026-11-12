#include "ttp/theme.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <initializer_list>

#include "generated/track_defs.h"
#include "ttp/canonical.h"
#include "ttp/detail.h"
#include "ttp/glb_mesh.h"
#include "ttp/json_parse.h"
#include "ttp/race_track.h"

namespace ttp {
namespace rt {
namespace {

// ---------------------------------------------------------------------------
// Ambient motion presets (trackPayload.js AMB_KINDS). A theme names the KIND and
// the preset supplies the motion; explicit fields on the theme override it.
// ---------------------------------------------------------------------------
void ambientKind(AmbientSpec& a, uint32_t kind) {
  a.kind = kind;
  switch (kind) {
    case AMB_FLAKE:  a.size = 0.3f;  a.opacity = 0.85f; a.fall = 1;     a.wind = 0.7f; a.bob = 0;     a.band = 1;     break;
    case AMB_MOTE:   a.size = 0.13f; a.opacity = 0.5f;  a.fall = 0.05f; a.wind = 0.4f; a.bob = 0.4f;  a.band = 0.5f;  break;
    case AMB_SAND:   a.size = 0.17f; a.opacity = 0.4f;  a.fall = 0;     a.wind = 9;    a.bob = 0.5f;  a.band = 0.1f;  break;
    case AMB_POLLEN: a.size = 0.15f; a.opacity = 0.5f;  a.fall = 0.1f;  a.wind = 1.2f; a.bob = 0.6f;  a.band = 0.35f; break;
    // An unlisted kind takes the flake preset, exactly as AMB_KINDS[kind] || AMB_KINDS.flake did.
    default:         a.size = 0.3f;  a.opacity = 0.85f; a.fall = 1;     a.wind = 0.7f; a.bob = 0;     a.band = 1;     break;
  }
}

// The road palette's derived fallbacks: `dash` follows `line`, and both `skirt`
// and `shoulder` follow `asphalt`. Call AFTER the biome's own road overrides so
// a biome that only repaints the deck still gets a matching belly and shoulder.
void deriveRoad(RoadPalette& r, bool dashSet, bool skirtSet, bool shoulderSet) {
  if (!dashSet) r.dash = r.line;
  if (!skirtSet) r.skirt = r.asphalt;
  if (!shoulderSet) r.shoulder = r.asphalt;
}

// The scenery<i>.glb index order: the tree models deduped in first-appearance
// order, then the bush donor if it is not already among them.
void deriveModels(ScenerySpec& s) {
  s.models.clear();
  const auto add = [&](const std::string& m) {
    for (const std::string& seen : s.models) if (seen == m) return;
    s.models.push_back(m);
  };
  for (const TreeSpec& t : s.trees) add(t.model);
  if (s.hasBush) add(s.bush.model);
}

// ---------------------------------------------------------------------------
// Green-parkland scenery, shared by every biome that keeps the grass world
// (grass + sunset: golden light over the SAME trees is the sunset look).
// No kit fir stands on a lawn: the trees are our own build
// (scripts/blender/set_prototypes.py, the tree_* pieces), one family per
// backyard track, the same trees its set pieces are made of. The list names
// every family, because the shell fetches a biome's scenery by the BIOME
// (ttp_theme_scenery_models); a track picks its own by weight (lawnTrees),
// and a lawn outside the cup wears the oak.
// ---------------------------------------------------------------------------
ScenerySpec grassScenery() {
  ScenerySpec s;
  s.trees = {
    { "set-tree-oak", 1.0f, 1.0f, 0.4f },           // Pretzel's faceted broadleaf
    { "set-tree-cherry", 0.0f, 0.8f, 0.7f },        // Cloverleaf's blossom, pink, young to old
    { "set-tree-cherry-white", 0.0f, 0.8f, 0.7f },  // and white
    { "set-tree-alder", 0.0f, 0.95f, 0.45f },       // Tangle's tall dark wood
    { "set-tree-willow", 0.0f, 0.95f, 0.3f },       // and its willows
    { "set-tree-apple", 0.0f, 1.3f, 0.6f },         // Ribbon's round orchard tree
    { "set-tree-poplar", 0.0f, 0.9f, 0.4f },        // and its poplar
  };
  s.hasBush = true;
  s.bush = { "set-lawn-shrub", 0.9f, 0.5f, 0.0f };
  s.mixTree = 0.62f; s.mixBush = 0.9f;
  s.rocks = { 0xc6cbd6, 0xb4bac8, 0x9aa1b4 };  // pillar-concrete family
  s.rockS[0] = 0.3f; s.rockS[1] = 0.45f;
  s.density = 0.62f;
  // Near-field pass (own rand stream — the scatter above is untouched):
  // wildflower patches on the verge. Soft meadow colours: poppy red, daisy
  // cream, cornflower, warm gold.
  s.clutter = { { CL_FLOWER, 1, { 0xe4604a, 0xf5f0e2, 0x6f8fd8, 0xe8b84a } } };
  s.clutterDensity = 0.3f;
  deriveModels(s);
  return s;
}

// ---------------------------------------------------------------------------
// The biomes.
// ---------------------------------------------------------------------------

// ── grass — the canonical Sunny Circuit biome. Every value here is the VERBATIM
// constant the renderer used before theming existed; do not drift it, or the
// Backyard cup (which resolves to grass) changes look.
// Shared by grass and sunset, the grassScenery() rule: one authored list, two
// light rigs.
PropsSpec gardenProps() {
  PropsSpec p;
  // The tent is Nature Kit, which is authored small — a third of a car length —
  // so it is staged at better than twice its own size to read as something you
  // could camp in beside a toy car. The generated crate and bale are already
  // at world scale and are not. Hay bales line the kerb the way they line a
  // real one, among road-works lights (City Kit Roads, authored at street
  // scale, so well over twice its size). Only here: road works mean something
  // on a country road, and nothing on a beach, a ski run or a bedroom floor.
  p.models = { "prop-hay", "prop-crate", "tent-open", "construction-light" };
  p.scatterDensity = 0.28f;
  p.scatter = { { 0, 0.40f, 0.85f, 0.4f, false, true }, { 1, 0.22f, 0.9f, 0.25f },
                { 2, 0.22f, 2.0f, 0.5f }, { 3, 0.16f, 2.4f, 0.4f, true, true } };
  return p;
}

Theme grassTheme() {
  Theme t;
  t.sky[0] = 0x59a7e8; t.sky[1] = 0x8ecae6; t.sky[2] = 0xc8e9f2;
  t.fog = 0x8ecae6;
  t.boost = 0x22c9b6;  // the classic teal — the canonical backyard accent
  t.hemi = { 0xffffff, 0x9aa68f, 2.2f };
  t.key = { 0xfff1d0, 1.4f };
  t.groundKind = GROUND_LAWN;
  t.hills = { 0x8cc578, 0x7cb86a, 0x9bce86 };
  // The Backyard is a PLACE, not the default: garden clutter trackside, drifting
  // pollen in the sun, and a hot-air balloon over the meadow.
  ambientKind(t.ambient, AMB_POLLEN); t.ambient.count = 7; t.ambient.tint = 0xfff2c4;
  t.balloon = { { 0xd94f3d, 0xf5f0e2 }, 44, 6 };
  t.landmarks = { LM_GNOME, LM_DOGHOUSE, LM_PICNIC };
  t.scenery = grassScenery();
  t.props = gardenProps();  // hay bales and toy crates on the verge
  deriveRoad(t.road, false, false, false);
  return t;
}

// ── sunset — golden hour over the grass world (no cup since the stunt cup went
// playroom; reachable via ?biome=sunset). SAME grass ground + scenery as grass:
// the warm key light alone turns the green grass golden.
Theme sunsetTheme() {
  Theme t;
  t.sky[0] = 0x5e74c0; t.sky[1] = 0xffb878; t.sky[2] = 0xffd9a8;
  t.fog = 0xffb878;
  t.boost = 0x4f7ce6;  // deep sky blue — teal turns muddy in the warm key
  t.hemi = { 0xffd0a0, 0x8c7a66, 2.0f };
  t.key = { 0xffa850, 1.55f };
  t.groundKind = GROUND_LAWN;
  t.hills = { 0xc69a86, 0xb98a72, 0xd0a890 };
  ambientKind(t.ambient, AMB_POLLEN); t.ambient.count = 8; t.ambient.tint = 0xffd9a0;
  t.balloon = { { 0xf2c14e, 0x8a76d8 }, 46, 6 };
  t.landmarks = { LM_GNOME, LM_DOGHOUSE, LM_PICNIC };  // the same backyard, later in the day
  t.scenery = grassScenery();
  t.props = gardenProps();  // the same garden, later in the day
  deriveRoad(t.road, false, false, false);
  return t;
}

// ── beach — the Easy on-ramp biome. A turquoise water ring surrounds the sand
// past the dunes, and the dune hills rise out of it as headlands.
Theme beachTheme() {
  Theme t;
  t.sky[0] = 0x37b4e6; t.sky[1] = 0xbfe7ec; t.sky[2] = 0xcdeef0;
  t.fog = 0xbfe7ec;
  t.boost = 0x1fc0c9;  // bright aqua — the one biome whose accent echoes its scenery
  t.hemi = { 0xffffff, 0xd2bd8a, 2.35f };
  t.key = { 0xfff0cf, 1.55f };
  t.groundKind = GROUND_SAND;
  // Two dune tones + one scrub-grass green: a vegetated headland every third
  // feature keeps the coast from reading as bare desert dunes.
  t.hills = { 0xe6d29a, 0xefe2b3, 0x9fc48e };
  t.hillShape = HILL_ISLAND;  // the sea must show BETWEEN the hills
  // `wet` is the damp-sand tint: the SAND's own hue taken darker and MORE
  // saturated, because water deepens sand's colour.
  t.hasWater = true;
  t.water.foam = 0xf2fbf5; t.water.shallow = 0x62d3c8;
  t.water.deep = 0x2596c8; t.water.wet = 0x7d5f34;
  t.fogTune = 1.3f;  // clear seaside air: the water must read from track level
  // Sun-bleached coastal asphalt — the CANONICAL circuit road, just lighter and
  // warmer, as if years of salt sun baked it.
  t.road.asphalt = 0x6c6a74;
  deriveRoad(t.road, false, false, false);
  t.structure = 0x9a7b55;  // overpass supports stay timber piles — pier flavour
  t.landmarks = { LM_LIGHTHOUSE, LM_SAILBOAT, LM_UMBRELLA, LM_SANDCASTLE };
  // Gulls working the shoreline, flapping busily.
  t.birds.count = 4; t.birds.tint = 0x51616d; t.birds.size = 3.0f; t.birds.y = 13;
  t.birds.rc = 100; t.birds.rb = 32; t.birds.speed = 0.26f; t.birds.flap = 1; t.birds.flapHz = 2.1f;
  t.kites.count = 2; t.kites.tints = { 0xd94f3d, 0x3f8fd1 }; t.kites.size = 2.8f; t.kites.y = 13;
  t.gate = 0xfff1de;  // sun-bleached gate grade
  t.gantry.pylon = 0xfff6eb; t.gantry.hasRings = true; t.gantry.rings = 0xff5040;
  t.gantry.finial = 0xff5040;  // lighthouse posts — echoes the beacon landmark
  // Palms over weathered sandstone boulders, scattered sparser than parkland so
  // the beach reads open and airy.
  ScenerySpec& s = t.scenery;
  s.trees = { { "palm-tall", 0.55f, 1.6f, 0.6f }, { "palm-bend", 0.45f, 1.5f, 0.6f } };
  s.hasBush = false;
  s.mixTree = 0.45f; s.mixBush = 0.45f;  // no bushes; the rest rolls "rock"
  s.rocks = { 0xdccfa8, 0xcfbd90, 0xbca878 };
  s.rockS[0] = 0.55f; s.rockS[1] = 0.75f;  // boulder-sized, not pebbles
  s.density = 0.5f;
  // Tide-line finds close to the road, in the beach's warm coral/cream family.
  s.clutter = { { CL_SHELL, 0.45f, { 0xf5ead8, 0xecc8b4, 0xd9b8c4 } },
                { CL_STARFISH, 0.3f, { 0xe4784f, 0xd95f6a } },
                { CL_DRIFTWOOD, 0.25f, { 0xcbb794, 0xb8a686 } } };
  s.clutterDensity = 0.28f;
  deriveModels(s);
  // Washed-up freight above the tide line: crates. No rowing boats: the
  // scatter stands by the road, a long way up the sand from the water, and
  // a boat there was left high and dry. No fence — the coast stays open to
  // the water. The pirate leavings are Cove's alone (pirateCove, applied in
  // resolve_theme): a chest or a cannon on every beach told the cup one
  // story four times.
  t.props.models = { "prop-crate" };
  t.props.scatterDensity = 0.11f;
  t.props.scatter = { { 0, 1.0f, 0.9f, 0.3f } };
  return t;
}

// Cove is a pirate island and nothing else. The holiday beach goes: its
// lighthouse, sailboat, parasol and sandcastle landmarks, the kites, and the
// lighthouse bands on the gantry, whose posts stand as timber instead. The
// pirate leavings come in as its props. Sand, sea, palms, rocks, shells and
// gulls are the island's own and stay. The Pirate Kit is authored large
// against a toy car (its barrel is taller than one), so its pieces stand at
// about half size, and the small ones stand on the verge.
void pirateCove(Theme& t) {
  t.landmarks.clear();
  t.kites.count = 0;
  t.kites.tints.clear();
  t.gantry.pylon = t.structure;
  t.gantry.hasRings = false;
  t.gantry.finial = 0x38383d;
  // Its boats are on the water (the ship's longboat, the one tied at the
  // jetty), none left on the sand by the road.
  t.props.models = { "prop-crate", "pirate-barrel", "pirate-chest", "pirate-crate",
                     "pirate-cannon", "pirate-flag" };
  t.props.scatterDensity = 0.24f;
  t.props.scatter = { { 0, 0.12f, 0.9f, 0.3f }, { 1, 0.23f, 0.42f, 0.12f, false, true },
                      { 2, 0.15f, 0.42f, 0.1f, false, true }, { 3, 0.2f, 0.55f, 0.15f },
                      { 4, 0.16f, 0.5f, 0.1f, true, true }, { 5, 0.14f, 0.5f, 0.15f } };
}

// The other three beaches each tell their own story, and the holiday
// postcard (lighthouse, sailboat, parasol, sandcastle) only stays where it
// belongs to it. Sand, sea, palms, shells and gulls are the island's own.
//
// Tidepool is the reef at low tide: no postcard and no kites, the boulders
// the reef's own grey stone, starfish and shells on the sand rather than
// driftwood, and the gantry's posts the grey of the reef banded in the
// shallows' teal.
void lowTideReef(Theme& t) {
  t.landmarks.clear();
  t.kites.count = 0;
  t.kites.tints.clear();
  t.gantry.pylon = 0x9aa1b4; t.gantry.hasRings = true; t.gantry.rings = 0x1fc0c9;
  t.gantry.finial = 0xe4784f;
  ScenerySpec& s = t.scenery;
  s.rocks = { 0x9aa1b4, 0x868ba1, 0x7b8194 };
  s.clutter = { { CL_SHELL, 0.45f, { 0xf5ead8, 0xecc8b4, 0xd9b8c4 } },
                { CL_STARFISH, 0.55f, { 0xe4784f, 0xd95f6a, 0xf2c14e } } };
  t.props.models = { "prop-crate" };
  t.props.scatter = { { 0, 1.0f, 0.9f, 0.3f } };
  t.props.scatterDensity = 0.1f;
}

// Driftwood is a storm beach: the gulls more of them and harder at it in the
// wind, no kites, no parasol or sandcastle (and no sailboat out in that sea);
// the lighthouse stays, it is a storm coast. Driftwood lies thick along the
// tide line, the freight the sea brought in is crates, and the gantry is
// timber, like the trunk.
void stormBeach(Theme& t) {
  t.landmarks = { LM_LIGHTHOUSE };
  t.kites.count = 0;
  t.kites.tints.clear();
  t.birds.count = 6; t.birds.speed = 0.34f; t.birds.flapHz = 2.8f;
  t.gantry.pylon = 0x8a6a46; t.gantry.hasRings = false; t.gantry.finial = 0xfff6eb;
  ScenerySpec& s = t.scenery;
  s.clutter = { { CL_DRIFTWOOD, 0.55f, { 0xcbb794, 0xb8a686, 0x9a8a70 } },
                { CL_SHELL, 0.3f, { 0xf5ead8, 0xecc8b4 } },
                { CL_STARFISH, 0.15f, { 0xe4784f } } };
  s.clutterDensity = 0.36f;
  t.props.models = { "prop-crate" };
  t.props.scatter = { { 0, 1.0f, 0.9f, 0.3f } };
  t.props.scatterDensity = 0.22f;
}

// Riptide is the surf patrol's beach: its parasols and its tower are the
// holiday here, so the procedural parasol and sandcastle go; the lighthouse,
// the sailboat and the kites stay, and the gantry keeps the lifeguard's red
// and white.
void surfPatrol(Theme& t) {
  t.landmarks = { LM_LIGHTHOUSE, LM_SAILBOAT };
}

// The snow cup's four tracks are four places, so each carries its own idea
// round the lap past its set pieces: the scatter's Holiday Kit leavings, and
// where it says something, the kerb banks and the gantry. One entry per
// scatter model: (name, weight, s0, s1, face, verge).
struct SnowProp { const char* model; float w, s0, s1; bool face, verge; };
void snowProps(Theme& t, std::initializer_list<SnowProp> list) {
  t.props.models.clear();
  t.props.scatter.clear();
  for (const SnowProp& p : list) {
    t.props.scatter.push_back({ (uint32_t) t.props.models.size(), p.w, p.s0, p.s1, p.face, p.verge });
    t.props.models.push_back(p.model);
  }
}

// A road through the snow is edged by what the plough threw up, not by a
// racing kerb: a lumpy white bank up to a little over a car's wheel, slush
// on its road face (RoadPalette::kerbBank). Every snow track but the resort,
// whose banks are its race course's.
void ploughBanks(Theme& t) {
  t.road.kerbA = 0xf3f7fb; t.road.kerbB = 0xf3f7fb;
  t.road.kerbH = 0.42f;
  t.road.kerbBank = true; t.road.kerbSlush = 0xa3aab4;
}

// Powder is a ski resort: the banks are the race course's red and blue gate
// colours, the gantry's posts banded like slalom poles, and what lies about
// is the guests' (a snowman by the road, sleds), at their real size beside a
// car: the kit's snowman is a unit tall and its sled a unit long, twice the
// real thing. At that size more of them clear the spacing rule, so they are
// rolled less often, and the verge carries fewer of them (the kit snowman is
// a heavy model, and the resort's chalets and lift spend that budget).
void powderResort(Theme& t) {
  t.props.scatterDensity = 0.18f;
  t.road.kerbA = 0xf2877c; t.road.kerbB = 0x86a9e6;
  t.gantry.hasRings = true; t.gantry.rings = 0xff5040;
  snowProps(t, { { "snowman", 0.12f, 0.45f, 0.1f, true, true }, { "sled", 0.25f, 0.4f, 0.1f, false, true },
                 { "snow-pile", 0.38f, 1.0f, 0.6f, false, false }, { "set-snow-boulder", 0.25f, 0.6f, 0.3f, false, false } });
}

// Flurry is a frozen lake below a village: open snow round the ice (fewer
// pines, which also pays for the lake on the long view down its middle leg),
// sleds left by the road for the slope down to the ice; its one snowman is
// the set's, on the lake.
void flurryLake(Theme& t) {
  ploughBanks(t);
  t.scenery.density = 0.42f;
  t.props.scatterDensity = 0.28f;
  snowProps(t, { { "sled", 0.35f, 0.4f, 0.1f, false, true }, { "snow-pile", 0.35f, 1.0f, 0.6f, false, false },
                 { "set-snow-boulder", 0.15f, 0.6f, 0.3f, false, false }, { "snow-bunker", 0.15f, 1.0f, 0.3f, false, false } });
}

// Glacier is wild ice: no cabin and no village leavings, few trees (open
// snow, where the penguins read), rock the ice dropped.
void penguinGlacier(Theme& t) {
  t.landmarks.clear();
  t.scenery.density = 0.3f;
  t.fogTune = 1.2f;  // clear alpine air: the range a lap's length away must read from the opening
  ploughBanks(t);
  snowProps(t, { { "snow-pile", 0.35f, 1.0f, 0.6f, false, false }, { "set-snow-boulder", 0.45f, 0.6f, 0.6f, false, false },
                 { "snow-bunker", 0.20f, 1.0f, 0.3f, false, false } });
}

// Avalanche is a pass under a slope that lets go: tumbled snow along the
// road, young spruce growing back on the verge and now and then a trunk a
// slide snapped (no lone rock on the open snow: it read as dropped crates;
// its rock is the cirque's and the cuts'), and the gantry's posts banded
// orange and black like the avalanche poles that mark a road through a
// slide path.
void avalanchePass(Theme& t) {
  ploughBanks(t);
  t.gantry.pylon = 0xff7e44; t.gantry.hasRings = true; t.gantry.rings = 0x38383d;
  snowProps(t, { { "snow-pile", 0.55f, 1.0f, 0.6f, false, false }, { "set-snow-sapling", 0.35f, 1.0f, 0.25f, false, false },
                 { "set-snow-log", 0.1f, 1.0f, 0.2f, false, true } });
}

// Each playroom track is one game played on the floor at the toy cars' own
// scale, and the finish gantry wears the track's colours (the snake's green
// and yellow, the sky's blue, the marbles' purple, the castle's red).
void playroomTrack(Theme& t, const std::string& track) {
  if (track == "skysnake") {
    t.gantry.pylon = 0x5cb168; t.gantry.finial = 0xf2c14e;
  } else if (track == "skyline") {
    t.gantry.pylon = 0x5a8fd8; t.gantry.finial = 0xfff6eb;
    // the skyway's U stands on stacked toy blocks in two of the rails' blues,
    // so under a town of coloured blocks they read as the track's own
    // supports, not more towers
    t.structureStack = { 0x4a6fc4, 0x6f93df };
  } else if (track == "helix") {
    t.gantry.pylon = 0xa878e8; t.gantry.finial = 0xe66a5a;
    // the skyway and both spirals stand on one plain connector blue: a
    // striped stack is a station of the marble run, and posts banded in two
    // blues still striped into a picket along the kerb
    t.structureStack = { 0x4a6fc4 };
    // the marble run's own pieces fill the floor; the loose blocks and
    // marbles strewn across it read as coloured specks at distance
    t.scenery.density = 0.08f;
    t.scenery.clutterDensity = 0.05f;
  } else if (track == "gauntlet") {
    t.gantry.pylon = 0xe66a5a; t.gantry.finial = 0xf2c14e;
    // the bridge past the ring stands on the castle's stacked toy blocks
    t.structureStack = { 0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c };
  }
}

// The backyard cup's four gardens, each one idea at the tiny world's own
// scale, where a car is a car: Ribbon's village, Pretzel's treehouse,
// Tangle's mill stream, Cloverleaf's playground (their set pieces and land
// carry it). The grass biome's gnome, kennel and picnic are giants at that
// scale, so no garden keeps them; its verge things stand at their real size
// (a hay bale a third of a car, a tent half one) and what is smaller than
// that is left out. Each garden wears its idea on the kerbs and the gantry.
// A track's tree family: the scatter's weights by model, the rest at none.
void lawnTrees(Theme& t, std::initializer_list<std::pair<const char*, float>> mix) {
  for (TreeSpec& tr : t.scenery.trees) {
    tr.w = 0;
    for (const auto& m : mix) if (tr.model == m.first) tr.w = m.second;
  }
}

void backyardTrack(Theme& t, const std::string& track) {
  if (track != "ribbon" && track != "pretzel" && track != "tangle" && track != "cloverleaf") return;
  t.landmarks.clear();
  t.props.models = { "prop-hay", "tent-open" };
  t.props.scatter = { { 0, 0.7f, 0.34f, 0.08f, false, true }, { 1, 0.3f, 0.7f, 0.15f } };
  if (track == "ribbon") {
    // The village: hay bales on the lane's verge, no tents. Fewer
    // wildflowers (a patch costs more vertices than a cottage) and a few
    // fewer trees, so the village fits the frame the washing lines had.
    // The kerbs the maypole's blue, the gantry white like the cottages.
    t.props.models = { "prop-hay" };
    t.props.scatter = { { 0, 1.0f, 0.34f, 0.08f, false, true } };
    t.scenery.clutterDensity = 0.12f;
    t.scenery.density = 0.55f;
    // The orchard's round trees and poplars of the same make.
    lawnTrees(t, { { "set-tree-apple", 0.5f }, { "set-tree-poplar", 0.5f } });
    t.road.kerbA = 0x339cf2;
    t.gantry.pylon = 0xf8f8fb; t.gantry.finial = 0x339cf2;
  } else if (track == "pretzel") {
    // The children's summer: tents pitched round the garden. Timber kerbs
    // and gantry, the treehouse's. Fewer wildflowers: the road lies on the
    // lawn, so its whole verge is open to them, and a patch costs more
    // vertices than a tent.
    t.props.scatter = { { 0, 0.4f, 0.34f, 0.08f, false, true }, { 1, 0.6f, 0.7f, 0.15f } };
    t.scenery.clutterDensity = 0.15f;
    t.road.kerbA = 0xb08a5a;
    t.gantry.pylon = 0xb08a5a; t.gantry.finial = 0x22c46e;
    // High summer on the downs: the garden's broadleaf oaks, well apart,
    // and the far hills gone to hay.
    lawnTrees(t, { { "set-tree-oak", 1.0f } });
    t.scenery.density = 0.4f;
    t.hills = { 0xb7bf6c, 0xa8b160, 0xc5cb7e };
    t.groundBase = 0xa2b654;
  } else if (track == "tangle") {
    // The mill's water meadows: open grass mown along the stream, so the
    // stream reads across it, fewer trees and wildflowers (the hose's lawn
    // used to keep both off half the map), the hay made and no tents (a
    // tent in a mill's meadow told no story). Meadow-green kerbs and gantry.
    t.props.models = { "prop-hay" };
    t.props.scatter = { { 0, 1.0f, 0.34f, 0.08f, false, true } };
    t.scenery.clutterDensity = 0.1f;
    t.scenery.density = 0.6f;
    // A wooded valley: tall dark alders and the stream's willows, dark hills beyond.
    lawnTrees(t, { { "set-tree-alder", 0.8f }, { "set-tree-willow", 0.2f } });
    t.hills = { 0x5f9f6a, 0x4f8f5c, 0x6fae78 };
    t.groundBase = 0x4f9a58;
    t.road.kerbA = 0x2bb673;
    t.gantry.pylon = 0x2bb673; t.gantry.finial = 0xffc044;
  } else if (track == "cloverleaf") {
    // The park: the gantry in the climbing frame's blue. Fewer wildflowers,
    // as on Pretzel: the road lies on the grass, its verge open to them.
    t.scenery.clutterDensity = 0.15f;
    // The park's trees are its cherries, in blossom.
    // No tents or hay bales on a town park's lawn.
    t.props.scatterDensity = 0.0f;
    // Thin on the open lawn: a park plants its trees in avenues and groves
    // (the set).
    lawnTrees(t, { { "set-tree-cherry", 0.55f }, { "set-tree-cherry-white", 0.45f } });
    t.scenery.density = 0.26f;
    t.gantry.pylon = 0x339cf2; t.gantry.finial = 0xff5040;
  }
}

// ── canyon — hot red-rock badlands (the Hard cup's biome). The air itself is
// the signature: fogTune pulls the chase-cam fog in and low dust banks drift
// across the mesas.
Theme canyonTheme() {
  Theme t;
  t.sky[0] = 0x4292d4; t.sky[1] = 0xe8c8a2; t.sky[2] = 0xf4e3c6;
  t.fog = 0xe8c8a2;
  t.boost = 0x7a4fd0;  // violet — teal/aqua washes out in the sand-fog
  t.hemi = { 0xffeedd, 0xb9825e, 2.15f };
  t.key = { 0xffdca6, 1.6f };
  t.groundKind = GROUND_REDROCK;
  t.hills = { 0xc47a52, 0xa96545, 0xd68f62 };
  t.hillShape = HILL_MESA;  // flat-topped buttes, not meadow mounds
  // Bone-dry air: a few high, stretched, barely-there wisps with a warm dust tint.
  t.clouds = { 3, 0.3f, 1.35f, 0.2f, 0xfff2e2 };
  t.fogTune = 0.72f;  // sand-fog starts noticeably closer than clear air
  t.haze = { 4, 0.16f, 0xe9c9a0, 1 };  // blowing dust at mesa height
  // Desert highway: sun-baked warm asphalt, NO painted edge lines (a dusty
  // shoulder fades to the kerb instead), a faded-yellow centre dash.
  t.road.asphalt = 0x6e6560;
  t.road.dash = 0xd9b054;
  t.road.edgeLines = false;
  t.road.shoulder = 0x7d6f5f;
  t.road.kerbA = 0xc06a42; t.road.kerbB = 0xe3cfa4;  // rust / sand
  deriveRoad(t.road, /*dashSet=*/true, false, /*shoulderSet=*/true);
  // Grit on the wind: fast low sand streaks under the drifting dust banks.
  ambientKind(t.ambient, AMB_SAND); t.ambient.count = 240; t.ambient.tint = 0xe9c9a0;
  t.structure = 0xb4714d;  // supports read as red-rock columns, not city concrete
  t.landmarks = { LM_HOODOO };
  // Vultures riding a thermal — soaring, barely a wing-beat.
  t.birds.count = 2; t.birds.tint = 0x3a322c; t.birds.size = 3.6f; t.birds.y = 36;
  t.birds.rc = 150; t.birds.rb = 20; t.birds.speed = 0.1f; t.birds.flap = 0.15f; t.birds.flapHz = 0.5f;
  t.gate = 0xffdec2;  // hot dusty gate grade
  t.gantry.pylon = 0x8a5f3e; t.gantry.finial = 0xfff6eb;  // weathered timber posts
  // Saguaros as the signature silhouette, barrel cacti as the low accent.
  ScenerySpec& s = t.scenery;
  s.trees = { { "cactus-tall", 0.6f, 2.3f, 0.7f }, { "cactus-short", 0.4f, 1.15f, 0.55f } };
  s.hasBush = false;
  s.mixTree = 0.4f; s.mixBush = 0.4f;
  s.rocks = { 0xc07a55, 0xa8623f, 0xd39a70 };  // rust -> dusty ochre family
  s.rockS[0] = 0.6f; s.rockS[1] = 0.9f;
  s.density = 0.45f;  // sparser than the shore; deserts read empty on purpose
  // Scrub and red pebbles only: no driftwood, which is the beach's (and dead
  // wood reads as the trees a canyon has none of).
  s.clutter = { { CL_SCRUB, 0.62f, { 0x8a8f56, 0x7c8a4e, 0x9c9460 } },
                { CL_PEBBLES, 0.38f, { 0xc07a55, 0xa8623f, 0xd39a70 } } };
  s.clutterDensity = 0.25f;
  deriveModels(s);
  // Supply crates and barrels by the road, among sandstone rocks and stone
  // heaps (Survival Kit, Mini Forest — both authored small, so they stand well
  // over their own size). The crates and barrels are on the verge, where they
  // read; the barrel is the beach's, at the beach's size. The list is every
  // canyon track's: the shell stages a BIOME's props (ttp_theme_prop_models
  // resolves no track), so a track picks among these by slot in its scatter
  // (canyonTrack) and never re-lists them. A list of its own would bind its
  // slots to the biome's models: rocks drawn as crates, lamps as barrels.
  t.props.models = { "prop-crate", "pirate-barrel", "rock-sand", "stones", "prop-hay", "construction-light" };
  t.props.scatterDensity = 0.24f;
  t.props.scatter = { { 0, 0.22f, 0.9f, 0.3f, false, true }, { 1, 0.26f, 0.42f, 0.12f, false, true },
                      { 2, 0.30f, 1.5f, 0.6f }, { 3, 0.22f, 1.4f, 0.5f } };
  return t;
}

// Each canyon track tells its own story (its `set` and `land` in tracks.js),
// and the biome's scatter and structures follow it. The props are re-chosen
// from the biome's list by slot (0 crate, 1 barrel, 2 sandstone rocks,
// 3 stones, 4 hay, 5 road-works lamp): no story gets another's leftovers. The
// hoodoos stand on every track: they are the badlands themselves, not a story.
//   wash        a dry wash and its canyon: the rock alone, rocks and stones
//   gulch       a gold mine: timber supports like a trestle, crates and
//               barrels of supplies, broken stone, no hay
//   crag        a ranch in butte country: hay by the fences, a barrel, rocks
//   sidewinder  a desert highway: road-works lights on the verge, stones
void canyonTrack(Theme& t, const std::string& track) {
  if (track == "wash") {
    t.props.scatter = { { 2, 0.55f, 1.6f, 0.6f }, { 3, 0.45f, 1.4f, 0.5f } };
  } else if (track == "gulch") {
    t.structure = 0x8a6a46;  // timber, like the mine's own trestles
    t.props.scatter = { { 0, 0.34f, 0.6f, 0.2f, false, true }, { 1, 0.30f, 0.3f, 0.08f, false, true },
                        { 3, 0.36f, 1.4f, 0.5f } };
  } else if (track == "crag") {
    t.props.scatter = { { 4, 0.30f, 0.6f, 0.25f, false, true }, { 1, 0.16f, 0.3f, 0.08f, false, true },
                        { 2, 0.30f, 1.5f, 0.6f }, { 3, 0.24f, 1.4f, 0.5f } };
  } else if (track == "sidewinder") {
    t.props.scatter = { { 5, 0.22f, 2.4f, 0.4f, true, true }, { 2, 0.42f, 1.5f, 0.6f },
                        { 3, 0.36f, 1.4f, 0.5f } };
  }
}

// ── snow — winter alpine (the Medium rung of the ladder). Scenery leans on one
// trick: PINES ONLY. Dropping the round oak and the bushes makes the same kit
// assets read "winter forest" with zero new models.
Theme snowTheme() {
  Theme t;
  t.sky[0] = 0x6f9fd4; t.sky[1] = 0xdfe9f2; t.sky[2] = 0xf3f8fc;
  t.fog = 0xdfe9f2;
  t.boost = 0x2f7de0;  // ski-gate blue — dark-on-white reads on the pale deck
  t.hemi = { 0xedf3fc, 0xb2bdcc, 2.25f };
  t.key = { 0xf4f8ff, 1.45f };
  t.groundKind = GROUND_SNOW;
  t.hills = { 0xeef4f9, 0xdfe9f2, 0xf7fafc };
  t.clouds = { 6, 0.55f, 1.25f, 0.3f, 0xe9edf2 };  // low flat overcast
  // Wet ploughed asphalt between snowbanks: a darker, colder deck (free contrast
  // against the white ground), ice-tinted paint, and kerbs that become plain
  // white banks — wider and taller than a racing kerb.
  t.road.asphalt = 0x494f5e;
  t.road.line = 0xc2d6e6;
  t.road.kerbA = 0xeff4f9; t.road.kerbB = 0xdde7f0;  // whisper-contrast bank pair
  t.road.kerbW = 0.55f; t.road.kerbH = 0.3f;         // squat ploughed bank, not a kerb
  deriveRoad(t.road, false, false, false);
  ambientKind(t.ambient, AMB_FLAKE);
  t.ambient.count = 3200; t.ambient.size = 0.3f; t.ambient.tint = 0xffffff;
  // A pair of geese crossing high.
  t.birds.count = 2; t.birds.tint = 0x555b66; t.birds.size = 3.4f; t.birds.y = 32;
  t.birds.rc = 140; t.birds.rb = 24; t.birds.speed = 0.12f; t.birds.flap = 0.7f; t.birds.flapHz = 1.3f;
  // Oil slicks read as black stains on ploughed snow — reskin them as ICE
  // sheets. Same spin-out, same cones.
  t.hasIce = true; t.ice = { 0xa9d7ee, 0xf0f8fd };
  t.gate = 0xdfe9f6;  // cold-cast gate grade
  t.gantry.pylon = 0x3f7bd9; t.gantry.finial = 0xfff6eb;  // pops against the white world
  // The snowman that used to head this list is a Holiday Kit model now, in the
  // prop scatter below — one greeter a track became several a lap.
  t.landmarks = { LM_CABIN };
  // Snow-capped pines from the Holiday Kit — three variants so a treeline never
  // reads as stamped clones.
  ScenerySpec& s = t.scenery;
  s.trees = { { "tree-snow-a", 0.4f, 1.05f, 0.4f },
              { "tree-snow-b", 0.35f, 1.05f, 0.4f },
              { "tree-snow-c", 0.25f, 1.05f, 0.4f } };
  s.hasBush = false;
  s.mixTree = 0.55f; s.mixBush = 0.55f;
  // NO boulder palette: the flat-shaded grey granite this cup used to scatter
  // sat wrong beside the snow-capped rock in the props below, which is the
  // rock this biome has now. An empty palette places none (buildScenery).
  s.rocks = {};
  s.density = 0.55f;
  s.clutter = { { CL_DRIFT, 1, { 0xf3f7fb, 0xe9eff6 } } };  // wind-blown snow heaps
  s.clutterDensity = 0.3f;
  deriveModels(s);
  // The snow the crates used to stand in for: a greeter by the road, sleds left
  // out, wind-heaped drifts, all Holiday Kit, and faceted rock (the kit's read
  // as stacked crates; set_prototypes.py snow_boulder, at its scale). The SNOWMAN
  // is here rather than in the landmark list it used to head, because a scatter
  // gives several a lap where a landmark gives one a track — and it is the same
  // object either way.
  t.props.models = { "snowman", "sled", "snow-pile", "set-snow-boulder", "snow-bunker" };
  t.props.scatterDensity = 0.34f;
  t.props.scatter = { { 0, 0.18f, 1.0f, 0.3f, true, true },  // snowman, at the kerb facing the cars
                      { 1, 0.16f, 1.0f, 0.3f, false, true }, // sled, left by the road
                      { 2, 0.20f, 1.0f, 0.6f },        // drift
                      { 3, 0.28f, 0.6f, 0.6f },        // rock, small to big
                      { 4, 0.18f, 1.0f, 0.3f } };      // snow bunker
  return t;
}

// ── playroom — the stunt cup's biome: a toy racetrack set up on a sunlit
// playroom floor. Bright orange moulded-plastic deck between solid blue clip-on
// rails; indoors, but still broad daylight.
Theme playroomTheme() {
  Theme t;
  // Indoors there is no blue overhead: over the room's walls the zenith is a
  // warm ceiling, so a racer up on a deck sees no sky above a wall.
  t.sky[0] = 0xf6ecdc; t.sky[1] = 0xf3e3c3; t.sky[2] = 0xfaf0da;
  t.fog = 0xf3e3c3;
  t.boost = 0x39c24a;  // green — complementary pop on the orange deck
  t.hemi = { 0xfff2dc, 0xa88860, 2.2f };  // warm room light, wood-floor bounce
  t.key = { 0xffeac2, 1.5f };             // low afternoon sun through the window
  t.groundKind = GROUND_WOOD;
  // The room round the floor, past the fog: its walls' skirting board and the
  // wall over it, each picking its colour from this list by index (the
  // renderer's ROOM table): red, blue, yellow, green, skirting wood, wall linen.
  // hills[0] also tints the controller's cup panel, so the warm red keeps the
  // playroom distinct from beach sand / canyon clay.
  t.hills = { 0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c, 0xa8744a, 0xfdf4de };
  t.hillShape = HILL_ROOM;
  // Indoors: no cumulus, just faint warm puffs of sunbeam bloom.
  t.clouds = { 3, 0.22f, 1.3f, 0.3f, 0xffedd2 };
  t.fogTune = 1.25f;  // the tall stunt structures must read from track level
  // The star: orange moulded-plastic track.
  t.road.asphalt = 0xe8731f;   // toy-track orange (bright, not neon — soft-toy rule)
  t.road.dash = 0xfdf4de;      // printed cream lane decal — keeps the speedometer read
  t.road.edgeLines = false;    // moulded plastic has no painted lines
  t.road.patched = false;      // nor repairs — a patch on orange plastic is a stain
  t.road.kerbA = 0x3e6ed8; t.road.kerbB = 0x4677e0;  // solid blue snap-on rails
  t.road.kerbW = 0.26f; t.road.kerbH = 0.26f;        // beefier rail profile
  t.road.skirt = 0xc25e14;     // darker plastic underside/sides
  deriveRoad(t.road, /*dashSet=*/true, /*skirtSet=*/true, false);
  // Dust motes hanging in the window sunbeams, and a paper airplane on a long
  // lazy glide around the room (REAL 3D — a folded dart that banks into turns).
  ambientKind(t.ambient, AMB_MOTE); t.ambient.count = 11; t.ambient.tint = 0xffdf9e;
  t.hasPlane = true;
  t.plane.tint = 0xfaf7ec; t.plane.size = 3.2f; t.plane.y = 22;
  t.plane.rc = 95; t.plane.rb = 32; t.plane.speed = 0.3f; t.plane.bank = 0.4f;
  t.structure = 0x4a6fc4;  // support columns read as the kit's blue connectors
  // No procedural landmarks: the giant blocks, duck, ball, crayons and books
  // were everyday things at many times a toy car's scale. Each track's toys
  // are its set pieces, at their real size (tracks.js `set`); the retired
  // shapes live on in the asset gallery's model bench.
  t.landmarks.clear();
  t.gate = 0xfff3e2;  // warm indoor-light gate grade
  t.gantry.pylon = 0x5cb168; t.gantry.finial = 0xff5040;  // a third primary
  // No trees indoors — the "boulder" channel does all the work: a child's
  // building blocks left about the floor (cubes and long blocks, 3 to 7 cm,
  // the set pieces' own blocks), in the toys' painted primaries. Faceted
  // stones in those colours read as rocks, and a floor has none.
  ScenerySpec& s = t.scenery;
  s.hasBush = false;
  s.mixTree = 0; s.mixBush = 0;  // everything rolls "rock"
  s.rocks = { 0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c };
  s.rockS[0] = 0.5f; s.rockS[1] = 0.7f;  // a block's side
  s.rockBlocks = true;
  s.density = 0.35f;                     // floors are tidier than meadows
  s.clutter = { { CL_BRICK, 0.5f, { 0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c } },
                { CL_MARBLE, 0.3f, { 0x7db8e8, 0xe89a8a, 0x9cd89c } },
                { CL_DOMINO, 0.2f, { 0xf5f2ea } } };
  s.clutterDensity = 0.22f;
  deriveModels(s);
  // The toy train, as the Holiday Kit's own set on a ring of its own rails
  // (scripts/gen-trainset.mjs). ONE composed model, because a train set is one
  // object to a player and a dozen to a scatter: dropped in as pieces this
  // channel would strew rails across the floor. Drawn at a fixed 2x, because
  // the kit's train is smaller than its cars and should stand at least as
  // big as them; a ring that size is a landmark, so it is sparse.
  // A toy skateboard (a fingerboard's big brother, about 14 cm) left on the
  // floor stands at three and a half times its kit size, by the road.
  t.props.models = { "trainset", "skateboard" };
  // The ring keeps its own rate (0.03 a candidate) under the skateboard's
  // density: at 2.8k vertices it is the heaviest thing the scatter plants.
  t.props.scatterDensity = 0.18f;
  t.props.scatter = { { 0, 0.25f, 2.0f }, { 1, 0.75f, 3.5f, 0.5f, false, true } };
  return t;
}

// ---------------------------------------------------------------------------
// The table, and the two lookups over it.
// ---------------------------------------------------------------------------
struct BiomeEntry { const char* name; Theme (*build)(); };
// ORDER IS USER-VISIBLE: it is the ?biome= override list, in both the display's
// debug panel and the gallery.
const BiomeEntry kBiomes[] = {
  { "grass", grassTheme },
  { "sunset", sunsetTheme },
  { "beach", beachTheme },
  { "canyon", canyonTheme },
  { "snow", snowTheme },
  { "playroom", playroomTheme },
};
constexpr int kBiomeCount = (int) (sizeof(kBiomes) / sizeof(kBiomes[0]));

// Cup id -> biome name. Cups absent here (or an undefined cup) fall back to
// grass, so resolving is always safe with whatever a track carries.
struct CupBiome { const char* cup; const char* biome; };
const CupBiome kCupBiome[] = {
  { "beach", "beach" },
  { "snow", "snow" },
  { "backyard", "grass" },
  { "canyon", "canyon" },
  { "rooftop", "playroom" },  // the stunt cup — displayed as "Playroom Cup"; id kept for wiring
};

const BiomeEntry* findBiome(const char* name) {
  if (!name) return nullptr;
  for (const BiomeEntry& b : kBiomes) if (std::strcmp(b.name, name) == 0) return &b;
  return nullptr;
}

// ---------------------------------------------------------------------------
// Scenery model recolours (themes.js scenery[].tint).
// ---------------------------------------------------------------------------
// A plain hex repaints every material of the model; a map is keyed by each
// part's AUTHORED colour, as the six lowercase hex digits of its sRGB value.
struct TintPair { const char* key; uint32_t rgb; };
struct ModelTintDef {
  const char* model;
  bool scalar;
  uint32_t rgb;              // scalar only
  const TintPair* pairs;     // map only
  int nPairs;
};
// The tint maps recolour the Nature Kit's authored colours to this game's
// palette: turquoise fronds / terracotta trunk to tropical green / sun-bleached
// tan (palms), and the same turquoise to a dusty sage (cacti). Those authored
// colours are KENNEY'S OWN and not export damage — the Nature Kit is a
// flat-material kit that ships no colormap at all (its .mtl states
// `Kd 0.1607843 0.7882353 0.6705883`, and the kit's own render shows a
// turquoise palm), so this table is art direction rather than asset repair.
// Colormap-TEXTURED kit models have nothing to recolour, which is why no entry
// here names one.
//
// KEYED BY MODEL ALONE, deliberately. It used to carry a biome column, which
// read as "beach palms are green" but never actually meant it: no model appears
// under two biomes, so the column restated what the model name already said. It
// only ever DID something in the one place a model is staged outside its home
// biome — the asset gallery (ttp/showcase.h), which unions every biome's
// vocabulary into one scene and so drew untinted turquoise palms and cacti in
// five biomes out of six. A recolour is a property of the MODEL, so it resolves
// from the model.
const TintPair kPalmTall[] = { { "70e6d6", 0x4fae6b }, { "f2be9e", 0xc09a72 } };
const TintPair kPalmBend[] = { { "70e6d6", 0x54b573 }, { "f2be9e", 0xb8926c } };
const ModelTintDef kModelTints[] = {
  { "palm-tall", false, 0, kPalmTall, 2 },
  { "palm-bend", false, 0, kPalmBend, 2 },
  { "cactus-tall", true, 0x6da85c, nullptr, 0 },
  { "cactus-short", true, 0x7cb464, nullptr, 0 },
};

// glTF baseColorFactor is LINEAR; the theme's keys are authored as sRGB hex.
// Mirrors the JS byte for byte, Math.round included (floor(x + 0.5); every
// channel here lands at least 0.15 of a step clear of a boundary, so the
// platform pow's last ulp cannot move one).
std::string authoredKey(double r, double g, double b) {
  const auto ch = [](double c) -> int {
    const double s = c <= 0.0031308 ? c * 12.92 : 1.055 * std::pow(c, 1.0 / 2.4) - 0.055;
    return (int) std::floor(255.0 * s + 0.5);
  };
  char out[7];
  std::snprintf(out, sizeof out, "%02x%02x%02x", ch(r) & 0xff, ch(g) & 0xff, ch(b) & 0xff);
  return std::string(out);
}

}  // namespace

// The BOOST ACCENT used to live here. mix_hex + boost_shades are inline in
// theme.h now — the renderer is their biggest consumer and may not link this
// library. See the note there.

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------
int biome_count() { return kBiomeCount; }

const char* biome_name(int index) {
  return (index >= 0 && index < kBiomeCount) ? kBiomes[index].name : nullptr;
}

bool has_biome(const char* name) { return findBiome(name) != nullptr; }

const char* biome_for_cup(const char* cupId) {
  if (cupId && *cupId) {
    for (const CupBiome& c : kCupBiome) if (std::strcmp(c.cup, cupId) == 0) return c.biome;
  }
  return "grass";
}

const char* biome_for_track(const char* trackId) {
  const TrackDef* def = trackId ? find_track_def(trackId) : nullptr;
  return biome_for_cup(def ? def->cup : nullptr);
}

namespace {

// What one track patches over its biome's theme: its weather, its props, its
// carriers.
void patchTrack(Theme& t, const BiomeEntry* b, const std::string& track) {
  // Weather varies ACROSS the snow cup: each track patches the flake cloud, so
  // the four races read as four different winter days rather than one repeated
  // snow globe. A count is "particles in the camera box" (the renderer's
  // vpoint cloud wraps them around each view's camera), NOT over the map.
  // Glacier carries the highest count because its flakes are the cup's finest
  // — by count x size^2 it still lays less ink than flurry, an ice dust
  // rather than a heavy fall (powder is the lightest day of the four). The
  // renderer clamps at 9600.
  if (b && std::strcmp(b->name, "snow") == 0) {
    if (track == "powder") { t.ambient.count = 2800; t.ambient.size = 0.28f; powderResort(t); }
    else if (track == "flurry") { t.ambient.count = 4500; flurryLake(t); }
    else if (track == "glacier") { t.ambient.count = 6000; t.ambient.size = 0.22f; penguinGlacier(t); }
    else if (track == "avalanche") {
      t.ambient.count = 3600; t.ambient.size = 0.36f; t.ambient.wind = 1.6f;
      avalanchePass(t);
    }
  }

  // Each beach cup track is its own place (pirateCove and the three after it).
  if (b && std::strcmp(b->name, "beach") == 0) {
    if (track == "cove") pirateCove(t);
    else if (track == "tidepool") lowTideReef(t);
    else if (track == "driftwood") stormBeach(t);
    else if (track == "riptide") surfPatrol(t);
  }
  if (b && std::strcmp(b->name, "playroom") == 0) playroomTrack(t, track);
  if (b && std::strcmp(b->name, "grass") == 0) backyardTrack(t, track);

  // Each canyon track's own carriers (canyonTrack): its story's props and
  // structures.
  if (b && std::strcmp(b->name, "canyon") == 0) canyonTrack(t, track);

  // No procedural landmark beside a set piece that contradicts it. Where
  // the track's set has its own houses (Flurry's smoking log cabins, Powder's
  // chalets round the valley station, Avalanche's cabin by the crossing), the
  // procedural cabin goes: never a lone cabin beside a village of other ones,
  // nor two cabins.
  const auto drop = [&](uint32_t k) {
    t.landmarks.erase(std::remove(t.landmarks.begin(), t.landmarks.end(), k), t.landmarks.end());
  };
  if (b && std::strcmp(b->name, "snow") == 0 && (track == "powder" || track == "flurry" || track == "avalanche")) {
    drop(LM_CABIN);
  }
}

// The prop<i>.glb slot order of a biome, which the shell fetches by the BIOME
// (ttp_theme_prop_models): the biome's own props, then each of its catalogue
// tracks' own in catalogue order. A track that patches its props (snowProps,
// pirateCove, ...) names its models in an order of its own, so resolve_theme
// puts its slots back into this one: left in its own, Glacier's snow piles
// drew as the biome's snowmen and its rocks as sleds.
std::vector<std::string> biomeProps(const BiomeEntry* b) {
  std::vector<std::string> out = b->build().props.models;
  for (int i = 0; i < TTP_TRACK_COUNT; i++) {
    if (std::strcmp(biome_for_track(TTP_TRACKS[i].id), b->name) != 0) continue;
    Theme x = b->build();
    patchTrack(x, b, TTP_TRACKS[i].id);
    for (const std::string& m : x.props.models) {
      if (std::find(out.begin(), out.end(), m) == out.end()) out.push_back(m);
    }
  }
  return out;
}

}  // namespace

Theme resolve_theme(const char* biomeName, const char* trackId) {
  const BiomeEntry* b = findBiome(biomeName);
  Theme t = (b ? b->build : grassTheme)();
  const std::string track = trackId ? trackId : "";
  patchTrack(t, b, track);
  if (b) {
    const std::vector<std::string> all = biomeProps(b);
    for (PropStamp& p : t.props.scatter) {
      p.slot = (uint32_t) (std::find(all.begin(), all.end(), t.props.models[p.slot]) - all.begin());
    }
    t.props.models = all;
  }

  // shorelineFn's per-track seed, so the island's lobes/crinkle/swash come out
  // identical wherever this runs. Track ids are ASCII, so hashing the UTF-8
  // bytes is what the JS charCodeAt loop did.
  if (t.hasWater) t.water.shoreSeed = fnv1a(track);

  // The set pieces, deduped into slots in first-appearance order — the order
  // the shell fetches them in (ttp_theme_set_models).
  const bool lite = detail_in_force() == Detail::Lite;
  if (const TrackDef* def = trackId ? find_track_def(trackId) : nullptr) {
    // A piece or a form authored `lite: false` is not in the lite tier's list
    // at all; a landform anchored on a piece (SET_GROUND) follows it to its
    // new index, and the generator refuses `lite: false` on such a piece.
    std::vector<int> pieceAt((size_t) def->nSet, -1);
    for (int i = 0; i < def->nSet; i++) {
      const SetDef& d = def->set[i];
      if (lite && !d.lite) continue;
      pieceAt[(size_t) i] = (int) t.set.pieces.size();
      uint32_t slot = 0;
      while (slot < t.set.models.size() && t.set.models[slot] != d.model) slot++;
      if (slot == t.set.models.size()) t.set.models.push_back(d.model);
      t.set.pieces.push_back({ slot, (float) d.u, (float) d.lat,
                               (float) (d.yaw * M_PI / 180.0), (float) d.y, (float) d.scale });
    }
    for (int i = 0; i < def->nLand; i++) {
      const LandDef& d = def->land[i];
      if (lite && !d.lite) continue;
      Landform l;
      l.kind = (uint32_t) d.kind; l.piece = d.piece < 0 ? d.piece : pieceAt[(size_t) d.piece];
      l.u = (float) d.u; l.lat = (float) d.lat; l.yaw = (float) (d.yaw * M_PI / 180.0);
      l.x = (float) d.x; l.z = (float) d.z; l.len = (float) d.len;
      l.r = (float) d.r; l.r1 = (float) d.r1; l.w = (float) d.w; l.rz = (float) d.rz;
      l.h = (float) d.h; l.h1 = (float) d.h1; l.top = (float) d.top; l.shape = (float) d.shape;
      l.tint = d.tint;
      l.near = (float) d.near;
      t.land.push_back(l);
    }
  }
  if (lite) {
    lite_models(t.scenery.models);
    lite_models(t.props.models);
    lite_models(t.set.models);
  }
  return t;
}

void lite_models(std::vector<std::string>& models) {
  for (std::string& m : models) {
    for (int i = 0; i < TTP_LITE_MODEL_COUNT; i++) {
      if (m == TTP_LITE_MODELS[i]) { m += "-lite"; break; }
    }
  }
}

std::vector<MatTint> resolve_model_tints(const std::string& model,
                                         const uint8_t* glb, size_t len) {
  std::vector<MatTint> out;
  // A lite build (<model>-lite.glb) is recoloured as the model it stands in for.
  const std::string base = model.size() > 5 && model.compare(model.size() - 5, 5, "-lite") == 0
      ? model.substr(0, model.size() - 5) : model;
  const ModelTintDef* def = nullptr;
  for (const ModelTintDef& d : kModelTints) {
    if (base == d.model) { def = &d; break; }
  }
  if (!def) return out;

  std::string text;
  if (!glb_json_chunk(glb, len, text)) return out;
  bool ok = false;
  const Value doc = json::parse(text.c_str(), &ok);
  if (!ok) return out;
  const Value* materials = doc.find("materials");
  if (!materials || materials->type != Value::ARR) return out;

  for (const Value& m : materials->arr) {
    const Value* nameV = m.find("name");
    const std::string name = (nameV && nameV->type == Value::STR) ? nameV->str : std::string();
    if (def->scalar) { out.push_back({ name, def->rgb }); continue; }
    double f[3] = { 1, 1, 1 };
    const Value* pbr = m.find("pbrMetallicRoughness");
    const Value* factor = pbr ? pbr->find("baseColorFactor") : nullptr;
    if (factor && factor->type == Value::ARR) {
      for (int i = 0; i < 3 && i < (int) factor->arr.size(); i++) {
        if (factor->arr[i].type == Value::NUM) f[i] = factor->arr[i].num;
      }
    }
    const std::string key = authoredKey(f[0], f[1], f[2]);
    for (int i = 0; i < def->nPairs; i++) {
      if (key == def->pairs[i].key) { out.push_back({ name, def->pairs[i].rgb }); break; }
    }
  }
  return out;
}

}  // namespace rt
}  // namespace ttp
