#include "ttp/progression.h"

namespace ttp {
namespace rt {
namespace progression {

namespace {
const char* kLockedCup = "rooftop";
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
  if (best == 1) return 3;
  if (best <= 3) return 2;
  return 1;
}

bool unlocked(const Record& r, const std::string& cupId,
              const std::vector<std::string>& allCupIds) {
  if (cupId != kLockedCup) return true;
  for (const std::string& id : allCupIds) {
    if (id == kLockedCup) continue;
    if (r.bestOf(id) == 0) return false;
  }
  return true;
}

int unlockDone(const Record& r, const std::string& cupId,
               const std::vector<std::string>& allCupIds) {
  int done = 0;
  for (const std::string& id : allCupIds)
    if (id != cupId && r.bestOf(id) > 0) done++;
  return done;
}

int unlockNeed(const std::string& cupId, const std::vector<std::string>& allCupIds) {
  int need = 0;
  for (const std::string& id : allCupIds)
    if (id != cupId) need++;
  return need;
}

bool bankEligible(const std::string& cupId, const std::vector<std::string>& allCupIds) {
  if (cupId == "tour") return true;
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
