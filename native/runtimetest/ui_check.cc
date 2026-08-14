// ui_check — the C++ UI MODEL against the JS it was ported from
// (tests/fixtures/ui-corpus.jsonl, recorded by scripts/gen-ui-corpus.mjs off
// public/display/uiModel.js).
//
// WHAT THIS IS. JS-RECORDED cross-implementation evidence — class 1 in
// tests/fixtures/traces/README.md, the only class that can settle a parity
// question. Every step in it is an answer the shipping browser game drew a
// screen from. Nothing here may be "fixed" by re-recording: a disagreement is a
// bug in libttp-runtime/ttp/ui_model.cc, never in the corpus.
//
// WHAT IT REPLAYS: all of it. 37 scenarios, 1559 steps, every one of the
// thirteen op kinds, and for each step BOTH the model's answer (`out`) and the
// shell state the driver threads through it (`state` — the current screen, the
// reconnect cards actually on screen, and what each phone was last told its
// item was). The state is checked because three rules are only correct IN
// SEQUENCE: the reconnect diff against a shown set that a failed attach left
// behind, the ITEM push against a Map that is per-race and insertion-ordered,
// and the screen step against wherever the last `show` left the shell.
//
// `hud` steps carry two answers and only one of them is new here: `rows` is
// hudRows, ported in P6 and already replayed by runtimetest/hud_check.cc. It is
// rebuilt here too, through the SAME ttp::rt::hudSlot — not a second
// implementation — because the scenario replay would otherwise skip the op that
// drives `lastItem`, and a `pushes` check with no `rows` check beside it would
// silently accept a step whose cars were misread.
//
// THE BOARD'S KEY ORDER. `out.wire` is the recorded JSON.stringify of the
// standings payload — INSERTION order, the bytes the phones receive. The
// structural diff cannot see that (it sorts keys, as canonical JSON must), so
// the board is rebuilt in the JS's own key order and serialized with
// ordered_stringify — libttp-json's second emitter, which shares its whole walk
// with canonical_stringify and differs only in not sorting. That is also what
// runtime/ttp_ui.cc emits with, so this check pins the exact bytes the shipping
// ABI hands a shell. canonical_stringify keeps the sort and its evidence-only
// job; it must not grow a mode.
//
// THE SYNTHETIC WORLD COMES OUT OF THE CORPUS. The model is catalogue-AGNOSTIC
// — it looks cups and tracks up in whatever list it is handed — so the generator
// carries its own two cups and nine circuits rather than binding the oracle to
// shared/tracks.js, and it WRITES THAT WORLD INTO THE HEADER LINE. This check
// reads it from there and transcribes nothing: editing a number in
// gen-ui-corpus.mjs must not be able to leave a replayer configured for a world
// the recorded answers were never produced in. (It used to be hand-copied here,
// and again in abi_check.cc; a third copy arrived with the next ABI, which is
// the drift this shape removes. tests/fixtures/traces/README.md states the rule.)
//
// Usage: ui_check <ui-corpus.jsonl>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

#include "corpus_diff.h"
#include "corpus_record.h"
#include "ttp/game.h"        // ITEM_IDS — the sim's own roll table
#include "ttp/hud.h"         // hudSlot — the P6 half of this same JS module
#include "ttp/json_read.h"   // the shared field readers every ABI marshals with
#include "ttp/protocol.h"    // ROOM_STATE — the vocabulary ui_model.h mirrors
#include "ttp/ui_model.h"

using namespace ttp;
using namespace ttp::corpus;
namespace ui = ttp::rt::ui;

