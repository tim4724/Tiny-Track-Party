// Race-orchestration conformance check — replays tests/fixtures/raceflow-corpus.jsonl
// against native/libttp-runtime/ttp/race_flow.h.
//
// JS-RECORDED evidence, like the ui/audio/session corpora and unlike the
// C++-authored ones: every line was taken off the live public/display/raceFlow.js
// before this port existed, so it settles whether the port matches the JS it
// replaced. A disagreement is a bug in the C++, never in the fixture.
//
// WHAT IT REPLAYS, AND WHY BOTH HALVES MATTER. Each step carries `out` (the
// layer's answer) and `state` (the shell state the generator's driver threads).
// `out` alone would pass a port that emits the right effects in the WRONG ORDER,
// which is precisely the failure this layer exists to prevent — so the driver
// below is a transcription of the generator's applier, walking each effect list
// in order and mutating the same shell state. `state.ops` is the ordered list of
// op keys applied during the step, so the order is compared directly as well as
// through its consequences.
//
// Line 1 is a header {kind,version,scenarios,steps,...}. Then
// {case:"scenario",name} starts a scenario and
// {case:"step",name,step,op,in,out,state} is one step. Each `in` is the FULLY
// RESOLVED input, so a step replays standalone.
//
// The comparison is structural through corpus_diff's diff_val, which compares
// numbers via js_number_to_string — a recorded decimal matches iff it
// round-trips to the same double.
//
// KEY PRESENCE IS PART OF THE CONTRACT. JSON.stringify drops undefined, so
// several answers differ in WHICH keys exist rather than in their values: a
// rejected start has {action,reason} and no series, an accepted one has
// {action,series,drawsUsed} and no reason; a cup plan carries only {kind,cupId}
// while a random plan also carries cupName and tracks. Emitting a null where the
// recording has no key at all is a failure, and diff_val treats it as one.
//
// There is NO --record mode, on the same grounds as session_check.cc: this
// fixture's whole value is that C++ did not write it.
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

#include "corpus_diff.h"
#include "ttp/canonical.h"
#include "ttp/race_flow.h"

using namespace ttp;
using ttp::corpus::Diff;
namespace race = ttp::rt::race;

