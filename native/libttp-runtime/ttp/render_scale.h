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
// whatever that cadence is. ABOVE the anchor rate that same arithmetic inverts,
// which is why the reference is floored at 60 (latePresentRatio) — a 120 Hz
// laptop holding a solid 60 is not a device that is late twice over. What it
// CANNOT do is prove headroom — a plateau
// looks identical at 10% and 95% load — so it may only ever step DOWN. A device
// with no timer that is running fine stays exactly where the shell started it.
//
// SHARE, not milliseconds, so the frame budget stays declared in ONE place (the
// shell that measures it) rather than being re-typed here as a second 60.
//
// IT SOLVES RATHER THAN COMPARES. Frame cost is `fixed + fill * s^2`, and no
// single "is there headroom?" threshold can serve both halves of that — see the
// cost model at RenderScaleFit, which is the heart of this file. Two
// observations at two scales determine the split, and the step is then "the
// highest rung predicted to fit the budget" rather than a comparator's nudge.
//
// The cooldowns are asymmetric anyway: a device that is struggling should be
// rescued within a couple of seconds, and a device with headroom should be left
// alone for a good while before the picture changes under a player.
#pragma once

#include <algorithm>

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
  // 16.7 on a 60 Hz TV, 8.3 on a 120 Hz one. The budget is this times whichever
  // divisor the operating point runs at, which is why the rule can trade frame
  // RATE against resolution at all; a hard-coded 60 could only ever spend a
  // 120 Hz panel's headroom on pixels. 0 or absent means "assume 60".
  double panelMs;
  // HOW MANY CELLS the surface is split into. The rule reads it for one thing
  // only: whether the FLOOR ESCAPE below the bottom rung exists (see
  // kScaleEscapeCells). It is not a shell's opinion — the grid is the frame
  // builder's — so it crosses inside C++ rather than over the ABI. 0 means
  // "not a split", which is what every caller predating the escape says — and
  // DEFAULTED here for that reason: every shell-facing caller leaves it out, so
  // requiring the brace to spell it would only buy `-Wmissing-field-initializers`
  // on twenty call sites that all meant 0.
  int cells = 0;
};

// Above this the device is LATE and retreats. The only threshold left: where to
// aim once the rule can predict is kScaleTargetShare, with the cost model.
inline constexpr double kScaleDownShare = 0.90;
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
// A SCENE'S FIRST SECONDS ARE NOT ITS COST, and on the FALLBACK path that
// distinction is permanent rather than merely wasteful.
//
// Staging a scene keeps costing after the build returns: shader compiles, first
// uploads, the shadow bake. Measured on an A10X, a SOLO race — which holds 60
// at the panel's own resolution all day — presented at 7-25 fps for the first
// ~2.6 s and was clean by 3.6 s. The late-present fallback read that as a device
// that could not hold its rung, dropped one, and then had no way back: it may
// only ever step DOWN (see the signals note at the top), so a scene's assembly
// cost became the resolution for the rest of the process.
//
// FALLBACK ONLY, and the asymmetry is the whole point. A device with a GPU timer
// that drops here climbs back out as soon as the fit says the rung fits, so the
// mistake costs it one hold; a device without one pays for the life of the
// process. What may not be undone must not be decided on frames that describe a
// scene still assembling itself.
//
// Longer than the measured tail, because the failure modes are not symmetric:
// too short is a permanent unnecessary downgrade, too long is a few seconds of
// stutter at a race start that is already the most expensive stretch of the run
// (perf-race.mjs discards its own opening GRID_MS for the same reason).
inline constexpr double kScaleSceneGraceSec = 5.0;
// LAP-SIZED, because a race frame's cost swings ~4 ms around a lap and a fit
// taken over one stretch of circuit describes that stretch. The cost model
// stops the rule climbing into a rung it cannot hold; this hold is what stops it
// climbing on EVIDENCE that only covered the cheap half of a lap. The
// up-decision's ~3 s evidence window taken on a cheap section never
// contains the vista it is about to climb into, and the reference Android box
// pumped 768x432..960x540 for whole races, paying a buffer reallocation hitch
// at every move. At 28 s the scale climbs at most once per lap (catalogue lap
// times run 45-75 s), so the window that qualifies the climb has seen most of
// the circuit. The cost is NOT cosmetic on its own, which is what the recovery
// pair below is for: a lap-sized hold times a twelve-rung ladder is a climb
// measured in MINUTES, and a scale inherited from a scene that no longer exists
// starts that climb from wherever the old scene left it.
inline constexpr double kScaleUpHoldSec = 28.0;
// A SCALE HAS NO TENURE IN A SCENE IT DID NOT SETTLE IN, and for the first
// `kScaleRecoverSec` after a build the up-hold is one evidence window instead
// of a lap. The UP hold only: a rescue is already 2.5 s, and a scene change is
// not a reason to drop a picture faster.
//
// The lobby legitimately floors the scale — the attract demo behind the boards
// is one of the heaviest pictures the game draws — and the race that follows is
// a different scene with a different cost. Without this the race inherits the
// lobby's floor and thaws ONE RUNG PER 28 SECONDS: four rungs to the race's own
// level is most of a three-lap race spent soft, and a full climb from the floor
// is over five minutes. The measurement that says so is the reference Android
// box; the browser is exposed to exactly the same arithmetic and had no shell
// mitigation at all, which is why this is the RULE's and not a shell's.
//
// WHY A WINDOW RATHER THAN "UNTIL IT SETTLES". Settling is history, and this
// function is pure — deliberately, so every leg's ctest can execute it as
// arithmetic. A window is the honest approximation: it is sized to the longest
// climb the ladder can ask for (one rung per poll, kScaleLadderCount rungs) and
// then gets out of the way. Inside it the pumping kScaleUpHoldSec exists to
// stop is possible again for a few seconds; it lands on the countdown and the
// opening straight rather than mid-race, it is bounded below by the down step
// 2.5 s behind it, and it is a far smaller cost than the whole race spent at
// the lobby's floor.
//
// One evidence window. A shell polls about once a second and the rule ignores a
// window under kMinSignalFrames, so what actually paces the climb is EVIDENCE
// arriving, not this number; it is here to say that a recovery rung needs no
// more than that. kScaleRecoverSec is derived from the ladder's own length,
// below, where the rungs are.
inline constexpr double kScaleUpRecoverHoldSec = 1.0;
// Below this the answer is "no change": a step the eye cannot see is not worth a
// buffer reallocation, and it is what stops a scale pinned at a limit from
// re-deciding every poll.
inline constexpr double kScaleMinMove = 0.02;

