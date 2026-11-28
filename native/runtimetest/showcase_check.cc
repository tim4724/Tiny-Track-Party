// showcase_check — the asset gallery's world (ttp/showcase.h), driven directly.
//
// WHAT THIS IS. A BEHAVIOURAL gate, like frame_check and hazard_check — not a
// corpus and not conformance evidence. The showcase theme has no JS twin and
// never had one: it stages a scene that has never existed in play, so there is
// nothing to record against and nothing here says whether a port was right.
// What it does say is that the claims showcase.h makes are true of the tables
// as they stand TODAY, which is the only thing that can rot:
//
//   1. COMPLETENESS. Seven pads (a neutral kit pad, then one per biome). Every
//      scenery, prop and set model in the union has a spot, and so does every
//      landmark kind, every clutter kind, the four cars, the four named items
//      and the one shipping rocket. A biome added to theme.cc joins on the
//      same commit.
//   2. SLOT ORDER DOES NOT DEPEND ON THE MASK OR THE NAMED BIOME. The shell
//      fetches scenery<i>.glb from showcase_models() before the build, and a
//      filter must not move those slots.
//   3. THE STUDIO IS NEUTRAL. One sky, wood ground, no water, no land, no
//      fliers — whichever biome the caller names.
//   4. A FILTER DROPS SPOTS, NOT LISTS. Mask 0 is seven empty pads, each at
//      least the minimum size. A category bit off produces no spots of that
//      category and leaves the model lists alone.
//   5. EVERY SPOT SITS STRICTLY INSIDE SOME PAD. The inventory names the seven
//      categories, in bit order, and opens with the pad bounds.
//
// Usage: showcase_check   (no arguments — the tables are compiled in)

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "generated/track_defs.h"
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

int spotsOf(const Theme& t, uint32_t channel, uint32_t slot) {
  int n = 0;
  for (const rt::GallerySpot& s : t.gallerySpots)
    if (s.channel == channel && s.slot == slot) n++;
  return n;
}

bool spotForModel(const Theme& t, uint32_t channel, const std::vector<std::string>& models,
                  const std::string& model) {
  for (size_t i = 0; i < models.size(); i++) {
    if (models[i] == model && spotsOf(t, channel, (uint32_t) i) > 0) return true;
  }
  return false;
}

