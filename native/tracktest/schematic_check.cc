// Schematic conformance check — replays tests/fixtures/schematic-corpus.jsonl
// against native/libttp-track/ttp/schematic.h.
//
// JS-RECORDED evidence, and the reason it counts as such is worth stating: the
// per-track expectations come from public/shared/trackSchematics.js, which is
// COMMITTED, was baked by the JS trackSchematic(), and is already held to the
// live geometry by tests/track.test.js. This binary rebuilds each track through
// libttp-track's own TrackBuilder and has to reproduce those bytes exactly — the
// projection, the toFixed rounding, the path spelling, the RDP survivors and the
// base64. It is not C++ agreeing with C++.//
// --record RE-EMITS, IT DOES NOT REGENERATE. `--record <fixture> --out=<f>`
// rebuilds each case from its recorded id/path and writes the corpus back with
// the C++'s answers; record_schematic holds the result byte-identical. It cannot
// invent a case — the track ids and codec paths are read off the committed file
// — so what it proves is that the port reproduces every recorded answer and its
// exact JSON spelling. It is NOT parity evidence: the committed bytes carry
// that, and the JS bake wrote them. If a re-record ever differs, the committed
// file is right.
//
// Line 1 is a header. Then:
//   {case:"track", id, schematic:{viewBox,d,start,proj}, packed, unpacked}
//   {case:"codec", name, d, eps, packed, unpacked}
// The codec cases carry their own path, so they reach shapes no shipped layout
// contains (an empty path, a two-point path, a collinear run, a hairpin, both
// ends of the byte range, a tighter and a looser eps).

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "corpus_diff.h"
#include "corpus_record.h"
#include "generated/track_defs.h"
#include "ttp/canonical.h"
#include "ttp/json_read.h"
#include "ttp/schematic.h"
#include "ttp/trackbuilder.h"

using namespace ttp;
using namespace ttp::corpus;
namespace sch = ttp::schematic;

namespace {

Value schematicValue(const sch::Schematic& s) {
  Value o = Value::Obj();
  o.set("viewBox", Value::Str(s.viewBox));
  o.set("d", Value::Str(s.d));
  if (s.hasStart) {
    Value st = Value::Obj();
    st.set("x", Value::Num(s.start.x));
    st.set("y", Value::Num(s.start.y));
    o.set("start", std::move(st));
  } else {
    o.set("start", Value::Null());
  }
  if (s.hasProj) {
    Value p = Value::Obj();
    p.set("minX", Value::Num(s.proj.minX));
    p.set("minZ", Value::Num(s.proj.minZ));
    p.set("scale", Value::Num(s.proj.scale));
    p.set("offX", Value::Num(s.proj.offX));
    p.set("offZ", Value::Num(s.proj.offZ));
    o.set("proj", std::move(p));
  }
  return o;
}

const TrackDef* findDef(const std::string& id) {
  for (int i = 0; i < TTP_TRACK_TOTAL; i++) {
    if (id == TTP_TRACKS[i].id) return &TTP_TRACKS[i];
  }
  return nullptr;
}

int spew = 0;
bool report(const char* label, const std::string& who, const Value& exp, const Value& act) {
  const Diff d = diff_val(exp, act, label);
  if (!d.differ) return true;
  if (spew++ < 20) {
    std::fprintf(stderr, "FAIL %s\n  piece %s  path %s\n  expected %s\n  actual   %s\n",
                 who.c_str(), label, d.path.c_str(), d.expected.c_str(), d.actual.c_str());
  }
  return false;
}

}  // namespace