namespace {

int cases = 0, passed = 0, spew = 0;

void report(const std::string& what, const Diff& d) {
  cases++;
  if (!d.differ) {
    passed++;
    return;
  }
  if (spew++ < 20) {
    std::fprintf(stderr, "FAIL %s\n  path %s\n  expected %s\n  actual   %s\n",
                 what.c_str(), d.path.c_str(), d.expected.c_str(), d.actual.c_str());
  }
}

// ---- the generator's synthetic world ----------------------------------------
// Read from the corpus header, never transcribed — see the note up top. The
// world is line 1's `world` object: gen-ui-corpus.mjs's CUPS / CATALOG /
// MAX_PLAYERS / CAR_COUNT / INTERMISSION_MS, verbatim. (cup-empty has no
// circuits and `solo` is in no cup: between them they reach every arm of the
// lookups — cup -> its races, track -> its cup + difficulty, an id in no cup,
// an id in no catalogue.)
struct World {
  int maxPlayers = 0;
  int carCount = 0;
  double intermissionMs = 0;
  std::vector<ui::Cup> cups;
  std::vector<ui::CatalogEntry> catalog;
};

// One per process, because the replay reaches for it from every op. Filled from
// the header before step 1; a corpus without one is refused rather than replayed
// into an empty catalogue, which would diff loudly but blame the wrong side.
World g_world;

// ---- Value <-> the model's plain types ---------------------------------------

// The three that name this layer's option types; everything else a corpus field
// needs read out of it is ttp/json_read.h, shared with runtime/ttp_ui.cc and
// every other replayer.
ui::Id idOf(const Value* v) { return json::id_of<ui::Id>(v); }
ui::OptNum numOf(const Value* v) { return json::opt_num<ui::OptNum>(v); }
ui::OptStr strOf(const Value* v) { return json::opt_str<ui::OptStr>(v); }

Value valOf(const ui::OptNum& n) { return n.has ? Value::Num(n.v) : Value::Null(); }
Value valOf(const ui::OptStr& s) { return s.has ? Value::Str(s.v) : Value::Null(); }

// ---- the header's world, into the model's types ------------------------------
// The one place this check learns what it is replaying against. `cupName` rides
// the catalogue in the fixture but is not a CatalogEntry field — the model
// derives a cup's name from the cup list — so it is read and dropped here.
bool loadWorld(const Value& header, World& w) {
  const Value* kind = header.find("kind");
  if (!kind || kind->type != Value::STR || kind->str != "ui") {
    std::fprintf(stderr, "not a ui corpus: no {kind:'ui'} header\n");
    return false;
  }
  const Value* wv = header.find("world");
  if (!json::is_obj(wv)) {
    // NOT "regenerate it": this corpus is FROZEN — gen-ui-corpus.mjs went with
    // uiModel.js — so a header without a world means the fixture was damaged,
    // and the fix is git, not a generator.
    std::fprintf(stderr,
                 "the ui corpus header carries no `world`, and this check has no "
                 "world of its own to fall back on. The corpus is FROZEN (its "
                 "generator was deleted with its oracle), so restore it rather "
                 "than re-deriving it: git checkout -- tests/fixtures/ui-corpus.jsonl\n");
    return false;
  }
  w.maxPlayers = (int) json::num_field(*wv, "maxPlayers");
  w.carCount = (int) json::num_field(*wv, "carCount");
  w.intermissionMs = json::num_field(*wv, "intermissionMs");

  const Value* cups = wv->find("cups");
  if (cups && cups->type == Value::ARR) {
    for (const Value& c : cups->arr) {
      ui::Cup cup;
      cup.id = json::str_field(c, "id");
      cup.name = json::str_field(c, "name");
      const Value* tracks = c.find("tracks");
      if (tracks && tracks->type == Value::ARR) {
        for (const Value& t : tracks->arr) {
          if (t.type == Value::STR) cup.tracks.push_back(t.str);
        }
      }
      w.cups.push_back(std::move(cup));
    }
  }
  const Value* cat = wv->find("catalog");
  if (cat && cat->type == Value::ARR) {
    for (const Value& e : cat->arr) {
      ui::CatalogEntry row;
      row.id = json::str_field(e, "id");
      row.name = json::str_field(e, "name");
      row.cup = strOf(e.find("cup"));
      row.cupDifficulty = numOf(e.find("cupDifficulty"));
      w.catalog.push_back(std::move(row));
    }
  }
  if (w.maxPlayers <= 0 || w.carCount <= 0 || w.cups.empty() || w.catalog.empty()) {
    std::fprintf(stderr, "the corpus header's `world` is not a world "
                         "(maxPlayers/carCount/cups/catalog)\n");
    return false;
  }
  return true;
}

// The item as JS spells it: undefined is a MISSING KEY (JSON.stringify drops
// it), and that is a real recorded push.
void setItem(Value& o, const char* k, const ui::ItemVal& item) {
  if (item.kind == ui::ItemVal::ABSENT) return;
  o.set(k, item.kind == ui::ItemVal::NUL ? Value::Null() : Value::Str(item.str));
}
ui::ItemVal itemOf(const Value& car, const char* k = "item") {
  const Value* v = car.find(k);
  if (!v) return ui::ItemVal::Absent();
  if (v->type == Value::STR) return ui::ItemVal::Str(v->str);
  return ui::ItemVal::Null();
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

// The wire bytes: JSON.stringify in INSERTION order. Values are built below in
// the JS literal's own key order, so walking them unsorted reproduces the
// phones' bytes exactly.
std::string wire(const Value& v) { return ordered_stringify(v); }

// ---- the shell state a scenario threads --------------------------------------
// Exactly what main.js owns beside the model, and what gen-ui-corpus.mjs's
// newShellState() records after every step.
struct Shell {
  bool hasScreen = false;
  std::string screenName;       // the RAW name, so an unknown board round-trips
  ui::Screen screen = ui::Screen::UNKNOWN;
  std::vector<ui::Id> shown;    // reconnect cards actually on screen
  ui::LastItems lastItem;       // what each phone was last told

  void reset(const Value* screenV) {
    hasScreen = screenV && screenV->type == Value::STR;
    screenName = hasScreen ? screenV->str : std::string();
    screen = hasScreen ? ui::screenOf(screenName) : ui::Screen::UNKNOWN;
    shown.clear();
    lastItem.clear();
  }
  Value toValue() const {
    Value o = Value::Obj();
    o.set("screen", hasScreen ? Value::Str(screenName) : Value::Null());
    o.set("shown", idArray(shown));
    Value items = Value::Arr();
    for (const auto& kv : lastItem.entries()) {
      Value e = Value::Obj();
      e.set("id", kv.first.toValue());
      // The driver records undefined as null here; the MAP still holds the
      // distinction, which is what the next push compares against.
      e.set("item", kv.second.kind == ui::ItemVal::STR ? Value::Str(kv.second.str)
                                                       : Value::Null());
      items.push(e);
    }
    o.set("lastItem", items);
    return o;
  }
};

// ---- per-op replay -----------------------------------------------------------

std::vector<ui::RosterEntry> rosterOf(const Value* arr) {
  std::vector<ui::RosterEntry> out;
  if (!arr || arr->type != Value::ARR) return out;
  for (const Value& p : arr->arr) {
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

Value seatsValue(const std::vector<ui::Seat>& seats) {
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
  return a;
}

Value gridValue(const std::vector<ui::SeatCell>& grid) {
  Value a = Value::Arr();
  for (const ui::SeatCell& c : grid) {
    Value o = Value::Obj();
    if (c.open) {
      o.set("open", Value::Bool(true));
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
  return a;
}

Value slotValue(const ui::CupSlot& s) {
  Value o = Value::Obj();
  o.set("nameKey", Value::Str(ui::key(s.nameKey)));
  o.set("name", valOf(s.name));
  o.set("racesKey", Value::Str(ui::key(s.racesKey)));
  o.set("raceCount", valOf(s.raceCount));
  o.set("difficulty", valOf(s.difficulty));
  Value maps = Value::Arr();
  for (const ui::MapChip& m : s.maps) {
    Value e = Value::Obj();
    e.set("trackId", valOf(m.trackId));
    if (m.n.has) e.set("n", Value::Num(m.n.v));
    maps.push(e);
  }
  o.set("maps", maps);
  o.set("cupId", valOf(s.cupId));
  return o;
}

// hudRows' recorded row, rebuilt from the packed slot the P6 port answers with.
// Identical to hud_check.cc's rowOf, and for the same reason: the port emits no
// id (a slot IS its identity), so copying the input car's across asserts that
// row i is car i.
Value itemValue(int32_t code) {
  if (code == TTP_ITEM_NONE) return Value::Null();
  if (code >= 1 && code <= 4) return Value::Str(ITEM_IDS[code - 1]);
  return Value::Str("<unknown item code>");
}
Value hudRowValue(const Value& car) {
  const Value* ft = car.find("finishTime");
  const bool timed = ft && ft->type == Value::NUM;
  const ui::ItemVal item = itemOf(car);
  const TtpHudSlot s = rt::hudSlot(
      (int32_t) json::num_field(car, "position"), (int32_t) json::num_field(car, "lap"),
      (int32_t) json::num_field(car, "totalLaps"),
      item.kind == ui::ItemVal::STR ? item.str : std::string(),
      json::truthy(car.find("finished")), timed, timed ? ft->num : 0.0);
  Value o = Value::Obj();
  const Value* id = car.find("id");
  o.set("id", id ? *id : Value::Null());
  o.set("position", Value::Num((double) s.place));
  o.set("lap", Value::Num((double) s.lap));
  o.set("totalLaps", Value::Num((double) s.totalLaps));
  o.set("item", itemValue(s.item));
  o.set("finished", Value::Bool((s.flags & TTP_HUD_SLOT_FINISHED) != 0));
  o.set("finishTime", (s.flags & TTP_HUD_SLOT_TIMED) ? Value::Num(s.finishTime)
                                                     : Value::Null());
  return o;
}

ui::SeriesInfo seriesFrom(const Value& s, const std::vector<ui::CatalogEntry>& catalog) {
  ui::SeriesInput in;
  in.cupId = strOf(s.find("cupId"));
  in.cupName = strOf(s.find("cupName"));
  in.endless = json::truthy(s.find("endless"));
  in.raceIndex = json::num_field(s, "raceIndex");
  in.raceCount = numOf(s.find("raceCount"));
  in.finished = json::truthy(s.find("finished"));
  in.nextTrackId = strOf(s.find("nextTrackId"));
  in.autoAdvanceMs = g_world.intermissionMs;
  return ui::seriesInfo(in, catalog);
}

Value seriesValue(const ui::SeriesInfo& s) {
  Value o = Value::Obj();   // seriesInfo's literal order — part of `wire`
  o.set("cupId", valOf(s.cupId));
  o.set("cupName", valOf(s.cupName));
  o.set("endless", Value::Bool(s.endless));
  o.set("raceIndex", Value::Num(s.raceIndex));
  o.set("raceCount", valOf(s.raceCount));
  o.set("nextTrackId", valOf(s.nextTrackId));
  o.set("nextTrackName", valOf(s.nextTrackName));
  o.set("final", Value::Bool(s.isFinal));
  o.set("autoAdvanceMs", Value::Num(s.autoAdvanceMs));
  return o;
}

Value rowValue(const ui::BoardRow& r) {
  Value o = Value::Obj();   // standingsPayload's literal order — part of `wire`
  o.set("playerId", r.playerId.toValue());
  o.set("name", Value::Str(r.name));
  o.set("colorIndex", Value::Num(r.colorIndex));
  if (r.joining) {
    o.set("joining", Value::Bool(true));
    return o;
  }
  o.set("ai", Value::Bool(r.ai));
  o.set("finished", Value::Bool(r.finished));
  o.set("time", valOf(r.time));
  o.set("racePlace", Value::Num(r.racePlace));
  if (r.hasPoints) o.set("points", Value::Num(r.points));
  if (r.hasGained) o.set("gained", Value::Num(r.gained));
  return o;
}

// A results-view phase: the board row plus what this phase says about it.
Value listValue(const std::vector<ui::ListRow>& rows) {
  Value out = Value::Arr();
  for (const ui::ListRow& lr : rows) {
    Value row = rowValue(*lr.row);
    row.set("kind", Value::Str(ui::key(lr.kind)));
    // On BOTH cup kinds: the race phase DISPLAYS this total and the standings
    // phase counts up from it, so it is the row's starting value either way.
    if (lr.kind == ui::RowKind::POINTS || lr.kind == ui::RowKind::TIME_GAIN)
      row.set("pointsBefore", Value::Num(lr.pointsBefore));
    if (lr.medal) row.set("medal", Value::Num(lr.medal));
    out.push(row);
  }
  return out;
}

Value boardValue(const ui::Board& b) {
  Value o = Value::Obj();   // over, hostPeerIndex, [series], total, order
  o.set("over", Value::Bool(b.over));
  o.set("hostPeerIndex", b.hostPeerIndex.toValue());
  if (b.hasSeries) o.set("series", seriesValue(b.series));
  o.set("total", Value::Num((double) b.total()));
  Value order = Value::Arr();
  for (const ui::BoardRow& r : b.order) order.push(rowValue(r));
  o.set("order", order);
  return o;
}

Value viewValue(const ui::ResultsView& v) {
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
  o.set("twoPhase", Value::Bool(v.twoPhase));
  o.set("raceTitleKey", Value::Str(ui::key(v.raceTitleKey)));
  o.set("raceRows", listValue(v.raceRows));
  o.set("listRows", listValue(v.listRows));
  o.set("racePhaseMs", Value::Num(v.racePhaseMs));
  if (v.hasNext) {
    Value next = Value::Obj();
    next.set("trackName", Value::Str(v.nextTrackName));
    next.set("secs", Value::Num(v.nextSecs));
    o.set("next", next);
  } else {
    o.set("next", Value::Null());
  }
  o.set("newGameKey", Value::Str(ui::key(v.newGameKey)));
  return o;
}

// One step: run the op, mutate the shell, return the `out` the corpus records.
Value applyOp(Shell& st, const std::string& op, const Value& in) {
  const std::vector<ui::Cup>& cups = g_world.cups;
  const std::vector<ui::CatalogEntry>& catalog = g_world.catalog;
  Value out = Value::Obj();

  if (op == "show") {
    const Value* to = in.find("to");
    const std::string name = (to && to->type == Value::STR) ? to->str : std::string();
    const int step = ui::screenStep(st.screen, ui::screenOf(name));
    st.hasScreen = to && to->type == Value::STR;
    st.screenName = name;
    st.screen = ui::screenOf(name);
    out.set("step", Value::Num(step));
    out.set("nav", Value::Str(step > 0 ? "push" : step < 0 ? "pop" : "none"));
    return out;
  }
  if (op == "back") {
    out.set("effect", Value::Str(ui::key(ui::backEffect(st.screen))));
    return out;
  }
  if (op == "roster") {
    const std::vector<ui::RosterEntry> roster = rosterOf(in.find("roster"));
    const ui::Id host = idOf(in.find("host"));
    const std::vector<ui::Seat> seats = ui::rosterSeats(roster, host);
    out.set("seats", seatsValue(seats));
    out.set("grid", gridValue(ui::seatGrid(seats, g_world.maxPlayers, g_world.carCount)));
    out.set("ready", Value::Bool(ui::allRacersReady(roster, host)));
    Value conn = Value::Arr();
    for (const ui::RosterEntry* p : ui::connectedPlayers(roster)) conn.push(p->peerIndex.toValue());
    out.set("connected", conn);
    return out;
  }
  if (op == "pick") {
    const ui::OptStr mode = strOf(in.find("mode"));
    ui::CupSlot slot;
    const bool any = ui::cupSlot(ui::pickModeOf(mode), strOf(in.find("cupId")),
                                 strOf(in.find("trackId")), numOf(in.find("randomRaces")),
                                 cups, catalog, slot);
    out.set("slot", any ? slotValue(slot) : Value::Null());
    return out;
  }
  if (op == "reconnect") {
    const Value* seatsV = in.find("seats");
    std::vector<ui::Id> seatIds;
    if (seatsV && seatsV->type == Value::ARR) {
      for (const Value& s : seatsV->arr) seatIds.push_back(idOf(s.find("peerIndex")));
    }
    const ui::ReconnectDiff d = ui::reconnectDiff(st.shown, seatIds);
    // The shell keeps the shown set because putting a card up can FAIL; `land`
    // names the added seats whose card actually attached (absent = all land).
    const Value* land = in.find("land");
    const auto landed = [&land](const ui::Id& id) {
      if (!land || land->type != Value::ARR) return true;
      for (const Value& e : land->arr) if (idOf(&e) == id) return true;
      return false;
    };
    std::vector<ui::Id> kept;
    for (const ui::Id& id : st.shown) {
      bool removed = false;
      for (const ui::Id& r : d.remove) if (r == id) { removed = true; break; }
      if (!removed) kept.push_back(id);
    }
    st.shown = kept;
    Value add = Value::Arr();
    for (size_t i : d.add) {
      add.push(seatIds[i].toValue());
      if (landed(seatIds[i])) st.shown.push_back(seatIds[i]);
    }
    out.set("remove", idArray(d.remove));
    out.set("add", add);
    return out;
  }
  if (op == "hud") {
    const Value* carsV = in.find("cars");
    const ui::IdSet ai = idSetOf(in.find("aiIds"));
    std::vector<ui::PushCar> cars;
    Value rows = Value::Arr();
    if (carsV && carsV->type == Value::ARR) {
      for (const Value& c : carsV->arr) {
        rows.push(hudRowValue(c));
        ui::PushCar pc;
        pc.id = idOf(c.find("id"));
        pc.item = itemOf(c);
        pc.finished = json::truthy(c.find("finished"));
        cars.push_back(std::move(pc));
      }
    }
    const std::vector<ui::ItemPush> pushes = ui::itemPushes(cars, ai, st.lastItem);
    Value pv = Value::Arr();
    for (const ui::ItemPush& p : pushes) {
      Value o = Value::Obj();
      o.set("id", p.id.toValue());
      setItem(o, "item", p.item);
      pv.push(o);
      st.lastItem.set(p.id, p.item);   // the caller applies, exactly as main.js does
    }
    out.set("rows", rows);
    out.set("pushes", pv);
    return out;
  }
  if (op == "clearItems") {
    st.lastItem.clear();
    out.set("cleared", Value::Bool(true));
    return out;
  }
  if (op == "welcomeItem") {
    const Value* carV = in.find("car");
    ui::PushCar car;
    const bool live = carV && carV->type == Value::OBJ;
    if (live) {
      car.id = idOf(carV->find("id"));
      car.item = itemOf(*carV);
      car.finished = json::truthy(carV->find("finished"));
    }
    const ui::ItemVal item = ui::welcomeItem(live ? &car : nullptr);
    out.set("item", item.kind == ui::ItemVal::STR ? Value::Str(item.str) : Value::Null());
    return out;
  }
  if (op == "flow") {
    const std::vector<ui::Id> carIds = idListOf(in.find("carIds"));
    const ui::IdSet ai = idSetOf(in.find("aiIds"));
    const ui::IdSet disc = idSetOf(in.find("disconnectedIds"));
    const ui::IdSet fin = idSetOf(in.find("finishedIds"));
    out.set("allDone", Value::Bool(ui::humansAllDone(carIds, ai, disc, fin)));
    out.set("forfeit", idArray(ui::forfeitCandidates(carIds, ai, disc)));
    return out;
  }
  if (op == "autopause") {
    ui::AutoPauseInput api;
    api.hasSession = json::truthy(in.find("hasSession"));
    api.raceEnded = json::truthy(in.find("raceEnded"));
    api.roomState = ui::roomStateOf(json::str_field(in, "roomState"));
    api.carIds = idListOf(in.find("carIds"));
    api.aiIds = idSetOf(in.find("aiIds"));
    api.seatedIds = idSetOf(in.find("seatedIds"));
    const bool asks = ui::autoPauseAsksParticipants(api);
    // The shell only READS the party layer when the model asks — the read has a
    // side effect on the room machine, so its timing is part of the contract.
    const ui::AutoPauseDecision d =
        ui::autoPause(api, asks && json::truthy(in, "allDisconnected"));
    out.set("asks", Value::Bool(asks));
    Value dv = Value::Obj();
    dv.set("action", Value::Str(ui::key(d.action)));
    dv.set("asked", Value::Bool(d.asked));
    if (d.hasAutoPaused) dv.set("autoPaused", Value::Bool(d.autoPaused));
    out.set("decision", dv);
    return out;
  }
  if (op == "freeze") {
    const bool hasSession = json::truthy(in.find("hasSession"));
    const bool paused = json::truthy(in.find("paused"));
    const ui::RoomState rs = ui::roomStateOf(json::str_field(in, "roomState"));
    out.set("move", Value::Str(ui::key(ui::freezeTransition(
        paused, json::truthy(in.find("autoPaused")), json::truthy(in.find("sessionPaused"))))));
    out.set("canPause", Value::Bool(ui::canPause(hasSession, paused, rs)));
    out.set("canResume", Value::Bool(ui::canResume(hasSession, paused)));
    return out;
  }
  if (op == "board") {
    const Value* sV = in.find("series");
    const bool over = json::truthy(in.find("over"));
    std::vector<ui::StandingRow> standings;
    ui::CupBoard cup;
    if (sV && sV->type == Value::OBJ) {
      const Value* st_ = sV->find("standings");
      if (st_ && st_->type == Value::ARR) {
        for (const Value& r : st_->arr) {
          ui::StandingRow sr;
          sr.playerId = idOf(r.find("playerId"));
          sr.points = json::num_field(r, "points");
          sr.gained = json::num_field(r, "gained");
          standings.push_back(std::move(sr));
        }
      }
      cup.standings = &standings;
      cup.info = seriesFrom(*sV, g_world.catalog);
    }
    std::vector<ui::ResultRow> results;
    const Value* rV = in.find("results");
    if (rV && rV->type == Value::ARR) {
      for (const Value& r : rV->arr) {
        ui::ResultRow rr;
        rr.playerId = idOf(r.find("playerId"));
        rr.finished = json::truthy(r.find("finished"));
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
        fr.name = json::str_field(f, "name");
        fr.colorIndex = numOf(f.find("colorIndex"));
        fr.ai = json::truthy(f.find("ai"));
        field.push_back(std::move(fr));
      }
    }
    std::vector<ui::LateJoiner> late;
    const Value* lV = in.find("lateJoiners");
    if (lV && lV->type == Value::ARR) {
      for (const Value& l : lV->arr) {
        ui::LateJoiner lj;
        lj.peerIndex = idOf(l.find("peerIndex"));
        lj.name = json::str_field(l, "name");
        lj.colorIndex = json::num_field(l, "colorIndex");
        late.push_back(std::move(lj));
      }
    }
    const ui::Board board = ui::standingsPayload(
        results, field, cup.standings ? &cup : nullptr, late, idOf(in.find("hostPeerIndex")), over);
    const Value bv = boardValue(board);
    out.set("board", bv);
    out.set("wire", Value::Str(wire(bv)));
    out.set("view", over ? viewValue(ui::resultsView(board, g_world.intermissionMs))
                         : Value::Null());
    return out;
  }
  if (op == "intermission") {
    out.set("secs", Value::Num(ui::intermissionSecs(json::num_field(in, "deadlineMs"),
                                                    json::num_field(in, "nowMs"))));
    return out;
  }
  std::fprintf(stderr, "unknown ui-corpus op '%s'\n", op.c_str());
  std::exit(2);
}

// The room-state vocabulary is TWO lists once this library declines to depend on
// libttp-party — protocol.h's ROOM_STATE and ui_model.h's local mirror. Pinning
// them costs four comparisons, and without it a relabelled state would make
// every autopause/freeze answer here consistently wrong.
void checkRoomStates() {
  const ui::RoomState want[] = {ui::RoomState::LOBBY, ui::RoomState::COUNTDOWN,
                                ui::RoomState::PLAYING, ui::RoomState::RESULTS};
  cases++;
  bool ok = protocol::ROOM_STATE.size() == 4;
  for (size_t i = 0; ok && i < 4; i++) {
    const std::string& wire_ = protocol::ROOM_STATE[i].second;
    ok = ui::roomStateOf(wire_) == want[i] && ui::key(want[i]) == wire_;
  }
  // ... and an unlisted state must stay OTHER rather than decaying into one of
  // the four, which is what makes "not a race state" reachable.
  ok = ok && ui::roomStateOf("paused-forever") == ui::RoomState::OTHER;
  if (ok) {
    passed++;
  } else if (spew++ < 20) {
    std::fprintf(stderr, "FAIL room states: ui_model.h's mirror disagrees with protocol.h\n");
  }
}

// The cup re-sort must be STABLE, and the corpus cannot say so: its widest
// board is seven rows, and every standard-library sort is stable at that size
// (libc++ insertion-sorts below 30 elements), so std::sort passes every
// recorded step. Above that threshold it does not, and a real party is not the
// only caller — a shell replaying a long endless series can hand this a field
// the corpus never reached. So one synthetic board pins the property directly.
//
// Not conformance evidence and not pretending to be: it is a behavioural
// assertion of hud_check's checkItemTable kind, over a shape no JS was ever
// recorded on. What it holds is exactly what the JS comparator says — rows the
// cup table does not name compare NaN against each other, Array#sort reads that
// as 0, and they therefore keep their race order underneath the ranked ones.
void checkStableCupSort() {
  const size_t N = 40;   // past every library's insertion-sort cutoff
  std::vector<ui::ResultRow> results;
  std::vector<ui::StandingRow> standings;
  for (size_t i = 0; i < N; i++) {
    ui::ResultRow r;
    r.playerId = ui::Id::Num((double) i);
    r.finished = true;
    results.push_back(std::move(r));
  }
  // Only the EVEN ids are in the cup table, and in reverse order, so a correct
  // sort has to move them and leave the odd ones alone.
  for (size_t i = N; i-- > 0;) {
    if (i % 2) continue;
    ui::StandingRow s;
    s.playerId = ui::Id::Num((double) i);
    standings.push_back(std::move(s));
  }
  ui::CupBoard cup;
  cup.standings = &standings;
  const ui::Board b = ui::standingsPayload(results, {}, &cup, {}, ui::Id::None(), true);

  std::vector<double> want;
  for (size_t i = N; i-- > 0;) if (i % 2 == 0) want.push_back((double) i);
  for (size_t i = 0; i < N; i++) if (i % 2) want.push_back((double) i);

  cases++;
  bool ok = b.order.size() == want.size();
  for (size_t i = 0; ok && i < want.size(); i++) ok = b.order[i].playerId == ui::Id::Num(want[i]);
  if (ok) {
    passed++;
  } else if (spew++ < 20) {
    std::fprintf(stderr, "FAIL cup re-sort is not stable: rows outside the cup table "
                         "must keep their race order\n");
  }
}

}  // namespace

// Re-emit the corpus from the port: same driver, same shell threading, the
// comparison replaced by a write.
int recordCorpus(const std::string& fixture, const std::string& outPath) {
  Shell st;
  // A failed world load must reach the EXIT CODE. Re-emitting 1500 lines
  // computed against an empty catalogue and then exiting 0 leaves the byte
  // comparison in record_roundtrip.cmake to notice, which it does — but it
  // reports a diff rather than the cause.
  bool world = false, bad = false;
  const int rc = corpus::record(fixture, outPath, [&](const Value& root) {
    const Value* kind = root.find("case");
    // UNDEF copies the header through verbatim — and the header is also where
    // the world comes from, so the re-emit configures itself exactly as the
    // replay does rather than carrying a second copy of the catalogue.
    if (!kind) {
      if (!world && !(world = loadWorld(root, g_world))) bad = true;
      return Value();
    }
    if (kind->str == "scenario") { st.reset(root.find("screen")); return Value(); }
    if (kind->str != "step") return Value();
    const Value* opV = root.find("op");
    const Value* inV = root.find("in");
    const Value empty = Value::Obj();
    const Value got = applyOp(st, opV ? opV->str : std::string(),
                              inV && inV->type == Value::OBJ ? *inV : empty);
    // The generator's key SET; canonical_stringify sorts them.
    Value line = Value::Obj();
    line.set("case", Value::Str("step"));
    const Value* nm = root.find("name");
    line.set("name", nm ? *nm : Value::Str("?"));
    const Value* sn = root.find("step");
    line.set("step", sn ? *sn : Value::Num(0));
    line.set("op", opV ? *opV : Value::Str(""));
    line.set("in", inV ? *inV : empty);
    line.set("out", got);
    line.set("state", st.toValue());
    return line;
  });
  return bad ? 2 : rc;
}

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: ui_check <ui-corpus.jsonl>\n"
                         "       ui_check --record <corpus> --out=<file>\n");
    return 2;
  }
  {
    std::string fixture, outPath;
    if (corpus::wants_record(argc, argv, &fixture, &outPath))
      return recordCorpus(fixture, outPath);
  }
  std::ifstream in(argv[1]);
  if (!in) {
    std::fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }

  checkRoomStates();
  checkStableCupSort();

  Shell st;
  std::string scenario;
  int scenarios = 0, steps = 0;
  bool header = false;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    std::string err;
    if (!read_line(line, root, &err)) {
      std::fprintf(stderr, "parse error: %s\n", err.c_str());
      return 2;
    }
    const Value* kind = root.find("case");
    if (!kind) {
      if (header) continue;
      header = true;
      if (!loadWorld(root, g_world)) return 2;
      continue;
    }
    if (kind->str == "scenario") {
      scenario = root.find("name") ? root.find("name")->str : std::string("?");
      st.reset(root.find("screen"));
      scenarios++;
      continue;
    }
    if (kind->str != "step") continue;

    const Value* opV = root.find("op");
    const Value* wantOut = root.find("out");
    const Value* wantState = root.find("state");
    if (!opV || opV->type != Value::STR || !wantOut || !wantState) {
      std::fprintf(stderr, "malformed step: no op / out / state\n");
      return 2;
    }
    const Value* inV = root.find("in");
    const Value empty = Value::Obj();
    const Value got = applyOp(st, opV->str, inV && inV->type == Value::OBJ ? *inV : empty);
    steps++;

    const Value* stepN = root.find("step");
    const std::string what = opV->str + " " + scenario + " step " +
                             std::to_string(stepN ? (long long) stepN->num : -1);
    report(what, diff_val(*wantOut, got, "out"));
    report(what, diff_val(*wantState, st.toValue(), "state"));
  }

  // The corpus is frozen, so a shape change that silently stopped matching any
  // step would turn this check green while proving nothing.
  if (!header || steps == 0) {
    std::fprintf(stderr, "no ui steps found in the corpus\n");
    return 2;
  }

  std::printf("ui model corpus: %d/%d cases passed (%d scenarios, %d steps)\n",
              passed, cases, scenarios, steps);
  return passed == cases ? 0 : 1;
}
