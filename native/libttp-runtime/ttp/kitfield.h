// kitfield — where every model in the Kenney kits stands when the asset gallery
// puts the whole kit on the ground at once.
//
// The gallery used to browse the kits as a sheet of Kenney's own preview
// renders. A render answers what a model IS; it cannot answer whether it belongs
// in this game, because that question is about size against a car, about the
// biome's light on it, and about whether it reads as the same moulded plastic.
// So the browser is a FIELD: every candidate standing on the ground beside the
// track, at the size it would ship.
//
// Here rather than in the renderer for the usual reason (native/CLAUDE.md): the
// packing names no platform API, so every leg compiles AND executes it, and
// `kitfield` ctests it. The renderer measures the footprints, offsets the field
// onto clear ground and seats each model on the surface; the arithmetic between
// those two is this file.
//
// INLINE, header-only, and that is load-bearing: the renderer needs this and the
// renderer may not link libttp-runtime (native/CLAUDE.md). `boost_shades` in
// theme.h is the same shape for the same reason.
//
// DEV-ONLY. Nothing on the shipping path calls this — the field is reachable
// from /gallery-assets.html and nowhere else.
#pragma once

#include <algorithm>
#include <vector>

namespace ttp {
namespace rt {

// One model's ground footprint, in world units, measured from its glTF AABB.
struct KitFootprint {
  float w = 0.0f;  // extent across x
  float d = 0.0f;  // extent across z
};

// Where that model stands, in FIELD SPACE: the CENTRE of its footprint, +x along
// a row and +z down the rows, with the first row's near edge at z = 0. The
// renderer translates the whole field onto clear ground.
struct KitSpot {
  float x = 0.0f;
  float z = 0.0f;
};

// How wide a row runs before it wraps, and the clear ground left between
// neighbours. Field space is world space, so these are the units a car is ~2
// wide in: a row is a long walk on purpose, since the models arrive sorted and
// walking one is how you compare a family of them.
constexpr float kKitRowWidth = 96.0f;
constexpr float kKitGap = 1.4f;
// The cell a footprint-less model gets. A few kit models measure zero on one
// axis (a flat decal plane, an empty node); without a floor they would stack on
// one spot and read as a single object.
constexpr float kKitMinCell = 0.6f;
// How much clear ground the field wants around it. Nothing the scene decorates
// the horizon with may stand inside this, or a row comes out parked behind a
// mountain — which is a browser you have to fly around to read.
constexpr float kKitFieldClear = 30.0f;
// And how far above the ground its own apron sits. Enough to clear a biome's
// water sheet, which covers every piece of ground far enough out to hold a
// field; invisible on a dry one.
constexpr float kKitFieldLift = 0.35f;

// Row-pack `models` in the order given — the caller's order is the gallery's
// (kit, then name), and packing must not reorder it or the field stops matching
// the list beside it. One spot per model, same indices.
inline std::vector<KitSpot> kit_field_layout(const std::vector<KitFootprint>& models) {
  std::vector<KitSpot> out;
  out.reserve(models.size());
  // A row fills left to right and then wraps; the next row clears the DEEPEST
  // model in the one above, so a row of trees cannot walk into the row of
  // trucks behind it.
  float x = 0.0f, z = 0.0f, rowDepth = 0.0f;
  for (const KitFootprint& m : models) {
    const float w = std::max(m.w, kKitMinCell);
    const float d = std::max(m.d, kKitMinCell);
    // Wrap on the model that would OVERRUN the row, never on one that exactly
    // fills it — and never on the first of a row, or a model wider than the
    // whole row would wrap for ever.
    if (x > 0.0f && x + w > kKitRowWidth) {
      z += rowDepth + kKitGap;
      x = 0.0f;
      rowDepth = 0.0f;
    }
    out.push_back({ x + w * 0.5f, z + d * 0.5f });
    x += w + kKitGap;
    rowDepth = std::max(rowDepth, d);
  }
  return out;
}

}  // namespace rt
}  // namespace ttp