namespace {

int cases = 0, passed = 0, spew = 0;

void report(const std::string& what, const Diff& d) {
  cases++;
  if (!d.differ) { passed++; return; }
  if (spew++ < 20) {
    std::fprintf(stderr, "FAIL %s\n  path %s\n  expected %s\n  actual   %s\n",
                 what.c_str(), d.path.c_str(), d.expected.c_str(), d.actual.c_str());
  }
}

// ---- the generator's synthetic world ----------------------------------------
// scripts/gen-raceflow-corpus.mjs's PERSONAS / CAR_STATS / CUPS and the four
// sizes, transcribed. Deliberately NOT the shipped tables: the layer only ever
// indexes them, so a synthetic world proves that and keeps a persona retune or a
// new track from being a corpus re-record.
const int FIELD_SIZE = 4;
const int CAR_COUNT = 6;
const int COLOR_COUNT = 8;

std::vector<race::Persona> makePersonas() {
  return {{"Alpha", 1.10, -0.5}, {"Beta", 1.00, 0.5},
          {"Gamma", 0.95, -0.2}, {"Delta", 0.90, 0.2}};
}

// The stat rows are OPAQUE to the layer — it copies whichever one the wrap
// selects and never reads inside it — so they are built as Values here, exactly
// as the ABI would hand them over.
std::vector<Value> makeCarStats() {
  const auto row = [](double accel, double top, double turn, double weight) {
    Value v = Value::Obj();
    v.set("accel", Value::Num(accel));
    v.set("top", Value::Num(top));
    v.set("turn", Value::Num(turn));
    v.set("weight", Value::Num(weight));
    return v;
  };
  return {row(1.0, 1.0, 1.0, 1.0),   row(1.1, 0.95, 1.05, 0.9),
          row(0.9, 1.1, 0.95, 1.1),  row(1.05, 1.0, 0.9, 1.0),
          row(0.95, 1.05, 1.1, 0.95), row(1.0, 0.9, 1.0, 1.2)};
}

std::vector<race::Cup> makeCups() {
  return {{"cup-a", "Sunrise", {"a1", "a2", "a3", "a4"}},
          {"cup-b", "Thunder", {"b1", "b2", "b3", "b4"}},
          {"cup-empty", "Hollow", {}}};
}

// ---- Value -> the model's plain types ----------------------------------------

race::Id idOf(const Value* v) {
  if (!v) return race::Id::None();
  if (v->type == Value::NUM) return race::Id::Num(v->num);
  if (v->type == Value::STR) return race::Id::Str(v->str);
  return race::Id::None();
}
race::OptNum numOf(const Value* v) {
  return (v && v->type == Value::NUM) ? race::OptNum::Of(v->num) : race::OptNum::None();
}
race::OptStr strOf(const Value* v) {
  return (v && v->type == Value::STR) ? race::OptStr::Of(v->str) : race::OptStr::None();
}
bool truthy(const Value* v) {
  if (!v) return false;
  switch (v->type) {
    case Value::BOOL: return v->b;
    case Value::NUM: return v->num != 0 && !(v->num != v->num);
    case Value::STR: return !v->str.empty();
    case Value::ARR:
    case Value::OBJ: return true;
    default: return false;
  }
}
double numField(const Value& o, const char* k) {
  const Value* v = o.find(k);
  return (v && v->type == Value::NUM) ? v->num : 0.0;
}
std::string strField(const Value& o, const char* k) {
  const Value* v = o.find(k);
  return (v && v->type == Value::STR) ? v->str : std::string();
}

race::Human humanOf(const Value& v) {
  race::Human h;
  h.peerIndex = idOf(v.find("peerIndex"));
  h.name = strField(v, "name");
  h.colorIndex = static_cast<int>(numField(v, "colorIndex"));
  h.carIndex = numOf(v.find("carIndex"));
  return h;
}
std::vector<race::Human> humansOf(const Value* arr) {
  std::vector<race::Human> out;
  if (arr && arr->type == Value::ARR) for (const Value& e : arr->arr) out.push_back(humanOf(e));
  return out;
}
std::vector<std::string> strListOf(const Value* arr) {
  std::vector<std::string> out;
  if (arr && arr->type == Value::ARR)
    for (const Value& e : arr->arr) if (e.type == Value::STR) out.push_back(e.str);
  return out;
}

race::FieldWorld worldOf(const Value& in) {
  race::FieldWorld w;
  w.fieldSize = FIELD_SIZE;
  w.carCount = CAR_COUNT;
  w.colorCount = COLOR_COUNT;
  w.personas = makePersonas();
  w.carStats = makeCarStats();
  w.botCap = numOf(in.find("botCap"));
  return w;
}

// ---- the model's plain types -> Value ----------------------------------------
// Every builder below spells the JS object literal's keys, and only the keys the
// literal actually had — see the key-presence note in the header.

Value valOf(const race::OptNum& n) { return n.has ? Value::Num(n.v) : Value::Null(); }
Value valOf(const race::OptStr& s) { return s.has ? Value::Str(s.v) : Value::Null(); }

Value personaVal(const race::Persona& p) {
  Value v = Value::Obj();
  v.set("name", Value::Str(p.name));
  v.set("caution", Value::Num(p.caution));
  v.set("laneBias", Value::Num(p.laneBias));
  return v;
}
Value seatVal(const race::CpuSeat& s) {
  Value v = Value::Obj();
  v.set("n", Value::Num(s.n));
  v.set("persona", personaVal(s.persona));
  v.set("colorIndex", Value::Num(s.colorIndex));
  v.set("carIndex", Value::Num(s.carIndex));
  v.set("stats", s.stats);
  return v;
}
Value fieldVal(const race::FieldEntry& f) {
  Value v = Value::Obj();
  v.set("peerIndex", f.peerIndex.toValue());
  v.set("name", Value::Str(f.name));
  v.set("colorIndex", Value::Num(f.colorIndex));
  v.set("carIndex", valOf(f.carIndex));
  v.set("stats", f.stats);
  v.set("ai", Value::Bool(f.ai));
  return v;
}
Value botVal(const race::BotSpec& b) {
  Value v = Value::Obj();
  v.set("peerIndex", b.peerIndex.toValue());
  v.set("caution", Value::Num(b.caution));
  v.set("laneBias", Value::Num(b.laneBias));
  v.set("seed", Value::Num(b.seed));
  return v;
}
Value demoVal(const race::DemoEntry& d) {
  Value v = Value::Obj();
  v.set("id", Value::Str(d.id));
  v.set("name", Value::Str(d.name));
  v.set("colorIndex", Value::Num(d.colorIndex));
  v.set("carIndex", valOf(d.carIndex));
  v.set("stats", d.stats);
  v.set("persona", personaVal(d.persona));
  return v;
}
Value carVal(const race::SceneCar& c) {
  Value v = Value::Obj();
  v.set("id", c.id.toValue());
  v.set("colorIndex", Value::Num(c.colorIndex));
  v.set("name", Value::Str(c.name));
  v.set("cell", Value::Bool(c.cell));
  v.set("carIndex", valOf(c.carIndex));
  return v;
}
template <typename T, typename F>
Value arrOf(const std::vector<T>& xs, F f) {
  Value a = Value::Arr();
  for (const T& x : xs) a.push(f(x));
  return a;
}
Value idArr(const std::vector<race::Id>& ids) {
  Value a = Value::Arr();
  for (const race::Id& i : ids) a.push(i.toValue());
  return a;
}

// One effect, spelled exactly as raceFlow.js wrote its literal.
Value effectVal(const race::Effect& e) {
  Value v = Value::Obj();
  v.set("op", Value::Str(race::key(e.op)));
  switch (e.op) {
    case race::Op::SET_TRACK_SEED: v.set("seed", Value::Num(e.num)); break;
    case race::Op::SET_FIELD:
      v.set("field", arrOf(e.field, fieldVal));
      v.set("aiIds", idArr(e.aiIds));
      v.set("bots", arrOf(e.bots, botVal));
      break;
    case race::Op::SHOW_SCREEN: v.set("screen", Value::Str(e.str)); break;
    case race::Op::SET_RACE_FLAGS:
      v.set("paused", Value::Bool(e.paused));
      v.set("autoPaused", Value::Bool(e.autoPaused));
      v.set("raceEnded", Value::Bool(e.raceEnded));
      break;
    case race::Op::SET_PAUSE_OVERLAY:
    case race::Op::SHOW_MUSIC_CREDIT:
    case race::Op::SET_AUTO_PAUSED: v.set("on", Value::Bool(e.on)); break;
    case race::Op::SET_PAUSE_BUTTON: v.set("shown", Value::Bool(e.shown)); break;
    case race::Op::RESET_SCENE_CARS: v.set("cars", arrOf(e.cars, carVal)); break;
    case race::Op::CREATE_SESSION:
      v.set("trackId", Value::Str(e.str));
      v.set("forceItem", valOf(e.forceItem));
      v.set("bots", arrOf(e.bots, botVal));
      break;
    case race::Op::TRANSITION: v.set("to", Value::Str(e.str)); break;
    case race::Op::START_COUNTDOWN: v.set("seconds", Value::Num(e.num)); break;
    case race::Op::SHOW_COUNTDOWN:
      v.set("n", Value::Num(e.num));
      v.set("slap", Value::Bool(e.slap));
      v.set("go", Value::Bool(e.go));
      break;
    case race::Op::BROADCAST_COUNTDOWN: v.set("n", Value::Num(e.num)); break;
    case race::Op::REFRESH_AUTO_PAUSE: v.set("deferred", Value::Bool(e.deferred)); break;
    case race::Op::START_MUSIC: v.set("biome", Value::Str(e.str)); break;
    case race::Op::ITEM_PICKUP:
      v.set("id", e.id.toValue());
      v.set("item", Value::Str(e.str));
      break;
    case race::Op::ROCKET_IMPACT:
    case race::Op::REMOVE_SCENE_CAR:
    case race::Op::STOP_CAR_AUDIO: v.set("id", e.id.toValue()); break;
    case race::Op::ROCKET_EXPIRE:
      v.set("s", Value::Num(e.s));
      v.set("lat", Value::Num(e.lat));
      break;
    case race::Op::BROADCAST_STANDINGS: v.set("over", Value::Bool(e.over)); break;
    case race::Op::ARM_RESULTS_FAILSAFE: v.set("ms", Value::Num(e.num)); break;
    case race::Op::ARM_INTERMISSION:
      v.set("ms", Value::Num(e.num));
      v.set("deadline", Value::Num(e.deadline));
      break;
    case race::Op::SET_TRACK: v.set("trackId", Value::Str(e.str)); break;
    case race::Op::FADE_TO_LOBBY: v.set("placeTrack", Value::Bool(e.placeTrack)); break;
    case race::Op::SERIES_REKEY:
    case race::Op::REKEY_SCENE_CAR:
    case race::Op::REKEY_FIELD:
      v.set("oldId", e.id.toValue());
      v.set("newId", e.id2.toValue());
      break;
    // The payload-free ops. Listed rather than defaulted so a new op with a
    // payload cannot silently marshal as bare.
    case race::Op::STOP_LOBBY_DEMO:
    case race::Op::CLEAR_ITEM_CACHE:
    case race::Op::HIDE_RESULTS:
    case race::Op::REVEAL_CHROME:
    case race::Op::HOLD_CHROME:
    case race::Op::BIND_SESSION:
    case race::Op::PAINT_INITIAL_HUD:
    case race::Op::STOP_MUSIC:
    case race::Op::STOP_VOICES:
    case race::Op::APPLY_RACE_POINTS:
    case race::Op::SHOW_RESULTS:
    case race::Op::CLEAR_RESULTS_FAILSAFE:
    case race::Op::CLEAR_INTERMISSION:
    case race::Op::SERIES_ADVANCE:
    case race::Op::CLEAR_SERIES:
    case race::Op::SET_TRACK_FROM_SERIES:
    case race::Op::PLACE_TRACK:
    case race::Op::DISPOSE_SESSION:
    case race::Op::CLEAR_FIELD:
    case race::Op::SYNC_STATE:
    case race::Op::SYNC_FROZEN:
    case race::Op::RETURN_TO_LOBBY:
      break;
  }
  return v;
}
Value effectsVal(const race::Effects& es) { return arrOf(es, effectVal); }

Value planVal(const race::SeriesForStart& s) {
  if (!s.has) return Value::Null();
  Value v = Value::Obj();
  v.set("kind", Value::Str(race::key(s.series.kind)));
  v.set("cupId", Value::Str(s.series.cupId));
  // A cup plan carries ONLY kind+cupId — the shell already holds the cup. The
  // random plans name themselves and carry their card.
  if (s.series.kind != race::SeriesKind::CUP) {
    v.set("cupName", Value::Str(s.series.cupName));
    Value t = Value::Arr();
    for (const std::string& id : s.series.tracks) t.push(Value::Str(id));
    v.set("tracks", t);
  }
  return v;
}

// ---- the shell state the driver threads --------------------------------------
// A transcription of gen-raceflow-corpus.mjs's applier. Deliberately the
// SHELL-VISIBLE surface only: a port may structure its internals freely, but the
// room it leaves behind after an effect list has to be the same room.
struct Shell {
  std::string roomState = "lobby";
  std::string screen = "lobby";
  bool hasSession = false, sessionBound = false;
  bool paused = false, autoPaused = false, raceEnded = false;
  bool pauseOverlay = false, pauseButton = false;
  std::string chrome = "held";
  std::string music = "stopped";
  bool musicCredit = false;
  race::OptStr trackId;
  race::OptNum trackSeed;
  race::OptNum countdownShown;
  std::vector<race::Id> sceneCars;
  std::vector<race::Id> aiIds;
  std::vector<race::FieldEntry> field;
  bool demoRunning = true;
  race::OptNum seriesRaceIndex;
  race::OptNum resultsFailsafe;
  race::OptNum intermissionDeadline;
  race::OptStr lastBroadcast;
  std::vector<std::string> ops;
};

void applyEffect(Shell& s, const race::Effect& e) {
  s.ops.push_back(race::key(e.op));
  switch (e.op) {
    case race::Op::SET_TRACK_SEED: s.trackSeed = race::OptNum::Of(e.num); break;
    case race::Op::STOP_LOBBY_DEMO: s.demoRunning = false; break;
    case race::Op::SET_FIELD: s.field = e.field; s.aiIds = e.aiIds; break;
    case race::Op::SHOW_SCREEN: s.screen = e.str; break;
    case race::Op::SET_RACE_FLAGS:
      s.paused = e.paused; s.autoPaused = e.autoPaused; s.raceEnded = e.raceEnded; break;
    case race::Op::SET_PAUSE_OVERLAY: s.pauseOverlay = e.on; break;
    case race::Op::SET_PAUSE_BUTTON: s.pauseButton = e.shown; break;
    case race::Op::REVEAL_CHROME: s.chrome = "revealed"; break;
    case race::Op::HOLD_CHROME: s.chrome = "held"; break;
    case race::Op::RESET_SCENE_CARS:
      s.sceneCars.clear();
      for (const race::SceneCar& c : e.cars) s.sceneCars.push_back(c.id);
      break;
    case race::Op::CREATE_SESSION:
      s.hasSession = true; s.trackId = race::OptStr::Of(e.str); break;
    case race::Op::TRANSITION: s.roomState = e.str; break;
    case race::Op::BIND_SESSION: s.sessionBound = true; break;
    case race::Op::START_COUNTDOWN:
    case race::Op::SHOW_COUNTDOWN: s.countdownShown = race::OptNum::Of(e.num); break;
    case race::Op::START_MUSIC: s.music = "playing"; break;
    case race::Op::STOP_MUSIC: s.music = "stopped"; break;
    case race::Op::SHOW_MUSIC_CREDIT: s.musicCredit = e.on; break;
    case race::Op::BROADCAST_STANDINGS:
      s.lastBroadcast = race::OptStr::Of(e.over ? "final" : "running"); break;
    case race::Op::ARM_RESULTS_FAILSAFE: s.resultsFailsafe = race::OptNum::Of(e.num); break;
    case race::Op::CLEAR_RESULTS_FAILSAFE: s.resultsFailsafe = race::OptNum::None(); break;
    case race::Op::ARM_INTERMISSION:
      s.intermissionDeadline = race::OptNum::Of(e.deadline); break;
    case race::Op::CLEAR_INTERMISSION:
      s.intermissionDeadline = race::OptNum::None(); break;
    case race::Op::SERIES_ADVANCE:
      s.seriesRaceIndex = race::OptNum::Of((s.seriesRaceIndex.has ? s.seriesRaceIndex.v : 0) + 1);
      break;
    case race::Op::CLEAR_SERIES: s.seriesRaceIndex = race::OptNum::None(); break;
    case race::Op::SET_TRACK: s.trackId = race::OptStr::Of(e.str); break;
    case race::Op::DISPOSE_SESSION: s.hasSession = false; s.sessionBound = false; break;
    case race::Op::CLEAR_FIELD: s.field.clear(); s.aiIds.clear(); break;
    case race::Op::FADE_TO_LOBBY: s.sceneCars.clear(); s.demoRunning = true; break;
    case race::Op::REMOVE_SCENE_CAR: {
      std::vector<race::Id> keep;
      for (const race::Id& c : s.sceneCars) if (!(c == e.id)) keep.push_back(c);
      s.sceneCars = keep;
      break;
    }
    case race::Op::REKEY_SCENE_CAR:
      for (race::Id& c : s.sceneCars) if (c == e.id) c = e.id2;
      break;
    case race::Op::REKEY_FIELD:
      for (race::FieldEntry& f : s.field) if (f.peerIndex == e.id) f.peerIndex = e.id2;
      break;
    case race::Op::SET_AUTO_PAUSED: s.autoPaused = e.on; break;
    // No state of their own — the corpus records them only through `ops`.
    case race::Op::CLEAR_ITEM_CACHE:
    case race::Op::HIDE_RESULTS:
    case race::Op::PAINT_INITIAL_HUD:
    case race::Op::BROADCAST_COUNTDOWN:
    case race::Op::REFRESH_AUTO_PAUSE:
    case race::Op::STOP_VOICES:
    case race::Op::ITEM_PICKUP:
    case race::Op::ROCKET_IMPACT:
    case race::Op::ROCKET_EXPIRE:
    case race::Op::APPLY_RACE_POINTS:
    case race::Op::SHOW_RESULTS:
    case race::Op::SET_TRACK_FROM_SERIES:
    case race::Op::PLACE_TRACK:
    case race::Op::STOP_CAR_AUDIO:
    case race::Op::SYNC_STATE:
    case race::Op::SERIES_REKEY:
    case race::Op::SYNC_FROZEN:
    case race::Op::RETURN_TO_LOBBY:
      break;
  }
}
void applyAll(Shell& s, const race::Effects& es) { for (const race::Effect& e : es) applyEffect(s, e); }

Value digest(const Shell& s) {
  Value v = Value::Obj();
  v.set("roomState", Value::Str(s.roomState));
  v.set("screen", Value::Str(s.screen));
  v.set("hasSession", Value::Bool(s.hasSession));
  v.set("sessionBound", Value::Bool(s.sessionBound));
  v.set("paused", Value::Bool(s.paused));
  v.set("autoPaused", Value::Bool(s.autoPaused));
  v.set("raceEnded", Value::Bool(s.raceEnded));
  v.set("pauseOverlay", Value::Bool(s.pauseOverlay));
  v.set("pauseButton", Value::Bool(s.pauseButton));
  v.set("chrome", Value::Str(s.chrome));
  v.set("music", Value::Str(s.music));
  v.set("musicCredit", Value::Bool(s.musicCredit));
  v.set("trackId", valOf(s.trackId));
  v.set("trackSeed", valOf(s.trackSeed));
  v.set("countdownShown", valOf(s.countdownShown));
  v.set("cars", idArr(s.sceneCars));
  v.set("aiIds", idArr(s.aiIds));
  v.set("demoRunning", Value::Bool(s.demoRunning));
  v.set("seriesRaceIndex", valOf(s.seriesRaceIndex));
  v.set("resultsFailsafe", valOf(s.resultsFailsafe));
  v.set("intermissionDeadline", valOf(s.intermissionDeadline));
  v.set("lastBroadcast", valOf(s.lastBroadcast));
  Value ops = Value::Arr();
  for (const std::string& o : s.ops) ops.push(Value::Str(o));
  v.set("ops", ops);
  return v;
}

// ---- one step ----------------------------------------------------------------
// Returns the answer in the shape the generator recorded.
Value runStep(Shell& s, const std::string& op, const Value& in) {
  if (op == "carStatsAt") {
    return race::carStatsAt(makeCarStats(), numOf(in.find("carIndex")));
  }
  if (op == "lowestFreeSlot") {
    std::vector<int> used;
    const Value* u = in.find("used");
    if (u && u->type == Value::ARR)
      for (const Value& e : u->arr) used.push_back(static_cast<int>(e.num));
    return Value::Num(race::lowestFreeSlot(used, static_cast<int>(numField(in, "count"))));
  }
  if (op == "cpuSeats") {
    return arrOf(race::cpuSeats(humansOf(in.find("humans")), worldOf(in)), seatVal);
  }
  if (op == "buildField") {
    race::BuiltField b = race::buildField(humansOf(in.find("humans")), numField(in, "seed"), worldOf(in));
    Value v = Value::Obj();
    v.set("field", arrOf(b.field, fieldVal));
    v.set("bots", arrOf(b.bots, botVal));
    v.set("aiIds", idArr(b.aiIds));
    return v;
  }
  if (op == "buildDemoField") {
    return arrOf(race::buildDemoField(humansOf(in.find("humans")), worldOf(in)), demoVal);
  }
  if (op == "demoSig") {
    // The recorded field is a literal, not a built one — read it back as such.
    std::vector<race::DemoEntry> f;
    const Value* arr = in.find("field");
    if (arr && arr->type == Value::ARR) {
      for (const Value& e : arr->arr) {
        race::DemoEntry d;
        d.id = strField(e, "id");
        d.colorIndex = static_cast<int>(numField(e, "colorIndex"));
        d.carIndex = numOf(e.find("carIndex"));
        f.push_back(std::move(d));
      }
    }
    return Value::Str(race::demoSig(f, strField(in, "trackId")));
  }
  if (op == "drawsNeeded") {
    return Value::Num(race::drawsNeeded(strField(in, "mode"), numField(in, "randomRaces")));
  }
  if (op == "seriesForStart") {
    race::SeriesForStart r = race::seriesForStart(
        strField(in, "mode"), strOf(in.find("cupId")), strField(in, "trackId"),
        numField(in, "randomRaces"), makeCups(), strListOf(in.find("draws")));
    Value v = Value::Obj();
    v.set("series", planVal(r));
    v.set("drawsUsed", Value::Num(r.drawsUsed));
    return v;
  }
  if (op == "startRace") {
    race::StartInput si;
    si.roomState = ttp::rt::ui::roomStateOf(strField(in, "roomState"));
    si.sceneReady = truthy(in.find("sceneReady"));
    si.selectedTrackId = strOf(in.find("selectedTrackId"));
    si.players = humansOf(in.find("players"));
    si.mode = strField(in, "mode");
    si.cupId = strOf(in.find("cupId"));
    si.trackId = strField(in, "trackId");
    si.randomRaces = numField(in, "randomRaces");
    si.cups = makeCups();
    si.draws = strListOf(in.find("draws"));
    race::StartResult r = race::startRace(si);
    Value v = Value::Obj();
    v.set("action", Value::Str(race::key(r.action)));
    // Key presence is the contract: a rejection carries `reason` and no series,
    // an acceptance carries `series`+`drawsUsed` and no reason.
    if (r.action == race::StartAction::LAUNCH) {
      v.set("series", planVal(r.series));
      v.set("drawsUsed", Value::Num(r.drawsUsed));
      if (r.series.has) s.seriesRaceIndex = race::OptNum::Of(0);
    } else {
      v.set("reason", Value::Str(race::key(r.reason)));
    }
    return v;
  }
  if (op == "launchRace") {
    race::LaunchInput li;
    li.players = humansOf(in.find("players"));
    li.seed = numField(in, "seed");
    li.trackId = strField(in, "trackId");
    li.countdownSeconds = numField(in, "countdownSeconds");
    li.forceItem = strOf(in.find("forceItem"));
    li.world = worldOf(in);
    race::LaunchResult r = race::launchRace(li);
    applyAll(s, r.effects);
    Value v = Value::Obj();
    v.set("effects", effectsVal(r.effects));
    v.set("field", arrOf(r.field, fieldVal));
    v.set("aiIds", idArr(r.aiIds));
    v.set("bots", arrOf(r.bots, botVal));
    return v;
  }
  if (op == "countdownTick") {
    race::Effects es = race::countdownTick(numField(in, "n"));
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  if (op == "raceStart") {
    race::Effects es = race::raceStart(strField(in, "biome"), truthy(in.find("audioReady")));
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  if (op == "raceEvent") {
    race::RaceEvent ev;
    const Value* e = in.find("event");
    if (e && e->type == Value::OBJ) {
      ev.present = true;
      ev.type = strField(*e, "type");
      ev.id = idOf(e->find("id"));
      ev.item = strField(*e, "item");
      ev.cause = strField(*e, "cause");
      ev.finished = truthy(e->find("finished"));
      ev.s = numField(*e, "s");
      ev.lat = numField(*e, "lat");
    }
    race::Effects es = race::raceEvent(ev, truthy(in.find("fastForwarding")),
                                       truthy(in.find("humansAllDone")));
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  if (op == "endRace") {
    race::EndRaceInput ei;
    ei.hasSeries = truthy(in.find("hasSeries"));
    ei.seriesFinished = truthy(in.find("seriesFinished"));
    ei.intermissionMs = numField(in, "intermissionMs");
    ei.nowMs = numField(in, "nowMs");
    ei.resultsFailsafeMs = numField(in, "resultsFailsafeMs");
    race::Effects es = race::endRace(ei);
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  if (op == "advanceSeriesRace") {
    race::AdvanceInput ai;
    ai.roomState = ttp::rt::ui::roomStateOf(strField(in, "roomState"));
    ai.hasSeries = truthy(in.find("hasSeries"));
    ai.seriesFinished = truthy(in.find("seriesFinished"));
    ai.sceneReady = truthy(in.find("sceneReady"));
    ai.players = humansOf(in.find("players"));
    race::AdvanceResult r = race::advanceSeriesRace(ai);
    applyAll(s, r.effects);
    Value v = Value::Obj();
    v.set("action", Value::Str(race::key(r.action)));
    v.set("effects", effectsVal(r.effects));
    return v;
  }
  if (op == "returnToLobby") {
    race::ReturnInput ri;
    ri.roomState = ttp::rt::ui::roomStateOf(strField(in, "roomState"));
    ri.mode = strField(in, "mode");
    ri.cupId = strOf(in.find("cupId"));
    ri.trackId = strOf(in.find("trackId"));
    ri.cups = makeCups();
    ri.draws = strListOf(in.find("draws"));
    race::ReturnResult r = race::returnToLobby(ri);
    applyAll(s, r.effects);
    Value v = Value::Obj();
    v.set("action", Value::Str(race::key(r.action)));
    v.set("effects", effectsVal(r.effects));
    // The no-op branch has no trackSwap key at all.
    if (r.action == race::ReturnAction::RETURN) v.set("trackSwap", valOf(r.trackSwap));
    v.set("drawsUsed", Value::Num(r.drawsUsed));
    return v;
  }
  if (op == "forfeitCar") {
    race::Effects es = race::forfeitCar(truthy(in.find("removed")), idOf(in.find("peerIndex")));
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  if (op == "rekeyCarPlayer") {
    race::Effects es = race::rekeyCarPlayer(truthy(in.find("hasSeries")), truthy(in.find("rekeyed")),
                                            idOf(in.find("oldId")), idOf(in.find("newId")));
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  if (op == "autoPauseEffects") {
    race::AutoPauseDecision d;
    const Value* dv = in.find("decision");
    if (dv && dv->type == Value::OBJ) {
      d.present = true;
      d.action = strField(*dv, "action");
      d.autoPaused = truthy(dv->find("autoPaused"));
    }
    race::Effects es = race::autoPauseEffects(d);
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  std::fprintf(stderr, "FAIL: unknown op %s\n", op.c_str());
  std::exit(1);
}

}  // namespace

int main(int argc, char** argv) {
  const char* file = argc > 1 ? argv[1] : "tests/fixtures/raceflow-corpus.jsonl";
  std::ifstream f(file);
  if (!f) { std::fprintf(stderr, "cannot open %s\n", file); return 1; }

  std::string line;
  bool header = true;
  int scenarios = 0, steps = 0;
  Shell shell;

  while (std::getline(f, line)) {
    if (line.empty()) continue;
    Value v;
    std::string perr;
    if (!corpus::read_line(line, v, &perr)) {
      std::fprintf(stderr, "%s: parse: %s\n", file, perr.c_str());
      return 1;
    }
    if (header) {
      header = false;
      if (strField(v, "kind") != "raceflow-corpus") {
        std::fprintf(stderr, "%s: not a raceflow corpus\n", file);
        return 1;
      }
      // The sizes the scenarios were recorded against are compiled in above; a
      // corpus recorded at different ones would replay green against the wrong
      // world, so refuse it rather than trust the transcription.
      if (static_cast<int>(numField(v, "fieldSize")) != FIELD_SIZE ||
          static_cast<int>(numField(v, "carCount")) != CAR_COUNT ||
          static_cast<int>(numField(v, "colorCount")) != COLOR_COUNT) {
        std::fprintf(stderr, "FAIL: corpus world (%g/%g/%g) != this check's (%d/%d/%d)\n",
                     numField(v, "fieldSize"), numField(v, "carCount"),
                     numField(v, "colorCount"), FIELD_SIZE, CAR_COUNT, COLOR_COUNT);
        return 1;
      }
      continue;
    }
    const std::string kind = strField(v, "case");
    if (kind == "scenario") {
      scenarios++;
      shell = Shell();   // each scenario starts from a cold shell
      continue;
    }
    if (kind != "step") continue;

    const std::string name = strField(v, "name");
    const std::string op = strField(v, "op");
    const double idx = numField(v, "step");
    const Value* in = v.find("in");
    shell.ops.clear();
    Value got = runStep(shell, op, in ? *in : Value::Obj());

    const Value* want = v.find("out");
    const std::string what = name + "#" + std::to_string(static_cast<int>(idx)) + " " + op;
    report(what + " out", corpus::diff_val(want ? *want : Value::Null(), got, "out"));
    const Value* wantState = v.find("state");
    if (wantState) report(what + " state", corpus::diff_val(*wantState, digest(shell), "state"));
    steps++;
  }

  std::printf("raceflow: %d/%d checks passed (%d steps, %d scenarios)\n",
              passed, cases, steps, scenarios);
  return passed == cases ? 0 : 1;
}
