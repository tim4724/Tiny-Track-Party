// Drift check — the slide behind Game::update's DRIFT_* block.
//
// The brake with a steer at speed slides, letting go ends it, the look rises in
// and fades out, the slide's brake turns tighter and costs no speed, the slide
// holds more speed than plain steering and more the better the car handles, a
// straight or light-steer brake is a plain brake, and a bot slides by the same
// rule, as often as its skill. Assertions rather than a corpus, like
// hazard_check.

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

// One car alone at the start of tidepool, at racing speed (a gentle bend: s 48 on is straight).
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
    Stats st; st.turn = turn;
    game = std::make_unique<Game>(std::vector<PlayerDesc>{PlayerDesc{Id::Num(0), turn != 1, st, bot}},
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
  // The brake with a steer at speed slides toward the steer; steering hard
  // alone, a light steer or a slow car does not.
  {
    Rig hard(false), noBrake(false), light(false), slow(false);
    hard.drive(1, 1, 20);
    check(hard.car->drifting, "the brake with a steer at speed slides");
    check(hard.car->driftMix == 1, "the slide is fully in after its rise");
    check(STEER_SIGN * hard.car->slip > 0, "the drawn body slips into the corner");
    noBrake.drive(1, 0, 20);
    check(!noBrake.car->drifting && noBrake.car->slip == 0, "steering hard without the brake does not slide, nor swing the body");
    light.drive(0.2, 1, 20);
    check(!light.car->drifting, "the brake with a light steer does not slide");
    slow.car->v = slow.car->vmax * 0.3;
    slow.drive(1, 1, 1);
    check(!slow.car->drifting, "a slow car does not slide");
  }

  // It rises in over a few frames (the hop), ends the moment the brake comes
  // up, holds through a counter-steer while the brake stays down, and the look
  // fades out over the release.
  {
    Rig r(false), back(false);
    r.drive(1, 1, 1);
    check(r.car->drifting && r.car->driftMix > 0 && r.car->driftMix < 0.25, "the slide rises in rather than snapping on");
    r.drive(1, 1, 20);
    r.drive(1, 0, 1);
    check(!r.car->drifting, "letting go of the brake ends the slide at once");
    check(r.car->driftMix > 0.9, "…but the look fades out rather than snapping off");
    const int releaseFrames = (int) std::ceil(debugDriftRelease(-1) * 60);
    r.drive(0, 0, releaseFrames + 1);
    check(r.car->driftMix == 0, "the release ends in plain driving");
    back.drive(1, 1, 10);
    back.drive(-0.5, 1, 5);
    check(back.car->drifting, "a counter-steer with the brake down keeps the slide");
  }

  // A bot slides corners on its own inputs, by its skill: the full bot brakes
  // into a slide at every hard steer it can slide, the Beach bot (skill 0)
  // keeps its plain corner braking there. No bot holds a slide's brake while too
  // slow to start one (that brake would be a plain one).
  {
    BuiltRaceTrack bt; std::string err;
    if (!build_race_track_by_id("drift", 1, 42u, bt, err)) { std::fprintf(stderr, "FAIL build drift: %s\n", err.c_str()); std::exit(2); }
    int slid = 0, loose[2] = {0, 0};
    bool slowBrake = false;
    for (int k = 0; k < 2; k++) {
      Game g(std::vector<PlayerDesc>{PlayerDesc{Id::Num(0), false, Stats{}, true}}, bt.game);
      AiController ai(1.0, LOOKAHEAD, STEER_GAIN, 0, 1, k == 0 ? 0.0 : 1.0);
      Car& c = *g.cars()[0];
      for (int f = 0; f < 60 * 30; f++) {
        Input m = ai.drive(c, *g.centerline(), g);
        const bool canSlide = c.drifting || canStartSlide(c);
        if (m.b == 1 && !canSlide && std::fabs(m.s) >= DRIFT_START && k == 1) slowBrake = true;
        loose[k] += canSlide && !c.drifting && std::fabs(m.s) >= DRIFT_START && m.b < 1;
        g.processInput(Id::Num(0), m);
        g.update(DT);
        if (k == 1) slid += c.drifting;
      }
    }
    check(slid > 60, "the full bot slides corners on its own inputs");
    check(loose[1] == 0, "the full bot brakes into a slide at every hard steer it can slide");
    check(loose[0] > 0, "the Beach bot keeps its plain corner braking there");
    check(!slowBrake, "a bot never holds a slide's brake too slow to slide");
  }

  // A slide at lock holds more speed than plain lock steering, and a better
  // handler holds more of it. Each frame puts the car back mid-road at the
  // same heading so the curb never joins in.
  {
    auto lockSpeed = [](double turn, double b) {
      Rig r(false, turn);
      for (int i = 0; i < 90; i++) { r.car->lat = 0; r.car->heading = 0; r.drive(1, b, 1); }
      return r.car->v / r.car->vmax;
    };
    const double goodSlide = lockSpeed(1.24, 1), goodPlain = lockSpeed(1.24, 0);
    const double poorSlide = lockSpeed(0.88, 1), poorPlain = lockSpeed(0.88, 0);
    check(poorSlide > poorPlain, "a slide holds more speed than plain lock steering");
    check(goodSlide - goodPlain > 2 * (poorSlide - poorPlain), "a better handler's slide holds far more of it");
  }

  // The brake in a slide turns it tighter and costs no speed.
  {
    Rig slide(false), plain(false);
    for (Rig* r : { &slide, &plain }) { r->car->totalS = 48; r->car->lat = -2.0; r->drive(1, 0, 4); }
    // (the slide starts on the first braked frame below; the plain car never brakes)
    const double hs = slide.car->heading, hp = plain.car->heading;
    slide.drive(1, 1, 10);
    plain.drive(1, 0, 10);
    check(slide.car->drifting, "(the slide-brake test is sliding)");
    check(turned(*slide.car, hs) > turned(*plain.car, hp) * 1.1, "braking in a slide turns it tighter");
    // At full lock the billed scrub is capped, so a half and a full brake turn
    // differently and hold the same speed; each frame puts the car back
    // mid-road so the curb never joins in.
    Rig full(false), half(false);
    for (Rig* r : { &full, &half }) {
      const double b = r == &full ? 1 : 0.5;
      for (int i = 0; i < 90; i++) { r->car->lat = 0; r->car->heading = 0; r->drive(1, b, 1); }
    }
    check(full.car->drifting && half.car->drifting, "(the slide-brake cost test slides)");
    check(full.car->v == half.car->v, "a slide's brake costs no speed");
  }

  // A straight brake is a plain brake, for a player as for a bot.
  {
    Rig player(false), bot(true);
    player.drive(0, 1, 30);
    bot.drive(0, 1, 30);
    check(player.car->v < player.car->vmax * 0.7, "a player's brake brakes");
    check(bot.car->v < bot.car->vmax * 0.7, "a bot's brake brakes");
  }

  std::printf("drift check: %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
