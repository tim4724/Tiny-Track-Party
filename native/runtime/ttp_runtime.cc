// ttp_runtime.cc — the C ABI implementation (see ttp_runtime.h).
//
// Each handle owns a RuntimeSession: the built track, the added players, and
// either a RaceSession (countdown mode) or a bare Game (countdown < 0, the
// input-replay / golden-trace equivalent). The session's onEvent/onCountdown/
// onRaceEnd callbacks funnel into one ordered event queue that ttp_events_json
// drains. Bots are driven inside ttp_update, mirroring the live render loop.

#include "ttp_runtime.h"
#include "ttp_session.h"

#include <map>
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
#include "ttp/race_track.h"
#include "ttp/race_track_json.h"
#include "ttp/json_parse.h"
#include "ttp/grand_prix.h"
#include "ttp/race_session.h"
#include "ttp/trackbuilder.h"

using namespace ttp;

static const int CONTRACT_VERSION = 2;
static const char* MATHLIB = "fdlibm-openlibm-0.8.7";

// ---------------------------------------------------------------------------
// Flat stats parsing (ids parse via ttp/scalar_id.h).
// ---------------------------------------------------------------------------
// Flat numeric stats object; absent or non-numeric members keep the benchmark
// default. Each key is read as a real object member, not matched as a substring
// of the raw text.
static Stats parseStats(const char* json) {
  Stats st;
  if (!json) return st;
  bool ok = false;
  Value v = json::parse(json, &ok);
  if (!ok || v.type != Value::OBJ) return st;
  auto num = [&v](const char* key, double& dst) {
    const Value* f = v.find(key);
    if (f && f->type == Value::NUM) dst = f->num;
  };
  num("accel", st.accel);
  num("vmax", st.vmax);
  num("turn", st.turn);
  num("mass", st.mass);
  num("halfLen", st.halfLen);
  num("halfWid", st.halfWid);
  return st;
}

// ---------------------------------------------------------------------------
// Track descriptor -> TrackDef (ttp_track_build_json).
//
// The twin of scripts/gen-track-defs-header.mjs, which bakes the SHIPPED
// catalogue into generated/track_defs.h at build time. This does the same job at
// run time for a descriptor that is not in the catalogue — an authoring tool's
// candidate layout. Both must read a descriptor identically or a track would
// measure one way in the tool and build another way in the game, so the field
// rules below are deliberately the same rules, in the same order.
//
// The PRESENCE rules are the subtle part (the codegen's own notes spell out why):
//   furniture radius : absent -> derived from the road width, not 0
//   segment  width   : absent -> default, number -> scalar, [a,b] -> taper
//   segment  over    : absent -> true (only an explicit false flips it)
//   waypoint w       : absent -> the track width, carried as a 0 sentinel
// Everything else the builder reads as `x || 0`, so a missing field is a real 0.
// ---------------------------------------------------------------------------

// Owns the arrays TrackDef points into; `def` is only valid while this lives.
struct ParsedTrackDef {
  TrackDef def{};
  std::string id;
  std::vector<SegDef> segs;
  std::vector<WptDef> wpts;
  std::vector<FurnDef> oils, pads, boxes, poles;
  std::vector<BananaDef> bananas;
};

static const double kRoadWidthFallback = 2.5;  // TrackBuilder ROAD_WIDTH

static double numOr(const Value& v, const char* key, double dflt) {
  const Value* f = v.find(key);
  return (f && f->type == Value::NUM) ? f->num : dflt;
}
static bool boolOr(const Value& v, const char* key, bool dflt) {
  const Value* f = v.find(key);
  return (f && f->type == Value::BOOL) ? f->b : dflt;
}

static bool parseSeg(const Value& s, SegDef& out) {
  if (s.type != Value::OBJ) return false;
  const Value* kind = s.find("kind");
  if (!kind || kind->type != Value::STR) return false;
  if (kind->str == "straight") out.kind = SegKind::Straight;
  else if (kind->str == "arc") out.kind = SegKind::Arc;
  else if (kind->str == "loop") out.kind = SegKind::Loop;
  else return false;  // an unknown kind is a typo, not a track
  out.length = numOr(s, "length", 0);
  out.radius = numOr(s, "radius", 0);
  out.angle = numOr(s, "angle", 0);
  out.rise = numOr(s, "rise", 0);
  out.bank = numOr(s, "bank", 0);
  out.roll = numOr(s, "roll", 0);
  out.drift = numOr(s, "drift", 0);
  out.over = boolOr(s, "over", true);
  out.pillars = boolOr(s, "pillars", false);
  out.widthKind = 0;
  out.w0 = 0;
  out.w1 = 0;
  if (const Value* w = s.find("width")) {
    if (w->type == Value::NUM) { out.widthKind = 1; out.w0 = w->num; }
    else if (w->type == Value::ARR && w->arr.size() == 2
             && w->arr[0].type == Value::NUM && w->arr[1].type == Value::NUM) {
      out.widthKind = 2; out.w0 = w->arr[0].num; out.w1 = w->arr[1].num;
    } else if (w->type != Value::NUL) return false;
  }
  return true;
}

