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
// The cooldowns are asymmetric: a device that is struggling should be rescued
// within a couple of seconds, and a device with headroom should be left alone
// for a good while before the picture changes under a player. Between the two
// thresholds nothing happens at all, which is where a healthy frame sits and
// where this must not oscillate — see kScaleUpShare for why the gap is exactly
// as wide as one step, and no wider.
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
// Below this, there is room to spare. DERIVED FROM THE LADDER — see
// kScaleUpShare below, which cannot be stated until the rungs are.
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
// LAP-SIZED, and that is the anti-oscillation argument's missing half. The
// share-threshold proof (kScaleUpShare) assumes the cost is STATIONARY, but a
// race frame's cost swings ~4 ms around a lap — wider than the dead band — so
// the up-decision's ~3 s evidence window taken on a cheap section never
// contains the vista it is about to climb into, and the reference Android box
// pumped 768x432..960x540 for whole races, paying a buffer reallocation hitch
// at every move. At 28 s the scale climbs at most once per lap (catalogue lap
// times run 45-75 s), so the window that qualifies the climb has seen most of
// the circuit. The cost is cosmetic: a race->lobby re-sharpen arrives in ~30 s
// instead of ~8.
inline constexpr double kScaleUpHoldSec = 28.0;
// Below this the answer is "no change": a step the eye cannot see is not worth a
// buffer reallocation, and it is what stops a scale pinned at a limit from
// re-deciding every poll.
inline constexpr double kScaleMinMove = 0.02;

// THE RUNGS, and they are SIMPLE FRACTIONS on purpose.
//
// A buffer is upscaled to the panel by the display, and a scale factor that is
// not a simple ratio blurs UNEVENLY: at 2.02x some output rows take almost one
// source row and their neighbours take a blend of two, so detail is sharp in
// bands and soft in bands, and the bands CRAWL as the camera moves. It reads as
// shimmer along every kerb and lane line, and on flat high-contrast art — thick
// ink outlines on flat colour — it is the most visible artefact there is at a
// reduced resolution. At a clean 1/2 every output pixel takes the same blend of
// the same four texels, so the softening is uniform and STILL, which the eye
// forgives; and at 2/3 and 3/4 the pattern repeats over 3 and 4 pixels rather
// than wandering.
//
// A free-running geometric step cannot land on those. Multiplying by 1.15 from
// a floor of 1/3 walks through 0.383, 0.441, 0.507, 0.583 — on a 1920x1080
// panel that is 736x414, 846x476, 973x548, 1120x630, and not one of them
// divides the panel. So the step became a rung: the rule still decides the
// DIRECTION from the measurement — down is a decisive rescue, up is a nudge, so
// a device that only just has the headroom creeps rather than jumping to a
// resolution it cannot hold and falling straight back — and the ladder decides
// where it lands.
//
// THE RUNGS ARE FRACTIONS OF THE BAND'S CEILING, NOT OF 1.0, and that
// distinction is the whole of what a scale MEANS to each shell. A TV surface is
// the panel, so its ceiling is 1.0 and the rungs read directly: on 1920x1080
// they are 640x360, 768x432, 960x540, 1152x648, 1280x720, 1440x810, 1600x900 and
// native. A BROWSER's scale is a multiplier on CSS pixels, so its ceiling is the
// device pixel ratio — 2 on a Retina Mac — and 1.0 there is HALF the panel's
// linear resolution, a quarter of its pixels.
//
// Reading the ladder as absolute cost exactly that: the web asked for a band of
// [floor, 2], every rung sat at or below 1, and the first decision the controller
// made snapped a 3443x2160 buffer down to 1721x1080 with no rung above it to
// climb back through. Against the ceiling the argument is the same one it always
// was — the buffer is a clean fraction of the surface the display upscales it to
// — and it is now true on both. The floor still clamps: a rung under it is simply
// not offered.
// EVENLY SPACED, and that is a constraint the ladder has to satisfy rather than
// a nicety: kScaleUpShare below is kScaleDownShare divided by the BIGGEST step
// on it, so one wide rung narrows the band every device has to live in. The
// first draft went 1/3, 2/5, 1/2, … — and 2/5 to 1/2 is 1.56x in pixels, which
// left so little room that the reference box stepped up, found itself over and
// stepped straight back, hunting between two rungs for the whole race. Filling
// in 3/8, 9/20, 11/20 and 9/10 takes the widest step down to 1.27x. Every one
// of them still divides 1920x1080 whole: 720x405, 864x486, 1056x594, 1728x972.
inline constexpr double kScaleLadder[] = {
    1.0 / 3.0,  3.0 / 8.0,  2.0 / 5.0,  9.0 / 20.0, 1.0 / 2.0, 11.0 / 20.0,
    3.0 / 5.0,  2.0 / 3.0,  3.0 / 4.0,  5.0 / 6.0,  9.0 / 10.0, 1.0
};
inline constexpr int kScaleLadderCount =
    (int) (sizeof(kScaleLadder) / sizeof(kScaleLadder[0]));

