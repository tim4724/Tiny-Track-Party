// Air check — the airborne half of the sim, stated as assertions.
//
// Kickers: no catalogue track carries one, so no fixture reaches them. The gym
// does, and this drives cars over it: the ramp launches a car, gravity lands
// it, the landing is free, and a car in the air steers less, clears what lies
// on the deck and passes over a car on the ground.
//
// Crests: the catalogue's hills launch fast cars, and the corpora PIN that
// without judging it. So the whole catalogue is raced here with a bot field
// and the flights are bounded: some hill somewhere must launch, none may send
// a car higher than the crest cap allows, and every flight comes back down.

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "ttp/ai_driver.h"
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

void place(Car& c, double s, double lat, double v) {
  c.totalS = s; c.lat = lat; c.v = v; c.vlat = 0; c.heading = 0;
}

}  // namespace

int main() {
  BuiltRaceTrack bt;
  std::string err;
  if (!build_race_track_by_id("gym", 3, 42u, bt, err)) {
    std::fprintf(stderr, "FAIL build gym: %s\n", err.c_str());
    return 2;
  }
  if (bt.game.kickers.size() != 1) {
    std::fprintf(stderr, "FAIL the gym should carry one kicker, has %zu\n", bt.game.kickers.size());
    return 2;
  }
  const double K = bt.game.kickers[0];
  // Nothing on the run-up but the ramp itself.
  bt.game.bananas.clear();
  bt.game.hazards.clear();
  bt.game.pads.clear();
  const std::vector<PlayerDesc> one{PlayerDesc{Id::Num(0), false, Stats{}}};

  // ---- launch, flight, landing -----------------------------------------------
  {
    Game game(one, bt.game, [](const Event&) {});
    Car& c = *game.cars()[0];
    place(c, K - 4.0, 0, c.vmax);
    const double vIn = c.v;
    double peak = 0, airT = 0, maxRampH = 0;
    bool climbed = false, launched = false, landed = false;
    for (int i = 0; i < 240 && !landed; i++) {
      const bool onRamp = wrap_delta(c.totalS - K, game.length()) >= 0
                          && wrap_delta(c.totalS - K, game.length()) < KICKER_LEN;
      game.update(DT);
      if (onRamp && c.h > 0) { climbed = true; maxRampH = std::fmax(maxRampH, c.h); }
      if (c.h > 0 && c.totalS > K + KICKER_LEN) { launched = true; airT += DT / 1000; }
      peak = std::fmax(peak, c.h);
      if (launched && c.h == 0) landed = true;
    }
    check(climbed, "the wedge lifts a car that drives onto it");
    check(maxRampH <= KICKER_RISE, "on the wedge the car rides its surface, no higher");
    check(launched, "a full-speed car leaves the lip");
    check(peak > KICKER_RISE, "off the lip it keeps climbing before gravity turns it");
    check(landed && c.vh == 0, "it lands back on the deck");
    check(airT > 0.2 && airT < 1.5, "the hop is a hop: airborne between 0.2 and 1.5 s");
    check(c.v == vIn, "landing is free: the car keeps its full speed");
  }

  // ---- steering in the air ---------------------------------------------------
  // The same tilt from the same spot, once on the deck and once a metre up: the
  // airborne heading must turn by AIR_STEER of the grounded one.
  {
    const double S = 28.0;  // the main straight, clear of every kicker
    double turned[2];
    for (int air = 0; air < 2; air++) {
      Game game(one, bt.game, [](const Event&) {});
      Car& c = *game.cars()[0];
      place(c, S, 0, c.vmax);
      c.h = air ? 1.0 : 0.0;
      Input in; in.hasS = true; in.s = 1;
      game.processInput(c.id, in);
      game.update(DT);
      turned[air] = std::fabs(c.heading);
    }
    const double ratio = turned[1] / turned[0];
    check(turned[0] > 0 && ratio > 0.3 && ratio < 0.4,
          "a car in the air turns by about a third of what it turns on the deck");
  }

  // ---- the deck's hazards are cleared ----------------------------------------
  {
    GameTrack oily = bt.game;
    const double S = 28.0;
    oily.hazards.push_back(Zone{S + 0.5, 0, 1.0});
    for (int air = 0; air < 2; air++) {
      int spins = 0;
      Game game(one, oily, [&](const Event& e) { if (e.type == "spin") spins++; });
      Car& c = *game.cars()[0];
      place(c, S, 0, c.vmax);
      c.h = air ? 1.0 : 0.0;
      game.update(DT);
      check(air ? spins == 0 : spins == 1,
            air ? "a car in the air flies over an oil slick" : "the control car on the deck spins in it");
    }
  }

  // ---- a car in the air passes over one on the deck --------------------------
  // Two cars in line and overlapping, at the same speed. On the deck the
  // collider splits them sideways (the shallower axis for a pair in line); one
  // of them in the air leaves both exactly on their lines.
  {
    const std::vector<PlayerDesc> two{PlayerDesc{Id::Num(0), false, Stats{}},
                                      PlayerDesc{Id::Num(1), false, Stats{}}};
    const double S = 28.0, GAP = 0.3;
    double spread[2];
    for (int air = 0; air < 2; air++) {
      Game game(two, bt.game, [](const Event&) {});
      Car& a = *game.cars()[0];
      Car& b = *game.cars()[1];
      place(a, S, 0, a.vmax);
      place(b, S + GAP, 0, b.vmax);
      a.h = air ? 1.0 : 0.0;
      game.update(DT);
      spread[air] = std::fabs(b.lat - a.lat);
    }
    check(spread[0] > 0.3, "the control pair on the deck is pushed apart");
    check(spread[1] == 0, "a car in the air passes over a car on the deck");
  }

  // ---- crests across the catalogue -------------------------------------------
  // Four bots, flat out, a minute on every shipped track. The bounds are loose
  // on purpose — they catch a crest that sends a car into orbit or a flight
  // that never ends, not a retune.
  {
    const double MAX_PEAK = 1.5, MAX_AIR = 2.0;
    int hops = 0;
    for (int t = 0; t < TTP_TRACK_COUNT; t++) {
      BuiltRaceTrack race;
      std::string why;
      if (!build_race_track_by_id(TTP_TRACKS[t].id, 3, 7u, race, why)) {
        check(false, std::string("build ") + TTP_TRACKS[t].id + ": " + why);
        continue;
      }
      std::vector<PlayerDesc> field;
      std::vector<AiController> ais;
      for (int i = 0; i < 4; i++) {
        field.push_back(PlayerDesc{Id::Num(i), false, Stats{}});
        ais.emplace_back(1.0, LOOKAHEAD, STEER_GAIN, -0.6 + 0.4 * i, 300u + i);
      }
      Game game(field, race.game, [](const Event&) {});
      double peak = 0, longest = 0;
      std::vector<double> air(4, 0);
      int trackHops = 0;
      for (int f = 0; f < 3600; f++) {
        for (int i = 0; i < 4; i++) game.driveBot(Id::Num(i), ais[i], nullptr);
        game.update(DT);
        for (int i = 0; i < 4; i++) {
          const Car& c = *game.cars()[i];
          if (c.h > 0) {
            if (air[i] == 0) trackHops++;
            air[i] += DT / 1000;
            peak = std::fmax(peak, c.h);
            longest = std::fmax(longest, air[i]);
          } else {
            air[i] = 0;
          }
        }
      }
      hops += trackHops;
      std::printf("  %-12s hops %3d  peak %.2f  longest %.2f s\n", TTP_TRACKS[t].id, trackHops, peak, longest);
      check(peak < MAX_PEAK, std::string(TTP_TRACKS[t].id) + ": no crest sends a car above the cap");
      check(longest < MAX_AIR, std::string(TTP_TRACKS[t].id) + ": every flight comes back down");
    }
    check(hops > 0, "somewhere in the catalogue a hill launches a fast car");
  }

  std::printf("air_check: %d/%d checks passed\n", checks - failures, checks);
  return failures ? 1 : 0;
}
