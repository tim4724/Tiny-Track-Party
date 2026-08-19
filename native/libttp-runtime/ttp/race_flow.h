// race_flow — the display's RACE ORCHESTRATION, in C++.
//
// This is public/display/raceFlow.js, ported. The state machine main.js used to
// run inline: starting a race, launching one, the countdown beats, the finish,
// the cup chain, the return to the lobby, and the four roster-driven repairs
// that ride alongside it (forfeit, rekey, auto-pause, standings).
//
// ui_model.h is the sibling that took the PREDICATES — allRacersReady, canPause,
// raceFlow, autoPause. This is the machine that calls them in order, and the
// ORDER is what it exists to hold. Four constraints in it are load-bearing and
// none of them type-checks:
//
//   * COUNTDOWN is published only AFTER the session exists, because the
//     statechange republishes the room snapshot and each player's `inRace` is
//     read from the live session. Flip first and every racer's phone briefly
//     says "you're in the next race".
//   * the post-GO auto-pause re-check is DEFERRED off the launch stack, because
//     it runs inside the session update and its no-seats-left branch tears the
//     session down underneath the caller.
//   * cup points are banked BEFORE the final board is broadcast, because the
//     board carries this race's gains.
//   * the session is disposed BEFORE the flow flips to LOBBY, because that
//     transition sweeps held disconnected seats and would otherwise race an
//     endRace on the way out.
//
// So nothing here returns a verdict for a shell to sequence. Every entry point
// returns an ORDERED LIST OF EFFECTS, and a shell's whole job is to walk it and
// perform each op. The order is then DATA — recorded in a corpus, replayed on
// every leg — rather than prose a second shell re-derives and gets subtly wrong.
//
// PURE, on the same terms as ui_model.h: no DOM, no clock, no RNG, no handles.
// An effect NAMES a timer to arm; it never holds one. The three things this
// layer cannot compute arrive as inputs — the per-race `seed` (the shell's page
// RNG), `nowMs`, and `draws` pulled from the shell's shuffle bag (which stays
// JS on purpose: page RNG, not sim state).
//
// CATALOGUE-AGNOSTIC, like ui_model.cc. The persona table, the car-stats rows
// and the cup list arrive per call rather than being reached for, which is what
// lets the corpus carry a synthetic world and keeps a new track — or a persona
// retune — from being a corpus re-record. It is also what lets the WEB shell
// pass ttp::AI_PERSONALITIES straight through from libttp-sim instead of
// keeping the second copy public/display/aiPersonas.js used to be.
//
// CONFORMANCE. tests/fixtures/raceflow-corpus.jsonl was recorded off the live
// raceFlow.js before this file existed, which makes it JS-RECORDED
// cross-implementation evidence: class 1 in tests/fixtures/traces/README.md,
// the only class that can settle a parity question. runtimetest/raceflow_check.cc
// replays every step of it — `out` AND the shell state its driver threads —
// through this header on all four legs. A disagreement is a bug HERE, never in
// the corpus.
//
// WHAT IS DELIBERATELY NOT HERE. The performing (sockets, timers, the History
// API, the AudioContext, scene objects), and — for the reason the plan gives
// each — the shuffle BAG itself, the host's mode pick, LobbyDemo, and the
// back-stack traversal.
//
// FLOATING POINT. Everything is double, matching JS Number. The only arithmetic
// that can round is `colorIndex % carCount` (std::fmod, JS's % exactly) and the
// bot seed's `>>> 0` (a uint32 truncation, spelled out in seedForBot). No
// transcendental appears here, and one showing up would mean something is wrong.
#pragma once

#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/scalar_id.h"
#include "ttp/ui_model.h"

