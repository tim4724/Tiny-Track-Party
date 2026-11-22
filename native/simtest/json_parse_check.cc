// json_parse.h on hostile text: nesting past MAX_DEPTH fails the parse instead
// of recursing. The relay and the fastlane hand the parser raw network text
// (ttp_framing_classify, ttp_link_inbound), and before the limit a few KB of '['
// overflowed every platform's stack. This runs on the main thread, so a
// regression crashes the check rather than passing it.

#include <cstdio>
#include <string>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"

using namespace ttp;

namespace {

int failures = 0;

void check(bool ok, const char* what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL %s\n", what);
    failures++;
  }
}

// `depth` containers around a scalar, each opened by `open` and closed by `close`.
std::string nested(int depth, const char* open, const char* close) {
  std::string s;
  for (int i = 0; i < depth; i++) s += open;
  s += "1";
  for (int i = 0; i < depth; i++) s += close;
  return s;
}

bool parses(const std::string& text, Value* out = nullptr, std::string* err = nullptr) {
  json::Parser p(text);
  Value v;
  const bool ok = p.parse(v);
  if (out) *out = v;
  if (err) *err = p.error();
  return ok;
}

}  // namespace

int main() {
  const int D = json::MAX_DEPTH;

  // The boundary: exactly MAX_DEPTH containers parse, and read back unchanged.
  const std::string arrays = nested(D, "[", "]");
  Value v;
  check(parses(arrays, &v), "arrays nested MAX_DEPTH deep parse");
  check(canonical_stringify(v) == arrays, "...and stringify back to the same text");
  check(parses(nested(D, "{\"a\":", "}")), "objects nested MAX_DEPTH deep parse");

  // One past it fails, and says why.
  std::string err;
  check(!parses(nested(D + 1, "[", "]"), nullptr, &err), "arrays nested MAX_DEPTH + 1 deep fail");
  check(err.find("nesting") != std::string::npos, "...with the depth named as the reason");
  check(!parses(nested(D + 1, "{\"a\":", "}")), "objects nested MAX_DEPTH + 1 deep fail");
  check(parses(nested(D / 2, "[{\"a\":", "}]")) && !parses(nested(D / 2 + 1, "[{\"a\":", "}]")),
        "arrays and objects count alike");

  // Far past it, closed and unclosed: what an attacker sends.
  check(!parses(nested(1000000, "[", "]")), "a million nested arrays fail cleanly");
  check(!parses(std::string(1000000, '[')), "a million unclosed arrays fail cleanly");
  std::string objects;
  for (int i = 0; i < 1000000; i++) objects += "{\"a\":";
  bool ok = true;
  const Value back = json::parse(objects.c_str(), &ok);
  check(!ok && back.type == Value::NUL, "json::parse answers null and ok=false for them");

  std::printf("json parse: depth limit %d, %d failures\n", D, failures);
  return failures == 0 ? 0 : 1;
}
