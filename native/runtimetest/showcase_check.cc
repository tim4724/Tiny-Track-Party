// showcase_check — the asset gallery's world (ttp/showcase.h), driven directly.
//
// WHAT THIS IS. A BEHAVIOURAL gate, like frame_check and hazard_check — not a
// corpus and not conformance evidence. The showcase theme has no JS twin and
// never had one: it stages a scene that has never existed in play, so there is
// nothing to record against and nothing here says whether a port was right.
// What it does say is that the claims showcase.h makes are true of the tables
// as they stand TODAY, which is the only thing that can rot:
//
//   1. COMPLETENESS. Every landmark kind, every clutter kind and every scenery
//      GLB any biome plants is staged. This is the whole point of the gallery,
//      and it is the assertion that turns "add a biome and the gallery picks it
//      up" from a comment into a checked property: a new kind that no biome
//      lists (or that showcase_theme drops) fails here rather than silently
//      never being drawn.
//   2. SLOT ORDER IS BIOME-INDEPENDENT. The shell fetches scenery<i>.glb from
//      showcase_models() before the build picks a biome, so the two lists must
//      agree for all six. A biome-dependent order is invisible in a unit test of
//      one biome and shows up as a palm planted where a cactus should be.
//   3. THE PALETTE IS UNTOUCHED. A gallery that quietly altered the look would
//      be showing a world that ships nowhere. Every palette field of the picked
//      biome must survive the union byte for byte.
//   4. THE SCATTER IS WELL-FORMED. Weights sum to one, the roll thresholds
//      stay ordered, the densities meet their floors.
//   5. THE STANDING EXHIBITS ARE PLACEABLE. The rocket the parked showroom
//      stands is on the road and inside one lap, and the monster rig lands on
//      the back of the grid rather than in the lineup. (WHEN they are staged is
//      frame_check's — the exhibits are the parked field's, not the race's.)
//
// Usage: showcase_check   (no arguments — the tables are compiled in)

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "ttp/showcase.h"
#include "ttp/theme.h"

using namespace ttp;
using ttp::rt::Theme;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& what) {
  checks++;
  if (!ok) {
    failures++;
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
  }
}

bool hasModel(const std::vector<std::string>& models, const std::string& m) {
  for (const std::string& s : models) if (s == m) return true;
  return false;
}

bool hasKind(const std::vector<uint32_t>& kinds, uint32_t k) {
  for (uint32_t s : kinds) if (s == k) return true;
  return false;
}

// 1. Completeness — every kind and model any biome carries.
void testCompleteness() {
  const Theme show = rt::showcase_theme("grass", "showroom");
  const std::vector<std::string>& models = rt::showcase_models();
  for (int i = 0; i < rt::biome_count(); i++) {
    const char* name = rt::biome_name(i);
    const Theme b = rt::resolve_theme(name, "showroom");
    for (const rt::TreeSpec& t : b.scenery.trees) {
      check(hasModel(models, t.model),
            std::string("showcase stages ") + name + "'s tree " + t.model);
    }
    if (b.scenery.hasBush) {
      check(hasModel(models, b.scenery.bush.model),
            std::string("showcase stages ") + name + "'s bush donor " + b.scenery.bush.model);
    }
    for (uint32_t k : b.landmarks) {
      check(hasKind(show.landmarks, k),
            std::string("showcase stages ") + name + " landmark kind " + std::to_string(k));
    }
    for (const rt::ClutterSpec& c : b.scenery.clutter) {
      bool found = false;
      for (const rt::ClutterSpec& s : show.scenery.clutter) if (s.kind == c.kind) found = true;
      check(found, std::string("showcase stages ") + name + " clutter kind "
                   + std::to_string(c.kind));
    }
  }
  // Every kind DECLARED, not merely every kind some biome happens to use: the
  // enum is the vocabulary, and a kind the renderer can draw but no biome lists
  // is exactly the thing a gallery is for.
  for (uint32_t k = rt::LM_GNOME; k <= rt::LM_TRAIN; k++) {
    check(hasKind(show.landmarks, k), "showcase stages landmark kind " + std::to_string(k));
  }
  for (uint32_t k = rt::CL_FLOWER; k <= rt::CL_DOMINO; k++) {
    bool found = false;
    for (const rt::ClutterSpec& s : show.scenery.clutter) if (s.kind == k) found = true;
    check(found, "showcase stages clutter kind " + std::to_string(k));
  }
  // The air: all four rigs fly in every biome, whichever one authored them.
  for (int i = 0; i < rt::biome_count(); i++) {
    const Theme t = rt::showcase_theme(rt::biome_name(i), "showroom");
    const std::string who = rt::biome_name(i);
    check(t.birds.count > 0, who + " showcase flies birds");
    check(t.kites.count > 0, who + " showcase flies kites");
    check(t.hasPlane, who + " showcase flies the paper plane");
    check(!t.balloon.panels.empty(), who + " showcase flies the balloon");
    check(t.haze.count > 0, who + " showcase carries dust banks");
    check(t.ambient.count > 0, who + " showcase carries ambient particles");
  }
}

