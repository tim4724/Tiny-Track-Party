// ttp_race.cc — the race-orchestration ABI over native/libttp-runtime's
// ttp::rt::race.
//
// MARSHALLING ONLY. Not one orchestration decision is taken in this file: every
// export parses its arguments into the plain structs ttp/race_flow.h declares,
// calls the rule, and spells the answer back out. That split is what lets
// raceflow_check.cc gate the rules against tests/fixtures/raceflow-corpus.jsonl
// while this layer is covered by runtimetest/abi_check.cc replaying the SAME
// corpus through the C boundary — the arrangement ttp_ui.cc / ttp_runtime.cc /
// ttp_party.cc already have, for the reason abi_check's header gives: a wrong
// key, a dropped null or an id parsed as the wrong JSON type lives exactly here
// and is invisible to a check that calls C++ objects directly.
//
// KEY ORDER IS OUTPUT, not incidental — every Value below is built in the order
// the JS object literal was written in and emitted with ordered_stringify. And
// key PRESENCE is contract: see ttp_race.h. An `if` that adds a key only on one
// branch is deliberate everywhere it appears.
#include "ttp_error.h"
#include "ttp_race.h"

#include <string>
#include <vector>

#include "ttp/ai_driver.h"
#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/json_read.h"
#include "ttp/race_flow.h"
#include "ttp/scalar_id.h"
#include "ttp/ui_model.h"

using namespace ttp;
namespace race = ttp::rt::race;

namespace {

// ---- the configured world ----------------------------------------------------
// The one piece of state in this ABI, and the header says why. Unset, a start
// resolves no cup and the CPU fill seats nobody.
race::FieldWorld g_world;
std::vector<race::Cup> g_cups;

// ---- scratch buffers ---------------------------------------------------------
// One per string-returning export rather than one shared: a shell reads the
// launch answer and then immediately the demo signature on the same tick, and a
// single buffer would hand the second call's bytes to a caller still holding the
// first's pointer.
std::string g_bufPersonas, g_bufField, g_bufDemo, g_bufSig, g_bufStart, g_bufLaunch,
    g_bufTick, g_bufBeat, g_bufEvent, g_bufEnd, g_bufAdvance, g_bufReturn,
    g_bufForfeit, g_bufRekey, g_bufAutoPause;

const char* put(std::string& buf, const Value& v) {
  ordered_stringify_into(v, buf);
  return buf.c_str();
}

// ---- Value readers -----------------------------------------------------------
// The three that name this layer's option types; everything else is
// ttp/json_read.h, shared with the other ABIs and with the checks that replay
// them.
race::Id idOf(const Value* v) { return json::id_of<race::Id>(v); }
race::OptNum numOf(const Value* v) { return json::opt_num<race::OptNum>(v); }
race::OptStr strOf(const Value* v) { return json::opt_str<race::OptStr>(v); }

std::vector<race::Human> humansOf(const Value* arr) {
  std::vector<race::Human> out;
  if (!arr || arr->type != Value::ARR) return out;
  for (const Value& e : arr->arr) {
    race::Human h;
    h.peerIndex = idOf(e.find("peerIndex"));
    h.name = json::str_field(e, "name");
    h.colorIndex = static_cast<int>(json::num_field(e, "colorIndex"));
    h.carIndex = numOf(e.find("carIndex"));
    out.push_back(std::move(h));
  }
  return out;
}
std::vector<std::string> strListOf(const Value* arr) {
  std::vector<std::string> out;
  if (arr && arr->type == Value::ARR)
    for (const Value& e : arr->arr) if (e.type == Value::STR) out.push_back(e.str);
  return out;
}
// A world whose botCap comes off THIS call rather than the configured one: the
// ?bots cap is a per-launch debug hook, not part of the boot world.
race::FieldWorld worldWithCap(const char* botCapJson) {
  race::FieldWorld w = g_world;
  w.botCap = numOf(nullptr);
  Value cap = json::parse_or(botCapJson, Value::Null());
  if (cap.type == Value::NUM) w.botCap = race::OptNum::Of(cap.num);
  return w;
}

// ---- writers -----------------------------------------------------------------
Value valOf(const race::OptNum& n) { return n.has ? Value::Num(n.v) : Value::Null(); }
Value valOf(const race::OptStr& s) { return s.has ? Value::Str(s.v) : Value::Null(); }

Value personaVal(const race::Persona& p) {
  Value v = Value::Obj();
  v.set("name", Value::Str(p.name));
  v.set("caution", Value::Num(p.caution));
  v.set("laneBias", Value::Num(p.laneBias));
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

// One effect, spelled exactly as raceFlow.js wrote its literal. The switch is
// exhaustive so a new op that forgets its payload is a -Wswitch warning.
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
  // A cup plan carries ONLY kind+cupId — the shell already holds the cup.
  if (s.series.kind != race::SeriesKind::CUP) {
    v.set("cupName", Value::Str(s.series.cupName));
    Value t = Value::Arr();
    for (const std::string& id : s.series.tracks) t.push(Value::Str(id));
    v.set("tracks", t);
  }
  return v;
}
Value wrapEffects(const race::Effects& es) {
  Value v = Value::Obj();
  v.set("effects", effectsVal(es));
  return v;
}

}  // namespace