// THE RUNGS, IN BUFFER LINES, and they are REAL RESOLUTIONS on purpose.
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
// LINE COUNTS RATHER THAN FRACTIONS, and the two panels this ships to are why:
// against 2160 these are 1, 3/4, 1/2, 1/3 and 1/4, and against 1080 they are 1,
// 2/3 and 1/2. One list is the clean-fraction set for BOTH, so the rung a device
// lands on is a resolution with a name — 1280x720, 960x540 — rather than a
// fraction of whatever surface it happened to have. That is also what makes a
// floor mean the same thing everywhere: a fraction-of-the-ceiling ladder puts
// its bottom rung at a third of the PANEL, so "the softest picture we will
// show" was 360 lines on a 1080p surface and 720 on a 2160p one, which is not
// one decision, it is two.
//
// THE CEILING IS ALWAYS OFFERED, as an implicit top rung above these. A surface
// whose height is not on the ladder (a 1440p monitor, a browser window at any
// size at all) would otherwise cap below its own native resolution and never
// render sharp. Native is a rung on every panel; the ladder fills in below it.
//
// THE BOTTOM RUNG IS THE FLOOR. There is no separate floor constant and no
// shell may set one lower: 540 lines is the softest picture this game is
// willing to show, and a device that cannot hold its frame rate there is asking
// a different question than "how many pixels" (see the frame-rate half of that
// decision in shells/androidtv/CLAUDE.md).
inline constexpr double kScaleLadder[] = { 540.0, 720.0, 1080.0, 1620.0, 2160.0 };
inline constexpr int kScaleLadderCount =
    (int) (sizeof(kScaleLadder) / sizeof(kScaleLadder[0]));


// WHERE THE RULE AIMS, once it can predict. Under kScaleDownShare by a real
// margin: a rung whose predicted cost lands exactly on "late" is a rung the
// next expensive corner takes over it, and p95 is already the number being
// judged. The gap between the two is the whole deadband — aim at 0.85, only
// retreat above 0.90 — so a fit that wobbles inside it moves nothing.
inline constexpr double kScaleTargetShare = 0.85;

