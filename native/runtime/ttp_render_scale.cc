// The adaptive-render-scale shim: ttp_display_scale_step's body, and nothing
// else.
//
// Its own file rather than ttp_display_core.cc's, for the reason that file's
// header states in reverse — deciding a buffer size names neither a platform
// API nor the renderer, so it belongs in TTP_APP_SOURCES, where CI's
// Filament-less wasm leg link-checks the browser's call to it and every shell
// gets it whether or not its renderer is built. ttp_theme.cc is the same shape
// for the same reason.
//
// The rule is in libttp-runtime (ttp/render_scale.h), executed on every leg by
// the render_scale ctest. This is the marshalling and nothing more.

#include "ttp_display.h"

#include "ttp/render_scale.h"

extern "C" double ttp_display_scale_step(double current,
                                         double gpuShareP95, int gpuFrames,
                                         double presentP95Ms, double presentFloorMs,
                                         int presentFrames, double sinceChangeSec,
                                         double minScale, double maxScale) {
  const ttp::rt::RenderScaleCost cost{gpuShareP95, gpuFrames, presentP95Ms, presentFloorMs,
                                      presentFrames};
  return ttp::rt::renderScaleStep(current, cost, sinceChangeSec,
                                  ttp::rt::RenderScaleLimits{minScale, maxScale});
}

extern "C" double ttp_display_present_floor(double prevFloorMs, double p05Ms) {
  return ttp::rt::presentBaseline(prevFloorMs, p05Ms);
}
