// protocol conformance check — replays tests/fixtures/protocol-corpus.jsonl (from
// scripts/gen-protocol-corpus.mjs, read straight from public/shared/protocol.js)
// against the C++ ttp::protocol twin. Line 1 header; line 2 {constants} vs
// protocol::manifest(); each further line {carIndex, result} vs car_stats().
// First divergence localizes and fails; spew capped at 20.

#include <cmath>
#include <cstdio>
#include <fstream>
#include <limits>
#include <string>

#include "json_check.h"
#include "ttp/protocol.h"

using namespace ttp;
using namespace ttp::jsoncheck;

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
    JV root;
    if (!parseLine(line, root)) { std::fprintf(stderr, "parse error on constants line\n"); return 2; }
    const JV* consts = root.get("constants");
    if (!consts) { std::fprintf(stderr, "constants line has no 'constants'\n"); return 2; }
    Value m = protocol::manifest();
    cases++;
    Diff d = diffVal(*consts, m, "constants");
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
    JV root;
    if (!parseLine(line, root)) { std::fprintf(stderr, "parse error on carStats line\n"); return 2; }
    const JV* idxJV = root.get("carIndex");
    const JV* resJV = root.get("result");
    if (!idxJV || !resJV) { std::fprintf(stderr, "carStats line missing carIndex/result\n"); return 2; }

    Value idx;
    if (idxJV->t == JV::OBJ && idxJV->has("nan")) idx = Value::Num(std::numeric_limits<double>::quiet_NaN());
    else if (idxJV->t == JV::NUM) idx = Value::Num(idxJV->num);
    else idx = Value::Null();

    Value got = protocol::car_stats(idx);
    cases++;
    Diff d = diffVal(*resJV, got, "carStats");
    if (d.differ) {
      if (spew++ < 20) {
        std::fprintf(stderr, "FAIL carStats(%s)  path %s\n  expected %s\n  actual   %s\n",
                     canonJV(*idxJV).c_str(), d.path.c_str(), d.expected.c_str(), d.actual.c_str());
      }
    } else {
      passed++;
    }
  }

  std::printf("protocol corpus: %d/%d cases passed\n", passed, cases);
  return passed == cases ? 0 : 1;
}
