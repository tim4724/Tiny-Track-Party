// Drift check — the Mario Kart drift behind Game::update's DRIFT_* block.
//
// No golden trace drifts, so this is what says the control means what it says:
// a held brake with a hard steer at speed drifts on a LOCKED side, the lean only
// picks the line inside a band that never straightens, it rises in and fades
// out, a straight, slow or light-lean brake is still a brake, and a bot drifts
// only when its controller allows it — which cup bots do on some corners.
// Assertions rather than a corpus, like hazard_check.

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

// One car alone on tidepool's opening straight, at racing speed.
struct Rig {
  BuiltRaceTrack bt;
  std::unique_ptr<Game> game;
  Car* car = nullptr;

  explicit Rig(bool bot) {
    std::string err;
    if (!build_race_track_by_id("tidepool", 3, 42u, bt, err)) {
      std::fprintf(stderr, "FAIL build tidepool: %s\n", err.c_str());
      std::exit(2);
    }
    game = std::make_unique<Game>(std::vector<PlayerDesc>{PlayerDesc{Id::Num(0), false, Stats{}, bot}},
                                  bt.game);
    car = game->cars()[0].get();
    car->totalS = 30.0;
    car->lat = 0.0;
    car->heading = 0.0;
    car->v = car->vmax * 0.9;
  }

  // Hold one input for `frames` frames.
  void drive(double s, double b, int frames) {
    Input in;
    in.hasS = true; in.s = s;
    in.hasB = true; in.b = b;
    for (int i = 0; i < frames; i++) {
      game->processInput(Id::Num(0), in);
      game->update(DT);
    }
  }
};

// How far the car has turned toward a positive-steer corner since `h0`.
double turned(const Car& c, double h0) { return STEER_SIGN * (c.heading - h0); }

// …and in WORLD yaw since forward `f0`: `heading` is against the track's
// tangent, which turns under the car and swamps a short window.
double yawed(const Car& c, const Vec3& f0) {
  const Pose& p = c.pose;
  return STEER_SIGN * std::atan2(f0.clone().cross(p.forward).dot(p.up), f0.dot(p.forward));
}

}  // namespace

