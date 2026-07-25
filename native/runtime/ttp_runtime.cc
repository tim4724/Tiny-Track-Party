// ttp_runtime.cc — the C ABI implementation (see ttp_runtime.h).
//
// Each handle owns a RuntimeSession: the built track, the added players, and
// either a RaceSession (countdown mode) or a bare Game (countdown < 0, the
// input-replay / golden-trace equivalent). The session's onEvent/onCountdown/
// onRaceEnd callbacks funnel into one ordered event queue that ttp_events_json
// drains. Bots are driven inside ttp_update, mirroring the live render loop.

#include "ttp_runtime.h"

#include <cstdlib>
#include <cstring>
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
#include "ttp/race_track.h"
#include "ttp/json_parse.h"
#include "ttp/grand_prix.h"
#include "ttp/race_session.h"
#include "ttp/trackbuilder.h"

using namespace ttp;

static const int CONTRACT_VERSION = 2;
static const char* MATHLIB = "fdlibm-openlibm-0.8.7";

// ---------------------------------------------------------------------------
// JSON-scalar id + flat stats parsing.
// ---------------------------------------------------------------------------
static Id parseId(const char* json) {
  if (!json) return Id::None();
  const char* p = json;
  while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
  if (*p == '"') {
    std::string s;
    p++;
    while (*p && *p != '"') {
      if (*p == '\\') {
        p++;
        switch (*p) {
          case 'n': s += '\n'; break;
          case 't': s += '\t'; break;
          case 'r': s += '\r'; break;
          case 'b': s += '\b'; break;
          case 'f': s += '\f'; break;
          case '"': s += '"'; break;
          case '\\': s += '\\'; break;
          case '/': s += '/'; break;
          case 'u': {
            int v = 0;
            for (int i = 0; i < 4 && p[1]; i++) {
              char hc = *++p;
              v <<= 4;
              if (hc >= '0' && hc <= '9') v |= hc - '0';
              else if (hc >= 'a' && hc <= 'f') v |= hc - 'a' + 10;
              else if (hc >= 'A' && hc <= 'F') v |= hc - 'A' + 10;
            }
            s += (char)v;
            break;
          }
          default: s += *p;
        }
        if (*p) p++;
      } else {
        s += *p++;
      }
    }
    return Id::Str(s);
  }
  if (*p == 'n') return Id::None();  // null
  return Id::Num(std::strtod(p, nullptr));
}

// Flat numeric stats object. Keys are distinct tokens, values are numbers, so a
// keyed scan is sufficient (the adapter emits exactly this shape).
static void statField(const char* json, const char* key, double& dst) {
  std::string pat = std::string("\"") + key + "\"";
  const char* q = std::strstr(json, pat.c_str());
  if (!q) return;
  q += pat.size();
  while (*q == ' ' || *q == '\t' || *q == ':') q++;
  dst = std::strtod(q, nullptr);
}
static Stats parseStats(const char* json) {
  Stats st;
  if (!json) return st;
  statField(json, "accel", st.accel);
  statField(json, "vmax", st.vmax);
  statField(json, "turn", st.turn);
  statField(json, "mass", st.mass);
  statField(json, "halfLen", st.halfLen);
  statField(json, "halfWid", st.halfWid);
  return st;
}

// ---------------------------------------------------------------------------
// buildRaceTrack twin (crib of replay_cli.cc): TrackDef -> Centerline + GameTrack.
// ---------------------------------------------------------------------------
static const TrackDef* findTrackDef(const std::string& id) {
  for (int i = 0; i < TTP_TRACK_COUNT; i++)
    if (id == TTP_TRACKS[i].id) return &TTP_TRACKS[i];
  return nullptr;
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
  p.id = parseId(idJson);
  if (statsJsonOrNull) { p.hasStats = true; p.stats = parseStats(statsJsonOrNull); }
  rs->humans.push_back(p);
}

void ttp_add_bot(int h, const char* idJson, double caution, double laneBias,
                 uint32_t aiSeed, const char* statsJsonOrNull) {
  RuntimeSession* rs = get(h);
  if (!rs || rs->started || rs->built) return;
  BotEntry b;
  b.id = parseId(idJson);
  b.caution = caution;
  b.laneBias = laneBias;
  b.aiSeed = aiSeed;
  if (statsJsonOrNull) { b.hasStats = true; b.stats = parseStats(statsJsonOrNull); }
  rs->bots.push_back(std::move(b));
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

  // Build the bot controllers now that the field (and its cars) exist.
  for (auto& b : rs->bots)
    b.ai = std::make_unique<AiController>(b.caution, LOOKAHEAD, STEER_GAIN, b.laneBias, b.aiSeed);
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
    for (auto& b : rs->bots)
      b.ai = std::make_unique<AiController>(b.caution, LOOKAHEAD, STEER_GAIN, b.laneBias, b.aiSeed);
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
  rs->eng->processInput(parseId(idJson), in);
}

const char* ttp_snapshot_json(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return NULL_JSON;
  if (!rs->eng) buildSession(rs);
  if (!rs->eng) return NULL_JSON;
  rs->scratch = canonical_stringify(rs->eng->getSnapshot());
  return rs->scratch.c_str();
}

const char* ttp_results_json(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return NULL_JSON;
  if (!rs->eng) buildSession(rs);
  if (!rs->eng) return NULL_JSON;
  rs->scratch = canonical_stringify(rs->eng->getResults());
  return rs->scratch.c_str();
}

const char* ttp_events_json(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return EMPTY_ARR;
  Value arr = Value::Arr();
  for (auto& e : rs->outQueue) arr.push(std::move(e));
  rs->outQueue.clear();
  rs->scratch = canonical_stringify(arr);
  return rs->scratch.c_str();
}

int ttp_has_car(int h, const char* idJson) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  return rs && rs->eng && rs->eng->hasCar(parseId(idJson)) ? 1 : 0;
}

int ttp_car_finished(int h, const char* idJson) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng) return -1;
  bool out = false;
  if (!rs->eng->carFinished(parseId(idJson), out)) return -1;
  return out ? 1 : 0;
}

const char* ttp_car_ids_json(int h) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng) return EMPTY_ARR;
  Value arr = Value::Arr();
  for (const auto& c : rs->eng->cars()) arr.push(c->id.toValue());
  rs->scratch = canonical_stringify(arr);
  return rs->scratch.c_str();
}

int ttp_car_world_pos(int h, const char* idJson, double* out3) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng || !out3) return 0;
  Id id = parseId(idJson);
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
  Id id = parseId(idJson);
  if (rs->session) return rs->session->forceRemoveCar(id) ? 1 : 0;
  return rs->eng->removeCar(id) ? 1 : 0;
}

int ttp_rekey_car(int h, const char* oldJson, const char* newJson) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->eng) return 0;
  return rs->eng->rekeyCar(parseId(oldJson), parseId(newJson)) ? 1 : 0;
}

void ttp_force_finish(int h, const char* idJson, double time) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->eng) return;
  rs->eng->forceFinish(parseId(idJson), true, time);
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
  g->scratch = canonical_stringify(o);
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
  g->scratch = canonical_stringify(arr);
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
