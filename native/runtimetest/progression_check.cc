// Behaviour check for ttp/progression.h — the cup star record's derivations.
//
// Assertions rather than a corpus, like frame_check: every rule here is exactly
// reproducible on every leg (integer compares, list walks, a tolerant parse) and
// there is no JS oracle — the layer is NEW, decided 2026-08-12 (stars 1/2/3 =
// finished / podium / won, the 'rooftop' cup locked until every other shipped
// cup is finished, best-HUMAN standing banks; shipped cups only — the tour
// earns nothing, decided 2026-08-13).
// This file is where those decisions are pinned; the abi ctest separately gates
// the marshalling and the catalogue stamping over the same functions.
#include <cstdio>
#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/progression.h"

using namespace ttp;
namespace progression = ttp::rt::progression;

namespace {

int cases = 0, failed = 0;

void check(bool ok, const char* what) {
  cases++;
  if (!ok) {
    failed++;
    std::fprintf(stderr, "FAIL %s\n", what);
  }
}

Value parseJson(const std::string& s) {
  bool ok = false;
  Value v = json::parse(s.c_str(), &ok);
  return ok ? v : Value();
}

const std::vector<std::string> SHIPPED = {"beach", "snow", "backyard", "canyon", "rooftop"};

}  // namespace

int main() {
  // ---- parse / serialize ------------------------------------------------------
  {
    progression::Record r =
        progression::parse(parseJson(R"({"v":1,"cups":{"beach":{"best":2},"snow":{"best":1}}})"));
    check(r.bestOf("beach") == 2 && r.bestOf("snow") == 1, "parse reads bests");
    check(r.bestOf("canyon") == 0, "an unbanked cup reads 0");
    check(canonical_stringify(progression::serialize(r)) ==
              R"({"cups":{"beach":{"best":2},"snow":{"best":1}},"v":1})",
          "serialize is canonical and stable");
  }
  {
    // Tolerance: every corrupt shape loads a fresh couch, never a crash.
    const char* garbage[] = {
        "", "null", "42", "[]", R"({"v":2,"cups":{"beach":{"best":1}}})",
        R"({"cups":{"beach":{"best":1}}})",              // no version
        R"({"v":1})",                                    // no cups
        R"({"v":1,"cups":{"beach":{"best":0}}})",        // rank 0 is not a rank
        R"({"v":1,"cups":{"beach":{"best":-3}}})",
        R"({"v":1,"cups":{"beach":{"best":1.5}}})",      // nor is a fraction
        R"({"v":1,"cups":{"beach":"won"}})",
    };
    for (const char* g : garbage) {
      progression::Record r = progression::parse(parseJson(g));
      check(r.bests.empty(), (std::string("garbage loads empty: ") + g).c_str());
    }
  }

  // ---- stars ------------------------------------------------------------------
  check(progression::stars(0) == 0, "no finish, no star");
  check(progression::stars(-1) == 0, "nonsense best, no star");
  check(progression::stars(1) == 3, "won = 3 stars");
  check(progression::stars(2) == 2 && progression::stars(3) == 2, "podium = 2 stars");
  check(progression::stars(4) == 1 && progression::stars(8) == 1, "finished = 1 star");

  // ---- the lock ---------------------------------------------------------------
  {
    progression::Record r;
    check(progression::unlocked(r, "beach", SHIPPED), "ordinary cups are never locked");
    check(!progression::unlocked(r, "rooftop", SHIPPED), "a fresh couch has the Playroom locked");
    check(progression::unlockDone(r, "rooftop", SHIPPED) == 0 &&
              progression::unlockNeed("rooftop", SHIPPED) == 4,
          "fresh unlock progress is 0 of 4");
    for (const char* id : {"beach", "snow", "backyard"}) {
      std::vector<bool> ai = {true, false, true};   // best human 2nd
      progression::bank(r, id, ai);
    }
    check(!progression::unlocked(r, "rooftop", SHIPPED), "three of four is still locked");
    check(progression::unlockDone(r, "rooftop", SHIPPED) == 3, "unlock progress counts finishes");
    std::vector<bool> ai = {true, true, true, true, true, true, true, false};
    progression::bank(r, "canyon", ai);
    check(progression::unlocked(r, "rooftop", SHIPPED), "all four finished unlocks the Playroom");
    // A synthetic conformance world carries no 'rooftop': nothing locks.
    check(progression::unlocked(progression::Record(), "cup-a", {"cup-a", "cup-b"}),
          "synthetic worlds lock nothing");
  }

  // ---- banking ----------------------------------------------------------------
  {
    progression::Record r;
    std::vector<bool> fifth = {true, true, true, true, false, true, true, true};
    check(progression::bank(r, "beach", fifth) && r.bestOf("beach") == 5,
          "first finish banks the best human's rank");
    std::vector<bool> secondAndFourth = {true, false, true, false};
    check(progression::bank(r, "beach", secondAndFourth) && r.bestOf("beach") == 2,
          "the FIRST human row is the couch's best");
    std::vector<bool> third = {true, true, false};
    check(!progression::bank(r, "beach", third) && r.bestOf("beach") == 2,
          "a worse run never downgrades the record");
    std::vector<bool> won = {false, true};
    check(progression::bank(r, "beach", won) && r.bestOf("beach") == 1, "a win upgrades to 1");
    check(!progression::bank(r, "snow", {true, true}), "an all-bot podium banks nothing");
    check(!progression::bank(r, "snow", {}), "empty standings bank nothing");
  }

  // ---- eligibility ------------------------------------------------------------
  check(progression::bankEligible("beach", SHIPPED), "a shipped cup banks");
  check(!progression::bankEligible("tour", SHIPPED), "the tour earns nothing");
  check(!progression::bankEligible("random", SHIPPED), "random never banks");
  check(!progression::bankEligible("", SHIPPED), "a nameless series never banks");

  std::printf("progression: %d/%d checks passed\n", cases - failed, cases);
  return failed == 0 ? 0 : 1;
}
