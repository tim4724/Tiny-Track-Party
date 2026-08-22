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
#include "ttp/perf_stats.h"
#include "ttp/race_flow.h"
#include "ttp/scalar_id.h"
#include "ttp/ui_model.h"
// The live room, race and series, through the seams — see ttp_room.h /
// ttp_session.h / ttp_live.h. This file gains no edge on libttp-party or the
// registries, only on the shim that already links them.
#include "ttp_live.h"
#include "ttp_net.h"
#include "ttp_progress.h"
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
// The bench latch (ttp_race_autopilot_players). Off is the shipping path and
// the only path any recorded launch takes.
bool g_autopilotPlayers = false;

// ---- scratch buffers ---------------------------------------------------------
// One per string-returning export rather than one shared: a shell reads the
// start answer and then immediately the demo signature on the same tick, and a
// single buffer would hand the second call's bytes to a caller still holding the
// first's pointer.
std::string g_bufPersonas, g_bufOps, g_bufDemo, g_bufStart, g_bufLaunch,
    g_bufEvents, g_bufAdvance, g_bufReturn, g_bufEndParty,
    g_bufPause, g_bufResume,
    g_bufForfeit, g_bufRekey, g_bufAutoPause, g_bufBench;

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

// The launch, shared by the start walk and the cup chain's launch. The grid
// rule is the GAME's, so it lives here in the shared walk rather than in any
// shell: humans always start at the back, and a chained series race grids by
// the previous race's finish order (gridOrder — empty on a fresh start).
race::LaunchResult launchOff(int roomHandle, std::vector<race::Human> players,
                             double seed, double countdownSeconds,
                             const char* forceItemOrNull, const char* botCapJson,
                             std::vector<race::Id> gridOrder = {}) {
  race::LaunchInput li;
  li.players = std::move(players);
  li.seed = seed;
  const Value pick = ttp_room_pick_value(roomHandle);
  li.trackId = json::str_field(pick, "trackId");
  li.countdownSeconds = countdownSeconds;
  li.forceItem = optStrOfC(forceItemOrNull);
  li.world = worldWithCap(botCapJson);
  li.humansAtBack = true;
  li.autopilotPlayers = g_autopilotPlayers;
  li.gridOrder = std::move(gridOrder);
  // EVERY LIVE LAUNCH DEFERS. The flag exists for the corpus, whose recorded
  // launches predate the gate; a shipping race always waits for the scene it is
  // about to be driven on (race_flow.h, countdownReady).
  li.deferCountdown = true;
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
  // ONLY when set — key PRESENCE is contract here (this file's header), and an
  // unconditional `player:false` would rewrite every recorded launch's bots
  // array for a marker no shipping launch ever raises.
  if (b.player) v.set("player", Value::Bool(true));
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
      v.set("seed", Value::Num(e.num));
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
    // Bare from the DECISION layer; the executor enriches it with the banked
    // record (`progress`) the same way create-session gains its field rows.
    case race::Op::PERSIST_PROGRESSION:
      break;
  }
  return v;
}
Value effectsVal(const race::Effects& es) { return arrOf(es, effectVal); }

Value wrapEffects(const race::Effects& es) {
  Value v = Value::Obj();
  v.set("effects", effectsVal(es));
  return v;
}

