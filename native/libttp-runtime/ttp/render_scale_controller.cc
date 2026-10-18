#include "ttp/render_scale_controller.h"

namespace ttp {
namespace rt {

void RenderScaleController::scene(double tMs) {
  // What the outgoing scene's count left off at, for the next scene with it.
  if (sceneCells_ >= 0) rungOf_[sceneCells_] = point_.scale;
  sceneCells_ = -1;
  cells_ = -1;
  sceneMs_ = tMs;
  enteredMs_ = tMs;
  judged_ = 0;
  head_ = 0;
}

bool RenderScaleController::poll(double tMs, RenderScaleLimits limits,
                                 perf::Monitor& mon, RenderScalePoint* out) {
  // The first call decides immediately rather than waiting a second: what it
  // does is declare the panel period, and a readout judged against a guessed
  // 60 Hz reads amber on a 50 Hz television for as long as it takes.
  if (lastPollMs_ > 0 && tMs - lastPollMs_ < kScalePollMs) return false;
  lastPollMs_ = tMs;

  // THE CEILING, ONCE — see point_. Before the decision rather than after, so
  // the first poll is judged against the scale the shell is actually drawing
  // at; and it reports NO MOVE, because the shell was already there.
  if (!adopted_) {
    adopted_ = true;
    if (limits.max > 0.0) point_.scale = limits.max;
  }

  const perf::Readout r = mon.fold();

  // The device's own fastest present, folded one window at a time (presentBaseline
  // says why it outlives the window). Off the TICK series — panelMs() says why.
  //
  // THE MEDIAN, NOT THE P05, and a stamp's jitter is why. rAF stamps sit ±1 ms
  // around the vsync on an idle Mac and ±2 ms with the main thread loaded, so
  // one window's p05 on a 120 Hz panel read 6.5 ms — and a floor that only
  // ever falls then believed in a 154 Hz panel for the life of the page, and
  // judged every frame against it. Jitter is symmetric, so the median of a
  // window that keeps up IS the period; a window that does not keep up has a
  // slower median, and the running minimum across windows ignores it exactly
  // as it ignored a slow p05.
  floorMs_ = presentBaseline(floorMs_, r.frame.p50);
  panelMs_ = limits.panelMs > 0 ? limits.panelMs : floorMs_;
  limits.panelMs = panelMs_;
  limits.halfRate = halfRate();

  // BELOW THE ANCHOR, at full rate, for kHalfRateOfferSec on end — counted
  // from when it first fell below, so a step from 720 to 540 does not restart it.
  if (limits.halfRate || !belowAnchor(point_, limits)) {
    belowMs_ = -1.0;
  } else if (belowMs_ < 0.0) {
    belowMs_ = tMs;
  }
  if (!offered_ && belowMs_ >= 0.0 && tMs - belowMs_ >= kHalfRateOfferSec * 1000.0) {
    offered_ = true;
  }

  // JUDGE THE SECOND: every frame presented since the last poll, counted in
  // vsyncs missed against the point's own period — times its divisor, so the
  // host's deliberate every-other-vsync is on time, not one miss a frame. A
  // poll that saw no present judges nothing (a hidden tab, a stalled loop: the
  // next present's gap carries what was missed).
  const std::vector<double> gaps = mon.takeGaps();
  if (!gaps.empty() && tMs - sceneMs_ >= kScaleSceneGraceSec * 1000.0) {
    const double due = pointPeriodMs(point_, limits);
    int missed = 0;
    for (double g : gaps) missed += perf::budgetsMissed(g, due);
    if (judged_ < kJudgeSec) {
      missed_[(head_ + judged_++) % kJudgeSec] = missed;
    } else {
      missed_[head_] = missed;
      head_ = (head_ + 1) % kJudgeSec;
    }
  }
  int missed = 0;
  for (int i = 0; i < judged_; i++) missed += missed_[(head_ + i) % kJudgeSec];

  RenderScalePoint list[kScaleMaxPoints];
  const int n = operatingPoints(limits, list);
  const double clamped = std::min(std::max(point_.scale, limits.min), limits.max);
  const int at = pointAtOrBelow(RenderScalePoint{clamped, point_.divisor}, list, n);

  // PLACE THE SCENE, once its cell count is known and while it is still in its
  // grace: where that count left off this session. A count not seen yet stays
  // where the scene before it was, since only missed frames move the rung. A
  // placement is not a step: it judges nothing, and the wait to climb still
  // runs from the build.
  if (cells_ >= 0 && std::min(cells_, kMaxCells) != sceneCells_
      && tMs - sceneMs_ < kScaleSceneGraceSec * 1000.0) {
    const int c = std::min(cells_, kMaxCells);
    const int place = rungOf_[c] > 0.0
        ? pointAtOrBelow(RenderScalePoint{rungOf_[c], point_.divisor}, list, n)
        : at;
    sceneCells_ = c;
    if (list[place].scale != point_.scale || list[place].divisor != point_.divisor) {
      return moveTo(list[place], mon, out);
    }
  }
  const int slot = sceneCells_ >= 0 ? sceneCells_ : 0;
  // A rung that has stood kFailSec holds, whatever it failed before.
  if (tMs - enteredMs_ >= kFailSec * 1000.0) fails_[slot][at] = 0;
  // A POINT FROM THE OTHER RATE — the host just flipped `halfRate` — has no
  // entry in this list (every entry shares one divisor), so it moves to the
  // anchor at the new rate.
  const int to = list[0].divisor != point_.divisor
      ? anchorPoint(list, n, limits)
      : renderScaleRung(at, n, missed, judged_, (tMs - enteredMs_) / 1000.0,
                        upWaitSec(at + 1 < n ? fails_[slot][at + 1] : 0));
  RenderScalePoint next = list[to];
  // Snap rather than creep: without this a scale a hair off its rung (a band
  // that moved) re-decides every poll forever.
  if (next.divisor == point_.divisor
      && next.scale > clamped - kScaleMinMove && next.scale < clamped + kScaleMinMove) {
    next = RenderScalePoint{clamped, point_.divisor};
  }
  if (next.scale == point_.scale && next.divisor == point_.divisor) return false;

  // A step down soon after the rung was entered FAILED it (kFailSec). One that
  // came before the window had even filled is hopeless for this session, and
  // waits the longest there is: four players trying 1080 on the reference box
  // miss ten frames inside two seconds.
  if (next.divisor == point_.divisor && to < at && tMs - enteredMs_ < kFailSec * 1000.0) {
    fails_[slot][at] = judged_ < kJudgeSec ? kMaxFails : std::min(fails_[slot][at] + 1, kMaxFails);
  }
  enteredMs_ = tMs;
  return moveTo(next, mon, out);
}

bool RenderScaleController::moveTo(RenderScalePoint p, perf::Monitor& mon,
                                   RenderScalePoint* out) {
  point_ = p;
  judged_ = 0;
  head_ = 0;
  mon.reset();
  if (out) *out = point_;
  return true;
}

int RenderScaleController::rateHz(bool half) const {
  // A LEARNED period is the median of rAF ticks and can land a fraction of a
  // millisecond off the panel's, which would label a 60 Hz TV "61 fps". Snap to
  // the panel rate it is nearest to; a declared period is already one of these.
  static constexpr double kPanelHz[] = {50.0, 60.0, 75.0, 90.0, 100.0, 120.0, 144.0, 165.0, 240.0};
  double hz = 1000.0 / (panelMs_ > 0.0 ? panelMs_ : 1000.0 / kDefaultPanelHz);
  for (double k : kPanelHz) {
    if (hz > k * 0.95 && hz < k * 1.05) hz = k;
  }
  return (int) (hz / (half ? 2.0 : 1.0) + 0.5);
}

RenderScaleController& renderScale() {
  static RenderScaleController c;
  return c;
}

}  // namespace rt
}  // namespace ttp
