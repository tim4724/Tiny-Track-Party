// perf_stats — the frame-cost readout's DECISIONS: what a window of frames
// costs, whether that is healthy, and the one machine-readable line a bench
// reads back.
//
// It is here rather than in each shell because the three readouts had already
// drifted while all three carried a comment saying they had not. Every one of
// them said "the web's thresholds, kept so the readouts mean the same thing",
// and by the time this was written tvOS folded skipped presents into its
// verdict and the other two did not — so a run that a television called amber a
// browser called green, on the same numbers. A comparison across platforms is
// the whole point of the bench, and a rule restated three times cannot support
// one.
//
// WHAT A SHELL STILL OWES: the measurements. It reads its own clocks, its own
// profile buffer and whatever GPU timer its backend has, and hands them over —
// it may not judge them. Same contract as render_scale.h, and for the same
// reason.
//
// THREE CLOCKS, and they do not measure the same thing:
//
//   * the PRESENT INTERVAL — the cadence the panel actually ran at. Under vsync
//     it is a plateau, so on its own it says nothing about headroom: 60 fps is
//     equally true at 10% and at 95% load. What it does say is whether a budget
//     was MISSED, which is the part a human feels.
//   * CPU — the renderer building this frame's input and issuing its draws.
//   * GPU — a timer query wrapped around the frame. This is the only one that
//     can see HEADROOM, and it does not exist on every platform: pass it absent
//     rather than passing a plausible substitute (see ttp_display_gpu_ms's
//     header for the two sources that look right and are not).
//
// The two costs do NOT sum. The CPU builds frame N's commands while the GPU is
// still drawing N-1, so 30% + 30% is a comfortable frame. Whichever is larger
// is the one to cut.
#pragma once

#include <string>
#include <vector>

#include "ttp/canonical.h"

