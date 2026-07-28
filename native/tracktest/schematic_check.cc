// Schematic conformance check — replays tests/fixtures/schematic-corpus.jsonl
// against native/libttp-track/ttp/schematic.h.
//
// JS-RECORDED evidence, and the reason it counts as such is worth stating: the
// per-track expectations come from public/shared/trackSchematics.js, which is
// COMMITTED, was baked by the JS trackSchematic(), and is already held to the
// live geometry by tests/track.test.js. This binary rebuilds each track through
// libttp-track's own TrackBuilder and has to reproduce those bytes exactly — the
// projection, the toFixed rounding, the path spelling, the RDP survivors and the
// base64. It is not C++ agreeing with C++, and there is no --record mode.
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
#include "generated/track_defs.h"
#include "ttp/canonical.h"
#include "ttp/schematic.h"
#include "ttp/trackbuilder.h"

using namespace ttp;
using namespace ttp::corpus;
namespace sch = ttp::schematic;

namespace {

std::string strOf(const Value& o, const char* k) {
  const Value* v = o.find(k);
  return (v && v->type == Value::STR) ? v->str : std::string();
}
double numOf(const Value& o, const char* k, double dflt = 0) {
  const Value* v = o.find(k);
  return (v && v->type == Value::NUM) ? v->num : dflt;
}

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

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: schematic_check <schematic-corpus.jsonl>\n");
    return 2;
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
  if (numOf(header, "view") != sch::VIEW || numOf(header, "pad") != sch::PAD ||
      numOf(header, "eps") != sch::EPS) {
    std::fprintf(stderr, "FAIL: corpus was recorded at VIEW/PAD/eps %g/%g/%g, library has %d/%d/%g\n",
                 numOf(header, "view"), numOf(header, "pad"), numOf(header, "eps"),
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
    const std::string kind = strOf(rec, "case");

    if (kind == "track") {
      const std::string id = strOf(rec, "id");
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
      const std::string name = strOf(rec, "name");
      const std::string d = strOf(rec, "d");
      const double eps = numOf(rec, "eps");
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