static bool parseWpt(const Value& w, WptDef& out) {
  if (w.type != Value::OBJ) return false;
  const Value* x = w.find("x");
  const Value* z = w.find("z");
  if (!x || x->type != Value::NUM || !z || z->type != Value::NUM) return false;
  out.x = x->num;
  out.z = z->num;
  out.y = numOr(w, "y", 0);
  out.w = numOr(w, "w", 0);  // 0 == absent: the builder substitutes the track width
  out.bank = numOr(w, "bank", 0);
  out.bridge = boolOr(w, "bridge", false);
  return true;
}

static bool parseFurn(const Value& f, FurnDef& out) {
  if (f.type != Value::OBJ) return false;
  const Value* u = f.find("u");
  if (!u || u->type != Value::NUM) return false;
  out.u = u->num;
  out.lat = numOr(f, "lat", 0);
  const Value* r = f.find("radius");
  out.hasRadius = r && r->type == Value::NUM;
  out.radius = out.hasRadius ? r->num : 0;
  return true;
}

template <class T, class F>
static bool parseList(const Value& desc, const char* key, std::vector<T>& out, F parse1) {
  const Value* arr = desc.find(key);
  if (!arr) return true;                       // absent == none
  if (arr->type == Value::NUL) return true;
  if (arr->type != Value::ARR) return false;
  out.reserve(arr->arr.size());
  for (const Value& e : arr->arr) {
    T item{};
    if (!parse1(e, item)) return false;
    out.push_back(item);
  }
  return true;
}

static bool parse_track_def(const Value& desc, ParsedTrackDef& p) {
  const Value* wpts = desc.find("waypoints");
  const Value* segs = desc.find("segments");
  const bool isSpline = wpts && wpts->type == Value::ARR;
  const bool hasSegs = segs && segs->type == Value::ARR;
  // Exactly one geometry source, matching the codegen's two failure cases.
  if (isSpline == hasSegs) return false;

  if (const Value* id = desc.find("id")) {
    if (id->type == Value::STR) p.id = id->str;
  }
  p.def.id = p.id.c_str();
  p.def.isSpline = isSpline;
  // The codegen's `(desc.width) || ROAD_WIDTH`, spelled out: C++ `||` is boolean,
  // so writing it the JS way silently yields 1.0 for every track that omits a
  // width — a half-width road, and every derived furniture radius with it.
  const double width = numOr(desc, "width", 0);
  p.def.width = width != 0 ? width : kRoadWidthFallback;
  p.def.startU = numOr(desc, "startU", 0);

  if (isSpline) {
    if (!parseList(desc, "waypoints", p.wpts, parseWpt)) return false;
    if (p.wpts.empty()) return false;
  } else {
    if (!parseList(desc, "segments", p.segs, parseSeg)) return false;
    if (p.segs.empty()) return false;
  }
  if (!parseList(desc, "oils", p.oils, parseFurn)) return false;
  if (!parseList(desc, "pads", p.pads, parseFurn)) return false;
  if (!parseList(desc, "boxes", p.boxes, parseFurn)) return false;
  if (!parseList(desc, "poles", p.poles, parseFurn)) return false;
  if (!parseList(desc, "bananas", p.bananas, [](const Value& b, BananaDef& out) {
        if (b.type != Value::OBJ) return false;
        const Value* u = b.find("u");
        if (!u || u->type != Value::NUM) return false;
        out.u = u->num;
        out.lat = numOr(b, "lat", 0);
        return true;
      })) return false;

  p.def.segs = p.segs.empty() ? nullptr : p.segs.data();
  p.def.nSegs = (int) p.segs.size();
  p.def.wpts = p.wpts.empty() ? nullptr : p.wpts.data();
  p.def.nWpts = (int) p.wpts.size();
  p.def.oils = p.oils.empty() ? nullptr : p.oils.data();
  p.def.nOils = (int) p.oils.size();
  p.def.pads = p.pads.empty() ? nullptr : p.pads.data();
  p.def.nPads = (int) p.pads.size();
  p.def.boxes = p.boxes.empty() ? nullptr : p.boxes.data();
  p.def.nBoxes = (int) p.boxes.size();
  p.def.poles = p.poles.empty() ? nullptr : p.poles.data();
  p.def.nPoles = (int) p.poles.size();
  p.def.bananas = p.bananas.empty() ? nullptr : p.bananas.data();
  p.def.nBananas = (int) p.bananas.size();
  return true;
}