// THE COST MODEL, and the reason there is no "is there headroom?" threshold.
//
// Frame cost is `fixed + fill * s^2`: a resolution-independent half (the scene
// being submitted) and a per-pixel half. A single threshold has to serve both
// device shapes at once and CANNOT — with 1.5x rungs, a device with no fixed
// cost needs the climb threshold at or under 0.40 to keep an up step from
// provoking the down step that undoes it, while the reference Android box
// measures 0.48 of budget in FIXED cost alone and would never climb again below
// 0.48. Every constant in that range disappoints one of them, and both are real.
//
// So the rule stops comparing and starts SOLVING. Two observations at different
// scales determine `fixed` and `fill`; from there the cost of any rung is a
// prediction, and the step is "the highest rung that fits the budget" rather
// than "one rung towards wherever a comparator points". A rung is never stepped
// to unless it is predicted to hold, so oscillation is structurally gone at any
// rung width, and a mostly-fixed-cost device climbs correctly because the model
// KNOWS its fixed half instead of a constant having to guess it.
//
// This is what dynamic resolution does everywhere else, minus the part this GPU
// cannot afford: engines that render into a sub-rect of a max-size target change
// resolution for free and can re-decide every frame, so they use fine steps and
// no hysteresis at all. Here a change costs a buffer reallocation and a drain,
// which is why the rungs stay coarse and the holds stay — see kScaleUpHoldSec.
struct RenderScaleFit {
  bool ok;
  double fixedMs;   // frame cost that does not move with resolution
  double fillMs;    // cost at scale 1.0 on top of `fixedMs`
};

// The last observation at a DIFFERENT scale, held by the shell exactly as
// presentFloorMs is: it is a MEASUREMENT, and which samples may become one is
// still decided here. scale <= 0 means "none yet".
struct RenderScaleSample {
  double scale;
  double costMs;
};

// Solve for the two halves from the current observation and the previous one.
// Refuses rather than guesses: one point, two points at the same scale, or a
// fit saying more pixels cost LESS (which is noise, not a device) all answer
// `ok = false`, and the caller falls back to not climbing at all.
inline RenderScaleFit fitCost(double scale, double costMs, RenderScaleSample prev) {
  RenderScaleFit f{false, 0.0, 0.0};
  if (!(scale > 0.0) || !(costMs > 0.0)) return f;
  if (!(prev.scale > 0.0) || !(prev.costMs > 0.0)) return f;
  const double a = scale * scale, b = prev.scale * prev.scale;
  const double d = a > b ? a - b : b - a;
  if (d < 1e-6) return f;
  const double fill = (costMs - prev.costMs) / (a - b);
  if (!(fill > 0.0)) return f;
  double fixed = costMs - fill * a;
  if (fixed < 0.0) fixed = 0.0;   // all of it is fill; the fit overshot on noise
  return RenderScaleFit{true, fixed, fill};
}

// MILLISECONDS, NOT A SHARE, and that is what lets one fit serve every frame
// rate: what a frame costs the GPU does not depend on how often it is presented,
// so a rate change leaves the model valid where a share of budget would have
// been silently renormalised by it.
inline double predictMs(const RenderScaleFit& f, double scale) {
  return f.fixedMs + f.fillMs * scale * scale;
}

// Is there an observation at another scale AT ALL? Distinct from `fit.ok`, and
// the difference is what stops a device probing forever: fitCost refuses BOTH
// when nothing has been measured yet and when what was measured says cost does
// not rise with pixels. The first is missing data and is worth a probe; the
// second is EVIDENCE, and what it says is that resolution is not the lever
// here — probing on it is a climb that cannot pay and a retreat 2.5 s later,
// repeated for as long as the scene lasts.
//
// The reference Android box is that device at its floor: 1280x720 measured
// 17.1 ms and 960x540 measured 17.3, so the slope is NEGATIVE and no ladder
// step can buy anything. (Whether the timer is telling the truth that far under
// one vsync is a separate question; the rule's job is not to bet on it.)
inline bool hasPrevObservation(RenderScaleSample prev) {
  return prev.scale > 0.0 && prev.costMs > 0.0;
}

// The most operating points a surface can offer: every ladder rung that fits
// under the ceiling, the ceiling itself, and the rate step above the anchor.
// Sizes the caller's array AND the recovery window below, so the two cannot
// disagree about how long the ladder is.
// Rungs, plus the rate step above the anchor, plus the floor escape below the
// bottom rung, plus the split's sub-floor rungs above the escape.
inline constexpr int kScaleMaxPoints = kScaleLadderCount + 3
        + 3 /* kScaleSplitLadderCount — declared below the ladder it extends */;

// How long after a scene build the up-hold stays short (kScaleUpRecoverHoldSec
// has the why). DERIVED, because what it has to cover is the longest climb the
// list can ask for — bottom to top is one step short of the point count, at one
// step per evidence window — and a window shorter than that strands the last
// steps behind a lap-sized hold, which is most of the problem it exists to fix.
//
// COUNT THE OPERATING POINTS, NOT THE RUNGS. It was the rungs once, and that was
// already wrong by two the moment the list grew a ceiling entry and a rate step:
// 5 rungs read as a 4 s window while a 120 Hz panel's list needs 6 steps, so the
// top of the climb sat behind the 28 s hold on exactly the panels the rate step
// was added for.
inline constexpr double kScaleRecoverSec =
        (double) (kScaleMaxPoints - 1) * kScaleUpRecoverHoldSec;

