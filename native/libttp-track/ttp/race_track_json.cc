// See race_track_json.h. Every key order below is the SORTED order the frozen
// corpus was recorded in — do not tidy it into declaration order.

#include "ttp/race_track_json.h"

#include <cstdio>
#include <cstring>
#include <cstdint>

#include "ttp/jsonnum.h"

namespace ttp {
namespace rtjson {

void hex_number(std::string& out, double v) {
  uint64_t u;
  std::memcpy(&u, &v, 8);
  char b[20];
  std::snprintf(b, sizeof b, "x%016llx", (unsigned long long) u);
  out += b;
}

void decimal_number(std::string& out, double v) {
  // Sign-test the BITS, not the value: v < 0 is false for -0.0, and so is
  // std::signbit's usual stand-in v == 0 && 1/v < 0 under fast-math.
  uint64_t u;
  std::memcpy(&u, &v, 8);
  if (u == 0x8000000000000000ull) { out += "-0"; return; }
  js_number_into(v, out);
}

const char* const kTopKeys[] = {
    "autoPoles", "bananas", "boxes", "centerline", "closed", "gap", "groundY",
    "hazards", "hills", "instances", "length", "loopStarts", "pads", "pillars",
    "poles", "roadWidth", "seed", "startGate", "supportPosts", "totalLaps",
    "trackId", "version"};
const int kTopKeyCount = (int) (sizeof(kTopKeys) / sizeof(kTopKeys[0]));

namespace {
void emitBool(std::string& o, bool v) { o += v ? "true" : "false"; }

// Every element emitter takes the Writer so it can spell numbers; free functions
// rather than members so the array template below stays one line.
template <class T, class F>
std::string arr(const std::vector<T>& v, F emit) {
  std::string o = "[";
  for (size_t i = 0; i < v.size(); i++) {
    if (i) o += ",";
    emit(o, v[i]);
  }
  o += "]";
  return o;
}
}  // namespace

void Writer::vec(std::string& o, const Vec3& v) const {
  o += "{\"x\":"; n(o, v.x);
  o += ",\"y\":"; n(o, v.y);
  o += ",\"z\":"; n(o, v.z);
  o += "}";
}

void Writer::sample(std::string& o, const OutSample& s) const {
  o += "{\"hillable\":"; emitBool(o, s.hillable);
  o += ",\"lateral\":"; vec(o, s.lateral);
  o += ",\"pillars\":"; emitBool(o, s.pillars);
  o += ",\"pos\":"; vec(o, s.pos);
  o += ",\"s\":"; n(o, s.s);
  o += ",\"tangent\":"; vec(o, s.tangent);
  o += ",\"up\":"; vec(o, s.up);
  o += ",\"width\":"; n(o, s.width);
  o += "}";
}

void Writer::samples(std::string& o, const std::vector<OutSample>& v,
                     size_t from, size_t to) const {
  o += "[";
  for (size_t i = from; i < to; i++) {
    if (i > from) o += ",";
    sample(o, v[i]);
  }
  o += "]";
}

std::string Writer::hazards(const std::vector<Hazard>& v) const {
  return arr(v, [this](std::string& o, const Hazard& h) {
    o += "{\"lat\":"; n(o, h.lat);
    o += ",\"radius\":"; n(o, h.radius);
    o += ",\"s\":"; n(o, h.s);
    o += "}";
  });
}

std::string Writer::boxes(const std::vector<Box>& v) const {
  return arr(v, [this](std::string& o, const Box& b) {
    o += "{\"lat\":"; n(o, b.lat);
    o += ",\"radius\":"; n(o, b.radius);
    o += ",\"s\":"; n(o, b.s);
    o += "}";
  });
}

std::string Writer::bananas(const std::vector<Banana>& v) const {
  return arr(v, [this](std::string& o, const Banana& b) {
    o += "{\"lat\":"; n(o, b.lat);
    o += ",\"s\":"; n(o, b.s);
    o += "}";
  });
}

std::string Writer::pads(const std::vector<Pad>& v) const {
  return arr(v, [this](std::string& o, const Pad& p) {
    // A strip pad carries a different field set from a disc, and `shape` only
    // appears on the strip — absent means disc, exactly as the JS authored it.
    if (!p.strip) {
      o += "{\"lat\":"; n(o, p.lat);
      o += ",\"radius\":"; n(o, p.radius);
      o += ",\"s\":"; n(o, p.s);
      o += "}";
    } else {
      o += "{\"halfLen\":"; n(o, p.halfLen);
      o += ",\"halfWidth\":"; n(o, p.halfWidth);
      o += ",\"lat\":"; n(o, p.lat);
      o += ",\"s\":"; n(o, p.s);
      o += ",\"shape\":\"strip\"}";
    }
  });
}

std::string Writer::poles(const std::vector<Pole>& v) const {
  return arr(v, [this](std::string& o, const Pole& p) {
    o += "{";
    if (p.ghost) o += "\"ghost\":true,";  // absent, not false, when authored
    o += "\"lat\":"; n(o, p.lat);
    o += ",\"radius\":"; n(o, p.radius);
    o += ",\"s\":"; n(o, p.s);
    o += "}";
  });
}

std::string Writer::autoPoles(const std::vector<AutoPole>& v) const {
  return arr(v, [this](std::string& o, const AutoPole& p) {
    o += "{\"ghost\":true,\"lat\":"; n(o, p.lat);
    o += ",\"radius\":"; n(o, p.radius);
    o += ",\"s\":"; n(o, p.s);
    o += "}";
  });
}

std::string Writer::topKey(const RaceTrack& b, const std::string& k) const {
  std::string o;
  if (k == "version") { n(o, (double) b.version); return o; }
  if (k == "seed") { n(o, (double) b.seed); return o; }
  if (k == "totalLaps") { n(o, (double) b.totalLaps); return o; }
  if (k == "length") { n(o, b.length); return o; }
  if (k == "roadWidth") { n(o, b.roadWidth); return o; }
  if (k == "gap") { n(o, b.gap); return o; }
  if (k == "groundY") { n(o, b.groundY); return o; }
  if (k == "closed") { emitBool(o, b.closed); return o; }
  if (k == "startGate") { emitBool(o, b.startGate); return o; }
  // Track ids are the codegen's own identifiers ([a-z0-9-]), so no escaping can
  // apply; gen-track-defs-header would have failed on anything else.
  if (k == "trackId") { o = "\"" + b.trackId + "\""; return o; }
  // The GLB instance list the JS builder carried for the retired three.js scene
  // graph. Always empty, kept because the schema (and the corpus) still name it.
  if (k == "instances") return "[]";
  if (k == "hazards") return hazards(b.hazards);
  if (k == "boxes") return boxes(b.boxes);
  if (k == "bananas") return bananas(b.bananas);
  if (k == "pads") return pads(b.pads);
  if (k == "poles") return poles(b.poles);
  if (k == "autoPoles") return autoPoles(b.autoPoles);
  if (k == "loopStarts") {
    return arr(b.loopStarts, [this](std::string& o2, const LoopStart& l) {
      o2 += "{\"s\":"; n(o2, l.s);
      o2 += ",\"width\":"; n(o2, l.width);
      o2 += "}";
    });
  }
  if (k == "pillars") {
    return arr(b.pillars, [this](std::string& o2, const Pillar& p) {
      o2 += "{\"baseY\":"; n(o2, p.baseY);
      o2 += ",\"radius\":"; n(o2, p.radius);
      o2 += ",\"topY\":"; n(o2, p.topY);
      o2 += ",\"x\":"; n(o2, p.x);
      o2 += ",\"z\":"; n(o2, p.z);
      o2 += "}";
    });
  }
  if (k == "supportPosts") {
    return arr(b.supportPosts, [this](std::string& o2, const SupportPost& p) {
      o2 += "{\"baseY\":"; n(o2, p.baseY);
      o2 += ",\"contact\":{\"pos\":"; vec(o2, p.contactPos);
      o2 += ",\"up\":"; vec(o2, p.contactUp);
      o2 += "},\"radius\":"; n(o2, p.radius);
      o2 += ",\"x\":"; n(o2, p.x);
      o2 += ",\"z\":"; n(o2, p.z);
      o2 += "}";
    });
  }
  if (k == "hills") {
    // A run of lofted berm rings per raised stretch of deck: array of arrays.
    o = "[";
    for (size_t i = 0; i < b.hills.size(); i++) {
      if (i) o += ",";
      o += arr(b.hills[i], [this](std::string& o2, const HillRing& r) {
        o2 += "{\"cx\":"; n(o2, r.cx);
        o2 += ",\"cz\":"; n(o2, r.cz);
        o2 += ",\"halfW\":"; n(o2, r.halfW);
        o2 += ",\"lx\":"; n(o2, r.lx);
        o2 += ",\"lz\":"; n(o2, r.lz);
        o2 += ",\"topL\":"; n(o2, r.topL);
        o2 += ",\"topR\":"; n(o2, r.topR);
        o2 += "}";
      });
    }
    o += "]";
    return o;
  }
  if (k == "centerline") {
    o = "{\"length\":"; n(o, b.length);
    o += ",\"samples\":"; samples(o, b.samples, 0, b.samples.size());
    o += "}";
    return o;
  }
  return {};  // unknown — the caller decides whether that is fatal
}

std::string Writer::object(const RaceTrack& b) const {
  std::string o = "{";
  for (int i = 0; i < kTopKeyCount; i++) {
    if (i) o += ",";
    o += "\"";
    o += kTopKeys[i];
    o += "\":";
    o += topKey(b, kTopKeys[i]);
  }
  o += "}";
  return o;
}

}  // namespace rtjson
}  // namespace ttp
