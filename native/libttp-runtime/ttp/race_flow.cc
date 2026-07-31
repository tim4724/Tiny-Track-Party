#include "ttp/race_flow.h"

#include <cmath>

#include "ttp/jsmath.h"   // js_max — Math.max's ±0 ordering, not std::max's
#include "ttp/jsonnum.h"  // js_number_to_string — Number::toString, not printf

namespace ttp {
namespace rt {
namespace race {

// ---- wire spellings ----------------------------------------------------------
// One switch, no table lookup, so a new Op that forgets its spelling is a
// -Wswitch warning rather than an empty string on the wire. raceflow_check pins
// every one of these against the corpus.
const char* key(Op op) {
  switch (op) {
    case Op::STOP_LOBBY_DEMO: return "stop-lobby-demo";
    case Op::SET_FIELD: return "set-field";
    case Op::CLEAR_ITEM_CACHE: return "clear-item-cache";
    case Op::SHOW_SCREEN: return "show-screen";
    case Op::HIDE_RESULTS: return "hide-results";
    case Op::SET_RACE_FLAGS: return "set-race-flags";
    case Op::SET_PAUSE_OVERLAY: return "set-pause-overlay";
    case Op::SET_PAUSE_BUTTON: return "set-pause-button";
    case Op::REVEAL_CHROME: return "reveal-chrome";
    case Op::HOLD_CHROME: return "hold-chrome";
    case Op::RESET_SCENE_CARS: return "reset-scene-cars";
    case Op::CREATE_SESSION: return "create-session";
    case Op::TRANSITION: return "transition";
    case Op::BIND_SESSION: return "bind-session";
    case Op::PAINT_INITIAL_HUD: return "paint-initial-hud";
    case Op::START_COUNTDOWN: return "start-countdown";
    case Op::SHOW_COUNTDOWN: return "show-countdown";
    case Op::BROADCAST_COUNTDOWN: return "broadcast-countdown";
    case Op::REFRESH_AUTO_PAUSE: return "refresh-auto-pause";
    case Op::START_MUSIC: return "start-music";
    case Op::STOP_MUSIC: return "stop-music";
    case Op::SHOW_MUSIC_CREDIT: return "show-music-credit";
    case Op::STOP_VOICES: return "stop-voices";
    case Op::ITEM_PICKUP: return "item-pickup";
    case Op::ROCKET_IMPACT: return "rocket-impact";
    case Op::ROCKET_EXPIRE: return "rocket-expire";
    case Op::BROADCAST_STANDINGS: return "broadcast-standings";
    case Op::APPLY_RACE_POINTS: return "apply-race-points";
    case Op::SHOW_RESULTS: return "show-results";
    case Op::ARM_RESULTS_FAILSAFE: return "arm-results-failsafe";
    case Op::CLEAR_RESULTS_FAILSAFE: return "clear-results-failsafe";
    case Op::ARM_INTERMISSION: return "arm-intermission";
    case Op::CLEAR_INTERMISSION: return "clear-intermission";
    case Op::SERIES_ADVANCE: return "series-advance";
    case Op::CLEAR_SERIES: return "clear-series";
    case Op::SET_TRACK_FROM_SERIES: return "set-track-from-series";
    case Op::PLACE_TRACK: return "place-track";
    case Op::SET_TRACK: return "set-track";
    case Op::DISPOSE_SESSION: return "dispose-session";
    case Op::CLEAR_FIELD: return "clear-field";
    case Op::FADE_TO_LOBBY: return "fade-to-lobby";
    case Op::REMOVE_SCENE_CAR: return "remove-scene-car";
    case Op::STOP_CAR_AUDIO: return "stop-car-audio";
    case Op::SYNC_STATE: return "sync-state";
    case Op::SERIES_REKEY: return "series-rekey";
    case Op::REKEY_SCENE_CAR: return "rekey-scene-car";
    case Op::REKEY_FIELD: return "rekey-field";
    case Op::SET_AUTO_PAUSED: return "set-auto-paused";
    case Op::SYNC_FROZEN: return "sync-frozen";
    case Op::RETURN_TO_LOBBY: return "return-to-lobby";
    case Op::CLOSE_ROOM: return "close-room";
    case Op::CLEAR_PICK: return "clear-pick";
    case Op::RENDER_LOBBY_PICK: return "render-lobby-pick";
    case Op::REFRESH_LOBBY_DEMO: return "refresh-lobby-demo";
    case Op::UPDATE_BACKDROP: return "update-backdrop";
  }
  return "";
}

const char* key(SeriesKind k) {
  switch (k) {
    case SeriesKind::NONE: return "";
    case SeriesKind::CUP: return "cup";
    case SeriesKind::RANDOM_ENDLESS: return "random-endless";
    case SeriesKind::RANDOM_CARD: return "random-card";
  }
  return "";
}
const char* key(StartAction a) { return a == StartAction::LAUNCH ? "launch" : "none"; }
const char* key(StartReason r) {
  switch (r) {
    case StartReason::NONE: return "";
    case StartReason::ROOM_STATE: return "room-state";
    case StartReason::SCENE: return "scene";
    case StartReason::NO_TRACK: return "no-track";
    case StartReason::NO_PLAYERS: return "no-players";
  }
  return "";
}
const char* key(AdvanceAction a) {
  switch (a) {
    case AdvanceAction::NONE: return "none";
    case AdvanceAction::RETURN_TO_LOBBY: return "return-to-lobby";
    case AdvanceAction::ADVANCE: return "advance";
  }
  return "";
}
const char* key(ReturnAction a) { return a == ReturnAction::RETURN ? "return" : "none"; }

namespace {

Effect mk(Op op) {
  Effect e;
  e.op = op;
  return e;
}

// JS `x >>> 0` on a double: ToUint32. Spelled out rather than cast, because a
// plain (uint32_t) cast on a non-finite or out-of-range double is UB in C++ and
// JS defines the whole domain. The bot seed is the only place it is reached.
double toUint32(double x) {
  if (!std::isfinite(x)) return 0;
  double m = std::fmod(std::trunc(x), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return m;
}

}  // namespace

// ---- the CPU field -----------------------------------------------------------

Value carStatsAt(const std::vector<Value>& table, const OptNum& carIndex) {
  if (table.empty()) return Value::Null();
  const double n = static_cast<double>(table.size());
  // A null/undefined/NaN carIndex is car 0; anything else wraps into range. The
  // modulo is applied twice so a negative index lands positive, exactly as
  // protocol.js does it (JS % is fmod, which keeps the dividend's sign).
  double i = 0;
  if (carIndex.has && !std::isnan(carIndex.v)) {
    i = std::fmod(std::fmod(carIndex.v, n) + n, n);
  }
  const long idx = static_cast<long>(i);
  if (idx < 0 || idx >= static_cast<long>(table.size())) return Value::Null();
  return table[static_cast<size_t>(idx)];
}

int lowestFreeSlot(const std::vector<int>& used, int count) {
  for (int i = 0; i < count; i++) {
    bool taken = false;
    for (int u : used) if (u == i) { taken = true; break; }
    if (!taken) return i;
  }
  return 0;
}

std::vector<CpuSeat> cpuSeats(const std::vector<Human>& humans, const FieldWorld& w) {
  std::vector<int> used;
  used.reserve(humans.size());
  for (const Human& h : humans) used.push_back(h.colorIndex);

  std::vector<CpuSeat> seats;
  // ?bots=<n> caps the AI fill (debug); unset tops the grid up to fieldSize.
  const double fill = w.botCap.has
      ? std::fmin(static_cast<double>(w.fieldSize),
                  static_cast<double>(humans.size()) + w.botCap.v)
      : static_cast<double>(w.fieldSize);
  for (int n = 0; static_cast<double>(humans.size() + seats.size()) < fill; n++) {
    CpuSeat s;
    s.n = n;
    s.colorIndex = lowestFreeSlot(used, w.colorCount);
    used.push_back(s.colorIndex);
    s.carIndex = w.carCount
        ? static_cast<int>(std::fmod(static_cast<double>(s.colorIndex),
                                     static_cast<double>(w.carCount)))
        : 0;
    if (!w.personas.empty()) {
      s.persona = w.personas[static_cast<size_t>(n) % w.personas.size()];
    }
    s.stats = carStatsAt(w.carStats, OptNum::Of(s.carIndex));
    seats.push_back(std::move(s));
    // A zero/negative colourCount would otherwise spin: lowestFreeSlot returns 0
    // forever and the fill condition never advances on its own.
    if (seats.size() > 64) break;
  }
  return seats;
}

BuiltField buildField(const std::vector<Human>& humans, double seed, const FieldWorld& w) {
  BuiltField out;
  // carIndex is the player's lobby car pick; each player carries the handling
  // stats resolved from it, so the engine can give every car its own accel/top
  // speed/turn/weight + collision footprint.
  for (const Human& h : humans) {
    FieldEntry e;
    e.peerIndex = h.peerIndex;
    e.name = h.name;
    e.colorIndex = h.colorIndex;
    e.carIndex = h.carIndex;
    e.stats = carStatsAt(w.carStats, h.carIndex);
    e.ai = false;
    out.field.push_back(std::move(e));
  }
  // cpuSeats reads only colorIndex off the humans it is handed, and the JS hands
  // it the field it has built so far — same list, same answer.
  std::vector<Human> asHumans;
  asHumans.reserve(out.field.size());
  for (const FieldEntry& f : out.field) {
    Human h;
    h.peerIndex = f.peerIndex;
    h.name = f.name;
    h.colorIndex = f.colorIndex;
    h.carIndex = f.carIndex;
    asHumans.push_back(std::move(h));
  }
  for (const CpuSeat& s : cpuSeats(asHumans, w)) {
    const Id id = Id::Str(w.aiPrefix + std::to_string(s.n));
    FieldEntry e;
    e.peerIndex = id;
    e.name = s.persona.name;
    e.colorIndex = s.colorIndex;
    e.carIndex = OptNum::Of(s.carIndex);
    e.stats = s.stats;
    e.ai = true;
    out.field.push_back(std::move(e));

    // Seed each bot's wander from the race seed + its NUMERIC index (s.n, not
    // the "ai-N" id string — in JS a number+string coerces to NaN>>>0 = 0, which
    // had been handing every bot the same stream): distinct per bot, fresh per
    // race. JS `(seed || 1) + n`, so a 0/NaN seed becomes 1.
    BotSpec b;
    b.peerIndex = id;
    b.caution = s.persona.caution;
    b.laneBias = s.persona.laneBias;
    const double base = (seed != 0 && !std::isnan(seed)) ? seed : 1.0;
    b.seed = toUint32(base + s.n);
    out.bots.push_back(std::move(b));
    out.aiIds.push_back(id);
  }
  return out;
}

std::vector<DemoEntry> buildDemoField(const std::vector<Human>& humans, const FieldWorld& w) {
  std::vector<DemoEntry> field;
  for (const Human& h : humans) {
    DemoEntry e;
    // A player who never picked drives the car their LIVERY maps to.
    e.carIndex = h.carIndex.has ? h.carIndex : OptNum::Of(h.colorIndex);
    e.id = "demo-" + h.peerIndex.key();
    e.name = h.name;
    e.colorIndex = h.colorIndex;
    e.stats = carStatsAt(w.carStats, e.carIndex);
    field.push_back(std::move(e));
  }
  const size_t humanCount = field.size();

  std::vector<Human> asHumans;
  asHumans.reserve(field.size());
  for (const DemoEntry& f : field) {
    Human h;
    h.peerIndex = Id::Str(f.id);
    h.name = f.name;
    h.colorIndex = f.colorIndex;
    h.carIndex = f.carIndex;
    asHumans.push_back(std::move(h));
  }
  for (const CpuSeat& s : cpuSeats(asHumans, w)) {
    DemoEntry e;
    e.id = "demo-cpu-" + std::to_string(s.n);
    e.colorIndex = s.colorIndex;
    e.carIndex = OptNum::Of(s.carIndex);
    e.stats = s.stats;
    field.push_back(std::move(e));
  }
  // Persona by FINAL GRID INDEX so they spread across the whole field; each CPU
  // also takes THAT persona's name, so its plate matches how it drives.
  for (size_t i = 0; i < field.size(); i++) {
    if (!w.personas.empty()) field[i].persona = w.personas[i % w.personas.size()];
    if (i >= humanCount) field[i].name = field[i].persona.name;
  }
  return field;
}

std::string demoSig(const std::vector<DemoEntry>& field, const std::string& trackId) {
  std::string out = trackId + "|";
  for (size_t i = 0; i < field.size(); i++) {
    if (i) out += ",";
    out += field[i].id;
    out += ":";
    out += js_number_to_string(static_cast<double>(field[i].colorIndex));
    out += ":";
    // JS template-interpolates the raw value, so a null carIndex spells "null".
    out += field[i].carIndex.has ? js_number_to_string(field[i].carIndex.v) : "null";
  }
  return out;
}

// ---- the series behind a start ----------------------------------------------

int drawsNeeded(const std::string& mode, double randomRaces) {
  // The tour's randomRaces is its cup count (the pick walk stores it), so both
  // draw-ahead modes share one formula: everything past race 1 is a draw.
  if (mode != "random" && mode != "tour") return 0;
  if (randomRaces == 0 || std::isnan(randomRaces) || randomRaces == 1) return 0;
  return static_cast<int>(js_max(0.0, randomRaces - 1));
}

int returnDrawsNeeded(const std::string& mode) {
  return (mode == "random" || mode == "tour") ? 1 : 0;
}

SeriesForStart seriesForStart(const std::string& mode, const OptStr& cupId,
                              const std::string& trackId, double randomRaces,
                              const std::vector<Cup>& cups,
                              const std::vector<std::string>& draws) {
  SeriesForStart out;
  if (mode == "cup") {
    for (const Cup& c : cups) {
      if (cupId.has && c.id == cupId.v) {
        out.has = true;
        out.series.kind = SeriesKind::CUP;
        out.series.cupId = c.id;
        return out;
      }
    }
    return out;   // no such cup -> null, no draws used
  }
  if (mode == "tour") {
    // The World Tour: race 1 is the pick's own (first-cup) draw, the rest are
    // the walk's per-cup draws in cup order. Mechanically it IS a random card —
    // fixed track list, points, a podium — so it reuses that kind; its identity
    // rides the cupId/cupName the shells and boards show.
    out.has = true;
    out.series.kind = SeriesKind::RANDOM_CARD;
    out.series.cupId = "tour";
    out.series.cupName = "World Tour";
    out.series.tracks.push_back(trackId);
    const size_t want = static_cast<size_t>(js_max(0.0, randomRaces - 1));
    const size_t take = want < draws.size() ? want : draws.size();
    for (size_t i = 0; i < take; i++) out.series.tracks.push_back(draws[i]);
    out.drawsUsed = static_cast<int>(take);
    return out;
  }
  if (mode != "random") return out;
  // Endless: one track on the card, and a draw offered at every intermission.
  if (randomRaces == 0 || std::isnan(randomRaces)) {
    out.has = true;
    out.series.kind = SeriesKind::RANDOM_ENDLESS;
    out.series.cupId = "random";
    out.series.cupName = "Random";
    out.series.tracks.push_back(trackId);
    return out;
  }
  if (randomRaces == 1) return out;   // a single race, which the phone cannot pick
  out.has = true;
  out.series.kind = SeriesKind::RANDOM_CARD;
  out.series.cupId = "random";
  out.series.cupName = "Random";
  out.series.tracks.push_back(trackId);
  // JS slice(0, n-1): fewer draws than asked for simply yields fewer races.
  const size_t want = static_cast<size_t>(js_max(0.0, randomRaces - 1));
  const size_t take = want < draws.size() ? want : draws.size();
  for (size_t i = 0; i < take; i++) out.series.tracks.push_back(draws[i]);
  out.drawsUsed = static_cast<int>(take);
  return out;
}

// ---- start / launch ----------------------------------------------------------

StartResult startRace(const StartInput& in) {
  StartResult r;
  if (in.roomState != RoomState::LOBBY) { r.reason = StartReason::ROOM_STATE; return r; }
  if (!in.sceneReady) { r.reason = StartReason::SCENE; return r; }
  // A track must be chosen first. JS tests truthiness, so an empty string is
  // "no track" just as null is.
  if (!in.selectedTrackId.has || in.selectedTrackId.v.empty()) {
    r.reason = StartReason::NO_TRACK;
    return r;
  }
  if (in.players.empty()) { r.reason = StartReason::NO_PLAYERS; return r; }
  r.action = StartAction::LAUNCH;
  r.series = seriesForStart(in.mode, in.cupId, in.trackId, in.randomRaces, in.cups, in.draws);
  r.drawsUsed = r.series.drawsUsed;
  return r;
}

LaunchResult launchRace(const LaunchInput& in) {
  LaunchResult out;
  BuiltField built = buildField(in.players, in.seed, in.world);
  out.field = built.field;
  out.aiIds = built.aiIds;
  out.bots = built.bots;

  // THE ORDER BELOW IS THE CONTRACT. Read race_flow.h's header before moving a
  // single line of it.
  Effect e;

  out.effects.push_back(mk(Op::STOP_LOBBY_DEMO));   // the race owns the scene now

  e = mk(Op::SET_FIELD);                            // kept for the results screen
  e.field = built.field; e.aiIds = built.aiIds; e.bots = built.bots;
  out.effects.push_back(e);

  // first frame resends every phone's (empty) ITEM
  out.effects.push_back(mk(Op::CLEAR_ITEM_CACHE));
  e = mk(Op::SHOW_SCREEN); e.str = "race"; out.effects.push_back(e);
  out.effects.push_back(mk(Op::HIDE_RESULTS));
  e = mk(Op::SET_RACE_FLAGS);
  e.paused = false; e.autoPaused = false; e.raceEnded = false;
  out.effects.push_back(e);
  e = mk(Op::SET_PAUSE_OVERLAY); e.on = false; out.effects.push_back(e);
  // pausable from the countdown on
  e = mk(Op::SET_PAUSE_BUTTON); e.shown = true; out.effects.push_back(e);
  out.effects.push_back(mk(Op::REVEAL_CHROME));

  // (re)build scene cars. AI cars get no split-screen cell — they are opponents
  // in the shared world, not players watching the screen. The rebuild is also
  // what puts the warning cones back upright, clears last race's rubber patina
  // and restores every collected item box.
  e = mk(Op::RESET_SCENE_CARS);
  for (const FieldEntry& p : built.field) {
    SceneCar c;
    c.id = p.peerIndex;
    c.colorIndex = p.colorIndex;
    c.name = p.name;
    c.cell = !p.ai;
    c.carIndex = p.carIndex;
    e.cars.push_back(std::move(c));
  }
  out.effects.push_back(e);

  // The seed rides the effect that consumes it (the session constructor), so
  // a shell threads nothing across ops to perform a launch.
  e = mk(Op::CREATE_SESSION);
  e.str = in.trackId; e.num = in.seed; e.forceItem = in.forceItem; e.bots = built.bots;
  out.effects.push_back(e);

  // Flip to COUNTDOWN only now that the session exists — see the header. No
  // frame or await runs between the create above and here, so this is the first
  // snapshot any phone sees for the race.
  e = mk(Op::TRANSITION); e.str = "countdown"; out.effects.push_back(e);

  // Hand the renderer and the audio this race's session. Binding the audio
  // before the countdown starts is what keeps the opening beat from getting
  // away; the lobby's attract race is never bound, which is why it is silent.
  out.effects.push_back(mk(Op::BIND_SESSION));
  // chrome at final size through the countdown, no pop-in at GO
  out.effects.push_back(mk(Op::PAINT_INITIAL_HUD));
  e = mk(Op::START_COUNTDOWN); e.num = in.countdownSeconds; out.effects.push_back(e);
  return out;
}

Effects countdownTick(double n) {
  Effects out;
  Effect e = mk(Op::SHOW_COUNTDOWN);
  e.num = n;
  e.slap = n > 0;
  e.go = n == 0;
  out.push_back(e);
  if (n >= 0) { e = mk(Op::BROADCAST_COUNTDOWN); e.num = n; out.push_back(e); }
  return out;
}

Effects raceStart(const std::string& biome, bool audioReady) {
  Effects out;
  Effect e;
  // roomState=playing in the snapshot lands phones on the drive screen
  e = mk(Op::TRANSITION); e.str = "playing"; out.push_back(e);
  // The auto-pause only freezes while PLAYING, so a field that emptied during
  // the countdown has to be re-checked now that we are. DEFERRED off this stack
  // on purpose — see the header.
  e = mk(Op::REFRESH_AUTO_PAUSE); e.deferred = true; out.push_back(e);
  // Background song for the whole race, from the biome's pool. The pick only
  // happens if the device can play it.
  if (audioReady) { e = mk(Op::START_MUSIC); e.str = biome; out.push_back(e); }
  e = mk(Op::SHOW_MUSIC_CREDIT); e.on = true; out.push_back(e);
  return out;
}

// ---- the finish --------------------------------------------------------------

Effects raceEvent(const RaceEvent& ev, bool fastForwarding, bool humansAllDone) {
  Effects out;
  if (!ev.present) return out;
  Effect e;
  if (!fastForwarding) {
    // A live car's grab always re-spins its cell roulette (incl. a box swap that
    // re-rolls the same item) — a finished car's victory-lap grab has no usable
    // slot, so no spin.
    if (ev.type == "pickup" && !ev.finished) {
      e = mk(Op::ITEM_PICKUP); e.id = ev.id; e.str = ev.item; out.push_back(e);
    }
    // Rocket strike: a one-shot impact burst on the target.
    if (ev.type == "spin" && ev.cause == "rocket") {
      e = mk(Op::ROCKET_IMPACT); e.id = ev.id; out.push_back(e);
    }
    // A rocket self-destructing at the end of its flight (a whiff).
    if (ev.type == "rocket_expire") {
      e = mk(Op::ROCKET_EXPIRE); e.s = ev.s; e.lat = ev.lat; out.push_back(e);
    }
  }
  if (ev.type != "finish") return out;
  // endRace sends the final board once; don't spam one per AI car.
  if (fastForwarding) return out;
  // If that finish was the last human's we are about to fast-forward to the flag
  // and endRace will send the final board — skip this intermediate push so the
  // last human jumps straight to results, with no flash of the "FINISHED" hero
  // for a race that is effectively already decided.
  if (humansAllDone) return out;
  e = mk(Op::BROADCAST_STANDINGS); e.over = false; out.push_back(e);
  return out;
}

Effects endRace(const EndRaceInput& in) {
  Effects out;
  Effect e;
  e = mk(Op::TRANSITION); e.str = "results"; out.push_back(e);
  // Bank the cup points FIRST — the final board broadcast below must already
  // carry this race's gains, and the intermission/podium read them too.
  if (in.hasSeries) out.push_back(mk(Op::APPLY_RACE_POINTS));
  // hold the finish frame behind the translucent results overlay
  e = mk(Op::SET_RACE_FLAGS);
  e.paused = false; e.autoPaused = false; e.raceEnded = true;
  out.push_back(e);
  // the frozen frame must not hold wind/squeal voices open
  out.push_back(mk(Op::STOP_VOICES));
  out.push_back(mk(Op::STOP_MUSIC));           // race over → results screen is quiet
  e = mk(Op::SHOW_MUSIC_CREDIT); e.on = false; out.push_back(e);
  e = mk(Op::SET_PAUSE_OVERLAY); e.on = false; out.push_back(e);   // results aren't pausable
  e = mk(Op::SET_PAUSE_BUTTON); e.shown = false; out.push_back(e);
  out.push_back(mk(Op::HOLD_CHROME));
  // final board → phones show the full results overlay
  e = mk(Op::BROADCAST_STANDINGS); e.over = true; out.push_back(e);
  out.push_back(mk(Op::SHOW_RESULTS));
  // The host ends the results screen with "New game"; this is only a safety net
  // so a room whose players all left mid-podium still recovers.
  e = mk(Op::ARM_RESULTS_FAILSAFE); e.num = in.resultsFailsafeMs; out.push_back(e);
  // Mid-cup: this results screen is an INTERMISSION — arm the auto-advance into
  // the next race (the host can jump it early; advanceSeriesRace disarms the
  // failsafe above).
  if (in.hasSeries && !in.seriesFinished) {
    e = mk(Op::ARM_INTERMISSION);
    e.num = in.intermissionMs;
    e.deadline = in.nowMs + in.intermissionMs;
    out.push_back(e);
  }
  return out;
}

// ---- the cup chain -----------------------------------------------------------

AdvanceResult advanceSeriesRace(const AdvanceInput& in) {
  AdvanceResult r;
  if (in.roomState != RoomState::RESULTS || !in.hasSeries || in.seriesFinished ||
      !in.sceneReady) {
    return r;   // NONE, no effects
  }
  // Everyone left mid-intermission.
  if (in.players.empty()) { r.action = AdvanceAction::RETURN_TO_LOBBY; return r; }
  r.action = AdvanceAction::ADVANCE;
  // endRace armed the back-to-lobby failsafe — it must not yank race N+1.
  r.effects.push_back(mk(Op::CLEAR_RESULTS_FAILSAFE));
  r.effects.push_back(mk(Op::CLEAR_INTERMISSION));
  r.effects.push_back(mk(Op::SERIES_ADVANCE));
  // publishes + selects (track/totalLaps swap). Outside the lobby the select
  // skips its scene crossfade (there is no preview to fade), and a chained start
  // has no lobby step — so the new circuit is placed explicitly and the results
  // overlay covers the pop.
  r.effects.push_back(mk(Op::SET_TRACK_FROM_SERIES));
  r.effects.push_back(mk(Op::PLACE_TRACK));
  return r;
}

// ---- the way out -------------------------------------------------------------

ReturnResult returnToLobby(const ReturnInput& in) {
  ReturnResult r;
  if (in.roomState == RoomState::LOBBY) return r;   // NONE
  r.action = ReturnAction::RETURN;

  // Re-aim the pick for the next lobby: random (and the tour, whose draw the
  // walk restricts to the first cup) re-rolls every visit, a cup rewinds to its
  // race 1 (a quit or finished cup left trackId mid-cup, and the next Start
  // races a fresh series from the top).
  if (in.mode == "random" || in.mode == "tour") {
    if (!in.draws.empty()) { r.trackSwap = OptStr::Of(in.draws[0]); r.drawsUsed = 1; }
  } else if (in.mode == "cup") {
    for (const Cup& c : in.cups) {
      if (in.cupId.has && c.id == in.cupId.v) {
        if (!c.tracks.empty() && (!in.trackId.has || in.trackId.v != c.tracks[0])) {
          r.trackSwap = OptStr::Of(c.tracks[0]);
        }
        break;
      }
    }
  }

  Effect e;
  r.effects.push_back(mk(Op::CLEAR_RESULTS_FAILSAFE));
  // every exit route cancels a running cup (quit, abandon, failsafe)
  r.effects.push_back(mk(Op::CLEAR_SERIES));
  r.effects.push_back(mk(Op::CLEAR_INTERMISSION));
  if (r.trackSwap.has) { e = mk(Op::SET_TRACK); e.str = r.trackSwap.v; r.effects.push_back(e); }
  // Tear the session down BEFORE the flow flips to LOBBY — see the header.
  r.effects.push_back(mk(Op::DISPOSE_SESSION));
  e = mk(Op::TRANSITION); e.str = "lobby"; r.effects.push_back(e);
  // Reachable straight from a live race (controller RETURN_TO_LOBBY, solo's R
  // key) — kill any state voices or a boost wind would drone on in the lobby.
  r.effects.push_back(mk(Op::STOP_VOICES));
  r.effects.push_back(mk(Op::STOP_MUSIC));
  e = mk(Op::SHOW_MUSIC_CREDIT); e.on = false; r.effects.push_back(e);
  e = mk(Op::SET_RACE_FLAGS);
  e.paused = false; e.autoPaused = false; e.raceEnded = false;
  r.effects.push_back(e);
  e = mk(Op::SET_PAUSE_OVERLAY); e.on = false; r.effects.push_back(e);
  e = mk(Op::SET_PAUSE_BUTTON); e.shown = false; r.effects.push_back(e);
  r.effects.push_back(mk(Op::HOLD_CHROME));
  r.effects.push_back(mk(Op::CLEAR_FIELD));
  // controllers return to the lobby off the snapshot (roomState=lobby)
  e = mk(Op::SHOW_SCREEN); e.str = "lobby"; r.effects.push_back(e);
  // Crossfade from the frozen finish frame back to the attract demo: drop the
  // race cars + restart the demo under cover so the reset doesn't pop.
  e = mk(Op::FADE_TO_LOBBY); e.placeTrack = r.trackSwap.has; r.effects.push_back(e);
  return r;
}

const char* key(PauseAction a) {
  switch (a) {
    case PauseAction::PAUSE: return "pause";
    case PauseAction::RESUME: return "resume";
    case PauseAction::NONE: break;
  }
  return "none";
}

PauseResult pauseRace(const PauseInput& in) {
  PauseResult r;
  if (!ui::canPause(in.hasSession, in.paused, in.roomState)) return r;
  r.action = PauseAction::PAUSE;
  Effect e = mk(Op::SET_RACE_FLAGS);
  e.paused = true; e.autoPaused = in.autoPaused; e.raceEnded = in.raceEnded;
  r.effects.push_back(e);
  r.effects.push_back(mk(Op::SYNC_FROZEN));
  r.effects.push_back(mk(Op::SYNC_STATE));
  e = mk(Op::SET_PAUSE_OVERLAY); e.on = true; r.effects.push_back(e);
  // the overlay is a mouse target — cursor + buttons stay put while it's up
  r.effects.push_back(mk(Op::HOLD_CHROME));
  return r;
}

PauseResult resumeRace(const PauseInput& in) {
  PauseResult r;
  if (!ui::canResume(in.hasSession, in.paused)) return r;
  r.action = PauseAction::RESUME;
  Effect e = mk(Op::SET_RACE_FLAGS);
  e.paused = false; e.autoPaused = in.autoPaused; e.raceEnded = in.raceEnded;
  r.effects.push_back(e);
  r.effects.push_back(mk(Op::SYNC_FROZEN));
  r.effects.push_back(mk(Op::SYNC_STATE));
  e = mk(Op::SET_PAUSE_OVERLAY); e.on = false; r.effects.push_back(e);
  // racing again — re-arm the chrome fade
  r.effects.push_back(mk(Op::REVEAL_CHROME));
  return r;
}

Effects endParty() {
  Effects out;
  // The room closes FIRST — phones bail to their party-over overlay before the
  // pick vanishes under them — and the screen flips only once the lobby is
  // re-dressed; the backdrop fades last, over the final state. The shell's own
  // returnToLobby() runs BEFORE this list (it owns the race teardown and the
  // draw protocol); from the lobby that call is a no-op.
  out.push_back(mk(Op::CLOSE_ROOM));
  out.push_back(mk(Op::CLEAR_PICK));
  out.push_back(mk(Op::RENDER_LOBBY_PICK));
  out.push_back(mk(Op::REFRESH_LOBBY_DEMO));
  Effect e = mk(Op::SHOW_SCREEN); e.str = "welcome"; out.push_back(e);
  out.push_back(mk(Op::UPDATE_BACKDROP));
  return out;
}

// ---- the roster-driven repairs ----------------------------------------------

Effects forfeitCar(bool removed, const Id& peerIndex) {
  Effects out;
  if (!removed) return out;
  Effect e;
  e = mk(Op::REMOVE_SCENE_CAR); e.id = peerIndex; out.push_back(e);
  // its id leaves the loop — no zero-level update will come
  e = mk(Op::STOP_CAR_AUDIO); e.id = peerIndex; out.push_back(e);
  // inRace(peerIndex) just flipped false with no roster event — republish
  out.push_back(mk(Op::SYNC_STATE));
  return out;
}

Effects rekeyCarPlayer(bool hasSeries, bool rekeyed, const Id& oldId, const Id& newId) {
  Effects out;
  Effect e;
  // banked cup points follow the player, car or no car
  if (hasSeries) { e = mk(Op::SERIES_REKEY); e.id = oldId; e.id2 = newId; out.push_back(e); }
  if (!rekeyed) return out;
  e = mk(Op::REKEY_SCENE_CAR); e.id = oldId; e.id2 = newId; out.push_back(e);
  // the loop re-creates voices under newId next frame
  e = mk(Op::STOP_CAR_AUDIO); e.id = oldId; out.push_back(e);
  e = mk(Op::REKEY_FIELD); e.id = oldId; e.id2 = newId; out.push_back(e);
  return out;
}

Effects autoPauseEffects(const AutoPauseDecision& d) {
  Effects out;
  if (!d.present || d.action == "none") return out;
  if (d.action == "return-to-lobby") { out.push_back(mk(Op::RETURN_TO_LOBBY)); return out; }
  Effect e = mk(Op::SET_AUTO_PAUSED);
  e.on = d.autoPaused;
  out.push_back(e);
  out.push_back(mk(Op::SYNC_FROZEN));
  return out;
}

}  // namespace race
}  // namespace rt
}  // namespace ttp
