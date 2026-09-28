// preview.{h,cc} — the couch and the boards the screens gallery photographs.
//
// Three harnesses (the web's TestHarness, and the tvOS and Android Scenarios)
// stand every gallery screen up with no party behind it, so each has to
// FABRICATE a couch's progress and a finished race's standings. They used to
// type those numbers each, and the copies drifted until the same card showed a
// different leader, different banked points and a different cup shelf on each
// platform. So the fabrication is decided once, here: the shells load the record
// and run the board through the same model calls live play makes.
//
// Harness-only: nothing a party does reaches this.
#pragma once

#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/progression.h"
#include "ttp/scalar_id.h"

namespace ttp {
namespace rt {
namespace preview {

// A mid-game couch: the first shipped cup won, the second a podium, nothing
// since — so the shelf reads three stars, two, then blanks, and the locked cup
// sits short of its unlock, which is the dressing the lobby cards exist to show.
progression::Record progressRecord(const std::vector<std::string>& cupIds);

enum class Kind { Results, Intermission, Podium };

// "results" | "intermission" | "podium"; false otherwise.
bool parseKind(const std::string& s, Kind* out);

struct Racer {
  ScalarId id;
  std::string name;
  int colorIndex = 0;
  bool ai = false;
};

struct CupRef {
  std::string id;
  std::string name;
  std::vector<std::string> tracks;
  std::vector<std::string> trackNames;  // parallel to `tracks`
};

// The fake lap times, by finishing place.
inline constexpr double FINISH_TIMES[8] = {28.4, 30.7, 33.1, 35.8, 38.2, 41.0, 44.3, 47.6};

// The board a preview shows, in the shape ttp_ui_standings_live_json answers
// ({over, hostPeerIndex, order:[row…], series?}), for `ttp_ui_results_view_json`.
//
// `field` is the race standing behind the board, in any order: players finish
// first, then the CPU fill, each keeping its own name, livery and `ai` flag (the
// model draws a CPU's suffix from it). A single race carries `joiner`, the late
// joiner riding under the field; a cup dressing is race 2 of `cup` (intermission)
// or its last race (podium) — or race `raceIndex` when it is >= 0, for a preview
// that walks a cup — with banked points that make the cup table differ from this
// race's finishing order part-way through the count.
Value board(Kind kind, const std::vector<Racer>& field, const Racer& joiner, const CupRef& cup,
            double autoAdvanceMs, int raceIndex = -1);

}  // namespace preview
}  // namespace rt
}  // namespace ttp