// The rungs this surface actually offers, ascending, as SCALES: every ladder
// line count that fits the band, then the ceiling itself. Native is always the
// top rung whatever the panel — see the ladder's comment. Answers at least one
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

// Where `s` sits on the ladder: the highest rung AT OR BELOW it, as an index.
//
// DOWNWARD, never to the nearest. A scale between two rungs is a scale the
// device has not proved it can afford the upper one of, and rounding to the
// nearest would hand a struggling device MORE pixels on a poll that decided
// nothing — 0.70 on a 4K panel is nearer 1620 lines than 1080, so "hold" would
// raise the resolution. Flooring makes the ladder monotone: the picture only
// ever gets sharper through an explicit up-decision.
//
// The epsilon is not decoration. A ceiling arrives as min(dpr, 2160/height) and
// can land a hair under its own rung through float alone; a bare floor would
// read that as "between rungs" and drop a whole step off native.
//
// Below the bottom rung there is nothing to floor to, so the bottom rung is the
// answer — which is also how a scale under the band is clamped back into it.
inline int rungAtOrBelow(double s, const double* r, int n) {
  int at = 0;
  for (int i = 0; i < n; i++) if (r[i] <= s + 1e-9) at = i;
  return at;
}


// ---- the operating points ----------------------------------------------------
//
// ONE ORDERED AXIS, NOT TWO CONTROLLERS. Frame rate and resolution are both ways
// of spending the same GPU milliseconds, and a rule with a knob for each has to
// arbitrate between them every poll. Instead they are laid out as a single list
// of (resolution, present divisor) pairs from worst to best, and the rule picks
// the highest entry the cost model says fits. Stepping "up" may buy pixels or
// may buy frames; which one is decided HERE, once, by the order of the list.
//
// 1080 LINES AT 60 Hz IS THE DESIRED SPOT, and the list is built around it:
//
//   540@60   720@60   1080@60   1080@120   1620@120   2160@120
//                        ^anchor    ^ rate first, then pixels
//
// BELOW the anchor, resolution gives way and the rate does not: a party game
// steered by tilting a phone pays for a halved present rate in input latency,
// on every player, which is a worse trade than a softer picture. (The 30 Hz mode
// still exists as a deliberate floor-escape — see the Android shell — but it is
// not a rung of this ladder.)
//
// ABOVE the anchor, the rate goes first. A 120 Hz panel with the headroom to
// drive it should, and spending that headroom on pixels instead is what a fixed
// 60 Hz budget silently did: a 6 ms frame reads as 36% of 16.7 ms, the rule
// calls it headroom, climbs until the frame costs 15 ms, and the 120 Hz panel
// now presents 60. The whole reason panelMs is an input is to stop that.
inline constexpr double kAnchorLines = 1080.0;
inline constexpr double kAnchorHz = 60.0;

// THE FLOOR ESCAPE, and the cell count that gates it.
//
// Below the anchor the list buys pixels and never frames, for the reason above:
// a phone-tilt party game pays for a halved present rate in input latency, on
// every player. That holds right down to the bottom rung — and then stops,
// because a split screen can want a frame the bottom rung cannot deliver. Four
// cells cost more to SUBMIT than a whole 60 Hz budget however few pixels each
// one gets, so at the floor the box is not choosing between a locked 60 and a
// locked 30: it is choosing between a locked 30 and a 34 fps that misses a
// quarter of its slots. So ONE entry exists below the floor at half rate, and
// it is the only place in this ladder where the rate gives way first.
//
// GATED ON CELLS, NOT ON COST, and that is the whole design. Cost-gating was
// built first and had to be reverted: solo at the floor measures a gpu p95 of
// ~21 ms against a 16.7 ms budget while presenting a clean 60 with ZERO skips —
// the rare expensive frame does not land often enough to cost a slot — so the
// down-branch has ALWAYS judged solo "late" there, and only the absence of
// anywhere lower kept it. Anything placed below the floor inherits that
// misjudgement and steals the solo case. A cell count cannot: one cell never
// gets the entry, so it cannot fall into it, and when a race ends the entry
// stops existing and the controller returns to full rate with no special case.
//
// THREE rather than four, because a 3-way split is the same shape as a 4-way
// one: the grid is 2x2 with a hole, so it opens the same four cells' worth of
// per-cell cost.
inline constexpr int kScaleEscapeCells = 3;

