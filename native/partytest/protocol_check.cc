// protocol conformance check — replays tests/fixtures/protocol-corpus.jsonl (from
// scripts/gen-protocol-corpus.mjs, read straight from public/shared/protocol.js)
// against the C++ ttp::protocol twin. Line 1 header; line 2 {constants} vs
// protocol::manifest(); each further line {carIndex, result} vs car_stats().
// First divergence localizes and fails; spew capped at 20.
//
// Plus one assertion that is NOT from the corpus, and is the reason this binary
// links libttp_sim: the sim's own default steering exponent must BE the manifest
// value. The corpus proves protocol.h agrees with protocol.js; that assertion
// proves game.cc agrees with protocol.h, and the two together are what make the
// phone/display steering chain a checked chain rather than three comments. It
// lives here rather than in game.cc as an include because libttp_sim must not
// take a dependency on the party layer above it — a test binary linking both is
// free, a layering inversion is not.

#include <cmath>
#include <cstdio>
#include <fstream>
#include <limits>
#include <string>

#include "corpus_diff.h"
#include "ttp/game.h"
#include "ttp/protocol.h"

using namespace ttp;
using namespace ttp::corpus;

int main(int argc, char** argv) {
  if (argc != 2) { std::fprintf(stderr, "usage: protocol_check <protocol-corpus.jsonl>\n"); return 2; }
  std::ifstream in(argv[1]);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }

  std::string line;
  if (!std::getline(in, line)) { std::fprintf(stderr, "empty corpus\n"); return 2; }  // header

  int cases = 0, passed = 0, spew = 0;

  // ---- constants manifest -----------------------------------------------------
  if (!std::getline(in, line)) { std::fprintf(stderr, "missing constants line\n"); return 2; }
  {
    Value root;
    if (!read_line(line, root)) { std::fprintf(stderr, "parse error on constants line\n"); return 2; }
    const Value* consts = root.find("constants");
    if (!consts) { std::fprintf(stderr, "constants line has no 'constants'\n"); return 2; }
    Value m = protocol::manifest();
    cases++;
    Diff d = diff_val(*consts, m, "constants");
    if (d.differ) {
      std::fprintf(stderr, "FAIL constants  path %s\n  expected %s\n  actual   %s\n",
                   d.path.c_str(), d.expected.c_str(), d.actual.c_str());
    } else {
      passed++;
    }
  }

  // ---- carStats table ---------------------------------------------------------
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    if (!read_line(line, root)) { std::fprintf(stderr, "parse error on carStats line\n"); return 2; }
    const Value* idxV = root.find("carIndex");
    const Value* resV = root.find("result");
    if (!idxV || !resV) { std::fprintf(stderr, "carStats line missing carIndex/result\n"); return 2; }

    Value idx;
    if (idxV->type == Value::OBJ && idxV->has("nan")) idx = Value::Num(std::numeric_limits<double>::quiet_NaN());
    else if (idxV->type == Value::NUM) idx = Value::Num(idxV->num);
    else idx = Value::Null();

    Value got = protocol::car_stats(idx);
    cases++;
    Diff d = diff_val(*resV, got, "carStats");
    if (d.differ) {
      if (spew++ < 20) {
        std::fprintf(stderr, "FAIL carStats(%s)  path %s\n  expected %s\n  actual   %s\n",
                     canonical_stringify(*idxV).c_str(), d.path.c_str(), d.expected.c_str(), d.actual.c_str());
      }
    } else {
      passed++;
    }
  }

  // ---- the sim's steering exponent IS the manifest's --------------------------
  // getSteerExpo() reads the module global before anyone has called
  // setSteerExpo, i.e. game.cc's own STEER_EXPO literal.
  cases++;
  const double simExpo = getSteerExpo();
  if (simExpo != protocol::STEER_EXPO) {
    std::fprintf(stderr,
                 "FAIL steerExpo  libttp-sim game.cc STEER_EXPO has drifted from the "
                 "protocol manifest\n  expected %.17g\n  actual   %.17g\n",
                 protocol::STEER_EXPO, simExpo);
  } else {
    passed++;
  }

  std::printf("protocol corpus: %d/%d cases passed\n", passed, cases);
  return passed == cases ? 0 : 1;
}
