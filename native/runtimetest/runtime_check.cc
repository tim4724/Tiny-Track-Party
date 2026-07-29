// runtime_check — the chase camera, the framing/fog solve and the split-screen
// grid, replayed against a frozen corpus.
//
// WHAT THIS IS. C++-AUTHORED regression evidence — class 2 in
// tests/fixtures/traces/README.md. ChaseCamera.js and SceneRenderer's overview
// rigs were deleted with the JS renderer, so there is no oracle left to record
// against: this proves the cameras still do what they did when this was
// recorded, and says NOTHING about whether the port from JS was right. Only the
// golden traces can settle a parity question, and they never reach this code.
//
// WHY IT EXISTS. Until libttp-runtime, every line under test here lived in
// runtime/ttp_display.cc (since DELETED — git history has it), behind the
// Filament gate: ~500 lines of camera,
// framing and frame-assembly logic that names no platform API, compiled on
// exactly one machine configuration in the world and exercised by none of the
// ctests on any of the four legs.
//
// WHY THE NUMBERS ARE QUANTIZED, uniquely in this tree. Every other corpus here
// is bit-exact, because the sim routes each transcendental through the vendored
// fdlibm. The camera math deliberately does not — it is cosmetic float (see
// vecmath.h) and calls the PLATFORM's expf/logf/tanf/atan2f. Apple libm, glibc
// and musl (which is what emscripten ships) agree on those to about a ulp, not
// to the bit, so a corpus of raw float bits would be green on the machine that
// recorded it and red on the other three legs.
//
// So each recorded number is rounded to 4 significant decimal digits, and the
// recorder REFUSES to freeze a value sitting close enough to a rounding boundary
// that a one-ulp difference could flip it. A value that clears that guard is
// stable by construction: one ulp is ~1e-4 of a quantization step, and the guard
// keeps every value at least 1e-2 of a step clear of the boundary — 80x the
// disagreement. Do not read more precision into this fixture than it has: it
// pins behaviour to ~0.1%, which is far tighter than any of these cues can move
// without being visible, and far looser than bit equality.
//
// That is not just an argument: the committed corpus was recorded on macOS
// (Apple libm) and both replays and RE-RECORDS byte-identically under
// emscripten/node, which is musl — two independent libms, one file.
//
// Usage: runtime_check <corpus.jsonl>
//        runtime_check --record --out=<f>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "corpus_diff.h"
#include "ttp/camera.h"
#include "ttp/canonical.h"
#include "ttp/framing.h"
#include "ttp/game.h"
#include "ttp/vecmath.h"
#include "ttp_render.h"

using namespace ttp;
using namespace ttp::corpus;

