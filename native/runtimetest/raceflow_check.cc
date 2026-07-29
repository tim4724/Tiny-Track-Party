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
#include "ttp/json_read.h"
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
// Read from the corpus header, never transcribed. gen-raceflow-corpus.mjs writes
// its PERSONAS / CAR_STATS / CUPS and the three sizes into line 1 verbatim, and
// this check configures itself from them — because ONE corpus has several
// replayers (this one, runtimetest/abi_check.cc, a tvOS or Android shell later)
// and a hand-copied world is a number that has to be edited in each and rots in
// the rest. It is deliberately NOT the shipped tables: the layer only ever
// indexes them, so a synthetic world proves that and keeps a persona retune or a
// new track from being a corpus re-record.
//
// The stat rows are OPAQUE to the layer — it copies whichever one the wrap
// selects and never reads inside it — so they stay Values, exactly as the ABI
// hands them over.
struct World {
  int fieldSize = 0;
  int carCount = 0;
  int colorCount = 0;
  std::string aiPrefix;
  std::vector<race::Persona> personas;
  std::vector<Value> carStats;
  std::vector<race::Cup> cups;
};

// One per process: the replay reaches for it from most ops. Filled from the
// header before step 1, and a corpus without one is refused rather than replayed
// against an empty world.
World g_world;

// ---- Value -> the model's plain types ----------------------------------------

// The three that name this layer's option types; everything else a corpus field
// needs read out of it is ttp/json_read.h, shared with runtime/ttp_race.cc.
race::Id idOf(const Value* v) { return json::id_of<race::Id>(v); }
race::OptNum numOf(const Value* v) { return json::opt_num<race::OptNum>(v); }
race::OptStr strOf(const Value* v) { return json::opt_str<race::OptStr>(v); }

// ---- the header's world, into the layer's types ------------------------------
// The one place this check learns what it is replaying against.
bool loadWorld(const Value& header, World& w) {
  const Value* wv = header.find("world");
  if (!wv || wv->type != Value::OBJ) {
    std::fprintf(stderr,
                 "the corpus header carries no `world`. Regenerate it: "
                 "node scripts/gen-raceflow-corpus.mjs — this check configures "
                 "itself from the fixture and has no world of its own.\n");
    return false;
  }
  w.fieldSize = static_cast<int>(json::num_field(*wv, "fieldSize"));
  w.carCount = static_cast<int>(json::num_field(*wv, "carCount"));
  w.colorCount = static_cast<int>(json::num_field(*wv, "colorCount"));
  w.aiPrefix = json::str_field(*wv, "aiPrefix");
  for (const Value& p : json::arr_field(*wv, "personas").arr) {
    race::Persona persona;
    persona.name = json::str_field(p, "name");
    persona.caution = json::num_field(p, "caution");
    persona.laneBias = json::num_field(p, "laneBias");
    w.personas.push_back(std::move(persona));
  }
  // Opaque to the layer: kept as Values, exactly as the ABI hands them over.
  for (const Value& r : json::arr_field(*wv, "carStats").arr) w.carStats.push_back(r);
  for (const Value& c : json::arr_field(*wv, "cups").arr) {
    race::Cup cup;
    cup.id = json::str_field(c, "id");
    cup.name = json::str_field(c, "name");
    cup.tracks = json::str_list(c, "tracks");
    w.cups.push_back(std::move(cup));
  }
  if (w.fieldSize <= 0 || w.carCount <= 0 || w.colorCount <= 0 ||
      w.personas.empty() || w.carStats.empty() || w.cups.empty()) {
    std::fprintf(stderr, "the corpus header's `world` is not a world\n");
    return false;
  }
  return true;
}

