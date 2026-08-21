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

  // The cell count is the frame builder's, not the shell's, so it reaches the
  // rule from here rather than through the poll's arguments — see cells().
  limits.cells = cells_;

  const perf::Readout r = mon.fold();

  // The device's own fastest present, folded one window at a time. It has to
  // outlive the window, and that is the whole subtlety of the fallback signal:
  // a device slow enough that EVERY frame in one window is slow has a p05 equal
  // to its p95, reads as a perfectly steady cadence, and would never adapt. Off
  // the TICK series — panelMs() says why.
  floorMs_ = presentBaseline(floorMs_, r.frame.p05);
  panelMs_ = limits.panelMs > 0 ? limits.panelMs : floorMs_;
  limits.panelMs = panelMs_;

  // ABSENT IS NOT ZERO, and the rule reads 0 as "no signal" for both terms. A
  // platform with no GPU timer has no milliseconds, not free frames.
  const RenderScaleCost cost{
      r.gpu.has ? r.gpu.p95 : 0.0, r.gpu.n,
      r.present.has ? r.present.p95 : 0.0,
      // THE FLOOR TIMES THE DIVISOR: what lateness is judged against is the
      // cadence we CHOSE, not the panel's raw period. Without it a deliberate
      // present-every-other-vsync reads as a ratio of 2.0 and the fallback path
      // rescues a healthy device downward, once every hold, to the floor.
      //
      // IT AGREES WITH latePresentRatio's OWN 60 Hz FLOOR BY CONSTRUCTION, and
      // that is worth knowing rather than tidying: the divisor is anchorDivisor,
      // which is round(hz/60), so `floor * divisor` lands within a rounding of
      // 1000/60 on every panel the ladder can name. The two guards are therefore
      // not catchable apart by any reachable configuration — there is no
      // mutation for this line for that reason. They are kept as two because
      // they say two different things, and only the other one covers the case
      // that actually bit (a 120 Hz panel at divisor 1, where this multiplies
      // by one and does nothing).
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

RenderScaleController& renderScale() {
  static RenderScaleController c;
  return c;
}

}  // namespace rt
}  // namespace ttp