// THE SPLIT'S SUB-FLOOR RUNGS, at the panel's own rate, offered ONLY where the
// escape is (cells >= kScaleEscapeCells) and ranked ABOVE the half-rate entry:
// below the floor, resolution now gives way BEFORE the rate does, which is the
// ladder's own principle finally applied to the one place it wasn't.
//
// MEASURED, and the measurement is why the escape stopped being the answer
// (docs/perf/androidtv-4p-plan.md, Phases 4-5): on the reference box a 4-way
// split at the floor delivers 52 fps missing 7 skips/s, while 640x360 holds a
// LOCKED 60 with zero skips — and with the four-cell masked-shadow trade
// (TtpRendererFrame's kMaskedBlobCells) 853x480 does too. The old single
// half-rate escape also proved TERMINAL: 540@30's p95 can never pass the climb
// gate back to 540@60, so a box that fell in stayed for the whole race. The
// climb OUT of the half-rate entry now lands on a strictly cheaper point
// (fewer pixels at full rate), which is what un-parks it.
//
// Solo can never fall in — same cells gate, same reasoning as the escape: at
// one cell the entries below the floor do not exist. 432 and 360 divide both
// TV panels wholly (2160/5, 2160/6); 480 is the measured prize rung and rides
// a 4/9 ratio — if its scaling ever bands visibly, drop it from this list
// before softening anything else.
inline constexpr double kScaleSplitLadder[] = {360.0, 432.0, 480.0};
inline constexpr int kScaleSplitLadderCount = 3;

struct RenderScalePoint {
  double scale;
  int divisor;    // present every Nth vsync; 1 is the panel's own rate
};

// A frame's budget at this operating point: one present interval.
inline double pointBudgetMs(const RenderScalePoint& p, RenderScaleLimits b) {
  const double panel = b.panelMs > 0.0 ? b.panelMs : 1000.0 / kAnchorHz;
  return panel * (double) p.divisor;
}

// Which divisor lands nearest the anchor rate on this panel: 1 on a 60 Hz TV, 2
// on a 120 Hz one, 2 on a 144 Hz monitor (72 Hz, the closest it can offer), 4 on
// a 240 Hz one. A 50 Hz panel in PAL mode answers 1 and runs at 50, which is the
// honest answer — a shell may not name a rate its panel cannot present.
inline int anchorDivisor(RenderScaleLimits b) {
  const double panel = b.panelMs > 0.0 ? b.panelMs : 1000.0 / kAnchorHz;
  const double hz = 1000.0 / panel;
  int d = (int) (hz / kAnchorHz + 0.5);
  return d < 1 ? 1 : d;
}

// The list, ascending. At most one entry per rung plus one for the rate step.
inline int operatingPoints(RenderScaleLimits b, RenderScalePoint* out) {
  double r[kScaleMaxPoints];
  const int n = rungScales(b, r);
  const int base = anchorDivisor(b);
  const int fast = base > 1 ? base - 1 : 1;   // == base where there is no faster rate
  const double anchor = kAnchorLines / (b.baseLines > 0.0 ? b.baseLines : kAnchorLines);
  int m = 0;
  // The escape sits below everything, at the bottom rung's own pixels — the
  // backstop for a box that cannot hold 60 at ANY resolution. Above it, the
  // split's sub-floor rungs spend resolution before rate (their comment has
  // the measurements); dominance ordering holds (pointAtOrBelow): the
  // half-rate entry is worse than every full-rate one above it.
  if (b.cells >= kScaleEscapeCells && n > 0) {
    out[m++] = RenderScalePoint{r[0], base * 2};
    if (b.baseLines > 0.0) {
      for (int i = 0; i < kScaleSplitLadderCount; i++) {
        const double s = kScaleSplitLadder[i] / b.baseLines;
        if (s < r[0] - 1e-9 && s >= b.min - 1e-9) {
          out[m++] = RenderScalePoint{s, base};
        }
      }
    }
  }
  for (int i = 0; i < n; i++) {
    if (r[i] <= anchor + 1e-9) out[m++] = RenderScalePoint{r[i], base};
  }
  // The rate step sits directly above the anchor — but only where the anchor is
  // actually reachable on this surface. A window too short to show 1080 lines is
  // never "above the desired spot", so it never buys frames it cannot fill.
  if (fast != base && m > 0 && out[m - 1].scale >= anchor - 1e-9) {
    out[m++] = RenderScalePoint{anchor, fast};
  }
  for (int i = 0; i < n; i++) {
    if (r[i] > anchor + 1e-9) out[m++] = RenderScalePoint{r[i], fast};
  }
  return m;
}

