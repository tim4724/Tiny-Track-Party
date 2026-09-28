// Behaviour check for ttp/preview.h — the screens gallery's fabricated couch
// and boards.
//
// Assertions, like progression_check: the layer is new and has no oracle. What
// is pinned is what the gallery cards exist to show — a couch part-way to the
// locked cup, a single race with a late joiner, and cup boards whose table
// differs from the race's finishing order — because a fabrication that loses
// one of those photographs a card with nothing to check on it.
#include <cstdio>
#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/grand_prix.h"
#include "ttp/preview.h"
#include "ttp/progression.h"

using namespace ttp;
namespace pv = ttp::rt::preview;
namespace progression = ttp::rt::progression;

namespace {

int cases = 0, failed = 0;

void check(bool ok, const char* what) {
  cases++;
  if (!ok) {
    failed++;
    std::fprintf(stderr, "FAIL %s\n", what);
  }
}

const std::vector<std::string> SHIPPED = {"beach", "snow", "backyard", "canyon", "rooftop"};

pv::Racer racer(double id, const char* name, int color, bool ai) {
  pv::Racer r;
  r.id = ScalarId::Num(id);
  r.name = name;
  r.colorIndex = color;
  r.ai = ai;
  return r;
}

// The launch grids players at the BACK: CPUs first, then the seats.
std::vector<pv::Racer> gridField() {
  return {
    racer(10, "Bot A", 4, true), racer(11, "Bot B", 5, true), racer(12, "Bot C", 6, true),
    racer(13, "Bot D", 7, true), racer(0, "Mia", 0, false), racer(1, "Theo", 1, false),
    racer(2, "Ava", 2, false), racer(3, "Leo", 3, false),
  };
}

pv::CupRef cup() {
  pv::CupRef c;
  c.id = "beach";
  c.name = "Beach Cup";
  c.tracks = {"tidepool", "cove", "driftwood", "riptide"};
  c.trackNames = {"Tidepool", "Cove", "Driftwood", "Riptide"};
  return c;
}

double num(const Value* v) { return v && v->type == Value::NUM ? v->num : -1; }

}  // namespace

int main() {
  // ---- the couch ----
  const progression::Record rec = pv::progressRecord(SHIPPED);
  check(progression::stars(rec.bestOf("beach")) == 3, "the first cup is won");
  check(progression::stars(rec.bestOf("snow")) == 2, "the second is a podium");
  check(progression::stars(rec.bestOf("backyard")) == 0, "nothing since");
  check(progression::starsEarned(rec, SHIPPED) == 5, "five stars earned");
  check(!progression::unlocked(rec, "rooftop", SHIPPED), "the Playroom is still locked");
  check(progression::unlockDone(rec, "rooftop", SHIPPED) + 1 == progression::unlockNeed("rooftop"),
        "one star short of the unlock");
  check(pv::progressRecord({}).bests.empty(), "no cups, no record");

  // ---- kinds ----
  pv::Kind k;
  check(pv::parseKind("results", &k) && k == pv::Kind::Results, "results parses");
  check(pv::parseKind("intermission", &k) && k == pv::Kind::Intermission, "intermission parses");
  check(pv::parseKind("podium", &k) && k == pv::Kind::Podium, "podium parses");
  check(!pv::parseKind("lobby", &k), "anything else is refused");

  const pv::Racer joiner = racer(4, "Zoe", 4, false);

  // ---- a single race ----
  {
    const Value b = pv::board(pv::Kind::Results, gridField(), joiner, cup(), 5000);
    const Value* order = b.find("order");
    check(order && order->arr.size() == 9, "eight finishers and the joiner");
    check(!b.find("series"), "a single race carries no series");
    check(order->arr[0].find("name")->str == "Mia", "players finish first, in grid order");
    check(order->arr[3].find("name")->str == "Leo", "all four players ahead of the CPUs");
    check(order->arr[4].find("ai")->b, "the CPU fill keeps its ai flag");
    check(num(order->arr[0].find("time")) == pv::FINISH_TIMES[0], "the winner's time");
    const Value& last = order->arr[8];
    check(last.find("joining") && last.find("joining")->b && !last.find("time"),
          "the joiner rides last with no time");
    check(num(b.find("hostPeerIndex")) == 0, "the host is the first row");
  }

  // ---- the cup boards ----
  for (const pv::Kind kind : {pv::Kind::Intermission, pv::Kind::Podium}) {
    const bool podium = kind == pv::Kind::Podium;
    const Value b = pv::board(kind, gridField(), joiner, cup(), 5000);
    const Value* order = b.find("order");
    const Value* series = b.find("series");
    check(order && order->arr.size() == 8, "a cup board has no joiner");
    check(series != nullptr, "a cup board carries its series");
    if (!order || !series) continue;
    check(num(series->find("raceIndex")) == (podium ? 3 : 1), "race 2 for the break, the last for the podium");
    check(series->find("final")->b == podium, "only the podium is final");
    if (podium) check(series->find("nextTrackId")->type == Value::NUL, "no next race after the last");
    else check(series->find("nextTrackName")->str == "Driftwood", "the break names the next race");
    bool sorted = true, swapped = false;
    for (size_t i = 0; i < order->arr.size(); i++) {
      const double pts = num(order->arr[i].find("points"));
      if (i > 0 && pts > num(order->arr[i - 1].find("points"))) sorted = false;
      if (num(order->arr[i].find("racePlace")) != (double) i + 1) swapped = true;
    }
    check(sorted, "the table is in cup order");
    check(swapped, "the cup order differs from this race's finishing order");
    check(num(order->arr[0].find("gained")) >= 0, "rows carry what they gained");
  }

  {
    const Value b = pv::board(pv::Kind::Intermission, gridField(), joiner, cup(), 5000, 2);
    check(num(b.find("series")->find("raceIndex")) == 2, "a walked cup names its own race");
    const Value c = pv::board(pv::Kind::Intermission, gridField(), joiner, cup(), 5000, 9);
    check(num(c.find("series")->find("raceIndex")) == 3, "a race index past the cup clamps to its last");
  }

  std::printf("preview: %d/%d passed\n", cases - failed, cases);
  return failed ? 1 : 0;
}
