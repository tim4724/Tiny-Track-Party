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
#include "ttp_error.h"
#include "ttp_ui.h"

#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/json_read.h"
#include "ttp/scalar_id.h"
#include "ttp/ui_model.h"
// The live room and the live race, through the two seams that hand over plain
// Values — this file gains no edge on libttp-party or the session registry,
// only on the shim that already links them. See ttp_room.h / ttp_session.h.
// ttp_runtime.h is here for the gp accessors the series twins gather from —
// C ABI functions of this same module, called directly.
#include "ttp_room.h"
#include "ttp_runtime.h"
#include "ttp_session.h"

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
    g_bufBoard, g_bufView, g_bufCatalogue, g_bufFlowLive, g_bufAutoLive,
    g_bufSeriesGp, g_bufBoardLive;

const char* put(std::string& buf, const Value& v) {
  ordered_stringify_into(v, buf);
  return buf.c_str();
}

// ---- Value readers -----------------------------------------------------------
// The plain ones are ttp/json_read.h, shared with every other ABI and with the
// checks that replay them; only the three that name THIS layer's option types
// are local, and they are one line each over the same shared mapping.
ui::Id idOf(const Value* v) { return json::id_of<ui::Id>(v); }
ui::OptNum numOf(const Value* v) { return json::opt_num<ui::OptNum>(v); }
ui::OptStr strOf(const Value* v) { return json::opt_str<ui::OptStr>(v); }

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
    e.name = json::str_field(p, "name");
    e.colorIndex = json::num_field(p, "colorIndex");
    e.carIndex = numOf(p.find("carIndex"));
    e.connected = json::truthy(p.find("connected"));
    e.ready = json::truthy(p.find("ready"));
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
  r.name = json::str_field(v, "name");
  r.colorIndex = json::num_field(v, "colorIndex");
  r.joining = json::truthy(v.find("joining"));
  if (r.joining) return r;
  r.ai = json::truthy(v.find("ai"));
  r.finished = json::truthy(v.find("finished"));
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
  s.endless = json::truthy(v.find("endless"));
  s.raceIndex = json::num_field(v, "raceIndex");
  s.raceCount = numOf(v.find("raceCount"));
  s.nextTrackId = strOf(v.find("nextTrackId"));
  s.nextTrackName = strOf(v.find("nextTrackName"));
  s.isFinal = json::truthy(v.find("final"));
  s.autoAdvanceMs = json::num_field(v, "autoAdvanceMs");
  return s;
}

ui::Board boardOf(const Value& v) {
  ui::Board b;
  b.over = json::truthy(v.find("over"));
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
  api.hasSession = json::truthy(in.find("hasSession"));
  api.raceEnded = json::truthy(in.find("raceEnded"));
  api.roomState = ui::roomStateOf(json::str_field(in, "roomState"));
  api.carIds = idListOf(in.find("carIds"));
  api.aiIds = idSetOf(in.find("aiIds"));
  api.seatedIds = idSetOf(in.find("seatedIds"));
  return api;
}

}  // namespace

// ---- the catalogue -----------------------------------------------------------

int ttp_ui_configure(const char* json) {
  ttp::clear_error();
  bool ok = false;
  Value c = json::parse(json && *json ? json : "", &ok);
  if (!ok || c.type != Value::OBJ) {
    ttp::set_error("ttp_ui_configure: expected a JSON object with maxPlayers and carCount, got "
                   + ttp::error_excerpt(json));
    return 0;
  }
  g_maxPlayers = (int) json::num_field(c, "maxPlayers");
  g_carCount = (int) json::num_field(c, "carCount");
  g_cups.clear();
  g_catalog.clear();
  const Value* cups = c.find("cups");
  const Value* cat = c.find("catalog");
  // NEITHER LIST GIVEN = the world this build ships. The cups, their display
  // names, the track names and the tendency rule are all codegen'd into the
  // wasm (generated/track_defs.h), so a shell that just wants the real game
  // hands over the two field sizes and stops — it does not owe this ABI ~2 KB
  // of JSON assembled out of a copy of the catalogue it would have to carry.
  //
  // Given, they OVERRIDE, and that is what the conformance corpus rides: its
  // synthetic two-cup world is exactly the case that proves ui_model.cc looks
  // ids up in whatever list it is handed rather than in the shipped one.
  //
  // Both-or-neither is deliberate. A cups list with no catalog (or the reverse)
  // is a half-configured world where one lookup resolves and its neighbour
  // misses, which is worse than either whole answer.
  if (!cups && !cat) {
    g_cups = ui::shippedCups();
    g_catalog = ui::shippedCatalog();
    return 1;
  }
  if (cups && cups->type == Value::ARR) {
    for (const Value& v : cups->arr) {
      ui::Cup cup;
      cup.id = json::str_field(v, "id");
      cup.name = json::str_field(v, "name");
      const Value* tracks = v.find("tracks");
      if (tracks && tracks->type == Value::ARR) {
        for (const Value& t : tracks->arr) {
          if (t.type == Value::STR) cup.tracks.push_back(t.str);
        }
      }
      g_cups.push_back(std::move(cup));
    }
  }
  if (cat && cat->type == Value::ARR) {
    for (const Value& v : cat->arr) {
      ui::CatalogEntry e;
      e.id = json::str_field(v, "id");
      e.name = json::str_field(v, "name");
      e.cup = strOf(v.find("cup"));
      e.cupDifficulty = numOf(v.find("cupDifficulty"));
      g_catalog.push_back(std::move(e));
    }
  }
  return 1;
}