// Where `p` sits in the list: the highest entry at or below it, by the same
// downward rule the rungs use on their own (see rungAtOrBelow).
inline int pointAtOrBelow(RenderScalePoint p, const RenderScalePoint* l, int n) {
  int at = 0;
  for (int i = 0; i < n; i++) {
    if (l[i].scale <= p.scale + 1e-9 && l[i].divisor >= p.divisor) at = i;
  }
  return at;
}

// The best entry whose PREDICTED cost fits its own budget, searched downward
// from `from`. The rescue's landing spot, and the ceiling on any climb.
inline int pointForBudget(int from, const RenderScaleFit& f,
                          const RenderScalePoint* l, int n, RenderScaleLimits b) {
  for (int i = from; i >= 0; i--) {
    if (predictMs(f, l[i].scale) <= kScaleTargetShare * pointBudgetMs(l[i], b)) return i;
  }
  return 0;
}

// What the last window of frames cost, as the shell measured it. RAW: every
// judgement about whether a number here means anything is made below, so that a
// second shell hands over its measurements rather than its opinions.
struct RenderScaleCost {
  // p95 GPU time in MILLISECONDS, straight off the backend's timer, and how many
  // frames carried a result. <= 0 where there is no timer. Deliberately not a
  // share of budget: the budget is what this layer decides when it picks a
  // present rate, so a share handed in would be normalised against a rate nobody
  // had chosen. It is also what makes the cost model survive a rate change.
  double gpuP95Ms;
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
  // …AND NEVER TIGHTER THAN THE ANCHOR RATE. This is the 144 Hz trap, and it is
  // the exact one perf_stats.cc closed for the readout ("a fast panel does not
  // make a perfectly good 16.7 ms frame cost 240% of budget") while the rule
  // beside it kept dividing by the raw floor.
  //
  // The note at the top of this file argues the fastest present is the right
  // reference because it costs nothing on a 50 Hz panel or a 30 Hz HDMI mode.
  // That is true and it only covers panels SLOWER than the anchor; above it the
  // same arithmetic inverts. A 120 Hz laptop holding a solid 60 has a floor of
  // 8.3 and a p95 of 16.7, which is a ratio of 2.0 — "a whole period late", every
  // window, forever. Measured on the artifact: 2160 lines to 1080 in nine
  // seconds, on a machine doing nothing wrong. And this is the arm that may only
  // step DOWN, so it never comes back.
  //
  // 60 fps IS the bar, so a device presenting at it is not late whatever its
  // glass could theoretically do. Only the FALLBACK reads this; a device with a
  // GPU timer prices the anchor properly through pointBudgetMs and never comes
  // here.
  //
  // kAnchorHz AND NOT perf_stats.h's kGoodHz, which is the same 60 — deliberately,
  // and the two are worth keeping apart until something forces the question. This
  // header is the pure rule: it includes <algorithm> and nothing else, which is
  // what lets every leg's ctest execute it as arithmetic, and perf_stats.h drags
  // in <string>, <vector> and canonical.h. The rate the LADDER is anchored on and
  // the bar a READOUT scores against are also two questions, even where one
  // number answers both. If they ever have to move together, extract the 60 —
  // do not make the rule depend on the readout to get it.
  const double bar = std::max(cost.presentFloorMs, 1000.0 / kAnchorHz);
  return cost.presentP95Ms / bar;
}

// IS THE DEVICE ACTUALLY DELIVERING, at the rate this point asks for?
//
// This is the veto the GPU model answers to, and it exists because a GPU
// millisecond is not a fixed quantity. A governor that downclocks whenever a
// frame leaves idle makes the SAME work measure dearer the healthier the frame
// is, and a p95 collects exactly the windows where the clock had not ramped —
// so a device comfortably holding its rate can price its own frame at 90% of
// budget and be asked to retreat from a rung it is demonstrably presenting at.
// Measured on an Apple TV 4K: 4 players at native, GPU p95 over the down
// threshold, presenting 60/60 with zero skips, and the rule stepping it down a
// rung it did not need to give up.
//
// AGAINST THE POINT'S OWN BUDGET, never against latePresentRatio. That ratio is
// the FALLBACK's signal and is measured against the panel's fastest present, so
// it reads a perfectly healthy 30 Hz point as "a whole period late" — see its
// own note on the 120 Hz trap, which is the same arithmetic one rung along. A
// rule that has chosen a divisor has to judge cadence against the rate it chose.
//
// kLatePresentDown IS the bar, deliberately reused rather than given a
// companion constant: it already means "on cadence, or a whole period late, and
// nothing lands between them".
//
// Too few frames is NOT clean — that is "not enough to say", and silence is not
// evidence.
inline bool presentsOnCadence(const RenderScaleCost& cost, double budgetMs) {
  if (cost.presentFrames < kMinSignalFrames) return false;
  if (!(cost.presentP95Ms > 0.0) || !(budgetMs > 0.0)) return false;
  return cost.presentP95Ms < kLatePresentDown * budgetMs;
}

