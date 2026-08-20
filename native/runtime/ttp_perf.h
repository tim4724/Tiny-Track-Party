/* ttp_perf.h — the frame-cost readout, shared by the three shells.
 *
 * WHAT IS BEHIND IT: libttp-runtime/ttp/perf_stats.{h,cc}, executed on every
 * leg by the `perf` ctest. This header is how a SHELL reaches it, and the
 * split is the same one render_scale draws: a shell hands over MEASUREMENTS —
 * its own clocks, its own profile buffer, whatever GPU timer its backend has —
 * and this decides what they mean. A shell that computes a percentile or picks
 * a colour has taken a decision that must not differ between platforms, and the
 * three hand-written copies this replaces had already drifted apart.
 *
 * WHY IT IS AN ABI AND NOT THREE HUDS. The bench compares a browser, an Apple
 * TV and an Android box on the same race. That comparison is worth nothing
 * unless "60 fps", "2 drops" and "amber" are the same statements on all three,
 * and a comment saying they are is not a mechanism.
 *
 * ONE MONITOR PER PROCESS, because there is one display. No handle.
 */
#ifndef TTP_PERF_H
#define TTP_PERF_H

#include "ttp_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Drop the window. Stale history is worse than none, so call this whenever what
 * is being measured changes underneath: a new scene, a resize, a benched run
 * starting. */
TTP_ABI void ttp_perf_reset(void);

/* What the shell is AIMING AT: the panel's own present period in milliseconds
 * (ONE vsync: 16.7 on a 60 Hz TV, 8.3 on a 120 Hz one; 0 means assume 60) and
 * the render-scale rule's divisor, "present every Nth vsync" (0 or 1 = every
 * one).
 *
 * WITHOUT IT A PACED BOX READS RED FOREVER, which is the state a developer's
 * own 120 Hz screen is in: the rule anchors on divisor 2 there to hold 60, so
 * half the ticks deliberately do not draw, and a readout that cannot tell a
 * chosen cadence from a missed one scores every one of them as damage. The
 * budget follows the divisor and is never tighter than 60 Hz.
 *
 * Declare it whenever either moves. Both are facts only the shell has. */
TTP_ABI void ttp_perf_pacing(double panelMs, int divisor);

/* One tick of the frame loop, drawn or not.
 *
 *   tMs         when the tick happened, on any monotonic clock the shell likes
 *               (only differences are read).
 *   intervalMs  elapsed since the previous tick — the CADENCE, not the nominal
 *               refresh: a missed vsync is exactly what this is here to show.
 *   presented   did this tick put a new picture on the panel. On a platform
 *               whose frame call cannot refuse, pass 1 always.
 *   cpuMs       ttp_display_profile()'s `total` for this frame, or <= 0.
 *   gpuMs       a timer query wrapped around ttp_display_frame, or <= 0.
 *
 * <= 0 means ABSENT, and absent is not zero: a platform with no GPU timer has
 * no signal, not a free frame. Drop the cpu sample on a skip rather than
 * repeating it — the renderer returns before writing its total, so the profile
 * still holds the last DRAWN frame.
 *
 * Warm-up is filtered HERE (perf_stats.h says why), so the first frames of a
 * run are discarded rather than reported. */
TTP_ABI void ttp_perf_sample(double tMs, double intervalMs, int presented,
                             double cpuMs, double gpuMs);

/* The whole readout as ONE canonical JSON line — what the overlay draws AND
 * what a bench parses, deliberately the same bytes so a screenshot and a
 * logged number cannot disagree.
 *
 *   {"budgetMs","cells","cpu","dpr","drops","fps","fpsReady","frame","gpu",
 *    "height","hz","present","skips","track","verdict","warming","width"}
 *
 * THE SCALE RULE READS THIS, and there is ONE window rather than four: the
 * render-scale controller folds its percentiles off this same monitor, so a
 * shell cannot steer its resolution off numbers its own overlay disagrees with.
 * That is why `ttp_perf_sample` must be fed on EVERY tick and not only while an
 * overlay is up — the readout is drawn on demand, but the window behind it is
 * always being kept.
 *
 * `budgetMs` is what ONE PRESENT was allowed — the operating point's, per
 * ttp_perf_pacing, never tighter than 60 Hz — and every share on the line is
 * against it. `drops` counts budgets the LOOP missed, `skips` budgets a PRESENT
 * missed; a clean loop with late presents is the GPU refusing frames.
 *
 * `cpu`/`gpu`/`frame`/`present` are each {"max","n","p05","p50","p95"} or null.
 * `frame` is the LOOP's tick cadence and `present` the gaps between frames that
 * actually reached the panel; they are one series on rAF and two on a display
 * link, which is the same split `hz` and `fps` carry. `verdict`
 * is "good" | "warn" | "bad". `cells` and the buffer size ride along because
 * GPU cost scales with cells and pixels TOGETHER: a logged number carrying
 * neither is not comparable to any other logged number.
 *
 * `trackOrNull` is what is being driven, for a sweep that spans a catalogue. */
TTP_ABI const char* ttp_perf_readout_json(int cells, int width, int height,
                                          double dpr, const char* trackOrNull);

#ifdef __cplusplus
}
#endif

#endif /* TTP_PERF_H */