// ---- the executor ------------------------------------------------------------
// The decision layer (race_flow.cc) still answers the FULL corpus-pinned
// effect list; this walk executes the ops whose object lives behind the room
// (the series, the retained field, the pick's track) and spells the remainder
// for the shell. What a shell performs is therefore only what names a
// platform API — and what the executor performed is observable through the
// stored state, which is how abi_check gates it.
void executeAndSpell(int roomHandle, const race::Effects& es,
                     const Value* resultsRowsForApply, Value& out) {
  for (const race::Effect& e : es) {
    switch (e.op) {
      case race::Op::SET_FIELD:
        // Retain the field rows; nothing about them crosses to a shell.
        ttp_room_store_field(roomHandle, arrOf(e.field, fieldVal));
        break;
      case race::Op::CLEAR_FIELD:
        ttp_room_store_field(roomHandle, Value::Null());
        break;
      case race::Op::APPLY_RACE_POINTS: {
        const int gp = ttp_room_series(roomHandle);
        if (gp && resultsRowsForApply) {
          // An endless series on its last queued race extends itself from the
          // room's bag — the WHEN is the series engine's (needsDraw).
          std::string drawn;
          const Value st = json::parse_or(ttp_gp_state_json(gp), Value::Obj());
          if (json::truthy(st.find("needsDraw"))) drawn = ttp_live_bag_draw(roomHandle);
          ttp_gp_apply_race(gp, canonical_stringify(*resultsRowsForApply).c_str(),
                            canonical_stringify(ttp_room_field_value(roomHandle)).c_str(),
                            drawn.empty() ? nullptr : drawn.c_str());
        }
        break;
      }
      case race::Op::SERIES_ADVANCE:
        if (const int gp = ttp_room_series(roomHandle)) ttp_gp_advance(gp);
        break;
      case race::Op::CLEAR_SERIES:
        ttp_room_store_series(roomHandle, 0);  // disposes the gp handle
        break;
      case race::Op::SET_TRACK_FROM_SERIES: {
        // The net walk owns the store + publish + preview tail; its effects
        // (track-change, publish, ...) merge into this answer in place, so the
        // shell performs them with everything else in index order.
        if (const ttp::CupSeries* s = ttp_gp_series(ttp_room_series(roomHandle))) {
          const Value sub = json::parse_or(
              ttp_net_set_track_json(roomHandle, s->currentTrackId().c_str()), Value::Obj());
          if (const Value* fx = sub.find("effects"))
            if (fx->type == Value::ARR) for (const Value& x : fx->arr) out.push(x);
        }
        break;
      }
      case race::Op::SET_TRACK: {
        // return-to-lobby's re-aim (random re-roll / cup rewind): same merge.
        const Value sub = json::parse_or(
            ttp_net_set_track_json(roomHandle, e.str.c_str()), Value::Obj());
        if (const Value* fx = sub.find("effects"))
          if (fx->type == Value::ARR) for (const Value& x : fx->arr) out.push(x);
        break;
      }
      case race::Op::SERIES_REKEY:
        if (const int gp = ttp_room_series(roomHandle))
          ttp_gp_rekey(gp, canonical_stringify(e.id.toValue()).c_str(),
                       canonical_stringify(e.id2.toValue()).c_str());
        break;
      case race::Op::REKEY_FIELD: {
        Value f = ttp_room_field_value(roomHandle);
        if (f.type == Value::ARR) {
          for (Value& row : f.arr)
            if (idOf(row.find("peerIndex")) == e.id) row.set("peerIndex", e.id2.toValue());
          ttp_room_store_field(roomHandle, std::move(f));
        }
        break;
      }
      case race::Op::CREATE_SESSION: {
        // The constructor's one remaining input the effect did not carry: the
        // field rows, which used to arrive on the (now-executed) set-field
        // effect. Enriched from the retained copy stored moments earlier in
        // this same walk.
        Value v = effectVal(e);
        v.set("field", ttp_room_field_value(roomHandle));
        out.push(std::move(v));
        break;
      }
      case race::Op::PERSIST_PROGRESSION: {
        // The list puts this AFTER apply-race-points, so the series standings
        // read here are final. The bank decides which human's rank counts (and
        // whether this series id may bank at all); the shell only writes the
        // enriched blob.
        if (const ttp::CupSeries* s = ttp_gp_series(ttp_room_series(roomHandle))) {
          std::vector<bool> aiByRank;
          for (const ttp::GpStanding& row : s->standings()) aiByRank.push_back(row.ai);
          ttp_progress_bank(s->cup().id, aiByRank);
        }
        Value v = effectVal(e);
        v.set("progress", ttp_progress_value());
        out.push(std::move(v));
        break;
      }
      default:
        out.push(effectVal(e));
    }
  }
}

