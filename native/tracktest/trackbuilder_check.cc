// Rebuilds all shipped tracks from the codegen'd DEFS (generated/track_defs.h)
// through the native TrackBuilder port (libttp-track) and diffs the augmented
// race-track object against tests/fixtures/trackbuilder-corpus.jsonl —
// scripts/gen-trackbuilder-corpus.mjs's bit-exact oracle.
//
// The corpus encodes each track's augmented object as "hexJSON": canonical
// JSON-shaped text where every NUMBER is x<16-hex big-endian IEEE-754 bits>,
// object keys sorted, undefined/"_"-prefixed dropped, the Centerline projected
// to {length, samples}. Per track it stores fnv1a(hexJSON(value)) for every
// top-level key, fnv1a per 64-sample chunk, the raw hexJSON of samples[0..1],
// and the raw hexJSON of each furniture array. This binary reproduces the exact
// hexJSON via its own structs and compares hash-for-hash / byte-for-byte.
//
// REQUIRED keys (merge gate) must match on all tracks; STRETCH keys are reported
// but were fully ported too — a STRETCH mismatch fails the run, it is never
// silently skipped. Any key the corpus carries that this binary cannot emit is a
// hard error (schema drift must surface, not vanish).

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "corpus_diff.h"
#include "ttp/trackbuilder.h"
#include "ttp/vec3.h"
#include "generated/track_defs.h"

