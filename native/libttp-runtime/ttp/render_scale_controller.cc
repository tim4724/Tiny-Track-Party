#include "ttp/render_scale_controller.h"

#include <cmath>

namespace ttp {
namespace rt {

void RenderScaleController::scene(double tMs) {
  // What the outgoing scene's count left off at, for the next scene with it.
  if (sceneCells_ >= 0) rungOf_[sceneCells_] = point_.scale * baseLines_;
  sceneCells_ = -1;
  cells_ = -1;
  sceneMs_ = tMs;
  enteredMs_ = tMs;
  steppedDown_ = false;
  judged_ = 0;
  head_ = 0;
  lateRun_ = 0;
  cleanRun_ = 0;
}

bool RenderScaleController::poll(double tMs, RenderScaleLimits limits,
                                 perf::Monitor& mon, RenderScalePoint* out) {
  // THE BAND MOVED: the surface changed height or ceiling (fullscreen, a
  // dragged window, DevTools). Answered now rather than at the next cadence,
  // so a shell sizing its buffer for the new surface sizes it once.
  if (adopted_ && ((limits.baseLines > 0.0 ? limits.baseLines : 1.0) != baseLines_
                   || limits.max != max_)) {
    return remap(tMs, limits, out);
  }

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
  baseLines_ = limits.baseLines > 0.0 ? limits.baseLines : 1.0;
  max_ = limits.max;

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

  // JUDGE THE SECOND: every frame presented since the last poll, against the
  // point's own period — times its divisor, so the host's deliberate
  // every-other-vsync is on time. A poll that saw no present judges nothing (a
  // hidden tab, a stalled loop: the next present's gap carries the late one).
  const std::vector<double> gaps = mon.takeGaps();
  const bool resizing = resized_ && tMs - resizedMs_ < kScaleResizeGraceSec * 1000.0;
  if (!gaps.empty() && !resizing && tMs - sceneMs_ >= kScaleSceneGraceSec * 1000.0) {
    const double due = pointPeriodMs(point_, limits);
    int lateNow = 0, vsyncs = 0;
    for (double g : gaps) {
      const int missed = perf::budgetsMissed(g, due);
      lateNow += missed > 0;
      vsyncs += 1 + missed;
    }
    const bool clean = cleanSecond(vsyncs, lateNow);
    cleanRun_ = clean ? cleanRun_ + 1 : 0;
    lateRun_ = clean ? 0 : lateRun_ + 1;
    if (judged_ < kJudgeSec) {
      late_[(head_ + judged_++) % kJudgeSec] = lateNow;
    } else {
      late_[head_] = lateNow;
      head_ = (head_ + 1) % kJudgeSec;
    }
  }
  int late = 0;
  for (int i = 0; i < judged_; i++) late += late_[(head_ + i) % kJudgeSec];

  RenderScalePoint list[kScaleMaxPoints];
  const int n = operatingPoints(limits, list);
  const double clamped = std::min(std::max(point_.scale, limits.min), limits.max);
  const int at = pointAtOrBelow(RenderScalePoint{clamped, point_.divisor}, list, n);

  // PLACE THE SCENE, once its cell count is known and while it is still in its
  // grace: where that count left off this session. A count not seen yet stays
  // where the scene before it was, since only late frames move the rung. A
  // placement is not a step: it judges nothing, and the clean run starts from
  // the end of the grace either way.
  if (cells_ >= 0 && std::min(cells_, kMaxCells) != sceneCells_
      && tMs - sceneMs_ < kScaleSceneGraceSec * 1000.0) {
    const int c = std::min(cells_, kMaxCells);
    const int place = rungOf_[c] > 0.0
        ? pointAtOrBelow(RenderScalePoint{rungOf_[c] / baseLines_, point_.divisor}, list, n)
        : at;
    sceneCells_ = c;
    if (list[place].scale != point_.scale || list[place].divisor != point_.divisor) {
      return moveTo(list[place], mon, out);
    }
  }
  const int slot = barSlot();
  const bool aboveBarred = at + 1 < n && barred(slot, list[at + 1].scale * baseLines_, tMs);
  // A POINT FROM THE OTHER RATE — the host just flipped `halfRate` — has no
  // entry in this list (every entry shares one divisor), so it moves to the
  // anchor at the new rate.
  const int to = list[0].divisor != point_.divisor
      ? anchorPoint(list, n, limits)
      : renderScaleRung(at, n, late, downLateFrames(pointPeriodMs(point_, limits)),
                        lateRun_, cleanRun_, aboveBarred);
  RenderScalePoint next = list[to];
  // Snap rather than creep: without this a scale a hair off its rung (a band
  // that moved) re-decides every poll forever.
  if (next.divisor == point_.divisor
      && next.scale > clamped - kScaleMinMove && next.scale < clamped + kScaleMinMove) {
    next = RenderScalePoint{clamped, point_.divisor};
  }
  if (next.scale == point_.scale && next.divisor == point_.divisor) return false;

  // A step down within kTrySec of entering the rung LOST it, unless a step
  // down is also how it was entered: barred at this count for kBarSec.
  const bool down = next.divisor == point_.divisor && to < at;
  if (down && !steppedDown_ && tMs - enteredMs_ < kTrySec * 1000.0) {
    bar(slot, list[at].scale * baseLines_, tMs);
  }
  enteredMs_ = tMs;
  steppedDown_ = down;
  return moveTo(next, mon, out);
}

bool RenderScaleController::moveTo(RenderScalePoint p, perf::Monitor& mon,
                                   RenderScalePoint* out) {
  point_ = p;
  judged_ = 0;
  head_ = 0;
  lateRun_ = 0;
  cleanRun_ = 0;
  mon.reset();
  if (out) *out = point_;
  return true;
}

bool RenderScaleController::remap(double tMs, RenderScaleLimits limits,
                                  RenderScalePoint* out) {
  // THE PICTURE, NOT THE SCALE. A scale is a multiplier on the surface's height,
  // so kept across a change of height it is another picture — and placed
  // DOWNWARD onto the new rungs (pointAtOrBelow), a shorter surface lost a rung
  // to it every time: a Mac on 1620 lines in fullscreen had 1358 of them in
  // the window, which is 1080. Each exit from fullscreen cost a rung no missed
  // frame had asked for, and a climb back takes most of a minute per rung.
  //
  // So a ladder rung keeps its LINES — every rung under the new ceiling is
  // offered on any surface — and the CEILING stays the ceiling: "as sharp as
  // this surface allows" is the same answer on the new surface, even where it
  // is more lines than the old one's. If the new surface cannot afford it, its
  // frames say so, as they would have for any rung — unless they already have:
  // a new ceiling this count has barred keeps the old one's lines instead.
  const double base = limits.baseLines > 0.0 ? limits.baseLines : 1.0;
  const bool atCeiling = point_.scale >= max_ - 1e-9
      && !barred(barSlot(), limits.max * base, tMs);
  const double want = atCeiling ? limits.max : point_.scale * baseLines_ / base;
  baseLines_ = base;
  max_ = limits.max;
  limits.halfRate = halfRate();
  RenderScalePoint list[kScaleMaxPoints];
  const int n = operatingPoints(limits, list);
  const double clamped = std::min(std::max(want, limits.min), limits.max);
  // The divisor is untouched: a pending rate flip is the next poll's to perform.
  const RenderScalePoint p{
      list[pointAtOrBelow(RenderScalePoint{clamped, point_.divisor}, list, n)].scale,
      point_.divisor};
  // NOT A STEP: the rung, its clocks, how it was entered, its window and its
  // clean run all stand. The resize's own stall is the shell's to report
  // (resized()), and the grace that follows keeps it out of the window.
  if (p.scale == point_.scale) return false;
  point_ = p;
  if (out) *out = point_;
  return true;
}

// Lines within half a line are one rung: a rung's scale is its lines over the
// surface's, and the product comes back a hair off.
bool RenderScaleController::barred(int c, double lines, double tMs) const {
  for (const Bar& b : bars_[c]) {
    if (tMs < b.untilMs && b.lines <= lines + 0.5) return true;
  }
  return false;
}

void RenderScaleController::bar(int c, double lines, double tMs) {
  // The same rung's entry, or else the one that runs out soonest (an empty one
  // ran out at 0).
  Bar* slot = &bars_[c][0];
  for (Bar& b : bars_[c]) {
    if (std::fabs(b.lines - lines) < 0.5) {
      slot = &b;
      break;
    }
    if (b.untilMs < slot->untilMs) slot = &b;
  }
  *slot = Bar{lines, tMs + kBarSec * 1000.0};
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
