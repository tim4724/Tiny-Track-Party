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
using ttp::rt::anchorDivisor;
using ttp::rt::operatingPoints;
using ttp::rt::pointBudgetMs;
using ttp::rt::RenderScalePoint;
using ttp::rt::renderScaleStep;
using ttp::rt::fitCost;
using ttp::rt::predictMs;
using ttp::rt::RenderScaleSample;
using ttp::rt::rungAtOrBelow;
using ttp::rt::rungScales;

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

// A 4K panel at devicePixelRatio 1: a scale of 1.0 is its own 2160 lines, and
// no shell floor narrows it, so what it offers is the whole ladder — 540, 720,
// 1080, 1620 and native. THE FLOOR IS THE LADDER'S BOTTOM RUNG and no longer a
// shell constant, which is the point of line counts: 540 lines is 540 lines on
// every panel, where a fraction-of-the-ceiling floor meant two different
// pictures on a 1080p surface and a 2160p one.
constexpr double kHz60 = 1000.0 / 60.0;
constexpr double kHz120 = 1000.0 / 120.0;
constexpr RenderScaleLimits k4K{0.0, 1.0, 2160.0, kHz60};
constexpr double kFloor = 540.0 / 2160.0;
// The same ladder seen by a 1080p TV, where only three rungs fit under native.
constexpr RenderScaleLimits kHD{0.0, 1.0, 1080.0, kHz60};
// A 4K panel that can present 120.
constexpr RenderScaleLimits k4K120{0.0, 1.0, 2160.0, kHz120};
constexpr double kLongHold = 60.0;
// Seconds since the SCENE was built. Past kScaleRecoverSec, so every case
// above the recovery block below is judged by the steady-state up-hold —
// which is what they were all written against.
constexpr double kSettled = 600.0;
// "no previous observation at another scale" — the boot state, and what every
// case that is not ABOUT the cost model passes.
constexpr RenderScaleSample kNoFit{0.0, 0.0};
constexpr RenderScalePoint kNative{1.0, 1};
constexpr int kEnough = 120;  // a full stats window

// A device whose GPU timer says `ms` per frame, presenting on cadence.
RenderScaleCost gpuAt(double ms, int frames = kEnough) {
  return RenderScaleCost{ms, frames, 16.7, 16.7, kEnough};
}
// A device with NO timer, presenting `ratio` times slower than its own best.
RenderScaleCost noTimerAt(double ratio, double floorMs = 16.7, int frames = kEnough) {
  return RenderScaleCost{0.0, 0, floorMs * ratio, floorMs, frames};
}

