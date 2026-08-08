// corpus_record — the shared --record walk for the JS-recorded corpora.
//
// WHAT IT DOES, AND WHAT IT DOES NOT. It re-emits a committed corpus from the
// PORT: each line is parsed, its recorded INPUT is fed back through the C++, and
// the line is written out again with the C++'s own answers in place of the
// recorded ones. `record_*` ctest entries then require the result to be
// byte-identical to the committed file.
//
// It does NOT regenerate the corpus. The scenarios — which ops, in which order,
// with which arguments, including the mulberry32 sweeps — stay in the .mjs
// generators and are read straight off the committed file here. So a re-record
// can never invent a case, only reproduce one.
//
// WHAT BYTE IDENTITY BUYS, stated plainly because it is easy to overclaim: it
// proves the port reproduces every recorded answer AND its exact JSON spelling
// — key set, null-vs-absent, and every number through js_number_to_string. That
// is strictly more than the replay checks assert (they compare structurally,
// and a structural pass tolerates a number that reformats differently). It is
// NOT evidence that the port matches the JS: the committed bytes are what carry
// that, and they were written by the JS. See tests/fixtures/traces/README.md.
//
// The corollary is the one worth remembering: if a --record output ever differs
// from the committed file UNEXPECTEDLY, the committed file is right — do not
// overwrite it to make a broken change pass. A DELIBERATE behaviour change may
// overwrite it, under the green-first re-record rule in tests/CLAUDE.md.
#pragma once

#include <cstdio>
#include <fstream>
#include <functional>
#include <string>

#include "corpus_diff.h"
#include "ttp/canonical.h"

namespace ttp {
namespace corpus {

// Given one parsed corpus line, return the line to write. Returning a Value of
// type UNDEF copies the original text through verbatim, which is what headers
// and scenario markers want.
using Recompute = std::function<Value(const Value&)>;

// Returns 0 on success, non-zero (with a message on stderr) otherwise.
inline int record(const std::string& inPath, const std::string& outPath, const Recompute& f) {
  std::ifstream in(inPath);
  if (!in) { std::fprintf(stderr, "--record: cannot open %s\n", inPath.c_str()); return 2; }
  std::ofstream out(outPath, std::ios::binary);
  if (!out) { std::fprintf(stderr, "--record: cannot write %s\n", outPath.c_str()); return 2; }

  std::string line;
  int n = 0;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value v;
    std::string err;
    if (!read_line(line, v, &err)) {
      std::fprintf(stderr, "--record: parse at line %d: %s\n", n + 1, err.c_str());
      return 2;
    }
    const Value rebuilt = f(v);
    // "\n" and not std::endl: the committed files end every line with a bare LF
    // and no trailing flush artefacts, and byte identity is the whole point.
    out << (rebuilt.type == Value::UNDEF ? line : canonical_stringify(rebuilt)) << "\n";
    n++;
  }
  return 0;
}

// The --record argument shape every check shares: "--record <fixture> --out=<f>".
// Fills `fixture` and `outPath` and returns true when the flag is present.
inline bool wants_record(int argc, char** argv, std::string* fixture, std::string* outPath) {
  bool seen = false;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    if (a == "--record" && i + 1 < argc) { seen = true; *fixture = argv[++i]; continue; }
    if (a.rfind("--out=", 0) == 0) { *outPath = a.substr(6); continue; }
  }
  return seen && !outPath->empty();
}

}  // namespace corpus
}  // namespace ttp