// The series plan, stood up and stored behind the room. Returns the gp handle
// (0 = single race); a fresh race always REPLACES the stored series, which
// disposes a finished cup's engine.
int standUpSeries(int roomHandle, const race::SeriesForStart& plan) {
  int gp = 0;
  if (plan.has) {
    Value cup = Value::Obj();
    if (plan.series.kind == race::SeriesKind::CUP) {
      for (const race::Cup& c : g_cups) {
        if (c.id != plan.series.cupId) continue;
        cup.set("id", Value::Str(c.id));
        cup.set("name", Value::Str(c.name));
        Value t = Value::Arr();
        for (const std::string& id : c.tracks) t.push(Value::Str(id));
        cup.set("tracks", std::move(t));
        break;
      }
    } else {
      cup.set("id", Value::Str(plan.series.cupId));
      cup.set("name", Value::Str(plan.series.cupName));
      Value t = Value::Arr();
      for (const std::string& id : plan.series.tracks) t.push(Value::Str(id));
      cup.set("tracks", std::move(t));
    }
    gp = ttp_gp_create(canonical_stringify(cup).c_str(),
                       plan.series.kind == race::SeriesKind::RANDOM_ENDLESS ? 1 : 0);
  }
  ttp_room_store_series(roomHandle, gp);
  return gp;
}

