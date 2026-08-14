// render_scale — how big the drawing buffer should be, decided from what the
// last second of frames actually cost.
//
// The alternative was a constant, and a constant cannot be right: capped at
// 1080 lines a 4K TV renders a quarter of its panel and the edges read as
// pixelated, while uncapped the weakest TV browser this game runs on has four
// times the fill it can afford. So the shell measures and this decides — start
// at the surface's own resolution, step DOWN whenever a device proves it cannot
// hold the budget, and back UP only where the measurement can prove there is
// headroom to climb into.
//
// TWO SIGNALS, AND THEY ARE NOT EQUALS.
//
// The good one is GPU SHARE OF BUDGET, from a timer query wrapped around the
// frame. It is the only measurement on the web that can see HEADROOM, which is
// what raising the resolution needs: the rAF cadence is a vsync plateau, so
// 60 fps is equally true at 10% and at 95% load. Where it exists, this decides
// in both directions.
//
// The fallback is LATE PRESENTS — the p95 frame interval over the device's own
// FASTEST present (presentBaseline + latePresentRatio below). It exists because
// EXT_disjoint_timer_query_webgl2 is not everywhere (WebKit does not expose it,
// and TV browsers vary), and a shell without it would otherwise be stuck at a
// constant forever. Measured against the device's own fastest present rather
// than against 60 Hz, it costs nothing on a 50 Hz panel or a 30 Hz HDMI mode:
// those present at their own steady cadence, and a ratio of 1 is a ratio of 1
// whatever that cadence is. What it CANNOT do is prove headroom — a plateau
// looks identical at 10% and 95% load — so it may only ever step DOWN. A device
// with no timer that is running fine stays exactly where the shell started it.
//
// SHARE, not milliseconds, so the frame budget stays declared in ONE place (the
// shell that measures it) rather than being re-typed here as a second 60.
//
// The thresholds are deliberately far apart and the cooldowns asymmetric: a
// device that is struggling should be rescued within a couple of seconds, and a
// device with headroom should be left alone for a good while before the picture
// changes under a player. Between 0.5 and 0.9 nothing happens at all, which is
// where a healthy frame sits and where this must not oscillate.
#pragma once

#include <algorithm>