// ---------------------------------------------------------------------------
// Per-handle session.
// ---------------------------------------------------------------------------
struct BotEntry {
  Id id;
  bool hasStats = false;
  Stats stats;
  double caution = 1, laneBias = 0;
  uint32_t aiSeed = 0;
  std::unique_ptr<AiController> ai;  // built at start
};

struct RuntimeSession {
  std::unique_ptr<Centerline> centerline;
  GameTrack track;
  std::string forceItem;
  std::vector<PlayerDesc> humans;  // add order
  std::vector<BotEntry> bots;      // add order

  bool started = false;  // startCountdown fired (or bare mode running)
  bool built = false;    // session objects constructed (may precede started)
  bool bare = false;
  bool racingBare = false;
  bool pausedBare = false;

  std::unique_ptr<Game> game;            // bare-mode owner
  std::unique_ptr<RaceSession> session;  // countdown-mode owner
  Game* eng = nullptr;

  std::vector<Value> outQueue;
  std::string scratch;

  // Drive every bot's controller (a no-op for finished/removed cars). Add order.
  void driveBots() {
    for (auto& b : bots)
      if (b.ai) eng->driveBot(b.id, *b.ai, nullptr);
  }
};

static std::map<int, std::unique_ptr<RuntimeSession>> g_sessions;
static int g_next = 1;

static RuntimeSession* get(int h) {
  auto it = g_sessions.find(h);
  return it == g_sessions.end() ? nullptr : it->second.get();
}

// Track assembly is shared (ttp/race_track.h) so the ABI, the replay/record CLI
// and the probes cannot drift apart. The session owns the centerline the
// GameTrack points at, so the built pair is moved onto it wholesale.
static bool buildTrack(RuntimeSession& rs, const std::string& trackId, int laps, uint32_t seed) {
  BuiltRaceTrack bt;
  std::string err;
  if (!build_race_track_by_id(trackId, laps, seed, bt, err)) return false;
  rs.centerline = std::move(bt.centerline);
  rs.track = std::move(bt.game);
  rs.track.centerline = rs.centerline.get();   // re-point after the move
  return true;
}

// A shared "no session" string result for calls on a bad/unstarted handle.
static const char* NULL_JSON = "null";
static const char* EMPTY_ARR = "[]";

static void buildSession(RuntimeSession* rs);

// ttp_session.h — the display's read-only seam onto the live engine. Same lazy
// build every other query does, so binding a display to a begun-but-not-started
// handle draws the grid poses rather than nothing.
ttp::Game* ttp_session_engine(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return nullptr;
  if (!rs->eng) buildSession(rs);
  return rs->eng;
}