Value refuse(const char* reason) {
  Value v = Value::Obj();
  v.set("action", Value::Str("none"));
  v.set("reason", Value::Str(reason));
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
  } else {
    // Absent means libttp-sim's own table — the single source, no read-back
    // round trip at boot. An explicit array (the corpus's synthetic world)
    // still overrides.
    for (const ttp::Persona& p : ttp::AI_PERSONALITIES) {
      race::Persona x;
      x.name = p.name;
      x.caution = p.caution;
      x.laneBias = p.laneBias;
      w.personas.push_back(std::move(x));
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
  // libttp-sim's own table — the single source; configure defaults to it, and
  // this read exists for the shells' test surfaces and the drift pin
  // (tests/display-abi.test.js).
  for (const ttp::Persona& p : ttp::AI_PERSONALITIES) {
    Value v = Value::Obj();
    v.set("name", Value::Str(p.name));
    v.set("caution", Value::Num(p.caution));
    v.set("laneBias", Value::Num(p.laneBias));
    a.push(v);
  }
  return put(g_bufPersonas, a);
}

// ---- the bench ---------------------------------------------------------------

void ttp_race_autopilot_players(int on) { g_autopilotPlayers = on != 0; }

const char* ttp_race_bench_field_json(const char* trackId, int players, double seed) {
  race::LaunchInput li;
  li.players = race::benchPlayers(players, g_world);
  li.seed = seed;
  li.trackId = trackId ? trackId : "";
  li.world = g_world;
  // The game's rule, both of them, unconditionally: this exists so a bench with
  // no room draws what the walk would, and a bench that gridded differently
  // would be measuring a different picture.
  li.humansAtBack = true;
  li.autopilotPlayers = true;
  const race::LaunchResult r = race::launchRace(li);

  // ONLY the two arrays ttp_session_begin_field takes. The effect list is the
  // walk's business and there is no room here to perform it against.
  Value out = Value::Obj();
  Value field = Value::Arr();
  for (const race::FieldEntry& f : r.field) field.push(fieldVal(f));
  Value bots = Value::Arr();
  for (const race::BotSpec& b : r.bots) bots.push(botVal(b));
  out.set("field", field);
  out.set("bots", bots);
  return put(g_bufBench, out);
}

// ---- the vocabulary ----------------------------------------------------------

// The ops a walk's ANSWER can carry — the enum minus the executor's own set,
// which executeAndSpell performs against the room's stored series/field/pick
// and strips. A shell asserts its performer table against exactly this list
// (net-vocabulary ops merged in by the set-track executor are the net list's,
// asserted separately against ttp_net_effect_ops_json).
static bool executorOp(race::Op op) {
  switch (op) {
    case race::Op::SET_FIELD:
    case race::Op::CLEAR_FIELD:
    case race::Op::APPLY_RACE_POINTS:
    case race::Op::SERIES_ADVANCE:
    case race::Op::CLEAR_SERIES:
    case race::Op::SET_TRACK_FROM_SERIES:
    case race::Op::SET_TRACK:
    case race::Op::SERIES_REKEY:
    case race::Op::REKEY_FIELD:
      return true;
    default:
      return false;
  }
}

const char* ttp_race_effect_ops_json(void) {
  Value a = Value::Arr();
  for (int i = 0; i < race::OP_COUNT; ++i) {
    const race::Op op = static_cast<race::Op>(i);
    if (!executorOp(op)) a.push(Value::Str(race::key(op)));
  }
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

const char* ttp_race_start_live_json(int roomHandle, int sceneReady, double seed,
                                     double countdownSeconds,
                                     const char* forceItemOrNull,
                                     const char* botCapJson) {
  race::StartInput si = startInputOf(roomHandle, sceneReady);
  // Verdict first, with no draws — a start that is going to be refused must
  // not advance the bag, and a draw can never be put back.
  race::StartResult r = race::startRace(si);
  if (r.action != race::StartAction::LAUNCH)
    return put(g_bufStart, refuse(race::key(r.reason)));
  const int need = race::drawsNeeded(si.mode, si.randomRaces);
  if (si.mode == "tour") {
    // The World Tour draws per UNLOCKED cup, in cup order — race 1 is the
    // pick's own draw from the first unlocked cup (the pick walk restricted
    // it), so the card's remaining races skip that lead cup and every locked
    // one. Pre-unlock the tour is simply shorter; drawsNeeded already read the
    // count off the pick's randomRaces.
    bool leadSkipped = false;
    for (size_t c = 0; c < g_cups.size() && (int)si.draws.size() < need; ++c) {
      if (!ttp_progress_cup_unlocked(g_cups[c].id)) continue;
      if (!leadSkipped) { leadSkipped = true; continue; }
      const std::string d = ttp_live_bag_draw_cup(roomHandle, g_cups[c].id);
      if (d.empty()) break;
      si.draws.push_back(d);
    }
  } else {
    for (int i = 0; i < need; ++i) {
      const std::string d = ttp_live_bag_draw(roomHandle);
      if (d.empty()) break;
      si.draws.push_back(d);
    }
  }
  if ((int)si.draws.size() < need)
    // An unseeded bag under a random pick — near-unreachable (the pick walk
    // refuses random without a bag), and a refusal is the legible answer.
    return put(g_bufStart, refuse("no-track"));
  if (need > 0) {
    r = race::startRace(si);
    if (r.action != race::StartAction::LAUNCH)
      return put(g_bufStart, refuse(race::key(r.reason)));
  }
  standUpSeries(roomHandle, r.series);
  race::LaunchResult lr = launchOff(roomHandle, si.players, seed, countdownSeconds,
                                    forceItemOrNull, botCapJson);
  Value v = Value::Obj();
  v.set("action", Value::Str("launch"));
  Value fx = Value::Arr();
  executeAndSpell(roomHandle, lr.effects, nullptr, fx);
  v.set("effects", std::move(fx));
  Value tail = Value::Arr();
  executeAndSpell(roomHandle, lr.countdownEffects, nullptr, tail);
  v.set("countdownEffects", std::move(tail));
  return put(g_bufStart, v);
}

// ---- the frame's event drain -------------------------------------------------

const char* ttp_race_events_live_json(int sessionHandle, int roomHandle,
                                      const char* biome,
                                      int audioReady, int fastForwarding,
                                      double intermissionMs, double nowMs,
                                      double resultsFailsafeMs) {
  const Value evs = ttp_session_drain_events(sessionHandle);
  const ttp::CupSeries* series = ttp_gp_series(ttp_room_series(roomHandle));
  Value fx = Value::Arr();
  Value results = Value::Null();
  if (evs.type == Value::ARR) {
    for (const Value& e : evs.arr) {
      const std::string type = json::str_field(e, "type");
      // The three lifecycle beats have their own entry points — feeding them
      // to the ordinary-event filter makes them vanish, which is the routing
      // bug this drain exists to end (shells.md, the fourth launch bug).
      if (type == "_countdown") {
        executeAndSpell(roomHandle, race::countdownTick(json::num_field(e, "n")), nullptr, fx);
      } else if (type == "_raceStart") {
        executeAndSpell(roomHandle, race::raceStart(biome ? biome : "", audioReady != 0),
                        nullptr, fx);
      } else if (type == "_raceEnd") {
        race::EndRaceInput ei;
        ei.hasSeries = series != nullptr;
        // "Finished" must mean AFTER this race's points apply: done_ flips
        // inside applyRace, which APPLY_RACE_POINTS runs later in this very
        // walk — read it here and the final race still says false, the
        // persist op never emits, and no cup ever banks (the bug the podium
        // E2E caught). An endless series extends itself instead of ending.
        ei.seriesFinished =
            series && (series->finished() ||
                       (!series->endless() && series->raceIndex() + 1 >= series->raceCount()));
        ei.intermissionMs = intermissionMs;
        ei.nowMs = nowMs;
        ei.resultsFailsafeMs = resultsFailsafeMs;
        // The live walk always banks a finished series; the flag exists so the
        // frozen corpus lines (which predate progression) stay byte-identical.
        ei.bankProgression = true;
        if (const Value* r = e.find("results")) results = *r;
        // Points bank HERE, against the retained field — before the board
        // effects the shell performs, exactly the order the corpus pins.
        const Value* rows = results.type == Value::OBJ ? results.find("results") : nullptr;
        executeAndSpell(roomHandle, race::endRace(ei), rows, fx);
      } else {
        // humans-all-done is read off the live handles exactly when a finish
        // asks for it — the one event whose effects branch on the answer.
        const bool allDone = type == "finish" && !fastForwarding &&
                             ttp_live_humans_all_done(sessionHandle, roomHandle);
        executeAndSpell(roomHandle,
                        race::raceEvent(eventOf(e), fastForwarding != 0, allDone),
                        nullptr, fx);
      }
    }
  }
  Value v = Value::Obj();
  v.set("effects", std::move(fx));
  v.set("results", std::move(results));
  return put(g_bufEvents, v);
}

// ---- the cup chain / the way out ---------------------------------------------

const char* ttp_race_advance_live_json(int roomHandle, int sceneReady, double seed,
                                       double countdownSeconds,
                                       const char* forceItemOrNull,
                                       const char* botCapJson) {
  const ttp::CupSeries* s = ttp_gp_series(ttp_room_series(roomHandle));
  race::AdvanceInput ai;
  ai.roomState = rtui::roomStateOf(ttp_room_state_name(roomHandle));
  ai.hasSeries = s != nullptr;
  ai.seriesFinished = s && s->finished();
  ai.sceneReady = sceneReady != 0;
  ai.players = humansOfEntries(ttp_live_roster_players(roomHandle, true));
  race::AdvanceResult r = race::advanceSeriesRace(ai);
  Value v = Value::Obj();
  v.set("action", Value::Str(race::key(r.action)));
  Value fx = Value::Arr();
  Value tail = Value::Arr();
  executeAndSpell(roomHandle, r.effects, nullptr, fx);
  if (r.action == race::AdvanceAction::ADVANCE) {
    // The advance re-aimed the pick at the cup's next circuit (executed
    // above), so the launch reads everything back off the handles. One walk:
    // RESULTS -> COUNTDOWN with no shell sequencing in between. The chained
    // grid is the previous race's finish order (advance() moved raceIndex, not
    // the banked ranks, so the read is the same on either side of it).
    race::LaunchResult lr = launchOff(roomHandle, ai.players, seed, countdownSeconds,
                                      forceItemOrNull, botCapJson,
                                      s ? s->lastRaceOrder() : std::vector<race::Id>{});
    executeAndSpell(roomHandle, lr.effects, nullptr, fx);
    executeAndSpell(roomHandle, lr.countdownEffects, nullptr, tail);
  }
  v.set("effects", std::move(fx));
  v.set("countdownEffects", std::move(tail));
  return put(g_bufAdvance, v);
}

const char* ttp_race_return_live_json(int roomHandle) {
  race::ReturnInput ri;
  ri.roomState = rtui::roomStateOf(ttp_room_state_name(roomHandle));
  const Value pick = ttp_room_pick_value(roomHandle);
  ri.mode = json::str_field(pick, "mode");
  ri.cupId = strOf(pick.find("cupId"));
  ri.trackId = strOf(pick.find("trackId"));
  ri.cups = g_cups;
  // A return that is a no-op must not advance the bag: the rule is asked
  // first, and only an accepted return draws its re-roll.
  race::ReturnResult r = race::returnToLobby(ri);
  if (r.action == race::ReturnAction::RETURN) {
    const int need = race::returnDrawsNeeded(ri.mode);
    bool drew = true;
    for (int i = 0; i < need; ++i) {
      // The tour's re-aim is race 1's preview, so its re-roll draws from the
      // first UNLOCKED cup only — and a cupless world refuses rather than
      // drawing wide.
      std::string lead;
      if (ri.mode == "tour")
        for (const race::Cup& c : g_cups)
          if (ttp_progress_cup_unlocked(c.id)) { lead = c.id; break; }
      const std::string d = ri.mode == "tour"
          ? (lead.empty() ? std::string() : ttp_live_bag_draw_cup(roomHandle, lead))
          : ttp_live_bag_draw(roomHandle);
      if (d.empty()) { drew = false; break; }
      ri.draws.push_back(d);
    }
    if (need > 0 && drew) r = race::returnToLobby(ri);
  }
  Value v = Value::Obj();
  v.set("action", Value::Str(race::key(r.action)));
  Value fx = Value::Arr();
  executeAndSpell(roomHandle, r.effects, nullptr, fx);
  v.set("effects", std::move(fx));
  return put(g_bufReturn, v);
}

const char* ttp_race_end_party_json(void) {
  return put(g_bufEndParty, wrapEffects(race::endParty()));
}

// ---- the series read ---------------------------------------------------------

const char* ttp_race_series_state_json(int roomHandle) {
  const int gp = ttp_room_series(roomHandle);
  // ttp_gp_state_json's own scratch backs the answer; "null" without a series.
  return gp ? ttp_gp_state_json(gp) : "null";
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

// ---- the countdown gate ------------------------------------------------------

int ttp_race_countdown_ready(int sceneBuilt, int measuring, double sinceLaunchMs) {
  // THE SEAM (CLAUDE.md rule 3): the frame evidence is fetched here rather than
  // pulled out of the readout by a shell and handed back in. `present` and not
  // `frame` — perf_stats.h's Readout says why the loop's own cadence cannot see
  // a stalling display link.
  const ttp::rt::perf::Readout r = ttp::rt::perf::monitor().fold();
  return race::countdownReady(sceneBuilt != 0, measuring != 0, r.present.n,
                              r.present.p50, r.present.p95, sinceLaunchMs) ? 1 : 0;
}

// ---- the roster-driven repairs -----------------------------------------------

const char* ttp_race_forfeit_live_json(int sessionHandle, const char* peerIdJson) {
  // The removal happens here, against the live session — the shell used to ask
  // the engine and hand the boolean back in.
  const bool removed = ttp_force_remove_car(sessionHandle, peerIdJson) != 0;
  return put(g_bufForfeit,
             wrapEffects(race::forfeitCar(removed, parse_scalar_id(peerIdJson))));
}

const char* ttp_race_rekey_live_json(int sessionHandle, int roomHandle,
                                     const char* oldIdJson, const char* newIdJson) {
  const bool rekeyed = ttp_rekey_car(sessionHandle, oldIdJson, newIdJson) != 0;
  const bool hasSeries = ttp_gp_series(ttp_room_series(roomHandle)) != nullptr;
  race::Effects es = race::rekeyCarPlayer(hasSeries, rekeyed,
                                          parse_scalar_id(oldIdJson),
                                          parse_scalar_id(newIdJson));
  // Banked points follow the PLAYER and the retained field rows follow the
  // seat — both executed here (series-rekey / rekey-field never reach a shell).
  Value fx = Value::Arr();
  executeAndSpell(roomHandle, es, nullptr, fx);
  Value v = Value::Obj();
  v.set("effects", std::move(fx));
  return put(g_bufRekey, v);
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
