#include "ttp/theme.h"

#include <cmath>
#include <cstdio>
#include <cstring>

#include "ttp/canonical.h"
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
// (grass + sunset — golden light over the SAME trees is the sunset look). Every
// value is the VERBATIM pre-theming constant from buildScenery; do not drift it,
// or grass-cup tracks lose their byte-identical guarantee (scenery placement is
// seeded, so any changed literal reshuffles the whole scatter).
// ---------------------------------------------------------------------------
ScenerySpec grassScenery() {
  ScenerySpec s;
  s.trees = {
    { "tree", 0.65f, 2.3f, 1.1f },       // round oak — the staple
    { "tree-pine", 0.35f, 2.3f, 1.1f },  // pine as the accent
  };
  s.hasBush = true;
  s.bush = { "tree", 1.1f, 0.7f, 0.3f };
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
  ambientKind(t.ambient, AMB_POLLEN); t.ambient.count = 140; t.ambient.tint = 0xfff2c4;
  t.balloon = { { 0xd94f3d, 0xf5f0e2 }, 44, 6 };
  t.landmarks = { LM_GNOME, LM_DOGHOUSE, LM_PICNIC };
  t.scenery = grassScenery();
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
  ambientKind(t.ambient, AMB_POLLEN); t.ambient.count = 160; t.ambient.tint = 0xffd9a0;
  t.balloon = { { 0xf2c14e, 0x8a76d8 }, 46, 6 };
  t.landmarks = { LM_GNOME, LM_DOGHOUSE, LM_PICNIC };  // the same backyard, later in the day
  t.scenery = grassScenery();
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
  return t;
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
  ambientKind(t.ambient, AMB_SAND); t.ambient.count = 700; t.ambient.tint = 0xe9c9a0;
  t.structure = 0xb4714d;  // supports read as red-rock columns, not city concrete
  t.landmarks = { LM_HOODOO, LM_WINDMILL };
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
  s.clutter = { { CL_SCRUB, 0.5f, { 0x8a8f56, 0x7c8a4e, 0x9c9460 } },
                { CL_DRIFTWOOD, 0.22f, { 0xd8c8a8, 0xc4b494 } },
                { CL_PEBBLES, 0.28f, { 0xc07a55, 0xa8623f, 0xd39a70 } } };
  s.clutterDensity = 0.25f;
  deriveModels(s);
  return t;
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
  t.ambient.count = 1200; t.ambient.size = 0.3f; t.ambient.tint = 0xffffff;
  // A pair of geese crossing high.
  t.birds.count = 2; t.birds.tint = 0x555b66; t.birds.size = 3.4f; t.birds.y = 32;
  t.birds.rc = 140; t.birds.rb = 24; t.birds.speed = 0.12f; t.birds.flap = 0.7f; t.birds.flapHz = 1.3f;
  // Oil slicks read as black stains on ploughed snow — reskin them as ICE
  // sheets. Same spin-out, same cones.
  t.hasIce = true; t.ice = { 0xa9d7ee, 0xf0f8fd };
  t.gate = 0xdfe9f6;  // cold-cast gate grade
  t.gantry.pylon = 0x3f7bd9; t.gantry.finial = 0xfff6eb;  // pops against the white world
  t.landmarks = { LM_SNOWMAN, LM_CABIN };
  // Snow-capped pines from the Holiday Kit — three variants so a treeline never
  // reads as stamped clones.
  ScenerySpec& s = t.scenery;
  s.trees = { { "tree-snow-a", 0.4f, 1.05f, 0.4f },
              { "tree-snow-b", 0.35f, 1.05f, 0.4f },
              { "tree-snow-c", 0.25f, 1.05f, 0.4f } };
  s.hasBush = false;
  s.mixTree = 0.55f; s.mixBush = 0.55f;
  s.rocks = { 0xcdd4e0, 0xb9c1d0, 0x9fa8ba };  // cold blue-grey granite
  s.rockS[0] = 0.4f; s.rockS[1] = 0.6f;
  s.density = 0.55f;
  s.clutter = { { CL_DRIFT, 1, { 0xf3f7fb, 0xe9eff6 } } };  // wind-blown snow heaps
  s.clutterDensity = 0.3f;
  deriveModels(s);
  return t;
}