race::Human humanOf(const Value& v) {
  race::Human h;
  h.peerIndex = idOf(v.find("peerIndex"));
  h.name = json::str_field(v, "name");
  h.colorIndex = static_cast<int>(json::num_field(v, "colorIndex"));
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
  w.fieldSize = g_world.fieldSize;
  w.carCount = g_world.carCount;
  w.colorCount = g_world.colorCount;
  w.aiPrefix = g_world.aiPrefix;
  w.personas = g_world.personas;
  w.carStats = g_world.carStats;
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
    return race::carStatsAt(g_world.carStats, numOf(in.find("carIndex")));
  }
  if (op == "lowestFreeSlot") {
    std::vector<int> used;
    const Value* u = in.find("used");
    if (u && u->type == Value::ARR)
      for (const Value& e : u->arr) used.push_back(static_cast<int>(e.num));
    return Value::Num(race::lowestFreeSlot(used, static_cast<int>(json::num_field(in, "count"))));
  }
  if (op == "cpuSeats") {
    return arrOf(race::cpuSeats(humansOf(in.find("humans")), worldOf(in)), seatVal);
  }
  if (op == "buildField") {
    race::BuiltField b = race::buildField(humansOf(in.find("humans")), json::num_field(in, "seed"), worldOf(in));
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
        d.id = json::str_field(e, "id");
        d.colorIndex = static_cast<int>(json::num_field(e, "colorIndex"));
        d.carIndex = numOf(e.find("carIndex"));
        f.push_back(std::move(d));
      }
    }
    return Value::Str(race::demoSig(f, json::str_field(in, "trackId")));
  }
  if (op == "drawsNeeded") {
    return Value::Num(race::drawsNeeded(json::str_field(in, "mode"), json::num_field(in, "randomRaces")));
  }
  if (op == "seriesForStart") {
    race::SeriesForStart r = race::seriesForStart(
        json::str_field(in, "mode"), strOf(in.find("cupId")), json::str_field(in, "trackId"),
        json::num_field(in, "randomRaces"), g_world.cups, strListOf(in.find("draws")));
    Value v = Value::Obj();
    v.set("series", planVal(r));
    v.set("drawsUsed", Value::Num(r.drawsUsed));
    return v;
  }
  if (op == "startRace") {
    race::StartInput si;
    si.roomState = ttp::rt::ui::roomStateOf(json::str_field(in, "roomState"));
    si.sceneReady = json::truthy(in.find("sceneReady"));
    si.selectedTrackId = strOf(in.find("selectedTrackId"));
    si.players = humansOf(in.find("players"));
    si.mode = json::str_field(in, "mode");
    si.cupId = strOf(in.find("cupId"));
    si.trackId = json::str_field(in, "trackId");
    si.randomRaces = json::num_field(in, "randomRaces");
    si.cups = g_world.cups;
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
    li.seed = json::num_field(in, "seed");
    li.trackId = json::str_field(in, "trackId");
    li.countdownSeconds = json::num_field(in, "countdownSeconds");
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
    race::Effects es = race::countdownTick(json::num_field(in, "n"));
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  if (op == "raceStart") {
    race::Effects es = race::raceStart(json::str_field(in, "biome"), json::truthy(in.find("audioReady")));
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
      ev.type = json::str_field(*e, "type");
      ev.id = idOf(e->find("id"));
      ev.item = json::str_field(*e, "item");
      ev.cause = json::str_field(*e, "cause");
      ev.finished = json::truthy(e->find("finished"));
      ev.s = json::num_field(*e, "s");
      ev.lat = json::num_field(*e, "lat");
    }
    race::Effects es = race::raceEvent(ev, json::truthy(in.find("fastForwarding")),
                                       json::truthy(in.find("humansAllDone")));
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  if (op == "endRace") {
    race::EndRaceInput ei;
    ei.hasSeries = json::truthy(in.find("hasSeries"));
    ei.seriesFinished = json::truthy(in.find("seriesFinished"));
    ei.intermissionMs = json::num_field(in, "intermissionMs");
    ei.nowMs = json::num_field(in, "nowMs");
    ei.resultsFailsafeMs = json::num_field(in, "resultsFailsafeMs");
    race::Effects es = race::endRace(ei);
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  if (op == "advanceSeriesRace") {
    race::AdvanceInput ai;
    ai.roomState = ttp::rt::ui::roomStateOf(json::str_field(in, "roomState"));
    ai.hasSeries = json::truthy(in.find("hasSeries"));
    ai.seriesFinished = json::truthy(in.find("seriesFinished"));
    ai.sceneReady = json::truthy(in.find("sceneReady"));
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
    ri.roomState = ttp::rt::ui::roomStateOf(json::str_field(in, "roomState"));
    ri.mode = json::str_field(in, "mode");
    ri.cupId = strOf(in.find("cupId"));
    ri.trackId = strOf(in.find("trackId"));
    ri.cups = g_world.cups;
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
    race::Effects es = race::forfeitCar(json::truthy(in.find("removed")), idOf(in.find("peerIndex")));
    applyAll(s, es);
    Value v = Value::Obj();
    v.set("effects", effectsVal(es));
    return v;
  }
  if (op == "rekeyCarPlayer") {
    race::Effects es = race::rekeyCarPlayer(json::truthy(in.find("hasSeries")), json::truthy(in.find("rekeyed")),
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
      d.action = json::str_field(*dv, "action");
      d.autoPaused = json::truthy(dv->find("autoPaused"));
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
      if (json::str_field(v, "kind") != "raceflow-corpus") {
        std::fprintf(stderr, "%s: not a raceflow corpus\n", file);
        return 1;
      }
      if (!loadWorld(v, g_world)) return 1;
      continue;
    }
    const std::string kind = json::str_field(v, "case");
    if (kind == "scenario") {
      scenarios++;
      shell = Shell();   // each scenario starts from a cold shell
      continue;
    }
    if (kind != "step") continue;

    const std::string name = json::str_field(v, "name");
    const std::string op = json::str_field(v, "op");
    const double idx = json::num_field(v, "step");
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