// 1. Completeness — pads, and a spot for everything the union holds.
void testCompleteness() {
  const Theme show = rt::showcase_theme("grass", "");
  check(show.gallery, "the gallery theme is a gallery");
  check(show.galleryPads.size() == (size_t) rt::biome_count() + 1,
        "a kit pad plus one pad per biome");
  const uint32_t padColor[] = {
    0xd9d6cf, 0x6aa84f, 0xc6a15a, 0xdec896, 0xd39671, 0xedf2f7, 0xd6b07c
  };
  check(sizeof padColor / sizeof padColor[0] == show.galleryPads.size(),
        "the pinned pad colours cover every pad");
  for (size_t i = 0; i < show.galleryPads.size() && i < 7; i++) {
    check(show.galleryPads[i].color == padColor[i],
          "pad " + std::to_string(i) + " wears its biome colour");
  }

  const std::vector<std::string>& models = rt::showcase_models();
  for (int i = 0; i < rt::biome_count(); i++) {
    const char* name = rt::biome_name(i);
    const Theme b = rt::resolve_theme(name, "");
    for (const rt::TreeSpec& tr : b.scenery.trees) {
      check(hasModel(models, tr.model),
            std::string("showcase stages ") + name + "'s tree " + tr.model);
      check(spotForModel(show, rt::GAL_CH_SCENERY, show.scenery.models, tr.model),
            std::string(name) + " tree " + tr.model + " stands on a pad");
    }
    if (b.scenery.hasBush) {
      check(hasModel(models, b.scenery.bush.model),
            std::string("showcase stages ") + name + "'s bush donor " + b.scenery.bush.model);
      check(spotForModel(show, rt::GAL_CH_SCENERY, show.scenery.models, b.scenery.bush.model),
            std::string(name) + " bush " + b.scenery.bush.model + " stands on a pad");
    }
    for (uint32_t k : b.landmarks) {
      check(spotsOf(show, rt::GAL_CH_LANDMARK, k) > 0,
            std::string(name) + " landmark kind " + std::to_string(k) + " has a spot");
    }
    for (const rt::ClutterSpec& c : b.scenery.clutter) {
      check(spotsOf(show, rt::GAL_CH_CLUTTER, c.kind) > 0,
            std::string(name) + " clutter kind " + std::to_string(c.kind) + " has a spot");
    }
  }
  for (uint32_t k = rt::LM_GNOME; k <= rt::LM_CABIN; k++) {
    check(spotsOf(show, rt::GAL_CH_LANDMARK, k) > 0,
          "landmark kind " + std::to_string(k) + " has a spot");
  }
  for (uint32_t k = rt::CL_FLOWER; k <= rt::CL_DOMINO; k++) {
    check(spotsOf(show, rt::GAL_CH_CLUTTER, k) > 0,
          "clutter kind " + std::to_string(k) + " has a spot");
  }
  std::vector<std::string> authored;
  for (int i = 0; i < TTP_TRACK_COUNT; i++) {
    for (int k = 0; k < TTP_TRACKS[i].nSet; k++) {
      const std::string m = TTP_TRACKS[i].set[k].model;
      if (!hasModel(authored, m)) authored.push_back(m);
    }
  }
  for (const std::string& m : authored) {
    check(spotForModel(show, rt::GAL_CH_SET, show.set.models, m),
          "catalogue set model " + m + " has a spot");
  }
  const char* cars[] = { "vehicle-gt", "vehicle-lemans", "vehicle-stock", "vehicle-jeep" };
  const char* named[] = { "item-box", "item-banana", "item-cone", "vehicle-monster-truck" };
  check(show.galleryCars.size() == 4, "four kit cars");
  check(show.galleryNamed.size() == 4, "four named items");
  for (int i = 0; i < 4; i++) {
    check(show.galleryCars[(size_t) i] == cars[i], std::string("car ") + cars[i]);
    check(spotsOf(show, rt::GAL_CH_CAR, (uint32_t) i) == 1, std::string(cars[i]) + " stands once");
    check(show.galleryNamed[(size_t) i] == named[i], std::string("item ") + named[i]);
    check(spotsOf(show, rt::GAL_CH_NAMED, (uint32_t) i) == 1, std::string(named[i]) + " stands once");
  }
  check(spotsOf(show, rt::GAL_CH_ROCKET, 0) == 1, "one shipping rocket");
}

// 2. Slot order is one list, whoever asks and whichever categories are on.
void testSlotOrder() {
  const std::vector<std::string>& models = rt::showcase_models();
  const std::vector<std::string>& props = rt::showcase_prop_models();
  const std::vector<std::string>& set = rt::showcase_set_models();
  check(!models.empty(), "showcase_models is not empty");
  const Theme grass = rt::showcase_theme("grass", "");
  const Theme beach = rt::showcase_theme("beach", "tidepool");
  const Theme masked = rt::showcase_theme("grass", "", rt::GAL_CARS);
  check(beach.scenery.models == grass.scenery.models, "scenery slots ignore the named biome");
  check(beach.props.models == grass.props.models, "prop slots ignore the named biome");
  check(beach.set.models == grass.set.models, "set slots ignore the named biome");
  check(masked.scenery.models == grass.scenery.models, "a filter does not move scenery slots");
  check(masked.props.models == grass.props.models, "a filter does not move prop slots");
  check(masked.set.models == grass.set.models, "a filter does not move set slots");
  check(grass.scenery.models == models, "showcase_models is that scenery list");
  check(grass.props.models == props, "showcase_prop_models is that prop list");
  check(grass.set.models == set, "showcase_set_models is that set list");
}