// ---------------------------------------------------------------------------
// ABI.
// ---------------------------------------------------------------------------
extern "C" {

int ttp_session_begin(const char* trackId, uint32_t seed, int laps, const char* forceItemOrNull) {
  if (!trackId) return 0;
  auto rs = std::make_unique<RuntimeSession>();
  if (!buildTrack(*rs, trackId, laps, seed)) return 0;
  rs->forceItem = forceItemOrNull ? forceItemOrNull : "";
  int h = g_next++;
  g_sessions[h] = std::move(rs);
  return h;
}

void ttp_add_human(int h, const char* idJson, const char* statsJsonOrNull) {
  RuntimeSession* rs = get(h);
  if (!rs || rs->started || rs->built) return;
  PlayerDesc p;
  p.id = parse_scalar_id(idJson);
  if (statsJsonOrNull) { p.hasStats = true; p.stats = parseStats(statsJsonOrNull); }
  rs->humans.push_back(p);
}

void ttp_add_bot(int h, const char* idJson, double caution, double laneBias,
                 uint32_t aiSeed, const char* statsJsonOrNull) {
  RuntimeSession* rs = get(h);
  if (!rs || rs->started || rs->built) return;
  BotEntry b;
  b.id = parse_scalar_id(idJson);
  b.caution = caution;
  b.laneBias = laneBias;
  b.aiSeed = aiSeed;
  if (statsJsonOrNull) { b.hasStats = true; b.stats = parseStats(statsJsonOrNull); }
  rs->bots.push_back(std::move(b));
}

// Build every bot's controller and, with them, the racing line they share. Both
// session modes need exactly this; written out twice, a persona knob could be
// dropped from one path with the other still covering it.
//
// The racing line is primed HERE rather than left to build on first use, because
// first use is the first frame a bot drives — the GO! beat, the exact frame the
// player first touches the throttle. Solving it costs 4.3-5.5 ms against a
// 0.013 ms steady frame, so it read as a stutter on the start line. It is pure
// precomputation over a centerline that cannot change, so every trace hashes
// identically either way.
static void buildBots(RuntimeSession& rs) {
  for (auto& b : rs.bots)
    b.ai = std::make_unique<AiController>(b.caution, LOOKAHEAD, STEER_GAIN, b.laneBias, b.aiSeed);
  if (!rs.bots.empty()) rs.eng->racingLine();
}

// Construct the RaceSession + bot controllers WITHOUT firing the countdown.
// Called from ttp_session_start, and LAZILY from any query on a begun-but-not-
// started handle: the JS RaceSession builds its Game in the constructor, so
// the display reads grid-pose snapshots BEFORE startCountdown — the ABI must
// answer those (main.js launchRace paints the grid, then starts the count).
static void buildSession(RuntimeSession* rs) {
  if (rs->built || rs->bare) return;
  rs->built = true;

  // Grid order: humans first, then bots, both in add order.
  std::vector<PlayerDesc> players = rs->humans;
  for (auto& b : rs->bots) players.push_back(PlayerDesc{b.id, b.hasStats, b.stats});

  RuntimeSession* self = rs;
  auto onEvent = [self](const Event& e) { self->outQueue.push_back(e.toValue()); };
  auto onTick = [self](int n) {
      Value c = Value::Obj();
      c.set("type", Value::Str("_countdown"));
      c.set("n", Value::Num((double)n));
      self->outQueue.push_back(std::move(c));
      if (n == 0) {  // GO beat: racing flips right after this tick (RaceSession.js)
        Value s = Value::Obj();
        s.set("type", Value::Str("_raceStart"));
        self->outQueue.push_back(std::move(s));
      }
    };
    auto onEnd = [self](const Value& r) {
      Value e = Value::Obj();
      e.set("type", Value::Str("_raceEnd"));
      e.set("results", r);  // the getResults() object the adapter hands to onRaceEnd
      self->outQueue.push_back(std::move(e));
    };
  rs->session = std::make_unique<RaceSession>(players, rs->track, onEvent, onEnd, onTick,
                                              rs->forceItem);
  rs->eng = &rs->session->engine();

  buildBots(*rs);  // the field (and its cars) exist now
}

void ttp_session_start(int h, int countdownSeconds) {
  RuntimeSession* rs = get(h);
  if (!rs || rs->started) return;

  if (countdownSeconds < 0) {
    // Bare-Game mode (conformance replay): racing from frame 0, no countdown/
    // session beats. Incompatible with a lazily built session.
    if (rs->built) return;
    rs->started = true;
    rs->bare = true;
    rs->racingBare = true;
    std::vector<PlayerDesc> players = rs->humans;
    for (auto& b : rs->bots) players.push_back(PlayerDesc{b.id, b.hasStats, b.stats});
    RuntimeSession* self = rs;
    auto onEvent = [self](const Event& e) { self->outQueue.push_back(e.toValue()); };
    rs->game = std::make_unique<Game>(players, rs->track, onEvent, rs->forceItem);
    rs->eng = rs->game.get();
    buildBots(*rs);
    return;
  }

  buildSession(rs);
  rs->started = true;
  rs->session->startCountdown(countdownSeconds);
}

void ttp_update(int h, double dtMs) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->started) return;
  if (rs->bare) {
    if (rs->pausedBare) return;
    if (rs->racingBare) {
      rs->driveBots();
      rs->eng->update(dtMs);
    }
  } else {
    if (rs->session->paused()) return;
    if (rs->session->racing()) rs->driveBots();  // drive-then-update, only while racing
    rs->session->update(dtMs);
  }
}

void ttp_process_input(int h, const char* idJson, int mask, double s, double b, double u) {
  RuntimeSession* rs = get(h);
  if (!rs) return;
  if (!rs->eng) buildSession(rs);
  if (!rs->eng) return;
  Input in;
  if (mask & 1) { in.hasS = true; in.s = s; }
  if (mask & 2) { in.hasB = true; in.b = b; }
  if (mask & 4) { in.hasU = true; in.u = u; }
  rs->eng->processInput(parse_scalar_id(idJson), in);
}

const char* ttp_snapshot_json(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return NULL_JSON;
  if (!rs->eng) buildSession(rs);
  if (!rs->eng) return NULL_JSON;
  canonical_stringify_into(rs->eng->getSnapshot(), rs->scratch);
  return rs->scratch.c_str();
}

