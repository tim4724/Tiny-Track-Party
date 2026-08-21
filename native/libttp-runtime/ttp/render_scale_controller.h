// render_scale_controller — the STATE around ttp/render_scale.h's rule.
//
// The rule itself is pure and stays pure: two observations, three clocks and a
// band go in, one operating point comes out. What was left over was the
// BOOKKEEPING — the window the percentiles are taken over, the running present
// floor, the observation the cost model fits from, when the point last moved
// and when the scene was built — and it was written three times, once per
// shell, in three languages, under comments that pointed at each other.
//
// None of it is platform. A poll cadence is not an Android fact; which samples
// may become a percentile is not a Swift one. The three copies had already
// drifted where it is cheapest to drift and hardest to see: two of them folded
// their p95 at `sorted[floor((n-1)*p)]` while the fold behind the readout used
// `sorted[floor(n*p)]`, so a television judged its own resolution on different
// frames than the ones its overlay drew.
//
// WHAT A SHELL STILL OWES, and it is now only this: keep feeding
// ttp_perf_sample (which it already did), say when a scene was built, name the
// band and the panel period, and PERFORM the answer. Everything between those
// is here.
//
// THE WINDOW IS THE READOUT'S. There is one monitor per process
// (perf::monitor()) and this folds off it, so the numbers steering the
// resolution are the numbers a human is looking at. The present series is the
// one that matters — see perf_stats.h's Readout::present for why it is not the
// tick series beside it.
#pragma once

#include "ttp/perf_stats.h"
#include "ttp/render_scale.h"

namespace ttp {
namespace rt {

// How often the point is re-decided. The rule's holds are seconds long, so this
// only has to be fast enough to catch the load changing — a race starting
// behind a lobby, a fourth player joining — within about a second of it
// happening. All three shells spelled this number, and the two TV ones spelled
// it in units of their own clocks.
//
// IT IS A COST GUARD AND DECIDES NOTHING — the rule's holds and kMinSignalFrames
// already pace every decision, so what this buys is not re-folding 120 samples
// once a frame. Do not write a test asserting that a second poll inside it is
// "refused": that answers no-move either way and passes for the wrong reason.
// render_scale_check gates the honest property instead — polled every frame, the
// controller lands where polling at the cadence lands.
inline constexpr double kScalePollMs = 1000.0;

class RenderScaleController {
 public:
  // The point in force. 1.0 is the surface's own size; nothing here ever
  // supersamples, because the ceiling is the band's and the band is the
  // shell's. NOT ON THE ABI — a shell's own copy is the buffer it actually
  // sized, which is a record of what it performed rather than a second opinion
  // about what to do. This is here for the ctest, which has no shell.
  RenderScalePoint point() const { return point_; }

  // The panel's present period the rule is being judged against: what the shell
  // declared, or — where it declared nothing — what the TICK series has taught
  // us. A shell hands this to ttp_perf_pacing so the readout's budget is the
  // operating point's rather than a guessed 60 Hz.
  //
  // THE TICK SERIES, NOT THE PRESENT ONE, and the divisor is why. Every one of
  // the three loops ticks at the panel's own rate whether or not the frame drew
  // — that is what makes `hz` a different number from `fps` — so ticks are
  // where a panel period can be learned, while presents run at whatever cadence
  // the rule most recently CHOSE. Learning the period off presents would read a
  // deliberate divisor of 2 as a 60 Hz panel and never offer the rate step
  // again.
  double panelMs() const { return panelMs_; }

  // A NEW SCENE. Drops the cost model's observation — a fit whose two points
  // straddle a scene change measures a slope belonging to neither — and
  // restamps the tenure the rule shortens its up-hold against
  // (kScaleUpRecoverHoldSec). The window itself is the shell's to drop, with
  // ttp_perf_reset, for the reason ttp_perf.h names.
  void scene(double tMs);

  // HOW MANY CELLS the surface is split into, which is what gates the floor
  // escape (`kScaleEscapeCells`). It is not part of `limits` as a shell passes
  // them because it is not a shell's fact: the grid belongs to the frame
  // builder, so `ttp_display_frame` declares it here and the poll folds it in.
  void cells(int n) { cells_ = n < 0 ? 0 : n; }

  // Re-decide, at most once per kScalePollMs. Answers whether the point MOVED,
  // and writes the new one to `out`.
  //
  // `tMs` is any monotonic clock the shell likes; only differences are read.
  // `limits` is the band and the panel period — the surface's own facts, and
  // the only things here a shell is entitled to an opinion about. Pass
  // `panelMs` 0 to have it learned (see panelMs() above).
  //
  // ON A MOVE THE WINDOW GOES, here rather than in three shells: it describes
  // the OLD buffer, and keeping it judges the new resolution on the old one's
  // frames for the next two seconds — which is how a controller talks itself
  // into a second step it does not need. Only on a MOVE: clearing every poll
  // caps the sample count at the frame rate, and the rule ignores a window
  // under kMinSignalFrames, so a box at 20 fps would be told it had no signal
  // and never step down — deaf in exactly the case the mechanism exists for.
  bool poll(double tMs, RenderScaleLimits limits, perf::Monitor& mon,
            RenderScalePoint* out);

 private:
  // 1.0 until the first poll ADOPTS THE BAND'S CEILING. "As sharp as this
  // surface allows" is a fact only the band knows, and a 1.0 left standing here
  // is wrong twice on any HiDPI browser (max 2): the shell sizes its buffer from
  // the ceiling before a frame exists, so the rule would be pricing frames drawn
  // at 2.0 as though they cost that at 1.0 — poisoning the cost model's first
  // observation — and its first move would halve the canvas nobody asked it to
  // touch. Both TV shells have a ceiling of 1.0 and see no difference.
  int cells_ = 0;
  bool adopted_ = false;
  RenderScalePoint point_{1.0, 1};
  RenderScaleSample prev_{0.0, 0.0};
  double floorMs_ = 0;     // presentBaseline's running answer
  double panelMs_ = 0;
  double movedMs_ = 0;
  double sceneMs_ = 0;
  double lastPollMs_ = 0;
};

// THE PROCESS'S ONE CONTROLLER, for the reason perf::monitor() is one: there is
// one display, so there is one operating point.
RenderScaleController& renderScale();

}  // namespace rt
}  // namespace ttp
