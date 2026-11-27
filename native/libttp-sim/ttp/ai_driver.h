// AiDriver — pure-pursuit autopilot,
// the precomputed racing line, corner-anticipation braking, and the AiController
// (seeded wander + held-item firing). Bit-exact under strict FP; transcendentals
// via ttp/dmath.h. Shared by Game (finished cars victory-lap through pursue/
// cornerBrake) and the replay CLI's ai-live path.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "ttp/centerline.h"
#include "ttp/util.h"

namespace ttp {

struct Car;
class Game;
struct Input;

// Precomputed racing line for a centerline (built once, shared by the field).
// It is solved about the ASPHALT's centre (midAt: Frame::asphaltMid), which
// stands off the centre line where one side carries more strip than the other;
// laneAt answers in centre-line lat like every other lane.
class RacingLine {
 public:
  explicit RacingLine(Centerline& centerline);
  double laneAt(double s) const { return at(mid_, s) + at(e_, s); }
  double midAt(double s) const { return at(mid_, s); }
  double curvAt(double s) const { return at(k_, s); }
  double roomAt(double s) const { return at(bound_, s); }

 private:
  double at(const std::vector<double>& arr, double s) const;
  double length_;
  int n_;
  double h_;
  std::vector<double> e_, k_, bound_, mid_;
};


// Shared with every construction/call site (replay CLI bot rebuild, the
// engine's finished-car victory-lap autopilot) — single-sourced here so a
// tuning change cannot silently fork between them (AiDriver.js:15-16).
inline constexpr double LOOKAHEAD = 7.5;
inline constexpr double STEER_GAIN = 1.8;

// Pure-pursuit steer toward the centerline lookahead point (optionally lane-offset).
double pursue(const Car& car, Centerline& centerline,
              double lookahead, double gain, double laneBias);

// Brake (0..1) for upcoming bends. `turn` overrides car.turn when > 0; `line` (or
// nullptr) rates bends by the racing line's curvature vs the centerline's.
double cornerBrake(const Car& car, Centerline& centerline,
                   double turn, double caution, const RacingLine* line,
                   double lineUse = 1.0);

struct Persona { const char* name; double caution; double laneBias; };
extern const Persona AI_PERSONALITIES[7];

// Bot skill (0..1) for a cup difficulty (1..4); anything else is 1, the bot as it
// always was. Lower skill drives less of the racing line, wobbles across its
// lane, and now and then runs wide into the barrier.
double aiSkillForTier(int tier);
// A cup's bot field is a spread of strengths. At one strength the bots finish
// within a couple of seconds of each other and a player slightly slower than
// them is last. So only the front seat drives as the cup's skill says; each
// seat behind it makes its kerb mistakes more often, evenly up to the cup's
// rate (CupDef::botMistakes) at the last seat. Earlier corner braking for the
// back seats was tried first and is no lever: it costs a bot little and parks
// it in the player's way.
inline double aiSeatMistakes(double cupRate, int seat, int seats) {
  return seats > 1 ? 1 + (cupRate - 1) * seat / (seats - 1) : 1.0;
}

class AiController {
 public:
  AiController(double caution, double lookahead, double gain, double laneBias, uint32_t seed,
               double skill = 1.0, double mistakes = 1.0);
  Input drive(Car& car, Centerline& centerline, Game& game);
  // The gallery's strip showcase: drive at this lateral offset instead of the
  // racing line, off the asphalt included, and while `brake` > 0 brake at least
  // that and slide not at all, until released. No race sets it.
  void holdLane(double lat, double brake) { held_ = true; heldLat_ = lat; heldBrake_ = brake; }
  void releaseLane() { held_ = false; }

 private:
  bool held_ = false;
  double heldLat_ = 0, heldBrake_ = 0;
  bool wantsToUse(const std::string& item, Car& car, Game& game, double corner);
  void drawMistakeGap();

  double caution_, lookahead_, gain_, laneBias_, skill_;
  Mulberry32 rng_;
  double weave_ = 0, weaveTarget_ = 0;
  double weaveT_ = 0;
  int useSeq_ = 0;
  std::string lastItem_;  // "" = null (no separate has-flag: "" IS the null)
  int heldFrames_ = 0;
  int holdMin_ = 0;
  bool dodgeSet_ = false;  // _dodgeLane != null
  double dodgeLane_ = 0;
  // The kerb mistake (skill < 1 only): frames to the next one (-1 = not drawn
  // yet), frames left in the current one, and which side it runs wide on.
  double mistakeGap_ = -1;
  int mistakeT_ = 0;
  double mistakeSide_ = 1;
  // The slide (see AI_SLIDE_OFF): this corner's roll, and whether the steer is
  // past the slide's threshold right now.
  Mulberry32 slideRng_;
  bool hardSteer_ = false, slideCorner_ = false;
  double mistakes_;   // how many times as often as its skill's it runs wide
};

}  // namespace ttp