const char* ttp_results_json(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return NULL_JSON;
  if (!rs->eng) buildSession(rs);
  if (!rs->eng) return NULL_JSON;
  canonical_stringify_into(rs->eng->getResults(), rs->scratch);
  return rs->scratch.c_str();
}

const char* ttp_events_json(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return EMPTY_ARR;
  Value arr = Value::Arr();
  for (auto& e : rs->outQueue) arr.push(std::move(e));
  rs->outQueue.clear();
  canonical_stringify_into(arr, rs->scratch);
  return rs->scratch.c_str();
}

int ttp_has_car(int h, const char* idJson) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  return rs && rs->eng && rs->eng->hasCar(parse_scalar_id(idJson)) ? 1 : 0;
}

int ttp_car_finished(int h, const char* idJson) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng) return -1;
  bool out = false;
  if (!rs->eng->carFinished(parse_scalar_id(idJson), out)) return -1;
  return out ? 1 : 0;
}

const char* ttp_car_ids_json(int h) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng) return EMPTY_ARR;
  Value arr = Value::Arr();
  for (const auto& c : rs->eng->cars()) arr.push(c->id.toValue());
  canonical_stringify_into(arr, rs->scratch);
  return rs->scratch.c_str();
}

int ttp_car_world_pos(int h, const char* idJson, double* out3) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng || !out3) return 0;
  Id id = parse_scalar_id(idJson);
  for (const auto& c : rs->eng->cars()) {
    if (c->id == id) {
      out3[0] = c->pose.pos.x;
      out3[1] = c->pose.pos.y;
      out3[2] = c->pose.pos.z;
      return 1;
    }
  }
  return 0;
}

int ttp_track_point(int h, double s, double lat, double* out3) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng || !out3) return 0;
  Frame f = rs->eng->centerline()->sampleAt(s);  // fresh frame
  f.pos.addScaledVector(f.lateral, lat);
  out3[0] = f.pos.x;
  out3[1] = f.pos.y;
  out3[2] = f.pos.z;
  return 1;
}

int ttp_force_remove_car(int h, const char* idJson) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->eng) return 0;
  Id id = parse_scalar_id(idJson);
  if (rs->session) return rs->session->forceRemoveCar(id) ? 1 : 0;
  return rs->eng->removeCar(id) ? 1 : 0;
}

int ttp_rekey_car(int h, const char* oldJson, const char* newJson) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->eng) return 0;
  return rs->eng->rekeyCar(parse_scalar_id(oldJson), parse_scalar_id(newJson)) ? 1 : 0;
}

void ttp_force_finish(int h, const char* idJson, double time) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->eng) return;
  rs->eng->forceFinish(parse_scalar_id(idJson), true, time);
}

void ttp_fast_forward(int h) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->eng) return;
  if (rs->session) {
    RuntimeSession* self = rs;
    rs->session->fastForwardToEnd([self]() { self->driveBots(); });
  } else if (rs->racingBare && !rs->pausedBare) {
    long guard = 0;
    while (!rs->eng->raceOver() && guard++ < 100000) {
      rs->driveBots();
      rs->eng->update(1000.0 / 30.0);
    }
  }
}

void ttp_pause(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return;
  if (rs->session) rs->session->pause();
  else rs->pausedBare = true;
}

void ttp_resume(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return;
  if (rs->session) rs->session->resume();
  else rs->pausedBare = false;
}

int ttp_racing(int h) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->started) return 0;
  if (rs->session) return rs->session->racing() ? 1 : 0;
  return rs->racingBare ? 1 : 0;
}

int ttp_paused(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return 0;
  if (rs->session) return rs->session->paused() ? 1 : 0;
  return rs->pausedBare ? 1 : 0;
}

void ttp_dispose(int h) {
  auto it = g_sessions.find(h);
  if (it == g_sessions.end()) return;
  if (it->second->session) it->second->session->dispose();
  g_sessions.erase(it);
}

void ttp_set_steer_expo(double v) { setSteerExpo(v); }
double ttp_get_steer_expo(void) { return getSteerExpo(); }


// =============================================================================
// Grand Prix / cup series.
// =============================================================================
namespace {
struct GpHandle {
  // The host's offered draw for this apply_race; CupSeries pulls it through the
  // drawNext callback only if the rules call for a draw.
  std::string pendingDraw;
  bool endless = false;
  std::unique_ptr<CupSeries> series;
  std::string scratch;
};
std::map<int, std::unique_ptr<GpHandle>> g_gps;
int g_nextGp = 1;
static GpHandle* gp(int h) {
  auto it = g_gps.find(h);
  return it == g_gps.end() ? nullptr : it->second.get();
}
static Id gpIdFrom(const Value& v) {
  if (v.type == Value::NUM) return Id::Num(v.num);
  if (v.type == Value::STR) return Id::Str(v.str);
  return Id::None();
}

}  // namespace

