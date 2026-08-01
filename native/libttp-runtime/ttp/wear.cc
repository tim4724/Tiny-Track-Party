#include "ttp/wear.h"

#include <algorithm>
#include <cmath>

#include "ttp/canonical.h"
#include "ttp/race_track.h"
#include "ttp/theme.h"
#include "ttp/util.h"

namespace ttp {
namespace rt {

WearPlan compute_wear_plan(const RaceTrack& geo, const RoadPalette& road) {
  WearPlan plan;
  const float L = (float) geo.length;
  if (!road.patched || L < 20.0f || geo.samples.empty()) return plan;

  // The deck's width per arclength, through the sim's own centerline type.
  const std::unique_ptr<Centerline> center = make_centerline(geo);

  // Seeded by track id so a track's repairs are ITS repairs, every visit
  // (ttp::fnv1a — the same hash theme.cc seeds the shoreline with). Kept off
  // the furniture: a patch under a boost pad reads as a broken pad.
  Mulberry32 rng(fnv1a(geo.trackId) ^ 0x9e3779b9u);
  const auto nearFurniture = [&](float s) {
    const auto near = [&](float fs, float margin) {
      float d = std::fabs(s - fs);
      d = std::min(d, L - d);
      return d < margin;
    };
    for (const Pad& p : geo.pads) if (near((float) p.s, 4.0f)) return true;
    for (const Box& b : geo.boxes) if (near((float) b.s, 2.5f)) return true;
    return false;
  };
  const int want = 3 + (int) (rng.next() * 4.0);  // 3..6
  for (int placed = 0, tries = 0; placed < want && tries < want * 8; tries++) {
    const float s = (float) (rng.next() * L);
    const float u = (float) rng.next();          // lat fraction
    const float hs = 0.5f + 0.6f * (float) rng.next();
    const float hl = 0.35f + 0.45f * (float) rng.next();
    const bool dark = rng.next() < 0.5;
    if (nearFurniture(s)) continue;
    const float half = (float) center->widthAt(s) * 0.5f;
    const float latMax = std::max(0.0f, half - hl - 0.4f);
    WearMark m;
    m.s = s;
    m.lat = (u * 2.0f - 1.0f) * latMax;
    m.halfS = hs;
    m.halfLat = hl;
    m.shade = dark ? 0.86f : 1.10f;
    plan.marks.push_back(m);
    placed++;
  }
  return plan;
}

}  // namespace rt
}  // namespace ttp
