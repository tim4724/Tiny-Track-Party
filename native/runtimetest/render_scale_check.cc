// Behaviour check for the adaptive render scale: ttp/render_scale.h, the pure
// rule, and ttp/render_scale_controller.h, the state around it.
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
#include "ttp/render_scale_controller.h"

using ttp::rt::RenderScaleController;
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

  // ---- the fallback does not step down off a scene's ASSEMBLY ---------------
  // A step this path takes is one it can never take back, and a scene keeps
  // costing after its build returns (shader compiles, first uploads, the shadow
  // bake). A solo race that holds 60 at the panel's own resolution presented at
  // 7-25 fps for its first seconds and was permanently downgraded for it.
  {
    const RenderScalePoint top{1.0, 1};
    const RenderScaleLimits k4K{0.0, 1.0, 2160.0, 16.7};
    const RenderScaleSample none{0.0, 0.0};
    const RenderScaleCost late = noTimerAt(2.0);

    check(renderScaleStep(top, late, kLongHold, 1.0, none, k4K).scale == top.scale,
          "a whole period late one second into a scene does NOT drop a rung");
    check(renderScaleStep(top, late, kLongHold,
                          ttp::rt::kScaleSceneGraceSec - 0.1, none, k4K).scale == top.scale,
          "…nor a tick before the grace is up");
    check(renderScaleStep(top, late, kLongHold,
                          ttp::rt::kScaleSceneGraceSec, none, k4K).scale < top.scale,
          "…and DOES once the scene has had time to settle");
    // The guard is the fallback's alone: a device with a timer climbs back out
    // of a premature drop, so it is not made to wait for a rescue.
    check(renderScaleStep(top, gpuAt(30.0), kLongHold, 1.0, none, k4K).scale < top.scale,
          "a GPU timer still rescues inside the grace, because it can climb back");
  }

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

  // ---- the controller ------------------------------------------------------
  //
  // The state the three shells used to hold by hand. What is pinned here is
  // everything that was theirs to get wrong: which series the floor is learned
  // from, what lateness is measured against once a rate has been chosen, when
  // the window is dropped, and what a scene build does to the climb.
  {
    // A loop that ticks at the panel's rate and presents every Nth tick.
    // `everyNth` above 1 with a divisor of 1 is a SKIP STORM; equal to the
    // divisor it is the cadence the rule itself chose.
    struct Box {
      ttp::rt::perf::Monitor mon;
      RenderScaleController ctl;
      double t = 0;
      int everyNth = 1;
      int tick = 0;
      double gpuMs = -1;   // <= 0: no timer, like tvOS

      void ticks(int n, double panel = kHz60) {
        for (int i = 0; i < n; i++) {
          t += panel;
          const bool drew = (++tick % everyNth) == 0;
          ttp::rt::perf::Sample s;
          s.tMs = t;
          s.intervalMs = panel;   // the LOOP's cadence, unaffected by a skip
          s.presented = drew;
          s.cpuMs = -1;
          s.gpuMs = drew ? gpuMs : -1;
          mon.record(s);
        }
      }
      bool poll(RenderScaleLimits b, RenderScalePoint* out = nullptr) {
        RenderScalePoint p{0, 0};
        const bool moved = ctl.poll(t, b, mon, &p);
        if (out) *out = p;
        return moved;
      }
      double lines(RenderScaleLimits b) const { return ctl.point().scale * b.baseLines; }
    };

    {
      // THE PANEL PERIOD IS LEARNED FROM THE TICKS where a shell has none to
      // declare — a browser has no refresh-rate API. Off the PRESENT series it
      // would read a chosen divisor as a slower panel.
      Box b;
      b.everyNth = 3;
      b.ticks(180);
      b.poll(RenderScaleLimits{0.0, 1.0, 2160.0, 0.0});
      nearly(b.ctl.panelMs(), kHz60, "no declared period: learned from the tick series");
    }
    {
      // THE CEILING IS THE BAND'S, ADOPTED ON THE FIRST POLL. A browser on a
      // HiDPI screen sizes its buffer from the ceiling before a frame exists,
      // so a controller that started at a baked-in 1.0 would be pricing frames
      // drawn at 2.0 as though they cost that at 1.0 — and would halve a canvas
      // nobody asked it to touch on its first move.
      const RenderScaleLimits retina{0.0, 2.0, 1080.0, kHz60};
      Box b;
      b.gpuMs = 1.0;
      b.ticks(180);
      check(!b.poll(retina), "adopting the ceiling is not a move: the shell is already there");
      nearly(b.ctl.point().scale, 2.0, "…and the point in force IS the ceiling");
      // …and it is the CEILING, not the top ladder rung: 2160 lines on a
      // 1080-line surface is not on the ladder at all, and native is a rung on
      // every panel (see kScaleLadder).
      nearly(b.lines(retina), 2160.0, "the ceiling is a rung whatever the surface");
    }
    {
      // ONCE, and the band still moves afterwards — a window dragged to another
      // screen lowers the ceiling, and the rule clamps into it every poll.
      const RenderScaleLimits retina{0.0, 2.0, 1080.0, kHz60};
      const RenderScaleLimits plain{0.0, 1.0, 1080.0, kHz60};
      Box b;
      b.gpuMs = 1.0;
      b.ticks(180);
      b.poll(retina);
      b.ticks(180);
      b.poll(plain);
      check(b.ctl.point().scale <= 1.0 + 1e-9, "a lowered ceiling is honoured, not re-adopted");
    }
    {
      // THE 144 Hz TRAP, on the arm that cannot take a mistake back.
      //
      // A 120 Hz panel with no GPU timer, holding a SOLID 60: the loop ticks at
      // the panel's rate and presents every other tick, so the floor learns 8.3
      // and the p95 is 16.7. Judged against the raw floor that is a ratio of
      // 2.0 — "a whole period late", every window, forever — and this arm may
      // only step DOWN, so a machine doing nothing wrong loses half its
      // resolution and never gets it back. Measured on the artifact before the
      // fix: 2160 lines to 1080 in nine seconds.
      //
      // 60 fps is the bar; a faster panel does not make a good frame a bad one.
      // perf_stats.cc closed exactly this hole for the readout, under exactly
      // this name, while the rule beside it kept dividing by the raw floor.
      Box b;
      b.ticks(240, kHz120);          // a cheap screen: every tick presents at 120
      b.everyNth = 2;                // …then a race the box holds at a solid 60
      for (int i = 0; i < 12; i++) { b.ticks(240, kHz120); b.poll(k4K120); }
      nearly(b.lines(k4K120), 2160.0,
             "a 120 Hz panel holding 60 is not late, and keeps its resolution");
    }
    {
      // …AND THE FLOOR IS NOT A BLINDFOLD, which is the arm that makes the check
      // above falsifiable. Where the panel IS the anchor the bar and the floor
      // are one number and nothing changed: a 60 Hz box presenting every other
      // vsync is 30 fps, a ratio of 2.0, and is rescued exactly as before.
      //
      // (Deliberately on a 60 Hz panel. The same demonstration at 120 Hz cannot
      // be made: the ring holds 120 TICKS, so a box slow enough to be judged
      // late there leaves under kMinSignalFrames present-gaps in it and the rule
      // answers "no signal" — a real blind spot of the fallback on a
      // high-refresh panel whose loop ticks regardless of what drew, and one
      // this file is not the place to fix.)
      Box b;
      b.ticks(180);
      b.everyNth = 2;
      for (int i = 0; i < 8; i++) { b.ticks(180); b.poll(k4K); }
      check(b.lines(k4K) < 2160.0, "a box that really is late still steps down");
    }
    {
      // THE SKIP STORM THE TICK SERIES HIDES, which is the whole reason the
      // present series exists. The loop ticks a clean 60 and presents 20: a
      // shell steering off tick intervals sees a flat 16.7 and never moves,
      // which is a television left at 40-55 fps with the rule never firing.
      Box b;
      b.everyNth = 3;
      b.ticks(360);   // 6 s: past kScaleSceneGraceSec, which this arm honours
      RenderScalePoint p{0, 0};
      check(b.poll(k4K, &p) && p.scale < 1.0,
            "a box presenting one tick in three is rescued, not read as 60 fps");
      check(b.mon.size() == 0, "…and the window that decided it goes with the buffer");
    }
    {
      // A CHOSEN CADENCE IS NOT A LATE ONE. On a 120 Hz panel the rule anchors
      // at divisor 2 to hold 60, so presents are deliberately two vsyncs apart.
      // Lateness is judged against the cadence CHOSEN — the floor times the
      // divisor — and without that multiply this box retreats every hold, all
      // the way to the bottom rung, while presenting perfectly.
      Box b;
      for (int i = 0; i < 10; i++) {
        const double sc = b.ctl.point().scale;
        b.gpuMs = 4.0 + 32.0 * sc * sc;         // fits 16.7 ms, never 8.3
        b.everyNth = b.ctl.point().divisor;     // present at the cadence chosen
        b.ticks(360, kHz120);                   // 3 s, past the down hold
        b.poll(k4K120);
      }
      check(b.ctl.point().divisor == 2, "a 120 Hz box without the headroom runs 60");
      check(b.lines(k4K120) >= 1080.0 - 1e-9,
            "…at the anchor's picture, not shredded to the floor by its own pacing");
    }
    {
      // A CHOSEN CADENCE IS NOT A LATE ONE, on the arm that cannot take it back.
      //
      // The fallback (no GPU timer) may only step DOWN, so a rescue it should
      // not have made is permanent for the life of the scene. Lateness is
      // therefore judged against the cadence the rule CHOSE — the device's own
      // fastest present times the divisor — and not against one raw vsync.
      //
      // REACHABLE, though it takes both halves: the divisor only ever moves on
      // the GPU arm, and `ttp_display_gpu_ms` answers 0 whenever a query has not
      // come back. So a box settles at 120 Hz/divisor 2 with a timer, the timer
      // goes quiet, and the fallback inherits a point it did not pick. Without
      // the multiply it reads its own deliberate 60 fps as a ratio of 2.0 and
      // walks the ladder to the floor while presenting perfectly.
      Box b;
      for (int i = 0; i < 10; i++) {
        const double sc = b.ctl.point().scale;
        b.gpuMs = 4.0 + 32.0 * sc * sc;
        b.everyNth = b.ctl.point().divisor;
        b.ticks(360, kHz120);
        b.poll(k4K120);
      }
      check(b.ctl.point().divisor == 2 && b.everyNth == 2, "settled at the anchor rate");
      const double settled = b.lines(k4K120);
      b.gpuMs = -1;   // the timer goes quiet; the point stays where it was
      for (int i = 0; i < 8; i++) { b.ticks(360, kHz120); b.poll(k4K120); }
      nearly(b.lines(k4K120), settled,
             "a box presenting at the cadence the rule chose is never late for it");
    }
    {
      // THE POLL CADENCE IS A COST GUARD, AND WHAT PINS IT IS THAT NOTHING
      // DEPENDS ON IT. It stops a 120-sample sort-and-fold running once a frame;
      // it decides nothing, because the rule's own holds and kMinSignalFrames
      // already pace every decision. So the property worth gating is not "the
      // second poll inside a second is refused" — that answers "no move" either
      // way, and passes for the wrong reason — but that a controller polled on
      // EVERY FRAME converges on the same operating point as one polled at the
      // cadence. If a decision ever starts depending on how often it is asked,
      // this is what notices.
      const auto cost = [](double sc) { return 4.0 + 32.0 * sc * sc; };
      Box slow, fast;
      for (int i = 0; i < 24; i++) {
        slow.gpuMs = cost(slow.ctl.point().scale);
        slow.ticks(180);
        slow.poll(k4K);                       // once per window
        for (int f = 0; f < 180; f++) {
          fast.gpuMs = cost(fast.ctl.point().scale);
          fast.ticks(1);
          fast.poll(k4K);                     // …and once per frame
        }
      }
      check(slow.ctl.point().scale > 0 && slow.ctl.point().scale < 1.0,
            "the box settles somewhere below native, so there is something to agree on");
      nearly(fast.lines(k4K), slow.lines(k4K),
             "how often the rule is ASKED does not change where it lands");
      check(fast.ctl.point().divisor == slow.ctl.point().divisor, "…nor the rate it picks");
    }
    {
      // A SCENE HAS NO TENURE IT DID NOT EARN. A box driven to a low rung by a
      // load that then lifts sits behind the LAP-sized up-hold — correct
      // mid-race, and wrong for a race that inherited a lobby's floor. The
      // build restarts the tenure, and the climb runs at one evidence window a
      // step instead of one lap.
      Box b;
      b.gpuMs = 30.0;                          // hopeless at 60 Hz
      for (int i = 0; i < 6; i++) { b.ticks(180); b.poll(k4K); }
      const double floored = b.lines(k4K);
      check(floored < 2160.0, "an expensive scene falls off native");

      b.gpuMs = 1.0;                           // …and the load lifts
      for (int i = 0; i < 6; i++) { b.ticks(180); b.poll(k4K); }
      nearly(b.lines(k4K), floored,
             "past the recovery window a climb waits out the lap-sized hold");

      b.ctl.scene(b.t);
      for (int i = 0; i < 5; i++) { b.ticks(180); b.poll(k4K); }
      check(b.lines(k4K) > floored,
            "a new scene climbs back at one evidence window a step");
    }
  }

  std::printf("render_scale: %d cases, %d failed\n", cases, failed);
  return failed ? 1 : 0;
}