int ttp_gp_create(const char* cupJson, int endless) {
  bool ok = false;
  Value c = cupJson && *cupJson ? json::parse(cupJson, &ok) : Value::Null();
  if (!ok || c.type != Value::OBJ) return 0;
  GpCup cup;
  if (const Value* x = c.find("id")) cup.id = x->str;
  if (const Value* x = c.find("name")) cup.name = x->str;
  if (const Value* x = c.find("tracks")) {
    if (x->type != Value::ARR) return 0;
    for (const Value& t : x->arr) cup.tracks.push_back(t.str);
  }
  if (cup.tracks.empty()) return 0;

  auto gh = std::make_unique<GpHandle>();
  GpHandle* raw = gh.get();
  raw->endless = endless != 0;
  if (raw->endless) {
    gh->series = std::make_unique<CupSeries>(cup, [raw]() { return raw->pendingDraw; });
  } else {
    gh->series = std::make_unique<CupSeries>(cup);
  }
  const int h = g_nextGp++;
  g_gps[h] = std::move(gh);
  return h;
}

void ttp_gp_dispose(int h) { g_gps.erase(h); }

int ttp_gp_endless(int h) { GpHandle* g = gp(h); return (g && g->series->endless()) ? 1 : 0; }
int ttp_gp_race_count(int h) { GpHandle* g = gp(h); return g ? g->series->raceCount() : 0; }
int ttp_gp_race_index(int h) { GpHandle* g = gp(h); return g ? g->series->raceIndex() : 0; }
int ttp_gp_finished(int h) { GpHandle* g = gp(h); return (g && g->series->finished()) ? 1 : 0; }

const char* ttp_gp_current_track(int h) {
  GpHandle* g = gp(h);
  if (!g) return "";
  g->scratch = g->series->currentTrackId();
  return g->scratch.c_str();
}

const char* ttp_gp_next_track(int h) {
  GpHandle* g = gp(h);
  if (!g) return "";
  g->scratch = g->series->nextTrackId();   // "" == JS null
  return g->scratch.c_str();
}

const char* ttp_gp_cup_json(int h) {
  GpHandle* g = gp(h);
  if (!g) return "null";
  const GpCup& c = g->series->cup();
  Value o = Value::Obj();
  o.set("id", Value::Str(c.id));
  o.set("name", Value::Str(c.name));
  Value tr = Value::Arr();
  for (const std::string& t : c.tracks) tr.push(Value::Str(t));
  o.set("tracks", std::move(tr));
  canonical_stringify_into(o, g->scratch);
  return g->scratch.c_str();
}

void ttp_gp_apply_race(int h, const char* resultsJson, const char* fieldJson,
                       const char* drawnTrackIdOrNull) {
  GpHandle* g = gp(h);
  if (!g) return;
  g->pendingDraw = drawnTrackIdOrNull ? drawnTrackIdOrNull : "";

  std::vector<GpResult> results;
  bool ok = false;
  Value r = resultsJson && *resultsJson ? json::parse(resultsJson, &ok) : Value::Null();
  if (ok && r.type == Value::ARR) {
    for (const Value& e : r.arr) {
      GpResult gr{Id::None(), 0, false};
      if (const Value* x = e.find("playerId")) gr.playerId = gpIdFrom(*x);
      if (const Value* x = e.find("rank")) gr.rank = (int)x->num;
      if (const Value* x = e.find("finished")) gr.finished = x->b;
      results.push_back(gr);
    }
  }

  std::vector<GpFieldEntry> field;
  ok = false;
  Value f = fieldJson && *fieldJson ? json::parse(fieldJson, &ok) : Value::Null();
  if (ok && f.type == Value::ARR) {
    for (const Value& e : f.arr) {
      GpFieldEntry fe{Id::None(), "", 0, false};
      if (const Value* x = e.find("peerIndex")) fe.peerIndex = gpIdFrom(*x);
      if (const Value* x = e.find("name")) fe.name = x->str;
      if (const Value* x = e.find("colorIndex")) fe.colorIndex = (int)x->num;
      if (const Value* x = e.find("ai")) fe.ai = x->b;
      field.push_back(fe);
    }
  }
  g->series->applyRace(results, field);
}

void ttp_gp_advance(int h) { GpHandle* g = gp(h); if (g) g->series->advance(); }

