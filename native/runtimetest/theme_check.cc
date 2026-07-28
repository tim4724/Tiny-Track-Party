// theme_check — the C++ biome tables against the JS palette they were ported
// from (tests/fixtures/theme-corpus.jsonl, recorded by the now-frozen
// scripts/gen-theme-corpus.mjs).
//
// WHAT THIS IS. JS-RECORDED cross-implementation evidence — class 1 in
// tests/fixtures/traces/README.md, the kind that can actually settle a parity
// question. The corpus was recorded off the live public/shared/themes.js +
// render/trackPayload.js + shared/trackBin.js before those were deleted, so
// every number in it is one the shipping browser game was drawing with. Nothing
// in this file may be "fixed" by re-recording: the JS twin is gone, and a
// re-record would only prove C++ matches itself.
//
// WHY IT MATTERS MORE THAN ITS SIZE SUGGESTS. A biome is pure data, so a port
// slip does not crash or fail a race — it silently changes what a cup LOOKS
// like, on a surface no other test in the tree renders. The corpus therefore
// pins every biome against every track (the snow cup patches its flake cloud
// per track, and the beach's shoreline seed is a hash of the track id), the
// biome-name ORDER (user-visible in the ?biome= dropdown), the cup/track
// fallbacks to grass, all six boostShades — the HUD chip stroke is still drawn
// in the DOM from `icon` — and the scenery recolours, resolved against the
// shipped GLBs' own authored material colours.
//
// Usage: theme_check <theme-corpus.jsonl> <assetDir>
//   assetDir is public/assets/toycar (the scenery GLBs the tint maps key on).

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

#include "corpus_diff.h"
#include "ttp/theme.h"

using namespace ttp;
using namespace ttp::corpus;

