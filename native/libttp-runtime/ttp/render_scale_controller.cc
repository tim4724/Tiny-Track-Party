#include "ttp/render_scale_controller.h"

namespace ttp {
namespace rt {

void RenderScaleController::scene(double tMs) {
  sceneMs_ = tMs;
  prev_ = RenderScaleSample{0.0, 0.0};
}

bool RenderScaleController::poll(double tMs, RenderScaleLimits limits,
                                 perf::Monitor& mon, RenderScalePoint* out) {
  // The first call decides immediately rather than waiting a second: what it
  // does is declare the panel period, and a readout judged against a guessed
  // 60 Hz reads amber on a 50 Hz television for as long as it takes.
  if (lastPollMs_ > 0 && tMs - lastPollMs_ < kScalePollMs) return false;
  lastPollMs_ = tMs;

  // THE CEILING, ONCE — see point_. Before renderScaleStep rather than after, so
  // the first poll's answer is measured against the scale the shell is actually
  // drawing at; and it reports NO MOVE, because the shell was already there.
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
  // priced every frame against it. Jitter is symmetric, so the median of a
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

  // ABSENT IS NOT ZERO, and the rule reads 0 as "no signal" for both terms. A
  // platform with no GPU timer has no milliseconds, not free frames.
  const RenderScaleCost cost{
      r.gpu.has ? r.gpu.p95 : 0.0, r.gpu.n,
      r.present.has ? r.present.p95 : 0.0,
      // THE FLOOR TIMES THE DIVISOR: what lateness is judged against is the
      // cadence we CHOSE, not the panel's raw period. Without it the host's
      // deliberate present-every-other-vsync reads as a ratio of 2.0 and the
      // fallback path rescues a healthy device downward, once every hold, to
      // the floor. At the panel's own rate this multiplies by one; the 60 Hz
      // floor latePresentRatio then puts under the bar is the other guard, and
      // the one that covers a 120 Hz panel presenting a steady 60.
      floorMs_ * static_cast<double>(point_.divisor),
      r.present.n};

  const RenderScalePoint next =
      renderScaleStep(point_, cost, (tMs - movedMs_) / 1000.0,
                      (tMs - sceneMs_) / 1000.0, prev_, limits);
  if (next.scale == point_.scale && next.divisor == point_.divisor) return false;

  // THE OBSERVATION THE COST MODEL IS BUILT FROM, recorded at the one moment it
  // exists: the scale that was in force and what a frame cost at it. The rule
  // solves `fixed + fill * s^2` from this and the next one, which is how a
  // device that is half fixed cost climbs at all, and how one frame rate's
  // measurement prices another's. Only on a RESOLUTION move — two points at one
  // scale determine nothing.
  if (next.scale != point_.scale) prev_ = RenderScaleSample{point_.scale, cost.gpuP95Ms};
  point_ = next;
  movedMs_ = tMs;
  mon.reset();
  if (out) *out = point_;
  return true;
}

int RenderScaleController::rateHz(bool half) const {
  RenderScaleLimits b{0.0, 0.0, 0.0, panelMs_};
  b.halfRate = half;
  // A LEARNED period is the median of rAF ticks and can land a fraction of a
  // millisecond off the panel's, which would label a 60 Hz TV "61 fps". Snap to
  // the panel rate it is nearest to; a declared period is already one of these.
  static constexpr double kPanelHz[] = {50.0, 60.0, 75.0, 90.0, 100.0, 120.0, 144.0, 165.0, 240.0};
  double hz = 1000.0 / (panelMs_ > 0.0 ? panelMs_ : 1000.0 / kDefaultPanelHz);
  for (double k : kPanelHz) {
    if (hz > k * 0.95 && hz < k * 1.05) hz = k;
  }
  return (int) (hz / (double) baseDivisor(b) + 0.5);
}

RenderScaleController& renderScale() {
  static RenderScaleController c;
  return c;
}

}  // namespace rt
}  // namespace ttp