const char* ttp_gp_standings_json(int h) {
  GpHandle* g = gp(h);
  if (!g) return "[]";
  Value arr = Value::Arr();
  for (const GpStanding& st : g->series->standings()) {
    Value o = Value::Obj();
    o.set("playerId", st.playerId.toValue());
    // An unseated row's name/colorIndex are JS undefined, i.e. ABSENT keys —
    // Value's default UNDEF is dropped by canonical_stringify, so leaving them
    // unset is exactly what the JS twin serialized.
    if (!st.seatNull) {
      o.set("name", Value::Str(st.name));
      o.set("colorIndex", Value::Num(st.colorIndex));
    }
    o.set("ai", Value::Bool(st.ai));
    o.set("points", Value::Num(st.points));
    o.set("gained", Value::Num(st.gained));
    o.set("lastRank", st.lastRankNull ? Value::Null() : Value::Num(st.lastRank));
    arr.push(std::move(o));
  }
  canonical_stringify_into(arr, g->scratch);
  return g->scratch.c_str();
}

void ttp_gp_rekey(int h, const char* oldIdJson, const char* newIdJson) {
  GpHandle* g = gp(h);
  if (!g) return;
  bool ok1 = false, ok2 = false;
  Value a = json::parse(oldIdJson, &ok1), b = json::parse(newIdJson, &ok2);
  if (!ok1 || !ok2) return;
  g->series->rekey(gpIdFrom(a), gpIdFrom(b));
}

const char* ttp_track_json(const char* trackId, int laps, uint32_t seed) {
  static std::string out;
  if (!trackId) return nullptr;
  const TrackDef* def = find_track_def(trackId);
  if (!def) return nullptr;
  const RaceTrack rt = build_race_track(*def, laps, seed);
  const rtjson::Writer w(rtjson::decimal_number);
  out = w.object(rt);
  return out.c_str();
}

const char* ttp_track_build_json(const char* descriptorJson, int laps, uint32_t seed) {
  static std::string out;
  if (!descriptorJson) return nullptr;
  bool ok = false;
  const Value desc = json::parse(descriptorJson, &ok);
  if (!ok || desc.type != Value::OBJ) return nullptr;

  // The arrays TrackDef points into must outlive build_race_track, so they live
  // here for the length of the call.
  ParsedTrackDef parsed;
  if (!parse_track_def(desc, parsed)) return nullptr;

  const RaceTrack rt = build_race_track(parsed.def, laps, seed);
  const rtjson::Writer w(rtjson::decimal_number);
  out = w.object(rt);
  return out.c_str();
}

// Resolve an "id or descriptor" argument into a built track. A leading '{' is
// the only thing that distinguishes the two, and no track id can start with one.
static bool build_by_id_or_descriptor(const char* arg, RaceTrack& out) {
  if (!arg) return false;
  if (arg[0] == '{') {
    bool ok = false;
    const Value desc = json::parse(arg, &ok);
    if (!ok || desc.type != Value::OBJ) return false;
    ParsedTrackDef parsed;
    if (!parse_track_def(desc, parsed)) return false;
    out = build_race_track(parsed.def, 3, 1u);
    return true;
  }
  const TrackDef* def = find_track_def(arg);
  if (!def) return false;
  out = build_race_track(*def, 3, 1u);
  return true;
}

// The built track's samples as a Centerline, for the interpolating queries.
static Centerline centerline_of(const RaceTrack& rt) {
  std::vector<Sample> cs;
  cs.reserve(rt.samples.size());
  for (const OutSample& s : rt.samples) {
    Sample c;
    c.pos = s.pos; c.tangent = s.tangent; c.up = s.up; c.lateral = s.lateral;
    c.width = s.width; c.s = s.s;
    cs.push_back(c);
  }
  return Centerline(std::move(cs), rt.length);
}

// One interpolated frame, as the shape the tools read.
static Value frameValue(Centerline& cl, double s);

static Value vec3Value(const Vec3& v) {
  Value o = Value::Obj();
  o.set("x", Value::Num(v.x));
  o.set("y", Value::Num(v.y));
  o.set("z", Value::Num(v.z));
  return o;
}

static Value frameValue(Centerline& cl, double s) {
  const Frame f = cl.sampleAt(s);
  Value o = Value::Obj();
  o.set("s", Value::Num(s));
  o.set("pos", vec3Value(f.pos));
  o.set("tangent", vec3Value(f.tangent));
  o.set("up", vec3Value(f.up));
  o.set("lateral", vec3Value(f.lateral));
  o.set("width", Value::Num(f.width));
  return o;
}

