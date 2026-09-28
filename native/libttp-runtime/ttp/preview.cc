#include "ttp/preview.h"

#include <algorithm>

#include "ttp/grand_prix.h"

namespace ttp {
namespace rt {
namespace preview {

namespace {

// Banked cup points per row COMING INTO each race of a cup, by race index.
//
// RACE 1 IS ALL ZEROS, because that is what a first race is: nobody has scored,
// so the standings after it ARE the finishing order. From race 2 the gaps are
// ONES, on purpose: the race pays POINTS_BY_RANK down the finishing order, so a
// row one point behind a row that scores three fewer overtakes it part way
// through the count — which is the whole thing the standings phase exists to
// show.
constexpr int BANKED_BY_RACE[4][8] = {
  {0, 0, 0, 0, 0, 0, 0, 0},
  {12, 13, 20, 9, 4, 5, 1, 0},
  {26, 27, 32, 21, 12, 13, 5, 2},
  {40, 41, 48, 33, 20, 21, 9, 4},
};

Value rowBase(const Racer& r) {
  Value v = Value::Obj();
  v.set("playerId", r.id.toValue());
  v.set("name", Value::Str(r.name));
  v.set("colorIndex", Value::Num(r.colorIndex));
  v.set("ai", Value::Bool(r.ai));
  return v;
}

}  // namespace

progression::Record progressRecord(const std::vector<std::string>& cupIds) {
  progression::Record r;
  if (cupIds.size() > 0) r.bests.push_back({cupIds[0], 1});
  if (cupIds.size() > 1) r.bests.push_back({cupIds[1], 2});
  return r;
}

bool parseKind(const std::string& s, Kind* out) {
  if (s == "results") *out = Kind::Results;
  else if (s == "intermission") *out = Kind::Intermission;
  else if (s == "podium") *out = Kind::Podium;
  else return false;
  return true;
}

Value board(Kind kind, const std::vector<Racer>& field, const Racer& joiner, const CupRef& cup,
            double autoAdvanceMs, int raceIndex) {
  // Players finish first, then the CPU fill; each keeps its grid order within.
  std::vector<const Racer*> roster;
  for (const Racer& r : field) if (!r.ai) roster.push_back(&r);
  for (const Racer& r : field) if (r.ai) roster.push_back(&r);

  struct Row { Value v; int points = 0; };
  std::vector<Row> rows;
  const bool isCup = kind != Kind::Results;
  const int raceCount = (int) cup.tracks.size();
  const int raceIdx = raceIndex >= 0 ? std::min(raceIndex, std::max(0, raceCount - 1))
                     : kind == Kind::Podium ? std::max(0, raceCount - 1) : 1;
  const int banked = std::min(raceIdx, 3);
  for (size_t i = 0; i < roster.size(); i++) {
    Row row{rowBase(*roster[i])};
    row.v.set("finished", Value::Bool(true));
    row.v.set("time", Value::Num(FINISH_TIMES[i % 8]));
    // What carries the FINISHING order through the cup re-sort below.
    row.v.set("racePlace", Value::Num((double) i + 1));
    if (isCup) {
      const int gained = i < (size_t) POINTS_RANKS ? POINTS_BY_RANK[i] : 0;
      row.points = BANKED_BY_RACE[banked][i % 8] + gained;
      row.v.set("gained", Value::Num(gained));
      row.v.set("points", Value::Num(row.points));
    }
    rows.push_back(std::move(row));
  }
  if (isCup) {
    std::stable_sort(rows.begin(), rows.end(),
                     [](const Row& a, const Row& b) { return a.points > b.points; });
  }

  Value order = Value::Arr();
  for (Row& r : rows) order.push(std::move(r.v));
  if (!isCup) {
    Value j = Value::Obj();
    j.set("playerId", joiner.id.toValue());
    j.set("name", Value::Str(joiner.name));
    j.set("colorIndex", Value::Num(joiner.colorIndex));
    j.set("joining", Value::Bool(true));
    order.push(std::move(j));
  }

  Value out = Value::Obj();
  out.set("over", Value::Bool(true));
  const Value* first = order.arr.empty() ? nullptr : order.arr[0].find("playerId");
  out.set("hostPeerIndex", first ? *first : Value::Null());
  out.set("order", std::move(order));
  if (isCup) {
    Value s = Value::Obj();
    s.set("cupId", Value::Str(cup.id));
    s.set("cupName", Value::Str(cup.name));
    s.set("endless", Value::Bool(false));
    s.set("raceIndex", Value::Num(raceIdx));
    s.set("raceCount", Value::Num(raceCount));
    const bool hasNext = raceIdx + 1 < raceCount;
    s.set("nextTrackId", hasNext ? Value::Str(cup.tracks[raceIdx + 1]) : Value::Null());
    const bool hasName = hasNext && (size_t) raceIdx + 1 < cup.trackNames.size();
    s.set("nextTrackName", hasName ? Value::Str(cup.trackNames[raceIdx + 1]) : Value::Null());
    s.set("final", Value::Bool(kind == Kind::Podium));
    s.set("autoAdvanceMs", Value::Num(autoAdvanceMs));
    out.set("series", std::move(s));
  }
  return out;
}

}  // namespace preview
}  // namespace rt
}  // namespace ttp
