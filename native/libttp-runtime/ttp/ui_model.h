// ui_model — the display's UI MODEL, in C++.
//
// This is public/display/uiModel.js, ported. Every "what should the screen say"
// decision the display owns, as pure functions of PLAIN DATA -> plain answers:
// the seat grid, the lobby readiness rule, the lobby race card, the ITEM-push
// gate, the reconnect-card diff, the race-flow predicates, the pause
// arbitration, the standings board + the cup chip + the results overlay, and
// the screen enum with its per-screen back EFFECT. No DOM, no clock, no RNG, no
// history — every input arrives as a value and every answer is returned.
//
// hudRows is NOT here: it went ahead of the rest in P6 and lives in ttp/hud.h,
// where it reads the live Game into the packed block the shell polls. This file
// is the other twenty-odd rules of the same JS module.
//
// STRINGS ARE KEYS, NOT COPY — the plan's decision D4, and the reason this
// layer can be C++ at all. Everything user-facing comes out as a stable KEY
// (an enum here, with `key()` giving the wire spelling) plus DATA. Player
// names, cup names and track names pass through as data. There is no composed
// English anywhere in this header or its .cc, and a formatted sentence in the
// output would be a defect: the copy tables live in the shells, next to the
// elements they fill.
//
// WHAT IS DELIBERATELY NOT HERE: DOM/CSS, fades, canvas sizing, rAF,
// fullscreen, QR painting, and the back-stack TRAVERSAL. The screen ENUM and
// the per-screen back EFFECT are the model; walking the History API is not —
// web has two flags that exist only to tame that API, tvOS is Menu + a focus
// engine, Android TV is a backstack the OS partly owns. Port the table, not the
// walk.
//
// CONFORMANCE. tests/fixtures/ui-corpus.jsonl — 37 scenarios, 1559 steps —
// was recorded off the live uiModel.js in P5, which makes it JS-RECORDED
// cross-implementation evidence: class 1 in tests/fixtures/traces/README.md,
// the only class that can settle a parity question. runtimetest/ui_check.cc
// replays every step of it through this header on all four legs. A
// disagreement is a bug HERE, never in the corpus.
//
// FLOATING POINT. Everything is double, matching JS Number. Almost all of this
// layer is integer and ordering logic; the only arithmetic that can round is
// `carIndex % carCount` (std::fmod, JS's % exactly) and the countdown's
// ceil(ms/1000). Math.max goes through js_max (fp-profile §3.4) so ±0 orders as
// JS orders it. No transcendental appears here, and one showing up would mean
// something is wrong.
#pragma once

#include <cstddef>
#include <string>
#include <utility>
#include <vector>

#include "ttp/scalar_id.h"

namespace ttp {
// The codegen'd cup table's row type (libttp-track/ttp/trackbuilder.h). Forward
// declared rather than included: this header is plain data by design, and only
// the .cc — which reads generated/track_defs.h — needs the definition.
struct CupDef;
}  // namespace ttp