// A shell driving the rule, holding the one observation the model needs: the
// scale that was in force and the share measured at it, recorded at the moment
// the scale changes. Both real shells do exactly this.
struct Shell {
  RenderScalePoint at{1.0, 1};
  RenderScaleSample prev{0.0, 0.0};
  int moves = 0;
  void poll(double ms, RenderScaleLimits b, double sinceScene = kSettled) {
    const RenderScalePoint next =
        renderScaleStep(at, gpuAt(ms), kLongHold, sinceScene, prev, b);
    if (next.scale != at.scale || next.divisor != at.divisor) {
      prev = RenderScaleSample{at.scale, ms};
      at = next;
      moves++;
    }
  }
  double lines(RenderScaleLimits b) const { return at.scale * b.baseLines; }
};

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

  // ---- the RUNGS -----------------------------------------------------------
  // Line counts, so the same rung is the same picture on any panel, and the
  // bottom one is the floor everywhere rather than a fraction of the ceiling.
  {
    double r[8];
    check(rungScales(kHD, r) == 3, "a 1080p surface offers three rungs");
    nearly(r[0], 540.0 / 1080.0, "…the lowest being 540 lines");
    check(rungScales(k4K, r) == 5, "a 4K surface offers five");
    nearly(r[0] * 2160.0, 540.0, "…and ITS lowest is also 540 lines");
    // The ceiling is always the top rung, so a panel the ladder does not name
    // still reaches its own native resolution.
    const RenderScaleLimits qhd{0.0, 1.0, 1440.0, kHz60};
    const int n = rungScales(qhd, r);
    nearly(r[n - 1], 1.0, "native is offered on a panel the ladder does not name");
    check(n == 4, "…above the three ladder rungs that fit under it");
  }
  // Placement is DOWNWARD, never to the nearest: rounding up would hand a
  // struggling device more pixels on a poll that decided nothing.
  {
    double r[8];
    const int n = rungScales(k4K, r);
    nearly(r[rungAtOrBelow(0.70, r, n)], 1080.0 / 2160.0,
           "a scale between rungs places on the one at or below it");
    nearly(r[rungAtOrBelow(0.24, r, n)], 540.0 / 2160.0,
           "and one under the bottom rung comes up to it");
  }

  // ---- the OPERATING POINTS ------------------------------------------------
  // Rate and resolution are ONE ordered axis, built around 1080@60.
  {
    RenderScalePoint l[8];
    const int n = operatingPoints(k4K, l);
    check(n == 5, "a 60 Hz 4K panel offers five points — every rung, one rate");
    for (int i = 0; i < n; i++) check(l[i].divisor == 1, "…all at the panel's own rate");
    nearly(l[0].scale * 2160.0, 540.0, "worst is 540");
    nearly(l[n - 1].scale * 2160.0, 2160.0, "best is native");
  }
  {
    RenderScalePoint l[8];
    const int n = operatingPoints(k4K120, l);
    // 540@60, 720@60, 1080@60, then the RATE step, then 1620@120, 2160@120.
    check(n == 6, "a 120 Hz 4K panel offers six — the same rungs plus a rate step");
    nearly(l[0].scale * 2160.0, 540.0, "540 first");
    check(l[0].divisor == 2 && l[1].divisor == 2 && l[2].divisor == 2,
          "everything at or below the anchor runs at 60 Hz, not 120");
    nearly(l[2].scale * 2160.0, 1080.0, "the anchor is 1080 lines");
    nearly(l[3].scale * 2160.0, 1080.0, "and the step ABOVE it is the SAME picture…");
    check(l[3].divisor == 1, "…at twice the rate — rate before pixels");
    nearly(l[4].scale * 2160.0, 1620.0, "only then does resolution climb again");
    check(l[4].divisor == 1 && l[5].divisor == 1, "…at the faster rate");
  }
  // BELOW the anchor the rate never gives way. A tilt-steered party game pays
  // for a halved present rate in input latency, on every player.
  {
    RenderScalePoint l[8];
    const int n = operatingPoints(k4K120, l);
    for (int i = 0; i < n; i++) {
      if (l[i].scale * 2160.0 < 1080.0 - 1e-9) {
        check(l[i].divisor == anchorDivisor(k4K120), "no point under the anchor halves the rate");
      }
    }
  }
  // The divisor nearest 60 on each panel, which is what the anchor means.
  nearly((double) anchorDivisor(k4K), 1.0, "a 60 Hz panel presents every vsync");
  nearly((double) anchorDivisor(k4K120), 2.0, "a 120 Hz panel presents every other one");
  {
    const RenderScaleLimits hz144{0.0, 1.0, 1440.0, 1000.0 / 144.0};
    nearly((double) anchorDivisor(hz144), 2.0, "a 144 Hz panel takes 72, the closest it offers");
    const RenderScaleLimits hz50{0.0, 1.0, 1080.0, 20.0};
    nearly((double) anchorDivisor(hz50), 1.0,
           "and a 50 Hz PAL box runs at 50 — a shell may not name a rate its panel lacks");
  }
  // A window too short to show the anchor is never "above the desired spot", so
  // it never buys frames it has no pixels to fill.
  {
    RenderScalePoint l[8];
    const RenderScaleLimits small{0.0, 1.0, 700.0, kHz120};
    const int n = operatingPoints(small, l);
    for (int i = 0; i < n; i++) check(l[i].divisor == 2, "a sub-1080 surface takes no rate step");
  }
  // The budget IS the present interval, which is what makes a rate step and a
  // resolution step comparable at all.
  nearly(pointBudgetMs(RenderScalePoint{1.0, 1}, k4K120), kHz120, "divisor 1 on 120 Hz is 8.3 ms");
  nearly(pointBudgetMs(RenderScalePoint{1.0, 2}, k4K120), 2.0 * kHz120, "divisor 2 is 16.7");

  // ---- the cost model ------------------------------------------------------
  // MILLISECONDS, so one fit serves every rate: what a frame costs the GPU does
  // not depend on how often it is presented.
  {
    const auto truth = [](double s) { return 4.0 + 9.0 * s * s; };
    const ttp::rt::RenderScaleFit f =
        fitCost(0.5, truth(0.5), RenderScaleSample{1.0, truth(1.0)});
    check(f.ok, "two observations at two scales fit");
    nearly(f.fixedMs, 4.0, "…and recover the resolution-independent half");
    nearly(f.fillMs, 9.0, "…and the per-pixel half");
    nearly(predictMs(f, 0.75), truth(0.75), "so a rung it has never visited is predictable");
  }
  check(!fitCost(0.5, 6.0, RenderScaleSample{0.0, 0.0}).ok, "one observation does not fit");
  check(!fitCost(0.5, 6.0, RenderScaleSample{0.5, 6.0}).ok, "nor two at the SAME scale");
  check(!fitCost(0.5, 12.0, RenderScaleSample{1.0, 3.0}).ok,
        "nor one saying more pixels cost LESS, which is noise and not a device");
  check(fitCost(0.5, 1.0, RenderScaleSample{1.0, 12.0}).fixedMs >= 0.0,
        "a negative fixed half clamps to zero");

  // ---- no signal -----------------------------------------------------------
  {
    const RenderScaleCost silent{0.0, 0, 0.0, 0.0, 0};
    const RenderScalePoint p = renderScaleStep(kNative, silent, kLongHold, kSettled, kNoFit, k4K);
    nearly(p.scale, 1.0, "no signal holds the current point");
    check(p.divisor == 1, "…rate included");
  }

  // ---- convergence ---------------------------------------------------------
  // Walked as sequences, because oscillation is a property of the loop and not
  // of any one decision. `Shell` holds the one observation the model needs.
  {
    // A weak TV: fill-dominated, so the ladder has real work to do. It starts
    // where every shell starts — native — and must land on the best point that
    // actually fits, then stay there.
    const auto cost = [](double s) { return 2.0 + 20.0 * s * s; };
    Shell sh;
    for (int i = 0; i < 40; i++) sh.poll(cost(sh.at.scale), k4K);
    check(sh.moves <= 4, "a weak device converges in a handful of steps");
    check(cost(sh.at.scale) <= ttp::rt::kScaleTargetShare * pointBudgetMs(sh.at, k4K),
          "onto a point inside its own budget");
    const int settled = sh.moves;
    for (int i = 0; i < 20; i++) sh.poll(cost(sh.at.scale), k4K);
    check(sh.moves == settled, "and stays there — a fixed point, not a limit cycle");
  }
  {
    // A MOSTLY-FIXED-COST DEVICE, the shape a low-end mobile GPU actually has:
    // the reference Android box measures ~8 ms of resolution-independent cost
    // against a 16.7 ms budget. THIS IS THE CASE A THRESHOLD CANNOT SERVE — any
    // climb threshold low enough to stop a pure-fill device oscillating sits
    // below its fixed cost, so it would read "no headroom" at every resolution
    // and pin to the floor for good. The model can see that 8 ms will not move.
    const auto cost = [](double s) { return 8.0 + 17.5 * s * s; };
    Shell sh;
    for (int i = 0; i < 40; i++) sh.poll(cost(sh.at.scale), k4K);
    check(sh.at.scale > kFloor + 1e-9, "a mostly-fixed-cost device is not pinned at the floor");
    check(cost(sh.at.scale) <= ttp::rt::kScaleTargetShare * pointBudgetMs(sh.at, k4K),
          "and settles inside budget");
  }
  {
    // THE OSCILLATION CASE, once an arithmetic bound on two thresholds and now a
    // property of the loop: a device with NO fixed cost is the worst case for
    // stepping up, because every pixel it takes back costs it.
    const auto cost = [](double s) { return 46.0 * s * s; };
    Shell sh;
    for (int i = 0; i < 40; i++) sh.poll(cost(sh.at.scale), k4K);
    const int settled = sh.moves;
    for (int i = 0; i < 60; i++) sh.poll(cost(sh.at.scale), k4K);
    check(sh.moves == settled, "a pure-fill device settles and never moves again");
  }
  {
    // THE SCENE GETTING CHEAPER, which the recovery path exists for. The shell
    // drops its previous observation (it belongs to a scene that no longer
    // exists), so the rule PROBES its way back to a model and climbs on it.
    const auto heavy = [](double s) { return 2.0 + 20.0 * s * s; };
    const auto light = [](double s) { return 1.0 + 3.0 * s * s; };
    Shell sh;
    for (int i = 0; i < 40; i++) sh.poll(heavy(sh.at.scale), k4K);
    check(sh.at.scale < 1.0, "the heavy scene really did soften it");
    sh.prev = RenderScaleSample{0.0, 0.0};      // what a scene build does
    for (int i = 0; i < 40; i++) sh.poll(light(sh.at.scale), k4K, 0.0);
    nearly(sh.at.scale, 1.0, "a lighter scene climbs back to native from a probe");
  }
  {
    // THE RECOVERY WINDOW HAS TO OUTLAST THE CLIMB, and this walks a real clock
    // rather than pinning sinceScene at 0 — which is what let the window sit two
    // steps short of the list without any case noticing.
    //
    // sinceChange is ONE evidence window, not kLongHold: that is what a climb
    // actually looks like (a step, a second, the next step), and it is the only
    // way the recovery hold is what decides. Handing over a long tenure would
    // satisfy the 28 s hold too and the window would make no difference — which
    // is exactly how the first version of this case passed against the bug.
    //
    // On the panel with the LONGEST list: a 120 Hz one, where the rate step adds
    // an entry the ladder's own rung count cannot see.
    const auto light = [](double x) { return 0.5 + 1.5 * x * x; };
    RenderScalePoint at{540.0 / 2160.0, 2};   // as if a heavy scene floored it
    RenderScaleSample prev{0.0, 0.0};
    double t = 0.0;
    for (int i = 0; i < ttp::rt::kScaleMaxPoints + 3; i++) {
      const double ms = light(at.scale);
      const RenderScalePoint next = renderScaleStep(
          at, gpuAt(ms), ttp::rt::kScaleUpRecoverHoldSec, t, prev, k4K120);
      if (next.scale != at.scale) prev = RenderScaleSample{at.scale, ms};
      at = next;
      t += ttp::rt::kScaleUpRecoverHoldSec;
    }
    nearly(at.scale * 2160.0, 2160.0, "the window outlasts a bottom-to-top climb");
    check(at.divisor == 1, "…rate step included, which the rung count could not cover");
  }

  {
    // A PANEL THE LADDER DOES NOT NAME still climbs to its OWN native
    // resolution, not to the highest ladder value under it. A browser window is
    // this case almost always: 909 CSS px at devicePixelRatio 2 is an 1818-line
    // surface, whose rungs are 540/720/1080/1620 and then 1818 itself.
    //
    // Capping at 1620 would be the WORSE picture, not the stricter one: 1620
    // displayed on 1818 lines is a 1.122 upscale, the uneven kind that blurs in
    // bands and crawls as the camera moves — exactly what the ladder exists to
    // avoid. At the ceiling nothing is upscaled at all.
    const RenderScaleLimits web{0.0, 2.0, 909.0, kHz60};
    double r[16];
    const int n = rungScales(web, r);
    nearly(r[n - 1] * 909.0, 1818.0, "the top rung on a browser window is its own native size");
    nearly(r[n - 2] * 909.0, 1620.0, "with the highest ladder value below it");
    const auto light = [](double x) { return 1.0 + 2.0 * x * x; };
    Shell sh;
    sh.at = RenderScalePoint{540.0 / 909.0, 1};
    for (int i = 0; i < 40; i++) sh.poll(light(sh.at.scale), web, 0.0);
    nearly(sh.lines(web), 1818.0, "and a device with the headroom climbs all the way to it");
  }

  {
    // A DEVICE WHOSE COST DOES NOT SCALE WITH PIXELS MUST HOLD, not pump.
    //
    // The reference Android box at its floor is this: 1280x720 measured 17.1 ms
    // and 960x540 measured 17.3, so the slope is NEGATIVE and fitCost refuses.
    // Routing a refused FIT into the blind probe made it climb a rung, find it
    // no cheaper, retreat one down-hold later and do it again — every excursion
    // a surface resize, which is a visible flicker on the panel. Observed on the
    // box as 0.67/0.50 round trips for as long as the lobby was up.
    //
    // Priced just UNDER the down threshold, because that is when it actually
    // fires: over it the retreat branch takes the poll and the probe is never
    // reached, which is why the pump on the box was minutes apart rather than
    // every few seconds.
    const RenderScaleSample flat{720.0 / 1080.0, 14.3};
    const RenderScalePoint at{540.0 / 1080.0, 1};
    nearly(renderScaleStep(at, gpuAt(14.5), kLongHold, kSettled, flat, kHD).scale,
           at.scale, "a non-positive cost slope holds rather than probing");
    // It is the OBSERVATION that stops it, not the hold and not lateness: the
    // same poll with nothing measured at another scale is missing data, and
    // probing is the only way to get any.
    check(renderScaleStep(at, gpuAt(14.5), kLongHold, kSettled, kNoFit, kHD).scale > at.scale,
          "…while having measured nothing probes");
  }

  // ---- 120 Hz --------------------------------------------------------------
  {
    // A DEVICE THAT CAN DRIVE 120 SHOULD. Cheap frames: 3 ms flat at native,
    // which fits an 8.3 ms budget everywhere, so it should end at 2160@120.
    const auto cost = [](double s) { return 1.0 + 2.0 * s * s; };
    Shell sh;
    for (int i = 0; i < 40; i++) sh.poll(cost(sh.at.scale), k4K120);
    check(sh.at.divisor == 1, "a device with the headroom takes the panel's 120 Hz");
    nearly(sh.lines(k4K120), 2160.0, "…at full resolution");
  }
  {
    // AND ONE THAT CANNOT, MUST NOT. 12 ms at 1080 fits 16.7 but not 8.3, so the
    // rate step is refused and it holds the anchor rather than shredding pixels
    // to chase a rate. This is the case a naive `budget = panel period` gets
    // wrong: it would drop to 540 to reach 120.
    const auto cost = [](double s) { return 4.0 + 32.0 * s * s; };
    Shell sh;
    for (int i = 0; i < 40; i++) sh.poll(cost(sh.at.scale), k4K120);
    check(sh.at.divisor == 2, "a device without it stays at 60 Hz");
    check(sh.lines(k4K120) >= 1080.0 - 1e-9, "…and keeps the anchor's picture");
  }
  {
    // A 120 Hz PANEL WITH A WEAK GPU falls DOWN the resolution rungs at 60 Hz,
    // never below the anchor at 120 — the rate is not a rescue.
    const auto cost = [](double s) { return 6.0 + 40.0 * s * s; };
    Shell sh;
    for (int i = 0; i < 40; i++) sh.poll(cost(sh.at.scale), k4K120);
    check(sh.at.divisor == 2, "a struggling device on a 120 Hz panel runs 60, not 120");
    check(sh.lines(k4K120) < 1080.0, "…and pays in resolution, which is the stated trade");
  }

  std::printf("render_scale: %d cases, %d failed\n", cases, failed);
  return failed ? 1 : 0;
}