// 2. The scenery<i>.glb slot order is the same list the shell fetched.
void testSlotOrder() {
  const std::vector<std::string>& models = rt::showcase_models();
  check(!models.empty(), "showcase_models is not empty");
  for (int i = 0; i < rt::biome_count(); i++) {
    const Theme t = rt::showcase_theme(rt::biome_name(i), "showroom");
    check(t.scenery.models == models,
          std::string("scenery slot order matches showcase_models in ") + rt::biome_name(i));
  }
  // And it really is the trees, in order, with the bush donor accounted for —
  // the derivation theme.cc runs for a biome's own spec.
  const Theme t = rt::showcase_theme("grass", "showroom");
  for (const rt::TreeSpec& tr : t.scenery.trees) {
    check(hasModel(t.scenery.models, tr.model), "tree " + tr.model + " has a scenery slot");
  }
  if (t.scenery.hasBush) {
    check(hasModel(t.scenery.models, t.scenery.bush.model), "the bush donor has a scenery slot");
  }
}

// 3. The picked biome's palette survives the union untouched.
void testPaletteUntouched() {
  for (int i = 0; i < rt::biome_count(); i++) {
    const char* name = rt::biome_name(i);
    const std::string who = name;
    const Theme base = rt::resolve_theme(name, "showroom");
    const Theme show = rt::showcase_theme(name, "showroom");
    check(std::memcmp(base.sky, show.sky, sizeof base.sky) == 0, who + " sky");
    check(base.fog == show.fog, who + " fog");
    check(base.fogTune == show.fogTune, who + " fogTune");
    check(base.hills == show.hills, who + " hills");
    check(base.hillShape == show.hillShape, who + " hill shape");
    check(base.groundKind == show.groundKind, who + " ground kind");
    check(base.boost == show.boost, who + " boost accent");
    check(base.structure == show.structure, who + " structure colour");
    check(base.gate == show.gate, who + " gate grade");
    check(base.key.color == show.key.color && base.key.intensity == show.key.intensity,
          who + " key light");
    check(base.hemi.sky == show.hemi.sky && base.hemi.ground == show.hemi.ground
                  && base.hemi.intensity == show.hemi.intensity, who + " hemi light");
    check(base.hasWater == show.hasWater && base.water.shoreSeed == show.water.shoreSeed,
          who + " water");
    check(base.hasIce == show.hasIce && base.ice.sheet == show.ice.sheet, who + " ice");
    check(std::memcmp(&base.road, &show.road, sizeof base.road) == 0, who + " road palette");
    check(base.gantry.pylon == show.gantry.pylon && base.gantry.finial == show.gantry.finial,
          who + " gantry");
    check(base.scenery.rocks == show.scenery.rocks, who + " boulder tints");
    // The look is the biome's; so is anything it already flies. A biome that
    // authored its own birds keeps them rather than being handed the beach's.
    if (base.birds.count) check(base.birds.tint == show.birds.tint, who + " keeps its own birds");
    if (base.ambient.count) {
      check(base.ambient.kind == show.ambient.kind && base.ambient.count == show.ambient.count,
            who + " keeps its own ambient particles");
    }
  }
}

