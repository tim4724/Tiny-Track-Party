// RaceSession — the C++ twin of public/display/RaceSession.js: countdown beats,
// the racing flip, and the race-timeout failsafe wrapped around a Game. Owns no
// clock; time is injected through update(dtMs). Clock-free / RNG-injected exactly
// like the JS module. Only the surface the golden-trace session driver exercises
// is ported (startCountdown / update / processInput / racing / results).
#pragma once

#include <functional>
#include <memory>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/game.h"

namespace ttp {

class RaceSession {
 public:
  RaceSession(const std::vector<PlayerDesc>& players, const GameTrack& track,
              std::function<void(const Event&)> onRaceEvent,
              std::function<void(const Value&)> onRaceEnd,
              std::function<void(int)> onCountdownTick,
              std::string forceItem = "");

  void startCountdown(int seconds);
  void update(double dtMs);
  void processInput(const Id& id, const Input& msg) { engine_->processInput(id, msg); }

  bool racing() const { return racing_; }
  Game& engine() { return *engine_; }

 private:
  void stepCountdown(double dtMs);
  void onRaceStart() {}
  void finish();

  std::unique_ptr<Game> engine_;
  bool racing_ = false;
  std::function<void(int)> onCountdownTick_;
  std::function<void(const Value&)> onRaceEnd_;

  bool countdownNull_ = true;
  int countdownN_ = 0;
  bool countdownMsNull_ = true;
  double countdownMs_ = 0;
  double raceMs_ = 0;
  bool ended_ = false;
  bool paused_ = false;
};

}  // namespace ttp
