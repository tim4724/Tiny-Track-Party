// Behaviour check for ttp/perf_stats.h — the frame-cost readout.
//
// Assertions rather than a corpus, like render_scale_check and for the same
// reason: the layer has no JS oracle to replay. What it pins is everything the
// three shells used to state three times — the drop arithmetic, the warm-up
// rule, the percentile formula, the two rates, and the health ladder — plus the
// two properties the bench actually rests on: that a platform with NO GPU timer
// still gets a verdict, and that "absent" is never read as "free".
#include <cstdio>
#include <string>

#include "ttp/perf_stats.h"

using ttp::rt::perf::budgetsMissed;
using ttp::rt::perf::Dims;
using ttp::rt::perf::kBudgetMs;
using ttp::rt::perf::kGoodHz;
using ttp::rt::perf::kWarmupMax;
using ttp::rt::perf::kWarmupRun;
using ttp::rt::perf::kWindow;
using ttp::rt::perf::Monitor;
using ttp::rt::perf::Readout;
using ttp::rt::perf::readoutJson;
using ttp::rt::perf::Sample;
using ttp::rt::perf::Verdict;
using ttp::rt::perf::warmupRun;

namespace {

int cases = 0, failed = 0;

// Timestamps ACCUMULATE, so a gap between two of them is never bit-identical to
// the step that built them. Every comparison against a nominal period is
// therefore a near one; a tenth of a microsecond is far under anything measured.
bool near(double a, double b) { return (a > b ? a - b : b - a) < 1e-7; }

void check(bool ok, const std::string& what) {
  cases++;
  if (!ok) {
    failed++;
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
  }
}

// A run of `n` ticks at `ms` apart, every one presented. `cpu`/`gpu` <= 0 mean
// the platform has no such number, which is the tvOS case for gpu.
Monitor run(int n, double ms, double cpu, double gpu, double startAt = 0) {
  Monitor m;
  double t = startAt;
  for (int i = 0; i < n; i++) {
    t += ms;
    Sample s;
    s.tMs = t;
    s.intervalMs = ms;
    s.presented = true;
    s.cpuMs = cpu;
    s.gpuMs = gpu;
    m.record(s);
  }
  return m;
}

// ---- the drop arithmetic -----------------------------------------------------
void drops() {
  check(budgetsMissed(kBudgetMs) == 0, "a frame on the bar misses nothing");
  check(budgetsMissed(16.9) == 0, "jitter inside one budget is not a drop");
  check(budgetsMissed(2 * kBudgetMs) == 1, "twice the budget is one missed");
  check(budgetsMissed(3 * kBudgetMs) == 2, "three times is two");
  // ROUNDED, not floored: a present lands ON a vsync, so 25 ms is one frame
  // reported late rather than 1.5 of them thrown away.
  check(budgetsMissed(25) == 1, "25 ms is one slipped frame, not 1.5 floored to 0");
  // Anything at or above the bar is free — a 144 Hz panel's 6.9 ms frame is not
  // a fraction of a drop, and a 120 Hz one's 8.3 ms is simply fine.
  check(budgetsMissed(1000.0 / 144) == 0, "a 144 Hz frame misses nothing");
  check(budgetsMissed(1000.0 / 120) == 0, "a 120 Hz frame misses nothing");
  check(budgetsMissed(4) == 0, "never negative");
  check(budgetsMissed(0) == 0, "no interval, nothing missed");
  check(budgetsMissed(16, 0) == 0, "no budget = nothing to have missed");
}

// ---- the warm-up filter ------------------------------------------------------
void warmup() {
  // The measured boot of this game: compilation and first uploads, then a clean
  // cadence. Recording any of those four holds the readout amber for a full
  // second after the game is already perfect.
  const double boot[] = {75.5, 17, 50, 58, 8.7, 8.3, 8.3, 8.3};
  int r = 0, firstKept = -1;
  for (int i = 0; i < 8; i++) {
    r = warmupRun(boot[i], r);
    if (r >= kWarmupRun && firstKept < 0) firstKept = i;
  }
  check(firstKept == 6, "all four boot frames are discarded");

  // Why a RUN and not a single frame: boot is bursty. That 17 ms frame is
  // already inside budget, so a one-frame all-clear lets the 50 and 58 behind
  // it straight into the window.
  check(warmupRun(17, 0) == 1, "17 ms misses no budget on its own...");
  check(warmupRun(50, 1) == 0, "...but the 50 ms behind it resets the run");

  // A steady cadence is warm in exactly kWarmupRun frames, whatever the panel:
  // a 50 Hz TV never "warms up" indefinitely just because it cannot reach 60.
  Monitor tv = run(4, 20, 4, -1);
  check(!tv.warming() && tv.size() == 4 - (kWarmupRun - 1),
        "a 50 Hz TV is warm in three frames and keeps the rest");

  // The backstop: a machine that never strings three together is not warming
  // up, it is slow, and must be SHOWN as slow rather than hidden forever.
  Monitor slow = run(kWarmupMax + 5, 200, 20, -1);
  check(!slow.warming() && slow.size() > 0,
        "past the backstop a slow machine is recorded, not hidden");

  // And the ring is bounded.
  Monitor many = run(kWindow * 3, 16.6667, 4, 3);
  check(many.size() == kWindow, "the ring holds exactly the window");
}

// ---- the two rates, skips and drops ------------------------------------------
void rates() {
  Monitor m;
  double t = 0;
  // 60 ticks of a clean 60 Hz second, then the readout should say 60/60.
  for (int i = 0; i < 60; i++) {
    t += kBudgetMs;
    Sample s;
    s.tMs = t; s.intervalMs = kBudgetMs; s.presented = true; s.cpuMs = 4; s.gpuMs = 3;
    m.record(s);
  }
  Readout r = m.fold();
  // EQUAL, not "both near 60". The pair is the diagnosis — a gap means the GPU
  // refused frames — so a panel that skipped nothing must not show one. Folding
  // ticks and presents over different numerators put them permanently one
  // apart, and both televisions printed that phantom gap unconditionally.
  check(r.fps == r.hz && r.fps == 60, "a clean second reads 60/60, exactly equal");
  check(r.drops == 0 && r.skips == 0, "...with nothing dropped or skipped");
  check(r.fpsReady, "sixty presents is enough to judge the bar");
  check(r.verdict == Verdict::GOOD, "...and it is healthy");

  // A GPU that refuses frames: the loop still TICKS at 60, so a tick-counting
  // rate would read a flat 60 through any number of skips. fps must not.
  Monitor sk;
  t = 0;
  for (int i = 0; i < 60; i++) {
    t += kBudgetMs;
    Sample s;
    s.tMs = t; s.intervalMs = kBudgetMs; s.presented = (i % 2) == 0;
    s.cpuMs = (i % 2) == 0 ? 4 : -1; s.gpuMs = -1;
    sk.record(s);
  }
  Readout rs = sk.fold();
  check(rs.hz >= 59 && rs.skips > 20 && rs.fps < 35,
        "the panel ticks at 60 while only half the frames DRAW — fps says so");
  check(rs.verdict == Verdict::BAD, "...and a wall of skips is not healthy");
}

// ---- pacing: a chosen cadence is not damage ---------------------------------
void pacing() {
  // A 120 Hz screen with the rule anchored on divisor 2 — the NORMAL operating
  // point there, and the state a developer's own monitor is in. Half the ticks
  // deliberately do not draw. Undeclared this reads as sixty skipped presents.
  const double kHz120 = 1000.0 / 120;
  Monitor paced;
  paced.pacing(kHz120, 2);
  double t = 0;
  for (int i = 0; i < 240; i++) {
    t += kHz120;
    Sample s;
    s.tMs = t; s.intervalMs = kHz120; s.presented = (i % 2) == 0;
    s.cpuMs = (i % 2) == 0 ? 2 : -1; s.gpuMs = (i % 2) == 0 ? 3 : -1;
    paced.record(s);
  }
  Readout p = paced.fold();
  check(p.hz >= 118 && p.fps >= 58 && p.fps <= 62,
        "120 ticks, 60 presents: the two rates say exactly that");
  check(p.skips == 0 && p.drops == 0,
        "a CHOSEN cadence is not a skipped present and not a dropped budget");
  check(p.verdict == Verdict::GOOD,
        "...so an idle 120 Hz box is GOOD, not permanently red");
  check(p.budgetMs > kBudgetMs - 1e-9 && p.budgetMs < kBudgetMs + 1e-9,
        "…and its budget is still one 60 Hz frame (2 x 8.3)");

  // The other direction: a 60 Hz panel pinned to divisor 2 is a deliberate
  // 30 fps whose DOUBLED budget the scaler spends on resolution. 20 ms of GPU
  // is 120% of a 60 Hz budget and 60% of this one.
  Monitor half;
  half.pacing(kBudgetMs, 2);
  t = 0;
  for (int i = 0; i < 120; i++) {
    t += kBudgetMs;
    Sample s;
    s.tMs = t; s.intervalMs = kBudgetMs; s.presented = (i % 2) == 0;
    s.cpuMs = (i % 2) == 0 ? 6 : -1; s.gpuMs = (i % 2) == 0 ? 20 : -1;
    half.record(s);
  }
  Readout h = half.fold();
  check(h.fps >= 28 && h.fps <= 32 && h.skips == 0,
        "a pinned 30 fps presents 30 times and skips nothing");
  check(h.budgetMs > 2 * kBudgetMs - 1e-9, "…on a doubled budget");
  check(h.verdict == Verdict::GOOD,
        "…so 20 ms of GPU is comfortable rather than over budget");

  // AND THE BAR NEVER TIGHTENS. A 144 Hz panel presenting every vsync does not
  // make a perfectly good 16.7 ms frame cost 240% of budget — that was the
  // panel-rate detector's bug and the floor is what keeps it shut.
  Monitor fast;
  fast.pacing(1000.0 / 144, 1);
  t = 0;
  for (int i = 0; i < 200; i++) {
    t += kBudgetMs;   // the LOOP runs at 60 on a 144 Hz panel
    Sample s;
    s.tMs = t; s.intervalMs = kBudgetMs; s.presented = true; s.cpuMs = 4; s.gpuMs = 8;
    fast.record(s);
  }
  Readout f = fast.fold();
  check(f.budgetMs > kBudgetMs - 1e-9 && f.budgetMs < kBudgetMs + 1e-9,
        "a 144 Hz panel does not tighten the bar below 60 Hz");
  check(f.verdict == Verdict::GOOD, "…so a 16.7 ms cadence there is still GOOD");

  // A DROP is the loop missing a vsync, and at 120 Hz that is a 16.7 ms tick.
  // Against a fixed 60 Hz denominator it would count as nothing at all.
  Monitor stall;
  stall.pacing(kHz120, 2);
  t = 0;
  for (int i = 0; i < 240; i++) {
    t += (i % 20 == 0) ? 3 * kHz120 : kHz120;
    Sample s;
    s.tMs = t; s.intervalMs = (i % 20 == 0) ? 3 * kHz120 : kHz120;
    s.presented = (i % 2) == 0; s.cpuMs = -1; s.gpuMs = -1;
    stall.record(s);
  }
  check(stall.fold().drops > 0, "a stalled LOOP still drops budgets under pacing");
}

// ---- the health ladder -------------------------------------------------------
void ladder() {
  // A platform with no GPU timer still gets a verdict, off the present
  // interval's overshoot past one budget. This is the tvOS case and it is the
  // whole reason the fallback exists.
  Monitor noTimer = run(60, kBudgetMs, 4, -1);
  Readout n = noTimer.fold();
  check(!n.gpu.has && n.frame.has, "no GPU timer is ABSENT, not zero");
  check(n.verdict == Verdict::GOOD, "...and a healthy box still reads healthy");

  // ABSENT IS NOT FREE. A monitor fed nothing but -1 costs must not come out
  // looking like a machine with all the headroom in the world.
  Monitor blind = run(60, 3 * kBudgetMs, -1, -1);
  Readout b = blind.fold();
  check(!b.cpu.has && !b.gpu.has, "absent costs stay absent");
  check(b.verdict == Verdict::BAD,
        "a box missing two budgets a frame is BAD even with no cost numbers");

  // The GPU term, where there IS a timer: p95 past a whole budget is BAD.
  Monitor hot = run(60, kBudgetMs, 4, kBudgetMs * 1.4);
  check(hot.fold().verdict == Verdict::BAD, "a GPU over budget is BAD");
  Monitor warm = run(60, kBudgetMs, 4, kBudgetMs * 0.8);
  check(warm.fold().verdict == Verdict::WARN, "a GPU at 80% of budget is WARN");
  Monitor cool = run(60, kBudgetMs, 4, kBudgetMs * 0.3);
  check(cool.fold().verdict == Verdict::GOOD, "a GPU at 30% is GOOD");

  // A 50 Hz TV that has DECLARED NOTHING is judged against 60 and sits WARN —
  // the honest answer when the monitor has not been told what the glass can do,
  // and the costs beside it still read healthy.
  Monitor pal = run(60, 20, 3, 4);
  Readout p = pal.fold();
  check(p.verdict == Verdict::WARN && p.drops == 0,
        "an UNDECLARED 50 Hz panel is WARN on rate alone, with no drops");
  // …and the same television, having said what it is, is simply healthy. This
  // is the pair that makes pacing worth having: the shell owes the fact, and
  // the fold owes the judgement.
  Monitor palDeclared;
  palDeclared.pacing(20, 1);
  double pt = 0;
  for (int i = 0; i < 60; i++) {
    pt += 20;
    Sample sm;
    sm.tMs = pt; sm.intervalMs = 20; sm.presented = true; sm.cpuMs = 3; sm.gpuMs = 4;
    palDeclared.record(sm);
  }
  Readout pd = palDeclared.fold();
  check(pd.verdict == Verdict::GOOD && pd.skips == 0 && pd.drops == 0,
        "…and a DECLARED 50 Hz panel is GOOD, not amber for being 50 Hz");

  // An empty window is not a verdict about anything.
  Monitor empty;
  Readout e = empty.fold();
  check(e.warming && e.fps == 0 && !e.cpu.has && e.verdict == Verdict::GOOD,
        "nothing measured is not a failing measurement");
}

// ---- the percentiles ---------------------------------------------------------
void percentiles() {
  Monitor m;
  // 100 frames whose gpu cost is 1..100 ms, so every percentile is readable by
  // eye and the ONE formula is pinned rather than described.
  for (int i = 1; i <= 100; i++) {
    Sample s;
    s.tMs = i * kBudgetMs; s.intervalMs = kBudgetMs; s.presented = true;
    s.cpuMs = i; s.gpuMs = i;
    m.record(s);
  }
  Readout r = m.fold();
  // The warm-up eats the first two, so the series is 3..100 (98 samples).
  check(r.gpu.n == 98 && r.gpu.max == 100, "every sample carrying a value is folded");
  check(r.gpu.p50 == 52 && r.gpu.p95 == 96 && r.gpu.p05 == 7,
        "one percentile formula: sorted[floor(n * p)]");
  check(r.cpu.p50 == r.gpu.p50, "…and the same one for every series");

  // The scale rule and the readout must fold the SAME frames — computing them
  // twice is how a shell steers its resolution off numbers its overlay
  // disagrees with.
  check(r.frame.n == 98, "the interval series is folded over the same window");
}

// ---- the present series ------------------------------------------------------
//
// THE ONE THE SCALE RULE STEERS OFF, and the whole reason it is not `frame`: on
// a display link the tick series is a flat vsync period however badly the box is
// skipping, so a shell reading `frame` there never moves at all. What is pinned
// here is that the two series SEPARATE under exactly that load.
void presents() {
  // A loop ticking cleanly at 60 Hz that only presents every third tick — a box
  // running 20 fps behind a link that fires at 60.
  Monitor m;
  for (int i = 1; i <= 120; i++) {
    Sample s;
    s.tMs = i * kBudgetMs;
    s.intervalMs = kBudgetMs;      // the LINK's cadence, unaffected by the skips
    s.presented = (i % 3) == 0;
    s.cpuMs = 4;
    s.gpuMs = -1;
    m.record(s);
  }
  const Readout r = m.fold();
  check(r.frame.has && r.frame.p95 == kBudgetMs,
        "the tick series is a flat vsync period through a skip storm");
  check(r.present.has && near(r.present.p95, 3 * kBudgetMs),
        "…and the present series is the only one that can see it");
  // The warm-up eats the first two ticks, so 3..120 are folded: 118 ticks, 40
  // of them presented, and a gap needs two presents.
  check(r.frame.n == 118 && r.present.n == 39,
        "a gap needs two presents, so n presents fold to n-1 samples");

  // ONE PRESENT IS NO CADENCE. Absent, not a fast frame — the scale rule reads
  // an absent series as "no signal" and holds, which is the safe answer.
  Monitor one;
  for (int i = 1; i <= 40; i++) {
    Sample s;
    s.tMs = i * kBudgetMs;
    s.intervalMs = kBudgetMs;
    s.presented = i == 40;
    s.cpuMs = -1;
    s.gpuMs = -1;
    one.record(s);
  }
  check(!one.fold().present.has, "one present is no cadence at all");

  // Where the loop presents every tick — a browser's rAF — the two series are
  // the same measurement, which is why the web could read `frame` and be right.
  const Readout clean = run(60, kBudgetMs, 4, 3).fold();
  check(clean.present.has && near(clean.present.p50, clean.frame.p50),
        "presenting every tick makes the two series one");
}

// ---- the line a bench reads back ---------------------------------------------
void json() {
  Monitor m = run(60, kBudgetMs, 4, 3);
  Dims d;
  d.cells = 4; d.width = 1280; d.height = 720; d.dpr = 2; d.track = "tidepool";
  const std::string s = readoutJson(m.fold(), d);
  // Canonical, so a parser can be written once. Spot-check the keys the bench
  // scripts read by name rather than the whole line, which would pin the
  // formatting of a double.
  const auto has = [&](const char* k) { return s.find(k) != std::string::npos; };
  check(s.size() > 2 && s[0] == '{' && s.back() == '}', "one JSON object");
  check(has("\"cells\":4") && has("\"width\":1280") && has("\"height\":720")
            && has("\"dpr\":2") && has("\"track\":\"tidepool\""),
        "the dims ride along — a cost without cells and pixels is not comparable");
  check(has("\"verdict\":\"good\"") && has("\"fpsReady\":true")
            && has("\"warming\":false"),
        "the verdict and the two readiness flags are on the line");
  check(has("\"gpu\":{") && has("\"p95\":"), "the folded series are on the line");
  check(has("\"present\":{"), "…including the one the scale rule steers off");

  // No GPU timer: the key is present and NULL, so a parser can tell "no signal"
  // from "a fast frame" without knowing which platform wrote the line.
  Monitor blind = run(60, kBudgetMs, 4, -1);
  const std::string b = readoutJson(blind.fold(), d);
  check(b.find("\"gpu\":null") != std::string::npos,
        "an absent series is null on the wire, never 0");
}

}  // namespace

int main() {
  std::printf("perf check:\n");
  drops();
  warmup();
  rates();
  pacing();
  ladder();
  percentiles();
  presents();
  json();
  std::printf("  %d cases, %d failures\n", cases, failed);
  return failed == 0 ? 0 : 1;
}