namespace ttp {
namespace rt {

// The band the caller allows, as scale factors on its surface's layout size.
// Both come from the shell, because both are facts about ITS surface: the
// ceiling is the panel's own resolution (and whatever pixel budget the shell
// caps that at), the floor is the softest picture it is willing to show.
struct RenderScaleLimits {
  double min;
  double max;
};

// Fractions of the frame budget the p95 GPU cost is judged against.
inline constexpr double kScaleDownShare = 0.90;  // above this, the device is late
inline constexpr double kScaleUpShare = 0.50;    // below this, there is room to spare
// The fallback's threshold, as a multiple of the device's own fastest present.
// 1.5 sits between the two things a vsync-locked present can be: on cadence, or
// a whole period late. Nothing lands between them, so the exact value only has
// to avoid jitter at the edges.
inline constexpr double kLatePresentDown = 1.5;
// A percentile over a handful of frames is not a percentile. Both signals are
// ignored until the shell has this many, which also covers the moment after a
// resize, when the window has deliberately been thrown away.
inline constexpr int kMinSignalFrames = 30;
// Faster than this is not a present, it is two rAF callbacks landing inside one
// vsync (or one bad timestamp). Taking it as the panel's period would make every
// ordinary frame look four times late, so it is rejected outright.
inline constexpr double kMinPresentMs = 4.0;
// Seconds a scale must hold before it may move again. Falling is a rescue;
// rising is a luxury, and the picture changing under a player is the cost of it.
inline constexpr double kScaleDownHoldSec = 2.5;
inline constexpr double kScaleUpHoldSec = 8.0;
// One step. Down is decisive (0.8 in scale is 0.64 in pixels, a real rescue);
// up is a nudge, so a device that only just has the headroom creeps rather than
// jumping to a resolution it cannot hold and falling straight back.
inline constexpr double kScaleDownFactor = 0.80;
inline constexpr double kScaleUpFactor = 1.15;
// Below this the answer is "no change": a step the eye cannot see is not worth a
// buffer reallocation, and it is what stops a scale pinned at a limit from
// re-deciding every poll.
inline constexpr double kScaleMinMove = 0.02;

// What the last window of frames cost, as the shell measured it. RAW: every
// judgement about whether a number here means anything is made below, so that a
// second shell hands over its measurements rather than its opinions.
struct RenderScaleCost {
  // p95 GPU time as a fraction of the frame budget (1.0 = the whole budget),
  // and how many frames carried a GPU result. <= 0 where there is no timer.
  double gpuShareP95;
  int gpuFrames;
  // p95 frame interval and how many frames it was taken over, plus the fastest
  // present seen SO FAR — presentBaseline's running answer, which the shell
  // stores and hands back (see it for why the caller keeps that one number).
  double presentP95Ms;
  double presentFloorMs;
  int presentFrames;
};

// The device's own fastest present, folded one window at a time. The shell keeps
// the running value and passes it back in; it is a MEASUREMENT, not a decision,
// which is why it is the one piece of state that lives out there.
//
// It has to outlive the stats window, and that is the whole subtlety of the
// fallback signal. A ratio taken inside one window is blind to the case it
// exists for: a device slow enough that EVERY frame in the window is slow has a
// p05 equal to its p95, reads as a perfectly steady cadence, and never adapts.
// Kept across windows, the cheap screens (a welcome board, a lobby) are where an
// honest vsync period gets learned. It also survives a resolution change, since
// the panel's period does not depend on what we draw at.
inline double presentBaseline(double prevFloorMs, double p05Ms) {
  if (!(p05Ms >= kMinPresentMs)) return prevFloorMs;
  return (prevFloorMs >= kMinPresentMs && prevFloorMs < p05Ms) ? prevFloorMs : p05Ms;
}

// How late this device is running, as a multiple of its own fastest present:
// 1.0 is every frame on cadence, 2.0 is a whole period late. 0 when there is not
// enough to say — which is what a caller passes on to renderScaleStep as "no
// signal", so the two agree without the shell knowing the rule.
inline double latePresentRatio(const RenderScaleCost& cost) {
  if (cost.presentFrames < kMinSignalFrames) return 0.0;
  if (!(cost.presentFloorMs >= kMinPresentMs) || !(cost.presentP95Ms > 0.0)) return 0.0;
  return cost.presentP95Ms / cost.presentFloorMs;
}

// The next scale, given where we are and what the last window of frames cost.
// `sinceChangeSec` is how long the current scale has been in force.
//
// With no signal at all the answer is the current scale, clamped — which is
// also the answer while a hold is still running.
inline double renderScaleStep(double current, const RenderScaleCost& cost,
                              double sinceChangeSec, RenderScaleLimits limits) {
  const double lo = limits.min;
  const double hi = limits.max;
  const double now = std::min(std::max(current, lo), hi);
  const double gpuShareP95 = cost.gpuFrames >= kMinSignalFrames ? cost.gpuShareP95 : 0.0;

  double next = now;
  if (gpuShareP95 > 0.0) {
    if (gpuShareP95 > kScaleDownShare && sinceChangeSec >= kScaleDownHoldSec) {
      next = now * kScaleDownFactor;
    } else if (gpuShareP95 < kScaleUpShare && sinceChangeSec >= kScaleUpHoldSec) {
      next = now * kScaleUpFactor;
    }
  } else if (latePresentRatio(cost) >= kLatePresentDown && sinceChangeSec >= kScaleDownHoldSec) {
    // DOWN ONLY on the fallback: see the header. A steady cadence here is not
    // evidence of headroom, so there is no branch that raises.
    next = now * kScaleDownFactor;
  }
  next = std::min(std::max(next, lo), hi);
  // Snap rather than creep: without this an up-step that clamps to the ceiling
  // lands a hair short of it and the next poll tries again forever.
  return (next > now - kScaleMinMove && next < now + kScaleMinMove) ? now : next;
}

}  // namespace rt
}  // namespace ttp
