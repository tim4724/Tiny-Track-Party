#include "ttp/ui_model.h"

#include <algorithm>
#include <cmath>

#include "ttp/jsmath.h"   // js_max — Math.max's ±0 ordering, not std::max's

namespace ttp {
namespace rt {
namespace ui {
namespace {

// Whole seconds, rounded up — how every countdown label in this layer is read.
double ceilSecs(double ms) { return std::ceil(ms / 1000.0); }

// String(id), for the board's name fallback. A number spells itself through
// Number::toString (ScalarId::key), never printf.
std::string idString(const Id& id) { return id.isNull() ? std::string("null") : id.key(); }

}  // namespace

// ---- room states ------------------------------------------------------------

RoomState roomStateOf(const std::string& name) {
  if (name == "lobby") return RoomState::LOBBY;
  if (name == "countdown") return RoomState::COUNTDOWN;
  if (name == "playing") return RoomState::PLAYING;
  if (name == "results") return RoomState::RESULTS;
  return RoomState::OTHER;
}

const char* key(RoomState s) {
  switch (s) {
    case RoomState::LOBBY: return "lobby";
    case RoomState::COUNTDOWN: return "countdown";
    case RoomState::PLAYING: return "playing";
    case RoomState::RESULTS: return "results";
    case RoomState::OTHER: break;
  }
  return "";
}

// ---- screens ----------------------------------------------------------------

Screen screenOf(const std::string& name) {
  if (name == "welcome") return Screen::WELCOME;
  if (name == "lobby") return Screen::LOBBY;
  if (name == "race") return Screen::RACE;
  return Screen::UNKNOWN;
}

int screenOrder(Screen s) {
  switch (s) {
    case Screen::LOBBY: return 1;
    case Screen::RACE: return 2;
    case Screen::WELCOME:          // welcome IS the root, order 0
    case Screen::UNKNOWN: break;   // ... and so is anything unrecognised
  }
  return 0;
}

int screenStep(Screen prev, Screen next) { return screenOrder(next) - screenOrder(prev); }

BackEffect backEffect(Screen s) {
  switch (s) {
    case Screen::LOBBY: return BackEffect::END_PARTY;
    case Screen::RACE: return BackEffect::RETURN_TO_LOBBY;
    // welcome is the root: there is nothing above it, so back is swallowed —
    // and an unknown board answers the same way.
    case Screen::WELCOME:
    case Screen::UNKNOWN: break;
  }
  return BackEffect::SWALLOW;
}

const char* key(BackEffect e) {
  switch (e) {
    case BackEffect::END_PARTY: return "end-party";
    case BackEffect::RETURN_TO_LOBBY: return "return-to-lobby";
    case BackEffect::SWALLOW: break;
  }
  return "swallow";
}

// ---- the lobby --------------------------------------------------------------

std::vector<Seat> rosterSeats(const std::vector<RosterEntry>& roster, const Id& hostPeerIndex) {
  std::vector<Seat> out;
  out.reserve(roster.size());
  for (const RosterEntry& p : roster) {
    Seat s;
    s.name = p.name;
    s.colorIndex = p.colorIndex;
    s.carIndex = p.carIndex;
    s.connected = p.connected;
    s.host = p.peerIndex == hostPeerIndex;
    s.ready = p.ready;
    out.push_back(std::move(s));
  }
  return out;
}

std::vector<SeatCell> seatGrid(const std::vector<Seat>& seats, int maxPlayers, int carCount) {
  size_t total = seats.size();
  if (maxPlayers > 0 && static_cast<size_t>(maxPlayers) > total) total = static_cast<size_t>(maxPlayers);
  std::vector<SeatCell> out;
  out.reserve(total);
  for (size_t i = 0; i < total; i++) {
    if (i >= seats.size()) {
      out.push_back(SeatCell{});   // open: the placeholder carries nothing else
      continue;
    }
    const Seat& p = seats[i];
    SeatCell c;
    c.open = false;
    c.name = p.name;
    c.colorIndex = p.colorIndex;
    // The car pick, or the livery slot before the player picks one.
    c.carIndex = p.carIndex.has ? p.carIndex.v : p.colorIndex;
    // JS `%`, which IS fmod: a negative pick stays negative rather than
    // wrapping into range, and that is recorded behaviour.
    c.modelIndex = carCount ? std::fmod(c.carIndex, static_cast<double>(carCount)) : 0.0;
    c.off = !p.connected;   // a held, dropped seat — dimmed, not removed
    c.host = p.host;
    c.ready = p.ready;
    out.push_back(std::move(c));
  }
  return out;
}

bool allRacersReady(const std::vector<RosterEntry>& roster, const Id& hostPeerIndex) {
  size_t players = 0;
  bool every = true;
  for (const RosterEntry& p : roster) {
    if (!p.connected) continue;
    players++;
    if (!(p.ready || p.peerIndex == hostPeerIndex)) every = false;
  }
  return players > 0 && every;
}

std::vector<const RosterEntry*> connectedPlayers(const std::vector<RosterEntry>& roster) {
  std::vector<const RosterEntry*> out;
  for (const RosterEntry& p : roster) {
    if (p.connected) out.push_back(&p);
  }
  return out;
}

// ---- the lobby's race card --------------------------------------------------

PickMode pickModeOf(const OptStr& mode) {
  if (!mode.has) return PickMode::NONE;
  if (mode.v == "cup") return PickMode::CUP;
  if (mode.v == "track") return PickMode::TRACK;
  if (mode.v == "random") return PickMode::RANDOM;
  return PickMode::NONE;
}

const char* key(NameKey k) {
  switch (k) {
    case NameKey::TRACK: return "track";
    case NameKey::RANDOM: return "random";
    case NameKey::CUP: break;
  }
  return "cup";
}

const char* key(RacesKey k) {
  switch (k) {
    case RacesKey::ONE: return "one";
    case RacesKey::ENDLESS: return "endless";
    case RacesKey::COUNT: break;
  }
  return "count";
}

namespace {

// catalog.find(t => t.id === trackId). A null id matches nothing: every
// catalogue id is a string.
const CatalogEntry* byTrackId(const std::vector<CatalogEntry>& catalog, const OptStr& trackId) {
  if (!trackId.has) return nullptr;
  for (const CatalogEntry& t : catalog) {
    if (t.id == trackId.v) return &t;
  }
  return nullptr;
}

}  // namespace

bool cupSlot(PickMode mode, const OptStr& cupId, const OptStr& trackId,
             const std::vector<Cup>& cups, const std::vector<CatalogEntry>& catalog,
             CupSlot& out) {
  if (mode == PickMode::CUP) {
    const Cup* cup = nullptr;
    if (cupId.has) {
      for (const Cup& c : cups) {
        if (c.id == cupId.v) { cup = &c; break; }
      }
    }
    // The catalogue is in CUPS order, so a cup's first entry carries its
    // difficulty. `t.cup === cupId` compares null to null too, which is how a
    // null pick lands on the cupless track's (absent) difficulty.
    const CatalogEntry* entry = nullptr;
    for (const CatalogEntry& t : catalog) {
      if (t.cup == cupId) { entry = &t; break; }
    }
    out = CupSlot{};
    out.nameKey = NameKey::CUP;
    out.name = cup ? OptStr::Of(cup->name) : OptStr::None();
    out.racesKey = RacesKey::COUNT;
    out.raceCount = OptNum::Of(cup ? static_cast<double>(cup->tracks.size()) : 4.0);
    out.difficulty = entry ? entry->cupDifficulty : OptNum::None();
    if (cup) {
      for (size_t i = 0; i < cup->tracks.size(); i++) {
        out.maps.push_back(MapChip{OptStr::Of(cup->tracks[i]), OptNum::Of(static_cast<double>(i + 1))});
      }
    }
    out.cupId = cupId;
    return true;
  }
  if (mode == PickMode::TRACK) {
    const CatalogEntry* entry = byTrackId(catalog, trackId);
    out = CupSlot{};
    out.nameKey = NameKey::TRACK;
    out.name = entry ? OptStr::Of(entry->name) : OptStr::None();
    out.racesKey = RacesKey::ONE;
    out.raceCount = OptNum::Of(1);
    out.difficulty = entry ? entry->cupDifficulty : OptNum::None();
    out.maps.push_back(MapChip{trackId, OptNum::None()});
    out.cupId = entry ? entry->cup : OptStr::None();
    return true;
  }
  if (mode == PickMode::RANDOM) {
    // An endless surprise series: the sticker sells the MODE, the mini shows
    // this round's draw (which is also what the lobby preview is orbiting).
    const CatalogEntry* entry = byTrackId(catalog, trackId);
    out = CupSlot{};
    out.nameKey = NameKey::RANDOM;
    out.name = OptStr::None();
    out.racesKey = RacesKey::ENDLESS;
    out.raceCount = OptNum::None();
    out.difficulty = OptNum::None();
    out.maps.push_back(MapChip{trackId, OptNum::None()});
    out.cupId = entry ? entry->cup : OptStr::None();
    return true;
  }
  return false;
}

// ---- dropped-seat reconnect cards -------------------------------------------

ReconnectDiff reconnectDiff(const std::vector<Id>& shownIds, const std::vector<Id>& seatIds) {
  const auto contains = [](const std::vector<Id>& v, const Id& id) {
    for (const Id& x : v) if (x == id) return true;
    return false;
  };
  ReconnectDiff d;
  for (const Id& id : shownIds) {
    if (!contains(seatIds, id)) d.remove.push_back(id);
  }
  for (size_t i = 0; i < seatIds.size(); i++) {
    if (!contains(shownIds, seatIds[i])) d.add.push_back(i);
  }
  return d;
}

// ---- the ITEM push ----------------------------------------------------------

ItemVal LastItems::get(const Id& id) const {
  for (const auto& kv : entries_) {
    if (kv.first == id) return kv.second;
  }
  return ItemVal::Absent();   // Map.get on a key nobody set: undefined
}

void LastItems::set(const Id& id, const ItemVal& item) {
  for (auto& kv : entries_) {
    if (kv.first == id) { kv.second = item; return; }   // Map.set keeps its place
  }
  entries_.emplace_back(id, item);
}

std::vector<ItemPush> itemPushes(const std::vector<PushCar>& cars, const IdSet& aiIds,
                                 const LastItems& lastItem) {
  std::vector<ItemPush> out;
  for (const PushCar& c : cars) {
    if (aiIds.has(c.id)) continue;   // no phone behind a bot
    // A finished car is on a victory lap with no usable slot. NOTE this rule
    // does NOT fold "" to null the way hudRows does — the recorded push for an
    // empty-string slot carries the empty string.
    const ItemVal item = c.finished ? ItemVal::Null() : c.item;
    if (lastItem.get(c.id) != item) out.push_back(ItemPush{c.id, item});
  }
  return out;
}

ItemVal welcomeItem(const PushCar* car) {
  return (car && !car->finished) ? car->item : ItemVal::Null();
}

// ---- race flow --------------------------------------------------------------

bool humansAllDone(const std::vector<Id>& carIds, const IdSet& aiIds,
                   const IdSet& disconnectedIds, const IdSet& finishedIds) {
  size_t humans = 0;
  for (const Id& id : carIds) {
    if (aiIds.has(id)) continue;
    if (disconnectedIds.has(id)) continue;   // a ghost can never finish
    humans++;
    if (!finishedIds.has(id)) return false;
  }
  return humans > 0;
}

std::vector<Id> forfeitCandidates(const std::vector<Id>& carIds, const IdSet& aiIds,
                                  const IdSet& disconnectedIds) {
  std::vector<Id> out;
  for (const Id& id : carIds) {
    if (!aiIds.has(id) && disconnectedIds.has(id)) out.push_back(id);
  }
  return out;
}

// ---- pause arbitration ------------------------------------------------------

bool canPause(bool hasSession, bool paused, RoomState roomState) {
  if (paused || !hasSession) return false;
  return roomState == RoomState::COUNTDOWN || roomState == RoomState::PLAYING;
}

bool canResume(bool hasSession, bool paused) { return paused && hasSession; }

const char* key(AutoPauseAction a) {
  switch (a) {
    case AutoPauseAction::RETURN_TO_LOBBY: return "return-to-lobby";
    case AutoPauseAction::SET: return "set";
    case AutoPauseAction::NONE: break;
  }
  return "none";
}

AutoPauseDecision autoPause(const AutoPauseInput& in, bool allParticipantsDisconnected) {
  AutoPauseDecision d;
  if (!in.hasSession || in.raceEnded) return d;
  if (in.roomState != RoomState::COUNTDOWN && in.roomState != RoomState::PLAYING) return d;
  // "Is any human seat still IN this race?" is game state, not room state: a
  // question about the live car list. A seat that leaves the room forfeits its
  // car, so a car whose owner is off the roster is transient and counts for
  // nobody.
  size_t humanCars = 0;
  for (const Id& id : in.carIds) {
    if (in.aiIds.has(id)) continue;
    if (in.seatedIds.has(id)) humanCars++;
  }
  if (!humanCars) {
    d.action = AutoPauseAction::RETURN_TO_LOBBY;
    return d;
  }
  d.action = AutoPauseAction::SET;
  d.asked = in.roomState == RoomState::PLAYING;
  d.hasAutoPaused = true;
  d.autoPaused = d.asked && allParticipantsDisconnected;
  return d;
}

bool autoPauseAsksParticipants(const AutoPauseInput& in) { return autoPause(in, false).asked; }

const char* key(FreezeMove m) {
  switch (m) {
    case FreezeMove::FREEZE: return "freeze";
    case FreezeMove::THAW: return "thaw";
    case FreezeMove::NONE: break;
  }
  return "none";
}

FreezeMove freezeTransition(bool paused, bool autoPaused, bool sessionPaused) {
  const bool frozen = paused || autoPaused;
  if (frozen && !sessionPaused) return FreezeMove::FREEZE;
  if (!frozen && sessionPaused) return FreezeMove::THAW;
  return FreezeMove::NONE;
}

// ---- the Grand Prix chip ----------------------------------------------------

SeriesInfo seriesInfo(const SeriesInput& in, const std::vector<CatalogEntry>& catalog) {
  const CatalogEntry* next = in.finished ? nullptr : byTrackId(catalog, in.nextTrackId);
  SeriesInfo o;
  o.cupId = in.cupId;
  o.cupName = in.cupName;
  o.endless = in.endless;
  o.raceIndex = in.raceIndex;
  o.raceCount = in.endless ? OptNum::None() : in.raceCount;
  o.nextTrackId = next ? OptStr::Of(next->id) : OptStr::None();
  o.nextTrackName = next ? OptStr::Of(next->name) : OptStr::None();
  o.isFinal = in.finished;
  o.autoAdvanceMs = in.autoAdvanceMs;
  return o;
}

// ---- the standings board ----------------------------------------------------

Board standingsPayload(const std::vector<ResultRow>& results,
                       const std::vector<FieldRow>& field,
                       const CupBoard* cup,
                       const std::vector<LateJoiner>& lateJoiners,
                       const Id& hostPeerIndex, bool over) {
  // new Map(field.map(...)): a repeated peerIndex means the LAST entry wins.
  const auto fieldFor = [&field](const Id& id) -> const FieldRow* {
    const FieldRow* found = nullptr;
    for (const FieldRow& p : field) {
      if (p.peerIndex == id) found = &p;
    }
    return found;
  };

  Board b;
  b.over = over;
  b.hostPeerIndex = hostPeerIndex;
  if (cup) {
    b.hasSeries = true;
    b.series = cup->info;
  }

  b.order.reserve(results.size() + lateJoiners.size());
  for (const ResultRow& res : results) {
    const FieldRow* p = fieldFor(res.playerId);
    BoardRow r;
    r.playerId = res.playerId;
    // An empty name is falsy in JS, so a nameless field row falls back to the
    // id exactly as an absent one does.
    r.name = (p && !p->name.empty()) ? p->name : idString(res.playerId);
    r.colorIndex = (p && p->colorIndex.has) ? p->colorIndex.v : 0.0;
    r.ai = p && p->ai;
    r.finished = res.finished;
    r.time = res.time;
    b.order.push_back(std::move(r));
  }

  if (cup) {
    // new Map(cup.standings.map((r, i) => [r.playerId, {row: r, seq: i}])) —
    // again last-wins, and `seq` is what the final board sorts on.
    const std::vector<StandingRow> empty;
    const std::vector<StandingRow>& std_ = cup->standings ? *cup->standings : empty;
    const size_t ABSENT = std_.size();   // stands in for Infinity: past every seq
    const auto seqOf = [&std_, ABSENT](const Id& id) -> size_t {
      size_t seq = ABSENT;
      for (size_t i = 0; i < std_.size(); i++) {
        if (std_[i].playerId == id) seq = i;
      }
      return seq;
    };
    for (BoardRow& o : b.order) {
      const size_t seq = seqOf(o.playerId);
      o.hasPoints = true;
      o.points = seq == ABSENT ? 0.0 : std_[seq].points;
      if (over) {
        o.hasGained = true;
        o.gained = seq == ABSENT ? 0.0 : std_[seq].gained;
      }
    }
    if (over) {
      // STABLE, and rows missing from the cup table keep their relative order:
      // JS's comparator is `Infinity - Infinity` for two of them, which is NaN,
      // and Array#sort reads a NaN comparator result as 0.
      std::stable_sort(b.order.begin(), b.order.end(),
                       [&](const BoardRow& x, const BoardRow& y) {
                         const size_t sx = seqOf(x.playerId), sy = seqOf(y.playerId);
                         if (sx == ABSENT && sy == ABSENT) return false;  // NaN -> +0
                         if (sx == ABSENT) return false;  // Infinity - seq > 0
                         if (sy == ABSENT) return true;   // seq - Infinity < 0
                         return sx < sy;
                       });
    }
  }

  // Anyone who joined mid-race has no car this round (the field is locked at
  // the start), so they are listed UNDER the racers, flagged `joining`.
  for (const LateJoiner& p : lateJoiners) {
    BoardRow r;
    r.playerId = p.peerIndex;
    r.name = p.name;
    r.colorIndex = p.colorIndex;
    r.joining = true;
    b.order.push_back(std::move(r));
  }
  return b;
}

// ---- the results overlay ----------------------------------------------------

const char* key(TitleKey k) {
  switch (k) {
    case TitleKey::STANDINGS: return "standings";
    case TitleKey::CUP_CHAMPS: return "cup_champs";
    case TitleKey::RESULTS: break;
  }
  return "results";
}

const char* key(SubKey k) {
  switch (k) {
    case SubKey::CUP_RACE_OF: return "cup_race_of";
    case SubKey::CUP_RACE: break;
  }
  return "cup_race";
}

const char* key(RowKind k) {
  switch (k) {
    case RowKind::POINTS: return "points";
    case RowKind::JOINING: return "joining";
    case RowKind::TIME: break;
  }
  return "time";
}

const char* key(NewGameKey k) {
  switch (k) {
    case NewGameKey::NEXT_RACE: return "next_race";
    case NewGameKey::NEW_GAME: break;
  }
  return "new_game";
}

ResultsView resultsView(const Board& board, double intermissionMs) {
  const SeriesInfo* s = board.hasSeries ? &board.series : nullptr;
  ResultsView v;
  v.podium = s && s->isFinal;
  v.intermission = s && !s->isFinal;
  v.titleKey = v.podium ? TitleKey::CUP_CHAMPS : (s ? TitleKey::STANDINGS : TitleKey::RESULTS);
  v.cupName = s ? s->cupName : OptStr::None();
  if (v.intermission) {
    v.hasSub = true;
    v.subKey = s->endless ? SubKey::CUP_RACE : SubKey::CUP_RACE_OF;
    v.subCupName = s->cupName;
    v.subRace = s->raceIndex + 1;
    v.subOf = s->endless ? OptNum::None() : s->raceCount;
  }
  if (v.podium) {
    v.hasPodiumRows = true;   // an empty podium is [] here, never null
    for (const BoardRow& r : board.order) {
      if (r.joining) continue;
      v.podiumRows.push_back(&r);
      if (v.podiumRows.size() == 3) break;
    }
  }
  // The list starts at index 3 of the RAW order on a podium — see the header:
  // a joining row inside the first three shortens the steps without shifting
  // this. Frozen on purpose.
  const size_t start = v.podium ? 3 : 0;
  for (size_t i = start; i < board.order.size(); i++) {
    const BoardRow& r = board.order[i];
    v.listRows.push_back(ListRow{&r, r.joining ? RowKind::JOINING
                                               : (s ? RowKind::POINTS : RowKind::TIME)});
  }
  if (v.intermission) {
    v.hasNext = true;
    v.nextTrackName = s->nextTrackName.has ? s->nextTrackName.v : std::string();
    v.nextSecs = ceilSecs(intermissionMs);
  }
  v.newGameKey = v.intermission ? NewGameKey::NEXT_RACE : NewGameKey::NEW_GAME;
  return v;
}

double intermissionSecs(double deadlineMs, double nowMs) {
  return js_max(0.0, ceilSecs(deadlineMs - nowMs));
}

}  // namespace ui
}  // namespace rt
}  // namespace ttp
