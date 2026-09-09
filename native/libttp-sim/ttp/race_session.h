// RaceSession — countdown beats,
// the racing flip, and the race-timeout failsafe wrapped around a Game. Owns no
// clock; time is injected through update(dtMs). Clock-free and RNG-injected,
// which is what lets a race replay frame for frame.
//
// The golden-trace session driver only exercises startCountdown / update /
// processInput / racing / results; the rest of the surface (pause / resume /
// fastForwardToEnd / forceRemoveCar / rekeyCar / getResults / getSnapshot /
// dispose) is the live-play lifecycle the native runtime ABI wraps for the
// browser adapter.
#pragma once

#include <functional>
#include <memory>
#include <optional>
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

  // Live-play lifecycle. pause()/resume() freeze injected time;
  // resume replays the held countdown banner. fastForwardToEnd steps the sim to
  // the flag in one burst, feeding the bots each step via `stepBots`.
  void pause();
  void resume();
  void fastForwardToEnd(const std::function<void()>& stepBots, double dtMs = 1000.0 / 30.0);
  // THE FINISH FLOURISH. Every human is home, so the shell wants a few seconds
  // of live picture — the place cards up, the field still moving — before the
  // board. Without this it cannot have them: when the last human is ALSO the
  // last car, raceOver() is already true on the frame they cross and update()
  // ends the race on the very next tick. This holds that end off; the sim keeps
  // stepping, and Game already drives a finished car (its victory-lap
  // autopilot). The shell ends it by calling this with `false`, and then
  // resolves whatever is still running the way it always did.
  //
  // No duration and no clock: how long a flourish lasts is the race-flow
  // layer's, and this only has to not end while one is running.
  void holdEnd(bool on) { holdingEnd_ = on; }
  bool holdingEnd() const { return holdingEnd_; }
  bool forceRemoveCar(const Id& id);
  bool rekeyCar(const Id& oldId, const Id& newId) { return engine_->rekeyCar(oldId, newId); }
  Value getResults() { return engine_->getResults(); }
  Value getSnapshot() { return engine_->getSnapshot(); }
  void dispose();

  bool racing() const { return racing_; }
  // Past the flag (or the race-timeout failsafe, or disposed) — set once and
  // never cleared, unlike racing(), which is also false through the countdown.
  bool ended() const { return ended_; }
  bool paused() const { return paused_; }
  Game& engine() { return *engine_; }

 private:
  void stepCountdown(double dtMs);
  void finish();
  bool timedOut();

  std::unique_ptr<Game> engine_;
  bool racing_ = false;
  std::function<void(int)> onCountdownTick_;
  std::function<void(const Value&)> onRaceEnd_;

  // The pre-race count, present only while it is running. n is the beat last
  // shown (3, 2, 1, 0 = GO, -1 = clear); ms is the accumulated time inside the
  // current beat. Held across a pause so resume can re-show the banner.
  struct Countdown { int n = 0; double ms = 0; };
  std::optional<Countdown> countdown_;
  double raceMs_ = 0;
  // raceMs_ when the grace clocks started, -1 while unarmed: the first flag
  // arms the field-wide clock, the field dropping to one straggler arms the
  // short one (see timedOut for the windows).
  double firstFinishAt_ = -1;
  double lastCarAt_ = -1;
  bool ended_ = false;
  bool paused_ = false;
  bool holdingEnd_ = false;   // see holdEnd: the flourish is running
};

}  // namespace ttp
