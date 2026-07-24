// Golden-trace REPLAY CLI — the C++ twin of scripts/verify-trace.mjs, linking
// libttp-sim. Reads a JSONL trace, rebuilds the race (buildRaceTrack twin +
// contract-version/mathlib-stamp checks), and replays the recorded inputs
// (input-replay, ai-live re-run, session driver, dt jitter, schedule ops),
// demanding EXACT per-frame agreement: events, stored snapshots, the FNV-1a of
// the canonical snapshot every frame, plus the session's countdown/racing/raceEnd
// beats. First divergence -> prints frame/path/expected/actual and exits 1.
//
// JSON numbers are parsed with strtod and then SELF-VALIDATED: each is reformatted
// with js_number_to_string and compared to the source token, proving correctly-
// rounded parsing per value rather than assuming it (aborts loudly on any miss).

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "generated/track_defs.h"
#include "ttp/ai_driver.h"
#include "ttp/canonical.h"
#include "ttp/centerline.h"
#include "ttp/game.h"
#include "ttp/jsonnum.h"
#include "ttp/race_session.h"
#include "ttp/trackbuilder.h"

using namespace ttp;

static const char* MATHLIB = "fdlibm-openlibm-0.8.7";
static const int CONTRACT_VERSION = 2;

// ---------------------------------------------------------------------------
// Minimal JSON reader with per-number self-validation.
// ---------------------------------------------------------------------------
struct JV {
  enum T { OBJ, ARR, STR, NUM, BOOL, NUL } t = NUL;
  std::vector<std::pair<std::string, JV>> obj;
  std::vector<JV> arr;
  std::string str;
  double num = 0;
  bool b = false;
  const JV* get(const char* key) const {
    for (auto& kv : obj) if (kv.first == key) return &kv.second;
    return nullptr;
  }
  bool has(const char* key) const { return get(key) != nullptr; }
};

struct JParse {
  const std::string& s;
  size_t p = 0;
  bool ok = true;
  std::string err;
  explicit JParse(const std::string& src) : s(src) {}
  void ws() { while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == '\n' || s[p] == '\r')) p++; }
  bool str(std::string& out) {
    if (s[p] != '"') return false;
    p++;
    out.clear();
    while (p < s.size()) {
      char c = s[p++];
      if (c == '"') return true;
      if (c == '\\') {
        char e = s[p++];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            int v = 0;
            for (int i = 0; i < 4; i++) {
              char h = s[p++]; v <<= 4;
              if (h >= '0' && h <= '9') v |= h - '0';
              else if (h >= 'a' && h <= 'f') v |= h - 'a' + 10;
              else if (h >= 'A' && h <= 'F') v |= h - 'A' + 10;
            }
            out += (char)v;
            break;
          }
          default: out += e;
        }
      } else out += c;
    }
    return false;
  }
  bool value(JV& v) {
    ws();
    if (p >= s.size()) return false;
    char c = s[p];
    if (c == '{') {
      v.t = JV::OBJ; p++; ws();
      if (s[p] == '}') { p++; return true; }
      while (true) {
        ws();
        std::string key;
        if (!str(key)) return false;
        ws();
        if (s[p] != ':') return false;
        p++;
        JV child;
        if (!value(child)) return false;
        v.obj.emplace_back(std::move(key), std::move(child));
        ws();
        if (s[p] == ',') { p++; continue; }
        if (s[p] == '}') { p++; return true; }
        return false;
      }
    }
    if (c == '[') {
      v.t = JV::ARR; p++; ws();
      if (s[p] == ']') { p++; return true; }
      while (true) {
        JV child;
        if (!value(child)) return false;
        v.arr.push_back(std::move(child));
        ws();
        if (s[p] == ',') { p++; continue; }
        if (s[p] == ']') { p++; return true; }
        return false;
      }
    }
    if (c == '"') { v.t = JV::STR; return str(v.str); }
    if (c == 't') { v.t = JV::BOOL; v.b = true; p += 4; return true; }
    if (c == 'f') { v.t = JV::BOOL; v.b = false; p += 5; return true; }
    if (c == 'n') { v.t = JV::NUL; p += 4; return true; }
    // number
    v.t = JV::NUM;
    size_t start = p;
    while (p < s.size() && (std::isdigit((unsigned char)s[p]) || s[p] == '-' || s[p] == '+' ||
                            s[p] == '.' || s[p] == 'e' || s[p] == 'E')) p++;
    std::string tok = s.substr(start, p - start);
    v.num = std::strtod(tok.c_str(), nullptr);
    // SELF-VALIDATE: correctly-rounded strtod is proven, not assumed, per value.
    std::string round = js_number_to_string(v.num);
    if (round != tok) {
      ok = false;
      err = "number round-trip mismatch: token '" + tok + "' reformats to '" + round + "'";
      return false;
    }
    return true;
  }
};