// The next OPERATING POINT — resolution and present divisor together — given
// where we are and what the last window of frames cost.
//
// `cost.gpuP95Ms` is RAW MILLISECONDS now, not a share. A share is already an
// opinion about the budget, and the budget is exactly what this function decides
// by choosing a divisor; a shell handing one over would be renormalising the
// measurement against a rate nobody had picked yet.
//
// `sinceChangeSec` is how long the current point has been in force;
// `sinceSceneSec` how long the current SCENE has. Both are measurements a shell
// already holds, and neither is an opinion: which hold each is judged against is
// decided here (kScaleUpRecoverHoldSec).
//
// With no signal at all the answer is the current point, clamped — which is also
// the answer while a hold is still running.
inline RenderScalePoint renderScaleStep(RenderScalePoint current,
                                        const RenderScaleCost& cost,
                                        double sinceChangeSec, double sinceSceneSec,
                                        RenderScaleSample prev,
                                        RenderScaleLimits limits) {
  RenderScalePoint list[kScaleMaxPoints];
  const int n = operatingPoints(limits, list);
  if (n <= 0) return current;

  const double clamped = std::min(std::max(current.scale, limits.min), limits.max);
  int at = pointAtOrBelow(RenderScalePoint{clamped, current.divisor}, list, n);
  const double gpuMs = cost.gpuFrames >= kMinSignalFrames ? cost.gpuP95Ms : 0.0;

  // A scale inherited from a scene that no longer exists has no tenure in this
  // one, so the climb back to THIS scene's level runs at one evidence window
  // per step rather than one lap per step.
  const double upHold = sinceSceneSec < kScaleRecoverSec
          ? kScaleUpRecoverHoldSec : kScaleUpHoldSec;
  const RenderScaleFit fit = fitCost(clamped, gpuMs, prev);
  int to = at;

  if (gpuMs > 0.0) {
    const double budget = pointBudgetMs(list[at], limits);
    if (gpuMs > kScaleDownShare * budget && sinceChangeSec >= kScaleDownHoldSec
        && !presentsOnCadence(cost, budget)) {
      // LATE, so retreat — and the MEASUREMENT outranks the model. Without a fit
      // it is one step; with one it is straight to a point predicted to hold,
      // but never nowhere: a model that says the current point is fine while the
      // device is demonstrably late is a model that is wrong.
      //
      // AND THE SAME SENTENCE IN REVERSE (presentsOnCadence): a model that says
      // this point is late while the device is demonstrably DELIVERING is also
      // wrong, and it is wrong in the direction that costs a rung. The veto is
      // on the retreat only — a clean record is evidence about the point we are
      // AT, not about the one above, so the climb stays the model's decision.
      // What it gives up is at most one evidence window of prediction: a device
      // that really is about to miss shows it in the presents within a window,
      // and this arm can climb back out of a retreat it takes late.
      to = fit.ok ? pointForBudget(at, fit, list, n, limits) : at - 1;
      if (to >= at) to = at - 1;
    } else if (sinceChangeSec >= upHold && at + 1 < n
               && list[at].divisor > list[at + 1].divisor
               && list[at + 1].scale < list[at].scale - 1e-9) {
      // THE ESCAPE'S EXIT IS A PROBE BY RIGHT — the second one-way door, and
      // the same disease the pure-rate arm below cures. Parked at the
      // half-rate backstop, no other branch can ever fire: the fit needs two
      // scales and a parked point only ever measures one, the no-data probe
      // is blocked by a same-scale observation that can never become a fit,
      // and the raw share gate compares THIS point's measurement against the
      // next point's budget — a measurement that is itself a downclocked
      // PACED span (a half-rate point leaves the GPU idle between presents,
      // and this backend's timer reads the pace — the saturation trap, from
      // the ledger). Measured on the reference box: the backstop read 14.57
      // against a 14.20 gate while the sub-floor rung above it demonstrably
      // held a locked 60. So the one climb that is out of a rate-trade into
      // STRICTLY FEWER PIXELS at full rate is taken on tenure alone: a wrong
      // probe is retreated within one evidence window on real present
      // evidence, so a hopeless box pays one bad window per up-hold — the
      // bounded cost every probe in this file already accepts. Only the
      // backstop -> first sub-floor rung transition matches the guard (the
      // rate step above the anchor moves at EQUAL pixels and keeps its own
      // arithmetic arm below).
      to = at + 1;
    } else if (!fit.ok && !hasPrevObservation(prev) && sinceChangeSec >= upHold) {
      // NOTHING MEASURED AT ANOTHER SCALE YET, so PROBE. A model needs two
      // scales to exist and a scale only moves when something asks it to, so
      // refusing to climb with no data is a deadlock: the scene changes, the
      // shell drops the previous observation (a fit across two scenes measures a
      // slope belonging to neither), and nothing would ever move again.
      //
      // ONLY WHEN THERE IS NO OBSERVATION — see hasPrevObservation. A refused
      // FIT is not missing data, it is data saying pixels are not the cost, and
      // probing on it pumps between two rungs for the life of the scene.
      //
      // A PROBE MAY NOT GUESS AT THE RATE. A guess that halves the present
      // interval is one a player feels in the steering rather than sees in the
      // picture, so a rate step bought with pixels is only ever taken on a model.
      //
      // A PURE RATE STEP IS NOT A GUESS, and barring it made the anchor a trap.
      // The entry above the anchor holds the SAME pixels at half the present
      // interval, so the millisecond measured here IS what it costs there and
      // only the budget changes — arithmetic, not a model, which is why this arm
      // may take it while the one below may not. Without it the step was
      // ONE-WAY: falling across it is a same-scale move, so the controller
      // records no observation (render_scale_controller.cc), a scene build
      // clears whatever one it had, and nothing could raise the rate again —
      // no fit to climb on, and the only branch that can move without a fit
      // refusing to. Measured in a browser on a 120 Hz laptop: a lobby heavy
      // enough to walk the point down to 1080@60, then every race after it
      // pinned there with the GPU at 15% of a 16.7 ms budget, for the life of
      // the page. The floor escape is the same shape one rung the other way.
      //
      // It cannot pump: the climb needs kScaleTargetShare of the budget above
      // and the retreat needs kScaleDownShare of the same budget, so the two
      // are the ordinary deadband apart.
      if (at + 1 < n
          && (list[at + 1].divisor == list[at].divisor
              || (list[at + 1].scale <= list[at].scale + 1e-9
                  && gpuMs <= kScaleTargetShare * pointBudgetMs(list[at + 1], limits)))) {
        to = at + 1;
      }
    } else if (fit.ok && sinceChangeSec >= upHold) {
      // CLIMB ONLY INTO A POINT THE MODEL SAYS FITS. This is the whole of the
      // anti-oscillation argument, and it holds at any step width: the step is
      // never taken unless the cost it will land at is predicted under the
      // target of ITS OWN budget — which is what makes the rate step and the
      // resolution step comparable at all.
      //
      // ONE STEP, not straight to the best that fits: the fit is taken over a
      // window that saw one stretch of a lap, and cost swings ~4 ms around a
      // circuit. One step keeps a cheap-section fit from buying three.
      if (at + 1 < n
          && predictMs(fit, list[at + 1].scale)
                 <= kScaleTargetShare * pointBudgetMs(list[at + 1], limits)) {
        to = at + 1;
      }
    }
  } else if (latePresentRatio(cost) >= kLatePresentDown && sinceChangeSec >= kScaleDownHoldSec
             && sinceSceneSec >= kScaleSceneGraceSec) {
    // DOWN ONLY on the fallback: a steady cadence is not evidence of headroom,
    // and a device with no GPU timer has no milliseconds to fit a model from
    // either, so there is no branch that raises. It also may not change the
    // rate, for the probe's reason — this path cannot predict what that buys.
    //
    // AND NOT WHILE THE SCENE IS STILL ASSEMBLING (kScaleSceneGraceSec): a step
    // taken here is one this path can never take back, so it may not be taken on
    // shader compiles and first uploads. The GPU-timer arm above has no such
    // guard because it can climb back out.
    if (at > 0 && list[at - 1].divisor == list[at].divisor) to = at - 1;
  }

  if (to < 0) to = 0;
  if (to >= n) to = n - 1;
  RenderScalePoint next = list[to];
  // Snap rather than creep: without this a step that lands a hair short of a
  // limit re-decides every poll forever.
  if (next.divisor == current.divisor
      && next.scale > clamped - kScaleMinMove && next.scale < clamped + kScaleMinMove) {
    return RenderScalePoint{clamped, current.divisor};
  }
  return next;
}

}  // namespace rt
}  // namespace ttp
