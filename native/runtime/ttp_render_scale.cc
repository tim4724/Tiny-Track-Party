// The adaptive-render-scale shim: three small bodies over
// ttp/render_scale_controller.h, and nothing else.
//
// Its own file rather than ttp_display_core.cc's, for the reason that file's
// header states in reverse — deciding a buffer size names neither a platform
// API nor the renderer, so it belongs in TTP_APP_SOURCES, where CI's
// Filament-less wasm leg link-checks the browser's call to it and every shell
// gets it whether or not its renderer is built. ttp_theme.cc is the same shape
// for the same reason.
//
// The rule is in libttp-runtime (ttp/render_scale.h) and the state around it in
// ttp/render_scale_controller.h, both executed on every leg by the
// `render_scale` ctest. This is the marshalling and nothing more.

#include "ttp_display.h"

#include "ttp/render_scale_controller.h"

namespace {
ttp::rt::RenderScaleController& ctl() { return ttp::rt::renderScale(); }
}  // namespace

extern "C" void ttp_display_scale_scene(double tMs) {
  ctl().scene(tMs);
}

extern "C" int ttp_display_scale_poll(double tMs, double minScale, double maxScale,
                                      double baseLines, double panelMs, double* out2) {
  if (!out2) return 0;
  ttp::rt::RenderScalePoint p{0.0, 0};
  // THE MONITOR IS THE READOUT'S (perf::monitor()). One window, two readers —
  // see ttp_perf.h.
  if (!ctl().poll(tMs, ttp::rt::RenderScaleLimits{minScale, maxScale, baseLines, panelMs},
                  ttp::rt::perf::monitor(), &p)) {
    return 0;
  }
  out2[0] = p.scale;
  out2[1] = (double) p.divisor;
  return 1;
}

extern "C" double ttp_display_scale_panel_ms(void) {
  return ctl().panelMs();
}
