// theme — the per-cup visual BIOMES, and the rules that resolve one.
//
// This is the C++ home of what public/shared/themes.js and
// public/display/render/trackPayload.js used to author in the browser. It is
// DATA plus three resolution rules, no renderer and no platform API, so it
// compiles and is ctested on every leg — and the palette is authored once for
// the three shells rather than once per shell.
//
// A biome is resolved from a track's CUP (generated/track_defs.h carries the cup
// id alongside the descriptor); an unknown or unlisted cup falls back to `grass`,
// the canonical "Sunny Circuit" look, so a cup added without a biome renders
// byte-for-byte as it did before theming existed.
//
// WHAT "RESOLVED" MEANS HERE. Theme below is the FINAL value set: the ambient
// kind's motion preset, the cloud/bird/plane defaults, the "field absent -> the
// verbatim pre-theming literal" fallbacks and the per-track ambient patch are all
// already folded in. Nothing downstream re-applies a default, and the renderer
// reads these fields straight.
//
// FLOATS ARE float, NOT double, deliberately. Every one of these numbers reached
// the renderer through track.bin as f32 for the whole life of the theming
// system, so f32 IS the value the shipped game has always drawn with;
// tests/fixtures/theme-corpus.jsonl records them Math.fround'd for the same
// reason. Widening them would silently change the palette in the third decimal.
//
// The oracle: tests/fixtures/theme-corpus.jsonl, recorded off the live JS
// palette before it was deleted (scripts/gen-theme-corpus.mjs, now frozen) and
// replayed by native/runtimetest/theme_check.cc — 6 biomes x 22 tracks, plus the
// cup/track resolution, the biome-name order and every boostShades shade.
#pragma once

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace ttp {
namespace rt {

// ---- shared enums (the ints the renderer switches on) -----------------------

enum GroundKind : uint32_t { GROUND_LAWN = 0, GROUND_SAND, GROUND_REDROCK, GROUND_SNOW, GROUND_WOOD };
// A shape change rebuilds the horizon ring: 'dome' soft meadow mounds, 'mesa'
// flat-topped buttes, 'block' giant toy building blocks, 'island' a sparse low
// offshore chain with sea gaps between features.
enum HillShape : uint32_t { HILL_DOME = 0, HILL_MESA, HILL_BLOCK, HILL_ISLAND };
// Ambient particle motion presets (trackPayload.js AMB_KINDS).
enum AmbKind : uint32_t { AMB_NONE = 0, AMB_POLLEN, AMB_MOTE, AMB_SAND, AMB_FLAKE };
// Hero set-piece kinds. The renderer dispatches these in buildLandmarks' SOURCE
// order rather than id order — several kinds share one rand stream, so the draw
// order is part of the contract and these ids must not be renumbered.
enum LandmarkKind : uint32_t {
  LM_GNOME = 0, LM_DOGHOUSE, LM_PICNIC, LM_HOODOO, LM_SNOWMAN, LM_BLOCKS,
  LM_WINDMILL, LM_LIGHTHOUSE, LM_SAILBOAT, LM_DUCK, LM_BALL, LM_UMBRELLA,
  LM_SANDCASTLE, LM_CABIN, LM_CRAYONS, LM_BOOKS, LM_TRAIN
};
// Near-field ground clutter kinds (procedural — the renderer's clutter builders).
enum ClutterKindId : uint32_t {
  CL_FLOWER = 0, CL_SHELL, CL_STARFISH, CL_DRIFTWOOD, CL_DRIFT,
  CL_SCRUB, CL_PEBBLES, CL_BRICK, CL_MARBLE, CL_DOMINO
};

// ---- the resolved theme -----------------------------------------------------
// Every default here is the VERBATIM constant the renderer used before theming
// existed. A biome only overrides what it changes, so these literals are what
// the Backyard cup still renders with — do not drift them.

struct RoadPalette {
  uint32_t asphalt = 0x5a6078;   // Kenney blue-grey plastic deck
  uint32_t line = 0xc4c4d9;      // painted edge-line / dash
  uint32_t dash = 0xc4c4d9;      // centre-dash override (defaults to `line`)
  uint32_t kerbA = 0xfa6b41;     // kerb band pair (red / white)
  uint32_t kerbB = 0xf8f8fb;
  uint32_t skirt = 0x5a6078;     // deck side/belly (defaults to `asphalt`)
  uint32_t shoulder = 0x5a6078;  // dusty edge tint where edge lines are dropped
  float kerbW = 0.22f, kerbH = 0.20f;  // kerb cross-section (visual only)
  bool edgeLines = true;         // false drops the painted side lines
  // Whether this deck has ever been REPAIRED — the asphalt patches of
  // ttp/wear.h. A moulded-plastic deck has not: a patch on it reads as a
  // stain, not as a season of racing. Post-corpus (theme_check does not
  // serialize it), so a biome authors it freely.
  bool patched = true;
};

struct TreeSpec {
  std::string model;   // GLB base name; its index in ScenerySpec::models is what track.bin carried
  float w = 0;         // weight; the entries' w's sum to 1
  float s0 = 0, s1 = 0;  // stamp scale = s0 + rand() * s1
};
struct BushSpec {
  std::string model;
  float s0 = 0, s1 = 0, sink = 0;  // sunk to its canopy — the "bush" trick
};
struct ClutterSpec {
  uint32_t kind = CL_FLOWER;
  float w = 0;
  std::vector<uint32_t> tints;
};
struct ScenerySpec {
  float density = 0;                 // per-side spawn chance at each corridor candidate
  float mixTree = 0, mixBush = 0;    // CUMULATIVE roll thresholds; tree == bush means no bushes
  // Dedupe of the tree models then the bush donor, in first-appearance order.
  // That order IS the scenery<i>.glb index the renderer binds by.
  std::vector<std::string> models;
  std::vector<TreeSpec> trees;
  bool hasBush = false;
  BushSpec bush;
  std::vector<uint32_t> rocks;       // boulder tint family (flat-shaded)
  float rockS[2] = { 0.3f, 0.45f };  // boulder radius = rockS[0] + rand() * rockS[1]
  float clutterDensity = 0;
  std::vector<ClutterSpec> clutter;  // drawn from its OWN seeded stream
};

// Trackside props: a scattered set-dressing pass from prop-*.glb (GENERATED by
// scripts/gen-props.mjs, colormap-textured so no tint entry ever names one). A
// post-corpus channel: the frozen theme corpus predates it, so theme_check
// does not serialize it and each biome authors it freely — unlike every field
// above.
struct PropStamp {
  uint32_t slot = 0;     // index into PropsSpec::models
  float w = 0;           // scatter weight; a biome's w's sum to 1
  float s0 = 1, s1 = 0;  // stamp scale = s0 + rand() * s1
};
struct PropsSpec {
  std::vector<std::string> models;  // prop<i>.glb slot order (the scenery rule)
  float scatterDensity = 0;         // per-side chance at each 9u candidate
  std::vector<PropStamp> scatter;
};

struct KeyLight { uint32_t color = 0xfff1d0; float intensity = 1.4f; };
struct HemiLight { uint32_t sky = 0xffffff, ground = 0x9aa68f; float intensity = 2.2f; };
struct CloudSpec {  // trackPayload.js DEF_CLOUDS
  uint32_t count = 8; float opacity = 0.8f, scale = 1, aspect = 0.42f; uint32_t tint = 0xffffff;
};
struct GantrySpec {  // FinishGate's DEFAULT_GANTRY: celebration-red posts + paper domes
  uint32_t pylon = 0xff5040, finial = 0xfff6eb;
  bool hasRings = false;             // rings switches the pylon to lighthouse bands
  uint32_t rings = 0xff5040;
};
struct WaterSpec {
  uint32_t foam = 0xffffff, shallow = 0x62d3c8, deep = 0x2596c8, wet = 0x7d5f34;
  uint32_t shoreSeed = 0;            // shorelineFn's per-track seed: FNV-1a over the track id
};
struct HazeSpec { uint32_t count = 0; float opacity = 0.16f; uint32_t tint = 0xffffff; float scale = 1; };
struct AmbientSpec {
  uint32_t kind = AMB_NONE, count = 0;
  float size = 0.3f, opacity = 0.85f;
  uint32_t tint = 0xffffff;
  float fall = 1, wind = 0.7f, bob = 0, band = 1;
};
struct BirdSpec {  // trackPayload.js DEF_BIRDS
  uint32_t count = 0, tint = 0xffffff;
  float size = 2.4f, y = 18, rc = 120, rb = 22, speed = 0.2f, flap = 0.8f, flapHz = 1.8f, dys = 1;
};
struct KiteSpec { uint32_t count = 0; float size = 2.8f, y = 13; std::vector<uint32_t> tints; };
struct PlaneSpec {  // trackPayload.js DEF_PLANE
  uint32_t tint = 0xfaf7ec;
  float size = 3.2f, y = 22, a0 = 1.3f, rc = 95, rb = 32, speed = 0.3f, bank = 0.4f;
};
struct BalloonSpec { std::vector<uint32_t> panels; float y = 44, size = 6; };
struct IceSpec { uint32_t sheet = 0xa9d7ee, frost = 0xf0f8fd; };

// One scenery model's recolour, resolved against that model's authored glTF
// materials — gltfio names its material instances after the glTF material, so
// the renderer applies these by name.
struct MatTint { std::string name; uint32_t rgb = 0xffffff; };

struct Theme {
  RoadPalette road;
  uint32_t sky[3] = { 0x59a7e8, 0x8ecae6, 0xc8e9f2 };  // zenith / horizon / below
  uint32_t fog = 0x8ecae6;        // race + overview + perimeter fog AND the background
  uint32_t hillShape = HILL_DOME;
  std::vector<uint32_t> hills = { 0x8cc578, 0x7cb86a, 0x9bce86 };
  ScenerySpec scenery;
  PropsSpec props;
  std::vector<uint32_t> landmarks;
  uint32_t structure = 0x9aa1b4;  // pillars / poles / loop shafts (toy concrete)
  uint32_t groundKind = GROUND_LAWN;
  float fogTune = 1;              // scalar on the RACE + lobby-perimeter fog distances
  KeyLight key;
  HemiLight hemi;
  CloudSpec clouds;
  uint32_t gate = 0xffffff;       // near-white grade over the start/finish gate
  GantrySpec gantry;
  uint32_t boost = 0x22c9b6;      // the biome's ONE speed-accent identity colour
  bool hasWater = false;
  WaterSpec water;
  HazeSpec haze;
  AmbientSpec ambient;
  BirdSpec birds;
  KiteSpec kites;
  bool hasPlane = false;
  PlaneSpec plane;
  BalloonSpec balloon;
  bool hasIce = false;
  IceSpec ice;
  // One entry per `scenery.models` index, filled by resolve_model_tints() once
  // the shell has handed over that model's bytes. Empty until then.
  std::vector<std::vector<MatTint>> modelTints;
};

// ---- boost accent -----------------------------------------------------------
// Every boost SURFACE derives from one identity hex, so the pad disc, the launch
// strip, the under-car aura, the wind streaks and the HUD chip read as one
// accent per biome. Keep the recipe here so all surfaces stay in lockstep.
struct BoostShades {
  uint32_t base;    // the biome accent itself
  uint32_t light;   // pad-disc bright core
  uint32_t dark;    // pad-disc rim
  uint32_t strip;   // flat launch-strip body
  uint32_t disk;    // under-car aura tint
  uint32_t streak;  // near-white wind streak with the accent's cast
  uint32_t icon;    // HUD item-chip stroke — darkened for contrast on paper
};

// INLINE, in the header, because the RENDERER is the biggest consumer of these
// shades and may not link libttp-runtime (neither library may link the other, or
// libttp-runtime would stop building on the legs with no Filament SDK — see
// native/CMakeLists.txt). It reaches theme.h by include path alone, so anything
// it must AGREE with has to be callable from a header.
//
// It used to re-derive them instead, with its own float/lround copy of mixHex
// against this file's double/floor one, and four coefficients retyped as
// literals. Four of the five stayed in step by luck; the fifth, the wind streak,
// was a hardcoded 0xdffcf8 that matches no biome's accent at all — so the one
// surface no biome drove was the one the recipe below names last. `boostShades`
// is pinned shade-by-shade for all six biomes by the frozen theme corpus, which
// is exactly the gate the renderer's copy could never be under.
//
// double, not float, and floor(x + 0.5) rather than lround: this is themes.js's
// arithmetic, and the corpus was recorded off it.
inline uint32_t mix_hex(uint32_t hex, double t) {
  const double to = t >= 0 ? 255.0 : 0.0, a = t < 0 ? -t : t;
  const auto m = [&](uint32_t c) -> uint32_t {
    return (uint32_t) std::floor((double) c + (to - (double) c) * a + 0.5);
  };
  return (m((hex >> 16) & 255) << 16) | (m((hex >> 8) & 255) << 8) | m(hex & 255);
}

inline BoostShades boost_shades(uint32_t hex) {
  BoostShades s;
  s.base = hex;
  s.light = mix_hex(hex, 0.55);    // pad-disc bright core (radial-gradient centre)
  s.dark = mix_hex(hex, -0.42);    // pad-disc rim (radial-gradient edge)
  s.strip = mix_hex(hex, -0.12);   // flat launch-strip body — reads as paint
  s.disk = mix_hex(hex, 0.15);     // under-car aura tint: the SATURATED accent, small lift
  s.streak = mix_hex(hex, 0.86);   // near-white wind streak with the accent's cast
  s.icon = mix_hex(hex, -0.2);     // HUD item-chip stroke — darkened for paper
  return s;
}

// ---- resolution -------------------------------------------------------------

// The biome names, in the order the ?biome= override list shows them.
int biome_count();
const char* biome_name(int index);          // nullptr out of range
bool has_biome(const char* name);

// Cup id -> biome name; unknown, unlisted or null -> "grass".
const char* biome_for_cup(const char* cupId);
// Track id -> biome name, via that track's cup (an unknown or cupless track,
// which is what every dev-only surface is, resolves to "grass").
const char* biome_for_track(const char* trackId);

// The fully resolved palette for a biome on a track. An unknown biome name
// resolves to grass, matching themeForCup's fallback. `trackId` only reaches two
// things: the per-track ambient patch (the snow cup's four different winter
// days) and the shoreline seed.
Theme resolve_theme(const char* biomeName, const char* trackId);

// The recolour table for `model`, resolved against that model's own authored
// glTF materials.
//
// buildScenery baked `tint` into vertex colours for UNTEXTURED models: a plain
// hex repaints the whole model, a map is keyed by each part's AUTHORED colour (a
// palm's fronds and trunk differ). `glb` is the model's raw GLB bytes, whose
// JSON chunk names the materials and their linear baseColorFactors; the theme's
// keys are authored as sRGB hex, so the factors convert before the lookup.
// Returns empty when nothing tints that model, or the bytes are
// missing/unparseable (which simply renders it in its authored colours).
//
// NO BIOME ARGUMENT: a recolour belongs to the model, so the same model looks
// the same wherever it is planted. theme.cc's table says what that costs.
std::vector<MatTint> resolve_model_tints(const std::string& model,
                                         const uint8_t* glb, size_t len);

}  // namespace rt
}  // namespace ttp
