// ttp_ui.cc — the UI-model ABI over native/libttp-runtime's ttp::rt::ui.
//
// MARSHALLING ONLY. Not one screen decision is taken in this file: every export
// parses its arguments into the plain structs ttp/ui_model.h declares, calls the
// rule, and spells the answer back out. That split is what lets ui_check.cc gate
// the rules against tests/fixtures/ui-corpus.jsonl while this layer is covered
// by runtimetest/abi_check.cc replaying the SAME corpus through the C boundary —
// the arrangement ttp_runtime.cc / ttp_party.cc already have, for the reason
// abi_check's header gives: a wrong key, a dropped null or an id parsed as the
// wrong JSON type lives exactly here and is invisible to a check that calls C++
// objects directly.
//
// KEY ORDER IS OUTPUT, not incidental. Every Value below is built in the order
// the JS object literal was written in and emitted with ordered_stringify, so
// the standings board comes out as the bytes the phones have always received.
// See ttp_ui.h's deviation note.
#include "ttp_ui.h"

#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/scalar_id.h"
#include "ttp/ui_model.h"

using namespace ttp;
namespace ui = ttp::rt::ui;

namespace {

// ---- the configured world ----------------------------------------------------
// The one piece of state in this ABI, and the header says why. Unset, every
// lookup simply misses.
int g_maxPlayers = 0;
int g_carCount = 0;
std::vector<ui::Cup> g_cups;
std::vector<ui::CatalogEntry> g_catalog;

// ---- scratch buffers ---------------------------------------------------------
// One per string-returning export rather than one shared: two of these are read
// back-to-back on the same tick (the roster's seats then its grid, the board
// then its results view), and a single buffer would hand the second call's bytes
// to a caller still holding the first's pointer. ttp_abi.h's rule ("valid until
// the next call") is per handle, and this ABI has none.
std::string g_bufSeats, g_bufGrid, g_bufConnected, g_bufSlot, g_bufDiff,
    g_bufPushes, g_bufWelcome, g_bufFlow, g_bufAutoPause, g_bufSeries,
    g_bufBoard, g_bufView;

const char* put(std::string& buf, const Value& v) {
  ordered_stringify_into(v, buf);
  return buf.c_str();
}

// ---- Value readers -----------------------------------------------------------
// The same handful ui_check.cc uses, for the same shapes. `truthy` is JS
// truthiness rather than a bool test because a corpus/shell field may arrive as
// a missing key, a 0 or an empty string and JS reads all three as false.
Value parseOr(const char* json, Value fallback) {
  if (!json || !*json) return fallback;
  bool ok = false;
  Value v = json::parse(json, &ok);
  return ok ? v : fallback;
}

ui::Id idOf(const Value* v) {
  if (!v) return ui::Id::None();
  if (v->type == Value::NUM) return ui::Id::Num(v->num);
  if (v->type == Value::STR) return ui::Id::Str(v->str);
  return ui::Id::None();
}
ui::OptNum numOf(const Value* v) {
  return (v && v->type == Value::NUM) ? ui::OptNum::Of(v->num) : ui::OptNum::None();
}
ui::OptStr strOf(const Value* v) {
  return (v && v->type == Value::STR) ? ui::OptStr::Of(v->str) : ui::OptStr::None();
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

Value valOf(const ui::OptNum& n) { return n.has ? Value::Num(n.v) : Value::Null(); }
Value valOf(const ui::OptStr& s) { return s.has ? Value::Str(s.v) : Value::Null(); }

// An item as JS spells it: an ABSENT key is `undefined`, which JSON.stringify
// drops. That is a real recorded push and the reason ItemVal is tri-state.
ui::ItemVal itemOf(const Value& car) {
  const Value* v = car.find("item");
  if (!v) return ui::ItemVal::Absent();
  if (v->type == Value::STR) return ui::ItemVal::Str(v->str);
  return ui::ItemVal::Null();
}
void setItem(Value& o, const ui::ItemVal& item) {
  if (item.kind == ui::ItemVal::ABSENT) return;   // the key does not appear
  o.set("item", item.kind == ui::ItemVal::NUL ? Value::Null() : Value::Str(item.str));
}

ui::IdSet idSetOf(const Value* arr) {
  ui::IdSet s;
  if (arr && arr->type == Value::ARR) {
    for (const Value& e : arr->arr) s.add(idOf(&e));
  }
  return s;
}
std::vector<ui::Id> idListOf(const Value* arr) {
  std::vector<ui::Id> out;
  if (arr && arr->type == Value::ARR) {
    for (const Value& e : arr->arr) out.push_back(idOf(&e));
  }
  return out;
}
Value idArray(const std::vector<ui::Id>& ids) {
  Value a = Value::Arr();
  for (const ui::Id& id : ids) a.push(id.toValue());
  return a;
}

// ---- roster <-> Value ---------------------------------------------------------
std::vector<ui::RosterEntry> rosterOf(const Value& arr) {
  std::vector<ui::RosterEntry> out;
  if (arr.type != Value::ARR) return out;
  for (const Value& p : arr.arr) {
    ui::RosterEntry e;
    e.peerIndex = idOf(p.find("peerIndex"));
    e.name = strField(p, "name");
    e.colorIndex = numField(p, "colorIndex");
    e.carIndex = numOf(p.find("carIndex"));
    e.connected = truthy(p.find("connected"));
    e.ready = truthy(p.find("ready"));
    out.push_back(std::move(e));
  }
  return out;
}

// ---- the standings board's rows, both directions ------------------------------
// standingsPayload builds them and resultsView reads them back, so the two
// spellings sit together: a change to one that misses the other would round-trip
// a board into a different board.
Value rowValue(const ui::BoardRow& r) {
  Value o = Value::Obj();                        // the JS literal's order
  o.set("playerId", r.playerId.toValue());
  o.set("name", Value::Str(r.name));
  o.set("colorIndex", Value::Num(r.colorIndex));
  if (r.joining) {
    o.set("joining", Value::Bool(true));
    return o;                                    // a joining row carries nothing else
  }
  o.set("ai", Value::Bool(r.ai));
  o.set("finished", Value::Bool(r.finished));
  o.set("time", valOf(r.time));
  if (r.hasPoints) o.set("points", Value::Num(r.points));
  if (r.hasGained) o.set("gained", Value::Num(r.gained));
  return o;
}

ui::BoardRow rowOf(const Value& v) {
  ui::BoardRow r;
  r.playerId = idOf(v.find("playerId"));
  r.name = strField(v, "name");
  r.colorIndex = numField(v, "colorIndex");
  r.joining = truthy(v.find("joining"));
  if (r.joining) return r;
  r.ai = truthy(v.find("ai"));
  r.finished = truthy(v.find("finished"));
  r.time = numOf(v.find("time"));
  const Value* pts = v.find("points");
  if (pts && pts->type == Value::NUM) { r.hasPoints = true; r.points = pts->num; }
  const Value* gd = v.find("gained");
  if (gd && gd->type == Value::NUM) { r.hasGained = true; r.gained = gd->num; }
  return r;
}

Value seriesValue(const ui::SeriesInfo& s) {
  Value o = Value::Obj();                        // seriesInfo's literal order
  o.set("cupId", valOf(s.cupId));
  o.set("cupName", valOf(s.cupName));
  o.set("endless", Value::Bool(s.endless));
  o.set("raceIndex", Value::Num(s.raceIndex));
  o.set("raceCount", valOf(s.raceCount));
  o.set("nextTrackId", valOf(s.nextTrackId));
  o.set("nextTrackName", valOf(s.nextTrackName));
  o.set("final", Value::Bool(s.isFinal));        // `isFinal` in C++, `final` on the wire
  o.set("autoAdvanceMs", Value::Num(s.autoAdvanceMs));
  return o;
}

ui::SeriesInfo seriesOf(const Value& v) {
  ui::SeriesInfo s;
  s.cupId = strOf(v.find("cupId"));
  s.cupName = strOf(v.find("cupName"));
  s.endless = truthy(v.find("endless"));
  s.raceIndex = numField(v, "raceIndex");
  s.raceCount = numOf(v.find("raceCount"));
  s.nextTrackId = strOf(v.find("nextTrackId"));
  s.nextTrackName = strOf(v.find("nextTrackName"));
  s.isFinal = truthy(v.find("final"));
  s.autoAdvanceMs = numField(v, "autoAdvanceMs");
  return s;
}

ui::Board boardOf(const Value& v) {
  ui::Board b;
  b.over = truthy(v.find("over"));
  b.hostPeerIndex = idOf(v.find("hostPeerIndex"));
  const Value* s = v.find("series");
  if (s && s->type == Value::OBJ) { b.hasSeries = true; b.series = seriesOf(*s); }
  const Value* order = v.find("order");
  if (order && order->type == Value::ARR) {
    for (const Value& r : order->arr) b.order.push_back(rowOf(r));
  }
  return b;
}

// The auto-pause input, shared by the two exports that read it.
ui::AutoPauseInput autoPauseInputOf(const Value& in) {
  ui::AutoPauseInput api;
  api.hasSession = truthy(in.find("hasSession"));
  api.raceEnded = truthy(in.find("raceEnded"));
  api.roomState = ui::roomStateOf(strField(in, "roomState"));
  api.carIds = idListOf(in.find("carIds"));
  api.aiIds = idSetOf(in.find("aiIds"));
  api.seatedIds = idSetOf(in.find("seatedIds"));
  return api;
}

}  // namespace

// ---- the catalogue -----------------------------------------------------------

int ttp_ui_configure(const char* json) {
  bool ok = false;
  Value c = json::parse(json && *json ? json : "", &ok);
  if (!ok || c.type != Value::OBJ) return 0;
  g_maxPlayers = (int) numField(c, "maxPlayers");
  g_carCount = (int) numField(c, "carCount");
  g_cups.clear();
  g_catalog.clear();
  const Value* cups = c.find("cups");
  if (cups && cups->type == Value::ARR) {
    for (const Value& v : cups->arr) {
      ui::Cup cup;
      cup.id = strField(v, "id");
      cup.name = strField(v, "name");
      const Value* tracks = v.find("tracks");
      if (tracks && tracks->type == Value::ARR) {
        for (const Value& t : tracks->arr) {
          if (t.type == Value::STR) cup.tracks.push_back(t.str);
        }
      }
      g_cups.push_back(std::move(cup));
    }
  }
  const Value* cat = c.find("catalog");
  if (cat && cat->type == Value::ARR) {
    for (const Value& v : cat->arr) {
      ui::CatalogEntry e;
      e.id = strField(v, "id");
      e.name = strField(v, "name");
      e.cup = strOf(v.find("cup"));
      e.cupDifficulty = numOf(v.find("cupDifficulty"));
      g_catalog.push_back(std::move(e));
    }
  }
  return 1;
}

// ---- screens -----------------------------------------------------------------

int ttp_ui_screen_step(const char* prevScreen, const char* nextScreen) {
  return ui::screenStep(ui::screenOf(prevScreen ? prevScreen : ""),
                        ui::screenOf(nextScreen ? nextScreen : ""));
}

const char* ttp_ui_back_effect(const char* screen) {
  return ui::key(ui::backEffect(ui::screenOf(screen ? screen : "")));
}

// ---- the lobby ---------------------------------------------------------------

const char* ttp_ui_roster_seats_json(const char* rosterJson, const char* hostIdJson) {
  const Value roster = parseOr(rosterJson, Value::Arr());
  const std::vector<ui::Seat> seats = ui::rosterSeats(rosterOf(roster),
                                                      parse_scalar_id(hostIdJson));
  Value a = Value::Arr();
  for (const ui::Seat& s : seats) {
    Value o = Value::Obj();
    o.set("name", Value::Str(s.name));
    o.set("colorIndex", Value::Num(s.colorIndex));
    o.set("carIndex", valOf(s.carIndex));
    o.set("connected", Value::Bool(s.connected));
    o.set("host", Value::Bool(s.host));
    o.set("ready", Value::Bool(s.ready));
    a.push(o);
  }
  return put(g_bufSeats, a);
}

const char* ttp_ui_seat_grid_json(const char* seatsJson) {
  const Value arr = parseOr(seatsJson, Value::Arr());
  std::vector<ui::Seat> seats;
  if (arr.type == Value::ARR) {
    for (const Value& v : arr.arr) {
      ui::Seat s;
      s.name = strField(v, "name");
      s.colorIndex = numField(v, "colorIndex");
      s.carIndex = numOf(v.find("carIndex"));
      s.connected = truthy(v.find("connected"));
      s.host = truthy(v.find("host"));
      s.ready = truthy(v.find("ready"));
      seats.push_back(std::move(s));
    }
  }
  Value a = Value::Arr();
  for (const ui::SeatCell& c : ui::seatGrid(seats, g_maxPlayers, g_carCount)) {
    Value o = Value::Obj();
    if (c.open) {
      o.set("open", Value::Bool(true));   // an open cell carries nothing else
      a.push(o);
      continue;
    }
    o.set("open", Value::Bool(false));
    o.set("name", Value::Str(c.name));
    o.set("colorIndex", Value::Num(c.colorIndex));
    o.set("carIndex", Value::Num(c.carIndex));
    o.set("modelIndex", Value::Num(c.modelIndex));
    o.set("off", Value::Bool(c.off));
    o.set("host", Value::Bool(c.host));
    o.set("ready", Value::Bool(c.ready));
    a.push(o);
  }
  return put(g_bufGrid, a);
}

int ttp_ui_all_racers_ready(const char* rosterJson, const char* hostIdJson) {
  const Value roster = parseOr(rosterJson, Value::Arr());
  return ui::allRacersReady(rosterOf(roster), parse_scalar_id(hostIdJson)) ? 1 : 0;
}

const char* ttp_ui_connected_players_json(const char* rosterJson) {
  const Value rosterV = parseOr(rosterJson, Value::Arr());
  const std::vector<ui::RosterEntry> roster = rosterOf(rosterV);
  const std::vector<const ui::RosterEntry*> kept = ui::connectedPlayers(roster);
  // Indices, not entries — the shell keeps its own objects. The rule answers
  // with pointers INTO `roster`, so subtracting the base is the index.
  Value a = Value::Arr();
  for (const ui::RosterEntry* p : kept) {
    a.push(Value::Num((double) (p - roster.data())));
  }
  return put(g_bufConnected, a);
}

const char* ttp_ui_cup_slot_json(const char* pickJson) {
  const Value in = parseOr(pickJson, Value::Obj());
  ui::CupSlot slot;
  const bool any = ui::cupSlot(ui::pickModeOf(strOf(in.find("mode"))),
                               strOf(in.find("cupId")), strOf(in.find("trackId")),
                               numOf(in.find("randomRaces")),
                               g_cups, g_catalog, slot);
  if (!any) return put(g_bufSlot, Value::Null());
  Value o = Value::Obj();
  o.set("nameKey", Value::Str(ui::key(slot.nameKey)));
  o.set("name", valOf(slot.name));
  o.set("racesKey", Value::Str(ui::key(slot.racesKey)));
  o.set("raceCount", valOf(slot.raceCount));
  o.set("difficulty", valOf(slot.difficulty));
  Value maps = Value::Arr();
  for (const ui::MapChip& m : slot.maps) {
    Value e = Value::Obj();
    e.set("trackId", valOf(m.trackId));
    if (m.n.has) e.set("n", Value::Num(m.n.v));   // only a cup numbers its minis
    maps.push(e);
  }
  o.set("maps", maps);
  o.set("cupId", valOf(slot.cupId));
  return put(g_bufSlot, o);
}

// ---- dropped-seat reconnect cards --------------------------------------------

const char* ttp_ui_reconnect_diff_json(const char* shownIdsJson, const char* seatIdsJson) {
  const Value shownV = parseOr(shownIdsJson, Value::Arr());
  const Value seatsV = parseOr(seatIdsJson, Value::Arr());
  const ui::ReconnectDiff d = ui::reconnectDiff(idListOf(&shownV), idListOf(&seatsV));
  Value o = Value::Obj();
  o.set("remove", idArray(d.remove));
  Value add = Value::Arr();
  for (size_t i : d.add) add.push(Value::Num((double) i));
  o.set("add", add);
  return put(g_bufDiff, o);
}

// ---- the ITEM push -----------------------------------------------------------

const char* ttp_ui_item_pushes_json(const char* carsJson, const char* aiIdsJson,
                                    const char* lastItemJson) {
  const Value carsV = parseOr(carsJson, Value::Arr());
  const Value aiV = parseOr(aiIdsJson, Value::Arr());
  const Value lastV = parseOr(lastItemJson, Value::Arr());

  std::vector<ui::PushCar> cars;
  if (carsV.type == Value::ARR) {
    for (const Value& c : carsV.arr) {
      ui::PushCar pc;
      pc.id = idOf(c.find("id"));
      pc.item = itemOf(c);
      pc.finished = truthy(c.find("finished"));
      cars.push_back(std::move(pc));
    }
  }
  // The shell's Map, rebuilt in ITS insertion order — re-setting an existing key
  // must not move it, which LastItems preserves.
  ui::LastItems last;
  if (lastV.type == Value::ARR) {
    for (const Value& e : lastV.arr) last.set(idOf(e.find("id")), itemOf(e));
  }
  Value a = Value::Arr();
  for (const ui::ItemPush& p : ui::itemPushes(cars, idSetOf(&aiV), last)) {
    Value o = Value::Obj();
    o.set("id", p.id.toValue());
    setItem(o, p.item);
    a.push(o);
  }
  return put(g_bufPushes, a);
}

const char* ttp_ui_welcome_item_json(const char* carJson) {
  const Value carV = parseOr(carJson, Value::Null());
  ui::PushCar car;
  const bool live = carV.type == Value::OBJ;
  if (live) {
    car.id = idOf(carV.find("id"));
    car.item = itemOf(carV);
    car.finished = truthy(carV.find("finished"));
  }
  const ui::ItemVal item = ui::welcomeItem(live ? &car : nullptr);
  // A bare value, not an object: the relight message carries `item` directly,
  // and an absent slot is null there (never a missing key — the phone reads it).
  return put(g_bufWelcome,
             item.kind == ui::ItemVal::STR ? Value::Str(item.str) : Value::Null());
}

// ---- race flow ---------------------------------------------------------------

const char* ttp_ui_race_flow_json(const char* json) {
  const Value in = parseOr(json, Value::Obj());
  const std::vector<ui::Id> carIds = idListOf(in.find("carIds"));
  const ui::IdSet ai = idSetOf(in.find("aiIds"));
  const ui::IdSet disc = idSetOf(in.find("disconnectedIds"));
  const ui::IdSet fin = idSetOf(in.find("finishedIds"));
  Value o = Value::Obj();
  o.set("allDone", Value::Bool(ui::humansAllDone(carIds, ai, disc, fin)));
  o.set("forfeit", idArray(ui::forfeitCandidates(carIds, ai, disc)));
  return put(g_bufFlow, o);
}

// ---- pause arbitration -------------------------------------------------------

int ttp_ui_can_pause(int hasSession, int paused, const char* roomState) {
  return ui::canPause(hasSession != 0, paused != 0,
                      ui::roomStateOf(roomState ? roomState : "")) ? 1 : 0;
}

int ttp_ui_can_resume(int hasSession, int paused) {
  return ui::canResume(hasSession != 0, paused != 0) ? 1 : 0;
}

int ttp_ui_auto_pause_asks(const char* json) {
  const Value in = parseOr(json, Value::Obj());
  return ui::autoPauseAsksParticipants(autoPauseInputOf(in)) ? 1 : 0;
}

const char* ttp_ui_auto_pause_json(const char* json, int allParticipantsDisconnected) {
  const Value in = parseOr(json, Value::Obj());
  const ui::AutoPauseDecision d =
      ui::autoPause(autoPauseInputOf(in), allParticipantsDisconnected != 0);
  Value o = Value::Obj();
  o.set("action", Value::Str(ui::key(d.action)));
  o.set("asked", Value::Bool(d.asked));
  if (d.hasAutoPaused) o.set("autoPaused", Value::Bool(d.autoPaused));
  return put(g_bufAutoPause, o);
}

const char* ttp_ui_freeze_transition(int paused, int autoPaused, int sessionPaused) {
  return ui::key(ui::freezeTransition(paused != 0, autoPaused != 0, sessionPaused != 0));
}

// ---- the Grand Prix chip -----------------------------------------------------

const char* ttp_ui_series_info_json(const char* json) {
  const Value in = parseOr(json, Value::Obj());
  ui::SeriesInput si;
  si.cupId = strOf(in.find("cupId"));
  si.cupName = strOf(in.find("cupName"));
  si.endless = truthy(in.find("endless"));
  si.raceIndex = numField(in, "raceIndex");
  si.raceCount = numOf(in.find("raceCount"));
  si.finished = truthy(in.find("finished"));
  si.nextTrackId = strOf(in.find("nextTrackId"));
  si.autoAdvanceMs = numField(in, "autoAdvanceMs");
  return put(g_bufSeries, seriesValue(ui::seriesInfo(si, g_catalog)));
}

// ---- the standings board -----------------------------------------------------

const char* ttp_ui_standings_json(const char* json) {
  const Value in = parseOr(json, Value::Obj());

  std::vector<ui::ResultRow> results;
  const Value* rV = in.find("results");
  if (rV && rV->type == Value::ARR) {
    for (const Value& r : rV->arr) {
      ui::ResultRow rr;
      rr.playerId = idOf(r.find("playerId"));
      rr.finished = truthy(r.find("finished"));
      rr.time = numOf(r.find("time"));
      results.push_back(std::move(rr));
    }
  }
  std::vector<ui::FieldRow> field;
  const Value* fV = in.find("field");
  if (fV && fV->type == Value::ARR) {
    for (const Value& f : fV->arr) {
      ui::FieldRow fr;
      fr.peerIndex = idOf(f.find("peerIndex"));
      fr.name = strField(f, "name");
      fr.colorIndex = numOf(f.find("colorIndex"));
      fr.ai = truthy(f.find("ai"));
      field.push_back(std::move(fr));
    }
  }
  std::vector<ui::LateJoiner> late;
  const Value* lV = in.find("lateJoiners");
  if (lV && lV->type == Value::ARR) {
    for (const Value& l : lV->arr) {
      ui::LateJoiner lj;
      lj.peerIndex = idOf(l.find("peerIndex"));
      lj.name = strField(l, "name");
      lj.colorIndex = numField(l, "colorIndex");
      late.push_back(std::move(lj));
    }
  }
  // The cup half. `standings` is held by value here and pointed at by CupBoard,
  // so it must outlive the call to standingsPayload below.
  std::vector<ui::StandingRow> standings;
  ui::CupBoard cup;
  const Value* cV = in.find("cup");
  if (cV && cV->type == Value::OBJ) {
    const Value* sV = cV->find("standings");
    if (sV && sV->type == Value::ARR) {
      for (const Value& r : sV->arr) {
        ui::StandingRow sr;
        sr.playerId = idOf(r.find("playerId"));
        sr.points = numField(r, "points");
        sr.gained = numField(r, "gained");
        standings.push_back(std::move(sr));
      }
    }
    cup.standings = &standings;
    const Value* iV = cV->find("info");
    if (iV && iV->type == Value::OBJ) cup.info = seriesOf(*iV);
  }

  const ui::Board b = ui::standingsPayload(results, field, cup.standings ? &cup : nullptr,
                                           late, idOf(in.find("hostPeerIndex")),
                                           truthy(in.find("over")));
  Value o = Value::Obj();      // over, hostPeerIndex, [series], total, order
  o.set("over", Value::Bool(b.over));
  o.set("hostPeerIndex", b.hostPeerIndex.toValue());
  if (b.hasSeries) o.set("series", seriesValue(b.series));
  o.set("total", Value::Num((double) b.total()));
  Value order = Value::Arr();
  for (const ui::BoardRow& r : b.order) order.push(rowValue(r));
  o.set("order", order);
  return put(g_bufBoard, o);
}

const char* ttp_ui_results_view_json(const char* boardJson, double intermissionMs) {
  const Value bv = parseOr(boardJson, Value::Obj());
  const ui::Board board = boardOf(bv);
  const ui::ResultsView v = ui::resultsView(board, intermissionMs);

  Value o = Value::Obj();
  o.set("podium", Value::Bool(v.podium));
  o.set("intermission", Value::Bool(v.intermission));
  o.set("titleKey", Value::Str(ui::key(v.titleKey)));
  o.set("cupName", valOf(v.cupName));
  if (v.hasSub) {
    Value sub = Value::Obj();
    sub.set("key", Value::Str(ui::key(v.subKey)));
    sub.set("cupName", valOf(v.subCupName));
    sub.set("race", Value::Num(v.subRace));
    sub.set("of", valOf(v.subOf));
    o.set("sub", sub);
  } else {
    o.set("sub", Value::Null());
  }
  if (v.hasPodiumRows) {
    Value rows = Value::Arr();
    for (const ui::BoardRow* r : v.podiumRows) rows.push(rowValue(*r));
    o.set("podiumRows", rows);
  } else {
    o.set("podiumRows", Value::Null());   // null = not a podium, not an empty list
  }
  Value list = Value::Arr();
  for (const ui::ListRow& lr : v.listRows) {
    Value row = rowValue(*lr.row);
    row.set("kind", Value::Str(ui::key(lr.kind)));
    list.push(row);
  }
  o.set("listRows", list);
  if (v.hasNext) {
    Value next = Value::Obj();
    next.set("trackName", Value::Str(v.nextTrackName));
    next.set("secs", Value::Num(v.nextSecs));
    o.set("next", next);
  } else {
    o.set("next", Value::Null());
  }
  o.set("newGameKey", Value::Str(ui::key(v.newGameKey)));
  return put(g_bufView, o);
}

double ttp_ui_intermission_secs(double deadlineMs, double nowMs) {
  return ui::intermissionSecs(deadlineMs, nowMs);
}
