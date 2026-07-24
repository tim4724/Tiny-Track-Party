// Replays tests/fixtures/json-number-corpus.jsonl against js_number_to_string:
// for each case {"i":"<hex64>","o":"<expected>"}, decode the big-endian IEEE-754
// bits and demand js_number_to_string == the recorded JSON.stringify output,
// byte-for-byte. This is fp-profile.md risk #4 (shortest-form serialization); it
// must reach zero before the sim/replay work depends on the serializer.
//
// The corpus header (line 1) is {"cases":N,"note":...}; each subsequent line is
// one case. Number strings never contain quotes/backslashes, so a flat scan for
// "i":" and "o":" suffices (no JSON parser needed).

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>

#include "ttp/jsonnum.h"

namespace {

// 16 hex chars (big-endian binary64 bits) -> double.
double hexToDouble(const std::string& hex) {
  uint64_t bits = 0;
  for (char c : hex) {
    bits <<= 4;
    if (c >= '0' && c <= '9') bits |= (uint64_t)(c - '0');
    else if (c >= 'a' && c <= 'f') bits |= (uint64_t)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') bits |= (uint64_t)(c - 'A' + 10);
  }
  double d;
  std::memcpy(&d, &bits, 8);
  return d;
}

// Extract the string value that follows `"<key>":"` up to the next unescaped ".
bool field(const std::string& line, const char* key, std::string& out) {
  std::string pat = std::string("\"") + key + "\":\"";
  size_t p = line.find(pat);
  if (p == std::string::npos) return false;
  p += pat.size();
  size_t q = line.find('"', p);
  if (q == std::string::npos) return false;
  out = line.substr(p, q - p);
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: serializer_check <json-number-corpus.jsonl>\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }

  std::string line;
  std::getline(in, line);  // header: {"cases":N,...}

  long total = 0, fail = 0;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    std::string hex, want;
    if (!field(line, "i", hex) || !field(line, "o", want)) {
      std::fprintf(stderr, "bad corpus line: %s\n", line.c_str());
      return 2;
    }
    total++;
    std::string got = ttp::js_number_to_string(hexToDouble(hex));
    if (got != want) {
      if (fail < 20)
        std::fprintf(stderr, "MISMATCH i=%s want=\"%s\" got=\"%s\"\n",
                     hex.c_str(), want.c_str(), got.c_str());
      fail++;
    }
  }
  std::printf("json-number corpus: %ld cases, %ld mismatches\n", total, fail);
  return fail == 0 ? 0 : 1;
}
