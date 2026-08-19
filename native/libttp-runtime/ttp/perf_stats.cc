#include "ttp/perf_stats.h"

#include <algorithm>
#include <cmath>

namespace ttp {
namespace rt {
namespace perf {

int budgetsMissed(double intervalMs, double budgetMs) {
  if (!(budgetMs > 0) || !(intervalMs > 0)) return 0;
  const int n = static_cast<int>(std::floor(intervalMs / budgetMs + 0.5)) - 1;
  return n > 0 ? n : 0;
}

int warmupRun(double intervalMs, int run) {
  return budgetsMissed(intervalMs, kBudgetMs) == 0 ? run + 1 : 0;
}

const char* key(Verdict v) {
  switch (v) {
    case Verdict::WARN: return "warn";
    case Verdict::BAD: return "bad";
    case Verdict::GOOD: break;
  }
  return "good";
}

void Monitor::reset() {
  ring_.clear();
  warmRun_ = 0;
  warmSeen_ = 0;
  warming_ = true;
}

void Monitor::record(const Sample& s) {
  if (warming_) {
    warmRun_ = warmupRun(s.intervalMs, warmRun_);
    warmSeen_++;
    // The backstop is what stops a slow machine hiding behind "warming up"
    // forever; past it, every frame counts however bad it is.
    if (warmRun_ < kWarmupRun && warmSeen_ < kWarmupMax) return;
    warming_ = false;
  }
  ring_.push_back(s);
  if (static_cast<int>(ring_.size()) > kWindow)
    ring_.erase(ring_.begin(), ring_.end() - kWindow);
}

namespace {

// The one percentile formula, so a p95 over one series is over the same frames
// as a p95 over another.
double at(const std::vector<double>& sorted, double p) {
  const size_t i = static_cast<size_t>(std::floor(static_cast<double>(sorted.size()) * p));
  return sorted[std::min(sorted.size() - 1, i)];
}

Stat foldOne(const std::vector<Sample>& ring, double Sample::*field) {
  std::vector<double> xs;
  for (const Sample& s : ring)
    if (s.*field > 0) xs.push_back(s.*field);
  Stat st;
  if (xs.empty()) return st;
  std::sort(xs.begin(), xs.end());
  st.has = true;
  // p05 has ONE reader: the render scale's present floor wants the device's own
  // FASTEST present, and the raw minimum is not it — a pair of ticks inside one
  // vsync, or one bad timestamp, and the minimum is half the period forever.
  st.p05 = at(xs, 0.05);
  st.p50 = at(xs, 0.5);
  st.p95 = at(xs, 0.95);
  st.max = xs.back();
  st.n = static_cast<int>(xs.size());
  return st;
}

}  // namespace

Readout Monitor::fold() const {
  Readout r;
  r.warming = warming_;
  if (ring_.empty()) return r;

  r.cpu = foldOne(ring_, &Sample::cpuMs);
  r.gpu = foldOne(ring_, &Sample::gpuMs);
  r.frame = foldOne(ring_, &Sample::intervalMs);

  // The trailing second, by TIMESTAMP rather than by count: during the first
  // second the window is short, and a bare count reads as a collapsed frame
  // rate for exactly as long as it takes a human to look at it.
  const double now = ring_.back().tMs;
  size_t first = 0;
  while (first + 1 < ring_.size() && now - ring_[first].tMs > kRecentMs) first++;
  const double span = now - ring_[first].tMs;

  // THE BUDGET IS THE OPERATING POINT'S, NOT THE PANEL'S, and never tighter
  // than 60 Hz. `divisor` is "present every Nth vsync" (ttp/render_scale.h) and
  // it is a CHOICE, not a fault: at 120 Hz the rule anchors on 2 to hold 60,
  // and a shell may pin 2 on a 60 Hz panel to spend a doubled budget on
  // resolution. Scoring either as a failure painted an idle machine red
  // forever, which is the state a developer's own screen is in.
  //
  // The floor is what keeps the 144 Hz trap shut: a fast panel does not make a
  // perfectly good 16.7 ms frame cost 240% of budget. 60+ is good, and below is
  // bad, whatever the glass can do.
  const double panel = panelMs_ > 0 ? panelMs_ : kBudgetMs;
  const double presentMs = std::max(panel * divisor_, kBudgetMs);
  r.budgetMs = presentMs;

  // COUNT EVENTS AFTER THE FIRST TICK, both of them. `span` covers the gaps
  // BETWEEN the window's ticks, so the numerator has to be gaps too — counting
  // ticks against one numerator and presents against another put the two rates
  // permanently one apart, which reads as a phantom skipped frame on a panel
  // that skipped nothing. The pair is the diagnosis, so it has to be able to
  // come out equal.
  // TWO CADENCES, MEASURED THE SAME WAY. `drops` folds the LOOP's own gaps and
  // `skips` folds the gaps between PRESENTS, both against the budget one
  // present is allowed. Where they separate is the diagnosis: a loop ticking
  // cleanly while presents come late is the GPU refusing frames, which is the
  // one thing a vsync-locked cadence cannot show on its own.
  //
  // Counting presents instead ("how many should there have been?") cannot
  // survive its own window edge — over 60 gaps of an alternating cadence you
  // see 29 or 30 presents depending on where the trailing second happens to
  // start, and the missing one reads as damage forever. A GAP is a gap wherever
  // the window begins.
  size_t ticks = 0, drawn = 0;
  double lastPresent = -1;
  for (size_t i = first; i < ring_.size(); i++) {
    if (i > first) {
      ticks++;
      r.drops += budgetsMissed(ring_[i].intervalMs, presentMs);
    }
    if (!ring_[i].presented) continue;
    if (lastPresent >= 0 && i > first)
      r.skips += budgetsMissed(ring_[i].tMs - lastPresent, presentMs);
    lastPresent = ring_[i].tMs;
    if (i > first) drawn++;
  }

  if (span > 0) {
    // A RATE over the span actually sampled, not a count of what is in it:
    // during the first second the window is short, and a bare count reads as a
    // collapsed frame rate for exactly as long as it takes a human to look.
    r.hz = static_cast<int>(std::floor(ticks * kRecentMs / span + 0.5));
    r.fps = static_cast<int>(std::floor(drawn * kRecentMs / span + 0.5));
  }
  // Ten presents before the bar is judged. Same reason as the warm-up: an
  // unknown rate is not a bad one.
  r.fpsReady = drawn >= 10 && span > 0;

  // Health: the rate against the bar, dropped budgets, skipped presents, and
  // the p95 cost — the p95 is what you FEEL, the p50 is what you tune against.
  //
  // With a GPU timer the overshoot term is that timer's p95 as a share of
  // budget; without one it is the present interval's p95 PAST one budget, which
  // lands on the same scale (1.0 means the slow frames take two).
  const double over = r.gpu.has ? r.gpu.p95 / presentMs
                                : (r.frame.has ? r.frame.p95 / presentMs - 1 : 0);
  // The two rungs are RATIOS of the cadence being aimed at (0.8 and 0.95), not
  // two more constants: at 60 fps they are the 48 and 57 the three shells each
  // used to spell, and under a deliberate 30 fps pacing they follow.
  const double target = kRecentMs / presentMs;
  const double rate = r.fpsReady ? r.fps : target;
  // Skips sit on the same rungs as drops: both are a budget that went by with
  // nothing new on the panel, and a viewer cannot tell which mechanism cost
  // them the frame.
  if (r.skips > 2 || r.drops > 2 || over > 1.0 || rate < target * 0.8)
    r.verdict = Verdict::BAD;
  else if (r.skips > 0 || r.drops > 0 || over > 0.7 || rate < target * 0.95)
    r.verdict = Verdict::WARN;
  else
    r.verdict = Verdict::GOOD;
  return r;
}

void Monitor::pacing(double panelMs, int divisor) {
  panelMs_ = panelMs > 0 ? panelMs : 0;
  divisor_ = divisor > 0 ? divisor : 1;
}

namespace {

Value statVal(const Stat& s) {
  if (!s.has) return Value::Null();
  Value v = Value::Obj();
  v.set("max", Value::Num(s.max));
  v.set("n", Value::Num(s.n));
  v.set("p05", Value::Num(s.p05));
  v.set("p50", Value::Num(s.p50));
  v.set("p95", Value::Num(s.p95));
  return v;
}

}  // namespace

std::string readoutJson(const Readout& r, const Dims& d) {
  Value v = Value::Obj();
  v.set("budgetMs", Value::Num(r.budgetMs));
  v.set("cells", Value::Num(d.cells));
  v.set("cpu", statVal(r.cpu));
  v.set("dpr", Value::Num(d.dpr));
  v.set("drops", Value::Num(r.drops));
  v.set("fps", Value::Num(r.fps));
  v.set("fpsReady", Value::Bool(r.fpsReady));
  v.set("frame", statVal(r.frame));
  v.set("gpu", statVal(r.gpu));
  v.set("height", Value::Num(d.height));
  v.set("hz", Value::Num(r.hz));
  v.set("skips", Value::Num(r.skips));
  v.set("track", d.track.empty() ? Value::Null() : Value::Str(d.track));
  v.set("verdict", Value::Str(key(r.verdict)));
  v.set("warming", Value::Bool(r.warming));
  v.set("width", Value::Num(d.width));
  return canonical_stringify(v);
}

}  // namespace perf
}  // namespace rt
}  // namespace ttp