// ---- the world ---------------------------------------------------------------

int ttp_race_configure(const char* json) {
  ttp::clear_error();
  bool ok = false;
  Value v = json::parse(json ? json : "", &ok);
  if (!ok || v.type != Value::OBJ) {
    ttp::set_error("ttp_race_configure: expected a JSON object (fieldSize, carCount, personas, "
                   "carStats, cups), got " + ttp::error_excerpt(json));
    return 0;
  }

  race::FieldWorld w;
  w.fieldSize = static_cast<int>(json::num_field(v, "fieldSize"));
  w.carCount = static_cast<int>(json::num_field(v, "carCount"));
  w.colorCount = static_cast<int>(json::num_field(v, "colorCount"));
  const std::string prefix = json::str_field(v, "aiPrefix");
  if (!prefix.empty()) w.aiPrefix = prefix;
  if (const Value* ps = v.find("personas")) {
    if (ps->type == Value::ARR) {
      for (const Value& p : ps->arr) {
        race::Persona x;
        x.name = json::str_field(p, "name");
        x.caution = json::num_field(p, "caution");
        x.laneBias = json::num_field(p, "laneBias");
        w.personas.push_back(std::move(x));
      }
    }
  }
  // The stat rows are copied WHOLE and never read — that is what keeps CAR_STATS
  // out of libttp-runtime.
  if (const Value* cs = v.find("carStats")) {
    if (cs->type == Value::ARR) for (const Value& row : cs->arr) w.carStats.push_back(row);
  }
  std::vector<race::Cup> cups;
  if (const Value* cv = v.find("cups")) {
    if (cv->type == Value::ARR) {
      for (const Value& c : cv->arr) {
        race::Cup cup;
        cup.id = json::str_field(c, "id");
        cup.name = json::str_field(c, "name");
        if (const Value* t = c.find("tracks")) cup.tracks = strListOf(t);
        cups.push_back(std::move(cup));
      }
    }
  }
  g_world = std::move(w);
  g_cups = std::move(cups);
  return 1;
}

const char* ttp_race_personas_json(void) {
  Value a = Value::Arr();
  // libttp-sim's own table — the single source, so a shell never keeps a copy.
  for (const ttp::Persona& p : ttp::AI_PERSONALITIES) {
    Value v = Value::Obj();
    v.set("name", Value::Str(p.name));
    v.set("caution", Value::Num(p.caution));
    v.set("laneBias", Value::Num(p.laneBias));
    a.push(v);
  }
  return put(g_bufPersonas, a);
}

// ---- the field ---------------------------------------------------------------

const char* ttp_race_build_field_json(const char* playersJson, double seed,
                                      const char* botCapJson) {
  Value players = json::parse_or(playersJson, Value::Arr());
  race::BuiltField b = race::buildField(humansOf(&players), seed, worldWithCap(botCapJson));
  Value v = Value::Obj();
  v.set("field", arrOf(b.field, fieldVal));
  v.set("bots", arrOf(b.bots, botVal));
  v.set("aiIds", idArr(b.aiIds));
  return put(g_bufField, v);
}

