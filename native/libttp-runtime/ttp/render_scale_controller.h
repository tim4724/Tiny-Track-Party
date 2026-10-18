// render_scale_controller — the STATE around ttp/render_scale.h's rule.
//
// The rule itself is pure and stays pure: frames missed, seconds judged, how
// long the rung has stood and the wait in force go in, one rung comes out. What
// is left over is the BOOKKEEPING — the missed frames per second, the running
// present floor, when the rung was entered, the rung and the failures each
// player count left this session — and it was once written three times, once
// per shell, in three languages, under comments that pointed at each other.
//
// None of it is platform. A poll cadence is not an Android fact; which frames
// count is not a Swift one. The three copies had already drifted where it is
// cheapest to drift and hardest to see, so a television judged its own
// resolution on different frames than the ones its overlay drew.
//
// WHAT A SHELL STILL OWES, and it is now only this: keep feeding
// ttp_perf_sample (which it already did), say when a scene was built, name the
// band and the panel period, and PERFORM the answer. Everything between those
// is here.
//
// THE MONITOR IS THE READOUT'S. There is one per process (perf::monitor()) and
// this drains its present gaps, so the frames steering the resolution are the
// frames a human is looking at. Presents, not ticks — see perf_stats.h's
// Readout::present for why.
#pragma once

#include "ttp/perf_stats.h"
#include "ttp/render_scale.h"

namespace ttp {
namespace rt {

// How often the point is re-decided. The rule's waits are seconds long, so this
// only has to be fast enough to catch the load changing — a race starting
// behind a lobby, a fourth player joining — within about a second of it
// happening. All three shells spelled this number, and the two TV ones spelled
// it in units of their own clocks.
//
// It is also the rule's unit of time: each poll judges the frames presented
// since the last one, and the window is kJudgeSec of those.
inline constexpr double kScalePollMs = 1000.0;

// How long the display must stay below the anchor before the host is offered
// half rate (offersHalfRate) — long enough that one late window is not the
// verdict, short enough that the lobby offers it before a race has started.
inline constexpr double kHalfRateOfferSec = 10.0;

// The most split-screen cells a scene draws; 0 is the overview (the lobby).
inline constexpr int kMaxCells = 4;

class RenderScaleController {
 public:
  // The point in force. 1.0 is the surface's own size; nothing here ever
  // supersamples, because the ceiling is the band's and the band is the
  // shell's. NOT ON THE ABI — a shell's own copy is the buffer it actually
  // sized, which is a record of what it performed rather than a second opinion
  // about what to do. This is here for the ctest, which has no shell.
  RenderScalePoint point() const { return point_; }

  // The panel's present period the rule is being judged against: what the shell
  // declared, or — where it declared nothing — what the TICK series has taught
  // us. A shell hands this to ttp_perf_pacing so the readout's budget is the
  // operating point's rather than a guessed 60 Hz.
  //
  // THE TICK SERIES, NOT THE PRESENT ONE, and the divisor is why. Every one of
  // the three loops ticks at the panel's own rate whether or not the frame drew
  // — that is what makes `hz` a different number from `fps` — so ticks are
  // where a panel period can be learned, while presents run at whatever cadence
  // the host most recently CHOSE. Learning the period off presents would read
  // the host's half rate as a 60 Hz panel and price every frame against double
  // the budget.
  double panelMs() const { return panelMs_; }

  // A NEW SCENE. Empties the judged window (the last scene's frames are another
  // picture) and starts the scene's grace, inside which nothing missed is
  // judged (kScaleSceneGraceSec). The scene is then PLACED once its cell count
  // is known (cells()): on the rung that count last held this session — a cup
  // is one session, four players race after race — or, for a count not seen
  // yet that draws more cells than the scene before it, one rung below where
  // that scene left off. The lobby holds 1080 that four players cannot; this
  // is what keeps the first race of a cup from finding that out on its grid.
  // The monitor itself is the shell's to drop, with ttp_perf_reset, for the
  // reason ttp_perf.h names.
  void scene(double tMs);

  // How many split-screen cells the frame draws (0: the overview), reported by
  // the display core every frame. Read once per scene, inside its grace — a
  // shell may name its cells just after the build — and never after: a seat
  // dropping mid-race does not re-place the scene.
  void cells(int n) { cells_ = n; }

