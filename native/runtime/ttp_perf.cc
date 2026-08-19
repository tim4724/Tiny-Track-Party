// ttp_perf.cc — MARSHALLING ONLY. Every judgement is in
// libttp-runtime/ttp/perf_stats.{h,cc}, where the `perf` ctest executes it on
// every leg; this file owns the process's one monitor and its scratch buffer.
#include "ttp_perf.h"

#include <string>

#include "ttp/perf_stats.h"

namespace perf = ttp::rt::perf;

namespace {
perf::Monitor g_monitor;
std::string g_buf;
}  // namespace

void ttp_perf_reset(void) { g_monitor.reset(); }

void ttp_perf_pacing(double panelMs, int divisor) {
  g_monitor.pacing(panelMs, divisor);
}

void ttp_perf_sample(double tMs, double intervalMs, int presented,
                     double cpuMs, double gpuMs) {
  perf::Sample s;
  s.tMs = tMs;
  s.intervalMs = intervalMs;
  s.presented = presented != 0;
  s.cpuMs = cpuMs;
  s.gpuMs = gpuMs;
  g_monitor.record(s);
}

const char* ttp_perf_readout_json(int cells, int width, int height, double dpr,
                                  const char* trackOrNull) {
  perf::Dims d;
  d.cells = cells;
  d.width = width;
  d.height = height;
  d.dpr = dpr;
  d.track = trackOrNull ? trackOrNull : "";
  g_buf = perf::readoutJson(g_monitor.fold(), d);
  return g_buf.c_str();
}
