// progression.{h,cc} — the cup star record and the Playroom unlock rule.
//
// The persisted shape is {"v":1,"cups":{"<cupId>":{"best":n}}} where `best` is
// the best FINAL standing any human on this couch has taken in a completed
// Grand Prix of that cup (1-based). Everything else — stars, the lock, the
// unlock progress — is DERIVED here, never stored, so retuning a threshold can
// never disagree with a written save.
//
// The one locked cup is 'rooftop' (the Playroom): it opens when every OTHER
// shipped cup has been finished at least once. The rule names the id rather
// than a position so the synthetic conformance worlds (which carry no
// 'rooftop') lock nothing under replay.
//
// The World Tour banks under the pseudo-cup id "tour" — it has final standings
// and a podium like any cup, but it never counts toward the unlock and is
// never itself locked (bank eligibility admits it explicitly).
#pragma once

#include <string>
#include <utility>
#include <vector>

#include "ttp/canonical.h"

namespace ttp {
namespace rt {
namespace progression {

// The parsed record. Insertion order is first-banked order; serialization is
// canonical (key-sorted), so the order never reaches a shell.
struct Record {
  std::vector<std::pair<std::string, int>> bests;
  // 0 = this cup has never been finished.
  int bestOf(const std::string& cupId) const;
};

// Tolerant: anything that is not a v1 object with sane rows reads as an empty
// record — a corrupt save must never crash a boot, it just starts over.
Record parse(const Value& blob);
Value serialize(const Record& r);

// 0 none, 1 finished, 2 podium, 3 won.
int stars(int best);

// The lock. `allCupIds` is the shipped cup list; the rule is above.
bool unlocked(const Record& r, const std::string& cupId,
              const std::vector<std::string>& allCupIds);
// Progress toward a locked cup's unlock: how many of the required cups are
// finished, out of how many. Meaningful only while locked(cupId).
int unlockDone(const Record& r, const std::string& cupId,
               const std::vector<std::string>& allCupIds);
int unlockNeed(const std::string& cupId, const std::vector<std::string>& allCupIds);

// May this series id bank at all? Shipped cups and the tour do; "random" (and
// anything else a future mode invents) does not.
bool bankEligible(const std::string& cupId, const std::vector<std::string>& allCupIds);

// Bank a FINISHED series: `aiByRank` is the final standings' ai flags in rank
// order, so the best human is the first false entry. Returns true when the
// record improved (first finish, or a better standing than any stored one).
bool bank(Record& r, const std::string& cupId, const std::vector<bool>& aiByRank);

}  // namespace progression
}  // namespace rt
}  // namespace ttp