namespace ttp {
namespace rt {
namespace race {

using Id = ScalarId;
using ui::OptNum;
using ui::OptStr;
using ui::RoomState;

// ---- the ops ----------------------------------------------------------------
// One enum entry per effect the layer can emit. `key()` gives the wire spelling
// the corpus recorded and a shell dispatches on; the two must stay in step and
// raceflow_check pins every one of them.
enum class Op {
  STOP_LOBBY_DEMO, SET_FIELD, CLEAR_ITEM_CACHE, SHOW_SCREEN,
  HIDE_RESULTS, SET_RACE_FLAGS, SET_PAUSE_OVERLAY, SET_PAUSE_BUTTON,
  REVEAL_CHROME, HOLD_CHROME, RESET_SCENE_CARS, CREATE_SESSION, TRANSITION,
  BIND_SESSION, PAINT_INITIAL_HUD, START_COUNTDOWN, SHOW_COUNTDOWN,
  BROADCAST_COUNTDOWN, REFRESH_AUTO_PAUSE, START_MUSIC, STOP_MUSIC,
  SHOW_MUSIC_CREDIT, STOP_VOICES, ITEM_PICKUP, ROCKET_IMPACT, ROCKET_EXPIRE,
  BROADCAST_STANDINGS, APPLY_RACE_POINTS, SHOW_RESULTS, ARM_RESULTS_FAILSAFE,
  CLEAR_RESULTS_FAILSAFE, ARM_INTERMISSION, CLEAR_INTERMISSION, SERIES_ADVANCE,
  CLEAR_SERIES, SET_TRACK_FROM_SERIES, PLACE_TRACK, SET_TRACK, DISPOSE_SESSION,
  CLEAR_FIELD, FADE_TO_LOBBY, REMOVE_SCENE_CAR, STOP_CAR_AUDIO, SYNC_STATE,
  SERIES_REKEY, REKEY_SCENE_CAR, REKEY_FIELD, SET_AUTO_PAUSED, SYNC_FROZEN,
  RETURN_TO_LOBBY, CLOSE_ROOM, CLEAR_PICK, RENDER_LOBBY_PICK,
  REFRESH_LOBBY_DEMO, UPDATE_BACKDROP, PERSIST_PROGRESSION
};
// One past the last op — the vocabulary export walks [0, OP_COUNT) and a new
// op joins it by construction. Keep PERSIST_PROGRESSION the last enumerator or
// move this with it.
inline constexpr int OP_COUNT = static_cast<int>(Op::PERSIST_PROGRESSION) + 1;
const char* key(Op op);

// ---- the pieces an effect carries -------------------------------------------

// A persona row. `name` is display identity; the two knobs are the sim's.
struct Persona {
  std::string name;
  double caution = 1.0;
  double laneBias = 0.0;
};

// One CPU seat: which livery, which model, which persona, and the stats row
// that model resolves to. `stats` is an OPAQUE pass-through — the layer never
// reads inside it, which is what keeps the stat table out of this library.
struct CpuSeat {
  int n = 0;
  Persona persona;
  int colorIndex = 0;
  int carIndex = 0;
  Value stats = Value::Null();
};

// One grid entry. `carIndex` keeps JS null distinct from 0 (a player who never
// picked drives car 0 but is not the same input as one who picked it).
struct FieldEntry {
  Id peerIndex;
  std::string name;
  int colorIndex = 0;
  OptNum carIndex;
  Value stats = Value::Null();
  bool ai = false;
};

// A bot as the wasm takes it.
//
// `player` is the AUTOPILOT MARKER, and it is the one field that does not
// describe how the car drives. A spec carrying it names a seat that is still a
// PLAYER — it counts as a participant, it grids with the humans, it keeps its
// split-screen cell and it is not in `aiIds` — and that also carries a
// controller, so the sim drives it instead of a phone. Default false, so no
// existing launch changes and no recorded effect list gains a key
// (ttp_race.cc's writer emits it only when set).
//
// It exists because a bench, a screenshot and an attract race all need a field
// that DRIVES without a room full of phones, and the alternative every shell
// reached for — spec every seat as a bot — files the players under `bots`, and
// then the session has no participants left and tears the race down a second
// after it starts.
struct BotSpec {
  Id peerIndex;
  double caution = 1.0;
  double laneBias = 0.0;
  double seed = 0;   // already >>>0'd; double so it round-trips as a JS Number
  bool player = false;
};

// A car as the renderer takes it.
struct SceneCar {
  Id id;
  int colorIndex = 0;
  std::string name;
  bool cell = false;
  OptNum carIndex;
};

// ---- an effect ---------------------------------------------------------------
// One tagged record. Only the fields an op names are meaningful; the rest keep
// their defaults and the marshaller does not emit them. It is a flat struct
// rather than a variant because a C ABI has to spell it out anyway, and a
// tvOS/Android shell switching on `op` reads this more easily than a visitor.
struct Effect {
  Op op = Op::SYNC_STATE;

