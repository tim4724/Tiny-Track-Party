// Behaviour check for ttp/render_scale.h — the adaptive render scale.
//
// Assertions rather than a corpus, like progression_check and frame_check: the
// layer has no JS oracle, so this file is where its rules are pinned — which
// signal decides, which directions each may move in, how many samples a
// percentile needs, the holds, the band, and the two ways this could oscillate.
//
// The convergence group at the end is the point of the file. A controller that
// chases its own tail is not a bug a screenshot shows: it shows up as a picture
// that softens and sharpens every few seconds forever, which is worse than
// either scale.
#include <cstdio>

#include "ttp/render_scale.h"

using ttp::rt::latePresentRatio;
using ttp::rt::presentBaseline;
using ttp::rt::RenderScaleCost;
using ttp::rt::RenderScaleLimits;
using ttp::rt::renderScaleStep;

namespace {

int cases = 0, failed = 0;

void check(bool ok, const char* what) {
  cases++;
  if (!ok) {
    failed++;
    std::fprintf(stderr, "FAIL %s\n", what);
  }
}

void nearly(double got, double want, const char* what) {
  check(got > want - 1e-9 && got < want + 1e-9, what);
}

// The band a 4K panel at devicePixelRatio 1 hands in: 2160 lines at the top,
// 720 at the bottom. The shell's floor (MIN_BUFFER_H in Stage.js) is
// deliberately below the commonest panel, so a third of the ceiling is what a
// real 4K screen offers here, not a half.
constexpr double kFloor = 720.0 / 2160.0;
constexpr RenderScaleLimits k4K{kFloor, 1.0};
constexpr double kLongHold = 60.0;
constexpr int kEnough = 120;  // a full stats window

// A device whose GPU timer says `share` of the budget, presenting on cadence.
RenderScaleCost gpuAt(double share, int frames = kEnough) {
  return RenderScaleCost{share, frames, 16.7, 16.7, kEnough};
}
// A device with NO timer, presenting `ratio` times slower than its own best.
RenderScaleCost noTimerAt(double ratio, double floorMs = 16.7, int frames = kEnough) {
  return RenderScaleCost{0.0, 0, floorMs * ratio, floorMs, frames};
}

}  // namespace