// Re-emit the corpus from the port: each track is rebuilt through libttp-track's
// own TrackBuilder and re-projected, each codec case re-packed from its path.
int recordCorpus(const std::string& fixture, const std::string& outPath) {
  bool bad = false;
  const int rc = corpus::record(fixture, outPath, [&](const Value& rec) {
    const std::string kind = strOf(rec, "case");
    if (kind == "track") {
      const std::string id = strOf(rec, "id");
      const TrackDef* def = findDef(id);
      if (!def) { std::fprintf(stderr, "--record: no such track %s\n", id.c_str()); bad = true; return Value(); }
      const RaceTrack rt = build_race_track(*def, 3, 1);
      const sch::Schematic sc = sch::build(rt);
      const std::string packed = sch::pack(sc.d);
      Value line = Value::Obj();
      line.set("case", Value::Str("track"));
      line.set("id", Value::Str(id));
      line.set("schematic", schematicValue(sc));
      line.set("packed", Value::Str(packed));
      line.set("unpacked", schematicValue(sch::unpack(packed)));
      return line;
    }
    if (kind == "codec") {
      const std::string d = strOf(rec, "d");
      const double eps = numOf(rec, "eps");
      const std::string packed = sch::pack(d, eps > 0 ? eps : sch::EPS);
      Value line = Value::Obj();
      line.set("case", Value::Str("codec"));
      line.set("name", Value::Str(strOf(rec, "name")));
      line.set("d", Value::Str(d));
      if (rec.find("eps")) line.set("eps", Value::Num(eps));
      line.set("packed", Value::Str(packed));
      line.set("unpacked", schematicValue(sch::unpack(packed)));
      return line;
    }
    return Value();   // UNDEF: the header, copied through
  });
  return (rc == 0 && !bad) ? 0 : 1;
}

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: schematic_check <schematic-corpus.jsonl>\n"
                         "       schematic_check --record <corpus> --out=<file>\n");
    return 2;
  }
  {
    std::string fixture, outPath;
    if (corpus::wants_record(argc, argv, &fixture, &outPath)) return recordCorpus(fixture, outPath);
  }
  std::ifstream f(argv[1]);
  if (!f) {
    std::fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }

  std::string line, err;
  if (!std::getline(f, line)) {
    std::fprintf(stderr, "empty corpus\n");
    return 2;
  }
  Value header;
  if (!read_line(line, header, &err)) {
    std::fprintf(stderr, "bad header: %s\n", err.c_str());
    return 2;
  }
  // The three shape constants are compiled into the library; a corpus recorded
  // against a different VIEW/PAD/eps would compare green while describing a
  // different map, so pin them rather than assume them.
  if (json::num_field(header, "view") != sch::VIEW || json::num_field(header, "pad") != sch::PAD ||
      json::num_field(header, "eps") != sch::EPS) {
    std::fprintf(stderr, "FAIL: corpus was recorded at VIEW/PAD/eps %g/%g/%g, library has %d/%d/%g\n",
                 json::num_field(header, "view"), json::num_field(header, "pad"), json::num_field(header, "eps"),
                 sch::VIEW, sch::PAD, sch::EPS);
    return 1;
  }

  int tracks = 0, codec = 0, failures = 0;
  while (std::getline(f, line)) {
    if (line.empty()) continue;
    Value rec;
    if (!read_line(line, rec, &err)) {
      std::fprintf(stderr, "bad line: %s\n", err.c_str());
      return 2;
    }
    const std::string kind = json::str_field(rec, "case");

    if (kind == "track") {
      const std::string id = json::str_field(rec, "id");
      const TrackDef* def = findDef(id);
      if (!def) {
        std::fprintf(stderr, "FAIL %s: no such track in generated/track_defs.h\n", id.c_str());
        failures++;
        continue;
      }
      // Laps and seed touch furniture, never the centreline the map is drawn
      // from, so any values reproduce the baked schematic.
      const RaceTrack rt = build_race_track(*def, 3, 1);
      const sch::Schematic s = sch::build(rt);
      const Value got = schematicValue(s);
      bool ok = true;
      const Value* expS = rec.find("schematic");
      if (expS) ok &= report("schematic", "track " + id, *expS, got);

      const std::string packed = sch::pack(s.d);
      const Value* expP = rec.find("packed");
      if (expP) ok &= report("packed", "track " + id, *expP, Value::Str(packed));

      const Value* expU = rec.find("unpacked");
      if (expU) ok &= report("unpacked", "track " + id, *expU, schematicValue(sch::unpack(packed)));

      // The claims tests/track.test.js makes about the codec's PURPOSE, restated
      // against the native side: the packed form must be a hard reduction (the
      // whole catalogue has to fit the relay's 16 KiB set_state cap) and every
      // survivor must land in the byte range the format assumes.
      const size_t full = sch::points_of(s.d).size();
      const size_t kept = sch::points_of(sch::unpack(packed).d).size();
      if (!(kept < 150 && full > 0 && kept * 4 < full)) {
        std::fprintf(stderr, "FAIL track %s: expected an aggressive reduction, got %zu of %zu\n",
                     id.c_str(), kept, full);
        ok = false;
      }
      for (const sch::Point& pt : sch::points_of(sch::unpack(packed).d)) {
        if (pt.x < 0 || pt.x > 255 || pt.y < 0 || pt.y > 255) {
          std::fprintf(stderr, "FAIL track %s: packed point out of the byte range\n", id.c_str());
          ok = false;
          break;
        }
      }
      if (!ok) failures++;
      tracks++;
      continue;
    }

    if (kind == "codec") {
      const std::string name = json::str_field(rec, "name");
      const std::string d = json::str_field(rec, "d");
      const double eps = json::num_field(rec, "eps");
      const std::string packed = sch::pack(d, eps > 0 ? eps : sch::EPS);
      bool ok = true;
      const Value* expP = rec.find("packed");
      if (expP) ok &= report("packed", "codec " + name, *expP, Value::Str(packed));
      const Value* expU = rec.find("unpacked");
      if (expU) ok &= report("unpacked", "codec " + name, *expU, schematicValue(sch::unpack(packed)));
      if (!ok) failures++;
      codec++;
      continue;
    }
  }

  std::printf("schematic corpus: %d tracks, %d codec cases, %d failures\n", tracks, codec, failures);
  return failures ? 1 : 0;
}