namespace {

Value f(float v) { return Value::Num((double) v); }
Value u(uint32_t v) { return Value::Num((double) v); }

Value colors(const std::vector<uint32_t>& v) {
  Value a = Value::Arr();
  for (uint32_t c : v) a.push(u(c));
  return a;
}

Value roadOf(const rt::RoadPalette& r) {
  Value o = Value::Obj();
  o.set("asphalt", u(r.asphalt)); o.set("line", u(r.line)); o.set("dash", u(r.dash));
  o.set("kerbA", u(r.kerbA)); o.set("kerbB", u(r.kerbB));
  o.set("skirt", u(r.skirt)); o.set("shoulder", u(r.shoulder));
  o.set("kerbW", f(r.kerbW)); o.set("kerbH", f(r.kerbH));
  o.set("edgeLines", Value::Bool(r.edgeLines));
  return o;
}

Value sceneryOf(const rt::ScenerySpec& s) {
  Value o = Value::Obj();
  o.set("density", f(s.density));
  o.set("mixTree", f(s.mixTree));
  o.set("mixBush", f(s.mixBush));
  Value models = Value::Arr();
  for (const std::string& m : s.models) models.push(Value::Str(m));
  o.set("models", models);
  Value trees = Value::Arr();
  for (const rt::TreeSpec& t : s.trees) {
    Value e = Value::Obj();
    e.set("model", Value::Str(t.model));
    e.set("w", f(t.w)); e.set("s0", f(t.s0)); e.set("s1", f(t.s1));
    trees.push(e);
  }
  o.set("trees", trees);
  if (s.hasBush) {
    Value b = Value::Obj();
    b.set("model", Value::Str(s.bush.model));
    b.set("s0", f(s.bush.s0)); b.set("s1", f(s.bush.s1)); b.set("sink", f(s.bush.sink));
    o.set("bush", b);
  } else {
    o.set("bush", Value::Null());
  }
  o.set("rocks", colors(s.rocks));
  Value rockS = Value::Arr();
  rockS.push(f(s.rockS[0])); rockS.push(f(s.rockS[1]));
  o.set("rockS", rockS);
  o.set("clutterDensity", f(s.clutterDensity));
  Value cl = Value::Arr();
  for (const rt::ClutterSpec& c : s.clutter) {
    Value e = Value::Obj();
    e.set("kind", u(c.kind)); e.set("w", f(c.w)); e.set("tints", colors(c.tints));
    cl.push(e);
  }
  o.set("clutter", cl);
  return o;
}

// The same field projection scripts/gen-theme-corpus.mjs records, so a diff
// localizes to the field rather than the object.
Value themeOf(const rt::Theme& t) {
  Value o = Value::Obj();
  o.set("road", roadOf(t.road));
  Value sky = Value::Arr();
  for (uint32_t c : t.sky) sky.push(u(c));
  o.set("sky", sky);
  o.set("fog", u(t.fog));
  o.set("hillShape", u(t.hillShape));
  o.set("hills", colors(t.hills));
  o.set("scenery", sceneryOf(t.scenery));
  o.set("landmarks", colors(t.landmarks));
  o.set("structure", u(t.structure));
  o.set("groundKind", u(t.groundKind));
  o.set("fogTune", f(t.fogTune));
  {
    Value k = Value::Obj();
    k.set("color", u(t.key.color)); k.set("intensity", f(t.key.intensity));
    o.set("key", k);
  }
  {
    Value h = Value::Obj();
    h.set("sky", u(t.hemi.sky)); h.set("ground", u(t.hemi.ground));
    h.set("intensity", f(t.hemi.intensity));
    o.set("hemi", h);
  }
  {
    Value c = Value::Obj();
    c.set("count", u(t.clouds.count)); c.set("opacity", f(t.clouds.opacity));
    c.set("scale", f(t.clouds.scale)); c.set("aspect", f(t.clouds.aspect));
    c.set("tint", u(t.clouds.tint));
    o.set("clouds", c);
  }
  o.set("gate", u(t.gate));
  {
    Value g = Value::Obj();
    g.set("pylon", u(t.gantry.pylon)); g.set("finial", u(t.gantry.finial));
    g.set("hasRings", Value::Bool(t.gantry.hasRings)); g.set("rings", u(t.gantry.rings));
    o.set("gantry", g);
  }
  o.set("boost", u(t.boost));
  if (t.hasWater) {
    Value w = Value::Obj();
    w.set("foam", u(t.water.foam)); w.set("shallow", u(t.water.shallow));
    w.set("deep", u(t.water.deep)); w.set("wet", u(t.water.wet));
    w.set("shoreSeed", u(t.water.shoreSeed));
    o.set("water", w);
  } else {
    o.set("water", Value::Null());
  }
  {
    Value h = Value::Obj();
    h.set("count", u(t.haze.count)); h.set("opacity", f(t.haze.opacity));
    h.set("tint", u(t.haze.tint)); h.set("scale", f(t.haze.scale));
    o.set("haze", h);
  }
  {
    Value a = Value::Obj();
    a.set("kind", u(t.ambient.kind)); a.set("count", u(t.ambient.count));
    a.set("size", f(t.ambient.size)); a.set("opacity", f(t.ambient.opacity));
    a.set("tint", u(t.ambient.tint));
    a.set("fall", f(t.ambient.fall)); a.set("wind", f(t.ambient.wind));
    a.set("bob", f(t.ambient.bob)); a.set("band", f(t.ambient.band));
    o.set("ambient", a);
  }
  {
    Value b = Value::Obj();
    b.set("count", u(t.birds.count)); b.set("tint", u(t.birds.tint));
    b.set("size", f(t.birds.size)); b.set("y", f(t.birds.y));
    b.set("rc", f(t.birds.rc)); b.set("rb", f(t.birds.rb));
    b.set("speed", f(t.birds.speed)); b.set("flap", f(t.birds.flap));
    b.set("flapHz", f(t.birds.flapHz)); b.set("dys", f(t.birds.dys));
    o.set("birds", b);
  }
  {
    Value k = Value::Obj();
    k.set("count", u(t.kites.count)); k.set("size", f(t.kites.size)); k.set("y", f(t.kites.y));
    k.set("tints", colors(t.kites.tints));
    o.set("kites", k);
  }
  if (t.hasPlane) {
    Value p = Value::Obj();
    p.set("tint", u(t.plane.tint)); p.set("size", f(t.plane.size)); p.set("y", f(t.plane.y));
    p.set("a0", f(t.plane.a0)); p.set("rc", f(t.plane.rc)); p.set("rb", f(t.plane.rb));
    p.set("speed", f(t.plane.speed)); p.set("bank", f(t.plane.bank));
    o.set("plane", p);
  } else {
    o.set("plane", Value::Null());
  }
  {
    Value b = Value::Obj();
    b.set("panels", colors(t.balloon.panels));
    b.set("y", f(t.balloon.y)); b.set("size", f(t.balloon.size));
    o.set("balloon", b);
  }
  if (t.hasIce) {
    Value i = Value::Obj();
    i.set("sheet", u(t.ice.sheet)); i.set("frost", u(t.ice.frost));
    o.set("ice", i);
  } else {
    o.set("ice", Value::Null());
  }
  return o;
}

std::vector<uint8_t> readFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return {};
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(in)),
                              std::istreambuf_iterator<char>());
}