  double num = 0;         // create-session's seed | n | ms | seconds
  double deadline = 0;    // arm-intermission — when the auto-advance fires
  bool on = false;        // set-pause-overlay/show-music-credit/set-auto-paused
  bool shown = false;     // set-pause-button
  bool over = false;      // broadcast-standings
  bool deferred = false;  // refresh-auto-pause — see the header
  bool go = false;        // show-countdown: this beat is GO!
  bool slap = false;      // show-countdown: re-slap the numeral
  bool placeTrack = false;  // fade-to-lobby

  // set-race-flags
  bool paused = false, autoPaused = false, raceEnded = false;

  std::string str;        // screen | to | trackId | biome | item
  OptStr forceItem;       // create-session, null when there is no ?item override

  Id id, id2;             // item-pickup/rocket-impact/remove/stop-car-audio; rekey pairs
  double s = 0, lat = 0;  // rocket-expire's track point

  std::vector<SceneCar> cars;      // reset-scene-cars
  std::vector<FieldEntry> field;   // set-field
  std::vector<BotSpec> bots;       // set-field, create-session
  std::vector<Id> aiIds;           // set-field
};

using Effects = std::vector<Effect>;

// ---- the CPU field -----------------------------------------------------------

// carStats' wrap-and-default rule, which is a rule and not a lookup: a null,
// undefined or NaN carIndex is car 0, and anything else wraps into range (the
// modulo is applied twice so a negative index lands positive, exactly as
// protocol.js does it). Returns Null when the table is empty.
Value carStatsAt(const std::vector<Value>& table, const OptNum& carIndex);

// The lowest livery slot not already taken, or 0 when none is. RoomFlow owns
// this rule for seats; the CPU fill needs the same one and must not grow a
// second spelling of it.
int lowestFreeSlot(const std::vector<int>& used, int count);

// The world the field rules are resolved against. Passed per call, never held.
struct FieldWorld {
  // 0, not a plausible 4: an UNCONFIGURED world must produce an empty field
  // (the ttp_race.h contract "the CPU fill seats nobody"), never a
  // real-looking all-CPU grid a shell could race without noticing its boot
  // never ran.
  int fieldSize = 0;
  int carCount = 0;
  int colorCount = 0;
  std::vector<Persona> personas;
  std::vector<Value> carStats;
  OptNum botCap;               // the ?bots=<n> debug cap; None = fill the grid
  std::string aiPrefix = "ai-";
};

// A connected human, as the roster hands them over.
struct Human {
  Id peerIndex;
  std::string name;
  int colorIndex = 0;
  OptNum carIndex;
};

// CPU seats that top a human roster up to fieldSize. Each gets the lowest free
// livery, the model that livery slot maps to (what the renderer already drew
// when carIndex was omitted) + its stats, and a persona cycled by CPU index.
std::vector<CpuSeat> cpuSeats(const std::vector<Human>& humans, const FieldWorld& w);

// The race field: the connected humans plus AI racers topping the grid up to
// fieldSize. AI get string ids ("ai-0"…) that never collide with the integer
// phone slots.
struct BuiltField {
  std::vector<FieldEntry> field;
  std::vector<BotSpec> bots;
  std::vector<Id> aiIds;
};
BuiltField buildField(const std::vector<Human>& humans, double seed, const FieldWorld& w);

// The BENCH ROSTER: `n` player seats for a field nobody joined — a perf run, a
// screenshot, an attract race. Names, liveries and cars are decided HERE, once,
// because three shells photographing the same screen side by side must differ
// in the UI under inspection and in nothing else (the tvOS harness picked its
// own names and every comparison since carried that as noise).
//
// peerIndex is the seat number, so a bench roster and a real lobby's first `n`
// players are the same ids — which is what lets the bench exercise the scalar-id
// path a shell actually ships.
std::vector<Human> benchPlayers(int n, const FieldWorld& w);

// The attract field. Same CPU fill, different ids, and one extra rule: persona
// by FINAL GRID INDEX so they spread across the whole field, with each CPU
// taking that persona's name so its HUD name matches how it drives. Humans
// keep their own name but still drive on a persona — no phones steer here.
struct DemoEntry {
  std::string id;
  std::string name;
  int colorIndex = 0;
  OptNum carIndex;
  Value stats = Value::Null();
  Persona persona;
};
std::vector<DemoEntry> buildDemoField(const std::vector<Human>& humans, const FieldWorld& w);

// Cheap signature of what the demo renders, so a refresh can skip a no-op
// rebuild. Track + each car's id/livery/model; a rename alone won't re-grid.
std::string demoSig(const std::vector<DemoEntry>& field, const std::string& trackId);

// ---- the series behind a start ----------------------------------------------

struct Cup {
  std::string id;
  std::string name;
  std::vector<std::string> tracks;
};

// What Start commits to, as a DESCRIPTOR the shell hands to CupSeries — never a
// series object, because constructing one is the shell's job and this layer
// holds no handles.
enum class SeriesKind { NONE, CUP, RANDOM_ENDLESS, RANDOM_CARD };
const char* key(SeriesKind k);

struct SeriesPlan {
  SeriesKind kind = SeriesKind::NONE;
  std::string cupId;
  std::string cupName;
  std::vector<std::string> tracks;
};
struct SeriesForStart {
  bool has = false;          // false spells JS null
  SeriesPlan series;
  int drawsUsed = 0;         // how many bag draws a rule actually consumed
};

struct StartInput {
  RoomState roomState = RoomState::LOBBY;
  bool sceneReady = false;
  OptStr selectedTrackId;
  std::vector<Human> players;
  std::string mode;
  OptStr cupId;
  std::string trackId;
  double randomRaces = 0;
  std::vector<Cup> cups;
  std::vector<std::string> draws;
};

// How many bag draws a start with these settings WOULD consume, deciding
// nothing and taking none. It exists because a draw cannot be put back: a shell
// that pre-draws for startRace and is then told "no-players" has advanced the
// shuffle for a race that never happened.
int drawsNeeded(const std::string& mode, double randomRaces);

// The same question for a lobby return: only the random family (random, and
// the tour, whose draw the walk restricts to the first cup) re-rolls its pick
// on the way back (returnToLobby's trackSwap), so only those modes spend a draw.
int returnDrawsNeeded(const std::string& mode);

SeriesForStart seriesForStart(const std::string& mode, const OptStr& cupId,
                              const std::string& trackId, double randomRaces,
                              const std::vector<Cup>& cups,
                              const std::vector<std::string>& draws);

// ---- start / launch ----------------------------------------------------------

enum class StartAction { NONE, LAUNCH };
enum class StartReason { NONE, ROOM_STATE, SCENE, NO_TRACK, NO_PLAYERS };
const char* key(StartAction a);
const char* key(StartReason r);

struct StartResult {
  StartAction action = StartAction::NONE;
  StartReason reason = StartReason::NONE;
  SeriesForStart series;
  int drawsUsed = 0;
};

// The START_GAME go/no-go. The host's button is only enabled once every other
// player is ready; re-checked here so a stale or forged START_GAME cannot jump
// the lobby. The readiness rule itself stays ui_model's.
StartResult startRace(const StartInput& in);

struct LaunchInput {
  std::vector<Human> players;
  double seed = 0;
  std::string trackId;
  double countdownSeconds = 3;
  OptStr forceItem;
  FieldWorld world;
  // Grid order. The field array IS the grid — index 0 is pole (the session
  // seats cars in field order) — and these two knobs reorder it AFTER the fill:
  //   * gridOrder, when non-empty, is the previous race's finish order and wins
  //     outright (a chained series race). Ids it does not name — a mid-series
  //     joiner, a fresh fill bot — start at the back.
  //   * humansAtBack sends the CPU field out front (a first race, and the
  //     back-of-grid rule for ids gridOrder missed).
  // Both default OFF because the raceflow corpus predates them: recorded
  // launches replay the recorded grid, and the live walks pass the game's rule.
  bool humansAtBack = false;
  std::vector<Id> gridOrder;
  // Give every PLAYER seat a controller too (BotSpec::player) — the bench, the
  // attract race and the screenshot harnesses, where nobody is holding a phone.
  // The field is otherwise identical to a real launch's: same fill, same grid
  // rule, same cells, same ids. Only the source of the steering changes.
  //
  // Default OFF for the corpus's sake, exactly like humansAtBack.
  bool autopilotPlayers = false;
};
struct LaunchResult {
  Effects effects;
  std::vector<FieldEntry> field;
  std::vector<Id> aiIds;
  std::vector<BotSpec> bots;
};

// The actual race launch, shared by the lobby start and the series chain.
// THE ORDER OF THE EFFECTS IS THE CONTRACT — read this file's header first.
LaunchResult launchRace(const LaunchInput& in);

// One countdown beat. n > 0 is "3/2/1", n === 0 is "GO!", n < 0 is banner-gone.
// The n<0 beat clears the LOCAL banner only and is never broadcast: the phones'
// COUNTDOWN handler flips them onto the drive HUD, so a race that ends within a
// second of GO would otherwise have this trailing beat land after the final
// standings and yank their results board back to the wheel.
Effects countdownTick(double n);

// The "GO!" beat: physics are live and the banner is still up.
Effects raceStart(const std::string& biome, bool audioReady);

// ---- the finish --------------------------------------------------------------

// A race event, filtered to what the shell must do about it. No audio: a
// pickup, a banana, a spin and a lap chime are decided into sound inside the
// wasm as the sim fires them. `fastForwarding` silences the visuals for the
// same reason it silences the sound — the burst is skipping, not racing.
struct RaceEvent {
  bool present = false;
  std::string type;
  Id id;
  std::string item;
  std::string cause;
  bool finished = false;
  double s = 0, lat = 0;
};
Effects raceEvent(const RaceEvent& e, bool fastForwarding, bool humansAllDone);

struct EndRaceInput {
  bool hasSeries = false;
  bool seriesFinished = false;
  double intermissionMs = 0;
  double nowMs = 0;
  double resultsFailsafeMs = 0;
  // Emit persist-progression on a finished series' podium. Default-off keeps
  // the frozen corpus lines byte-identical (same trick as LaunchInput's
  // humansAtBack); the live executor always sets it.
  bool bankProgression = false;
};
Effects endRace(const EndRaceInput& in);

// ---- the cup chain -----------------------------------------------------------

enum class AdvanceAction { NONE, RETURN_TO_LOBBY, ADVANCE };
const char* key(AdvanceAction a);

struct AdvanceInput {
  RoomState roomState = RoomState::LOBBY;
  bool hasSeries = false;
  bool seriesFinished = false;
  bool sceneReady = false;
  std::vector<Human> players;
};
struct AdvanceResult {
  AdvanceAction action = AdvanceAction::NONE;
  Effects effects;
};
// Chain into the cup's next race straight from the intermission (RESULTS →
// COUNTDOWN, no lobby in between). startRace's LOBBY guard stays intact, so
// nothing else can skip an intermission. The shell runs launchRace() next.
AdvanceResult advanceSeriesRace(const AdvanceInput& in);

// ---- the way out -------------------------------------------------------------

enum class ReturnAction { NONE, RETURN };
const char* key(ReturnAction a);

struct ReturnInput {
  RoomState roomState = RoomState::LOBBY;
  std::string mode;
  OptStr cupId;
  OptStr trackId;
  std::vector<Cup> cups;
  std::vector<std::string> draws;
};
struct ReturnResult {
  ReturnAction action = ReturnAction::NONE;
  Effects effects;
  OptStr trackSwap;
  int drawsUsed = 0;
};
// Back to the lobby, from anywhere. Every exit route cancels a running cup.
// `trackSwap` re-aims the pick for the next lobby: random re-rolls every visit,
// a cup rewinds to its race 1.
ReturnResult returnToLobby(const ReturnInput& in);

// Ending the PARTY, not just the race: the ordered teardown AFTER the shell's
// own returnToLobby() call (which owns the race half and the draw protocol).
// Was the one lifecycle path written outside the effect walk.
Effects endParty();

// The manual overlay pause and its resume, as walks. The verdicts are
// ui_model's (canPause/canResume, called here); the ORDER is the contract —
// flag first, then the freeze sync, the republish, the overlay, the chrome.
// autoPaused/raceEnded pass through untouched: this walk owns neither.
enum class PauseAction { NONE, PAUSE, RESUME };
const char* key(PauseAction a);
struct PauseInput {
  bool hasSession = false;
  bool paused = false;
  bool autoPaused = false;
  bool raceEnded = false;
  RoomState roomState = RoomState::LOBBY;  // read by the pause verdict only
};
struct PauseResult {
  PauseAction action = PauseAction::NONE;
  Effects effects;
};
PauseResult pauseRace(const PauseInput& in);
PauseResult resumeRace(const PauseInput& in);

// The two game-timing budgets endRace takes as inputs. They live HERE — the
// layer that arms the timers' effects — and shells read them through the ABI
// (main.js used to own both numbers, which made them the only game timings a
// second shell had to re-author). The E2E overrides (__intermissionMs and
// friends) stay shell-side overrides of these defaults; the raceflow corpus
// header records the values it was driven with and raceflow_check pins it to
// these, so the oracle and the layer cannot drift.
inline constexpr double INTERMISSION_MS = 10000;       // auto-advance budget; the host can advance early
inline constexpr double RESULTS_FAILSAFE_MS = 60000;   // players-all-left recovery net

// ---- the roster-driven repairs ----------------------------------------------

// Pull a player's car out of the live race. `removed` is whether the session
// actually held that car — only the shell holds the handle, so it asks and
// passes the answer in.
Effects forfeitCar(bool removed, const Id& peerIndex);

// A dropped player reconnected on a different device. The cup rekey happens
// even with no car: banked points follow the PLAYER.
Effects rekeyCarPlayer(bool hasSeries, bool rekeyed, const Id& oldId, const Id& newId);

// The auto-pause arbitration's EFFECT half. The RULE is ui_model's autoPause —
// which seats count, when the freeze may apply, what an empty field means — and
// the shell passes its answer in.
struct AutoPauseDecision {
  bool present = false;
  std::string action;     // "none" | "return-to-lobby" | anything else = set
  bool autoPaused = false;
};
Effects autoPauseEffects(const AutoPauseDecision& d);

}  // namespace race
}  // namespace rt
}  // namespace ttp