namespace {

// ---------------------------------------------------------------------------
// The quantizer, and its guard.
// ---------------------------------------------------------------------------
// 4 significant decimal digits, through the snprintf/strtod pair — C99 requires
// both to be correctly rounded, and glibc, musl and Apple all are.
const double WARN_FRAC = 0.49;    // authoring signal: nudge the input, then re-record
const double HARD_FRAC = 0.4995;  // genuinely on the boundary — unfreezable
const double MIN_MAG = 0.01;      // below this a cosmetic cue carries no signal

struct Q {
  double v = 0;
  double frac = 0;   // 0 .. 0.5 — how far the raw value sits from its rounded form
  bool tiny = false; // non-zero but below MIN_MAG
};

Q quantize(double x) {
  Q q;
  if (x == 0) return q;
  if (std::fabs(x) < MIN_MAG) { q.v = x; q.tiny = true; return q; }
  char buf[64];
  std::snprintf(buf, sizeof buf, "%.3e", x);
  q.v = std::strtod(buf, nullptr);
  // The unit of the last digit kept: the same decimal exponent, mantissa 1e-3.
  const char* e = std::strchr(buf, 'e');
  char stepBuf[32];
  std::snprintf(stepBuf, sizeof stepBuf, "1e%d", std::atoi(e + 1) - 3);
  const double step = std::strtod(stepBuf, nullptr);
  q.frac = std::fabs(x - q.v) / step;
  return q;
}

// Collected while a corpus is being built, so one report names every offender
// rather than dying on the first.
std::vector<std::string> g_warn, g_fatal;

Value num(double x, const std::string& path) {
  const Q q = quantize(x);
  char detail[160];
  if (q.tiny) {
    std::snprintf(detail, sizeof detail, "%s = %.9g is below %g", path.c_str(), x, MIN_MAG);
    g_fatal.push_back(detail);
  } else if (q.frac > HARD_FRAC) {
    std::snprintf(detail, sizeof detail, "%s = %.9g sits ON a rounding boundary (frac %.5f)",
                  path.c_str(), x, q.frac);
    g_fatal.push_back(detail);
  } else if (q.frac > WARN_FRAC) {
    std::snprintf(detail, sizeof detail, "%s = %.9g is %.5f of a step from the boundary",
                  path.c_str(), x, q.frac);
    g_warn.push_back(detail);
  }
  return Value::Num(q.v);
}

Value vec(const rt::V3& v, const std::string& path) {
  Value a = Value::Arr();
  a.push(num(v.x, path + ".x"));
  a.push(num(v.y, path + ".y"));
  a.push(num(v.z, path + ".z"));
  return a;
}

// ---------------------------------------------------------------------------
// 1. ttp_grid_cols — the split-screen column count, three copies of which had
//    drifted apart. Integers out, so this section is bit-exact whatever the libm
//    does; the one thing that could move is a COST TIE between two column
//    counts, and none of these surfaces is anywhere near one (the closest pair
//    in this table differs by 0.111 of a cost unit).
// ---------------------------------------------------------------------------
struct GridCase { const char* name; uint32_t w, h; };
const GridCase GRIDS[] = {
  {"1080p", 1920, 1080},
  {"720p-4x3", 1024, 768},
  {"ultrawide", 2560, 1080},
  {"portrait", 800, 1280},
};
const uint32_t GRID_MAX_N = 8;

Value gridCase(const GridCase& g) {
  Value o = Value::Obj();
  o.set("case", Value::Str("grid"));
  o.set("name", Value::Str(g.name));
  o.set("w", Value::Num((double) g.w));
  o.set("h", Value::Num((double) g.h));
  Value cols = Value::Arr();  // n = 0 .. GRID_MAX_N, so the n==0 guard is on the path
  for (uint32_t n = 0; n <= GRID_MAX_N; n++) cols.push(Value::Num((double) ttp_grid_cols(n, g.w, g.h)));
  o.set("cols", std::move(cols));
  return o;
}

// ---------------------------------------------------------------------------
// 2. solveFraming — the overview/lobby rigs and all three fog profiles, over
//    track boxes chosen to reach both arms of every max() in the solve: a
//    square circuit, one elongated in X, one in Z, and one big enough that the
//    overview fog band comes off radius*2 rather than the 220 floor. fogTune
//    varies so the per-biome scaling is on the path, and one case passes
//    maxOrbitDist 0 — the shape the ABI shim's first pass uses.
// ---------------------------------------------------------------------------
struct FramingCase { const char* name; TtpTrackFraming tf; float maxOrbitDist; };
const FramingCase FRAMINGS[] = {
  // name           centre X/Y/Z            size X/Y/Z              fogTune  maxOrbitDist
  //
  // The literals are deliberately UNTIDY. Round ones (.25, .5, fogTune 0.75)
  // land the fog bands and the bbox height exactly halfway between two
  // 4-significant-digit forms, where which way they round is the C library's
  // tie rule rather than the code's business.
  {"square",    {12.5f, 1.5f, -30.25f,  182.0f, 14.0f, 176.0f, 1.0f},   214.37f},
  {"wideX",     {-64.0f, 3.25f, 41.5f,  427.36f, 30.0f,  92.6f, 0.73f},  383.31f},
  {"longZ",     {31.0f, -2.5f, 118.0f,   76.4f,  9.0f, 301.74f, 1.37f},  297.53f},
  {"huge",      {5.0f, 12.0f, 7.5f,     905.2f, 61.0f, 711.4f, 0.62f}, 1104.19f},
  {"firstPass", {12.5f, 1.5f, -30.25f,  182.0f, 14.0f, 176.0f, 1.0f},   0.0f},
};

Value framingCase(const FramingCase& c) {
  const rt::Framing f = rt::solveFraming(c.tf, c.maxOrbitDist);
  const std::string p = std::string("framing.") + c.name;
  Value o = Value::Obj();
  o.set("case", Value::Str("framing"));
  o.set("name", Value::Str(c.name));
  o.set("center", vec(f.center, p + ".center"));
  o.set("ovOffset", vec(f.ovOffset, p + ".ovOffset"));
  o.set("ovRadius", num(f.ovRadius, p + ".ovRadius"));
  o.set("ovHeight", num(f.ovHeight, p + ".ovHeight"));
  o.set("ovBearing", num(f.ovBearing, p + ".ovBearing"));
  o.set("bbAx", num(f.bbAx, p + ".bbAx"));
  o.set("bbAz", num(f.bbAz, p + ".bbAz"));
  o.set("bbHeight", num(f.bbHeight, p + ".bbHeight"));
  o.set("ovFogNear", num(f.ovFogNear, p + ".ovFogNear"));
  o.set("ovFogFar", num(f.ovFogFar, p + ".ovFogFar"));
  o.set("bbFogNear", num(f.bbFogNear, p + ".bbFogNear"));
  o.set("bbFogFar", num(f.bbFogFar, p + ".bbFogFar"));
  o.set("raceFogNear", num(f.raceFogNear, p + ".raceFogNear"));
  o.set("raceFogFar", num(f.raceFogFar, p + ".raceFogFar"));
  return o;
}

// ---------------------------------------------------------------------------
// 3. ChaseCam — one continuous drive through six legs, each a straight run at a
//    fixed heading and speed. The camera state carries across them, so every leg
//    starts with the spring mid-swing from the last heading change, which is the
//    behaviour worth pinning (a camera that only ever settles proves nothing).
//
//    The legs between them reach: the first-update snap, a standing start, the
//    speed^2 tightening of the position spring, the CAM_RATE_SPD_MAX clamp
//    (boost runs at 1.9), a leg at half the frame rate (frame-rate-independent
//    damping must not care), and both arms of the asymmetric FOV response.
//
//    Every pose fed in is EXACT on every platform: the headings are literals and
//    normalise through sqrt (correctly rounded everywhere), and the position
//    integrates with +- and *. Only the camera's own expf can differ by a ulp,
//    which is what keeps the quantization guard's margin as wide as it is.
// ---------------------------------------------------------------------------
struct Leg {
  const char* name;
  int frames;
  float dt;
  float spd;                  // normalised v/vmax, exactly as the frame builder passes it
  double fx, fy, fz;          // heading (normalised below)
  double ux, uy, uz;          // body up (normalised below)
};
const Leg LEGS[] = {
  {"standing",   40, 1.0f / 60, 0.00f,  1.0, 0.0, 0.0,     0.0,  1.0, 0.0},
  {"cruise",     40, 1.0f / 60, 0.60f,  1.0, 0.0, 0.0,     0.0,  1.0, 0.0},
  {"corner",     40, 1.0f / 60, 0.85f,  0.6, 0.05, 0.8,    0.08, 1.0, 0.03},
  {"boost",      40, 1.0f / 60, 1.90f,  0.0, 0.1, 1.0,    -0.05, 1.0, 0.0},
  {"halfrate",   40, 1.0f / 30, 0.30f, -0.7, 0.0, 0.7,     0.0,  1.0, 0.12},
  {"rollingOut", 40, 1.0f / 60, 0.05f, -1.0, 0.0, 0.0,     0.0,  1.0, 0.0},
};

// World speed for a normalised spd — an arbitrary but fixed scale, so the car
// actually travels and the spring has something to lag behind.
const double WORLD_VMAX = 23.7;

Vec3 unit(double x, double y, double z) {
  const double l = std::sqrt(x * x + y * y + z * z);
  return Vec3(x / l, y / l, z / l);
}

std::vector<Value> chaseCases() {
  std::vector<Value> out;
  rt::ChaseCam cam;
  // Well away from the origin, so no recorded component sits near zero where a
  // relative quantization has nothing to hold on to.
  Vec3 pos(40.0, 3.0, 25.0);
  for (const Leg& leg : LEGS) {
    Pose pose;
    pose.forward = unit(leg.fx, leg.fy, leg.fz);
    pose.up = unit(leg.ux, leg.uy, leg.uz);
    const double step = WORLD_VMAX * leg.spd * leg.dt;
    for (int f = 0; f < leg.frames; f++) {
      pos.x += pose.forward.x * step;
      pos.y += pose.forward.y * step;
      pos.z += pose.forward.z * step;
      pose.pos = pos;
      cam.update(pose, leg.spd, leg.dt);
    }
    const std::string p = std::string("chase.") + leg.name;
    Value o = Value::Obj();
    o.set("case", Value::Str("chase"));
    o.set("name", Value::Str(leg.name));
    o.set("frames", Value::Num((double) leg.frames));
    o.set("pos", vec(cam.pos, p + ".pos"));
    o.set("target", vec(cam.target, p + ".target"));
    o.set("fov", num(cam.fov, p + ".fov"));
    out.push_back(std::move(o));
  }
  return out;
}

// ---------------------------------------------------------------------------
std::vector<Value> buildCorpus() {
  std::vector<Value> rows;
  for (const GridCase& g : GRIDS) rows.push_back(gridCase(g));
  for (const FramingCase& c : FRAMINGS) rows.push_back(framingCase(c));
  for (Value& v : chaseCases()) rows.push_back(std::move(v));
  return rows;
}

}  // namespace

