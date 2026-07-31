// wear — the road's asphalt patches, planned from the track itself.
//
// A deck straight from the builder reads as a diorama: nothing has ever been
// repaired on it. This layer decides the patch rectangles — a shade darker or
// sun-bleached lighter, a track's own repairs every visit — as PLAIN DATA in
// track space (s, lat), and the renderer stamps them through the static
// deck-decal channel in vroad.
//
// Two siblings shipped here briefly and were removed by decision (2026-08-01,
// git history has both): a pre-rubbered racing groove (rubber is earned live,
// lap by lap) and left/right turn chevrons before sharp corners (parked for a
// later revisit of how sharp turns should announce themselves).
//
// Everything is deterministic from the track (patches are seeded by track
// id), which is what wear_check pins across the catalogue.
#pragma once

#include <vector>

#include "ttp/trackbuilder.h"

namespace ttp {
namespace rt {

// One asphalt patch: a hard-edged rectangle of the deck's own colour scaled
// by `shade` (<1 a darker repair, >1 a sun-bleached one), stamped flat by the
// road shader as a static deck decal.
struct WearMark {
  float s = 0, lat = 0, halfS = 0, halfLat = 0;
  float shade = 1;
};

struct WearPlan {
  std::vector<WearMark> marks;
};

// Pure function of the built track. Deterministic: equal geometry gives an
// identical plan (wear_check replays the catalogue twice and diffs).
WearPlan compute_wear_plan(const RaceTrack& geo);

}  // namespace rt
}  // namespace ttp
