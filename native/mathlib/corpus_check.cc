// Replays tests/fixtures/math-corpus.jsonl against the NATIVE fdlibm build
// and demands identical IEEE-754 bit patterns — the C++ twin of
// tests/mathlib.test.js. Together they prove the emscripten/WASM build (what
// the JS engine ships) and this platform-clang build (what libttp-sim links)
// compute identical transcendentals, which is the foundation of the whole
// golden-trace conformance scheme.
//
// The corpus format is ours and stable (scripts/gen-math-corpus.mjs): line 1
// is a JSON header, each further line is {"f":"sin","i":["<hex64>",...],
// "o":"<hex64>"} with values as 16-hex-digit big-endian bit patterns and NaN
// canonicalized to the string "nan" (NaN is compared as a class — WASM and
// hardware may differ in NaN payload propagation, and no NaN reaches the sim
// byte path). Parsing is a few string scans, deliberately dependency-free.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>

extern "C" {
double ttp_fd_sin(double);
double ttp_fd_cos(double);
double ttp_fd_atan2(double, double);
double ttp_fd_exp(double);
double ttp_fd_pow(double, double);
double ttp_fd_hypot(double, double);
}

namespace {

uint64_t bits_of(double d) {
  uint64_t u;
  std::memcpy(&u, &d, 8);
  return u;
}
double double_of(uint64_t u) {
  double d;
  std::memcpy(&d, &u, 8);
  return d;
}
bool is_nan_bits(uint64_t u) {
  return ((u >> 52) & 0x7FF) == 0x7FF && (u & 0xFFFFFFFFFFFFFull) != 0;
}

// Extract the value of "key" in a flat JSON object line: either an array of
// strings (returns count, fills out[]) or a single string (count 1).
int extract_strings(const std::string& line, const char* key, std::string out[2]) {
  const std::string pat = std::string("\"") + key + "\":";
  size_t p = line.find(pat);
  if (p == std::string::npos) return -1;
  p += pat.size();
  int n = 0;
  bool in_array = line[p] == '[';
  if (in_array) p++;
  while (n < 2) {
    if (line[p] != '"') return -1;
    size_t end = line.find('"', p + 1);
    if (end == std::string::npos) return -1;
    out[n++] = line.substr(p + 1, end - p - 1);
    p = end + 1;
    if (!in_array || line[p] != ',') break;
    p++;
  }
  return n;
}

bool parse_hex64(const std::string& s, uint64_t* out, bool* is_nan) {
  if (s == "nan") { *is_nan = true; *out = 0x7FF8000000000000ull; return true; }
  *is_nan = false;
  if (s.size() != 16) return false;
  uint64_t v = 0;
  for (char c : s) {
    v <<= 4;
    if (c >= '0' && c <= '9') v |= (uint64_t)(c - '0');
    else if (c >= 'a' && c <= 'f') v |= (uint64_t)(c - 'a' + 10);
    else return false;
  }
  *out = v;
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: mathlib_corpus_check <math-corpus.jsonl>\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  if (!in) {
    std::fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }

  std::string line;
  std::getline(in, line);  // header — provenance checked by the JS side; here
                           // we only need the case lines.
  long checked = 0, failed = 0;
  long per_fn[6] = {0, 0, 0, 0, 0, 0};
  const char* fn_names[6] = {"sin", "cos", "atan2", "exp", "pow", "hypot"};

  while (std::getline(in, line)) {
    if (line.empty()) continue;
    std::string f[1], ins[2], outs[1];
    if (extract_strings(line, "f", f) != 1) { std::fprintf(stderr, "bad line: %s\n", line.c_str()); return 2; }
    int nin = extract_strings(line, "i", ins);
    if (nin < 1 || extract_strings(line, "o", outs) != 1) { std::fprintf(stderr, "bad line: %s\n", line.c_str()); return 2; }

    uint64_t in_bits[2] = {0, 0};
    bool in_nan;
    for (int k = 0; k < nin; k++) {
      if (!parse_hex64(ins[k], &in_bits[k], &in_nan)) { std::fprintf(stderr, "bad hex: %s\n", ins[k].c_str()); return 2; }
    }
    uint64_t want_bits;
    bool want_nan;
    if (!parse_hex64(outs[0], &want_bits, &want_nan)) { std::fprintf(stderr, "bad hex: %s\n", outs[0].c_str()); return 2; }

    double a = double_of(in_bits[0]);
    double b = nin > 1 ? double_of(in_bits[1]) : 0.0;
    double got;
    int fn;
    if (f[0] == "sin")        { got = ttp_fd_sin(a);       fn = 0; }
    else if (f[0] == "cos")   { got = ttp_fd_cos(a);       fn = 1; }
    else if (f[0] == "atan2") { got = ttp_fd_atan2(a, b);  fn = 2; }
    else if (f[0] == "exp")   { got = ttp_fd_exp(a);       fn = 3; }
    else if (f[0] == "pow")   { got = ttp_fd_pow(a, b);    fn = 4; }
    else if (f[0] == "hypot") { got = ttp_fd_hypot(a, b);  fn = 5; }
    else { std::fprintf(stderr, "unknown fn: %s\n", f[0].c_str()); return 2; }

    checked++;
    per_fn[fn]++;
    uint64_t got_bits = bits_of(got);
    bool ok = want_nan ? is_nan_bits(got_bits) : (got_bits == want_bits);
    if (!ok) {
      failed++;
      std::fprintf(stderr, "MISMATCH %s(%s%s%s): want %s got %016llx\n",
                   f[0].c_str(), ins[0].c_str(), nin > 1 ? ", " : "",
                   nin > 1 ? ins[1].c_str() : "", outs[0].c_str(),
                   (unsigned long long)got_bits);
      if (failed > 20) { std::fprintf(stderr, "...bailing after 20 mismatches\n"); break; }
    }
  }

  std::printf("mathlib corpus: %ld cases checked, %ld failed (", checked, failed);
  for (int i = 0; i < 6; i++) std::printf("%s %ld%s", fn_names[i], per_fn[i], i < 5 ? ", " : ")\n");
  for (int i = 0; i < 6; i++) {
    if (per_fn[i] < 100) { std::fprintf(stderr, "corpus is missing meaningful %s coverage\n", fn_names[i]); return 2; }
  }
  return failed == 0 ? 0 : 1;
}
