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

// The kerb's far edge may come this close to a corner's centre, as a fraction of
// the radius: past 1 it folds, and near 1 it already draws as a point. The
// generator rounds to |k| * halfWidth <= 0.7 (track-gen.mjs ROAD_FOLD_MAX), which
// on a 5 m road under the widest kerb lands near 0.85 here, so raising either
// limit means re-reading the other.
const double KERB_FOLD_MAX = 0.9;
const double STEP = 0.1;

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
    Centerline& cl = *bt.game.centerline;
    double worst = 0, worstS = 0;
    for (double s = 0; s < bt.game.length; s += STEP) {
      // Curvature IN THE ROAD PLANE, the only kind that stretches a lateral
      // offset: a loop's pitch does not fold its kerbs.
      const Frame a = cl.sampleAt(s - STEP / 2), b = cl.sampleAt(s + STEP / 2);
      const double k = std::fabs(b.lateral.clone().sub(a.lateral).dot(a.tangent)) / STEP;
      const double fold = k * (cl.widthAt(s) / 2 + kerb);
      if (fold > worst) { worst = fold; worstS = s; }
    }
    const bool ok = worst <= KERB_FOLD_MAX;
    if (!ok) failures++;
    std::printf("%s %-11s kerb %.2f  worst |k|*(half+kerb) %.2f at s=%.1f\n", ok ? "ok  " : "FAIL", id, kerb, worst,
                worstS);
  }
  std::printf("track fold check: %d tracks, %d failures\n", TTP_TRACK_COUNT, failures);
  return failures == 0 ? 0 : 1;
}
