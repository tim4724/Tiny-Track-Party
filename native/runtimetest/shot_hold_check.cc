// Behaviour check for ttp/shot_hold.h — the screenshot harnesses' race freeze.
//
// Assertions rather than a corpus, like progression_check: the layer is new and
// has no oracle. What is pinned is what makes three platforms' photographs of a
// card agree — the stop lands ON the named sim moment rather than on whichever
// frame passed it, an item event before `simMs` does not count, and an item card
// whose event never comes still stops (at its cap) instead of hanging a capture.
#include <cstdio>
#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/shot_hold.h"

using namespace ttp;
namespace sh = ttp::rt::shot_hold;

namespace {

int cases = 0, failed = 0;

void check(bool ok, const char* what) {
  cases++;
  if (!ok) {
    failed++;
    std::fprintf(stderr, "FAIL %s\n", what);
  }
}

bool parse(const std::string& s, sh::Spec* out) {
  bool ok = false;
  Value v = json::parse(s.c_str(), &ok);
  return ok && sh::parse(v, out);
}

// Step a race at a fixed frame dt until held (or a frame budget runs out), the
// way ttp_update does; `cars` is consulted every frame and `hitAt` fires a
// rocket hit on the first frame at or past that sim time. Returns the elapsed
// sim time at the hold, or -1 if it never held.
double run(const sh::Spec& spec, double dt, std::vector<sh::CarView> cars = {},
           double hitAt = -1, int frames = 100000) {
  sh::State st;
  double t = 0;
  for (int i = 0; i < frames; i++) {
    const double step = sh::allow(spec, st, t, dt, cars);
    if (st.held) return t;
    t += step;
    if (hitAt >= 0 && t >= hitAt) {
      sh::noteRocketHit(spec, st, t);
      hitAt = -1;
    }
  }
  return -1;
}

bool near(double a, double b) { return a - b < 1e-9 && b - a < 1e-9; }

}  // namespace