namespace ttp {
namespace rt {
namespace perf {

// The bar, and the FLOOR under every budget here. A frame that fits 60 Hz is a
// good frame and a faster panel does not make it a worse one — that floor is
// what stops a 144 Hz monitor scoring a perfectly good 16.7 ms frame as 240% of
// budget, which is what an earlier panel-rate detector did.
//
// A shell may declare a LOOSER bar through Monitor::pacing (a slower panel, or
// a divisor above 1 trading cadence for resolution) but never a tighter one.
// A 50 Hz television that declares its 20 ms period is therefore GOOD when it
// is healthy, rather than amber for being a 50 Hz television; one that declares
// nothing is judged against 60 and sits WARN, which is the honest answer when
// the monitor has not been told what the glass can do.
inline constexpr double kGoodHz = 60.0;
inline constexpr double kBudgetMs = 1000.0 / kGoodHz;

// Frames folded into the percentiles. The RATE and the drop count fold the
// trailing second instead (kRecentMs) — that is the span a human can act on,
// while a p50 over sixteen frames is noise.
inline constexpr int kWindow = 120;
inline constexpr double kRecentMs = 1000.0;

// BOOT IS NOT A FRAME RATE. The first presents of a run are shader compilation
// and first uploads — measured at 75, 17, 50 and 58 ms before a clean 8.3 — and
// since the rate and the drop count are both windowed over the trailing second,
// recording them holds the readout amber for a full second after the game is
// already perfect. Nobody can act on that, and a readout that cries wolf at
// every boot is one people stop reading.
//
// So a run is WARMING until it delivers kWarmupRun frames in a row that miss no
// budget. It has to be a RUN and not one frame: boot is bursty rather than
// monotonic, and that 17 ms second frame is already inside budget — taking it
// as the all-clear lets the 50 and 58 behind it straight into the window.
// kWarmupMax is the backstop: a machine that cannot string three good frames
// together in thirty is not warming up, it is slow, and must be shown as slow.
inline constexpr int kWarmupRun = 3;
inline constexpr int kWarmupMax = 30;

// Budgets missed by a frame that took `intervalMs`. Rounded rather than
// floored, because presents land on vsyncs: a 25 ms interval is a frame that
// slipped one budget, not 1.5 of them. Anything at or under the bar is free, so
// a 6.9 ms frame on a 144 Hz panel is not a fraction of a drop.
int budgetsMissed(double intervalMs, double budgetMs = kBudgetMs);

// The updated count of consecutive frames that missed nothing. Exposed for the
// gate, and because it is the whole of the warm-up rule.
int warmupRun(double intervalMs, int run);

// One tick, drawn or not.
//
// `cpuMs`/`gpuMs` are ABSENT at <= 0, and absent is not zero: a platform with
// no GPU timer has no signal, not a free frame. The cpu sample is dropped on a
// skip rather than repeated — the renderer returns before writing its total, so
// the profile still holds the last DRAWN frame, and folding it again would
// weight the median hardest under exactly the load that causes skips.
struct Sample {
  double tMs = 0;
  double intervalMs = 0;
  bool presented = true;
  double cpuMs = -1;
  double gpuMs = -1;
};

// One series, folded. `n` is how many samples carried the value at all, which
// is not the window size: a GPU timer answers at the driver's rate.
struct Stat {
  bool has = false;
  double p05 = 0, p50 = 0, p95 = 0, max = 0;
  int n = 0;
};

// DIAGNOSTIC colours, not chrome: the sticker palette's veto on amber does not
// reach a debug overlay, and the three readouts agreeing is worth more here
// than any of them matching the theme.
enum class Verdict { GOOD = 0, WARN = 1, BAD = 2 };
const char* key(Verdict v);

// What the shell knows and the fold cannot: how big the buffer is, how many
// cells are in it and what is being driven. GPU cost scales with cells and
// pixels TOGETHER, so a logged number carrying neither is not comparable to any
// other logged number — which is the only reason they ride the readout at all.
struct Dims {
  int cells = 0;
  int width = 0, height = 0;
  double dpr = 1;
  std::string track;
};

struct Readout {
  // TWO RATES, because they diverge precisely when the readout is worth
  // looking at. `hz` is how often the frame loop ticked, which is the panel's
  // rate and stays flat under any load the CPU survives. `fps` counts only the
  // ticks that DREW. Equal is healthy; a gap is the GPU refusing frames, and
  // the size of the gap is how many the television never got.
  int fps = 0, hz = 0;
  // TWO CADENCES, both counted as budgets missed against `budgetMs`. `drops`
  // folds the LOOP's own gaps; `skips` folds the gaps between PRESENTS. A loop
  // ticking cleanly while presents come late is the GPU refusing frames, and
  // that separation is the whole diagnosis — neither number alone can show it.
  int skips = 0, drops = 0;
  // Whether the rate means anything yet. Judging the bar off two presents
  // paints the readout red for the first tenth of a second of every run.
  bool fpsReady = false;
  Stat cpu, gpu, frame;
  // PRESENT-TO-PRESENT, and it is NOT `frame` beside it. `frame` folds the
  // LOOP's cadence — `intervalMs`, recorded on every tick whether it drew or
  // not — and the two coincide only where a late present delays the next
  // callback, which is a property of rAF and of nothing else. A CADisplayLink
  // and a Choreographer fire every vsync whatever the last frame did, so there
  // `frame.p95` is a flat vsync period however badly the box is skipping, and
  // this is the only series that can see it. That divergence is also why the
  // readout carries `fps` AND `hz`.
  //
  // THE RENDER-SCALE RULE STEERS OFF THIS ONE (ttp/render_scale.h). It is
  // folded here rather than in each shell because two of the three kept a ring
  // of their own for exactly this question, with a percentile formula of their
  // own — and by the time this was written that formula had drifted from the
  // one above, so the p95 a television judged its resolution on was over
  // different frames than the p95 its own overlay drew.
  Stat present;
  Verdict verdict = Verdict::GOOD;
  // What ONE PRESENT was allowed, which is the operating point's budget and not
  // the panel's: `pacing`'s divisor doubles it, and it is never tighter than
  // kBudgetMs. Every share on this readout is against this number, so a bench
  // comparing two boxes at two cadences is comparing like with like.
  double budgetMs = kBudgetMs;
  bool warming = true;
};

// The ring, its trim and the warm-up filter. Held here rather than in each
// shell for the same reason the fold is: three rings meant three trim rules and
// two of them were approximations.
class Monitor {
 public:
  // Stale history is worse than none — call this whenever the thing being
  // measured changes underneath (a new scene, a resize, the readout coming
  // back on).
  void reset();
  // What the shell is AIMING AT: the panel's own present period (one vsync)
  // and the render-scale rule's divisor, "present every Nth vsync". Both are
  // facts only the shell has, and both are CHOICES rather than faults — see
  // fold() for what they buy. Unset means a 60 Hz panel presenting every
  // vsync, which is what every caller meant before this existed.
  void pacing(double panelMs, int divisor);
  void record(const Sample& s);
  Readout fold() const;
  bool warming() const { return warming_; }
  int size() const { return static_cast<int>(ring_.size()); }

 private:
  std::vector<Sample> ring_;
  int warmRun_ = 0;
  int warmSeen_ = 0;
  bool warming_ = true;
  double panelMs_ = 0;
  int divisor_ = 1;
};

// THE PROCESS'S ONE MONITOR, because there is one display and therefore one
// window of frames — with TWO readers: the readout a human looks at, and the
// render-scale rule steering off the same numbers. A second ring is how the two
// come to disagree about what the last second cost, and every shell had one
// until this existed. "One monitor per process" was a sentence in ttp_perf.h;
// this is the mechanism.
Monitor& monitor();

// The readout as ONE canonical JSON line — the bench's whole wire. A browser
// hands it back from a page hook, a television logs it, and one parser reads
// both.
std::string readoutJson(const Readout& r, const Dims& d);

}  // namespace perf
}  // namespace rt
}  // namespace ttp