namespace ttp {
namespace rt {
namespace ui {

// Identity is the sim's and the party layer's: a JSON scalar, where the number
// 3 and the string "3" are different players (ScalarId's whole job). Peer
// indices are numbers, bots are strings like "ai-0", and both flow through the
// same board.
using Id = ScalarId;

// ---- JS null, kept ----------------------------------------------------------
// Half this layer's contract is WHICH field is null: a seat with no car pick, a
// cup with no difficulty, a DNF with no lap time, an endless series with no
// "of N". Collapsing those to 0 / "" would answer differently, so they are
// carried explicitly.
struct OptNum {
  bool has = false;
  double v = 0;
  static OptNum None() { return OptNum{}; }
  static OptNum Of(double x) { return OptNum{true, x}; }
};
struct OptStr {
  bool has = false;
  std::string v;
  static OptStr None() { return OptStr{}; }
  static OptStr Of(std::string s) { return OptStr{true, std::move(s)}; }
  // JS ===: null equals null, null never equals a string.
  bool operator==(const OptStr& o) const { return has == o.has && (!has || v == o.v); }
  bool operator!=(const OptStr& o) const { return !(*this == o); }
};

// Set membership over ids, the one thing uiModel.js asks of the Sets it takes.
// A vector because these hold a race's worth of cars, never a room's.
struct IdSet {
  std::vector<Id> ids;
  bool has(const Id& id) const {
    for (const Id& x : ids) if (x == id) return true;
    return false;
  }
  void add(const Id& id) { if (!has(id)) ids.push_back(id); }
};

// ---- room states ------------------------------------------------------------
// A local mirror of protocol.h's ROOM_STATE, for the same reason uiModel.js
// mirrors protocol.js's: this library must not gain a dependency edge on
// libttp-party to ask "is the room playing". OTHER is any state string neither
// side names — the recorded behaviour for one is "not a race state", which is
// what the enum has to preserve. runtimetest/ui_check.cc pins the four
// spellings to ttp::protocol::ROOM_STATE so the copy cannot drift silently.
enum class RoomState { LOBBY, COUNTDOWN, PLAYING, RESULTS, OTHER };
RoomState roomStateOf(const std::string& name);
const char* key(RoomState s);   // "" for OTHER — it has no spelling of its own

// ---- screens ----------------------------------------------------------------
// The display has three boards and they are strictly ordered, so "forward" and
// "back" are a subtraction. UNKNOWN is both "no board yet" and a name this
// build does not know: JS reads `SCREEN_ORDER[x] || 0`, so either counts as the
// root, and back is swallowed there.
enum class Screen { UNKNOWN, WELCOME, LOBBY, RACE };
Screen screenOf(const std::string& name);
int screenOrder(Screen s);
// >0 = a forward step (the shell pushes one history entry), <0 = a retreat
// (pop one), 0 = same level.
int screenStep(Screen prev, Screen next);

enum class BackEffect { SWALLOW, END_PARTY, RETURN_TO_LOBBY };
BackEffect backEffect(Screen s);
const char* key(BackEffect e);

// ---- the lobby --------------------------------------------------------------
// One roster entry, as the room hands it over.
struct RosterEntry {
  Id peerIndex;
  std::string name;
  double colorIndex = 0;
  OptNum carIndex;         // null until the player picks a car
  bool connected = true;
  bool ready = false;
};

// The roster as the seat grid sees it: the host marked, the ready flag carried.
// Pure projection — the ORDER is the room's (join order), never re-sorted.
struct Seat {
  std::string name;
  double colorIndex = 0;
  OptNum carIndex;
  bool connected = true;
  bool host = false;
  bool ready = false;
};
std::vector<Seat> rosterSeats(const std::vector<RosterEntry>& roster, const Id& hostPeerIndex);

// The seat grid itself: the taken seats padded with OPEN placeholders up to
// maxPlayers, so the lobby card keeps a fixed size as players trickle in (and
// never shrinks below the field that actually races). `open` cells carry
// nothing else.
struct SeatCell {
  bool open = true;
  std::string name;
  double colorIndex = 0;
  // The resolved car pick: carIndex falls back to the livery slot before the
  // player picks. modelIndex wraps it into the model roster for the thumbnail
  // and is JS `%`, so a negative pick stays negative — the shell's problem, not
  // this layer's to launder.
  double carIndex = 0;
  double modelIndex = 0;
  bool off = false;        // a held, dropped seat — dimmed, not removed
  bool host = false;
  bool ready = false;
};
std::vector<SeatCell> seatGrid(const std::vector<Seat>& seats, int maxPlayers, int carCount);

// START_GAME gate. The host's start IS their commitment, so they never ready
// up; everyone else must. An empty lobby cannot start.
bool allRacersReady(const std::vector<RosterEntry>& roster, const Id& hostPeerIndex);

// Who a race would seat: connected seats only. A dropped racer's seat lingers
// (dimmed, with a reconnect QR) but gets no car until they are back. Pointers
// into `roster`, valid while it is.
std::vector<const RosterEntry*> connectedPlayers(const std::vector<RosterEntry>& roster);

// ---- the lobby's race card --------------------------------------------------
struct Cup {
  std::string id;
  std::string name;
  std::vector<std::string> tracks;
};
struct CatalogEntry {
  std::string id;
  std::string name;
  OptStr cup;              // null for a track in no cup
  OptNum cupDifficulty;
};

// ---- the SHIPPED catalogue --------------------------------------------------
// Everything above is catalogue-AGNOSTIC on purpose: the model looks ids up in
// whatever lists it is handed, which is what lets the conformance corpus carry
// a synthetic world of two cups and nine circuits. These two functions are the
// other half of that arrangement — they answer with the world this build
// actually ships, read straight out of the codegen'd tables.
//
// WHY THEY EXIST. The shipped cups and their display names used to cross the
// ttp_ui.h boundary as ~2 KB of JSON the browser assembled out of
// public/shared/tracks.js. That made the catalogue an ARGUMENT, so every shell
// owed it a copy of the names AND its own spelling of the tendency rule below,
// for data the wasm already held (generated/track_defs.h has carried each
// track's cup since the biomes moved). A shell configures nothing now, and asks
// for the names it needs to draw a picker.

// Cup "tendency" difficulty, 1..4: a LEAN for a whole cup, not a per-track
// label. The rounded mean of its tracks' levels, unless the cup pins one.
//
// ROUNDING IS JS `Math.round` — half goes UP, toward +infinity, which for the
// positive values here is what std::lround does anyway. Spelt out because a
// cup of {Easy, Medium, Hard, Expert} means exactly 2.5 and no shipped cup
// currently lands on a tie, so nothing would notice the day one did.
int cupTendency(const CupDef& cup);

// The shipped cups, in the catalogue's own order (which IS the difficulty
// ladder), and the shipped tracks flattened in that same order — the
// arrangement every picker draws. Each catalogue entry carries its cup's
// resolved tendency, so a shell never recomputes one.
std::vector<Cup> shippedCups();
std::vector<CatalogEntry> shippedCatalog();

enum class PickMode { NONE, CUP, TRACK, RANDOM };
PickMode pickModeOf(const OptStr& mode);

// What the card's NAME is, and how many races the pick means. Keys, not copy.
enum class NameKey { CUP, TRACK, RANDOM };
enum class RacesKey { COUNT, ONE, ENDLESS };
const char* key(NameKey k);
const char* key(RacesKey k);

// A circuit to draw as a mini, BY TRACK ID; the schematic payload is the
// shell's to look up. A cup numbers them (n = 1..4) — that numbering is the GP
// menu at a glance and belongs to the model.
struct MapChip {
  OptStr trackId;
  OptNum n;
};
struct CupSlot {
  NameKey nameKey = NameKey::CUP;
  OptStr name;                 // null for random / an unresolved id
  RacesKey racesKey = RacesKey::COUNT;
  OptNum raceCount;            // meaningful only for RacesKey::COUNT
  OptNum difficulty;
  std::vector<MapChip> maps;
  OptStr cupId;
};
// false = no pick yet (the slot stays empty); `out` is untouched.
//
// randomRaces is the RANDOM mode's run length: 0 endless, a positive integer
// that many races. Absent (or any non-positive non-integer) reads as endless,
// which is what `random` meant before run lengths existed. It is ignored by the
// other two modes — a cup's count is its track list and a track pick is one race.
bool cupSlot(PickMode mode, const OptStr& cupId, const OptStr& trackId,
             const OptNum& randomRaces,
             const std::vector<Cup>& cups, const std::vector<CatalogEntry>& catalog,
             CupSlot& out);

// ---- dropped-seat reconnect cards -------------------------------------------
// Which cards to take down and which to put up, given what is already showing.
// The CALLER keeps the shown set, because putting a card up can FAIL (the car
// may have no cell) and only it knows what actually landed.
struct ReconnectDiff {
  std::vector<Id> remove;    // ids to take down, in shown order
  std::vector<size_t> add;   // indices into `seatIds`, in seat order
};
ReconnectDiff reconnectDiff(const std::vector<Id>& shownIds, const std::vector<Id>& seatIds);

// ---- the ITEM push ----------------------------------------------------------
// The held item lights the phone's USE button, and it is per-owner, so it rides
// its own message sent ONLY ON CHANGE.
//
// THREE STATES, not two. JS distinguishes an ABSENT item field from an explicit
// null, and `!==` sees the difference — a car whose slot went from null to
// absent pushes again. The empty string is a fourth value and is NOT null here
// (hudRows folds "" to null; this rule does not), which is why the recorded
// push for an empty-string slot carries `item: ""`.
struct ItemVal {
  enum Kind { ABSENT, NUL, STR };
  Kind kind = ABSENT;
  std::string str;
  static ItemVal Absent() { return ItemVal{}; }
  static ItemVal Null() { ItemVal v; v.kind = NUL; return v; }
  static ItemVal Str(std::string s) { ItemVal v; v.kind = STR; v.str = std::move(s); return v; }
  bool operator==(const ItemVal& o) const {
    return kind == o.kind && (kind != STR || str == o.str);
  }
  bool operator!=(const ItemVal& o) const { return !(*this == o); }
};

// What each phone was last told (main.js's `_lastItem`). Insertion-ordered
// because it is a JS Map and the shell's own state dump is `[...entries()]`;
// re-setting an existing key does not move it.
class LastItems {
 public:
  // Map.get: ABSENT when this phone was never told anything.
  ItemVal get(const Id& id) const;
  void set(const Id& id, const ItemVal& item);
  void clear() { entries_.clear(); }
  const std::vector<std::pair<Id, ItemVal>>& entries() const { return entries_; }

