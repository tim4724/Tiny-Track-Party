// GrandPrix — the pure scoring core
// behind the Cup / Random picks. Clock-free and RNG-injected (all identity/meta
// enters through apply_race; randomness through the
// injected rng in ShuffleBag). Off the golden-trace conformance path (no fixture
// exercises it), but ported for parity; a faithful transliteration.
#pragma once

#include <cstddef>
#include <functional>
#include <string>
#include <utility>
#include <vector>

#include "ttp/game.h"  // Id

namespace ttp {

// Points by finish rank (1st..4th). DNF earns nothing.
extern const int POINTS_BY_RANK[4];

// Endless track draw with no repeats until every id is seen (Fisher-Yates, no
// boundary repeat). rng() -> [0,1) is injected.
class ShuffleBag {
 public:
  ShuffleBag(std::vector<std::string> ids, std::function<double()> rng);
  std::string draw();

 private:
  void refill();
  std::vector<std::string> all_;
  std::vector<std::string> bag_;
  bool hasLast_ = false;
  std::string last_;
  std::function<double()> rng_;
};

struct GpResult { Id playerId; int rank; bool finished; };
struct GpFieldEntry { Id peerIndex; std::string name; int colorIndex; bool ai; };
struct GpStanding {
  Id playerId; std::string name; int colorIndex; bool ai;
  int points; int gained; bool lastRankNull; int lastRank;
  // No field entry named this player when their row was created (JS:
  // `seats.get(id) || {}`), so name/colorIndex are JS `undefined` rather than
  // ""/0 and must serialize as ABSENT keys. Same idiom as lastRankNull.
  bool seatNull;
};
struct GpCup { std::string id, name; std::vector<std::string> tracks; };

class CupSeries {
 public:
  CupSeries(const GpCup& cup, std::function<std::string()> drawNext = nullptr);

  bool endless() const { return (bool)drawNext_; }
  int raceCount() const { return (int)cup_.tracks.size(); }
  std::string currentTrackId() const { return cup_.tracks[raceIndex_]; }
  int raceIndex() const { return raceIndex_; }
  // "" stands for JS null (no next race queued).
  std::string nextTrackId() const {
    return raceIndex_ + 1 < raceCount() ? cup_.tracks[raceIndex_ + 1] : std::string();
  }
  const GpCup& cup() const { return cup_; }
  bool finished() const { return done_; }

  void applyRace(const std::vector<GpResult>& results, const std::vector<GpFieldEntry>& field);
  void advance();
  std::vector<GpStanding> standings() const;
  // The LAST APPLIED race's finish order (ids by that race's rank) — the next
  // race's grid. Empty before any race is banked. Only rows ranked by that
  // race qualify; a player who sat it out has no position to inherit.
  std::vector<Id> lastRaceOrder() const;
  void rekey(const Id& oldId, const Id& newId);

 private:
  struct Meta {
    std::string name; int colorIndex = 0; bool ai = false;
    int points = 0; int gained = 0;
    bool lastRankNull = true; int lastRank = 0;
    int lastRaceIndex = -1;
    // Set once, at row creation, exactly like name/colorIndex/ai in the JS twin:
    // a later race that does name the seat does NOT backfill it.
    bool seatNull = true;
  };
  Meta* findMeta(const Id& id);
  const Meta* findMeta(const Id& id) const;

  GpCup cup_;
  std::function<std::string()> drawNext_;
  int raceIndex_ = 0;
  int lastApplied_ = -1;
  bool done_ = false;
  std::vector<std::pair<Id, Meta>> meta_;  // insertion order = first-seen order
};

}  // namespace ttp
