// Drift check — the Mario Kart drift behind Game::update's DRIFT_* block.
//
// No golden trace drifts, so this is what says the control means what it says:
// a player's button never brakes and every press hops the car; held with a hard
// steer it drifts, at any speed, starting on the line the car was already
// turning, then steering the line each lean settles to in plain steering, and
// closing toward one tight line for every car while held at full lock; it
// holds a share of the speed it started at (smaller the slower it started,
// when the slow-start cost is on); a hard counter-lean flips its side and
// a soft one only eases the line, which never straightens; it rises in and
// fades out; and a bot's brake is still a brake, drifting only when its
// controller allows it — which cup bots do on some corners.
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
// game.cc's DRIFT_K_TIGHT (the line held lock closes to) and, under it, the
// widest a full lock's plain line gets for any car at the authored stats.
const double DRIFT_K_TIGHT_ALL = 1.0 / 4.5;
const double DRIFT_K_LOCK_MIN = 1.0 / 9;

// One car alone on tidepool's opening straight, at racing speed.
struct Rig {
  BuiltRaceTrack bt;
  std::unique_ptr<Game> game;
  Car* car = nullptr;

  explicit Rig(bool bot, double turn = 1) {
    std::string err;
    if (!build_race_track_by_id("tidepool", 3, 42u, bt, err)) {
      std::fprintf(stderr, "FAIL build tidepool: %s\n", err.c_str());
      std::exit(2);
    }
    Stats st;
    st.turn = turn;
    game = std::make_unique<Game>(std::vector<PlayerDesc>{PlayerDesc{Id::Num(0), true, st, bot}}, bt.game);
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

// The share of vmax a drift started at `v0` (a share of vmax) holds, at the
// authored knobs.
double driftHold(double v0) {
  return std::fmax(0.0, debugDriftFloor(-1) - debugDriftSlow(-1) * (1 - v0)) * v0;
}

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
  // The button held with a hard steer drifts toward the steer, holds a share of
  // its starting speed instead of braking, and turns further than full lock.
  {
    Rig drift(false), lock(false);
    const double h0 = drift.car->heading;
    drift.drive(1, 0, 4);
    drift.drive(1, 1, 20);
    check(drift.car->drifting && drift.car->driftDir == 1, "the button held while steering hard drifts toward the steer");
    check(drift.car->driftMix == 1, "the drift is fully in after its rise");
    check(drift.car->v > drift.car->vmax * (driftHold(drift.car->driftV0) - 0.02),
          "a drift holds a share of its starting speed instead of braking toward a stop");
    check(STEER_SIGN * drift.car->slip > 0, "the drawn body slips into the corner");
    lock.drive(1, 0, 24);
    check(turned(*drift.car, h0) > turned(*lock.car, h0),
          "a drift turns the car further than full lock in the same time");
  }

  // A soft counter-lean only eases the line: no lean short of the flip
  // straightens it, and leaning out only widens it.
  {
    const double soft = -0.6 * debugDriftFlip(-1);
    Rig in(false), out(false);
    in.car->lat = out.car->lat = 1.5;  // room to turn before the curb
    in.drive(1, 1, 16);
    out.drive(1, 1, 16);
    const Vec3 fIn = in.car->pose.forward, fOut = out.car->pose.forward;
    in.drive(1, 1, 6);
    out.drive(soft, 1, 6);
    check(!in.car->onWall && !out.car->onWall, "(the lean-out test stays off the curb)");
    check(out.car->drifting && out.car->driftDir == 1, "a soft counter-lean does not flip or end the drift");
    check(yawed(*out.car, fOut) > 0, "leaning out still turns into the drift's side");
    check(yawed(*in.car, fIn) > yawed(*out.car, fOut), "leaning in turns tighter than leaning out");
  }

  // A hard counter-lean flips the drift to that side, with a hop, swinging
  // through straight rather than snapping across; locked, it does not.
  {
    Rig flip(false), locked(false);
    flip.car->lat = locked.car->lat = 0;
    flip.drive(1, 1, 16);
    flip.drive(-1, 1, 1);
    check(flip.car->drifting && flip.car->driftDir == -1, "a hard counter-lean flips the drift's side");
    check(flip.car->hopT < HOP_TIME, "…and the car hops as it flips");
    check(flip.car->driftK < 0.5 * DRIFT_K_LOCK_MIN, "…easing into the new line rather than snapping onto it");
    debugDriftFlip(2);
    locked.drive(1, 1, 16);
    locked.drive(-1, 1, 6);
    check(locked.car->drifting && locked.car->driftDir == 1, "with the flip past full lean, the side stays locked");
    debugDriftFlip(-1);
  }

  // A lean steers the line it settles to in plain steering — a drift that
  // turned tighter at the same lean put players on the inner curb — and easing
  // off widens it, never to straight.
  {
    Rig hold(false), ease(false);
    for (Rig* r : { &hold, &ease }) { r->car->lat = 1.5; r->drive(0.7, 0, 4); r->drive(0.7, 1, 2); }
    hold.drive(0.7, 1, 40);
    ease.drive(0.3, 1, 40);
    const Car& c = *hold.car;
    const double shaped = steerShape(0.7);
    const double plain = shaped * c.turn / (c.vmax * (1 - 0.35 * shaped * shaped));  // STEER_SCRUB
    check(std::fabs(c.driftK - plain) < plain * 0.02, "a lean drifts the line it settles to without the drift");
    check(ease.car->driftK < c.driftK && ease.car->driftK >= 1.0 / 18 - 1e-9, "easing off widens the line, never straight");
  }

  // Held at full lock the line keeps closing toward one tight line, the same
  // for the poorest handler as the best, so a well-driven drift makes every
  // turn in any car; easing off lock opens it again quickly.
  {
    auto lockedFor = [](double turn, int frames) {
      Rig r(false, turn);
      r.car->lat = 1.5;
      r.drive(1, 1, frames);
      return r.car->driftK;
    };
    const int full = (int) std::ceil(debugDriftTighten(-1) * 60) + 15;
    const double lockLine = lockedFor(1, 12), half = lockedFor(1, full / 2), tight = lockedFor(1, full);
    check(lockLine < half && half < tight, "held lock keeps closing the line");
    check(std::fabs(tight - DRIFT_K_TIGHT_ALL) < DRIFT_K_TIGHT_ALL * 0.02, "…to the tight line");
    check(std::fabs(lockedFor(0.88, full) - tight) < tight * 0.02 && std::fabs(lockedFor(1.24, full) - tight) < tight * 0.02,
          "every car's held lock closes to the same tight line");
    Rig r(false);
    r.car->lat = 1.5;
    r.drive(1, 1, full);
    r.drive(0.8, 1, 20);
    check(r.car->driftK < tight * 0.75, "easing off lock opens the line again");
  }

  // A drift starts on the line the car is already turning, whatever the lean
  // on the frame it starts: a held full lock with the second thumb added as a
  // DRIFT_LEAN lean (buttons mode) does not jerk the line open.
  {
    Rig r(false);
    r.car->lat = 1.5;
    r.drive(1, 0, 6);
    const double full = std::fabs(r.car->turnIn) * r.car->turn / r.car->v;
    r.drive(debugDriftSteer(-1), 1, 1);
    check(r.car->drifting, "the second thumb's lean starts a drift");
    check(std::fabs(r.car->driftK - full) < full * 0.15, "…on the full-lock line the car was turning");
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

  // A player's button never brakes. Every press hops the car, held straight or
  // with a light lean it does nothing more, and it hops once per press.
  {
    Rig straight(false), light(false);
    const double v0 = straight.car->v;
    straight.drive(0, 1, 1);
    check(straight.car->hopT < HOP_TIME, "pressing the button hops the car");
    straight.drive(0, 1, 30);
    check(!straight.car->drifting && straight.car->v >= v0, "the button held straight does not brake");
    check(straight.car->hopT > HOP_TIME, "a held button hops once, not again and again");
    straight.drive(0, 0, 1);
    straight.drive(0, 1, 1);
    check(straight.car->hopT < HOP_TIME, "each new press hops again");
    light.drive(0.3, 1, 5);
    check(!light.car->drifting && appliedBrake(*light.car) == 0, "the button with a light lean neither drifts nor brakes");
  }

  // A drift starts at any speed and holds its floor's share of the speed it
  // started at, never more; with the slow-start cost on, one started slow
  // holds a smaller share than one carried in at pace. A poorer handler's
  // floor is lower. A start speed restores the gate.
  {
    auto drifted = [](double v0, double slowCost, double turn = 1) {
      debugDriftSlow(slowCost);
      Rig r(false, turn);
      r.car->v = r.car->vmax * v0;
      r.car->lat = 1.5;  // room to turn before the curb
      // short of lock (the line, not its tightening), and long enough for a
      // slow start to shed its share before the curb
      r.drive(0.8, 1, v0 < 0.5 ? 60 : 30);
      check(!r.car->onWall && r.car->drifting, "(the slow-drift test drifts, off the curb)");
      debugDriftSlow(-1);
      return r.car->v / (v0 * r.car->vmax);  // the share of its start it holds
    };
    const double floor = debugDriftFloor(-1);
    const double slow = drifted(0.4, -1), fast = drifted(0.9, -1);
    check(std::fabs(slow - floor) < 0.01 && std::fabs(fast - floor) < 0.01,
          "a drift holds its floor's share of the speed it started at, slow or fast");
    check(drifted(0.4, 0.5) < drifted(0.9, 0.5) - 0.1,
          "with the slow-start cost on, a slow drift holds a smaller share than one at pace");
    const double poor = drifted(0.9, -1, 0.88), good = drifted(0.9, -1, 1.24);
    check(poor < fast - 0.02 && fast < good - 0.01 && good < 1,
          "a poorer handler holds a smaller share, a better one a larger share, never all of it");
    Rig gated(false);
    debugDriftMinSpeed(0.5);
    gated.car->v = gated.car->vmax * 0.3;
    gated.drive(1, 1, 5);
    check(!gated.car->drifting, "under a start speed, a slow hold does not drift");
    debugDriftMinSpeed(-1);
  }

  // A bot drifts only while its controller allows it (Input::d): by default its
  // brake is a brake, which is what keeps every recorded bot replaying exactly.
  {
    Rig bot(true), allowed(true), straight(true);
    bot.drive(1, 1, 10);
    check(!bot.car->drifting, "a bot's brake is only a brake by default");
    straight.drive(0, 1, 30);
    check(straight.car->v < straight.car->vmax * 0.7 && straight.car->hopT >= HOP_TIME,
          "a bot's brake brakes, and does not hop");
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