// 3. One studio, not the picked biome.
void testStudio() {
  for (int i = 0; i < rt::biome_count(); i++) {
    const std::string who = rt::biome_name(i);
    const Theme t = rt::showcase_theme(rt::biome_name(i), "showroom");
    check(t.sky[0] == 0x8ec8f0 && t.sky[1] == 0xd7eef8 && t.sky[2] == 0xc5d5c8, who + " sky");
    check(t.fog == 0xd7eef8, who + " fog");
    check(t.skyCurve == 0.65f, who + " sky curve");
    check(t.key.color == 0xfff1d0 && t.key.intensity == 1.4f, who + " key");
    check(t.hemi.sky == 0xffffff && t.hemi.ground == 0x9aa68f && t.hemi.intensity == 2.2f,
          who + " hemi");
    check(t.groundKind == rt::GROUND_WOOD, who + " is flat wood");
    check(!t.hasWater && !t.hasIce, who + " has no water");
    check(t.land.empty(), who + " has no land");
    check(t.birds.count == 0 && t.kites.count == 0 && !t.hasPlane && t.balloon.panels.empty(),
          who + " flies nothing");
    check(t.haze.count == 0 && t.ambient.count == 0 && t.clouds.count == 0 && t.life.count == 0,
          who + " has no air");
    check(t.scenery.density == 0.f && t.scenery.clutterDensity == 0.f && t.props.scatterDensity == 0.f,
          who + " scatters nothing");
  }
}

// 4. Filters and empty pads. A spot is inside the colour it stands on.
void testLayout() {
  const Theme full = rt::showcase_theme("grass", "", rt::GAL_ALL);
  const Theme none = rt::showcase_theme("grass", "", 0);
  check(none.galleryPads.size() == full.galleryPads.size(), "mask 0 keeps every pad");
  check(none.gallerySpots.empty(), "mask 0 places nothing");
  check(none.scenery.models == full.scenery.models, "mask 0 keeps the scenery list");
  for (const rt::GalleryPad& p : none.galleryPads) {
    check(p.x1 - p.x0 >= 18.f && p.z1 - p.z0 >= 12.f, "an empty pad keeps its minimum");
  }
  const Theme noCars = rt::showcase_theme("grass", "", rt::GAL_ALL ^ rt::GAL_CARS);
  for (const rt::GallerySpot& s : noCars.gallerySpots) {
    check(s.cat != rt::GAL_CARS, "cars off places no car");
  }
  check(noCars.galleryCars.size() == full.galleryCars.size(), "cars off keeps the car names");
  check(noCars.scenery.models == full.scenery.models, "cars off keeps the scenery list");

  for (const rt::GallerySpot& s : full.gallerySpots) {
    bool inside = false;
    for (const rt::GalleryPad& p : full.galleryPads) {
      if (s.x > p.x0 && s.x < p.x1 && s.z > p.z0 && s.z < p.z1) inside = true;
    }
    check(inside, "spot " + std::to_string(s.channel) + ":" + std::to_string(s.slot)
                  + " is inside a pad");
  }
}

void testInventory() {
  const std::string json = rt::showcase_inventory_json(rt::GAL_ALL);
  check(json.rfind("{\"bounds\":", 0) == 0, "inventory opens with the bounds");
  check(json.find("[\"cars\",\"items\",\"scenery\",\"props\",\"landmarks\",\"clutter\",\"set\"]")
                != std::string::npos,
        "inventory names the categories in bit order");
  // Pad order is the button order. Kit first, then each biome by biome_name.
  size_t at = 0;
  const auto named = [&](const std::string& name) {
    const std::string key = "\"name\":\"" + name + "\"";
    const size_t f = json.find(key, at);
    check(f != std::string::npos, "inventory lists the " + name + " pad");
    if (f != std::string::npos) at = f + key.size();
  };
  named("kit");
  for (int i = 0; i < rt::biome_count(); i++) named(rt::biome_name(i));
  const std::string none = rt::showcase_inventory_json(0);
  check(none.rfind("{\"bounds\":", 0) == 0, "an empty mask still reports bounds");
  check(none.find("[\"cars\",\"items\",\"scenery\",\"props\",\"landmarks\",\"clutter\",\"set\"]")
                != std::string::npos,
        "an empty mask still names the categories");
  check(none.find("\"name\":\"kit\"") != std::string::npos,
        "an empty mask still lists the pads");
}

}  // namespace

int main() {
  testCompleteness();
  testSlotOrder();
  testStudio();
  testLayout();
  testInventory();

  std::printf("showcase check: %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
