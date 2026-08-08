#include "ttp/grand_prix.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace ttp {

const int POINTS_BY_RANK[4] = {9, 6, 3, 1};

ShuffleBag::ShuffleBag(std::vector<std::string> ids, std::function<double()> rng)
    : all_(std::move(ids)), rng_(std::move(rng)) {}

void ShuffleBag::refill() {
  bag_ = all_;
  for (int i = (int)bag_.size() - 1; i > 0; i--) {  // Fisher-Yates
    int j = (int)std::floor(rng_() * (i + 1));
    std::swap(bag_[i], bag_[j]);
  }
  // draw() pops from the END — swap a boundary repeat to the far end of the bag.
  if (all_.size() > 1 && hasLast_ && bag_.back() == last_) std::swap(bag_.front(), bag_.back());
}

std::string ShuffleBag::draw() {
  if (bag_.empty()) refill();
  last_ = bag_.back(); hasLast_ = true;
  bag_.pop_back();
  return last_;
}

CupSeries::CupSeries(const GpCup& cup, std::function<std::string()> drawNext)
    : cup_{cup.id, cup.name, cup.tracks}, drawNext_(std::move(drawNext)) {}

CupSeries::Meta* CupSeries::findMeta(const Id& id) {
  for (auto& kv : meta_) if (kv.first == id) return &kv.second;
  return nullptr;
}
const CupSeries::Meta* CupSeries::findMeta(const Id& id) const {
  for (const auto& kv : meta_) if (kv.first == id) return &kv.second;
  return nullptr;
}

void CupSeries::applyRace(const std::vector<GpResult>& results, const std::vector<GpFieldEntry>& field) {
  for (auto& kv : meta_) kv.second.gained = 0;  // absentees show "+0"
  for (const GpResult& res : results) {
    const GpFieldEntry* seat = nullptr;
    for (const auto& p : field) if (p.peerIndex == res.playerId) { seat = &p; break; }
    Meta* m = findMeta(res.playerId);
    if (!m) {
      Meta nm;
      nm.seatNull = (seat == nullptr);
      if (seat) { nm.name = seat->name; nm.colorIndex = seat->colorIndex; nm.ai = seat->ai; }
      meta_.emplace_back(res.playerId, nm);
      m = &meta_.back().second;
    }
    m->gained = res.finished ? (res.rank >= 1 && res.rank <= 4 ? POINTS_BY_RANK[res.rank - 1] : 0) : 0;
    m->points += m->gained;
    m->lastRankNull = false;
    m->lastRank = res.rank;
    m->lastRaceIndex = raceIndex_;
  }
  lastApplied_ = raceIndex_;
  if (raceIndex_ >= raceCount() - 1) {
    if (drawNext_) cup_.tracks.push_back(drawNext_());
    else done_ = true;
  }
}

void CupSeries::advance() {
  if (raceIndex_ + 1 < raceCount()) raceIndex_++;
}

std::vector<GpStanding> CupSeries::standings() const {
  std::vector<GpStanding> rows;
  for (const auto& kv : meta_) {
    const Meta& m = kv.second;
    rows.push_back({kv.first, m.name, m.colorIndex, m.ai, m.points, m.gained,
                    m.lastRankNull, m.lastRank, m.seatNull});
  }
  const double INF = std::numeric_limits<double>::infinity();
  auto latest = [&](const Id& id) -> double {
    const Meta* m = findMeta(id);
    return (m && m->lastRaceIndex == lastApplied_) ? (double)m->lastRank : INF;
  };
  std::stable_sort(rows.begin(), rows.end(), [&](const GpStanding& a, const GpStanding& b) {
    if (a.points != b.points) return a.points > b.points;  // b.points - a.points
    return latest(a.playerId) < latest(b.playerId);
  });
  return rows;
}

std::vector<Id> CupSeries::lastRaceOrder() const {
  std::vector<std::pair<int, Id>> ranked;
  for (const auto& kv : meta_) {
    const Meta& m = kv.second;
    if (!m.lastRankNull && m.lastRaceIndex == lastApplied_) ranked.push_back({m.lastRank, kv.first});
  }
  std::stable_sort(ranked.begin(), ranked.end(),
                   [](const auto& a, const auto& b) { return a.first < b.first; });
  std::vector<Id> out;
  out.reserve(ranked.size());
  for (const auto& r : ranked) out.push_back(r.second);
  return out;
}

void CupSeries::rekey(const Id& oldId, const Id& newId) {
  if (oldId == newId || !findMeta(oldId)) return;
  for (auto& kv : meta_) if (kv.first == oldId) kv.first = newId;
}

}  // namespace ttp