const char* ttp_race_build_demo_field_json(const char* playersJson, const char* botCapJson) {
  Value players = json::parse_or(playersJson, Value::Arr());
  return put(g_bufDemo,
             arrOf(race::buildDemoField(humansOf(&players), worldWithCap(botCapJson)), demoVal));
}

const char* ttp_race_demo_sig(const char* demoFieldJson, const char* trackId) {
  Value arr = json::parse_or(demoFieldJson, Value::Arr());
  std::vector<race::DemoEntry> f;
  if (arr.type == Value::ARR) {
    for (const Value& e : arr.arr) {
      race::DemoEntry d;
      d.id = json::str_field(e, "id");
      d.colorIndex = static_cast<int>(json::num_field(e, "colorIndex"));
      d.carIndex = numOf(e.find("carIndex"));
      f.push_back(std::move(d));
    }
  }
  g_bufSig = race::demoSig(f, trackId ? trackId : "");
  return g_bufSig.c_str();
}

// ---- start / launch ----------------------------------------------------------

const char* ttp_race_start_json(const char* inputJson) {
  Value in = json::parse_or(inputJson, Value::Obj());
  race::StartInput si;
  si.roomState = ttp::rt::ui::roomStateOf(json::str_field(in, "roomState"));
  si.sceneReady = json::truthy(in.find("sceneReady"));
  si.selectedTrackId = strOf(in.find("selectedTrackId"));
  {
    const Value* p = in.find("players");
    si.players = humansOf(p);
  }
  si.mode = json::str_field(in, "mode");
  si.cupId = strOf(in.find("cupId"));
  si.trackId = json::str_field(in, "trackId");
  si.randomRaces = json::num_field(in, "randomRaces");
  si.cups = g_cups;
  si.draws = strListOf(in.find("draws"));

  race::StartResult r = race::startRace(si);
  Value v = Value::Obj();
  v.set("action", Value::Str(race::key(r.action)));
  // Key presence is the contract: a rejection carries `reason` and no series,
  // an acceptance carries `series`+`drawsUsed` and no reason.
  if (r.action == race::StartAction::LAUNCH) {
    v.set("series", planVal(r.series));
    v.set("drawsUsed", Value::Num(r.drawsUsed));
  } else {
    v.set("reason", Value::Str(race::key(r.reason)));
  }
  return put(g_bufStart, v);
}

int ttp_race_draws_needed(const char* inputJson) {
  Value in = json::parse_or(inputJson, Value::Obj());
  return race::drawsNeeded(json::str_field(in, "mode"), json::num_field(in, "randomRaces"));
}

int ttp_race_return_draws_needed(const char* inputJson) {
  Value in = json::parse_or(inputJson, Value::Obj());
  return race::returnDrawsNeeded(json::str_field(in, "mode"));
}

const char* ttp_race_launch_json(const char* inputJson) {
  Value in = json::parse_or(inputJson, Value::Obj());
  race::LaunchInput li;
  li.players = humansOf(in.find("players"));
  li.seed = json::num_field(in, "seed");
  li.trackId = json::str_field(in, "trackId");
  li.countdownSeconds = json::num_field(in, "countdownSeconds");
  li.forceItem = strOf(in.find("forceItem"));
  {
    const Value* cap = in.find("botCap");
    li.world = g_world;
    li.world.botCap = numOf(cap);
  }
  race::LaunchResult r = race::launchRace(li);
  Value v = Value::Obj();
  v.set("effects", effectsVal(r.effects));
  v.set("field", arrOf(r.field, fieldVal));
  v.set("aiIds", idArr(r.aiIds));
  v.set("bots", arrOf(r.bots, botVal));
  return put(g_bufLaunch, v);
}

const char* ttp_race_countdown_tick_json(double n) {
  return put(g_bufTick, wrapEffects(race::countdownTick(n)));
}

const char* ttp_race_start_beat_json(const char* biome, int audioReady) {
  return put(g_bufBeat, wrapEffects(race::raceStart(biome ? biome : "", audioReady != 0)));
}

// ---- the finish --------------------------------------------------------------