static bool parseLine(const std::string& line, JV& out, std::string& err) {
  JParse jp(line);
  if (!jp.value(out) || !jp.ok) { err = jp.ok ? "parse error" : jp.err; return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Canonical stringify of a parsed JV (recorded side), for diff messages.
// ---------------------------------------------------------------------------
static std::string canonJV(const JV& v) {
  switch (v.t) {
    case JV::NUL: return "null";
    case JV::BOOL: return v.b ? "true" : "false";
    case JV::NUM: return js_number_to_string(v.num);
    case JV::STR: return json_quote(v.str);
    case JV::ARR: {
      std::string o = "[";
      for (size_t i = 0; i < v.arr.size(); i++) { if (i) o += ","; o += canonJV(v.arr[i]); }
      return o + "]";
    }
    case JV::OBJ: {
      std::vector<const std::pair<std::string, JV>*> kept;
      for (auto& kv : v.obj) kept.push_back(&kv);
      std::sort(kept.begin(), kept.end(), [](auto* a, auto* b) { return a->first < b->first; });
      std::string o = "{";
      for (size_t i = 0; i < kept.size(); i++) {
        if (i) o += ",";
        o += json_quote(kept[i]->first) + ":" + canonJV(kept[i]->second);
      }
      return o + "}";
    }
  }
  return "null";
}

// ---------------------------------------------------------------------------
// Structural diff: recorded JV (expected) vs engine Value (actual). Returns the
// first divergent path in canonical (sorted-key) order, mirroring verify-trace's
// firstDiff. Numbers compare by their js_number_to_string form (so ±0 and
// shortest-form match). Empty path string in `differ==false` means equal.
// ---------------------------------------------------------------------------
struct Diff { bool differ = false; std::string path, expected, actual; };

static std::string valType(const Value& v) {
  switch (v.type) { case Value::NUL: case Value::UNDEF: return "null";
    case Value::BOOL: return "bool"; case Value::NUM: return "num";
    case Value::STR: return "str"; case Value::ARR: return "arr"; case Value::OBJ: return "obj"; }
  return "?";
}
static std::string jvType(const JV& v) {
  switch (v.t) { case JV::NUL: return "null"; case JV::BOOL: return "bool";
    case JV::NUM: return "num"; case JV::STR: return "str"; case JV::ARR: return "arr"; case JV::OBJ: return "obj"; }
  return "?";
}

static Diff diffVal(const JV& e, const Value& a, const std::string& path);

static Diff leafMismatch(const JV& e, const Value& a, const std::string& path) {
  return {true, path, canonJV(e), canonical_stringify(a)};
}

static Diff diffVal(const JV& e, const Value& a, const std::string& path) {
  std::string te = jvType(e), ta = valType(a);
  if (te != ta) return leafMismatch(e, a, path);
  if (te == "num") {
    if (js_number_to_string(e.num) != js_number_to_string(a.num)) return leafMismatch(e, a, path);
    return {};
  }
  if (te == "bool") { if (e.b != a.b) return leafMismatch(e, a, path); return {}; }
  if (te == "str") { if (e.str != a.str) return leafMismatch(e, a, path); return {}; }
  if (te == "null") return {};
  if (te == "arr") {
    size_t n = std::min(e.arr.size(), a.arr.size());
    for (size_t i = 0; i < n; i++) {
      Diff d = diffVal(e.arr[i], a.arr[i], path + "[" + std::to_string(i) + "]");
      if (d.differ) return d;
    }
    if (e.arr.size() != a.arr.size())
      return {true, path + ".length", std::to_string(e.arr.size()), std::to_string(a.arr.size())};
    return {};
  }
  // object: union of keys, sorted
  std::vector<std::string> keys;
  for (auto& kv : e.obj) keys.push_back(kv.first);
  for (auto& kv : a.obj) if (kv.second.type != Value::UNDEF) {
    bool seen = false; for (auto& k : keys) if (k == kv.first) { seen = true; break; }
    if (!seen) keys.push_back(kv.first);
  }
  std::sort(keys.begin(), keys.end());
  for (const std::string& k : keys) {
    const JV* ec = e.get(k.c_str());
    const Value* ac = nullptr;
    for (auto& kv : a.obj) if (kv.first == k && kv.second.type != Value::UNDEF) { ac = &kv.second; break; }
    std::string cp = path.empty() ? k : path + "." + k;
    if (!ec) return {true, cp, "<absent>", ac ? canonical_stringify(*ac) : "<absent>"};
    if (!ac) return {true, cp, canonJV(*ec), "<absent>"};
    Diff d = diffVal(*ec, *ac, cp);
    if (d.differ) return d;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Trace-value builders (Id / Input / Stats from JV).
// ---------------------------------------------------------------------------
static Id idFromJV(const JV& v) {
  if (v.t == JV::STR) return Id::Str(v.str);
  if (v.t == JV::NUM) return Id::Num(v.num);
  return Id::None();
}
static Input inputFromJV(const JV& v) {
  Input in;
  if (const JV* s = v.get("s")) { if (s->t == JV::NUM) { in.hasS = true; in.s = s->num; } }
  if (const JV* b = v.get("b")) {
    if (b->t == JV::NUM) { in.hasB = true; in.b = b->num; }
    else if (b->t == JV::BOOL) { in.hasB = true; in.b = b->b ? 1 : 0; }
  }
  if (const JV* u = v.get("u")) { if (u->t == JV::NUM) { in.hasU = true; in.u = u->num; } }
  return in;
}
static Stats statsFromJV(const JV& v) {
  Stats st;
  if (const JV* x = v.get("accel")) st.accel = x->num;
  if (const JV* x = v.get("vmax")) st.vmax = x->num;
  if (const JV* x = v.get("turn")) st.turn = x->num;
  if (const JV* x = v.get("mass")) st.mass = x->num;
  if (const JV* x = v.get("halfLen")) st.halfLen = x->num;
  if (const JV* x = v.get("halfWid")) st.halfWid = x->num;
  return st;
}

// ---------------------------------------------------------------------------
// buildRaceTrack twin: native TrackBuilder -> Centerline + GameTrack.
// ---------------------------------------------------------------------------
struct BuiltTrack {
  std::unique_ptr<Centerline> centerline;
  GameTrack game;
};

static const TrackDef* findTrackDef(const std::string& id) {
  for (int i = 0; i < TTP_TRACK_COUNT; i++)
    if (id == TTP_TRACKS[i].id) return &TTP_TRACKS[i];
  return nullptr;
}

static bool buildRaceTrack(const std::string& trackId, int laps, uint32_t seed, BuiltTrack& out, std::string& err) {
  const TrackDef* def = findTrackDef(trackId);
  if (!def) { err = "unknown trackId '" + trackId + "'"; return false; }
  RaceTrack rt = build_race_track(*def, laps, seed);
  std::vector<Sample> samples;
  samples.reserve(rt.samples.size());
  for (const OutSample& s : rt.samples) {
    Sample cs; cs.pos = s.pos; cs.tangent = s.tangent; cs.up = s.up; cs.lateral = s.lateral;
    cs.width = s.width; cs.s = s.s;
    samples.push_back(cs);
  }
  out.centerline = std::make_unique<Centerline>(std::move(samples), rt.length);
  GameTrack& g = out.game;
  g.centerline = out.centerline.get();
  g.length = rt.length;
  g.totalLaps = laps;
  g.roadWidth = rt.roadWidth;
  g.seed = seed;
  for (const Hazard& h : rt.hazards) g.hazards.push_back(Zone{h.s, h.lat, h.radius});
  for (const Pad& p : rt.pads)
    g.pads.push_back(PadRt{p.s, p.lat, p.strip, p.radius, p.halfLen, p.halfWidth});
  for (const Box& b : rt.boxes) g.boxes.push_back(BoxRt{b.s, b.lat, b.radius, 0, 0});
  for (const ttp::Pole& p : rt.poles) g.poles.push_back(PoleRt{p.s, p.lat, p.radius});
  for (const Banana& b : rt.bananas) g.bananas.push_back(BananaRt{0, b.s, b.lat, Id::None(), 0, true, 0, false});
  return true;
}

// ---------------------------------------------------------------------------
// Replay.
// ---------------------------------------------------------------------------
struct RosterEntry { Id id; std::string kind; double caution = 1; double laneBias = 0; uint32_t aiSeed = 0; bool hasStats = false; Stats stats; };

static void fail(const std::string& file, int frame, const std::string& path,
                 const std::string& expected, const std::string& actual, const std::string& msg) {
  std::fprintf(stderr, "FAIL %s\n  frame %d  path %s\n  expected %s\n  actual   %s\n  %s\n",
               file.c_str(), frame, path.empty() ? "(hash)" : path.c_str(),
               expected.c_str(), actual.c_str(), msg.c_str());
}

int main(int argc, char** argv) {
  if (argc != 2) { std::fprintf(stderr, "usage: replay_cli <trace.jsonl>\n"); return 2; }
  std::string file = argv[1];
  std::ifstream in(file);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", file.c_str()); return 2; }

  std::string headerLine;
  if (!std::getline(in, headerLine)) { std::fprintf(stderr, "empty trace\n"); return 2; }
  JV header; std::string perr;
  if (!parseLine(headerLine, header, perr)) { std::fprintf(stderr, "header parse: %s\n", perr.c_str()); return 2; }

  // provenance
  const JV* cv = header.get("contractVersion");
  if (!cv || (int)cv->num != CONTRACT_VERSION) {
    std::fprintf(stderr, "FAIL %s: contractVersion %g != %d\n", file.c_str(), cv ? cv->num : -1.0, CONTRACT_VERSION);
    return 1;
  }
  const JV* math = header.get("math");
  if (!math || math->str != MATHLIB) {
    std::fprintf(stderr, "FAIL %s: mathlib stamp '%s' != '%s' (re-record)\n",
                 file.c_str(), math ? math->str.c_str() : "<none>", MATHLIB);
    return 1;
  }

  int frames = (int)header.get("frames")->num;
  std::string trackId = header.get("trackId")->str;
  int laps = (int)header.get("laps")->num;
  uint32_t seed = (uint32_t)header.get("seed")->num;
  double dt = header.get("dt")->num;
  bool isSession = header.has("driver") && header.get("driver")->str == "session";
  bool aiLive = header.has("aiLive") && header.get("aiLive")->b;
  int countdown = header.has("countdown") ? (int)header.get("countdown")->num : 3;

  // dt stream (makeDtStream)
  const JV* jj = header.get("dtJitter");
  bool jitter = jj != nullptr;
  double jAmp = 0, jSpikeScale = 4; int jSpikeEvery = 0; uint32_t jSeed = 1;
  if (jitter) {
    if (const JV* x = jj->get("amp")) jAmp = x->num;
    if (const JV* x = jj->get("spikeEvery")) jSpikeEvery = (int)x->num;
    if (const JV* x = jj->get("spikeScale")) jSpikeScale = x->num;
    if (const JV* x = jj->get("jseed")) jSeed = (uint32_t)x->num;
  }
  Mulberry32 dtRng(jSeed ? jSeed : 1u);
  auto dtFor = [&](int frame) -> double {
    if (!jitter) return dt;
    double d = dt + (dtRng.next() * 2 - 1) * jAmp;
    if (jSpikeEvery && frame > 0 && frame % jSpikeEvery == 0) d *= jSpikeScale;
    return d;
  };

  // roster
  std::vector<RosterEntry> roster;
  for (const JV& r : header.get("roster")->arr) {
    RosterEntry e;
    e.id = idFromJV(*r.get("id"));
    e.kind = r.get("kind")->str;
    if (const JV* x = r.get("caution")) e.caution = x->num;
    if (const JV* x = r.get("laneBias")) e.laneBias = x->num;
    if (const JV* x = r.get("aiSeed")) e.aiSeed = (uint32_t)x->num;
    if (const JV* x = r.get("stats")) { e.hasStats = true; e.stats = statsFromJV(*x); }
    roster.push_back(e);
  }

  BuiltTrack track; std::string terr;
  if (!buildRaceTrack(trackId, laps, seed, track, terr)) { std::fprintf(stderr, "FAIL %s: %s\n", file.c_str(), terr.c_str()); return 1; }

  // players (roster order) — {id, stats}
  std::vector<PlayerDesc> players;
  for (const RosterEntry& r : roster) players.push_back(PlayerDesc{r.id, r.hasStats, r.stats});

  // callbacks capture
  std::vector<Event> pending;
  std::vector<int> ticks;
  bool haveRaceEnd = false; Value raceEndResults;
  auto onEvent = [&](const Event& e) { pending.push_back(e); };
  auto onTick = [&](int n) { ticks.push_back(n); };
  auto onEnd = [&](const Value& r) { raceEndResults = r; haveRaceEnd = true; };

  std::unique_ptr<Game> game;
  std::unique_ptr<RaceSession> session;
  Game* eng = nullptr;
  if (isSession) {
    session = std::make_unique<RaceSession>(players, track.game, onEvent, onEnd, onTick);
    eng = &session->engine();
  } else {
    game = std::make_unique<Game>(players, track.game, onEvent);
    eng = game.get();
  }

  // applyStage
  if (const JV* stage = header.get("stage")) {
    for (const JV& st : stage->arr) {
      std::string kind = st.get("kind")->str;
      double s = st.get("s")->num, lat = st.has("lat") ? st.get("lat")->num : 0;
      if (kind == "rocket") {
        double v = 0; Id owner = Id::Str("staged");
        if (const JV* o = st.get("opts")) {
          if (const JV* x = o->get("v")) v = x->num;
          if (const JV* x = o->get("owner")) owner = idFromJV(*x);
        }
        eng->stageRocket(s, lat, v, owner);
      } else if (kind == "banana") {
        eng->stageBanana(s, lat);
      } else { std::fprintf(stderr, "FAIL %s: unknown stage kind '%s'\n", file.c_str(), kind.c_str()); return 1; }
    }
  }
  if (session) session->startCountdown(countdown);

  // controllers (ai-live)
  struct Ctrl { Id id; std::unique_ptr<AiController> ai; };
  std::vector<Ctrl> controllers;
  std::vector<std::string> botKeys;
  if (aiLive) {
    for (const RosterEntry& r : roster) if (r.kind == "bot") {
      controllers.push_back(Ctrl{r.id, std::make_unique<AiController>(r.caution, LOOKAHEAD, STEER_GAIN, r.laneBias, r.aiSeed)});
    }
  }
  for (const RosterEntry& r : roster) if (r.kind == "bot") botKeys.push_back(r.id.key());

  // idByKey
  std::vector<std::pair<std::string, Id>> idByKey;
  for (const RosterEntry& r : roster) idByKey.emplace_back(r.id.key(), r.id);
  auto lookupId = [&](const std::string& key, Id& out) -> bool {
    for (auto& kv : idByKey) if (kv.first == key) { out = kv.second; return true; }
    return false;
  };

  const JV* schedule = header.get("schedule");

  bool lastRacing = false;
  int recCount = 0;

  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    JV rec;
    if (!parseLine(line, rec, perr)) { std::fprintf(stderr, "FAIL %s: record parse: %s\n", file.c_str(), perr.c_str()); return 1; }
    recCount++;
    int frame = (int)rec.get("frame")->num;

    // schedule ops (before inputs), with id-remap bookkeeping
    if (schedule) {
      for (const JV& op : schedule->arr) {
        if ((int)op.get("frame")->num != frame) continue;
        std::string o = op.get("op")->str;
        Id id = idFromJV(*op.get("id"));
        if (o == "removeCar") eng->removeCar(id);
        else if (o == "rekeyCar") {
          Id newId = idFromJV(*op.get("newId"));
          eng->rekeyCar(id, newId);
          // remap idByKey / botKeys / controllers, exactly as verify-trace's onRekey:
          // DELETE the old key, SET the new key -> newId (not just rename the key,
          // which would leave the stale Id value and drop the car's later inputs).
          std::string ok = id.key(), nk = newId.key();
          idByKey.erase(std::remove_if(idByKey.begin(), idByKey.end(),
                                       [&](const std::pair<std::string, Id>& kv) { return kv.first == ok; }),
                        idByKey.end());
          idByKey.emplace_back(nk, newId);
          for (auto& bk : botKeys) if (bk == ok) bk = nk;
          for (auto& c : controllers) if (c.id.key() == ok) c.id = newId;
        } else if (o == "setCarStats") { eng->setCarStats(id, statsFromJV(*op.get("stats"))); }
        else if (o == "giveItem") {
          std::string item = op.get("item")->str;
          bool hasT = false; double t = 0;
          if (const JV* opts = op.get("opts")) if (const JV* x = opts->get("tCatch")) { hasT = true; t = x->num; }
          eng->giveItem(id, item, hasT, t);
        } else if (o == "useItem") eng->useItem(id);
        else if (o == "forceFinish") {
          bool hasT = op.has("time"); double t = hasT ? op.get("time")->num : 0;
          eng->forceFinish(id, hasT, t);
        } else { std::fprintf(stderr, "FAIL %s: unknown schedule op '%s'\n", file.c_str(), o.c_str()); return 1; }
      }
    }

    // recorded inputs
    const JV* inputs = rec.get("inputs");
    if (inputs) {
      for (const auto& kv : inputs->obj) {
        const std::string& key = kv.first;
        if (aiLive) { bool isBot = false; for (auto& bk : botKeys) if (bk == key) { isBot = true; break; } if (isBot) continue; }
        Id id;
        if (!lookupId(key, id)) {
          fail(file, frame, "inputs." + key, "<roster>", "<absent>", "input for id not in roster (corrupt trace)");
          return 1;
        }
        Input msg = inputFromJV(kv.second);
        if (session) session->processInput(id, msg); else eng->processInput(id, msg);
      }
    }

    // ai-live: re-run each bot's controller and compare BEFORE applying
    if (aiLive && (!session || session->racing())) {
      for (auto& c : controllers) {
        Input derived;
        bool applied = eng->driveBot(c.id, *c.ai, &derived);
        // recorded input for this bot
        const JV* recorded = inputs ? inputs->get(c.id.key().c_str()) : nullptr;
        if (applied) {
          Value dv = Value::Obj();
          dv.set("s", Value::Num(derived.s));
          dv.set("b", Value::Num(derived.b));
          dv.set("u", Value::Num(derived.u));
          if (!recorded) {
            fail(file, frame, "inputs." + c.id.key(), "<absent>", canonical_stringify(dv), "AI-LIVE: bot drove but trace has no input");
            return 1;
          }
          Diff d = diffVal(*recorded, dv, "inputs." + c.id.key());
          if (d.differ) { fail(file, frame, d.path, d.expected, d.actual, "AI-LIVE divergence for bot " + c.id.key()); return 1; }
        }
      }
    }

    double dtF = dtFor(frame);
    if (session) session->update(dtF); else eng->update(dtF);

    // session beats
    if (session) {
      // countdown
      std::vector<int> got = ticks; ticks.clear();
      const JV* recCd = rec.get("countdown");
      if (!got.empty()) {
        Value gv = Value::Arr(); for (int n : got) gv.push(Value::Num(n));
        if (!recCd) { fail(file, frame, "countdown", "<absent>", canonical_stringify(gv), "countdown ticks fired but trace records none"); return 1; }
        Diff d = diffVal(*recCd, gv, "countdown");
        if (d.differ) { fail(file, frame, d.path, d.expected, d.actual, "countdown diverged"); return 1; }
      } else if (recCd) {
        fail(file, frame, "countdown", canonJV(*recCd), "<absent>", "trace records countdown ticks that did not fire");
        return 1;
      }
      // racing flip
      const JV* recRacing = rec.get("racing");
      bool nowRacing = session->racing();
      if (nowRacing != lastRacing) {
        bool exp = recRacing && recRacing->b;
        if (!recRacing || exp != nowRacing) {
          fail(file, frame, "racing", recRacing ? (recRacing->b ? "true" : "false") : "<absent>",
               nowRacing ? "true" : "false", "racing flip mismatch");
          return 1;
        }
        lastRacing = nowRacing;
      } else if (recRacing) {
        fail(file, frame, "racing", recRacing->b ? "true" : "false", "<no flip>", "trace records a racing flip that did not happen");
        return 1;
      }
      // raceEnd
      const JV* recEnd = rec.get("raceEnd");
      if (haveRaceEnd) {
        if (!recEnd) { fail(file, frame, "raceEnd", "<absent>", canonical_stringify(raceEndResults), "race ended but trace records no raceEnd"); return 1; }
        Diff d = diffVal(*recEnd, raceEndResults, "raceEnd");
        if (d.differ) { fail(file, frame, d.path, d.expected, d.actual, "raceEnd diverged"); return 1; }
        haveRaceEnd = false;
      } else if (recEnd) {
        fail(file, frame, "raceEnd", canonJV(*recEnd), "<absent>", "trace records raceEnd that did not happen");
        return 1;
      }
    }

    // events (every frame)
    Value events = Value::Arr();
    for (const Event& e : pending) events.push(e.toValue());
    pending.clear();
    const JV* recEvents = rec.get("events");
    JV emptyArr; emptyArr.t = JV::ARR;
    const JV& re = recEvents ? *recEvents : emptyArr;
    { Diff d = diffVal(re, events, "events");
      if (d.differ) { fail(file, frame, d.path, d.expected, d.actual, "events diverged"); return 1; } }

    // snapshot
    Value snapshot = eng->getSnapshot();
    if (const JV* recSnap = rec.get("snapshot")) {
      Diff d = diffVal(*recSnap, snapshot, "snapshot");
      if (d.differ) { fail(file, frame, d.path, d.expected, d.actual, "snapshot diverged"); return 1; }
    }

    // hash (every frame)
    std::string hash = fnv1a_hex(canonical_stringify(snapshot));
    const JV* recHash = rec.get("hash");
    if (!recHash || recHash->str != hash) {
      fail(file, frame, "", recHash ? recHash->str : "<absent>", hash,
           "snapshot hash diverged (no full snapshot this frame — next stored snapshot localizes)");
      return 1;
    }
  }

  if (recCount != frames) {
    std::fprintf(stderr, "FAIL %s: header says %d frames, trace carries %d\n", file.c_str(), frames, recCount);
    return 1;
  }
  std::printf("PASS %s (%d frames, exact)\n", file.c_str(), recCount);
  return 0;
}
