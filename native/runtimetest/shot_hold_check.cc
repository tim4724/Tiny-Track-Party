// Behaviour check for ttp/shot_hold.h — the screenshot harnesses' race freeze.
//
// Assertions rather than a corpus, like progression_check: the layer is new and
// has no oracle. What is pinned is what makes three platforms' photographs of a
// card agree — the stop lands ON the named sim moment rather than on whichever
// frame passed it, at any frame rate.
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

// Step a race at a fixed frame dt until held, the way ttp_update does. Returns
// the elapsed sim time at the hold.
double run(const sh::Spec& spec, double dt) {
  sh::State st;
  double t = 0;
  while (true) {
    const double step = sh::allow(spec, st, t, dt);
    if (st.held) return t;
    t += step;
  }
}

bool near(double a, double b) { return a - b < 1e-9 && b - a < 1e-9; }

}  // namespace

int main() {
  sh::Spec s;

  // ---- parse ----
  check(parse("{\"simMs\":5000}", &s) && near(s.simS, 5), "a hold parses");
  check(!parse("{}", &s), "simMs is required");
  check(!parse("{\"simMs\":-1}", &s), "a negative simMs is refused");
  check(!parse("[1]", &s), "a non-object is refused");

  // ---- a hold lands exactly on its moment, whatever the frame rate ----
  parse("{\"simMs\":5000}", &s);
  check(near(run(s, 1.0 / 60), 5), "60 fps stops at 5 s");
  check(near(run(s, 0.05), 5), "20 fps stops at 5 s");
  check(near(run(s, 0.037), 5), "an uneven dt still lands on 5 s");
  {
    sh::State st;
    check(near(sh::allow(s, st, 4.99, 0.05), 0.01), "the last step is shortened to the target");
    check(!st.held, "not held before the target");
    check(sh::allow(s, st, 5, 0.05) == 0 && st.held, "held at the target");
    check(sh::allow(s, st, 5, 0.05) == 0, "stays held");
  }

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
