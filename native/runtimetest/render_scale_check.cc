// Behaviour check for the adaptive render scale: ttp/render_scale.h, the pure
// rule, and ttp/render_scale_controller.h, the state around it.
//
// Assertions rather than a corpus, like progression_check and frame_check: the
// layer has no JS oracle, so this file is where its rules are pinned — what
// counts as a missed frame, how many step down, what a climb waits for, how a
// failed climb backs off, the band, the floor and the host's half rate.
//
// The point of the file is that the rule does not MOVE much. Every move is a
// buffer reallocation the player sees, so a controller that steps on one bad
// second, or tries a rung it just failed every few seconds, is a flicker no
// screenshot shows.
#include <cstdio>

#include <algorithm>
#include <cmath>

#include "ttp/render_scale.h"
#include "ttp/render_scale_controller.h"

using ttp::rt::RenderScaleController;
using ttp::rt::presentBaseline;
using ttp::rt::RenderScaleLimits;
using ttp::rt::operatingPoints;
using ttp::rt::pointPeriodMs;
using ttp::rt::RenderScalePoint;
using ttp::rt::renderScaleRung;
using ttp::rt::upWaitSec;
using ttp::rt::belowAnchor;
using ttp::rt::kScaleMaxPoints;
using ttp::rt::kJudgeSec;
using ttp::rt::kDownMissed;
using ttp::rt::kUpWaitSec;
using ttp::rt::kMaxFails;
using ttp::rt::pointAtOrBelow;
using ttp::rt::rungScales;

namespace {

int cases = 0, failed = 0;

void check(bool ok, const char* what) {
  cases++;
  if (!ok) {
    failed++;
    std::fprintf(stderr, "FAIL %s\n", what);
  }
}

void nearly(double got, double want, const char* what) {
  check(got > want - 1e-9 && got < want + 1e-9, what);
}

// A 4K panel at devicePixelRatio 1: a scale of 1.0 is its own 2160 lines, and
// no shell floor narrows it, so what it offers is the whole ladder — 540, 720,
// 1080, 1620 and native.
constexpr double kHz60 = 1000.0 / 60.0;
constexpr double kHz120 = 1000.0 / 120.0;
constexpr RenderScaleLimits k4K{0.0, 1.0, 2160.0, kHz60};
// The same ladder seen by a 1080p TV, where only three rungs fit under native.
constexpr RenderScaleLimits kHD{0.0, 1.0, 1080.0, kHz60};
// A 4K panel that can present 120.
constexpr RenderScaleLimits k4K120{0.0, 1.0, 2160.0, kHz120};

}  // namespace