// The widest step on the ladder, in PIXELS — a scale is a linear factor, so a
// rung ratio squares.
inline constexpr double maxRungPixelRatio() {
  double m = 1.0;
  for (int i = 1; i < kScaleLadderCount; i++) {
    const double r = (kScaleLadder[i] * kScaleLadder[i])
                   / (kScaleLadder[i - 1] * kScaleLadder[i - 1]);
    if (r > m) m = r;
  }
  return m;
}

// BELOW THIS THERE IS ROOM TO SPARE, and it is DERIVED rather than chosen: a
// step up multiplies the fill by at most `maxRungPixelRatio`, so a threshold of
// kScaleDownShare over that ratio means a step taken from anywhere below it
// lands at most ON the down threshold — never past it. An up step can therefore
// never provoke the down step that undoes it, which is the whole
// anti-oscillation argument, and it now cannot drift out of step with the
// ladder: add a rung and this follows.
//
// IT USED TO BE A TYPED 0.50, AND THAT EXCLUDED A WHOLE CLASS OF DEVICE. A
// share of 0.50 is a statement about TOTAL cost, but a device whose cost is
// mostly FIXED cannot get its total under half a budget at any resolution — an
// Android TV box measured 8 ms of resolution-independent cost against a 16.7 ms
// budget, so even a 1x1 buffer sat at 0.48 and the rule read "no headroom" and
// left it at the softest picture the band allows, while it held a flat 60 Hz
// with 40 % of the budget spare. The threshold has to leave room for the STEP;
// it does not have to leave room for the whole frame.
inline constexpr double kScaleUpShare = kScaleDownShare / maxRungPixelRatio();

// The rung nearest `s`, as an index. Used to place a scale on the ladder before
// stepping it, so a caller that starts anywhere (a pin, a resume, the initial
// 1.0) is on a rung from its first decision.
inline int nearestRung(double s, double hi) {
  int best = 0;
  double bestD = -1.0;
  for (int i = 0; i < kScaleLadderCount; i++) {
    const double r = kScaleLadder[i] * hi;
    const double d = r > s ? r - s : s - r;
    if (bestD < 0.0 || d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// The rung `s` is already on, clamped into the band: what "no change" means
// once the scale lives on a ladder. A caller that starts anywhere — a pin, a
// resume, the initial 1.0 — lands on a rung from its very first decision.
inline double rungHold(double s, double lo, double hi);

// The rung one step in `dir` from `s`, clamped into [lo, hi]. A rung outside the
// band is skipped rather than clamped ONTO, because clamping a ladder onto an
// arbitrary limit puts the buffer back on a fraction the panel does not divide —
// which is the whole thing this exists to avoid. If no rung inside the band lies
// that way, the answer is the rung we are on.
inline double rungStep(double s, int dir, double lo, double hi) {
  const int at = nearestRung(s, hi);
  // Every rung is `fraction * hi`, so the ceiling is the top rung by construction
  // and only the floor can exclude one.
  const auto rung = [&](int i) { return kScaleLadder[i] * hi; };
  const auto inBand = [&](int i) { return rung(i) >= lo - 1e-9; };
  // `dir` is -1 or +1; 0 would make the walk below never advance, which is an
  // infinite loop with no side effects — UB, and clang turns it into a trap
  // rather than a hang. rungHold is the "stay put, but on a rung" spelling.
  if (dir != 0) {
    for (int i = at + dir; i >= 0 && i < kScaleLadderCount; i += dir) {
      if (inBand(i)) return rung(i);
    }
  }
  // Nowhere to go on the ladder. Stay where we are if that is legal, else take
  // the nearest rung that is — the band can be narrower than one rung, and a
  // degenerate band (min == max) has to keep pinning the scale.
  if (inBand(at)) return rung(at);
  for (int i = 0; i < kScaleLadderCount; i++) if (inBand(i)) return rung(i);
  return std::min(std::max(s, lo), hi);
}

inline double rungHold(double s, double lo, double hi) { return rungStep(s, 0, lo, hi); }

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

  // ONE RUNG, not a multiply — see kScaleLadder for why the landing spot has to
  // be a simple fraction of the panel. The measurement still decides the
  // DIRECTION and the thresholds still decide whether to move at all.
  double next = rungHold(now, lo, hi);   // onto the ladder, without moving
  if (gpuShareP95 > 0.0) {
    if (gpuShareP95 > kScaleDownShare && sinceChangeSec >= kScaleDownHoldSec) {
      next = rungStep(now, -1, lo, hi);
    } else if (gpuShareP95 < kScaleUpShare && sinceChangeSec >= kScaleUpHoldSec) {
      next = rungStep(now, +1, lo, hi);
    }
  } else if (latePresentRatio(cost) >= kLatePresentDown && sinceChangeSec >= kScaleDownHoldSec) {
    // DOWN ONLY on the fallback: see the header. A steady cadence here is not
    // evidence of headroom, so there is no branch that raises.
    next = rungStep(now, -1, lo, hi);
  }
  next = std::min(std::max(next, lo), hi);
  // Snap rather than creep: without this an up-step that clamps to the ceiling
  // lands a hair short of it and the next poll tries again forever.
  return (next > now - kScaleMinMove && next < now + kScaleMinMove) ? now : next;
}

}  // namespace rt
}  // namespace ttp
