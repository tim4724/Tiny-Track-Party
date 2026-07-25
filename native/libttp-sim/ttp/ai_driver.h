// AiDriver — the C++ twin of public/display/AiDriver.js: pure-pursuit autopilot,
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
class RacingLine {
 public:
  explicit RacingLine(Centerline& centerline);
  double laneAt(double s) const { return at(e_, s); }
  double curvAt(double s) const { return at(k_, s); }
  double roomAt(double s) const { return at(bound_, s); }

 private:
  double at(const std::vector<double>& arr, double s) const;
  double length_;
  int n_;
  double h_;
  std::vector<double> e_, k_, bound_;
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
                   double turn, double caution, const RacingLine* line);

struct Persona { const char* name; double caution; double laneBias; };
extern const Persona AI_PERSONALITIES[4];

class AiController {
 public:
  AiController(double caution, double lookahead, double gain, double laneBias, uint32_t seed);
  Input drive(Car& car, Centerline& centerline, Game& game);

 private:
  bool wantsToUse(const std::string& item, Car& car, Game& game, double corner);

  double caution_, lookahead_, gain_, laneBias_;
  Mulberry32 rng_;
  double weave_ = 0, weaveTarget_ = 0;
  double weaveT_ = 0;
  int useSeq_ = 0;
  std::string lastItem_;  // "" = null (no separate has-flag: "" IS the null)
  int heldFrames_ = 0;
  int holdMin_ = 0;
  bool dodgeSet_ = false;  // _dodgeLane != null
  double dodgeLane_ = 0;
};

}  // namespace ttp
