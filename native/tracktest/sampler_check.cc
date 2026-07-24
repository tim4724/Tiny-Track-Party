// Replays tests/fixtures/track-sampler-corpus.jsonl against the NATIVE
// Centerline port (libttp-track) and demands identical IEEE-754 bit patterns —
// the standalone sampler oracle from docs/native-port/plan.md Track S step 2, so
// track-math mismatches isolate here before whole-race trace replay ever runs.
//
// Corpus format (scripts/gen-track-sampler-corpus.mjs), all doubles as
// 16-hex-digit big-endian bit patterns like math-corpus.jsonl:
//   line 1        header {"tracks":[...],"cases":N,"mathlib":...}  (skipped)
//   3 track lines {"track":id,"length":hex,"samples":[[14 hex]...]}  — the
//                 Centerline INPUT (pos3,tangent3,up3,lateral3,width,s per sample)
//   case lines    {"track":id,"q":"sample","s":hex,"out":[13 hex]}       (pos3,tan3,up3,lat3,width)
//                 {"track":id,"q":"width","s":hex,"out":[1 hex]}
//                 {"track":id,"q":"project","p":[3 hex],"sHint":hex,"maxStep":hex,"out":[s,lat]}
// Parsing is a few string scans, deliberately dependency-free (no JSON lib).

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

#include "ttp/centerline.h"
#include "ttp/vec3.h"

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

// Signed magnitude → monotone total order, so adjacent doubles differ by 1.
// (AlmostEqualUlps transform.) Used for diagnostic ulp distance only.
int64_t ulp_key(uint64_t b) {
  return (b >> 63) ? (int64_t)(0x8000000000000000ull - b) : (int64_t)b;
}
uint64_t ulps_between(uint64_t a, uint64_t b) {
  int64_t ka = ulp_key(a), kb = ulp_key(b);
  return (uint64_t)(ka > kb ? ka - kb : kb - ka);
}