int main() {
  // A held brake with a hard steer at speed drifts toward the steer, holds its
  // speed floor instead of braking, and turns further than full lock alone.
  {
    Rig drift(false), lock(false);
    const double h0 = drift.car->heading;
    drift.drive(1, 0, 4);
    drift.drive(1, 1, 20);
    check(drift.car->drifting && drift.car->driftDir == 1, "a held brake while steering hard drifts toward the steer");
    check(drift.car->driftMix == 1, "the drift is fully in after its rise");
    check(drift.car->v > drift.car->vmax * (debugDriftFloor(-1) - 0.02),
          "a drift holds its speed floor instead of braking toward a stop");
    check(STEER_SIGN * drift.car->slip > 0, "the drawn body slips into the corner");
    lock.drive(1, 0, 24);
    check(turned(*drift.car, h0) > turned(*lock.car, h0),
          "a drift turns the car further than full lock in the same time");
  }

  // The side is locked: no lean straightens it, and leaning out only widens it.
  {
    Rig in(false), out(false);
    in.car->lat = out.car->lat = 1.5;  // room to turn before the curb
    in.drive(1, 1, 16);
    out.drive(1, 1, 16);
    const Vec3 fIn = in.car->pose.forward, fOut = out.car->pose.forward;
    in.drive(1, 1, 6);
    out.drive(-1, 1, 6);
    check(!in.car->onWall && !out.car->onWall, "(the lock test stays off the curb)");
    check(out.car->drifting && out.car->driftDir == 1, "leaning out does not flip or end the drift");
    check(yawed(*out.car, fOut) > 0, "leaning out still turns into the drift's side");
    check(yawed(*in.car, fIn) > yawed(*out.car, fOut), "leaning in turns tighter than leaning out");
  }

  // The lean is read relative to the one the drift started on: holding it keeps
  // the line the car was already on (an absolute map dived for the inner curb),
  // leaning further in tightens it, easing off widens it.
  {
    Rig hold(false), in(false), ease(false);
    for (Rig* r : { &hold, &in, &ease }) { r->car->lat = 1.5; r->drive(0.6, 0, 4); r->drive(0.6, 1, 2); }
    const double k0 = hold.car->driftK0;
    hold.drive(0.6, 1, 30);
    in.drive(1, 1, 30);
    ease.drive(0.3, 1, 30);
    check(std::fabs(hold.car->driftK - k0) < k0 * 0.02, "holding the starting lean keeps the starting line");
    check(in.car->driftK > k0 * 1.2, "leaning further in tightens the line");
    check(ease.car->driftK < k0 && ease.car->driftK > 0, "easing off widens the line, never straight");
  }

  // The line is holdable on tilt: a wobbling lean barely moves it, where an
  // unsmoothed line follows every wobble.
  {
    auto wobble = [](double smooth) {
      debugDriftSmooth(smooth);
      Rig r(false);
      r.car->lat = 1.5;
      r.drive(0.5, 1, 4);
      // settle under the wobble first, so only the wobble is measured
      for (int i = 0; i < 60; i++) r.drive(i % 2 ? 0.3 : 0.7, 1, 1);
      double lo = 1e9, hi = -1e9;
      for (int i = 0; i < 30; i++) {
        r.drive(i % 2 ? 0.3 : 0.7, 1, 1);
        lo = std::fmin(lo, r.car->driftK); hi = std::fmax(hi, r.car->driftK);
      }
      debugDriftSmooth(-1);
      return hi - lo;
    };
    const double smoothed = wobble(-1), raw = wobble(0);
    check(smoothed < raw * 0.25, "a wobbling lean moves the smoothed line a fraction of the raw one");
  }

  // It rises in over a few frames (the hop), so locking the side cannot jerk the car.
  {
    Rig r(false);
    r.drive(0.6, 0, 6);
    r.drive(0.6, 1, 1);
    check(r.car->drifting && r.car->driftMix > 0 && r.car->driftMix < 0.25, "the drift rises in rather than snapping on");
  }

  // Letting go ends the hold at once and fades the drift out over the release.
  {
    Rig r(false);
    r.drive(1, 1, 20);
    r.drive(0, 0, 1);
    check(!r.car->drifting, "letting go of the brake ends the hold at once");
    check(r.car->driftMix > 0.9, "…but the drift fades out rather than snapping off");
    const int releaseFrames = (int) std::ceil(debugDriftRelease(-1) * 60);
    r.drive(0, 0, releaseFrames / 2);
    check(r.car->driftMix > 0.3 && r.car->driftMix < 0.7, "halfway through the release, half the drift is left");
    r.drive(0, 0, releaseFrames / 2 + 1);
    check(r.car->driftMix == 0, "the release blend ends in plain steering");
  }

  // A brake held straight, or too slow, or with a light lean, is a brake.
  {
    Rig straight(false), slow(false), light(false);
    straight.drive(0, 1, 30);
    check(!straight.car->drifting && straight.car->v < straight.car->vmax * 0.7,
          "a brake held straight brakes");
    slow.car->v = slow.car->vmax * 0.3;
    slow.drive(1, 1, 5);
    check(!slow.car->drifting, "a brake below the drift speed is a brake");
    light.drive(0.3, 1, 5);
    check(!light.car->drifting, "a brake with a light lean is a brake");
  }

  // A bot drifts only while its controller allows it (Input::d): by default its
  // brake is a brake, which is what keeps every recorded bot replaying exactly.
  {
    Rig bot(true), allowed(true);
    bot.drive(1, 1, 10);
    check(!bot.car->drifting, "a bot's brake is only a brake by default");
    Input in;
    in.hasS = true; in.s = 1; in.hasB = true; in.b = 1; in.hasD = true; in.d = 1;
    for (int i = 0; i < 10; i++) { allowed.game->processInput(Id::Num(0), in); allowed.game->update(DT); }
    check(allowed.car->drifting, "a bot its controller allows drifts like a player");
  }

  // The controller: cup bots drift some corners, more the higher the cup; the
  // full bot (skill 1, every recording) and the Beach bot (skill 0) never do.
  {
    // Drifts started over a few laps by bots on several seeds — the per-corner
    // roll is a chance, so one bot on one lap is too small a sample.
    auto drifts = [](double skill) {
      BuiltRaceTrack bt; std::string err;
      if (!build_race_track_by_id("drift", 1, 42u, bt, err)) { std::fprintf(stderr, "FAIL build drift: %s\n", err.c_str()); std::exit(2); }
      int n = 0;
      for (uint32_t seed : { 3u, 7u, 11u, 19u }) {
        Game g(std::vector<PlayerDesc>{PlayerDesc{Id::Num(0), false, Stats{}, true}}, bt.game);
        AiController ai(1.0, LOOKAHEAD, STEER_GAIN, 0, seed, skill);
        bool was = false;
        for (int f = 0; f < 60 * 40; f++) {
          g.driveBot(Id::Num(0), ai, nullptr);
          g.update(DT);
          const bool now = g.cars()[0]->drifting;
          if (now && !was) n++;
          was = now;
        }
      }
      return n;
    };
    check(drifts(1) == 0, "the full bot never drifts");
    check(drifts(0) == 0, "the Beach bot never drifts");
    const int low = drifts(0.3), high = drifts(0.6);
    check(high > 0, "a Playroom bot drifts its corners");
    check(high > low, "a higher cup's bot drifts more corners");
  }

  std::printf("drift check: %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