// ── playroom — the stunt cup's biome: a toy racetrack set up on a sunlit
// playroom floor. Bright orange moulded-plastic deck between solid blue clip-on
// rails; indoors, but still broad daylight.
Theme playroomTheme() {
  Theme t;
  t.sky[0] = 0x8cbcea; t.sky[1] = 0xf3e3c3; t.sky[2] = 0xfaf0da;
  t.fog = 0xf3e3c3;
  t.boost = 0x39c24a;  // green — complementary pop on the orange deck
  t.hemi = { 0xfff2dc, 0xa88860, 2.2f };  // warm room light, wood-floor bounce
  t.key = { 0xffeac2, 1.5f };             // low afternoon sun through the window
  t.groundKind = GROUND_WOOD;
  // Giant toy blocks scattered on the floor past the fog. hills[0] also tints
  // the controller's cup panel, so the warm red keeps the playroom distinct
  // from beach sand / canyon clay.
  t.hills = { 0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c };
  t.hillShape = HILL_BLOCK;
  // Indoors: no cumulus, just faint warm puffs of sunbeam bloom.
  t.clouds = { 3, 0.22f, 1.3f, 0.3f, 0xffedd2 };
  t.fogTune = 1.25f;  // the tall stunt structures must read from track level
  // The star: orange moulded-plastic track.
  t.road.asphalt = 0xe8731f;   // toy-track orange (bright, not neon — soft-toy rule)
  t.road.dash = 0xfdf4de;      // printed cream lane decal — keeps the speedometer read
  t.road.edgeLines = false;    // moulded plastic has no painted lines
  t.road.kerbA = 0x3e6ed8; t.road.kerbB = 0x4677e0;  // solid blue snap-on rails
  t.road.kerbW = 0.26f; t.road.kerbH = 0.26f;        // beefier rail profile
  t.road.skirt = 0xc25e14;     // darker plastic underside/sides
  deriveRoad(t.road, /*dashSet=*/true, /*skirtSet=*/true, false);
  // Dust motes hanging in the window sunbeams, and a paper airplane on a long
  // lazy glide around the room (REAL 3D — a folded dart that banks into turns).
  ambientKind(t.ambient, AMB_MOTE); t.ambient.count = 240; t.ambient.tint = 0xffdf9e;
  t.hasPlane = true;
  t.plane.tint = 0xfaf7ec; t.plane.size = 3.2f; t.plane.y = 22;
  t.plane.rc = 95; t.plane.rb = 32; t.plane.speed = 0.3f; t.plane.bank = 0.4f;
  t.structure = 0x4a6fc4;  // support columns read as the kit's blue connectors
  t.landmarks = { LM_BLOCKS, LM_DUCK, LM_BALL, LM_CRAYONS, LM_BOOKS, LM_TRAIN };
  t.gate = 0xfff3e2;  // warm indoor-light gate grade
  t.gantry.pylon = 0x5cb168; t.gantry.finial = 0xff5040;  // a third primary
  // No trees indoors — the "boulder" channel does all the work: faceted toy bits
  // in the same plastic primaries as the horizon blocks.
  ScenerySpec& s = t.scenery;
  s.hasBush = false;
  s.mixTree = 0; s.mixBush = 0;  // everything rolls "rock"
  s.rocks = { 0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c };
  s.rockS[0] = 0.5f; s.rockS[1] = 0.7f;  // chunky toy-piece scale
  s.density = 0.35f;                     // floors are tidier than meadows
  s.clutter = { { CL_BRICK, 0.5f, { 0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c } },
                { CL_MARBLE, 0.3f, { 0x7db8e8, 0xe89a8a, 0x9cd89c } },
                { CL_DOMINO, 0.2f, { 0xf5f2ea } } };
  s.clutterDensity = 0.22f;
  deriveModels(s);
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
  const char* biome;
  const char* model;
  bool scalar;
  uint32_t rgb;              // scalar only
  const TintPair* pairs;     // map only
  int nPairs;
};
// The tint maps recolour the Nature Kit's authored teal fronds / peach trunk to
// tropical green / sun-bleached tan (palms), and pick the cacti's dusty sage
// green. Colormap-TEXTURED kit models ignore tints, which is why the grass,
// sunset and snow palettes carry none.
const TintPair kPalmTall[] = { { "70e6d6", 0x4fae6b }, { "f2be9e", 0xc09a72 } };
const TintPair kPalmBend[] = { { "70e6d6", 0x54b573 }, { "f2be9e", 0xb8926c } };
const ModelTintDef kModelTints[] = {
  { "beach", "palm-tall", false, 0, kPalmTall, 2 },
  { "beach", "palm-bend", false, 0, kPalmBend, 2 },
  { "canyon", "cactus-tall", true, 0x6da85c, nullptr, 0 },
  { "canyon", "cactus-short", true, 0x7cb464, nullptr, 0 },
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

// ---------------------------------------------------------------------------
// Boost accent.
// ---------------------------------------------------------------------------
namespace {
// themes.js mixHex: blend a 0xRRGGBB toward white (t > 0) or black (t < 0).
uint32_t mixHex(uint32_t hex, double t) {
  const double to = t >= 0 ? 255.0 : 0.0, a = t < 0 ? -t : t;
  const auto m = [&](uint32_t c) -> uint32_t {
    return (uint32_t) std::floor((double) c + (to - (double) c) * a + 0.5);
  };
  return (m((hex >> 16) & 255) << 16) | (m((hex >> 8) & 255) << 8) | m(hex & 255);
}
}  // namespace

BoostShades boost_shades(uint32_t hex) {
  BoostShades s;
  s.base = hex;
  s.light = mixHex(hex, 0.55);    // pad-disc bright core (radial-gradient centre)
  s.dark = mixHex(hex, -0.42);    // pad-disc rim (radial-gradient edge)
  s.strip = mixHex(hex, -0.12);   // flat launch-strip body — reads as paint
  s.disk = mixHex(hex, 0.15);     // under-car aura tint: the SATURATED accent, small lift
  s.streak = mixHex(hex, 0.86);   // near-white wind streak with the accent's cast
  s.icon = mixHex(hex, -0.2);     // HUD item-chip stroke — darkened for paper
  return s;
}

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

Theme resolve_theme(const char* biomeName, const char* trackId) {
  const BiomeEntry* b = findBiome(biomeName);
  Theme t = (b ? b->build : grassTheme)();
  const std::string track = trackId ? trackId : "";

  // Weather varies ACROSS the snow cup: each track patches the flake cloud, so
  // the four races read as four different winter days rather than one repeated
  // snow globe. (themes.js ambientByTrack, merged over `ambient`.)
  if (b && std::strcmp(b->name, "snow") == 0) {
    if (track == "powder") { t.ambient.count = 1000; t.ambient.size = 0.28f; }
    else if (track == "flurry") { t.ambient.count = 2000; }
    else if (track == "glacier") { t.ambient.count = 550; t.ambient.size = 0.22f; }
    else if (track == "avalanche") { t.ambient.count = 1800; t.ambient.size = 0.36f; t.ambient.wind = 1.6f; }
  }

  // shorelineFn's per-track seed, so the island's lobes/crinkle/swash come out
  // identical wherever this runs. Track ids are ASCII, so hashing the UTF-8
  // bytes is what the JS charCodeAt loop did.
  if (t.hasWater) t.water.shoreSeed = fnv1a(track);
  return t;
}

std::vector<MatTint> resolve_model_tints(const char* biomeName, const std::string& model,
                                         const uint8_t* glb, size_t len) {
  std::vector<MatTint> out;
  const BiomeEntry* b = findBiome(biomeName);
  const char* biome = b ? b->name : "grass";
  const ModelTintDef* def = nullptr;
  for (const ModelTintDef& d : kModelTints) {
    if (std::strcmp(d.biome, biome) == 0 && model == d.model) { def = &d; break; }
  }
  if (!def || !glb || len < 20) return out;

  // GLB: a 12-byte header, then chunks — JSON first (length at offset 12).
  uint32_t jsonLen = 0;
  std::memcpy(&jsonLen, glb + 12, 4);
  if (jsonLen == 0 || (size_t) jsonLen + 20 > len) return out;
  bool ok = false;
  const Value doc = json::parse(std::string((const char*) glb + 20, jsonLen).c_str(), &ok);
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