bool parse_hex64(const std::string& s, uint64_t* out) {
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

// Index just past `"key":` in a flat JSON object line, or npos.
size_t find_key(const std::string& line, const char* key) {
  const std::string pat = std::string("\"") + key + "\":";
  size_t p = line.find(pat);
  return p == std::string::npos ? p : p + pat.size();
}

// Raw string value of "key": (between the quotes), e.g. the track id or q.
bool read_str(const std::string& line, const char* key, std::string* out) {
  size_t p = find_key(line, key);
  if (p == std::string::npos || line[p] != '"') return false;
  size_t end = line.find('"', p + 1);
  if (end == std::string::npos) return false;
  *out = line.substr(p + 1, end - p - 1);
  return true;
}

// Single hex64 string value of "key": (a quoted 16-hex token).
bool read_hex(const std::string& line, const char* key, uint64_t* out) {
  size_t p = find_key(line, key);
  if (p == std::string::npos || line[p] != '"') return false;
  size_t end = line.find('"', p + 1);
  if (end == std::string::npos) return false;
  return parse_hex64(line.substr(p + 1, end - p - 1), out);
}

// All quoted hex64 tokens inside the (possibly nested) array at "key":. Bracket
// depth bounds the scan so a following key's hex string is never swept up.
bool read_hex_array(const std::string& line, const char* key, std::vector<uint64_t>* out) {
  size_t p = find_key(line, key);
  if (p == std::string::npos) return false;
  while (p < line.size() && line[p] == ' ') p++;
  if (p >= line.size() || line[p] != '[') return false;
  int depth = 0;
  for (; p < line.size(); p++) {
    char c = line[p];
    if (c == '[') {
      depth++;
    } else if (c == ']') {
      if (--depth == 0) return true;
    } else if (c == '"') {
      size_t end = line.find('"', p + 1);
      if (end == std::string::npos) return false;
      uint64_t v;
      if (!parse_hex64(line.substr(p + 1, end - p - 1), &v)) return false;
      out->push_back(v);
      p = end;
    }
  }
  return false;  // unterminated array
}

ttp::Vec3 vec_from(const std::vector<uint64_t>& h, size_t base) {
  return ttp::Vec3(double_of(h[base]), double_of(h[base + 1]), double_of(h[base + 2]));
}

int g_spew = 0;
const int kSpewCap = 20;

// Compare a run's produced doubles against the expected hex64 bit patterns
// (exact uint64 equality — ±0 must match, the JS side wrote real bit patterns).
// Returns true on full match; on mismatch prints up to kSpewCap diagnostics.
bool compare(const std::string& track, const std::string& q, long idx,
             const std::vector<double>& got, const std::vector<uint64_t>& want) {
  bool ok = got.size() == want.size();
  for (size_t k = 0; ok && k < want.size(); k++) ok = bits_of(got[k]) == want[k];
  if (ok) return true;
  if (g_spew < kSpewCap) {
    g_spew++;
    std::fprintf(stderr, "MISMATCH track=%s q=%s case#%ld (%zu comps)\n",
                 track.c_str(), q.c_str(), idx, want.size());
    for (size_t k = 0; k < want.size() && k < got.size(); k++) {
      uint64_t gb = bits_of(got[k]);
      if (gb != want[k]) {
        std::fprintf(stderr, "  [%zu] want %016llx got %016llx (%llu ulp)\n", k,
                     (unsigned long long)want[k], (unsigned long long)gb,
                     (unsigned long long)ulps_between(gb, want[k]));
      }
    }
    if (g_spew == kSpewCap) std::fprintf(stderr, "...capping mismatch spew at %d\n", kSpewCap);
  }
  return false;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: sampler_check <track-sampler-corpus.jsonl>\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  if (!in) {
    std::fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }

  std::string line;
  std::getline(in, line);  // header — provenance is the JS side's concern

  std::vector<std::pair<std::string, ttp::Centerline>> tracks;
  auto find_track = [&](const std::string& id) -> ttp::Centerline* {
    for (auto& t : tracks) if (t.first == id) return &t.second;
    return nullptr;
  };

  long checked = 0, failed = 0;
  long per_q[3] = {0, 0, 0};  // sample, width, project
  long idx = 0;

  while (std::getline(in, line)) {
    if (line.empty()) continue;

    // Track input line.
    if (line.find("\"samples\":") != std::string::npos) {
      std::string id;
      uint64_t len_bits;
      std::vector<uint64_t> flat;
      if (!read_str(line, "track", &id) || !read_hex(line, "length", &len_bits) ||
          !read_hex_array(line, "samples", &flat)) {
        std::fprintf(stderr, "bad track line: %s\n", line.substr(0, 80).c_str());
        return 2;
      }
      if (flat.size() % 14 != 0) {
        std::fprintf(stderr, "track %s: sample stride not 14 (%zu)\n", id.c_str(), flat.size());
        return 2;
      }
      std::vector<ttp::Sample> samples;
      samples.reserve(flat.size() / 14);
      for (size_t b = 0; b < flat.size(); b += 14) {
        ttp::Sample sm;
        sm.pos = vec_from(flat, b + 0);
        sm.tangent = vec_from(flat, b + 3);
        sm.up = vec_from(flat, b + 6);
        sm.lateral = vec_from(flat, b + 9);
        sm.width = double_of(flat[b + 12]);
        sm.s = double_of(flat[b + 13]);
        samples.push_back(sm);
      }
      tracks.emplace_back(id, ttp::Centerline(std::move(samples), double_of(len_bits)));
      continue;
    }

    // Case line.
    std::string id, q;
    if (!read_str(line, "track", &id) || !read_str(line, "q", &q)) {
      std::fprintf(stderr, "bad case line: %s\n", line.substr(0, 80).c_str());
      return 2;
    }
    ttp::Centerline* cl = find_track(id);
    if (!cl) {
      std::fprintf(stderr, "case references unknown track %s\n", id.c_str());
      return 2;
    }

    std::vector<uint64_t> want;
    if (!read_hex_array(line, "out", &want)) {
      std::fprintf(stderr, "case missing out array: %s\n", line.substr(0, 80).c_str());
      return 2;
    }

    std::vector<double> got;
    if (q == "sample") {
      uint64_t s_bits;
      if (!read_hex(line, "s", &s_bits)) { std::fprintf(stderr, "sample missing s\n"); return 2; }
      ttp::Frame f = cl->sampleAt(double_of(s_bits));
      got = {f.pos.x, f.pos.y, f.pos.z, f.tangent.x, f.tangent.y, f.tangent.z,
             f.up.x, f.up.y, f.up.z, f.lateral.x, f.lateral.y, f.lateral.z, f.width};
      per_q[0]++;
    } else if (q == "width") {
      uint64_t s_bits;
      if (!read_hex(line, "s", &s_bits)) { std::fprintf(stderr, "width missing s\n"); return 2; }
      got = {cl->widthAt(double_of(s_bits))};
      per_q[1]++;
    } else if (q == "project") {
      std::vector<uint64_t> p;
      uint64_t sHint_bits, maxStep_bits;
      if (read_hex_array(line, "p", &p) == false || p.size() != 3 ||
          !read_hex(line, "sHint", &sHint_bits) || !read_hex(line, "maxStep", &maxStep_bits)) {
        std::fprintf(stderr, "bad project case: %s\n", line.substr(0, 80).c_str());
        return 2;
      }
      ttp::ProjectResult r =
          cl->projectNear(vec_from(p, 0), double_of(sHint_bits), double_of(maxStep_bits));
      got = {r.s, r.lat};
      per_q[2]++;
    } else {
      std::fprintf(stderr, "unknown q: %s\n", q.c_str());
      return 2;
    }

    checked++;
    if (!compare(id, q, idx, got, want)) failed++;
    idx++;
  }

  std::printf("track sampler corpus: %ld cases checked, %ld failed (sample %ld, width %ld, project %ld)\n",
              checked, failed, per_q[0], per_q[1], per_q[2]);
  if (tracks.size() < 1) { std::fprintf(stderr, "no tracks parsed\n"); return 2; }
  if (per_q[0] < 1 || per_q[1] < 1 || per_q[2] < 1) {
    std::fprintf(stderr, "corpus missing a query kind (sample/width/project)\n");
    return 2;
  }
  return failed == 0 ? 0 : 1;
}
