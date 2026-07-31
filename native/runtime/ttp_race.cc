// ttp_race.cc — the race-orchestration ABI over native/libttp-runtime's
// ttp::rt::race.
//
// MARSHALLING AND GATHERING ONLY. Not one orchestration decision is taken in
// this file: every walk reads its inputs off the live handles (the room and gp
// seams, the session registry), hands the plain structs ttp/race_flow.h
// declares to the rules, and spells the answer back out. raceflow_check.cc
// gates the rules against tests/fixtures/raceflow-corpus.jsonl; abi_check.cc
// holds each walk here to the same decision functions over the same state —
// a wrong key, a dropped null or an id parsed as the wrong JSON type lives
// exactly here and is invisible to a check that calls C++ objects directly.
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
#include "ttp/grand_prix.h"
#include "ttp/json_parse.h"
#include "ttp/json_read.h"
#include "ttp/race_flow.h"
#include "ttp/scalar_id.h"
#include "ttp/ui_model.h"
// The live room, race and series, through the seams — see ttp_room.h /
// ttp_session.h / ttp_live.h. This file gains no edge on libttp-party or the
// registries, only on the shim that already links them.
#include "ttp_live.h"
#include "ttp_room.h"
#include "ttp_runtime.h"
#include "ttp_session.h"

using namespace ttp;
namespace race = ttp::rt::race;
namespace rtui = ttp::rt::ui;