const char* str(const Value* v) { return (v && v->type == Value::STR) ? v->str.c_str() : nullptr; }

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::fprintf(stderr, "usage: theme_check <theme-corpus.jsonl> <assetDir>\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }
  const std::string assetDir = argv[2];

  std::string line;
  if (!std::getline(in, line)) { std::fprintf(stderr, "empty corpus\n"); return 2; }  // header

  int cases = 0, passed = 0, spew = 0;
  const auto report = [&](const std::string& what, const Diff& d) {
    cases++;
    if (!d.differ) { passed++; return; }
    if (spew++ < 20) {
      std::fprintf(stderr, "FAIL %s  path %s\n  expected %s\n  actual   %s\n",
                   what.c_str(), d.path.c_str(), d.expected.c_str(), d.actual.c_str());
    }
  };

  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    std::string err;
    if (!read_line(line, root, &err)) {
      std::fprintf(stderr, "parse error: %s\n", err.c_str());
      return 2;
    }
    const char* kind = str(root.find("case"));
    if (!kind) { std::fprintf(stderr, "corpus line has no 'case'\n"); return 2; }

    if (std::string(kind) == "biomes") {
      Value got = Value::Arr();
      for (int i = 0; i < rt::biome_count(); i++) got.push(Value::Str(rt::biome_name(i)));
      report("biomes", diff_val(*root.find("names"), got, "names"));

    } else if (std::string(kind) == "cup") {
      // A JSON null cup is JS's "no cup at all" (every dev-only surface).
      const Value* cupV = root.find("cup");
      const char* cup = str(cupV);
      report("cup " + std::string(cup ? cup : "<null>"),
             diff_val(*root.find("biome"), Value::Str(rt::biome_for_cup(cup)), "biome"));

    } else if (std::string(kind) == "track") {
      const char* track = str(root.find("track"));
      report("track " + std::string(track ? track : "?"),
             diff_val(*root.find("biome"), Value::Str(rt::biome_for_track(track)), "biome"));

    } else if (std::string(kind) == "boost") {
      const char* biome = str(root.find("biome"));
      const rt::Theme t = rt::resolve_theme(biome, "");
      const rt::BoostShades s = rt::boost_shades(t.boost);
      Value got = Value::Obj();
      got.set("base", u(s.base)); got.set("light", u(s.light)); got.set("dark", u(s.dark));
      got.set("strip", u(s.strip)); got.set("disk", u(s.disk));
      got.set("streak", u(s.streak)); got.set("icon", u(s.icon));
      report("boost " + std::string(biome), diff_val(*root.find("shades"), got, "shades"));

    } else if (std::string(kind) == "theme") {
      const char* biome = str(root.find("biome"));
      const char* track = str(root.find("track"));
      const rt::Theme t = rt::resolve_theme(biome, track);
      report("theme " + std::string(biome) + "/" + track,
             diff_val(*root.find("resolved"), themeOf(t), "resolved"));

    } else if (std::string(kind) == "tints") {
      const char* biome = str(root.find("biome"));
      const char* model = str(root.find("model"));
      const std::vector<uint8_t> glb = readFile(assetDir + "/" + model + ".glb");
      if (glb.empty()) {
        std::fprintf(stderr, "missing asset %s/%s.glb\n", assetDir.c_str(), model);
        return 2;
      }
      const std::vector<rt::MatTint> pairs =
          rt::resolve_model_tints(biome, model, glb.data(), glb.size());
      Value got = Value::Arr();
      for (const rt::MatTint& p : pairs) {
        Value e = Value::Arr();
        e.push(Value::Str(p.name));
        e.push(u(p.rgb));
        got.push(e);
      }
      report("tints " + std::string(biome) + "/" + model,
             diff_val(*root.find("pairs"), got, "pairs"));

    } else {
      std::fprintf(stderr, "unknown corpus case '%s'\n", kind);
      return 2;
    }
  }

  std::printf("theme corpus: %d/%d cases passed\n", passed, cases);
  return passed == cases ? 0 : 1;
}
