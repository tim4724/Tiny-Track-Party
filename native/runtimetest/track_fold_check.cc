// Track fold check — no catalogue corner folds its inner kerb.
//
// The renderer sweeps the road as rulings `pos + lateral * offset`, out to the
// kerb's far edge. Where a corner's radius is under that offset, the inner
// edge sits past the corner's centre and the ribbon folds: the kerb draws as a
// pinched V and the car's inner curb rides the same point. The seeded tracks
// had exactly that where closeCourse's tail joins the lap (scripts/track-gen.mjs,
// CORNER FLOOR), which now rounds them with a road-only margin. This holds the
// result to the real thing — each track's own kerb, from its biome's theme — so
// a wider kerb or a looser generator fails here rather than on screen.

#include <cmath>
#include <cstdio>
#include <string>

#include "ttp/race_track.h"
#include "ttp/theme.h"

using namespace ttp;

namespace {

// The limits and windows are the builder's (trackbuilder.h KERB_FOLD_*,
// SURFACE_FOLD_*): near 1 the kerb already draws as a point. The generator
// rounds to |k| * halfWidth <= 0.7 (track-gen.mjs ROAD_FOLD_MAX), which on a
// 5 m road under the widest kerb lands near 0.85 here, so raising either limit
// means re-reading the other. The builder narrows a corner's inside strip to
// keep the drawn ribbon under it (trackbuilder.cc narrowFolds).
const double STEP = 0.1;   // where it is measured

}  // namespace

int main() {
  int failures = 0;
  for (int i = 0; i < TTP_TRACK_COUNT; i++) {
    const char* id = TTP_TRACKS[i].id;
    BuiltRaceTrack bt;
    std::string err;
    if (!build_race_track_by_id(id, 1, 1u, bt, err)) {
      std::fprintf(stderr, "FAIL build %s: %s\n", id, err.c_str());
      failures++;
      continue;
    }
    const double kerb = rt::resolve_theme(rt::biome_for_track(id), id).road.kerbW;
    // The builder narrows for KERB_MAX, not for this kerb, so a wider one is
    // under-narrowed whether or not a corner shows it yet. kerbW is a float:
    // the slack is what widening it to a double adds.
    const bool kerbFits = kerb <= KERB_MAX + 1e-6;
    if (!kerbFits)
      std::fprintf(stderr, "FAIL %s: its kerb (%.3f) is wider than KERB_MAX (%.3f, trackbuilder.h)\n", id, kerb, KERB_MAX);
    Centerline& cl = *bt.game.centerline;
    double worst = 0, worstS = 0, worstSurface = 0, worstSurfaceS = 0;
    for (double s = 0; s < bt.game.length; s += STEP) {
      // The worse side of the builder's own measure (edge_fold). On a road
      // with no strip, or the same strip both sides, that is |k| * (half +
      // kerb) about the centre line.
      const auto foldOver = [&](double window, double past) {
        const EdgeFold fold = edge_fold(cl, s, window, past);
        return std::fmax(fold.side[0], fold.side[1]);
      };
      const double fold = foldOver(KERB_FOLD_WINDOW, kerb);
      if (fold > worst) { worst = fold; worstS = s; }
      // the driven surface, kerb's foot to kerb's foot, at the scale its
      // cross-sections could cross
      const double surface = foldOver(SURFACE_FOLD_WINDOW, 0);
      if (surface > worstSurface) { worstSurface = surface; worstSurfaceS = s; }
    }
    const bool ok = kerbFits && worst <= KERB_FOLD_MAX && worstSurface <= SURFACE_FOLD_MAX;
    if (!ok) failures++;
    std::printf("%s %-11s kerb %.2f  worst kerb fold %.2f at s=%.1f, surface %.2f at s=%.1f\n", ok ? "ok  " : "FAIL", id,
                kerb, worst, worstS, worstSurface, worstSurfaceS);
  }
  std::printf("track fold check: %d tracks, %d failures\n", TTP_TRACK_COUNT, failures);
  return failures == 0 ? 0 : 1;
}
