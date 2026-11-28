#include "ttp/showcase.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include "generated/track_defs.h"
#include "ttp/canonical.h"
#include "ttp/detail.h"

namespace ttp {
namespace rt {
namespace {

// The kit cars. The same four strings as public/shared/protocol.js CAR_MODELS
// and native/libttp-party/ttp/protocol.h. This library does not include the
// party header; showcase_check pins the spellings.
const char* kCars[] = { "vehicle-gt", "vehicle-lemans", "vehicle-stock", "vehicle-jeep" };
// Display.js PROP_MODELS: fetched for every scene, not a biome's scatter.
const char* kNamed[] = { "item-box", "item-banana", "item-cone", "vehicle-monster-truck" };

constexpr float kYaw = 0.4f;
constexpr float kMargin = 2.0f;
constexpr float kMinW = 18.0f, kMinH = 12.0f;
constexpr float kGap = 3.0f;
constexpr float kPitchSmall = 4.5f;
constexpr int kColsSmall = 6;
constexpr float kPitchKit = 4.0f;
constexpr int kColsKit = 6;
constexpr float kPitchLm = 11.0f;
constexpr int kColsLm = 4;
constexpr float kPitchCl = 2.8f;
constexpr int kColsCl = 6;
constexpr int kColsSet = 12;
constexpr uint32_t kKitPad = 0xd9d6cf;
// A step darker than kKitPad, so the kit pad reads as a pad.
constexpr uint32_t kGalleryGround = 0xc3bfb6;

struct Sc { std::string model; float scale; };
struct BiomeBag {
  const char* name = "";
  uint32_t color = 0;
  std::vector<Sc> scenery;
  std::vector<Sc> props;
  std::vector<uint32_t> landmarks;
  std::vector<ClutterSpec> clutter;
  std::vector<Sc> sets;
};

float stampScale(float s0, float s1) {
  const float s = s0 + 0.5f * s1;
  return s > 1e-3f ? s : 1.0f;
}

void addModel(std::vector<Sc>& into, const std::string& model, float scale) {
  for (const Sc& s : into) if (s.model == model) return;
  into.push_back({ model, scale });
}

void addKind(std::vector<uint32_t>& into, uint32_t kind) {
  if (std::find(into.begin(), into.end(), kind) == into.end()) into.push_back(kind);
}

void addClutter(std::vector<ClutterSpec>& into, const ClutterSpec& c) {
  for (const ClutterSpec& seen : into) if (seen.kind == c.kind) return;
  into.push_back(c);
}

uint32_t slotOf(std::vector<std::string>& models, const std::string& model) {
  for (size_t i = 0; i < models.size(); i++) if (models[i] == model) return (uint32_t) i;
  models.push_back(model);
  return (uint32_t) models.size() - 1;
}

uint32_t padColorFor(const char* name, const Theme& base) {
  // Sunset shares grass's lawn kind; a warmer pad is what tells the two apart.
  if (std::strcmp(name, "sunset") == 0) return 0xc6a15a;
  if (std::strcmp(name, "playroom") == 0) return base.groundBase ? base.groundBase : 0xd6b07c;
  switch (base.groundKind) {
    case GROUND_SAND: return 0xdec896;
    case GROUND_REDROCK: return 0xd39671;
    case GROUND_SNOW: return 0xedf2f7;
    case GROUND_WOOD: return base.groundBase ? base.groundBase : 0xd6b07c;
    default: return 0x6aa84f;  // lawn
  }
}

void absorb(BiomeBag& bag, const Theme& o) {
  for (const TreeSpec& tr : o.scenery.trees) addModel(bag.scenery, tr.model, stampScale(tr.s0, tr.s1));
  if (o.scenery.hasBush) addModel(bag.scenery, o.scenery.bush.model, stampScale(o.scenery.bush.s0, o.scenery.bush.s1));
  for (const PropStamp& p : o.props.scatter) {
    if (p.slot >= o.props.models.size()) continue;
    addModel(bag.props, o.props.models[p.slot], stampScale(p.s0, p.s1));
  }
  for (uint32_t k : o.landmarks) addKind(bag.landmarks, k);
  for (const ClutterSpec& c : o.scenery.clutter) addClutter(bag.clutter, c);
}

BiomeBag* bagFor(std::vector<BiomeBag>& bags, const char* name) {
  for (BiomeBag& b : bags) if (std::strcmp(b.name, name) == 0) return &b;
  return nullptr;
}

struct Kit {
  std::vector<BiomeBag> bags;
  std::vector<std::string> scenery, props, set;
  std::vector<uint32_t> landmarks;
  std::vector<ClutterSpec> clutter;
};

// The union, once per call. Mask-independent: a filter only drops spots.
Kit buildKit() {
  Kit kit;
  for (int i = 0; i < biome_count(); i++) {
    const char* name = biome_name(i);
    const Theme base = resolve_theme(name, "");
    BiomeBag bag;
    bag.name = name;
    bag.color = padColorFor(name, base);
    absorb(bag, base);
    kit.bags.push_back(std::move(bag));
  }
  for (int i = 0; i < TTP_TRACK_COUNT; i++) {
    const char* id = TTP_TRACKS[i].id;
    BiomeBag* bag = bagFor(kit.bags, biome_for_track(id));
    if (!bag) continue;
    absorb(*bag, resolve_theme(bag->name, id));
  }
  const bool lite = detail_in_force() == Detail::Lite;
  for (int i = 0; i < TTP_TRACK_COUNT; i++) {
    BiomeBag* bag = bagFor(kit.bags, biome_for_track(TTP_TRACKS[i].id));
    if (!bag) continue;
    for (int k = 0; k < TTP_TRACKS[i].nSet; k++) {
      const SetDef& d = TTP_TRACKS[i].set[k];
      if (lite && !d.lite) continue;
      if (!d.model) continue;
      bool seen = false;
      for (const std::string& m : kit.set) seen = seen || m == d.model;
      if (seen) continue;
      const float scale = d.scale > 0 ? (float) d.scale : 1.0f;
      kit.set.push_back(d.model);
      bag->sets.push_back({ d.model, scale });
    }
  }
  for (const BiomeBag& bag : kit.bags) {
    for (const Sc& s : bag.scenery) slotOf(kit.scenery, s.model);
    for (const Sc& s : bag.props) slotOf(kit.props, s.model);
    for (uint32_t k : bag.landmarks) addKind(kit.landmarks, k);
    for (const ClutterSpec& c : bag.clutter) addClutter(kit.clutter, c);
  }
  // resolve_theme already renamed scenery and props when the lite tier is on.
  // Set names were read off the catalogue, so they still need it. In place:
  // spot slots are indices and must not move. Full tier keeps the authored name.
  if (lite) {
    lite_models(kit.set);
    for (BiomeBag& bag : kit.bags) {
      for (Sc& s : bag.sets) {
        std::vector<std::string> one{ s.model };
        lite_models(one);
        s.model = std::move(one[0]);
      }
    }
  }
  return kit;
}

struct Item { uint32_t cat, channel, slot; float scale; };

uint32_t findSlot(const std::vector<std::string>& models, const std::string& model) {
  for (size_t i = 0; i < models.size(); i++) if (models[i] == model) return (uint32_t) i;
  return (uint32_t) models.size();
}

// Lay `items` as a grid centred in `contentW`, stacked on +Z. Empty skips.
void layGroup(std::vector<GallerySpot>& local, const std::vector<Item>& items,
              float pitch, int maxCols, float contentW, float& z) {
  const int n = (int) items.size();
  if (!n) return;
  const int cols = std::min(maxCols, n);
  const int rows = (n + cols - 1) / cols;
  const float w = (float) cols * pitch;
  const float x0 = (contentW - w) * 0.5f;
  for (int i = 0; i < n; i++) {
    const int c = i % cols, r = i / cols;
    GallerySpot s;
    s.cat = items[i].cat;
    s.channel = items[i].channel;
    s.slot = items[i].slot;
    s.x = x0 + ((float) c + 0.5f) * pitch;
    s.z = z + ((float) r + 0.5f) * pitch;
    s.yaw = kYaw;
    s.scale = items[i].scale;
    local.push_back(s);
  }
  z += (float) rows * pitch;
}

float groupW(const std::vector<Item>& items, float pitch, int maxCols) {
  const int n = (int) items.size();
  if (!n) return 0;
  return (float) std::min(maxCols, n) * pitch;
}

// One pad. `groups` is parallel to pitch/cols. Content is centred in the pad;
// an empty pad (everything filtered, or a biome with nothing) stays at the
// minimum so the colour is still there.
void placePad(Theme& t, float& padX, uint32_t color,
              const std::vector<std::vector<Item>>& groups,
              const std::vector<float>& pitch, const std::vector<int>& cols) {
  float contentW = 0;
  for (size_t g = 0; g < groups.size(); g++) contentW = std::max(contentW, groupW(groups[g], pitch[g], cols[g]));
  std::vector<GallerySpot> local;
  float z = 0;
  for (size_t g = 0; g < groups.size(); g++) layGroup(local, groups[g], pitch[g], cols[g], contentW, z);
  const float contentH = z;
  const float padW = std::max(contentW + 2.0f * kMargin, kMinW);
  const float padH = std::max(contentH + 2.0f * kMargin, kMinH);
  const float ox = padX + (padW - contentW) * 0.5f;
  const float oz = (padH - contentH) * 0.5f;
  for (GallerySpot& s : local) {
    s.x += ox;
    s.z += oz;
    t.gallerySpots.push_back(s);
  }
  t.galleryPads.push_back({ padX, 0, padX + padW, padH, color });
  padX += padW + kGap;
}

}  // namespace

const std::vector<std::string>& showcase_models() {
  static const std::vector<std::string> models = showcase_theme(biome_name(0), "").scenery.models;
  return models;
}

const std::vector<std::string>& showcase_prop_models() {
  static const std::vector<std::string> models = showcase_theme(biome_name(0), "").props.models;
  return models;
}

const std::vector<std::string>& showcase_set_models() {
  static const std::vector<std::string> models = showcase_theme(biome_name(0), "").set.models;
  return models;
}

Theme showcase_theme(const char* biomeName, const char* trackId, uint32_t mask) {
  (void) biomeName;
  // Studio daylight, started from grass only so the unset fields stay the
  // shipping defaults, then overwritten. No road, no hills, no water, no air.
  Theme t = resolve_theme("grass", trackId ? trackId : "");
  t.gallery = true;
  t.galleryGround = kGalleryGround;
  t.sky[0] = 0x8ec8f0;
  t.sky[1] = 0xd7eef8;
  t.sky[2] = 0xc5d5c8;
  t.fog = 0xd7eef8;
  t.skyCurve = 0.65f;
  t.key = { 0xfff1d0, 1.4f };
  t.hemi = { 0xffffff, 0x9aa68f, 2.2f };
  t.clouds.count = 0;
  t.haze.count = 0;
  t.ambient.count = 0;
  t.life.count = 0;
  t.birds.count = 0;
  t.kites.count = 0;
  t.hasPlane = false;
  t.plane = {};
  t.balloon.panels.clear();
  t.land.clear();
  t.groundKind = GROUND_WOOD;
  t.groundBase = 0;
  t.hasWater = false;
  t.hasIce = false;

  const Kit kit = buildKit();
  t.scenery = {};
  t.scenery.models = kit.scenery;
  t.scenery.clutter = kit.clutter;
  t.props = {};
  t.props.models = kit.props;
  t.set = {};
  t.set.models = kit.set;
  t.landmarks = kit.landmarks;

  for (const char* c : kCars) t.galleryCars.push_back(c);
  for (const char* c : kNamed) t.galleryNamed.push_back(c);

  const auto on = [&](uint32_t cat) { return (mask & cat) != 0; };
  float padX = 0;

  std::vector<Item> cars, items;
  if (on(GAL_CARS)) {
    for (uint32_t i = 0; i < t.galleryCars.size(); i++) cars.push_back({ GAL_CARS, GAL_CH_CAR, i, 1 });
  }
  if (on(GAL_ITEMS)) {
    for (uint32_t i = 0; i < t.galleryNamed.size(); i++) items.push_back({ GAL_ITEMS, GAL_CH_NAMED, i, 1 });
    // Scale 1: the renderer bakes kRocketMesh, the same factor as a live rocket.
    items.push_back({ GAL_ITEMS, GAL_CH_ROCKET, 0, 1 });
  }
  placePad(t, padX, kKitPad, { cars, items }, { kPitchKit, kPitchKit }, { kColsKit, kColsKit });

  for (const BiomeBag& bag : kit.bags) {
    std::vector<Item> scenery, props, landmarks, clutter, sets;
    if (on(GAL_SCENERY)) {
      for (const Sc& s : bag.scenery) {
        const uint32_t slot = findSlot(t.scenery.models, s.model);
        if (slot == t.scenery.models.size()) continue;
        scenery.push_back({ GAL_SCENERY, GAL_CH_SCENERY, slot, s.scale });
      }
    }
    if (on(GAL_PROPS)) {
      for (const Sc& s : bag.props) {
        const uint32_t slot = findSlot(t.props.models, s.model);
        if (slot == t.props.models.size()) continue;
        props.push_back({ GAL_PROPS, GAL_CH_PROP, slot, s.scale });
      }
    }
    if (on(GAL_LANDMARKS)) {
      for (uint32_t k : bag.landmarks) landmarks.push_back({ GAL_LANDMARKS, GAL_CH_LANDMARK, k, 1 });
    }
    if (on(GAL_CLUTTER)) {
      for (const ClutterSpec& c : bag.clutter) clutter.push_back({ GAL_CLUTTER, GAL_CH_CLUTTER, c.kind, 1 });
    }
    if (on(GAL_SET)) {
      for (const Sc& s : bag.sets) {
        const uint32_t slot = findSlot(t.set.models, s.model);
        if (slot == t.set.models.size()) continue;
        sets.push_back({ GAL_SET, GAL_CH_SET, slot, s.scale });
      }
    }
    placePad(t, padX, bag.color,
             { scenery, props, landmarks, clutter, sets },
             { kPitchSmall, kPitchSmall, kPitchLm, kPitchCl, kGallerySetPitch },
             { kColsSmall, kColsSmall, kColsLm, kColsCl, kColsSet });
  }
  return t;
}

std::string showcase_inventory_json(uint32_t mask) {
  const Theme t = showcase_theme(biome_name(0), "", mask);
  // The opening shot is the fullest pad, not the kit. The kit is nine
  // models; a biome pad holds that biome's whole catalogue. An empty mask
  // has no spots, so it opens on the kit. Every pad is still listed, empty
  // ones included, so a button can land on its colour.
  const auto count = [&](const GalleryPad& p) {
    size_t n = 0;
    for (const GallerySpot& s : t.gallerySpots) {
      if (s.x > p.x0 && s.x < p.x1 && s.z > p.z0 && s.z < p.z1) n++;
    }
    return n;
  };
  const GalleryPad* open = t.galleryPads.empty() ? nullptr : &t.galleryPads.front();
  size_t best = 0;
  for (const GalleryPad& p : t.galleryPads) {
    const size_t n = count(p);
    if (n > best) { best = n; open = &p; }
  }
  const auto mm = [](float v) { return Value::Num(std::round(v * 1000.0) / 1000.0); };
  const auto box = [&](Value& o, const GalleryPad& p) {
    o.set("x0", mm(p.x0));
    o.set("x1", mm(p.x1));
    o.set("z0", mm(p.z0));
    o.set("z1", mm(p.z1));
  };
  Value bounds = Value::Obj();
  if (open) box(bounds, *open);
  Value cats = Value::Arr();
  for (const char* c : { "cars", "items", "scenery", "props", "landmarks", "clutter", "set" }) {
    cats.push(Value::Str(c));
  }
  Value pads = Value::Arr();
  for (size_t i = 0; i < t.galleryPads.size(); i++) {
    const char* name = i == 0 ? "kit"
        : (i - 1 < (size_t) biome_count() ? biome_name((int) i - 1) : "");
    Value one = Value::Obj();
    one.set("name", Value::Str(name));
    box(one, t.galleryPads[i]);
    pads.push(std::move(one));
  }
  Value o = Value::Obj();
  o.set("bounds", bounds);
  o.set("categories", cats);
  o.set("pads", std::move(pads));
  return canonical_stringify(o);
}

}  // namespace rt
}  // namespace ttp