// 4. The scatter spec is well-formed for the renderer's weighted pick.
void testScatter() {
  for (int i = 0; i < rt::biome_count(); i++) {
    const std::string who = rt::biome_name(i);
    const Theme t = rt::showcase_theme(rt::biome_name(i), "showroom");
    float w = 0;
    for (const rt::TreeSpec& tr : t.scenery.trees) {
      w += tr.w;
      check(tr.s0 > 0, who + " tree " + tr.model + " keeps its authored scale");
    }
    check(std::fabs(w - 1.0f) < 1e-4f, who + " tree weights sum to 1");
    float cw = 0;
    for (const rt::ClutterSpec& c : t.scenery.clutter) cw += c.w;
    check(std::fabs(cw - 1.0f) < 1e-4f, who + " clutter weights sum to 1");
    check(t.scenery.mixTree <= t.scenery.mixBush, who + " roll thresholds stay ordered");
    check(t.scenery.mixBush < 1.0f, who + " leaves a boulder share");
    check(t.scenery.density >= 0.6f, who + " scenery density meets the gallery floor");
    check(t.scenery.clutterDensity >= 0.3f, who + " clutter density meets the gallery floor");
    check(t.scenery.density >= rt::resolve_theme(rt::biome_name(i), "showroom").scenery.density,
          who + " is never planted more thinly than it races");
  }
}

// The legend: canonical JSON, and it names what is actually staged.
void testInventory() {
  const std::string json = rt::showcase_inventory_json();
  check(json.rfind("{\"clutter\":", 0) == 0, "inventory is canonical (keys sorted)");
  const Theme t = rt::showcase_theme("grass", "showroom");
  check(json.find("\"wind-up train\"") != std::string::npos, "inventory names the train");
  check(json.find("\"dominoes\"") != std::string::npos, "inventory names the dominoes");
  check(json.find("\"hot-air balloon\"") != std::string::npos, "inventory names the balloon");
  for (const std::string& m : rt::showcase_models()) {
    check(json.find("\"" + m + "\"") != std::string::npos, "inventory names " + m);
  }
  // Once each: the union dedupes, so the staged list is exactly the enum.
  check(t.landmarks.size() == (size_t) (rt::LM_TRAIN + 1), "every landmark kind is staged once");
}

// The standing exhibits. Placement is TASTE and nothing here judges it; what is
// checked is that each one is somewhere a viewer can reach and the renderer can
// place — on the road, inside one lap, and not stacked on top of each other.
// The frame builder turns these into the same TtpRocketInput a fired rocket
// produces, and it is `frame_check` that holds the parked-only rule.
void testExhibits() {
  const std::vector<rt::ShowcaseRocket>& rockets = rt::showcase_rockets();
  check(!rockets.empty(), "the showroom stands at least one rocket");
  bool left = false, right = false;
  for (size_t i = 0; i < rockets.size(); i++) {
    const rt::ShowcaseRocket& r = rockets[i];
    const std::string who = "rocket " + std::to_string(i);
    // u is a LAP FRACTION, and the builder's u2s wraps — so a value outside
    // [0,1) would silently land somewhere else entirely rather than fail.
    check(r.u >= 0.0f && r.u < 1.0f, who + " is a fraction of one lap");
    // Bananas sit at ±0.9 and the road runs to ±1: past that an exhibit is off
    // the deck, hovering over whatever the scatter planted.
    check(std::fabs(r.lat) <= 1.0f, who + " stands on the road");
    if (r.lat < 0) left = true;
    if (r.lat > 0) right = true;
    for (size_t j = 0; j < i; j++) {
      check(std::fabs(rockets[j].u - r.u) > 1e-3f || std::fabs(rockets[j].lat - r.lat) > 1e-3f,
            who + " does not stand inside another");
    }
  }
  check(left && right, "the rockets are staggered across the road, not paired");

  // The monster slot: the LAST one, so the lineup shot the gallery opens on is
  // the eight liveries and the truck is behind them.
  check(rt::showcase_monster_slot(8) == 7, "a field of eight wears the rig on the back row");
  check(rt::showcase_monster_slot(1) == 0, "a field of one still shows the truck");
  check(rt::showcase_monster_slot(0) == -1, "an empty field has no slot to spare");
}

}  // namespace

int main() {
  testCompleteness();
  testSlotOrder();
  testPaletteUntouched();
  testScatter();
  testInventory();
  testExhibits();

  std::printf("showcase check: %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
