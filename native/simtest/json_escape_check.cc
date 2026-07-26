// Replays tests/fixtures/json-escape-corpus.jsonl: the JS oracle for the JSON
// string layer. Per case it asserts BOTH directions —
//   serialize:  json_quote(raw)          == the recorded JSON.stringify output
//   round-trip: json::parse(want).str    == raw
// so an escape the writer emits wrongly and an escape the reader misreads are
// each caught on their own, and a matching pair of bugs cannot cancel out.
//
// This exists because no other fixture reaches the code: across all 8 traces and
// every other corpus there is not one backslash escape, so the quote/backslash/
// \b\t\n\f\r arms and the \u00XX control-character arm ran nowhere. A player can
// reach them with the controller's free-text name field.

#include <cstdio>
#include <fstream>
#include <string>

#include "corpus_diff.h"
#include "ttp/canonical.h"
#include "ttp/json_parse.h"

using namespace ttp;
using namespace ttp::corpus;

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: json_escape_check <corpus.jsonl>\n"); return 2; }
  std::ifstream in(argv[1]);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }

  int cases = 0, bad = 0;
  std::string line, err;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value rec;
    if (!read_line(line, rec, &err)) {
      std::fprintf(stderr, "FAIL corpus line %d: %s\n", cases, err.c_str());
      return 1;
    }
    const Value* raw = rec.find("raw");
    const Value* want = rec.find("want");
    if (!raw || !want || raw->type != Value::STR || want->type != Value::STR) {
      std::fprintf(stderr, "FAIL case %d: missing raw/want\n", cases);
      return 1;
    }
    cases++;

    const std::string got = json_quote(raw->str);
    if (got != want->str) {
      if (++bad <= 10)
        std::fprintf(stderr, "FAIL case %d serialize: got %s, want %s\n",
                     cases, got.c_str(), want->str.c_str());
      continue;
    }
    // The recorded `want` IS a JSON string literal; parsing it must give `raw`.
    bool ok = false;
    const Value back = json::parse(want->str.c_str(), &ok);
    if (!ok || back.type != Value::STR || back.str != raw->str) {
      if (++bad <= 10)
        std::fprintf(stderr, "FAIL case %d round-trip: %s did not read back\n",
                     cases, want->str.c_str());
    }
  }

  std::printf("json escape corpus: %d cases, %d bad\n", cases, bad);
  if (cases == 0) { std::fprintf(stderr, "FAIL corpus was empty\n"); return 1; }
  return bad == 0 ? 0 : 1;
}