namespace {

// ---- the configured world ----------------------------------------------------
// The one piece of state in this ABI, and the header says why. Unset, a start
// resolves no cup and the CPU fill seats nobody.
race::FieldWorld g_world;
std::vector<race::Cup> g_cups;

// ---- scratch buffers ---------------------------------------------------------
// One per string-returning export rather than one shared: a shell reads the
// start answer and then immediately the demo signature on the same tick, and a
// single buffer would hand the second call's bytes to a caller still holding the
// first's pointer.
std::string g_bufPersonas, g_bufOps, g_bufDemo, g_bufStart, g_bufLaunch,
    g_bufEvents, g_bufAdvance, g_bufReturn, g_bufEndParty,
    g_bufPause, g_bufResume,
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

// ---- the live gathers --------------------------------------------------------

// The room's players as the race rules take them. The roster crosses as ui
// entries (ttp_live.h); the field types are 1:1.
std::vector<race::Human> humansOfEntries(const std::vector<rtui::RosterEntry>& es) {
  std::vector<race::Human> out;
  for (const rtui::RosterEntry& e : es) {
    race::Human h;
    h.peerIndex = e.peerIndex;
    h.name = e.name;
    h.colorIndex = static_cast<int>(e.colorIndex);
    h.carIndex = e.carIndex;
    out.push_back(std::move(h));
  }
  return out;
}

// The start gate's whole input off the live room: phase, connected players and
// the stored pick. Draws are the caller's (the protocol in ttp_race.h).
race::StartInput startInputOf(int roomHandle, int sceneReady) {
  race::StartInput si;
  si.roomState = rtui::roomStateOf(ttp_room_state_name(roomHandle));
  si.sceneReady = sceneReady != 0;
  const Value pick = ttp_room_pick_value(roomHandle);
  si.selectedTrackId = strOf(pick.find("trackId"));
  si.mode = json::str_field(pick, "mode");
  si.cupId = strOf(pick.find("cupId"));
  si.trackId = json::str_field(pick, "trackId");
  si.randomRaces = json::num_field(pick, "randomRaces");
  si.cups = g_cups;
  si.players = humansOfEntries(ttp_live_roster_players(roomHandle, /*connectedOnly=*/true));
  return si;
}

race::OptStr optStrOfC(const char* s) {
  return s && *s ? race::OptStr::Of(s) : race::OptStr();
}

// The launch, shared by the start walk and the cup chain's launch.
race::LaunchResult launchOff(int roomHandle, std::vector<race::Human> players,
                             double seed, double countdownSeconds,
                             const char* forceItemOrNull, const char* botCapJson) {
  race::LaunchInput li;
  li.players = std::move(players);
  li.seed = seed;
  const Value pick = ttp_room_pick_value(roomHandle);
  li.trackId = json::str_field(pick, "trackId");
  li.countdownSeconds = countdownSeconds;
  li.forceItem = optStrOfC(forceItemOrNull);
  li.world = worldWithCap(botCapJson);
  return race::launchRace(li);
}

// One drained session event, as the finish rule reads it.
race::RaceEvent eventOf(const Value& e) {
  race::RaceEvent ev;
  ev.present = true;
  ev.type = json::str_field(e, "type");
  ev.id = idOf(e.find("id"));
  ev.item = json::str_field(e, "item");
  ev.cause = json::str_field(e, "cause");
  ev.finished = json::truthy(e.find("finished"));
  ev.s = json::num_field(e, "s");
  ev.lat = json::num_field(e, "lat");
  return ev;
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
    case race::Op::CLOSE_ROOM:
    case race::Op::CLEAR_PICK:
    case race::Op::RENDER_LOBBY_PICK:
    case race::Op::REFRESH_LOBBY_DEMO:
    case race::Op::UPDATE_BACKDROP:
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

// ---- the vocabulary ----------------------------------------------------------

const char* ttp_race_effect_ops_json(void) {
  Value a = Value::Arr();
  for (int i = 0; i < race::OP_COUNT; ++i)
    a.push(Value::Str(race::key(static_cast<race::Op>(i))));
  return put(g_bufOps, a);
}

// ---- the lobby attract demo --------------------------------------------------

const char* ttp_race_demo_live_json(int roomHandle, const char* trackId,
                                    const char* botCapJson) {
  const std::vector<race::DemoEntry> field =
      race::buildDemoField(humansOfEntries(ttp_live_roster_players(roomHandle, false)),
                           worldWithCap(botCapJson));
  Value v = Value::Obj();
  v.set("field", arrOf(field, demoVal));
  v.set("sig", Value::Str(race::demoSig(field, trackId ? trackId : "")));
  return put(g_bufDemo, v);
}

// ---- start / launch ----------------------------------------------------------

const char* ttp_race_start_live_json(int roomHandle, int sceneReady,
                                     const char* drawsJson, double seed,
                                     double countdownSeconds,
                                     const char* forceItemOrNull,
                                     const char* botCapJson) {
  race::StartInput si = startInputOf(roomHandle, sceneReady);
  const bool ask = !drawsJson || !*drawsJson;
  if (!ask) {
    Value draws = json::parse_or(drawsJson, Value::Arr());
    si.draws = strListOf(&draws);
  }
  race::StartResult r = race::startRace(si);
  Value v = Value::Obj();
  // Key presence is the contract: a rejection carries `reason` and nothing
  // else; a draws request carries `drawsNeeded`; a launch carries the plan and
  // the effects.
  if (r.action != race::StartAction::LAUNCH) {
    v.set("action", Value::Str("none"));
    v.set("reason", Value::Str(race::key(r.reason)));
    return put(g_bufStart, v);
  }
  if (ask) {
    const int need = race::drawsNeeded(si.mode, si.randomRaces);
    if (need > 0) {
      // Accepted, but the pick needs randomness: ask the shell for exactly
      // this many draws and decide nothing yet — a draw cannot be put back.
      v.set("action", Value::Str("draws"));
      v.set("drawsNeeded", Value::Num(need));
      return put(g_bufStart, v);
    }
  }
  race::LaunchResult lr = launchOff(roomHandle, si.players, seed, countdownSeconds,
                                    forceItemOrNull, botCapJson);
  v.set("action", Value::Str("launch"));
  v.set("series", planVal(r.series));
  v.set("drawsUsed", Value::Num(r.drawsUsed));
  v.set("effects", effectsVal(lr.effects));
  return put(g_bufStart, v);
}

const char* ttp_race_launch_live_json(int roomHandle, double seed,
                                      double countdownSeconds,
                                      const char* forceItemOrNull,
                                      const char* botCapJson) {
  ttp::clear_error();
  // The cup-chain entry point a shell calls bare, so it must refuse a dead
  // handle LOUDLY: without this, a shell that lost its room would launch a
  // plausible ghost race of CPU seats — the silent-refusal class ttp_last_error
  // exists to remove. (The start walk needs no guard: an unknown handle's
  // empty room-state already refuses with "room-state".)
  if (!ttp_room_flow(roomHandle)) {
    ttp::set_error("ttp_race_launch_live_json: unknown room handle "
                   + std::to_string(roomHandle));
    return put(g_bufLaunch, wrapEffects(race::Effects{}));
  }
  race::LaunchResult lr =
      launchOff(roomHandle,
                humansOfEntries(ttp_live_roster_players(roomHandle, true)),
                seed, countdownSeconds, forceItemOrNull, botCapJson);
  return put(g_bufLaunch, wrapEffects(lr.effects));
}

// ---- the frame's event drain -------------------------------------------------

const char* ttp_race_events_live_json(int sessionHandle, int roomHandle,
                                      int gpHandle, const char* biome,
                                      int audioReady, int fastForwarding,
                                      double intermissionMs, double nowMs,
                                      double resultsFailsafeMs) {
  const Value evs = ttp_session_drain_events(sessionHandle);
  const ttp::CupSeries* series = ttp_gp_series(gpHandle);
  race::Effects all;
  Value results = Value::Null();
  if (evs.type == Value::ARR) {
    for (const Value& e : evs.arr) {
      const std::string type = json::str_field(e, "type");
      race::Effects es;
      // The three lifecycle beats have their own entry points — feeding them
      // to the ordinary-event filter makes them vanish, which is the routing
      // bug this drain exists to end (shells.md, the fourth launch bug).
      if (type == "_countdown") {
        es = race::countdownTick(json::num_field(e, "n"));
      } else if (type == "_raceStart") {
        es = race::raceStart(biome ? biome : "", audioReady != 0);
      } else if (type == "_raceEnd") {
        race::EndRaceInput ei;
        ei.hasSeries = series != nullptr;
        ei.seriesFinished = series && series->finished();
        ei.intermissionMs = intermissionMs;
        ei.nowMs = nowMs;
        ei.resultsFailsafeMs = resultsFailsafeMs;
        es = race::endRace(ei);
        if (const Value* r = e.find("results")) results = *r;
      } else {
        // humans-all-done is read off the live handles exactly when a finish
        // asks for it — the one event whose effects branch on the answer.
        const bool allDone = type == "finish" && !fastForwarding &&
                             ttp_live_humans_all_done(sessionHandle, roomHandle);
        es = race::raceEvent(eventOf(e), fastForwarding != 0, allDone);
      }
      for (race::Effect& x : es) all.push_back(std::move(x));
    }
  }
  Value v = Value::Obj();
  v.set("effects", effectsVal(all));
  v.set("results", std::move(results));
  return put(g_bufEvents, v);
}

// ---- the cup chain / the way out ---------------------------------------------

const char* ttp_race_advance_live_json(int roomHandle, int gpHandle, int sceneReady) {
  const ttp::CupSeries* s = ttp_gp_series(gpHandle);
  race::AdvanceInput ai;
  ai.roomState = rtui::roomStateOf(ttp_room_state_name(roomHandle));
  ai.hasSeries = s != nullptr;
  ai.seriesFinished = s && s->finished();
  ai.sceneReady = sceneReady != 0;
  ai.players = humansOfEntries(ttp_live_roster_players(roomHandle, true));
  race::AdvanceResult r = race::advanceSeriesRace(ai);
  Value v = Value::Obj();
  v.set("action", Value::Str(race::key(r.action)));
  v.set("effects", effectsVal(r.effects));
  return put(g_bufAdvance, v);
}

const char* ttp_race_return_live_json(int roomHandle, const char* drawsJson) {
  race::ReturnInput ri;
  ri.roomState = rtui::roomStateOf(ttp_room_state_name(roomHandle));
  const Value pick = ttp_room_pick_value(roomHandle);
  ri.mode = json::str_field(pick, "mode");
  ri.cupId = strOf(pick.find("cupId"));
  ri.trackId = strOf(pick.find("trackId"));
  ri.cups = g_cups;
  const bool ask = !drawsJson || !*drawsJson;
  if (!ask) {
    Value draws = json::parse_or(drawsJson, Value::Arr());
    ri.draws = strListOf(&draws);
  }
  race::ReturnResult r = race::returnToLobby(ri);
  Value v = Value::Obj();
  if (r.action != race::ReturnAction::RETURN) {
    v.set("action", Value::Str("none"));
    v.set("effects", Value::Arr());
    v.set("drawsUsed", Value::Num(0));
    return put(g_bufReturn, v);
  }
  if (ask) {
    const int need = race::returnDrawsNeeded(ri.mode);
    if (need > 0) {
      v.set("action", Value::Str("draws"));
      v.set("drawsNeeded", Value::Num(need));
      return put(g_bufReturn, v);
    }
  }
  v.set("action", Value::Str("return"));
  v.set("effects", effectsVal(r.effects));
  v.set("trackSwap", valOf(r.trackSwap));
  v.set("drawsUsed", Value::Num(r.drawsUsed));
  return put(g_bufReturn, v);
}

const char* ttp_race_end_party_json(void) {
  return put(g_bufEndParty, wrapEffects(race::endParty()));
}

// ---- pause / resume ----------------------------------------------------------

static Value pauseValue(const race::PauseResult& r) {
  Value v = Value::Obj();
  v.set("action", Value::Str(race::key(r.action)));
  v.set("effects", effectsVal(r.effects));
  return v;
}

static race::PauseInput pauseInputLive(int sessionHandle, int roomHandle,
                                       int paused, int autoPaused, int raceEnded) {
  race::PauseInput pi;
  pi.hasSession = ttp_session_engine(sessionHandle) != nullptr;
  pi.paused = paused != 0;
  pi.autoPaused = autoPaused != 0;
  pi.raceEnded = raceEnded != 0;
  pi.roomState = rtui::roomStateOf(ttp_room_state_name(roomHandle));
  return pi;
}

const char* ttp_race_pause_live_json(int sessionHandle, int roomHandle,
                                     int paused, int autoPaused, int raceEnded) {
  return put(g_bufPause, pauseValue(race::pauseRace(
      pauseInputLive(sessionHandle, roomHandle, paused, autoPaused, raceEnded))));
}

const char* ttp_race_resume_live_json(int sessionHandle, int roomHandle,
                                      int paused, int autoPaused, int raceEnded) {
  return put(g_bufResume, pauseValue(race::resumeRace(
      pauseInputLive(sessionHandle, roomHandle, paused, autoPaused, raceEnded))));
}

double ttp_race_intermission_ms(void) { return race::INTERMISSION_MS; }
double ttp_race_results_failsafe_ms(void) { return race::RESULTS_FAILSAFE_MS; }

// ---- the roster-driven repairs -----------------------------------------------

const char* ttp_race_forfeit_live_json(int sessionHandle, const char* peerIdJson) {
  // The removal happens here, against the live session — the shell used to ask
  // the engine and hand the boolean back in.
  const bool removed = ttp_force_remove_car(sessionHandle, peerIdJson) != 0;
  return put(g_bufForfeit,
             wrapEffects(race::forfeitCar(removed, parse_scalar_id(peerIdJson))));
}

const char* ttp_race_rekey_live_json(int sessionHandle, int gpHandle,
                                     const char* oldIdJson, const char* newIdJson) {
  const bool rekeyed = ttp_rekey_car(sessionHandle, oldIdJson, newIdJson) != 0;
  return put(g_bufRekey,
             wrapEffects(race::rekeyCarPlayer(ttp_gp_series(gpHandle) != nullptr, rekeyed,
                                              parse_scalar_id(oldIdJson),
                                              parse_scalar_id(newIdJson))));
}

const char* ttp_race_auto_pause_live_json(int sessionHandle, int roomHandle,
                                          int raceEnded) {
  const Value d = ttp_live_auto_pause_decision(sessionHandle, roomHandle, raceEnded);
  race::AutoPauseDecision dec;
  dec.present = true;
  dec.action = json::str_field(d, "action");
  dec.autoPaused = json::truthy(d.find("autoPaused"));
  return put(g_bufAutoPause, wrapEffects(race::autoPauseEffects(dec)));
}
