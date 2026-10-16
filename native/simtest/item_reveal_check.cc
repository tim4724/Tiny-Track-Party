// Item-reveal check: a box's item is unusable until the sim's reveal gate opens,
// and the shells' roulette lands on the `item_ready` event that opens it.
//
// The press is BUFFERED across the gate (a tap during the reel is not lost), so
// the event and that buffered use land on the same update. The shells perform
// the event before anything shows the use, which is the whole guarantee that a
// player never fires an item the reel is still hiding: their own reel timers are
// cosmetic and only ever run late.

#include <cstdio>
#include <string>
#include <vector>

#include "ttp/game.h"
#include "ttp/race_track.h"

using namespace ttp;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& what) {
  checks++;
  if (!ok) {
    failures++;
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
  }
}

const double DT = 1000.0 / 60.0;

}  // namespace

int main() {
  BuiltRaceTrack bt;
  std::string err;
  if (!build_race_track_by_id("tidepool", 3, 42u, bt, err)) {
    std::fprintf(stderr, "FAIL build tidepool: %s\n", err.c_str());
    return 2;
  }
  const std::vector<PlayerDesc> players{PlayerDesc{Id::Num(0), false, Stats{}}};
  std::vector<Event> events;
  Game game(players, bt.game, [&events](const Event& e) { events.push_back(e); });
  check(!game.boxes().empty(), "the track has an item box");
  if (game.boxes().empty()) return 1;
  const BoxRt box = game.boxes()[0];

  // Held still, so the car takes this box and no other.
  Car& c = *game.cars()[0];
  const auto hold = [&](double s, double lat) {
    c.totalS = s; c.lat = lat; c.v = 0; c.vlat = 0; c.heading = 0;
  };

  // Out past the launch gate, nowhere near the box, then onto it.
  for (int i = 0; i < 120; i++) { hold(box.s + 30.0, 0.0); game.update(DT); }
  events.clear();
  int frame = 0, pickupAt = -1, readyAt = -1, useAt = -1, readies = 0;
  bool pressed = false;
  for (; frame < 120; frame++) {
    hold(box.s, box.lat);
    if (pickupAt >= 0 && !pressed) {
      Input in; in.hasU = true; in.u = 1;   // pressed the moment the reel starts
      game.processInput(c.id, in);
      pressed = true;
    }
    game.update(DT);
    for (const Event& e : events) {
      if (e.type == "pickup" && pickupAt < 0) pickupAt = frame;
      if (e.type == "item_ready") { readies++; readyAt = frame; }
      if (e.type == "item_use" && useAt < 0) useAt = frame;
    }
    events.clear();
  }

  check(pickupAt >= 0, "the car took the box");
  check(readies == 1, "the reveal gate opens exactly once per pickup");
  check(useAt >= 0, "the press buffered during the reveal still fires");
  check(useAt == readyAt,
        "the buffered press fires on the very update the gate opens, never before");
  check((readyAt - pickupAt) * DT >= 850.0,
        "the gate holds for the reveal, not a frame or two");

  std::printf("item reveal check: %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
