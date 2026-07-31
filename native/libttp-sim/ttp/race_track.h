// race_track — the C++ twin of record-trace.mjs's buildRaceTrack: take a shipped
// track definition (generated/track_defs.h), run the native TrackBuilder, and
// assemble the Centerline + GameTrack the sim actually races on.
//
// Every host needs this exact assembly (the runtime ABI, the replay/record CLI,
// the balance probes), and three private copies would be three chances to drift,
// so it lives here once. Header-only: it is a dozen lines of plumbing over
// build_race_track(), not logic worth a translation unit.
#pragma once

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "generated/track_defs.h"
#include "ttp/centerline.h"
#include "ttp/game.h"
#include "ttp/trackbuilder.h"

namespace ttp {

// The centerline must outlive the GameTrack that points at it, so they travel
// together.
struct BuiltRaceTrack {
  std::unique_ptr<Centerline> centerline;
  GameTrack game;
};

// Scans TTP_TRACK_TOTAL, not TTP_TRACK_COUNT: the dev-only ranges sit past the
// catalogue and must resolve by id (?solo&track=gym) without joining any sweep.
inline const TrackDef* find_track_def(const std::string& id) {
  for (int i = 0; i < TTP_TRACK_TOTAL; i++)
    if (id == TTP_TRACKS[i].id) return &TTP_TRACKS[i];
  return nullptr;
}

// The built track's ring as the Centerline the sim navigates by. Split out of
// build_race_track_by_id because it is the one conversion everyone needs (the
// wear planner, wear_check) — a private copy per caller is the drift this
// header exists to prevent.
inline std::unique_ptr<Centerline> make_centerline(const RaceTrack& rt) {
  std::vector<Sample> samples;
  samples.reserve(rt.samples.size());
  for (const OutSample& s : rt.samples) {
    Sample cs;
    cs.pos = s.pos; cs.tangent = s.tangent; cs.up = s.up; cs.lateral = s.lateral;
    cs.width = s.width; cs.s = s.s;
    samples.push_back(cs);
  }
  return std::make_unique<Centerline>(std::move(samples), rt.length);
}

// Returns false (with `err` set) on an unknown track id.
inline bool build_race_track_by_id(const std::string& trackId, int laps, uint32_t seed,
                                   BuiltRaceTrack& out, std::string& err) {
  const TrackDef* def = find_track_def(trackId);
  if (!def) { err = "unknown trackId '" + trackId + "'"; return false; }
  RaceTrack rt = build_race_track(*def, laps, seed);

  out.centerline = make_centerline(rt);

  GameTrack& g = out.game;
  g.centerline = out.centerline.get();
  g.length = rt.length;
  g.totalLaps = laps;
  g.roadWidth = rt.roadWidth;
  g.seed = seed;
  for (const Hazard& h : rt.hazards) g.hazards.push_back(Zone{h.s, h.lat, h.radius});
  for (const Pad& p : rt.pads)
    g.pads.push_back(PadRt{p.s, p.lat, p.strip, p.radius, p.halfLen, p.halfWidth});
  for (const Box& b : rt.boxes) g.boxes.push_back(BoxRt{b.s, b.lat, b.radius, 0, 0});
  for (const ttp::Pole& p : rt.poles) g.poles.push_back(PoleRt{p.s, p.lat, p.radius});
  for (const Banana& b : rt.bananas)
    g.bananas.push_back(BananaRt{0, b.s, b.lat, Id::None(), 0, true, 0, false});
  return true;
}

}  // namespace ttp