int main() {
  // ---- the present baseline: which samples may become the device's cadence ---
  nearly(presentBaseline(0.0, 16.7), 16.7, "the first usable median becomes the baseline");
  nearly(presentBaseline(16.7, 33.4), 16.7, "a slower window does not raise it");
  nearly(presentBaseline(16.7, 8.3), 8.3, "a faster one does lower it");
  nearly(presentBaseline(16.7, 2.0), 16.7,
         "a sub-4ms 'present' is two rAFs in one vsync and is rejected");
  nearly(presentBaseline(0.0, 2.0), 0.0, "…even when there is no baseline yet");
  nearly(presentBaseline(20.0, 20.0), 20.0, "a 50 Hz panel settles on its own 20 ms period");

  // ---- the decision ----------------------------------------------------------
  {
    const int n = 5;
    check(renderScaleRung(3, n, kDownMissed, 1, 0.0, kUpWaitSec) == 2,
          "kDownMissed frames missed in the window step down one rung");
    check(renderScaleRung(3, n, kDownMissed - 1, kJudgeSec, 999.0, kUpWaitSec) == 3,
          "…and one fewer holds: a rung that holds still has the stray skip");
    check(renderScaleRung(0, n, 100, kJudgeSec, 999.0, kUpWaitSec) == 0,
          "nothing steps below the bottom rung");
    check(renderScaleRung(2, n, 0, kJudgeSec, kUpWaitSec, kUpWaitSec) == 3,
          "a full clean window past the wait steps up one rung");
    check(renderScaleRung(2, n, 1, kJudgeSec, 999.0, kUpWaitSec) == 2,
          "…but one missed frame in it does not");
    check(renderScaleRung(2, n, 0, kJudgeSec - 1, 999.0, kUpWaitSec) == 2,
          "…nor a window not yet full");
    check(renderScaleRung(2, n, 0, kJudgeSec, kUpWaitSec - 0.1, kUpWaitSec) == 2,
          "…nor a rung entered too recently");
    check(renderScaleRung(n - 1, n, 0, kJudgeSec, 999.0, kUpWaitSec) == n - 1,
          "nothing climbs past the ceiling");
    nearly(upWaitSec(0), kUpWaitSec, "an unfailed rung waits kUpWaitSec");
    nearly(upWaitSec(1), 2.0 * kUpWaitSec, "each failure doubles it");
    nearly(upWaitSec(kMaxFails + 5), kUpWaitSec * (1 << kMaxFails), "…up to kMaxFails doublings");
  }

  // ---- the RUNGS -----------------------------------------------------------
  // Line counts, so the same rung is the same picture on any panel, and the
  // bottom one is the floor everywhere rather than a fraction of the ceiling.
  {
    double r[8];
    check(rungScales(kHD, r) == 3, "a 1080p surface offers three rungs");
    nearly(r[0], 540.0 / 1080.0, "…the lowest being 540 lines");
    check(rungScales(k4K, r) == 5, "a 4K surface offers five");
    nearly(r[0] * 2160.0, 540.0, "…and ITS lowest is also 540 lines");
    // The ceiling is always the top rung, so a panel the ladder does not name
    // still reaches its own native resolution.
    const RenderScaleLimits qhd{0.0, 1.0, 1440.0, kHz60};
    const int n = rungScales(qhd, r);
    nearly(r[n - 1], 1.0, "native is offered on a panel the ladder does not name");
    check(n == 4, "…above the three ladder rungs that fit under it");
    // A browser window: 909 CSS px at devicePixelRatio 2 is an 1818-line surface.
    // Capping it at 1620 would be the WORSE picture — a 1.122 upscale, the uneven
    // kind that crawls — so the ceiling itself is the top rung.
    const RenderScaleLimits web{0.0, 2.0, 909.0, kHz60};
    double w[16];
    const int m = rungScales(web, w);
    nearly(w[m - 1] * 909.0, 1818.0, "the top rung on a browser window is its own native size");
    nearly(w[m - 2] * 909.0, 1620.0, "with the highest ladder value below it");
  }
  // Placement is DOWNWARD, never to the nearest: rounding up would hand a
  // struggling device more pixels on a poll that decided nothing.
  {
    RenderScalePoint l[8];
    const int n = operatingPoints(k4K, l);
    nearly(l[pointAtOrBelow(RenderScalePoint{0.70, 1}, l, n)].scale, 1080.0 / 2160.0,
           "a scale between rungs places on the one at or below it");
    nearly(l[pointAtOrBelow(RenderScalePoint{0.24, 1}, l, n)].scale, 540.0 / 2160.0,
           "and one under the bottom rung comes up to it");
  }

  // ---- the OPERATING POINTS ------------------------------------------------
  {
    RenderScalePoint l[8];
    const int n = operatingPoints(k4K, l);
    check(n == 5, "a 60 Hz 4K panel offers five points — every rung, one rate");
    for (int i = 0; i < n; i++) check(l[i].divisor == 1, "…all at the panel's own rate");
    nearly(l[0].scale * 2160.0, 540.0, "worst is 540");
    nearly(l[n - 1].scale * 2160.0, 2160.0, "best is native");
    // THE RATE IS THE PANEL'S OWN ON EVERY PANEL — the rule never moves the
    // divisor. A 120 Hz panel offers the same rungs, each due every 8.3 ms.
    const int m = operatingPoints(k4K120, l);
    check(m == 5, "a 120 Hz 4K panel offers the same five points");
    for (int i = 0; i < m; i++) check(l[i].divisor == 1, "…every one at the panel's own 120");
  }
  nearly(pointPeriodMs(RenderScalePoint{1.0, 1}, k4K120), kHz120, "divisor 1 on 120 Hz is due every 8.3 ms");
  nearly(pointPeriodMs(RenderScalePoint{1.0, 2}, k4K120), 2.0 * kHz120, "divisor 2 every 16.7");

  // ---- the controller ------------------------------------------------------
  //
  // Driven the way a shell drives it: a loop that ticks at the panel's rate,
  // records each tick into the readout's monitor, and polls every second.
  {
    // A loop that ticks at the panel's rate and presents every Nth tick.
    // `everyNth` above 1 with a divisor of 1 is a SKIP STORM; equal to the
    // divisor it is the cadence the host chose. `missEvery` drops one present in
    // that many — the stray skip a rung that holds still has.
    struct Box {
      ttp::rt::perf::Monitor mon;
      RenderScaleController ctl;
      double t = 0;
      int everyNth = 1;
      int missEvery = 0;
      int cells = -1;      // reported to the controller every tick, as the display core does; -1: never
      int tick = 0;
      double gpuMs = -1;   // what a frame costs: past a period, it misses the vsync (the rule never reads it)
      double jitterMs = 0; // stamps land this far either side of the vsync, zero-mean

      void ticks(int n, double panel = kHz60) {
        // WORK THAT OVERRUNS THE PERIOD MISSES THE VSYNC. A box whose GPU takes
        // 30 ms cannot also present every 16.7; `everyNth` still wins where a
        // case declares a skip storm or the rate the host chose.
        const int forced = gpuMs > 0.0 ? (int) std::ceil(gpuMs / panel) : 1;
        const int cadence = std::max(everyNth, std::max(forced, 1));
        for (int i = 0; i < n; i++) {
          const double j = jitterMs * (double) ((tick % 3) - 1);
          t += panel;
          ++tick;
          const bool drew = tick % cadence == 0 && !(missEvery > 0 && tick % missEvery == 0);
          if (cells >= 0) ctl.cells(cells);
          ttp::rt::perf::Sample s;
          s.tMs = t + j;
          s.intervalMs = panel + j;   // the LOOP's cadence, unaffected by a skip
          s.presented = drew;
          s.cpuMs = -1;
          s.gpuMs = drew ? gpuMs : -1;
          mon.record(s);
        }
      }
      bool poll(RenderScaleLimits b, RenderScalePoint* out = nullptr) {
        RenderScalePoint p{0, 0};
        const bool moved = ctl.poll(t, b, mon, &p);
        if (out) *out = p;
        return moved;
      }
      // `secs` seconds of a race, polled every second as a shell does; `cost`
      // prices a frame at the scale in force. Answers how many times it moved.
      int race(double secs, RenderScaleLimits b, double (*cost)(double), double panel = kHz60) {
        int moves = 0;
        // One tick past the second, as a shell polling every frame lands: the
        // poll cadence refuses anything under 1000 ms, and float steps sum short.
        const int perSec = (int) std::lround(1000.0 / panel) + 1;
        for (int i = 0; i < (int) secs; i++) {
          gpuMs = cost(ctl.point().scale);
          ticks(perSec, panel);
          if (poll(b)) moves++;
        }
        return moves;
      }
      double lines(RenderScaleLimits b) const { return ctl.point().scale * b.baseLines; }
    };

    {
      // THE PANEL PERIOD IS LEARNED FROM THE TICKS where a shell has none to
      // declare — a browser has no refresh-rate API. Off the PRESENT series it
      // would read a chosen divisor as a slower panel.
      Box b;
      b.everyNth = 3;
      b.ticks(180);
      b.poll(RenderScaleLimits{0.0, 1.0, 2160.0, 0.0});
      nearly(b.ctl.panelMs(), kHz60, "no declared period: learned from the tick series");
    }
    {
      // …FROM THE TICKS' MEDIAN, NOT THEIR P05. Stamps jitter around the vsync,
      // ±2 ms with the main thread loaded, so one window's p05 on a 120 Hz
      // panel is a 154 Hz panel's period, and a floor that only falls would
      // price every frame against it for the life of the page.
      Box b;
      b.jitterMs = 1.8;
      b.ticks(360, kHz120);
      b.poll(RenderScaleLimits{0.0, 1.0, 2160.0, 0.0});
      nearly(b.ctl.panelMs(), kHz120, "a jittering 120 Hz tick series still teaches 8.3 ms");
    }
    {
      // THE CEILING IS THE BAND'S, ADOPTED ON THE FIRST POLL. A browser on a
      // HiDPI screen sizes its buffer from the ceiling before a frame exists,
      // so a controller that started at a baked-in 1.0 would be pricing frames
      // drawn at 2.0 as though they cost that at 1.0 — and would halve a canvas
      // nobody asked it to touch on its first move.
      const RenderScaleLimits retina{0.0, 2.0, 1080.0, kHz60};
      Box b;
      b.gpuMs = 1.0;
      b.ticks(180);
      check(!b.poll(retina), "adopting the ceiling is not a move: the shell is already there");
      nearly(b.ctl.point().scale, 2.0, "…and the point in force IS the ceiling");
      // …and it is the CEILING, not the top ladder rung: 2160 lines on a
      // 1080-line surface is not on the ladder at all, and native is a rung on
      // every panel (see kScaleLadder).
      nearly(b.lines(retina), 2160.0, "the ceiling is a rung whatever the surface");
    }
    {
      // ONCE, and the band still moves afterwards — a window dragged to another
      // screen lowers the ceiling, and the rule clamps into it every poll.
      const RenderScaleLimits retina{0.0, 2.0, 1080.0, kHz60};
      const RenderScaleLimits plain{0.0, 1.0, 1080.0, kHz60};
      Box b;
      b.gpuMs = 1.0;
      b.ticks(180);
      b.poll(retina);
      b.ticks(180);
      b.poll(plain);
      check(b.ctl.point().scale <= 1.0 + 1e-9, "a lowered ceiling is honoured, not re-adopted");
    }
    {
      // THE SKIP STORM THE TICK SERIES HIDES, which is why presents are counted
      // and ticks are not. The loop ticks a clean 60 and presents 20.
      Box b;
      b.everyNth = 3;
      b.ticks(360);   // 6 s: past kScaleSceneGraceSec, which this arm honours
      RenderScalePoint p{0, 0};
      check(b.poll(k4K, &p) && p.scale < 1.0,
            "a box presenting one tick in three is rescued, not read as 60 fps");
      check(b.mon.size() == 0, "…and the window that decided it goes with the buffer");
    }
    {
      // ONE BAD SECOND IS NOT A MOVE. A rung that holds still has a stray skip:
      // the reference box at 1080 with two players missed at most 4 frames in
      // any 10 s of a race. One in two and a half seconds holds…
      Box b;
      b.missEvery = 150;
      const int moves = b.race(120, kHD, [](double) { return 4.0; });
      check(moves == 0, "a stray skip every 2.5 s moves nothing");
      nearly(b.lines(kHD), 1080.0, "…and the ceiling holds");
      // …and two a second does not.
      Box c;
      c.missEvery = 30;
      c.race(20, kHD, [](double) { return 4.0; });
      check(c.lines(kHD) < 1080.0, "two missed frames a second step down");
    }
    {
      // A HOPELESS RUNG FAILS FAST, and the floor is where it stops: late at
      // every resolution, a split falls to the bottom rung within seconds of
      // the grace and never moves again — no sub-floor rung, no rate change.
      Box b;
      const int moves = b.race(10, kHD, [](double) { return 26.0; });
      nearly(b.lines(kHD), 540.0, "a box late at every resolution falls to 540");
      check(moves == 2, "…one rung at a time");
      check(b.ctl.point().divisor == 1, "…at the panel's own rate, never half of it");
      check(b.race(300, kHD, [](double) { return 26.0; }) == 0,
            "…and stays there: there is no lower point to move to");
    }
    {
      // A SCENE'S FIRST SECONDS ARE NOT ITS COST: nothing missed inside the
      // grace is judged.
      Box b;
      b.race(4, k4K, [](double) { return 1.0; });
      nearly(b.lines(k4K), 2160.0, "a cheap scene holds native");
      b.ctl.scene(b.t);
      b.mon.reset();
      b.race(4, k4K, [](double) { return 30.0; });
      nearly(b.lines(k4K), 2160.0, "a build's first seconds step nothing down");
      b.race(3, k4K, [](double) { return 30.0; });
      check(b.lines(k4K) < 2160.0, "…and past the grace a late scene steps down");
    }
    {
      // THE CLIMB WAITS, and a failed rung waits longer. A race starts on the
      // lobby's 1080 and the opening pack misses a frame and a half a second
      // there: after a full window it steps down, which so soon after the scene
      // put it there FAILS 1080. The pack spreads and 1080 would hold; the climb
      // back waits the doubled wait, not the plain one.
      const auto cheap = [](double) { return 4.0; };
      Box b;
      b.ctl.scene(b.t);
      b.missEvery = 38;
      for (int i = 0; i < 30 && b.lines(kHD) > 1000.0; i++) b.race(1, kHD, cheap);
      nearly(b.lines(kHD), 720.0, "the opening pack steps a 1080 race down");
      check(b.t > 13000.0, "…after a full window of it, not at once");
      b.missEvery = 0;
      const double down = b.t;
      while (b.t < down + 2.0 * kUpWaitSec * 1000.0 - 2000.0) b.race(1, kHD, cheap);
      nearly(b.lines(kHD), 720.0, "a rung failed at the start waits twice kUpWaitSec");
      b.race(4, kHD, cheap);
      nearly(b.lines(kHD), 1080.0, "…and then climbs back to it");
      check(b.race(300, kHD, cheap) == 0, "…and stays, now that it holds");
    }
    {
      // AN UNFAILED RUNG waits only kUpWaitSec from when its scene began. 1080
      // holds well past kFailSec and then stops holding: that step down failed
      // nothing.
      const auto light = [](double) { return 4.0; };
      Box b;
      b.race(35, kHD, light);
      nearly(b.lines(kHD), 1080.0, "a light scene holds the ceiling");
      b.race(10, kHD, [](double s) { return s > 0.7 ? 20.0 : 4.0; });
      nearly(b.lines(kHD), 720.0, "a rung that held, then could not, steps down");
      b.ctl.scene(b.t);
      b.mon.reset();
      const double built = b.t;
      while (b.t < built + kUpWaitSec * 1000.0 - 2000.0) b.race(1, kHD, light);
      nearly(b.lines(kHD), 720.0, "a new scene keeps the point it inherits for kUpWaitSec");
      b.race(4, kHD, light);
      nearly(b.lines(kHD), 1080.0, "…then climbs one rung");
    }
    {
      // A RUNG THE DEVICE CANNOT HOLD IS TRIED RARELY. 720 holds, 1080 misses a
      // frame in two — four players at 1080 on the reference box. Every try
      // fails inside two seconds, before the window ever fills, so the wait goes
      // straight to its longest: one try in five minutes, not one a race.
      const auto cost = [](double s) { return s > 0.7 ? 20.0 : 8.0; };
      Box b;
      b.ctl.scene(b.t);
      b.race(10, kHD, cost);
      nearly(b.lines(kHD), 720.0, "1080 is left at the start");
      check(b.race(300, kHD, cost) == 0,
            "a rung that failed before a full window is not tried again for the longest wait");
      check(b.race(300, kHD, cost) == 2, "…then tried once, and failed once, in the next five minutes");

      // A CUP IS ONE SESSION: the next race is the same four players, so it
      // does not try the rung again.
      b.ctl.scene(b.t);
      b.mon.reset();
      check(b.race(300, kHD, cost) == 0, "a new race in the same session does not try it again");

      // HOLDING a rung is what forgives it. The party shrinks and 1080 holds:
      // the longest wait runs out, the climb holds, and from then on a step
      // down that came after kFailSec failed nothing — the plain wait is back.
      const auto light = [](double) { return 4.0; };
      b.race(60, kHD, light);
      nearly(b.lines(kHD), 1080.0, "after the longest wait the shrunk party climbs, and holds");
      b.race(40, kHD, light);
      b.race(10, kHD, cost);
      nearly(b.lines(kHD), 720.0, "the full party is back and steps down");
      b.race(kUpWaitSec + 15, kHD, light);
      nearly(b.lines(kHD), 1080.0, "a rung that held is forgiven: back on the plain wait");
    }
    {
      // A SCENE STARTS WHERE ITS PLAYER COUNT LEFT OFF. The lobby (the overview,
      // no cells) holds the 1080 that four players cannot; a cup is four players
      // race after race.
      const auto lobby = [](double) { return 4.0; };
      const auto four = [](double s) { return s > 0.7 ? 20.0 : 8.0; };   // 720 holds, 1080 cannot
      Box b;
      b.cells = 0;
      b.ctl.scene(b.t);
      b.race(10, kHD, lobby);
      nearly(b.lines(kHD), 1080.0, "the lobby holds the ceiling");

      // The first four-player race: a count not seen yet starts on the lobby's
      // rung, and only what it misses after its grace moves it.
      b.ctl.scene(b.t);
      b.mon.reset();
      b.cells = 4;
      check(b.race(3, kHD, four) == 0, "the first four-player race starts on the lobby's rung");
      nearly(b.lines(kHD), 1080.0, "…1080, not a rung below it");
      check(b.race(10, kHD, four) == 1, "…and steps down on its missed frames");
      nearly(b.lines(kHD), 720.0, "…to 720");

      // The next race of the cup starts where four players left off, and tries
      // nothing.
      b.ctl.scene(b.t);
      b.mon.reset();
      check(b.race(300, kHD, four) == 0, "the next four-player race starts at 720 and never moves");

      // Back to the lobby: its own 1080, at once, with no climb wait.
      b.ctl.scene(b.t);
      b.mon.reset();
      b.cells = 0;
      check(b.race(3, kHD, lobby) == 1, "the lobby is placed back on its own rung at once");
      nearly(b.lines(kHD), 1080.0, "…the ceiling");
      b.race(60, kHD, lobby);

      // …and the lobby holding 1080 says nothing about four players.
      b.ctl.scene(b.t);
      b.mon.reset();
      b.cells = 4;
      check(b.race(300, kHD, four) == 1, "the next cup's first race is placed at 720 and tries nothing");
      nearly(b.lines(kHD), 720.0, "…and stays there");
    }
    {
      // A NEW COUNT THAT CAN HOLD the lobby's rung never moves: a change of
      // player count gives up no pixels on its own.
      Box b;
      b.cells = 0;
      b.ctl.scene(b.t);
      b.race(10, kHD, [](double) { return 4.0; });
      b.ctl.scene(b.t);
      b.mon.reset();
      b.cells = 2;
      check(b.race(120, kHD, [](double) { return 4.0; }) == 0,
            "a first two-player race that holds the lobby's rung never moves");
      nearly(b.lines(kHD), 1080.0, "…and stays at 1080");
    }
    {
      // 120 Hz IS HELD WITH PIXELS. A frame that fits 8.3 ms only at 720 lines
      // walks down to 720 and stays at 120 Hz.
      Box b;
      b.race(40, k4K120, [](double s) { return 4.0 + 32.0 * s * s; }, kHz120);
      nearly(b.lines(k4K120), 720.0, "a 120 Hz panel gives up pixels to keep 120");
      check(b.ctl.point().divisor == 1, "…at the panel's own rate");
      // A 120 Hz panel presenting a steady 60 IS late at 120: it pays in pixels
      // too, down to the floor if nothing fits 8.3 ms.
      Box c;
      c.everyNth = 2;
      c.race(20, k4K120, [](double) { return 1.0; }, kHz120);
      nearly(c.lines(k4K120), 540.0, "60 fps on a 120 Hz panel is missing every other vsync");
    }
    {
      // A CHOSEN CADENCE IS NOT A LATE ONE. At the host's half rate presents are
      // deliberately two vsyncs apart; judged against one vsync, this box would
      // walk to the floor while presenting perfectly.
      Box b;
      b.ctl.setHalfRate(true);
      for (int i = 0; i < 60; i++) {
        b.everyNth = b.ctl.point().divisor;     // present at the cadence chosen
        b.race(1, k4K120, [](double s) { return 8.0 + 8.0 * s * s; }, kHz120);
      }
      check(b.ctl.point().divisor == 2, "the host's half rate on a 120 Hz box is 60");
      check(b.lines(k4K120) >= 1080.0 - 1e-9,
            "…at the anchor's picture, not shredded to the floor by its own pacing");
    }
    {
      // A FLIP LANDS ON THE ANCHOR, on the very next poll: a step down takes
      // seconds and a step up most of a minute, so the new rung is found from
      // above.
      Box b;
      b.race(10, k4K, [](double) { return 40.0; });
      nearly(b.lines(k4K), 540.0, "walked to the floor");
      b.ctl.setHalfRate(true);
      RenderScalePoint p{0, 0};
      b.ticks(61);
      check(b.poll(k4K, &p) && p.divisor == 2, "flipping to half rate moves at once");
      nearly(p.scale * 2160.0, 1080.0, "…to the anchor, not native");
      b.ctl.setHalfRate(false);
      b.ticks(61);
      check(b.poll(k4K, &p) && p.divisor == 1, "flipping back moves at once too");
      nearly(p.scale * 2160.0, 1080.0, "…to the anchor");
    }
    {
      // ---- WHO IS OFFERED IT, AND WHAT IT BUYS ------------------------------
      //
      // A box whose frame is `14 + 8 s^2` ms on a 1080p panel holds 540@60 and
      // nothing above it; at 30 the budget doubles and 1080 fits.
      const auto drive = [](auto& b, int polls, RenderScaleLimits lim) {
        for (int i = 0; i < polls; i++) {
          for (int k = 0; k < 3; k++) {
            const double s = b.ctl.point().scale;
            b.gpuMs = 14.0 + 8.0 * s * s;
            b.everyNth = b.ctl.point().divisor;
            b.ticks(60, kHz60);
            b.poll(lim);
          }
        }
      };
      Box b;
      check(!b.ctl.offersHalfRate(), "nothing is offered before the box has proved anything");
      int polls = 0;
      while (b.lines(kHD) >= 1080.0 && polls++ < 20) drive(b, 1, kHD);
      check(b.lines(kHD) < 1080.0, "the box steps below the anchor at full rate");
      drive(b, 1, kHD);   // 3 s below it
      check(!b.ctl.offersHalfRate(), "…and is not offered half rate for a dip");
      drive(b, 4, kHD);   // 15 s below it, through the step down to 540
      nearly(b.lines(kHD), 540.0, "the box retreats to the bottom rung");
      check(b.ctl.offersHalfRate(), "below the anchor for kHalfRateOfferSec: the host is offered half rate");
      check(b.ctl.rateHz(false) == 60 && b.ctl.rateHz(true) == 30, "…named as 60 and 30");

      b.ctl.setHalfRate(true);
      RenderScalePoint out{0, 0};
      b.ticks(180, kHz60);
      check(b.poll(kHD, &out) && out.divisor == 2, "the host's choice is performed on the next poll");
      drive(b, 10, kHD);
      nearly(b.lines(kHD), 1080.0, "at half rate the doubled budget holds 1080");
      check(b.ctl.point().divisor == 2, "…and stays at 30");

      b.ctl.setHalfRate(false);
      drive(b, 4, kHD);
      check(b.ctl.point().divisor == 1, "switching back returns to the panel's rate");
      nearly(b.lines(kHD), 540.0, "…and steps back down to what it holds there");
      check(b.ctl.offersHalfRate(), "…and the choice stays offered for the life of the process");

      // A device that holds the anchor is never offered it — not at native on
      // a 4K panel, and not at 1620 lines either, which is above the anchor.
      Box good;
      for (int i = 0; i < 24; i++) {
        good.gpuMs = 2.0;
        good.ticks(180, kHz60);
        good.poll(k4K);
      }
      check(!good.ctl.offersHalfRate(), "a box holding native is never offered half rate");
      check(!belowAnchor(RenderScalePoint{1620.0 / 2160.0, 1}, k4K), "1620 lines is not below the anchor");
      check(belowAnchor(RenderScalePoint{720.0 / 2160.0, 1}, k4K), "720 lines is");
      check(!belowAnchor(RenderScalePoint{1.0, 1}, RenderScaleLimits{0.0, 1.0, 900.0, kHz60}),
            "a surface too short for 1080 lines holding its own ceiling is not below it");

      Box pal;
      pal.ticks(10, 20.0);
      pal.poll(RenderScaleLimits{0.0, 1.0, 1080.0, 20.0});
      check(pal.ctl.rateHz(false) == 50 && pal.ctl.rateHz(true) == 25, "a 50 Hz panel names 50 and 25");

      // A 120 Hz BOX IS OFFERED IT TOO, and there the choice means 60: the same
      // ladder at every other vsync, which is the picture a party game wants
      // when the panel's own rate cannot be held at the anchor.
      Box fast120;
      for (int i = 0; i < 20; i++) {
        const double s = fast120.ctl.point().scale;
        fast120.gpuMs = 14.0 + 8.0 * s * s;   // never fits 8.3 ms on any rung
        fast120.everyNth = fast120.ctl.point().divisor;
        fast120.ticks(360, kHz120);
        fast120.poll(k4K120);
      }
      check(fast120.lines(k4K120) < 1080.0, "a 120 Hz box that cannot hold the anchor settles below it");
      check(fast120.ctl.offersHalfRate(), "…and is offered half rate like any other");
      check(fast120.ctl.rateHz(false) == 120 && fast120.ctl.rateHz(true) == 60, "…named as 120 and 60");
      fast120.ctl.setHalfRate(true);
      for (int i = 0; i < 4; i++) {
        fast120.everyNth = fast120.ctl.point().divisor;
        fast120.ticks(360, kHz120);
        fast120.poll(k4K120);
      }
      check(fast120.ctl.point().divisor == 2 && fast120.ctl.halfRate(), "the choice is performed as every other vsync");
      check(fast120.lines(k4K120) > 540.0, "…and the doubled budget buys back pixels");
    }
  }

  std::printf("render_scale: %d cases, %d failed\n", cases, failed);
  return failed ? 1 : 0;
}