int main(int argc, char** argv) {
  bool record = false;
  std::string outPath, corpusPath;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    if (a == "--record") record = true;
    else if (a.rfind("--out=", 0) == 0) outPath = a.substr(6);
    else corpusPath = a;
  }
  if (!record && corpusPath.empty()) {
    std::fprintf(stderr, "usage: runtime_check <corpus.jsonl> | --record --out=<f>\n");
    return 2;
  }

  const std::vector<Value> rows = buildCorpus();

  for (const std::string& w : g_warn) {
    std::fprintf(stderr, "WARN  %s\n      (harmless here, but nudge the input before freezing it)\n",
                 w.c_str());
  }
  if (!g_fatal.empty()) {
    for (const std::string& f : g_fatal) std::fprintf(stderr, "FAIL  %s\n", f.c_str());
    std::fprintf(stderr,
                 "%zu value(s) cannot be frozen: the quantized form is not stable across the\n"
                 "platform libms. Move the case's inputs and re-record.\n", g_fatal.size());
    return 2;
  }

  if (record) {
    if (outPath.empty()) { std::fprintf(stderr, "--record needs --out=<file>\n"); return 2; }
    std::ofstream out(outPath, std::ios::binary);
    if (!out) { std::fprintf(stderr, "cannot write %s\n", outPath.c_str()); return 2; }
    Value header = Value::Obj();
    header.set("kind", Value::Str("runtime-camera"));
    header.set("sigDigits", Value::Num(4));
    header.set("cases", Value::Num((double) rows.size()));
    out << canonical_stringify(header) << "\n";
    for (const Value& r : rows) out << canonical_stringify(r) << "\n";
    std::printf("recorded %zu cases to %s\n", rows.size(), outPath.c_str());
    return 0;
  }

  std::ifstream in(corpusPath);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", corpusPath.c_str()); return 2; }
  std::string line, err;
  if (!std::getline(in, line)) { std::fprintf(stderr, "empty corpus\n"); return 2; }

  int failures = 0;
  size_t idx = 0;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value want;
    if (!read_line(line, want, &err)) { std::fprintf(stderr, "parse error: %s\n", err.c_str()); return 2; }
    if (idx >= rows.size()) {
      std::fprintf(stderr, "FAIL corpus has more cases than the build — re-record\n");
      failures++;
      break;
    }
    const Diff d = diff_val(want, rows[idx], "case");
    if (d.differ) {
      failures++;
      const Value* name = want.find("name");
      std::fprintf(stderr, "FAIL %s at %s\n  recorded %s\n  actual   %s\n",
                   name ? name->str.c_str() : "?",
                   d.path.c_str(), d.expected.c_str(), d.actual.c_str());
    }
    idx++;
  }
  if (idx != rows.size()) {
    std::fprintf(stderr, "FAIL corpus covers %zu cases, the build has %zu — re-record\n",
                 idx, rows.size());
    failures++;
  }

  std::printf("runtime check: %zu cases, %d failures\n", rows.size(), failures);
  return failures == 0 ? 0 : 1;
}
