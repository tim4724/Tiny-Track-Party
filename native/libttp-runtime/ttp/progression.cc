#include "ttp/progression.h"

namespace ttp {
namespace rt {
namespace progression {

namespace {
const char* kLockedCup = "rooftop";
const int kMaxStars = 3;
// Six of the twelve the other cups hold: more than finishing each once (4),
// short of a podium in every one (8), and reachable without ever winning a cup.
const int kUnlockStars = 6;
}

int Record::bestOf(const std::string& cupId) const {
  for (const auto& kv : bests)
    if (kv.first == cupId) return kv.second;
  return 0;
}

Record parse(const Value& blob) {
  Record r;
  if (blob.type != Value::OBJ) return r;
  const Value* v = blob.find("v");
  if (!v || v->type != Value::NUM || v->num != 1) return r;
  const Value* cups = blob.find("cups");
  if (!cups || cups->type != Value::OBJ) return r;
  for (const auto& kv : cups->obj) {
    if (kv.second.type != Value::OBJ) continue;
    const Value* best = kv.second.find("best");
    if (!best || best->type != Value::NUM) continue;
    const int b = static_cast<int>(best->num);
    if (b < 1 || b != best->num) continue;   // a rank is a positive integer
    if (r.bestOf(kv.first) == 0) r.bests.emplace_back(kv.first, b);
  }
  return r;
}

Value serialize(const Record& r) {
  Value cups = Value::Obj();
  for (const auto& kv : r.bests) {
    Value row = Value::Obj();
    row.set("best", Value::Num(kv.second));
    cups.set(kv.first, std::move(row));
  }
  Value out = Value::Obj();
  out.set("v", Value::Num(1));
  out.set("cups", std::move(cups));
  return out;
}

int stars(int best) {
  if (best < 1) return 0;
  if (best == 1) return kMaxStars;
  if (best <= 3) return 2;
  return 1;
}

int starsEarned(const Record& r, const std::vector<std::string>& cupIds) {
  int n = 0;
  for (const std::string& id : cupIds) n += stars(r.bestOf(id));
  return n;
}

int starsTotal(const std::vector<std::string>& cupIds) {
  return kMaxStars * static_cast<int>(cupIds.size());
}

bool unlocked(const Record& r, const std::string& cupId,
              const std::vector<std::string>& allCupIds) {
  if (cupId != kLockedCup) return true;
  return unlockDone(r, cupId, allCupIds) >= unlockNeed(cupId);
}

int unlockDone(const Record& r, const std::string& cupId,
               const std::vector<std::string>& allCupIds) {
  int done = 0;
  for (const std::string& id : allCupIds)
    if (id != cupId) done += stars(r.bestOf(id));
  return done;
}

int unlockNeed(const std::string& cupId) {
  return cupId == kLockedCup ? kUnlockStars : 0;
}

bool bankEligible(const std::string& cupId, const std::vector<std::string>& allCupIds) {
  for (const std::string& id : allCupIds)
    if (id == cupId) return true;
  return false;
}

bool bank(Record& r, const std::string& cupId, const std::vector<bool>& aiByRank) {
  int pos = 0;
  for (size_t i = 0; i < aiByRank.size(); ++i) {
    if (!aiByRank[i]) { pos = static_cast<int>(i) + 1; break; }
  }
  if (pos == 0) return false;   // no human in the standings — nothing to bank
  for (auto& kv : r.bests) {
    if (kv.first != cupId) continue;
    if (pos >= kv.second) return false;
    kv.second = pos;
    return true;
  }
  r.bests.emplace_back(cupId, pos);
  return true;
}

}  // namespace progression
}  // namespace rt
}  // namespace ttp