uint32_t ttp_ui_cup_tint_rgb(const char* cupIdOrNull, double pct) {
  ui::OptStr id;
  if (cupIdOrNull && *cupIdOrNull) { id.has = true; id.v = cupIdOrNull; }
  return ui::cupTintRgb(id, pct);
}

int ttp_ui_cup_field_tint_pct(void) { return ui::cupFieldTintPct(); }

const char* ttp_ui_catalogue_json(void) {
  Value out = Value::Obj();
  Value cups = Value::Arr();
  for (const ui::Cup& c : ui::shippedCups()) {
    Value v = Value::Obj();
    v.set("id", Value::Str(c.id));
    v.set("name", Value::Str(c.name));
    Value tracks = Value::Arr();
    for (const std::string& t : c.tracks) tracks.push(Value::Str(t));
    v.set("tracks", std::move(tracks));
    // Packed 0xRRGGBB as a NUMBER, not "#RRGGBB": every shell turns it into its
    // own colour type and none of them wants to parse a string to do it. The
    // web is the exception and already has the authored table on the page.
    v.set("color", Value::Num((double) c.color));
    cups.push(std::move(v));
  }
  Value cat = Value::Arr();
  for (const ui::CatalogEntry& e : ui::shippedCatalog()) {
    Value v = Value::Obj();
    v.set("id", Value::Str(e.id));
    v.set("name", Value::Str(e.name));
    v.set("cup", e.cup.has ? Value::Str(e.cup.v) : Value::Null());
    v.set("cupDifficulty", e.cupDifficulty.has ? Value::Num(e.cupDifficulty.v) : Value::Null());
    cat.push(std::move(v));
  }
  out.set("cups", std::move(cups));
  out.set("catalog", std::move(cat));
  return put(g_bufCatalogue, out);
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

// Shared by both spellings below, so the room-backed one cannot drift into a
// second seat encoder.
static const char* putSeats(const Value& roster, const char* hostIdJson) {
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

const char* ttp_ui_roster_seats_json(const char* rosterJson, const char* hostIdJson) {
  return putSeats(json::parse_or(rosterJson, Value::Arr()), hostIdJson);
}

const char* ttp_ui_roster_seats_room_json(int roomHandle, const char* hostIdJson) {
  return putSeats(ttp_room_roster_value(roomHandle), hostIdJson);
}

const char* ttp_ui_seat_grid_json(const char* seatsJson) {
  const Value arr = json::parse_or(seatsJson, Value::Arr());
  std::vector<ui::Seat> seats;
  if (arr.type == Value::ARR) {
    for (const Value& v : arr.arr) {
      ui::Seat s;
      s.name = json::str_field(v, "name");
      s.colorIndex = json::num_field(v, "colorIndex");
      s.carIndex = numOf(v.find("carIndex"));
      s.connected = json::truthy(v.find("connected"));
      s.host = json::truthy(v.find("host"));
      s.ready = json::truthy(v.find("ready"));
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
  const Value roster = json::parse_or(rosterJson, Value::Arr());
  return ui::allRacersReady(rosterOf(roster), parse_scalar_id(hostIdJson)) ? 1 : 0;
}

const char* ttp_ui_connected_players_json(const char* rosterJson) {
  const Value rosterV = json::parse_or(rosterJson, Value::Arr());
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
  const Value in = json::parse_or(pickJson, Value::Obj());
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
  const Value shownV = json::parse_or(shownIdsJson, Value::Arr());
  const Value seatsV = json::parse_or(seatIdsJson, Value::Arr());
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
  const Value carsV = json::parse_or(carsJson, Value::Arr());
  const Value aiV = json::parse_or(aiIdsJson, Value::Arr());
  const Value lastV = json::parse_or(lastItemJson, Value::Arr());

  std::vector<ui::PushCar> cars;
  if (carsV.type == Value::ARR) {
    for (const Value& c : carsV.arr) {
      ui::PushCar pc;
      pc.id = idOf(c.find("id"));
      pc.item = itemOf(c);
      pc.finished = json::truthy(c.find("finished"));
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
  const Value carV = json::parse_or(carJson, Value::Null());
  ui::PushCar car;
  const bool live = carV.type == Value::OBJ;
  if (live) {
    car.id = idOf(carV.find("id"));
    car.item = itemOf(carV);
    car.finished = json::truthy(carV.find("finished"));
  }
  const ui::ItemVal item = ui::welcomeItem(live ? &car : nullptr);
  // A bare value, not an object: the relight message carries `item` directly,
  // and an absent slot is null there (never a missing key — the phone reads it).
  return put(g_bufWelcome,
             item.kind == ui::ItemVal::STR ? Value::Str(item.str) : Value::Null());
}

// ---- race flow ---------------------------------------------------------------

// Shared by the JSON form (the conformance surface) and the live twin below, so
// the two can only ever differ in how the role sets were GATHERED — which is
// exactly the part abi_check holds them to.
static Value raceFlowValue(const std::vector<ui::Id>& carIds, const ui::IdSet& ai,
                           const ui::IdSet& disc, const ui::IdSet& fin) {
  Value o = Value::Obj();
  o.set("allDone", Value::Bool(ui::humansAllDone(carIds, ai, disc, fin)));
  o.set("forfeit", idArray(ui::forfeitCandidates(carIds, ai, disc)));
  return o;
}

const char* ttp_ui_race_flow_json(const char* json) {
  const Value in = json::parse_or(json, Value::Obj());
  return put(g_bufFlow, raceFlowValue(idListOf(in.find("carIds")),
                                      idSetOf(in.find("aiIds")),
                                      idSetOf(in.find("disconnectedIds")),
                                      idSetOf(in.find("finishedIds"))));
}

// The set of `ids[i]` whose parallel `flags[i]` is true — how a seam's
// per-id answer becomes a role set.
static ui::IdSet idSetWhere(const Value& ids, const Value& flags) {
  ui::IdSet s;
  if (ids.type == Value::ARR && flags.type == Value::ARR)
    for (size_t i = 0; i < ids.arr.size() && i < flags.arr.size(); ++i)
      if (flags.arr[i].type == Value::BOOL && flags.arr[i].b)
        s.add(idOf(&ids.arr[i]));
  return s;
}

const char* ttp_ui_race_flow_live_json(int sessionHandle, int roomHandle) {
  const Value carIdsV = ttp_session_car_ids(sessionHandle);
  const Value aiV = ttp_session_ai_ids(sessionHandle);
  const Value finV = ttp_session_finished_flags(sessionHandle, carIdsV);
  const Value discV = ttp_room_disconnected_flags(roomHandle, carIdsV);
  return put(g_bufFlowLive, raceFlowValue(idListOf(&carIdsV), idSetOf(&aiV),
                                          idSetWhere(carIdsV, discV),
                                          idSetWhere(carIdsV, finV)));
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
  const Value in = json::parse_or(json, Value::Obj());
  return ui::autoPauseAsksParticipants(autoPauseInputOf(in)) ? 1 : 0;
}

static Value autoPauseValue(const ui::AutoPauseInput& in, bool allParticipantsDisconnected) {
  const ui::AutoPauseDecision d = ui::autoPause(in, allParticipantsDisconnected);
  Value o = Value::Obj();
  o.set("action", Value::Str(ui::key(d.action)));
  o.set("asked", Value::Bool(d.asked));
  if (d.hasAutoPaused) o.set("autoPaused", Value::Bool(d.autoPaused));
  return o;
}

const char* ttp_ui_auto_pause_json(const char* json, int allParticipantsDisconnected) {
  const Value in = json::parse_or(json, Value::Obj());
  return put(g_bufAutoPause, autoPauseValue(autoPauseInputOf(in),
                                            allParticipantsDisconnected != 0));
}

const char* ttp_ui_auto_pause_live_json(int sessionHandle, int roomHandle, int raceEnded) {
  ui::AutoPauseInput in;
  in.hasSession = ttp_session_engine(sessionHandle) != nullptr;
  in.raceEnded = raceEnded != 0;
  in.roomState = ui::roomStateOf(ttp_room_state_name(roomHandle));
  const Value carIdsV = ttp_session_car_ids(sessionHandle);
  in.carIds = idListOf(&carIdsV);
  const Value aiV = ttp_session_ai_ids(sessionHandle);
  in.aiIds = idSetOf(&aiV);
  // A human at the wheel, or a held seat with its QR up.
  in.seatedIds = idSetWhere(carIdsV, ttp_room_has_flags(roomHandle, carIdsV));
  // The party layer's answer is read THROUGH THE SYNCED SEAM and only when the
  // decision consults it — the two rules the shell used to hold (Net.js pushed
  // the live car set in first; refreshAutoPause asked `asks` before reading).
  const bool allDisc = ui::autoPauseAsksParticipants(in) &&
      ttp_room_all_participants_disconnected_synced(roomHandle, sessionHandle) != 0;
  return put(g_bufAutoLive, autoPauseValue(in, allDisc));
}

const char* ttp_ui_freeze_transition(int paused, int autoPaused, int sessionPaused) {
  return ui::key(ui::freezeTransition(paused != 0, autoPaused != 0, sessionPaused != 0));
}

// ---- the Grand Prix chip -----------------------------------------------------

const char* ttp_ui_series_info_json(const char* json) {
  const Value in = json::parse_or(json, Value::Obj());
  ui::SeriesInput si;
  si.cupId = strOf(in.find("cupId"));
  si.cupName = strOf(in.find("cupName"));
  si.endless = json::truthy(in.find("endless"));
  si.raceIndex = json::num_field(in, "raceIndex");
  si.raceCount = numOf(in.find("raceCount"));
  si.finished = json::truthy(in.find("finished"));
  si.nextTrackId = strOf(in.find("nextTrackId"));
  si.autoAdvanceMs = json::num_field(in, "autoAdvanceMs");
  return put(g_bufSeries, seriesValue(ui::seriesInfo(si, g_catalog)));
}

// The chip's input off a live series handle — the gather the shell (and the
// tvOS twin, wrongly) used to spell. Field-for-field what main.js's
// seriesInfo() read off NativeCupSeries' getters, including "" spelling null
// for the next track.
static ui::SeriesInput seriesInputOfGp(int gpHandle, double autoAdvanceMs) {
  ui::SeriesInput si;
  const Value cup = json::parse_or(ttp_gp_cup_json(gpHandle), Value::Obj());
  si.cupId = strOf(cup.find("id"));
  si.cupName = strOf(cup.find("name"));
  si.endless = ttp_gp_endless(gpHandle) != 0;
  si.raceIndex = ttp_gp_race_index(gpHandle);
  si.raceCount = ui::OptNum::Of(ttp_gp_race_count(gpHandle));
  si.finished = ttp_gp_finished(gpHandle) != 0;
  const char* next = ttp_gp_next_track(gpHandle);
  if (next && next[0] != '\0') si.nextTrackId = ui::OptStr::Of(next);
  si.autoAdvanceMs = autoAdvanceMs;
  return si;
}

const char* ttp_ui_series_info_gp_json(int gpHandle, double autoAdvanceMs) {
  if (!gpHandle) return put(g_bufSeriesGp, Value::Null());
  return put(g_bufSeriesGp,
             seriesValue(ui::seriesInfo(seriesInputOfGp(gpHandle, autoAdvanceMs), g_catalog)));
}

// ---- the standings board -----------------------------------------------------

// The four row parses, shared by the JSON form and the live twin (whose seam
// Values carry the same shapes the JS assembly did).
static std::vector<ui::ResultRow> resultRowsOf(const Value* rV) {
  std::vector<ui::ResultRow> results;
  if (rV && rV->type == Value::ARR) {
    for (const Value& r : rV->arr) {
      ui::ResultRow rr;
      rr.playerId = idOf(r.find("playerId"));
      rr.finished = json::truthy(r.find("finished"));
      rr.time = numOf(r.find("time"));
      results.push_back(std::move(rr));
    }
  }
  return results;
}
static std::vector<ui::FieldRow> fieldRowsOf(const Value* fV) {
  std::vector<ui::FieldRow> field;
  if (fV && fV->type == Value::ARR) {
    for (const Value& f : fV->arr) {
      ui::FieldRow fr;
      fr.peerIndex = idOf(f.find("peerIndex"));
      fr.name = json::str_field(f, "name");
      fr.colorIndex = numOf(f.find("colorIndex"));
      fr.ai = json::truthy(f.find("ai"));
      field.push_back(std::move(fr));
    }
  }
  return field;
}
static std::vector<ui::LateJoiner> lateRowsOf(const Value* lV) {
  std::vector<ui::LateJoiner> late;
  if (lV && lV->type == Value::ARR) {
    for (const Value& l : lV->arr) {
      ui::LateJoiner lj;
      lj.peerIndex = idOf(l.find("peerIndex"));
      lj.name = json::str_field(l, "name");
      lj.colorIndex = json::num_field(l, "colorIndex");
      late.push_back(std::move(lj));
    }
  }
  return late;
}
static std::vector<ui::StandingRow> standingRowsOf(const Value* sV) {
  std::vector<ui::StandingRow> standings;
  if (sV && sV->type == Value::ARR) {
    for (const Value& r : sV->arr) {
      ui::StandingRow sr;
      sr.playerId = idOf(r.find("playerId"));
      sr.points = json::num_field(r, "points");
      sr.gained = json::num_field(r, "gained");
      standings.push_back(std::move(sr));
    }
  }
  return standings;
}

static Value boardValue(const ui::Board& b) {
  Value o = Value::Obj();      // over, hostPeerIndex, [series], total, order
  o.set("over", Value::Bool(b.over));
  o.set("hostPeerIndex", b.hostPeerIndex.toValue());
  if (b.hasSeries) o.set("series", seriesValue(b.series));
  o.set("total", Value::Num((double) b.total()));
  Value order = Value::Arr();
  for (const ui::BoardRow& r : b.order) order.push(rowValue(r));
  o.set("order", order);
  return o;
}

const char* ttp_ui_standings_json(const char* json) {
  const Value in = json::parse_or(json, Value::Obj());

  const std::vector<ui::ResultRow> results = resultRowsOf(in.find("results"));
  const std::vector<ui::FieldRow> field = fieldRowsOf(in.find("field"));
  const std::vector<ui::LateJoiner> late = lateRowsOf(in.find("lateJoiners"));

  // The cup half. `standings` is held by value here and pointed at by CupBoard,
  // so it must outlive the call to standingsPayload below.
  std::vector<ui::StandingRow> standings;
  ui::CupBoard cup;
  const Value* cV = in.find("cup");
  if (cV && cV->type == Value::OBJ) {
    standings = standingRowsOf(cV->find("standings"));
    cup.standings = &standings;
    const Value* iV = cV->find("info");
    if (iV && iV->type == Value::OBJ) cup.info = seriesOf(*iV);
  }

  const ui::Board b = ui::standingsPayload(results, field, cup.standings ? &cup : nullptr,
                                           late, idOf(in.find("hostPeerIndex")),
                                           json::truthy(in.find("over")));
  return put(g_bufBoard, boardValue(b));
}

const char* ttp_ui_standings_live_json(int sessionHandle, int roomHandle, int gpHandle,
                                       int over, const char* fieldJson,
                                       const char* resultsJsonOrNull, double autoAdvanceMs) {
  // endRace's own results object when the caller holds one (no effect can
  // carry it), else the live session's — broadcastStandings' either-or.
  Value resultsObj = json::parse_or(resultsJsonOrNull ? resultsJsonOrNull : "null",
                                    Value::Null());
  const Value rowsV = resultsObj.type == Value::OBJ && resultsObj.find("results")
      ? *resultsObj.find("results")
      : ttp_session_results_rows(sessionHandle);
  const std::vector<ui::ResultRow> results = resultRowsOf(&rowsV);

  const Value fieldV = json::parse_or(fieldJson, Value::Arr());
  const std::vector<ui::FieldRow> field = fieldRowsOf(&fieldV);

  const Value lateV = ttp_room_late_joiners_synced(roomHandle, sessionHandle);
  const std::vector<ui::LateJoiner> late = lateRowsOf(&lateV);

  // The cup half is composed HERE — one `cup` object holding standings + info,
  // the nesting a shell used to get wrong.
  std::vector<ui::StandingRow> standings;
  ui::CupBoard cup;
  if (gpHandle) {
    const Value standingsV = json::parse_or(ttp_gp_standings_json(gpHandle), Value::Arr());
    standings = standingRowsOf(&standingsV);
    cup.standings = &standings;
    cup.info = ui::seriesInfo(seriesInputOfGp(gpHandle, autoAdvanceMs), g_catalog);
  }

  const Value hostV = ttp_room_host_value(roomHandle);
  const ui::Board b = ui::standingsPayload(results, field, cup.standings ? &cup : nullptr,
                                           late, idOf(&hostV), over != 0);
  return put(g_bufBoardLive, boardValue(b));
}

const char* ttp_ui_results_view_json(const char* boardJson, double intermissionMs) {
  const Value bv = json::parse_or(boardJson, Value::Obj());
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
