// The adaptive-render-scale shim: ttp_display_step's body, and nothing
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

extern "C" int ttp_display_step(double curScale, int curDivisor,
                                double gpuP95Ms, int gpuFrames,
                                double presentP95Ms, double presentFloorMs,
                                int presentFrames, double sinceChangeSec,
                                double sinceSceneSec,
                                double prevScale, double prevCostMs,
                                double minScale, double maxScale,
                                double baseLines, double panelMs,
                                double* out2) {
  if (!out2) return 0;
  const ttp::rt::RenderScaleCost cost{gpuP95Ms, gpuFrames, presentP95Ms, presentFloorMs,
                                      presentFrames};
  const ttp::rt::RenderScalePoint p = ttp::rt::renderScaleStep(
      ttp::rt::RenderScalePoint{curScale, curDivisor}, cost, sinceChangeSec, sinceSceneSec,
      ttp::rt::RenderScaleSample{prevScale, prevCostMs},
      ttp::rt::RenderScaleLimits{minScale, maxScale, baseLines, panelMs});
  out2[0] = p.scale;
  out2[1] = (double) p.divisor;
  return 1;
}

extern "C" double ttp_display_present_floor(double prevFloorMs, double p05Ms) {
  return ttp::rt::presentBaseline(prevFloorMs, p05Ms);
}