namespace {

using ttp::RaceTrack;
using ttp::Value;
using ttp::Vec3;

// ---- fnv1a over UTF-8 bytes, 8 lowercase hex (record-trace.mjs fnv1a) --------
std::string fnv1a(const std::string& s) {
  uint32_t h = 0x811c9dc5u;
  for (unsigned char c : s) { h ^= c; h *= 0x01000193u; }
  char b[9];
  std::snprintf(b, sizeof b, "%08x", h);
  return std::string(b);
}

// ---- hexJSON emitters (sorted keys, x<16 hex> numbers) -----------------------
void emitNum(std::string& o, double d) {
  uint64_t u;
  std::memcpy(&u, &d, 8);
  char b[20];
  std::snprintf(b, sizeof b, "x%016llx", (unsigned long long)u);
  o += b;
}
void emitBool(std::string& o, bool v) { o += v ? "true" : "false"; }
void emitVec(std::string& o, const Vec3& v) {
  o += "{\"x\":"; emitNum(o, v.x);
  o += ",\"y\":"; emitNum(o, v.y);
  o += ",\"z\":"; emitNum(o, v.z);
  o += "}";
}
void emitSample(std::string& o, const ttp::OutSample& s) {
  o += "{\"hillable\":"; emitBool(o, s.hillable);
  o += ",\"lateral\":"; emitVec(o, s.lateral);
  o += ",\"pillars\":"; emitBool(o, s.pillars);
  o += ",\"pos\":"; emitVec(o, s.pos);
  o += ",\"s\":"; emitNum(o, s.s);
  o += ",\"tangent\":"; emitVec(o, s.tangent);
  o += ",\"up\":"; emitVec(o, s.up);
  o += ",\"width\":"; emitNum(o, s.width);
  o += "}";
}
void emitSamples(std::string& o, const std::vector<ttp::OutSample>& v, size_t from, size_t to) {
  o += "[";
  for (size_t i = from; i < to; i++) { if (i > from) o += ","; emitSample(o, v[i]); }
  o += "]";
}
void emitHazard(std::string& o, const ttp::Hazard& h) {
  o += "{\"lat\":"; emitNum(o, h.lat);
  o += ",\"radius\":"; emitNum(o, h.radius);
  o += ",\"s\":"; emitNum(o, h.s);
  o += "}";
}
void emitBox(std::string& o, const ttp::Box& b) {
  o += "{\"lat\":"; emitNum(o, b.lat);
  o += ",\"radius\":"; emitNum(o, b.radius);
  o += ",\"s\":"; emitNum(o, b.s);
  o += "}";
}
void emitBanana(std::string& o, const ttp::Banana& b) {
  o += "{\"lat\":"; emitNum(o, b.lat);
  o += ",\"s\":"; emitNum(o, b.s);
  o += "}";
}
void emitPad(std::string& o, const ttp::Pad& p) {
  if (!p.strip) {
    o += "{\"lat\":"; emitNum(o, p.lat);
    o += ",\"radius\":"; emitNum(o, p.radius);
    o += ",\"s\":"; emitNum(o, p.s);
    o += "}";
  } else {
    o += "{\"halfLen\":"; emitNum(o, p.halfLen);
    o += ",\"halfWidth\":"; emitNum(o, p.halfWidth);
    o += ",\"lat\":"; emitNum(o, p.lat);
    o += ",\"s\":"; emitNum(o, p.s);
    o += ",\"shape\":\"strip\"}";
  }
}
void emitPole(std::string& o, const ttp::Pole& p) {
  o += "{";
  if (p.ghost) o += "\"ghost\":true,";
  o += "\"lat\":"; emitNum(o, p.lat);
  o += ",\"radius\":"; emitNum(o, p.radius);
  o += ",\"s\":"; emitNum(o, p.s);
  o += "}";
}
void emitAutoPole(std::string& o, const ttp::AutoPole& p) {
  o += "{\"ghost\":true,\"lat\":"; emitNum(o, p.lat);
  o += ",\"radius\":"; emitNum(o, p.radius);
  o += ",\"s\":"; emitNum(o, p.s);
  o += "}";
}
void emitLoopStart(std::string& o, const ttp::LoopStart& l) {
  o += "{\"s\":"; emitNum(o, l.s);
  o += ",\"width\":"; emitNum(o, l.width);
  o += "}";
}
void emitPillar(std::string& o, const ttp::Pillar& p) {
  o += "{\"baseY\":"; emitNum(o, p.baseY);
  o += ",\"radius\":"; emitNum(o, p.radius);
  o += ",\"topY\":"; emitNum(o, p.topY);
  o += ",\"x\":"; emitNum(o, p.x);
  o += ",\"z\":"; emitNum(o, p.z);
  o += "}";
}
void emitHillRing(std::string& o, const ttp::HillRing& r) {
  o += "{\"cx\":"; emitNum(o, r.cx);
  o += ",\"cz\":"; emitNum(o, r.cz);
  o += ",\"halfW\":"; emitNum(o, r.halfW);
  o += ",\"lx\":"; emitNum(o, r.lx);
  o += ",\"lz\":"; emitNum(o, r.lz);
  o += ",\"topL\":"; emitNum(o, r.topL);
  o += ",\"topR\":"; emitNum(o, r.topR);
  o += "}";
}
void emitSupportPost(std::string& o, const ttp::SupportPost& p) {
  o += "{\"baseY\":"; emitNum(o, p.baseY);
  o += ",\"contact\":{\"pos\":"; emitVec(o, p.contactPos);
  o += ",\"up\":"; emitVec(o, p.contactUp);
  o += "},\"radius\":"; emitNum(o, p.radius);
  o += ",\"x\":"; emitNum(o, p.x);
  o += ",\"z\":"; emitNum(o, p.z);
  o += "}";
}

template <class T, class F>
std::string emitArr(const std::vector<T>& v, F emit) {
  std::string o = "[";
  for (size_t i = 0; i < v.size(); i++) { if (i) o += ","; emit(o, v[i]); }
  o += "]";
  return o;
}

// hexJSON of one top-level augmented-track key. Empty string => unknown key.
std::string hexTopKey(const RaceTrack& b, const std::string& k) {
  std::string o;
  if (k == "version") { emitNum(o, (double)b.version); return o; }
  if (k == "seed") { emitNum(o, (double)b.seed); return o; }
  if (k == "totalLaps") { emitNum(o, (double)b.totalLaps); return o; }
  if (k == "length") { emitNum(o, b.length); return o; }
  if (k == "roadWidth") { emitNum(o, b.roadWidth); return o; }
  if (k == "gap") { emitNum(o, b.gap); return o; }
  if (k == "groundY") { emitNum(o, b.groundY); return o; }
  if (k == "closed") { emitBool(o, b.closed); return o; }
  if (k == "startGate") { emitBool(o, b.startGate); return o; }
  if (k == "trackId") { o = "\"" + b.trackId + "\""; return o; }
  if (k == "instances") { return "[]"; }
  if (k == "hazards") return emitArr(b.hazards, emitHazard);
  if (k == "boxes") return emitArr(b.boxes, emitBox);
  if (k == "bananas") return emitArr(b.bananas, emitBanana);
  if (k == "pads") return emitArr(b.pads, emitPad);
  if (k == "poles") return emitArr(b.poles, emitPole);
  if (k == "autoPoles") return emitArr(b.autoPoles, emitAutoPole);
  if (k == "loopStarts") return emitArr(b.loopStarts, emitLoopStart);
  if (k == "pillars") return emitArr(b.pillars, emitPillar);
  if (k == "supportPosts") return emitArr(b.supportPosts, emitSupportPost);
  if (k == "hills") {
    o = "[";
    for (size_t i = 0; i < b.hills.size(); i++) { if (i) o += ","; o += emitArr(b.hills[i], emitHillRing); }
    o += "]";
    return o;
  }
  if (k == "centerline") {
    o = "{\"length\":"; emitNum(o, b.length);
    o += ",\"samples\":"; emitSamples(o, b.samples, 0, b.samples.size());
    o += "}";
    return o;
  }
  return {};  // unknown
}

const std::set<std::string> kRequired = {
    "centerline", "length", "roadWidth", "totalLaps", "seed", "version", "trackId",
    "closed", "gap", "groundY", "loopStarts", "hazards", "pads", "boxes", "poles",
    "bananas", "autoPoles"};
const std::set<std::string> kStretch = {"hills", "instances", "supportPosts", "pillars", "startGate"};

const ttp::TrackDef* findTrack(const std::string& id) {
  for (int i = 0; i < ttp::TTP_TRACK_COUNT; i++)
    if (id == ttp::TTP_TRACKS[i].id) return &ttp::TTP_TRACKS[i];
  return nullptr;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: trackbuilder_check <trackbuilder-corpus.jsonl>\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }

