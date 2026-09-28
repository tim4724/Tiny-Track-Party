// ttp_perf.cc — MARSHALLING ONLY. Every judgement is in
// libttp-runtime/ttp/perf_stats.{h,cc}, where the `perf` ctest executes it on
// every leg; this file owns the scratch buffer and nothing else.
//
// THE MONITOR IS NOT THIS FILE'S. It is `perf::monitor()`, because the
// render-scale controller folds off the same window — see its header. A static
// here would have been a second one the moment that shim needed the first.
#include "ttp_perf.h"

#include <string>

#include "ttp/perf_stats.h"

namespace perf = ttp::rt::perf;

namespace {
std::string g_buf;
}  // namespace

void ttp_perf_reset(void) { perf::monitor().reset(); }

void ttp_perf_pacing(double panelMs, int divisor) {
  perf::monitor().pacing(panelMs, divisor);
}

void ttp_perf_sample(double tMs, double intervalMs, int presented,
                     double cpuMs, double gpuMs) {
  perf::Sample s;
  s.tMs = tMs;
  s.intervalMs = intervalMs;
  s.presented = presented != 0;
  s.cpuMs = cpuMs;
  s.gpuMs = gpuMs;
  perf::monitor().record(s);
}

const char* ttp_perf_readout_json(int cells, int width, int height, double dpr,
                                  const char* trackOrNull) {
  perf::Dims d;
  d.cells = cells;
  d.width = width;
  d.height = height;
  d.dpr = dpr;
  d.track = trackOrNull ? trackOrNull : "";
  g_buf = perf::readoutJson(perf::monitor().fold(), d);
  return g_buf.c_str();
}
