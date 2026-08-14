#include "ttp/showcase.h"

#include <algorithm>

#include "ttp/canonical.h"

namespace ttp {
namespace rt {
namespace {

// ---------------------------------------------------------------------------
// The union, walked in the ?biome= list order.
//
// Every merge below is FIRST-APPEARANCE-WINS over that order, which is what
// makes the result a pure function of the biome tables: no seed, no clock, and
// nothing to keep in step by hand. A biome added to kBiomes brings its own
// scenery, landmarks, clutter and fliers into the gallery on the same commit,
// which is the property this file exists for — the alternative is a second list
// of "everything we draw" that rots the first time it is not updated.
// ---------------------------------------------------------------------------

void addTree(std::vector<TreeSpec>& into, const TreeSpec& t) {
  for (const TreeSpec& seen : into) if (seen.model == t.model) return;
  into.push_back(t);
}

void addClutter(std::vector<ClutterSpec>& into, const ClutterSpec& c) {
  for (const ClutterSpec& seen : into) if (seen.kind == c.kind) return;
  into.push_back(c);
}

void addLandmark(std::vector<uint32_t>& into, uint32_t kind) {
  if (std::find(into.begin(), into.end(), kind) == into.end()) into.push_back(kind);
}

// ---------------------------------------------------------------------------
// Names, for the legend alone.
//
// These are captions, not identifiers: nothing resolves by them and no fixture
// records them. They are here rather than in the gallery's JS because the thing
// that decides WHAT is staged should be the thing that says what it staged —
// three shells will read this, and a hand-kept caption list in each is exactly
// the drift the manifest rule exists to stop.
// ---------------------------------------------------------------------------
const char* landmarkName(uint32_t kind) {
  switch (kind) {
    case LM_GNOME: return "garden gnome";
    case LM_DOGHOUSE: return "doghouse";
    case LM_PICNIC: return "picnic table";
    case LM_HOODOO: return "hoodoo rocks";
    case LM_BLOCKS: return "alphabet blocks";
    case LM_WINDMILL: return "windmill";
    case LM_LIGHTHOUSE: return "lighthouse";
    case LM_SAILBOAT: return "sailboat";
    case LM_DUCK: return "bath duck";
    case LM_BALL: return "play ball";
    case LM_UMBRELLA: return "beach umbrella";
    case LM_SANDCASTLE: return "sandcastle";
    case LM_CABIN: return "log cabin";
    case LM_CRAYONS: return "crayons";
    case LM_BOOKS: return "picture books";
    default: return "landmark";
  }
}

const char* clutterName(uint32_t kind) {
  switch (kind) {
    case CL_FLOWER: return "wildflowers";
    case CL_SHELL: return "seashells";
    case CL_STARFISH: return "starfish";
    case CL_DRIFTWOOD: return "driftwood";
    case CL_DRIFT: return "snow drifts";
    case CL_SCRUB: return "desert scrub";
    case CL_PEBBLES: return "pebbles";
    case CL_BRICK: return "toy bricks";
    case CL_MARBLE: return "marbles";
    case CL_DOMINO: return "dominoes";
    default: return "clutter";
  }
}

// How thickly the showroom is planted, whatever the picked biome does. A desert
// reads empty ON PURPOSE (canyon runs 0.45), and that is right for a race and
// wrong for a gallery: a viewer walking the exhibition straight wants to meet
// each model, not to be shown how sparse a biome is. Floors, not overrides —
// a denser biome keeps its own number.
constexpr float kMinSceneryDensity = 0.6f;
constexpr float kMinClutterDensity = 0.3f;
// The scatter's roll thresholds, restated for a spec that now has every model in
// it: trees, then the bush channel, then boulders. Cumulative (theme.h), so the
// gap between them is the bush share and what is left over is rock.
constexpr float kMixTree = 0.7f;
constexpr float kMixBush = 0.86f;

}  // namespace

const std::vector<std::string>& showcase_models() {
  // Built once: the tables behind it are constant for the life of the process,
  // and the shell asks for this on every scene build.
  // Any biome answers the same list — that is the invariant, and showcase_check
  // holds it for all six — so the first one is as good as a special case.
  static const std::vector<std::string> models =
      showcase_theme(biome_name(0), "").scenery.models;
  return models;
}

Theme showcase_theme(const char* biomeName, const char* trackId) {
  // The PALETTE, whole and unmodified — the picked biome's sky, ground, road,
  // hills, light rig, water and ice. Nothing below touches any of it.
  Theme t = resolve_theme(biomeName, trackId);

  // Started EMPTY, not from the picked biome's own list, and that matters: the
  // scenery<i>.glb slot order falls out of this walk, and the shell fetches
  // those bytes from showcase_models() without knowing which biome is about to
  // be built. Seeding with the picked biome would put its trees first and make
  // slot 3 a different model per biome — the shell would hand the renderer a
  // palm and it would plant a cactus.
  std::vector<TreeSpec> trees;
  std::vector<ClutterSpec> clutter;
  for (int i = 0; i < biome_count(); i++) {
    // Each biome's own RESOLVED theme, so every default, preset and per-track
    // patch is already folded in (theme.h's "what resolved means"). The track
    // goes with it: the snow cup patches its flake cloud per track, and reading
    // it any other way here would be a second resolution rule.
    const Theme o = resolve_theme(biome_name(i), trackId);
    for (const TreeSpec& tr : o.scenery.trees) addTree(trees, tr);
    for (const ClutterSpec& c : o.scenery.clutter) addClutter(clutter, c);
    for (uint32_t k : o.landmarks) addLandmark(t.landmarks, k);
    // The bush channel is one donor model sunk to its canopy, so it is adopted
    // whole rather than merged — half of one biome's bush and half of another's
    // is not a bush anyone authored.
    if (!t.scenery.hasBush && o.scenery.hasBush) {
      t.scenery.hasBush = true;
      t.scenery.bush = o.scenery.bush;
    }
    // The air. Each of these is a whole flier rig (count, size, orbit, speed),
    // so the same rule applies: adopt the first biome that flies one, leave a
    // biome that already flies its own alone.
    if (!t.birds.count && o.birds.count) t.birds = o.birds;
    if (!t.kites.count && o.kites.count) t.kites = o.kites;
    if (!t.hasPlane && o.hasPlane) { t.hasPlane = true; t.plane = o.plane; }
    if (t.balloon.panels.empty() && !o.balloon.panels.empty()) t.balloon = o.balloon;
    if (!t.haze.count && o.haze.count) t.haze = o.haze;
    if (!t.ambient.count && o.ambient.count) t.ambient = o.ambient;
  }

  // EQUAL WEIGHTS, deliberately. A biome weights its palette for a look — the
  // grass cup is 65% oak to 35% pine because a meadow reads that way — and
  // carrying those weights into a nine-model union would leave the rarest model
  // stamped once on a lap, or not at all. Here every model is equally likely, so
  // one walk down the exhibition straight meets all of them. The per-model SCALE
  // range (s0/s1) is the model's own and is kept: a saguaro is not a shrub.
  const float w = trees.empty() ? 0.0f : 1.0f / (float) trees.size();
  for (TreeSpec& tr : trees) tr.w = w;
  const float cw = clutter.empty() ? 0.0f : 1.0f / (float) clutter.size();
  for (ClutterSpec& c : clutter) c.w = cw;

  t.scenery.trees = trees;
  t.scenery.clutter = clutter;
  t.scenery.mixTree = kMixTree;
  t.scenery.mixBush = t.scenery.hasBush ? kMixBush : kMixTree;
  t.scenery.density = std::max(t.scenery.density, kMinSceneryDensity);
  t.scenery.clutterDensity = std::max(t.scenery.clutterDensity, kMinClutterDensity);
  // The scenery<i>.glb slot order, derived exactly as a biome's own is
  // (theme.cc's deriveModels): the trees in first-appearance order, then the
  // bush donor if it is not already among them.
  t.scenery.models.clear();
  for (const TreeSpec& tr : t.scenery.trees) {
    if (std::find(t.scenery.models.begin(), t.scenery.models.end(), tr.model)
            == t.scenery.models.end()) {
      t.scenery.models.push_back(tr.model);
    }
  }
  if (t.scenery.hasBush
          && std::find(t.scenery.models.begin(), t.scenery.models.end(), t.scenery.bush.model)
                  == t.scenery.models.end()) {
    t.scenery.models.push_back(t.scenery.bush.model);
  }

  // Trackside props, by the same rules: the prop<i>.glb slot order falls out of
  // the fixed biome walk (never the picked biome first), and the scatter set is
  // deduped by model then rebalanced to EQUAL weights so one lap meets every prop.
  t.props = PropsSpec{};
  const auto propSlot = [&](const std::string& model) -> uint32_t {
    const auto it = std::find(t.props.models.begin(), t.props.models.end(), model);
    if (it != t.props.models.end()) return (uint32_t) (it - t.props.models.begin());
    t.props.models.push_back(model);
    return (uint32_t) (t.props.models.size() - 1);
  };
  for (int i = 0; i < biome_count(); i++) {
    const Theme o = resolve_theme(biome_name(i), trackId);
    for (const PropStamp& p : o.props.scatter) {
      const std::string& model = o.props.models[p.slot];
      const bool seen = std::find(t.props.models.begin(), t.props.models.end(), model)
              != t.props.models.end();
      const uint32_t slot = propSlot(model);
      if (!seen) t.props.scatter.push_back({ slot, p.w, p.s0, p.s1 });
    }
    t.props.scatterDensity = std::max(t.props.scatterDensity, o.props.scatterDensity);
  }
  const float pw = t.props.scatter.empty() ? 0.0f : 1.0f / (float) t.props.scatter.size();
  for (PropStamp& p : t.props.scatter) p.w = pw;
  return t;
}

const std::vector<std::string>& showcase_prop_models() {
  // The showcase_models() rule: any biome answers the same list.
  static const std::vector<std::string> models =
      showcase_theme(biome_name(0), "").props.models;
  return models;
}

std::string showcase_inventory_json() {
  const Theme t = showcase_theme(biome_name(0), "");
  Value o = Value::Obj();

  Value scenery = Value::Arr();
  for (const std::string& m : showcase_models()) scenery.push(Value::Str(m));
  o.set("scenery", scenery);

  Value props = Value::Arr();
  for (const std::string& m : showcase_prop_models()) props.push(Value::Str(m));
  o.set("props", props);

  Value landmarks = Value::Arr();
  for (uint32_t k : t.landmarks) landmarks.push(Value::Str(landmarkName(k)));
  o.set("landmarks", landmarks);

  Value clutter = Value::Arr();
  for (const ClutterSpec& c : t.scenery.clutter) clutter.push(Value::Str(clutterName(c.kind)));
  o.set("clutter", clutter);

  // The air, named by what a viewer sees rather than by field: the picked biome
  // decides none of this (the union above turns all four on), so the list is the
  // same whichever biome the gallery is showing.
  Value fliers = Value::Arr();
  if (t.birds.count) fliers.push(Value::Str("birds"));
  if (t.kites.count) fliers.push(Value::Str("kites"));
  if (t.hasPlane) fliers.push(Value::Str("paper plane"));
  if (!t.balloon.panels.empty()) fliers.push(Value::Str("hot-air balloon"));
  if (t.clouds.count) fliers.push(Value::Str("clouds"));
  if (t.haze.count) fliers.push(Value::Str("dust banks"));
  if (t.ambient.count) fliers.push(Value::Str("ambient particles"));
  o.set("fliers", fliers);

  return canonical_stringify(o);
}

const std::vector<ShowcaseRocket>& showcase_rockets() {
  // ON THE EXHIBITION STRAIGHT, in among the ITEM RUN the showroom track already
  // authors there: the lone box at u 0.02, the four-lane row at 0.045, the boost
  // pads at 0.075. That is 40-odd world units straight ahead of the opening
  // camera, which is the whole point of moving them here — they first stood at
  // u 0.70 with the road furniture, 420 units away round two corners, and a
  // gallery exhibit nobody can find is not an exhibit. The slicks, cones,
  // pillars and dropped bananas stay on the back straight: those are HAZARDS
  // laid into the road, and a viewer meets them by flying the lap.
  //
  // Staggered across the road rather than paired, so the whizz-roll reads from
  // two sides at once and neither exhibit hides the other.
  static const std::vector<ShowcaseRocket> rockets = {
      { 0.060f, -0.9f },
      { 0.090f, 0.9f },
  };
  return rockets;
}

int showcase_monster_from(int rosterSize) {
  return rosterSize > 0 ? rosterSize / 2 : -1;
}

}  // namespace rt
}  // namespace ttp