  // Re-decide, at most once per kScalePollMs. Answers whether the point MOVED,
  // and writes the new one to `out`.
  //
  // `tMs` is any monotonic clock the shell likes; only differences are read.
  // `limits` is the band and the panel period — the surface's own facts, and
  // the only things here a shell is entitled to an opinion about. Pass
  // `panelMs` 0 to have it learned (see panelMs() above).
  //
  // ON A MOVE THE WINDOW GOES, judged and monitor alike, here rather than in
  // three shells: it describes the OLD buffer, and keeping it judges the new
  // resolution on the old one's frames — which is how a controller talks itself
  // into a second step it does not need.
  bool poll(double tMs, RenderScaleLimits limits, perf::Monitor& mon,
            RenderScalePoint* out);

  // THE HOST'S RATE CHOICE (render_scale.h, `halfRate`), restored by the shell
  // at boot and flipped from the host phone. The next poll performs it as a
  // move of its own, landing on the anchor at the other rate (anchorPoint).
  void setHalfRate(bool on) { halfRate_ = on; }
  bool halfRate() const { return halfRate_; }

  // WHETHER THE HOST PHONE SHOWS THE CHOICE. Only a device that cannot hold
  // the anchor gets it: one that has stayed below it (belowAnchor) for
  // kHalfRateOfferSec, in the lobby as much as in a race — and from then on
  // for the life of the process, so the option never appears and vanishes
  // between races. Always while half rate is on, so it can be switched back.
  bool offersHalfRate() const { return offered_ || halfRate_; }

  // The present rate each choice means on this panel, for the phone's labels:
  // 60 and 30 on a 60 Hz TV, 50 and 25 on a 50 Hz one, 120 and 60 on a 120 Hz
  // panel.
  int rateHz(bool half) const;

 private:
  // Put `p` in force: the window it was judged on goes with the old buffer.
  bool moveTo(RenderScalePoint p, perf::Monitor& mon, RenderScalePoint* out);

  // 1.0 until the first poll ADOPTS THE BAND'S CEILING. "As sharp as this
  // surface allows" is a fact only the band knows, and a 1.0 left standing here
  // is wrong twice on any HiDPI browser (max 2): the shell sizes its buffer from
  // the ceiling before a frame exists, and a first step down from 1.0 would
  // halve a canvas drawn at 2.0 that nobody asked it to touch. Both TV shells
  // have a ceiling of 1.0 and see no difference.
  RenderScalePoint point_{1.0, 1};
  bool adopted_ = false;
  double floorMs_ = 0;     // presentBaseline's running answer
  double panelMs_ = 0;
  // Frames missed per judged second, newest at `judged_ - 1` of a ring
  // starting at `head_`; at most kJudgeSec of them, the current rung's only.
  int missed_[kJudgeSec] = {};
  int judged_ = 0;
  int head_ = 0;
  // When the current rung was entered — by a move or by a scene build.
  double enteredMs_ = 0;
  // PER CELL COUNT, for the session: the scale each count's last scene left
  // off at (0: never seen), and how often each rung (by its index in the point
  // list) has failed at that count. What four players failed says nothing
  // about the lobby, and the lobby holding 1080 must not clear it. The host's
  // half rate keeps the same indices: a rung four players failed at 60 is
  // taken as failed at 30 too, until it holds.
  double rungOf_[kMaxCells + 1] = {};
  int fails_[kMaxCells + 1][kScaleMaxPoints] = {};
  // What the frame last reported, and the count this scene was placed for (-1:
  // not yet); the count the scene before it was placed for.
  int cells_ = -1;
  int sceneCells_ = -1;
  int prevCells_ = -1;
  // The best scale this scene has stood on, and that of the scene before it: a
  // new count is placed a rung below the latter, so a lobby that dipped on its own
  // boot does not drag the first race down to the floor.
  double sceneTop_ = 0;
  double prevTop_ = 0;
  double sceneMs_ = 0;
  double lastPollMs_ = 0;
  bool halfRate_ = false;
  bool offered_ = false;
  double belowMs_ = -1.0;    // when it last fell below the anchor, -1 while not
};

// THE PROCESS'S ONE CONTROLLER, for the reason perf::monitor() is one: there is
// one display, so there is one operating point.
RenderScaleController& renderScale();

}  // namespace rt
}  // namespace ttp