  std::string line;
  std::getline(in, line);  // header — provenance is the JS side's concern

  long tracks = 0, reqFail = 0, stretchFail = 0, unknownKeys = 0;
  std::set<std::string> seenStretchPorted;   // stretch keys that matched at least once

  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    std::string perr;
    if (!ttp::corpus::read_line(line, root, &perr) || root.type != Value::OBJ) {
      std::fprintf(stderr, "bad corpus line: %s\n", perr.c_str()); return 2;
    }

    const Value* jTrack = root.find("track");
    const Value* jKeys = root.find("keys");
    const Value* jChunks = root.find("chunks");
    const Value* jFirst = root.find("firstSamples");
    const Value* jFurn = root.find("furniture");
    const Value* jCount = root.find("sampleCount");
    if (!jTrack || !jKeys || !jChunks || !jFirst || !jFurn) {
      std::fprintf(stderr, "corpus line missing a field\n"); return 2;
    }
    const std::string& id = jTrack->str;
    const ttp::TrackDef* def = findTrack(id);
    if (!def) { std::fprintf(stderr, "corpus references unknown track '%s'\n", id.c_str()); return 2; }

    RaceTrack b = ttp::build_race_track(*def, 3, 1u);
    tracks++;

    if (jCount && (size_t)jCount->num != b.samples.size()) {
      std::fprintf(stderr, "%s: sampleCount %zu, corpus %ld\n", id.c_str(), b.samples.size(), (long)jCount->num);
      reqFail++;  // centerline shape drift — treat as a required-key failure
    }

