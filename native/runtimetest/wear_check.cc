// wear_check — the asphalt-patch planner (ttp/wear.h) over the whole catalogue.
//
// Class-2 evidence only: wear never existed in JS, so there is no corpus and
// nothing here settles a parity question. What it pins is behavioural:
//
//   * DETERMINISM — the plan is a pure function of the built track, computed
//     twice and diffed.
//   * ON THE DECK — every patch, its half-extents included, sits inside the
//     drivable width at its own arclength. A patch off the deck is painted on
//     the kerb or on air.
//   * PATCHES KEEP OFF THE FURNITURE — a patch under a boost pad reads as a
//     broken pad; the planner's rejection rule is asserted, not trusted.
//   * THE DECK DECIDES — a biome whose deck is moulded plastic rather than
//     asphalt (RoadPalette::patched) gets no repairs, and an asphalt one does.
//
// With --dump <trackId> it prints one track's plan for eyeballing; the ctest
// runs it bare.

#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>

#include "ttp/race_track.h"
#include "ttp/theme.h"
#include "ttp/wear.h"

using namespace ttp;

namespace {

int checked = 0, failed = 0;

void expect(bool ok, const char* trackId, const char* what) {
  checked++;
  if (ok) return;
  failed++;
  std::fprintf(stderr, "FAIL %s: %s\n", trackId, what);
}

float wrapDist(float a, float b, float L) {
  float d = std::fabs(a - b);
  return std::min(d, L - d);
}

}  // namespace

int main(int argc, char** argv) {
  const char* dump = (argc == 3 && std::strcmp(argv[1], "--dump") == 0) ? argv[2] : nullptr;

  for (int i = 0; i < TTP_TRACK_COUNT; i++) {
    const TrackDef& def = TTP_TRACKS[i];
    if (dump && std::strcmp(def.id, dump) != 0) continue;
    const RaceTrack geo = build_race_track(def, 1, 0u);
    // The deck this track actually races on — the same resolve the display
    // shim does, so the gate below is the shipping one.
    const rt::Theme theme = rt::resolve_theme(rt::biome_for_track(def.id), def.id);
    const rt::WearPlan plan = rt::compute_wear_plan(geo, theme.road);
    const rt::WearPlan again = rt::compute_wear_plan(geo, theme.road);
    const float L = (float) geo.length;

    // The deck decides. Moulded plastic is never repaired; asphalt always is
    // (the planner's 3..6 has no empty outcome for a track this long).
    expect(theme.road.patched ? !plan.marks.empty() : plan.marks.empty(), def.id,
           theme.road.patched ? "asphalt deck planned no patches"
                              : "plastic deck planned patches");

    // Determinism, memberwise (the struct is plain floats).
    bool same = plan.marks.size() == again.marks.size();
    for (size_t k = 0; same && k < plan.marks.size(); k++) {
      same = std::memcmp(&plan.marks[k], &again.marks[k], sizeof(rt::WearMark)) == 0;
    }
    expect(same, def.id, "plan is not deterministic");

    // Width lookup via the same centerline the planner used — from the track
    // already built above, not a second run of the builder.
    const std::unique_ptr<Centerline> center = make_centerline(geo);
    for (const rt::WearMark& m : plan.marks) {
      const float half = (float) center->widthAt(m.s) * 0.5f;
      expect(std::fabs(m.lat) + m.halfLat <= half + 1e-3f, def.id, "patch off the deck");
      for (const Pad& p : geo.pads) {
        expect(wrapDist(m.s, (float) p.s, L) >= 3.0f, def.id, "patch on a boost pad");
      }
    }

    if (dump) {
      std::printf("%s: length %.1f, %zu patches\n", def.id, geo.length, plan.marks.size());
      for (const rt::WearMark& m : plan.marks) {
        std::printf("  patch s=%.1f lat=%.2f half=%.2fx%.2f shade=%.2f\n",
                    m.s, m.lat, m.halfS, m.halfLat, m.shade);
      }
    }
  }

  std::printf("wear: %d/%d checks passed\n", checked - failed, checked);
  return failed == 0 ? 0 : 1;
}