int main() {
  sh::Spec s;

  // ---- parse ----
  check(parse("{\"simMs\":5000}", &s) && near(s.simS, 5) && s.on == sh::On::None, "plain hold parses");
  check(parse("{\"simMs\":2000,\"on\":\"rocket\",\"afterMs\":90,\"capMs\":30000}", &s)
          && s.on == sh::On::Rocket && near(s.afterS, 0.09) && near(s.capS, 30), "rocket hold parses");
  check(parse("{\"simMs\":0,\"on\":\"monster\"}", &s) && s.on == sh::On::Monster, "monster hold parses");
  check(!parse("{}", &s), "simMs is required");
  check(!parse("{\"simMs\":-1}", &s), "a negative simMs is refused");
  check(!parse("{\"simMs\":1000,\"on\":\"banana\"}", &s), "an unknown event is refused");
  check(!parse("{\"simMs\":1000,\"on\":3}", &s), "a non-string event is refused");
  check(!parse("[1]", &s), "a non-object is refused");

  // ---- a plain hold lands exactly on its moment, whatever the frame rate ----
  parse("{\"simMs\":5000}", &s);
  check(near(run(s, 1.0 / 60), 5), "60 fps stops at 5 s");
  check(near(run(s, 0.05), 5), "20 fps stops at 5 s");
  check(near(run(s, 0.037), 5), "an uneven dt still lands on 5 s");
  {
    sh::State st;
    check(near(sh::allow(s, st, 4.99, 0.05, {}), 0.01), "the last step is shortened to the target");
    check(!st.held, "not held before the target");
    check(sh::allow(s, st, 5, 0.05, {}) == 0 && st.held, "held at the target");
    check(sh::allow(s, st, 5, 0.05, {}) == 0, "stays held");
  }

  // ---- rocket: the hit, plus afterMs; an early hit does not count ----
  parse("{\"simMs\":2000,\"on\":\"rocket\",\"afterMs\":90,\"capMs\":30000}", &s);
  {
    // The hit is noted on the first frame at or past 3.5 s, so it lands within a
    // frame of it; the hold is exactly afterMs past the NOTED moment.
    const double t = run(s, 0.05, {}, 3.5);
    check(t >= 3.59 - 1e-9 && t < 3.59 + 0.05 + 1e-9, "a rocket hit at 3.5 s holds 90 ms later");
  }
  check(near(run(s, 1.0 / 60, {}, -1), 30), "no hit: held at the cap");
  {
    sh::State st;
    sh::noteRocketHit(s, st, 1.0);
    check(st.eventAt < 0, "a hit before simMs is ignored");
    sh::noteRocketHit(s, st, 2.5);
    sh::noteRocketHit(s, st, 2.8);
    check(near(st.eventAt, 2.5), "only the first qualifying hit counts");
  }
  {
    sh::Spec plain;
    parse("{\"simMs\":1000}", &plain);
    sh::State st;
    sh::noteRocketHit(plain, st, 1.5);
    check(st.eventAt < 0, "a plain hold ignores rocket hits");
  }

  // ---- monster: a viewer's own car is the truck, plus afterMs ----
  parse("{\"simMs\":1000,\"on\":\"monster\",\"afterMs\":600,\"capMs\":20000}", &s);
  {
    const std::vector<sh::CarView> cpuTruck = {{12, true, false}, {10, false, true}};
    check(near(run(s, 0.05, cpuTruck), 20), "a CPU truck, however close to a viewer, does not count: the cap");
    const std::vector<sh::CarView> viewerIsTruck = {{30, false, false}, {10, true, true}};
    const double t = run(s, 0.05, viewerIsTruck);
    check(t >= 1.6 - 1e-9 && t < 1.6 + 0.05, "a viewer's truck from the start: held 600 ms past simMs");
  }

  // ---- no cap and no event never holds (the harness's own timeout owns that) ----
  parse("{\"simMs\":0,\"on\":\"rocket\"}", &s);
  check(run(s, 0.05, {}, -1, 2000) < 0, "an uncapped item hold waits for its event");

  // ---- the item showcase ----
  check(sh::parseShowcase("rocket") == sh::Showcase::Rocket, "rocket showcase parses");
  check(sh::parseShowcase("monster") == sh::Showcase::Monster, "monster showcase parses");
  check(sh::parseShowcase(nullptr) == sh::Showcase::None, "null turns the showcase off");
  check(sh::parseShowcase("banana") == sh::Showcase::None, "an unknown item turns it off");
  {
    // {totalS, monster, viewer, finished}
    const std::vector<sh::CarView> field = {
      {30, false, false, false},   // 0: AI, ahead
      {10, false, true, false},    // 1: viewer
      {5, false, false, false},    // 2: AI, furthest back of the running cars
      {2, false, true, true},      // 3: viewer, furthest back, but finished
    };
    sh::ShowcaseState st;
    check(sh::showcasePick(sh::Showcase::Rocket, st, 0.5, field) == -1, "nothing fires before the first 0.8 s");
    check(sh::showcasePick(sh::Showcase::Rocket, st, 0.5, field) == 2,
          "then the furthest-back UNFINISHED car fires, AI or not");
    check(sh::showcasePick(sh::Showcase::Rocket, st, 1.2, field) == -1, "a rocket waits its 1.3 s gap");
    check(sh::showcasePick(sh::Showcase::Rocket, st, 0.2, field) == 2, "and fires again after it");
    check(sh::showcasePick(sh::Showcase::None, st, 5, field) == -1, "an off showcase never fires");
  }
  {
    std::vector<sh::CarView> field = {
      {5, false, false, false},    // 0: AI, furthest back — not a viewer
      {10, false, true, false},    // 1: viewer
    };
    sh::ShowcaseState st;
    check(sh::showcasePick(sh::Showcase::Monster, st, 1, field) == 1, "a monster fires from a viewer seat only");
    check(sh::showcasePick(sh::Showcase::Monster, st, 1.5, field) == -1, "a monster waits its 1.6 s gap");
    field[0].monster = true;
    check(sh::showcasePick(sh::Showcase::Monster, st, 1, field) == -1, "one truck at a time");
    field[0].monster = false;
    check(sh::showcasePick(sh::Showcase::Monster, st, 0, field) == 1, "and the next once it is gone");
  }

  std::printf("shot_hold: %d/%d passed\n", cases - failed, cases);
  return failed ? 1 : 0;
}
