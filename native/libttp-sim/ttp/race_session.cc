#include "ttp/race_session.h"

namespace ttp {

static const double MAX_RACE_MS = 180000;
static const double FIRST_FINISH_GRACE_MS = 30000;
static const double LAST_CAR_GRACE_MS = 5000;

RaceSession::RaceSession(const std::vector<PlayerDesc>& players, const GameTrack& track,
                         std::function<void(const Event&)> onRaceEvent,
                         std::function<void(const Value&)> onRaceEnd,
                         std::function<void(int)> onCountdownTick,
                         std::string forceItem)
    : onCountdownTick_(std::move(onCountdownTick)),
      onRaceEnd_(std::move(onRaceEnd)) {
  engine_ = std::make_unique<Game>(players, track, std::move(onRaceEvent), std::move(forceItem));
}

void RaceSession::startCountdown(int seconds) {
  countdown_ = Countdown{seconds, 0};
  if (onCountdownTick_) onCountdownTick_(countdown_->n);
  // A zero count is GO on the spot — the tick above WAS the beat. Racing
  // otherwise only flips when a decrement lands on 0, so starting at 0
  // showed GO and held the field at the grid forever (the demo launches
  // with 0; every real race counts from 3, which is why no one had seen it).
  if (seconds <= 0) {
    racing_ = true;
    raceMs_ = 0;
  }
}

void RaceSession::stepCountdown(double dtMs) {
  if (!countdown_) return;
  countdown_->ms += dtMs;
  while (countdown_->ms >= 1000) {
    countdown_->ms -= 1000;
    countdown_->n -= 1;
    if (onCountdownTick_) onCountdownTick_(countdown_->n);  // 2, 1, 0 (GO!), then -1 (clear)
    if (countdown_->n == 0) {
      racing_ = true;
      raceMs_ = 0;
    } else if (countdown_->n < 0) {
      countdown_.reset();
      return;
    }
  }
}

void RaceSession::update(double dtMs) {
  if (paused_ || ended_) return;
  bool wasRacing = racing_;
  stepCountdown(dtMs);
  if (!wasRacing) return;
  engine_->update(dtMs);
  raceMs_ += dtMs;
  if (engine_->raceOver() || timedOut()) finish();
}

// The DNF ladder: once the first car is home the rest get 30 s, once only one
// straggler is left it gets 5 s, and MAX_RACE_MS caps a race where nobody
// finishes at all. Cut-off cars keep their `finished:false` / null-time result.
// The straggler clock requires a finisher so a 1-car solo race is never cut.
bool RaceSession::timedOut() {
  if (raceMs_ >= MAX_RACE_MS) return true;
  long fin = engine_->finishedCount();
  if (fin >= 1 && firstFinishAt_ < 0) firstFinishAt_ = raceMs_;
  if (fin >= 1 && engine_->carCount() - fin == 1 && lastCarAt_ < 0) lastCarAt_ = raceMs_;
  if (firstFinishAt_ >= 0 && raceMs_ - firstFinishAt_ >= FIRST_FINISH_GRACE_MS) return true;
  if (lastCarAt_ >= 0 && raceMs_ - lastCarAt_ >= LAST_CAR_GRACE_MS) return true;
  return false;
}

void RaceSession::finish() {
  if (ended_) return;
  ended_ = true;
  racing_ = false;
  if (onRaceEnd_) onRaceEnd_(engine_->getResults());
}

// ---- live-play lifecycle (RaceSession.js) -----------------------------------

void RaceSession::pause() {
  if (paused_ || ended_) return;
  paused_ = true;
}

void RaceSession::resume() {
  if (!paused_ || ended_) return;
  paused_ = false;
  if (!countdown_) return;
  if (!racing_) {
    if (onCountdownTick_) onCountdownTick_(countdown_->n);     // re-show the held count
  } else if (countdown_->n == 0) {
    countdown_.reset();
    if (onCountdownTick_) onCountdownTick_(-1);                // clear the GO! banner now
  }
}

void RaceSession::fastForwardToEnd(const std::function<void()>& stepBots, double dtMs) {
  if (!racing_ || paused_ || ended_) return;
  long guard = 0;
  while (!engine_->raceOver() && !timedOut() && guard++ < 100000) {
    if (stepBots) stepBots();
    engine_->update(dtMs);
    raceMs_ += dtMs;
  }
  finish();
}

bool RaceSession::forceRemoveCar(const Id& id) {
  bool removed = engine_->removeCar(id);
  if (removed && racing_ && engine_->raceOver()) finish();
  return removed;
}

void RaceSession::dispose() {
  countdown_.reset();
  ended_ = true;
  racing_ = false;
  paused_ = false;
}

}  // namespace ttp