const char* ttp_race_event_json(const char* inputJson) {
  Value in = json::parse_or(inputJson, Value::Obj());
  race::RaceEvent ev;
  if (const Value* e = in.find("event")) {
    if (e->type == Value::OBJ) {
      ev.present = true;
      ev.type = json::str_field(*e, "type");
      ev.id = idOf(e->find("id"));
      ev.item = json::str_field(*e, "item");
      ev.cause = json::str_field(*e, "cause");
      ev.finished = json::truthy(e->find("finished"));
      ev.s = json::num_field(*e, "s");
      ev.lat = json::num_field(*e, "lat");
    }
  }
  return put(g_bufEvent, wrapEffects(race::raceEvent(ev, json::truthy(in.find("fastForwarding")),
                                                     json::truthy(in.find("humansAllDone")))));
}

const char* ttp_race_end_json(const char* inputJson) {
  Value in = json::parse_or(inputJson, Value::Obj());
  race::EndRaceInput ei;
  ei.hasSeries = json::truthy(in.find("hasSeries"));
  ei.seriesFinished = json::truthy(in.find("seriesFinished"));
  ei.intermissionMs = json::num_field(in, "intermissionMs");
  ei.nowMs = json::num_field(in, "nowMs");
  ei.resultsFailsafeMs = json::num_field(in, "resultsFailsafeMs");
  return put(g_bufEnd, wrapEffects(race::endRace(ei)));
}

// ---- the cup chain / the way out ---------------------------------------------

const char* ttp_race_advance_json(const char* inputJson) {
  Value in = json::parse_or(inputJson, Value::Obj());
  race::AdvanceInput ai;
  ai.roomState = ttp::rt::ui::roomStateOf(json::str_field(in, "roomState"));
  ai.hasSeries = json::truthy(in.find("hasSeries"));
  ai.seriesFinished = json::truthy(in.find("seriesFinished"));
  ai.sceneReady = json::truthy(in.find("sceneReady"));
  ai.players = humansOf(in.find("players"));
  race::AdvanceResult r = race::advanceSeriesRace(ai);
  Value v = Value::Obj();
  v.set("action", Value::Str(race::key(r.action)));
  v.set("effects", effectsVal(r.effects));
  return put(g_bufAdvance, v);
}

const char* ttp_race_return_json(const char* inputJson) {
  Value in = json::parse_or(inputJson, Value::Obj());
  race::ReturnInput ri;
  ri.roomState = ttp::rt::ui::roomStateOf(json::str_field(in, "roomState"));
  ri.mode = json::str_field(in, "mode");
  ri.cupId = strOf(in.find("cupId"));
  ri.trackId = strOf(in.find("trackId"));
  ri.cups = g_cups;
  ri.draws = strListOf(in.find("draws"));
  race::ReturnResult r = race::returnToLobby(ri);
  Value v = Value::Obj();
  v.set("action", Value::Str(race::key(r.action)));
  v.set("effects", effectsVal(r.effects));
  // The no-op branch has no trackSwap key at all.
  if (r.action == race::ReturnAction::RETURN) v.set("trackSwap", valOf(r.trackSwap));
  v.set("drawsUsed", Value::Num(r.drawsUsed));
  return put(g_bufReturn, v);
}

// ---- the roster-driven repairs -----------------------------------------------

const char* ttp_race_forfeit_json(int removed, const char* peerIdJson) {
  return put(g_bufForfeit,
             wrapEffects(race::forfeitCar(removed != 0, parse_scalar_id(peerIdJson))));
}

const char* ttp_race_rekey_json(int hasSeries, int rekeyed, const char* oldIdJson,
                                const char* newIdJson) {
  return put(g_bufRekey,
             wrapEffects(race::rekeyCarPlayer(hasSeries != 0, rekeyed != 0,
                                              parse_scalar_id(oldIdJson),
                                              parse_scalar_id(newIdJson))));
}

const char* ttp_race_auto_pause_json(const char* decisionJson) {
  Value d = json::parse_or(decisionJson, Value::Null());
  race::AutoPauseDecision dec;
  if (d.type == Value::OBJ) {
    dec.present = true;
    dec.action = json::str_field(d, "action");
    dec.autoPaused = json::truthy(d.find("autoPaused"));
  }
  return put(g_bufAutoPause, wrapEffects(race::autoPauseEffects(dec)));
}