int main() {
  // ---- the present baseline: which samples may become the device's cadence ---
  nearly(presentBaseline(0.0, 16.7), 16.7, "the first usable p05 becomes the baseline");
  nearly(presentBaseline(16.7, 33.4), 16.7, "a slower window does not raise it");
  nearly(presentBaseline(16.7, 8.3), 8.3, "a faster one does lower it");
  nearly(presentBaseline(16.7, 2.0), 16.7,
         "a sub-4ms 'present' is two rAFs in one vsync and is rejected");
  nearly(presentBaseline(0.0, 2.0), 0.0, "…even when there is no baseline yet");
  nearly(presentBaseline(20.0, 20.0), 20.0, "a 50 Hz panel settles on its own 20 ms period");

  // ---- the late-present ratio, and the samples it needs ----------------------
  nearly(latePresentRatio(noTimerAt(2.0)), 2.0, "a whole period late reads as 2.0");
  nearly(latePresentRatio(noTimerAt(1.0, 20.0)), 1.0,
         "a 50 Hz panel on ITS cadence reads as 1.0, not as 20/16.7");
  nearly(latePresentRatio(noTimerAt(2.0, 16.7, 10)), 0.0,
         "a percentile over ten frames is not a percentile");
  nearly(latePresentRatio(RenderScaleCost{0, 0, 33.4, 0.0, kEnough}), 0.0,
         "no baseline learned yet means no signal");

  // ---- no signal --------------------------------------------------------------
  const RenderScaleCost silent{0.0, 0, 0.0, 0.0, 0};
  nearly(renderScaleStep(1.0, silent, kLongHold, k4K), 1.0,
         "no signal holds the current scale");
  nearly(renderScaleStep(2.0, silent, kLongHold, k4K), 1.0,
         "a scale above the band is clamped even with nothing measured");
  nearly(renderScaleStep(0.1, silent, kLongHold, k4K), kFloor,
         "a scale below the band is clamped up to the floor");
  nearly(renderScaleStep(0.8, gpuAt(0.99), kLongHold, RenderScaleLimits{0.8, 0.8}), 0.8,
         "a degenerate band (min == max) pins the scale whatever the cost");
  nearly(renderScaleStep(1.0, gpuAt(0.99, 10), kLongHold, k4K), 1.0,
         "a GPU p95 over ten frames is ignored, like the present one");

  // ---- the GPU signal, both directions ----------------------------------------
  nearly(renderScaleStep(1.0, gpuAt(0.95), kLongHold, k4K), 0.8,
         "over budget steps down");
  nearly(renderScaleStep(1.0, gpuAt(0.40), kLongHold, k4K), 1.0,
         "spare headroom at the ceiling stays at the ceiling");
  nearly(renderScaleStep(0.8, gpuAt(0.40), kLongHold, k4K), 0.92,
         "spare headroom below the ceiling steps up");
  nearly(renderScaleStep(0.7, gpuAt(0.70), kLongHold, k4K), 0.7,
         "between the thresholds nothing moves");
  nearly(renderScaleStep(0.4, gpuAt(0.99), kLongHold, k4K), kFloor,
         "a down step clamps at the floor rather than undershooting it");
  nearly(renderScaleStep(0.95, gpuAt(0.40), kLongHold, k4K), 1.0,
         "an up step clamps at the ceiling rather than overshooting it");

  // ---- the holds ---------------------------------------------------------------
  nearly(renderScaleStep(1.0, gpuAt(0.99), 0.5, k4K), 1.0,
         "a device that is late is still left alone inside the down hold");
  nearly(renderScaleStep(0.8, gpuAt(0.10), 3.0, k4K), 0.8,
         "the up hold is longer than the down hold");
  nearly(renderScaleStep(0.8, gpuAt(0.10), 9.0, k4K), 0.92,
         "past the up hold it rises");

  // ---- the fallback: late presents, down only ---------------------------------
  nearly(renderScaleStep(1.0, noTimerAt(2.0), kLongHold, k4K), 0.8,
         "no timer + presents a whole period late steps down");
  nearly(renderScaleStep(1.0, noTimerAt(1.02), kLongHold, k4K), 1.0,
         "no timer + a steady cadence holds");
  nearly(renderScaleStep(0.8, noTimerAt(1.0), kLongHold, k4K), 0.8,
         "a steady cadence is NEVER evidence of headroom, so it cannot raise");
  // A 50 Hz panel and a 30 Hz HDMI mode present at their own steady cadence, and
  // the ratio is over the device's OWN fastest present — so both read as 1.0 and
  // neither is punished for being a TV. That is the whole reason the fallback is
  // a ratio rather than a count of missed 16.7 ms budgets.
  nearly(renderScaleStep(1.0, noTimerAt(1.0, 20.0), kLongHold, k4K), 1.0,
         "a 50 Hz panel presenting on ITS cadence is not a slow device");
  nearly(renderScaleStep(1.0, noTimerAt(1.0, 33.4), kLongHold, k4K), 1.0,
         "nor is a 30 Hz HDMI mode");
  {
    // With a timer present the fallback is ignored, not merged: the same
    // hopelessly late presents that would step a timer-less device down leave a
    // device with headroom exactly where it is.
    RenderScaleCost c = gpuAt(0.40);
    c.presentP95Ms = 33.4;
    nearly(renderScaleStep(1.0, c, kLongHold, k4K), 1.0, "the GPU signal wins outright");
  }

  // ---- convergence -------------------------------------------------------------
  // Walked as sequences rather than asserted as single steps, because
  // oscillation is a property of the loop and not of any one decision.
  {
    // 1. A device pinned at the floor that keeps missing must stay put, not
    //    grind against the clamp forever.
    double s = kFloor;
    for (int i = 0; i < 20; i++) s = renderScaleStep(s, gpuAt(0.99), kLongHold, k4K);
    nearly(s, kFloor, "a floored device that keeps missing settles at the floor");
  }
  {
    // 2. The ceiling is the other clamp, and an up step that lands a hair short
    //    of it must SNAP (kScaleMinMove) rather than creep by a millipixel.
    double s = kFloor;
    for (int i = 0; i < 20; i++) s = renderScaleStep(s, gpuAt(0.10), kLongHold, k4K);
    nearly(s, 1.0, "a device with headroom climbs to the ceiling and stops there");
  }
  {
    // 3. THE REAL ONE: cost is roughly linear in pixels above a fixed floor, so
    //    stepping down by 0.8 in scale takes 0.64 of the pixel cost with it.
    //    Model that and check the loop lands somewhere and STAYS: a scale whose
    //    cost sits between the two thresholds is a fixed point, and the gap
    //    between 0.5 and 0.9 is what guarantees one exists.
    const double fixedShare = 0.12;   // the part that does not scale with pixels
    const double fillAtOne = 1.20;    // 120% of budget at full scale: a weak TV
    const auto shareAt = [&](double s) { return fixedShare + fillAtOne * s * s; };
    double s = 1.0;
    int changes = 0;
    for (int i = 0; i < 40; i++) {
      const double next = renderScaleStep(s, gpuAt(shareAt(s)), kLongHold, k4K);
      if (next != s) { changes++; s = next; }
    }
    check(changes <= 4, "a weak device converges in a handful of steps");
    nearly(renderScaleStep(s, gpuAt(shareAt(s)), kLongHold, k4K), s,
           "and the scale it lands on is a fixed point");
    check(shareAt(s) <= ttp::rt::kScaleDownShare, "settling under the down threshold");
  }

  std::printf("render_scale: %d cases, %d failed\n", cases, failed);
  return failed ? 1 : 0;
}
