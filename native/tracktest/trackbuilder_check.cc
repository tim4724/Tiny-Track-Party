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
//
// The hexJSON walk itself lives in ttp/race_track_json.h, shared with the decimal
// spelling ttp_track_json hands to the Node scripts. That sharing is the point:
// this check is the only thing that proves the walk still reproduces the retired
// JS builder's output, and it has to be judging the SAME walk the scripts read.

#include <algorithm>
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
#include "ttp/race_track_json.h"
#include "ttp/trackbuilder.h"
#include "ttp/vec3.h"
#include "generated/track_defs.h"

namespace {

using ttp::RaceTrack;
using ttp::Value;

using ttp::fnv1a_hex;
using ttp::json_quote;

// The corpus's number spelling: x<16-hex IEEE-754 bits>, so nothing in this
// comparison depends on decimal formatting on either side.
const ttp::rtjson::Writer kHex(ttp::rtjson::hex_number);

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

// The corpus line for one track, spelled as gen-trackbuilder-corpus.mjs spells
// it (field order, JSON.stringify's quoting), with the hashes and hexJSON taken
// from THIS build. --record re-emits the committed file through it, so the key
// set and the track list come off the fixture; it can add neither. False when
// the fixture carries a key this build cannot emit.
bool emitLine(const std::string& id, const Value& jKeys, const RaceTrack& b, std::string& o) {
  o = "{\"track\":" + json_quote(id)
      + ",\"sampleCount\":" + std::to_string(b.samples.size()) + ",\"keys\":{";
  bool first = true;
  for (const auto& kv : jKeys.obj) {
    const std::string hj = kHex.topKey(b, kv.first);
    if (hj.empty()) return false;
    o += (first ? "" : ",") + json_quote(kv.first) + ":" + json_quote(fnv1a_hex(hj));
    first = false;
  }
  o += "},\"chunks\":[";
  for (size_t c = 0; c < b.samples.size(); c += 64) {
    std::string chj;
    kHex.samples(chj, b.samples, c, std::min(c + 64, b.samples.size()));
    o += (c ? "," : "") + json_quote(fnv1a_hex(chj));
  }
  std::string fs;
  kHex.samples(fs, b.samples, 0, std::min<size_t>(2, b.samples.size()));
  o += "],\"firstSamples\":" + json_quote(fs) + ",\"furniture\":{";
  o += "\"hazards\":" + json_quote(kHex.hazards(b.hazards));
  o += ",\"pads\":" + json_quote(kHex.pads(b.pads));
  o += ",\"boxes\":" + json_quote(kHex.boxes(b.boxes));
  o += ",\"poles\":" + json_quote(kHex.poles(b.poles));
  o += ",\"bananas\":" + json_quote(kHex.bananas(b.bananas));
  o += ",\"autoPoles\":" + json_quote(kHex.autoPoles(b.autoPoles));
  o += "}}";
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  bool record = false;
  std::string fixture, outPath;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    if (a == "--record") record = true;
    else if (a.rfind("--out=", 0) == 0) outPath = a.substr(6);
    else fixture = a;
  }
  if (fixture.empty() || (record && outPath.empty())) {
    std::fprintf(stderr, "usage: trackbuilder_check <trackbuilder-corpus.jsonl> [--record --out=<f>]\n");
    return 2;
  }
  std::ifstream in(fixture);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", fixture.c_str()); return 2; }
  std::ofstream out;
  if (record) {
    out.open(outPath);
    if (!out) { std::fprintf(stderr, "cannot write %s\n", outPath.c_str()); return 2; }
  }

  std::string line;
  std::getline(in, line);  // header — provenance is the JS side's concern
  if (record) out << line << "\n";

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

    if (record) {
      std::string emitted;
      if (!emitLine(id, *jKeys, b, emitted)) {
        std::fprintf(stderr, "%s: corpus carries a key the check cannot emit (schema drift)\n", id.c_str());
        return 2;
      }
      out << emitted << "\n";
      continue;
    }

    if (jCount && (size_t)jCount->num != b.samples.size()) {
      std::fprintf(stderr, "%s: sampleCount %zu, corpus %ld\n", id.c_str(), b.samples.size(), (long)jCount->num);
      reqFail++;  // centerline shape drift — treat as a required-key failure
    }

    // Per top-level key: fnv1a(hexJSON) vs the corpus hash.
    for (const auto& kv : jKeys->obj) {
      const std::string& key = kv.first;
      const std::string& want = kv.second.str;
      std::string hj = kHex.topKey(b, key);
      if (hj.empty() && !(key == "instances")) {
        std::fprintf(stderr, "%s: corpus carries key '%s' the check cannot emit (schema drift)\n",
                     id.c_str(), key.c_str());
        unknownKeys++;
        continue;
      }
      std::string got = fnv1a_hex(hj);
      bool req = kRequired.count(key) > 0;
      if (got != want) {
        std::fprintf(stderr, "MISMATCH %s key=%s (%s) want=%s got=%s\n", id.c_str(), key.c_str(),
                     req ? "REQUIRED" : "stretch", want.c_str(), got.c_str());
        if (req) reqFail++; else stretchFail++;
        // Localize a centerline mismatch to the diverging 64-sample chunk.
        if (key == "centerline") {
          for (size_t c = 0, idx = 0; c < b.samples.size(); c += 64, idx++) {
            size_t to = c + 64 < b.samples.size() ? c + 64 : b.samples.size();
            std::string chj; kHex.samples(chj, b.samples, c, to);
            std::string cgot = fnv1a_hex(chj);
            std::string cwant = idx < jChunks->arr.size() ? jChunks->arr[idx].str : "<none>";
            if (cgot != cwant)
              std::fprintf(stderr, "    chunk[%zu] samples[%zu..%zu) want=%s got=%s\n",
                           idx, c, to, cwant.c_str(), cgot.c_str());
          }
          std::string fs; kHex.samples(fs, b.samples, 0, b.samples.size() < 2 ? b.samples.size() : 2);
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
    furnCheck("hazards", kHex.hazards(b.hazards));
    furnCheck("pads", kHex.pads(b.pads));
    furnCheck("boxes", kHex.boxes(b.boxes));
    furnCheck("poles", kHex.poles(b.poles));
    furnCheck("bananas", kHex.bananas(b.bananas));
    furnCheck("autoPoles", kHex.autoPoles(b.autoPoles));
  }

  if (record) {
    std::printf("recorded %ld tracks to %s\n", tracks, outPath.c_str());
    return 0;
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