 private:
  std::vector<std::pair<Id, ItemVal>> entries_;
};

// A car, as the push rule reads it off a snapshot.
struct PushCar {
  Id id;
  ItemVal item;
  bool finished = false;
};
struct ItemPush {
  Id id;
  ItemVal item;
};
// Which phones need a push this tick. AI cars have no phone behind them. PURE:
// the caller applies the answers to `lastItem`, exactly as the JS caller does,
// and clears it per race so the first tick resends every empty slot.
std::vector<ItemPush> itemPushes(const std::vector<PushCar>& cars, const IdSet& aiIds,
                                 const LastItems& lastItem);

// The same rule for a single car, for the one-shot relight a (re)joining phone
// gets: no live car (`car == nullptr`), or a finished one, means an empty slot.
ItemVal welcomeItem(const PushCar* car);

// ---- race flow --------------------------------------------------------------
// True once every CONNECTED human car has crossed the line (CPU cars may still
// be out) — the cue to fast-forward the deterministic sim to the flag instead
// of making the humans watch bots crawl home. A dropped racer's ghost is
// skipped: it can never finish, so it must not hold the flag down for everyone
// else. False with no connected humans left at all.
bool humansAllDone(const std::vector<Id>& carIds, const IdSet& aiIds,
                   const IdSet& disconnectedIds, const IdSet& finishedIds);

// Ghosts to forfeit at the finish moment: a dropped human's car can never cross
// the line, so once every connected human is home it must be removed or the
// fast-forward burst runs to its guard cap on a car that cannot finish.
std::vector<Id> forfeitCandidates(const std::vector<Id>& carIds, const IdSet& aiIds,
                                  const IdSet& disconnectedIds);

// ---- pause arbitration ------------------------------------------------------
// Two independent freezes compose into one: the manual overlay pause (any
// player's controller, or the on-screen button) and the SILENT auto-pause (no
// connected human is holding a car). A manual resume while every racer is still
// gone keeps the field frozen; a reconnect during a manual pause keeps the
// overlay's authority.
bool canPause(bool hasSession, bool paused, RoomState roomState);
bool canResume(bool hasSession, bool paused);

// The auto-pause decision.
//   NONE             nothing to arbitrate (no race, or already over)
//   RETURN_TO_LOBBY  no human seat is left in this race at all — nothing to
//                    wait for, so the room goes back to the lobby and any late
//                    joiners get seated in the next race immediately
//   SET              carry on, with `autoPaused` as given
// The freeze is a PLAYING-state thing on purpose: freezing the COUNTDOWN would
// strand the room short of the only state the abandoned-race grace runs in, so
// a field that dropped during the beats would never reach the deadline that
// recovers the room. Nothing moves before GO anyway.
enum class AutoPauseAction { NONE, RETURN_TO_LOBBY, SET };
const char* key(AutoPauseAction a);

struct AutoPauseInput {
  bool hasSession = false;
  bool raceEnded = false;
  RoomState roomState = RoomState::OTHER;
  std::vector<Id> carIds;
  IdSet aiIds;
  IdSet seatedIds;
};
struct AutoPauseDecision {
  AutoPauseAction action = AutoPauseAction::NONE;
  // Whether the party layer's answer was CONSULTED. Reading it is not free on
  // the shell side — it pushes the live car set into the room machine first —
  // so a shell uses autoPauseAsksParticipants() to read it exactly when this
  // decision would, instead of eagerly on every roster change.
  bool asked = false;
  bool hasAutoPaused = false;   // only SET carries an autoPaused answer
  bool autoPaused = false;
};
// `allParticipantsDisconnected` is NOT re-derived here: it is the party layer's
// answer over the same participant set the abandoned-race grace waits on, which
// is what keeps the silent freeze and that policy from ever disagreeing.
AutoPauseDecision autoPause(const AutoPauseInput& in, bool allParticipantsDisconnected);
bool autoPauseAsksParticipants(const AutoPauseInput& in);

// What the combined freeze state means for the SIM's clock, given where the sim
// currently is. One writer, so neither pause path drives pause()/resume()
// itself.
enum class FreezeMove { NONE, FREEZE, THAW };
const char* key(FreezeMove m);
FreezeMove freezeTransition(bool paused, bool autoPaused, bool sessionPaused);

// ---- the Grand Prix chip ----------------------------------------------------
// The cup's progress chip on every standings board: which race of how many
// (raceCount is null for endless random play — there is no "of N"), what is
// next (null after a cup's last race), and whether this board is the podium
// (`isFinal`; never for endless). autoAdvanceMs lets the phones caption the
// auto-start.
struct SeriesInput {
  OptStr cupId;
  OptStr cupName;
  bool endless = false;
  double raceIndex = 0;
  OptNum raceCount;
  bool finished = false;
  OptStr nextTrackId;
  double autoAdvanceMs = 0;
};
struct SeriesInfo {
  OptStr cupId;
  OptStr cupName;
  bool endless = false;
  double raceIndex = 0;
  OptNum raceCount;
  OptStr nextTrackId;
  OptStr nextTrackName;
  bool isFinal = false;      // `final` on the wire
  double autoAdvanceMs = 0;
};
SeriesInfo seriesInfo(const SeriesInput& in, const std::vector<CatalogEntry>& catalog);

// ---- the standings board ----------------------------------------------------
// ONE board, rendered by the TV and by every phone. Pushed as each car finishes
// (over=false) and once more at race end (over=true, so DNF/AFK cars resolve
// and everyone, not just finishers, sees the final board). Enriched from the
// race FIELD because the AI racers are not in the lobby roster the phones know,
// so the display is the only side that can name and colour them.
struct ResultRow {              // the sim's ranked rows
  Id playerId;
  bool finished = false;
  OptNum time;
};
struct FieldRow {               // this race's grid
  Id peerIndex;
  std::string name;
  OptNum colorIndex;
  bool ai = false;
};
struct StandingRow {            // the cup's banked points
  Id playerId;
  double points = 0;
  double gained = 0;
};
struct LateJoiner {             // a connected seat with no car this round
  Id peerIndex;
  std::string name;
  double colorIndex = 0;
};

struct BoardRow {
  Id playerId;
  std::string name;
  double colorIndex = 0;
  // A `joining` row carries NOTHING else: no ai/finished/time, no points. It is
  // a different shape on the wire, not a racer with empty fields.
  bool joining = false;
  bool ai = false;
  bool finished = false;
  OptNum time;
  bool hasPoints = false;
  double points = 0;
  bool hasGained = false;
  double gained = 0;
};
struct Board {
  bool over = false;
  Id hostPeerIndex;
  bool hasSeries = false;
  SeriesInfo series;
  std::vector<BoardRow> order;   // racers, then the joining rows
  size_t total() const { return order.size(); }
};

// The cup half of a board: the banked table plus the chip. null = a single race.
struct CupBoard {
  const std::vector<StandingRow>* standings = nullptr;
  SeriesInfo info;
};

// Cup boards stamp every racer's banked points, and the FINAL board is
// re-sorted into cup-standings order (points → latest-race placement, the
// intermission and podium story). Live boards stay in RACE order: mid-race the
// drama is who crosses the line, not the tally. That re-sort is STABLE and
// leaves anyone missing from the cup table where they were, relative to each
// other — JS's comparator returns NaN for two such rows, which Array#sort reads
// as 0. Reproduced with std::stable_sort, not sort.
//
// Late joiners are listed UNDER the racers so every board shows who is waiting
// on the next race instead of silently omitting them.
Board standingsPayload(const std::vector<ResultRow>& results,
                       const std::vector<FieldRow>& field,
                       const CupBoard* cup,
                       const std::vector<LateJoiner>& lateJoiners,
                       const Id& hostPeerIndex, bool over);

// ---- the results overlay ----------------------------------------------------
// Three dressings, as semantic values:
//   plain single-race board  RESULTS,    rows carry a lap time
//   cup intermission         STANDINGS + a sub + a "next up" footer
//   cup podium               CUP_CHAMPS, top three on the steps
// Rows come from the same board the phones get, so both screens always tell the
// same story (order, points, joining rows). `kind` is what each row's trailing
// cell says.
enum class TitleKey { RESULTS, STANDINGS, CUP_CHAMPS };
enum class SubKey { CUP_RACE, CUP_RACE_OF };
enum class RowKind { TIME, POINTS, JOINING };
enum class NewGameKey { NEW_GAME, NEXT_RACE };
const char* key(TitleKey k);
const char* key(SubKey k);
const char* key(RowKind k);
const char* key(NewGameKey k);

struct ListRow {
  const BoardRow* row = nullptr;
  RowKind kind = RowKind::TIME;
};
struct ResultsView {
  bool podium = false;
  bool intermission = false;
  TitleKey titleKey = TitleKey::RESULTS;
  OptStr cupName;
  bool hasSub = false;
  SubKey subKey = SubKey::CUP_RACE;
  OptStr subCupName;
  double subRace = 0;          // 1-based
  OptNum subOf;                // null for endless
  // The podium's split is deliberate and FROZEN: the STEPS take the top three
  // non-joining rows, while the list starts at index 3 of the RAW order. A
  // joining row inside the first three therefore shortens the steps without
  // shifting the list. A shell that "fixes" it drops a racer off both.
  bool hasPodiumRows = false;  // false = null (not a podium), not an empty list
  std::vector<const BoardRow*> podiumRows;
  std::vector<ListRow> listRows;
  bool hasNext = false;
  std::string nextTrackName;   // "" when the next circuit resolves to nothing
  double nextSecs = 0;
  NewGameKey newGameKey = NewGameKey::NEW_GAME;
};
// Rows are POINTERS into `board`, which must outlive the view.
ResultsView resultsView(const Board& board, double intermissionMs);

// The intermission's "starting in N", against the auto-advance deadline. A
// fresh ceil each beat rather than a decrementing counter, so it cannot drift.
double intermissionSecs(double deadlineMs, double nowMs);

}  // namespace ui
}  // namespace rt
}  // namespace ttp
