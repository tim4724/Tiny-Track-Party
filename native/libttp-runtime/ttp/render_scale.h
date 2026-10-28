// render_scale — how big the drawing buffer should be, decided from the frames
// the panel actually got.
//
// The alternative was a constant, and a constant cannot be right: capped at
// 1080 lines a 4K TV renders a quarter of its panel and the edges read as
// pixelated, while uncapped the weakest TV browser this game runs on has four
// times the fill it can afford. So the shell measures and this decides.
//
// ONE SIGNAL: LATE PRESENTS. A present that lands a vsync (or more) after the
// one it was due on is the only cost a player sees, and the one measurement
// every platform has, a browser without a GPU timer included. A GPU timer was
// the signal once and was given up: a DVFS GPU prices the same frame dearer the
// healthier it is (docs/perf/androidtv-frame-map.md, "The resolution rule").
//
// A MOVE IS ITSELF A HITCH. Every resolution change reallocates the buffer —
// on the Android box it recreates the swap chain, ~54 ms and one to three
// skipped frames — so the rule steps down only on sustained lateness, climbs
// only on a long clean run, and does not try a rung it lost again for a while.
#pragma once

#include <algorithm>
#include <cmath>

namespace ttp {
namespace rt {

// What the caller's surface is, as facts the shell alone can know.
//
// `min`/`max` are scale factors on the surface's layout size: the ceiling is the
// panel's own resolution (and whatever pixel budget the shell caps that at). A
// shell that wants no extra narrowing passes min 0 — THE LADDER OWNS THE FLOOR
// (kScaleLadder), so a floor here can only narrow the band further, never reach
// below the bottom rung.
//
// `baseLines` is how many BUFFER LINES a scale of 1.0 means on this surface —
// the SurfaceView's height on a TV, the container's CSS height in a browser.
// The rungs are line counts, so this is what turns one into a scale, and it is
// the whole of what makes a rung mean the same picture on both.
struct RenderScaleLimits {
  double min;
  double max;
  double baseLines;
  // The panel's OWN present period in milliseconds — one vsync, not one frame.
  // 16.7 on a 60 Hz TV, 8.3 on a 120 Hz one. A frame is due every `panelMs`
  // times the operating point's divisor — 1 at the panel's own rate, 2 at the
  // host's half rate — so a 120 Hz panel is held at 120 with pixels. 0 or
  // absent means "assume 60".
  double panelMs;
  // THE ONE INPUT THAT IS NOT A FACT ABOUT THE SURFACE: the host asked for the
  // sharper picture at half the panel's rate (the phone's "Sharp" option). The
  // rule never chooses it — see the operating points — and a shell never sets
  // it either; RenderScaleController holds the choice and fills it in.
  bool halfRate = false;
};

// ---- the moves ---------------------------------------------------------------
//
// EVERYTHING IS COUNTED IN LATE PRESENTS: a present that landed a vsync or
// more after the one it was due on, at the point's own period. Presents, not
// missed vsyncs: one frame frozen for 300 ms on a 120 Hz Mac is 36 missed
// vsyncs but ONE late present — a hiccup (a system overlay, a collection, a
// tab next door) that fewer pixels would not shorten — while a rung that
// cannot hold is late on present after present. Counted as vsyncs, a Mac's
// brightness keys walked Chrome down a rung a press.
//
// THE WINDOW the rule steps down on is the last kJudgeSec judged seconds at
// the current point, one entry per poll. A move or a scene build empties it.
inline constexpr int kJudgeSec = 10;
// STEP DOWN once the window holds this much late picture — fifteen presents at
// 60 Hz, thirty at 120. Measured on the reference Android box over whole races
// at 1080 lines: two players were late at most 4 times in any 10 s pinned, one
// and three players 40-46 times in their heavy stretches, and four players'
// periodic vista seconds (9-16 late each, between near-clean ones) sum past it
// where no streak of bad seconds ever forms. So it tolerates the stray late
// frame a rung that holds still has, and a rung that cannot hold crosses it
// within its first seconds.
inline constexpr double kDownLateMs = 250.0;
// …AND ONLY ONCE THE NEWEST kDownMinSec SECONDS WERE ALL LATE (not clean, in
// cleanSecond's terms): lateness that has lasted, and is still going on. One
// second at a quarter rate was enough for the count by itself; and a burst
// that has ended is still in the window, and stepped the rung below a second
// time for frames it never drew. A move ends the run, so a burst of outside
// load steps at most once per kDownMinSec of it, not once a second.
inline constexpr int kDownMinSec = 3;

// The window's step-down count at a point due every `dueMs`.
inline int downLateFrames(double dueMs) {
  return dueMs > 0.0 ? std::max(1, (int) std::lround(kDownLateMs / dueMs)) : 1;
}

// STEP UP one rung after kUpSec CLEAN seconds in a row, into a rung that is not
// barred. A clean second is late on at most kCleanLateShare of the vsyncs it
// spanned — one a second at 60 Hz, two at 120 — and never zero, because a
// browser at 120 Hz does not reliably give a second without a stray, nor a
// 50 Hz TV at its half rate of 25 (where the share rounds to none). The run
// is long because a climb taken on a cheap stretch of a lap meets the heavy
// one later, and that is two hitches for nothing.
inline constexpr double kCleanLateShare = 1.0 / 60.0;
inline constexpr int kUpSec = 15;

inline bool cleanSecond(int vsyncs, int late) {
  return late <= std::max(1, (int) std::lround(vsyncs * kCleanLateShare));
}

// A RUNG LOST: entered by a climb or by a scene's placement, and left by a
// step down within kTrySec, about a lap. It is BARRED at that player count for
// kBarSec, and so is every rung of as many lines or more, on any surface: a
// browser window that loses its 1818-line ceiling cannot hold 2160 in
// fullscreen either. The bar is clocked from the loss, so it runs through
// scene builds (a cup is the same players race after race), and it spans
// about a cup: four players who cannot hold 1080 try it once a cup, not once
// a race.
//
// Two kinds of rung are never lost. One entered by a step down was passed
// through, not tried: barred, a few seconds of outside load walked a page to
// the floor and held every rung above it for the bar. And one that stood
// kTrySec and then went late met a lap's heavy stretch or something outside
// the game; the climb back may try it as soon as it is clean.
inline constexpr double kTrySec = 30.0;
inline constexpr double kBarSec = 300.0;

// THE DECISION: where the point sits on its list (`at` of `n`), the late
// presents in the window against the count that steps down, the runs of late
// and of clean seconds at the point, and whether the rung above is barred.
// Answers the index to move to — `at` for "stay".
inline int renderScaleRung(int at, int n, int late, int downLate, int lateRun,
                           int cleanRun, bool aboveBarred) {
  if (late >= downLate && lateRun >= kDownMinSec) return std::max(at - 1, 0);
  if (cleanRun >= kUpSec && !aboveBarred && at + 1 < n) return at + 1;
  return at;
}

// A SCENE'S FIRST SECONDS ARE NOT ITS COST, so nothing in them is judged.
// Staging keeps costing after the build returns — shader compiles, first
// uploads, the shadow bake — and on an A10X a solo race that holds 60 at
// native all day presented at 7-25 fps for its first ~2.6 s.
inline constexpr double kScaleSceneGraceSec = 5.0;
// …AND A RESIZE'S FIRST SECONDS ARE NOT THE RUNG'S EITHER. A browser window
// entering or leaving fullscreen stalls the page while it reallocates the
// canvas and lays the page out again, a cost the rung did not cause.
inline constexpr double kScaleResizeGraceSec = 3.0;

// Below this the answer is "no change": a step the eye cannot see is not worth a
// buffer reallocation, and it is what stops a scale pinned at a limit from
// re-deciding every poll.
inline constexpr double kScaleMinMove = 0.02;

// ---- the rungs ---------------------------------------------------------------
//
// THE RUNGS, IN BUFFER LINES, and they are REAL RESOLUTIONS on purpose.
//
// A buffer is upscaled to the panel by the display, and a scale factor that is
// not a simple ratio blurs UNEVENLY: at 2.02x some output rows take almost one
// source row and their neighbours take a blend of two, so detail is sharp in
// bands and soft in bands, and the bands CRAWL as the camera moves. It reads as
// shimmer along every kerb and lane line, and on flat high-contrast art it is
// the most visible artefact there is at a reduced resolution. At a clean 1/2
// every output pixel takes the same blend of the same four texels, so the
// softening is uniform and STILL, which the eye forgives; and at 2/3 and 3/4
// the pattern repeats over 3 and 4 pixels rather than wandering.
//
// LINE COUNTS RATHER THAN FRACTIONS, and the two panels this ships to are why:
// against 2160 these are 1, 3/4, 1/2, 1/3 and 1/4, and against 1080 they are 1,
// 2/3 and 1/2. One list is the clean-fraction set for BOTH, so the rung a device
// lands on is a resolution with a name — 1280x720, 960x540 — rather than a
// fraction of whatever surface it happened to have, and the floor means the
// same picture everywhere.
//
// THE CEILING IS ALWAYS OFFERED, as an implicit top rung above these. A surface
// whose height is not on the ladder (a 1440p monitor, a browser window at any
// size at all) would otherwise cap below its own native resolution and never
// render sharp.
//
// THE BOTTOM RUNG IS THE FLOOR, at every cell count. There is no separate floor
// constant and no shell may set one lower: 540 lines is the softest picture
// this game is willing to show, and a device that cannot hold its frame rate
// there MISSES FRAMES there rather than going softer or slower. Below it, every
// point buys the frames back with something worse: a softer picture than the
// game will show, or a halved rate that doubles the picture latency of every
// player steering by tilt.
inline constexpr double kScaleLadder[] = { 540.0, 720.0, 1080.0, 1620.0, 2160.0 };
inline constexpr int kScaleLadderCount =
    (int) (sizeof(kScaleLadder) / sizeof(kScaleLadder[0]));

// The rungs this surface actually offers, ascending, as SCALES: every ladder
// line count that fits the band, then the ceiling itself. Answers at least one
// (the ceiling), so a caller may index [0] without checking.
inline int rungScales(RenderScaleLimits b, double* out) {
  int n = 0;
  if (b.baseLines > 0.0) {
    for (int i = 0; i < kScaleLadderCount; i++) {
      const double s = kScaleLadder[i] / b.baseLines;
      // Strictly below the ceiling: it is about to be appended as the top rung,
      // and a surface whose height IS a ladder entry must not offer it twice.
      if (s >= b.min - 1e-9 && s < b.max - 1e-9) out[n++] = s;
    }
  }
  out[n++] = b.max;
  return n;
}

// ---- the operating points ----------------------------------------------------
//
// ONE ORDERED AXIS: the list is (resolution, present divisor) pairs from worst
// to best, and the rule moves along it.
//
// THE RATE IS THE PANEL'S OWN, AND ONLY PIXELS GIVE WAY. A 120 Hz panel is held
// at 120 by giving up pixels, which keeps every vsync's worth of picture
// latency off a party steered by tilting phones. (`debug.ttp.hz` can still pin
// 30 Hz on the Android shell, as a measurement knob.)
//
// THE RULE NEVER MOVES THE RATE — decided 2026-10-15, after it did: pacing to
// every Nth vsync on the rule's own judgement needed the panel period read
// right, the web learns it from rAF stamps, and one misread window paced a
// healthy race to every third vsync for the life of the page.
//
// THE HOST MAY HALVE THE RATE, and only the host: `halfRate` lays the SAME
// ladder out at divisor 2 — 30 on a 60 Hz panel, 25 on a 50 Hz one, 60 on a
// 120 Hz one — and the rule then moves along it exactly as at full rate.
// 1080 LINES IS THE ANCHOR: where a rate flip lands, and the bar under which
// the host is offered the choice (belowAnchor).
inline constexpr double kAnchorLines = 1080.0;
// The panel rate assumed where none is known.
inline constexpr double kDefaultPanelHz = 60.0;

// The most operating points a surface can offer: every ladder rung that fits
// under the ceiling, and the ceiling itself. Sizes the caller's array.
inline constexpr int kScaleMaxPoints = kScaleLadderCount + 1;

struct RenderScalePoint {
  double scale;
  int divisor;    // present every Nth vsync; 1 is the panel's own rate
};

// The present period this point is due at: one vsync times its divisor.
inline double pointPeriodMs(const RenderScalePoint& p, RenderScaleLimits b) {
  const double panel = b.panelMs > 0.0 ? b.panelMs : 1000.0 / kDefaultPanelHz;
  return panel * (double) p.divisor;
}

// The anchor's 1080 lines as a scale of this surface.
inline double anchorScale(RenderScaleLimits b) {
  return kAnchorLines / (b.baseLines > 0.0 ? b.baseLines : kAnchorLines);
}

// The list, ascending: one entry per rung, all at the one divisor.
inline int operatingPoints(RenderScaleLimits b, RenderScalePoint* out) {
  double r[kScaleMaxPoints];
  const int n = rungScales(b, r);
  const int divisor = b.halfRate ? 2 : 1;
  for (int i = 0; i < n; i++) out[i] = RenderScalePoint{r[i], divisor};
  return n;
}

// Is `p` below the anchor — 1080 lines, or the ceiling where the surface is
// shorter than that? A device that has settled there cannot hold the desired
// picture, and it is the only kind the half-rate choice is offered to
// (RenderScaleController::offersHalfRate).
inline bool belowAnchor(RenderScalePoint p, RenderScaleLimits b) {
  double r[kScaleMaxPoints];
  const int n = rungScales(b, r);
  const double anchor = anchorScale(b);
  double top = 0.0;
  for (int i = 0; i < n; i++) {
    if (r[i] <= anchor + 1e-9) top = r[i];
  }
  return p.scale < top - 1e-9;
}

// Where `p` sits in the list: the highest entry AT OR BELOW it, as an index.
//
// DOWNWARD, never to the nearest. A scale between two rungs is a scale the
// device has not proved it can afford the upper one of, so rounding to the
// nearest would hand it MORE pixels on a poll that decided nothing. The epsilon
// is not decoration: a ceiling arrives as min(dpr, 2160/height) and can land a
// hair under its own rung through float alone. Below the bottom entry the
// bottom entry is the answer, which is also how a scale under the band is
// clamped back into it.
inline int pointAtOrBelow(RenderScalePoint p, const RenderScalePoint* l, int n) {
  int at = 0;
  for (int i = 0; i < n; i++) {
    if (l[i].scale <= p.scale + 1e-9) at = i;
  }
  return at;
}

// The entry a host's rate flip lands on: the anchor, or the ceiling under it.
// A step down takes seconds and a step up most of a minute, so the new rate's
// rung is found from above, where a boot starts too.
inline int anchorPoint(const RenderScalePoint* l, int n, RenderScaleLimits b) {
  const double anchor = anchorScale(b);
  int at = 0;
  for (int i = 1; i < n; i++) {
    if (l[i].scale <= anchor + 1e-9) at = i;
  }
  return at;
}

// ---- the learned panel period ------------------------------------------------
//
// Faster than this is not a present, it is two rAF callbacks landing inside one
// vsync (or one bad timestamp). Taking it as the panel's period would make every
// ordinary frame look four times late, so it is rejected outright.
inline constexpr double kMinPresentMs = 4.0;

// The device's own fastest present, folded one window at a time, for a shell
// that cannot declare its panel period (a browser has no API for it).
// RenderScaleController keeps the running value and passes it back in. It
// outlives the stats window so the cheap screens (a welcome board, a lobby) are
// where an honest vsync period gets learned, and it survives a resolution
// change, since the panel's period does not depend on what we draw at.
//
// `windowMs` is one window's figure for its cadence — the controller hands over
// the tick series' MEDIAN, and render_scale_controller.cc says why not its p05.
inline double presentBaseline(double prevFloorMs, double windowMs) {
  if (!(windowMs >= kMinPresentMs)) return prevFloorMs;
  return (prevFloorMs >= kMinPresentMs && prevFloorMs < windowMs) ? prevFloorMs : windowMs;
}

}  // namespace rt
}  // namespace ttp