const char* ttp_track_supports_json(const char* trackIdOrDescriptor) {
  static std::string out;
  RaceTrack rt;
  if (!build_by_id_or_descriptor(trackIdOrDescriptor, rt)) return nullptr;

  // The audit treats a bridge pillar and a loop shaft alike; they differ only in
  // where their top sits (a shaft is cut to the deck underside it holds up).
  struct Probe { Post post; const char* kind; };
  std::vector<Probe> probes;
  probes.reserve(rt.pillars.size() + rt.supportPosts.size());
  for (const Pillar& p : rt.pillars)
    probes.push_back({ Post{ p.x, p.z, p.radius, p.baseY, p.topY }, "pillar" });
  for (const SupportPost& p : rt.supportPosts)
    probes.push_back({ Post{ p.x, p.z, p.radius, p.baseY, p.contactPos.y }, "shaft" });

  Value posts = Value::Arr();
  for (const Probe& pr : probes) {
    double worst = 0, at = 0;
    bool any = false;
    for (const OutSample& sm : rt.samples) {
      const PostHit hit = post_at_sample(sm, pr.post);
      if (!hit.valid) continue;
      if (!any || hit.intrusion > worst) { worst = hit.intrusion; at = sm.s; any = true; }
    }
    Value o = Value::Obj();
    o.set("kind", Value::Str(pr.kind));
    o.set("x", Value::Num(pr.post.x));
    o.set("z", Value::Num(pr.post.z));
    o.set("radius", Value::Num(pr.post.radius));
    // No sample ever had a say: the post is nowhere near a corridor. Report it as
    // fully clear rather than as a zero-depth graze.
    o.set("intrusion", Value::Num(any ? worst : -1.0));
    o.set("s", Value::Num(any ? at : 0.0));
    posts.push(std::move(o));
  }

  // Each ghost pole's (s, lat) put back into world space through the builder's
  // own centreline sampler, so the audit can ask whether a real post stands there.
  Centerline cl = centerline_of(rt);
  Value autoPoles = Value::Arr();
  for (const AutoPole& ap : rt.autoPoles) {
    const Frame f = cl.sampleAt(ap.s);
    Value o = Value::Obj();
    o.set("s", Value::Num(ap.s));
    o.set("lat", Value::Num(ap.lat));
    o.set("radius", Value::Num(ap.radius));
    o.set("x", Value::Num(f.pos.x + f.lateral.x * ap.lat));
    o.set("z", Value::Num(f.pos.z + f.lateral.z * ap.lat));
    autoPoles.push(std::move(o));
  }

  Value root = Value::Obj();
  root.set("posts", std::move(posts));
  root.set("autoPoles", std::move(autoPoles));
  out = canonical_stringify(root);
  return out.c_str();
}

const char* ttp_track_sweep_json(const char* trackIdOrDescriptor, double step) {
  static std::string out;
  if (!(step > 0)) return nullptr;
  RaceTrack rt;
  if (!build_by_id_or_descriptor(trackIdOrDescriptor, rt)) return nullptr;

  Centerline cl = centerline_of(rt);
  Value arr = Value::Arr();
  // `s <= length` inclusive, matching the JS callers' `for (s = 0; s <= L; s += step)`
  // — the last frame lands on the lap line, which wraps to the first.
  for (double s = 0; s <= rt.length; s += step) arr.push(frameValue(cl, s));
  out = canonical_stringify(arr);
  return out.c_str();
}

const char* ttp_track_frames_json(const char* trackIdOrDescriptor, const char* sListJson) {
  static std::string out;
  if (!sListJson) return nullptr;
  bool ok = false;
  const Value list = json::parse(sListJson, &ok);
  if (!ok || list.type != Value::ARR) return nullptr;
  for (const Value& v : list.arr) if (v.type != Value::NUM) return nullptr;

  RaceTrack rt;
  if (!build_by_id_or_descriptor(trackIdOrDescriptor, rt)) return nullptr;
  Centerline cl = centerline_of(rt);
  Value arr = Value::Arr();
  for (const Value& v : list.arr) arr.push(frameValue(cl, v.num));
  out = canonical_stringify(arr);
  return out.c_str();
}

const char* ttp_item_id(int code) {
  // 1-based so TTP_ITEM_NONE can be 0 without a sentinel that looks like an
  // item; ttp::ITEM_IDS is the sim's own roll table, not a second list.
  if (code < 1 || code > 4) return nullptr;
  return ttp::ITEM_IDS[code - 1];
}

const char* ttp_version(void) {
  static std::string v;
  if (v.empty()) {
    Value o = Value::Obj();
    o.set("contractVersion", Value::Num((double)CONTRACT_VERSION));
    o.set("mathlib", Value::Str(MATHLIB));
    v = canonical_stringify(o);
  }
  return v.c_str();
}

}  // extern "C"