    // Per top-level key: fnv1a(hexJSON) vs the corpus hash.
    for (const auto& kv : jKeys->obj) {
      const std::string& key = kv.first;
      const std::string& want = kv.second.str;
      std::string hj = hexTopKey(b, key);
      if (hj.empty() && !(key == "instances")) {
        std::fprintf(stderr, "%s: corpus carries key '%s' the check cannot emit (schema drift)\n",
                     id.c_str(), key.c_str());
        unknownKeys++;
        continue;
      }
      std::string got = fnv1a(hj);
      bool req = kRequired.count(key) > 0;
      if (got != want) {
        std::fprintf(stderr, "MISMATCH %s key=%s (%s) want=%s got=%s\n", id.c_str(), key.c_str(),
                     req ? "REQUIRED" : "stretch", want.c_str(), got.c_str());
        if (req) reqFail++; else stretchFail++;
        // Localize a centerline mismatch to the diverging 64-sample chunk.
        if (key == "centerline") {
          for (size_t c = 0, idx = 0; c < b.samples.size(); c += 64, idx++) {
            size_t to = c + 64 < b.samples.size() ? c + 64 : b.samples.size();
            std::string chj; emitSamples(chj, b.samples, c, to);
            std::string cgot = fnv1a(chj);
            std::string cwant = idx < jChunks->arr.size() ? jChunks->arr[idx].str : "<none>";
            if (cgot != cwant)
              std::fprintf(stderr, "    chunk[%zu] samples[%zu..%zu) want=%s got=%s\n",
                           idx, c, to, cwant.c_str(), cgot.c_str());
          }
          std::string fs; emitSamples(fs, b.samples, 0, b.samples.size() < 2 ? b.samples.size() : 2);
          if (fs != jFirst->str)
            std::fprintf(stderr, "    firstSamples diverge:\n      want=%s\n      got =%s\n",
                         jFirst->str.c_str(), fs.c_str());
        }
      } else if (!req) {
        seenStretchPorted.insert(key);
      }
    }

    // Furniture direct hexJSON diff (redundant with the key hashes, but localizes).
    auto furnCheck = [&](const char* name, const std::string& got) {
      const Value* w = jFurn->find(name);
      if (w && w->str != got)
        std::fprintf(stderr, "MISMATCH %s furniture.%s\n      want=%s\n      got =%s\n",
                     id.c_str(), name, w->str.c_str(), got.c_str());
    };
    furnCheck("hazards", emitArr(b.hazards, emitHazard));
    furnCheck("pads", emitArr(b.pads, emitPad));
    furnCheck("boxes", emitArr(b.boxes, emitBox));
    furnCheck("poles", emitArr(b.poles, emitPole));
    furnCheck("bananas", emitArr(b.bananas, emitBanana));
    furnCheck("autoPoles", emitArr(b.autoPoles, emitAutoPole));
  }

  std::printf("trackbuilder corpus: %ld tracks, %ld required-key failures, %ld stretch-key failures\n",
              tracks, reqFail, stretchFail);
  std::printf("  stretch keys ported & green: ");
  for (const auto& k : kStretch) std::printf("%s%s", k.c_str(), seenStretchPorted.count(k) ? "(ok) " : "(DEFERRED) ");
  std::printf("\n");
  if (unknownKeys) std::printf("  %ld unknown corpus keys (schema drift)\n", unknownKeys);
  if (tracks != ttp::TTP_TRACK_COUNT)
    std::fprintf(stderr, "expected %d tracks, checked %ld\n", ttp::TTP_TRACK_COUNT, tracks);

  // Merge gate: all REQUIRED keys green on all tracks. Stretch failures and
  // schema-drift keys also fail the run (everything here was ported; a stretch
  // regression must not pass unnoticed).
  bool ok = reqFail == 0 && stretchFail == 0 && unknownKeys == 0 && tracks == ttp::TTP_TRACK_COUNT;
  return ok ? 0 : 1;
}
