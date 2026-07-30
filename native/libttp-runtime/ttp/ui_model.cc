#include "ttp/ui_model.h"

#include <algorithm>
#include <cmath>

#include "ttp/jsmath.h"   // js_max — Math.max's ±0 ordering, not std::max's
#include "ttp/race_track.h"  // find_track_def + generated/track_defs.h: the shipped catalogue

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

// JS Number.isInteger over a value already known to be a number: finite, and
// equal to its own floor. (NaN and the infinities both fail isfinite, which is
// the whole of what the JS check adds over the equality.)
bool isIntegerValue(double v) {
  return std::isfinite(v) && std::floor(v) == v;
}

}  // namespace

bool cupSlot(PickMode mode, const OptStr& cupId, const OptStr& trackId,
             const OptNum& randomRaces,
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
    // A surprise series: the sticker sells the MODE, the mini shows this round's
    // draw (which is also what the lobby preview is orbiting). Only race 1 is
    // known here — the rest of a fixed card is drawn as the series runs — so the
    // card promises a COUNT where a cup shows its four circuits.
    //
    // randomRaces is the run length the room SETTLED on: 0 endless, a positive
    // integer that many races. The wire's default for an absent length is applied
    // by the shell's clamp before a pick reaches this layer, so what arrives is
    // always a settled number. Anything else reads as endless — that is what
    // `random` meant before run lengths existed, so an older shell driving this
    // model gets the behaviour it was written against rather than a card with no
    // count on it. Matches uiModel.js's Number.isInteger(n) && n > 0.
    const CatalogEntry* entry = byTrackId(catalog, trackId);
    const bool endless = !(randomRaces.has && isIntegerValue(randomRaces.v) && randomRaces.v > 0);
    out = CupSlot{};
    out.nameKey = NameKey::RANDOM;
    out.name = OptStr::None();
    out.racesKey = endless ? RacesKey::ENDLESS : RacesKey::COUNT;
    out.raceCount = endless ? OptNum::None() : OptNum::Of(randomRaces.v);
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

// ---- the shipped catalogue ---------------------------------------------------
// The only place in this file that reads authored game data. Everything above
// it is catalogue-agnostic and stays that way — these functions PRODUCE the
// lists the rest of the layer is handed, they are not consulted by it.

int cupTendency(const CupDef& cup) {
  if (cup.difficulty != 0) return cup.difficulty;
  if (cup.nTracks <= 0) return 2;  // an empty cup cannot have a mean
  double sum = 0;
  for (int i = 0; i < cup.nTracks; i++) {
    const TrackDef* t = find_track_def(cup.tracks[i]);
    // A cup naming a track the catalogue does not hold cannot happen — the
    // codegen resolves both from one file — but the JS read it as the same
    // middling 2 an unlabelled track got, so this does too.
    sum += t ? (double) t->difficulty : 2.0;
  }
  return (int) std::lround(sum / (double) cup.nTracks);
}

std::vector<Cup> shippedCups() {
  std::vector<Cup> out;
  out.reserve((size_t) TTP_CUP_COUNT);
  for (int i = 0; i < TTP_CUP_COUNT; i++) {
    const CupDef& c = TTP_CUPS[i];
    Cup cup;
    cup.id = c.id;
    cup.name = c.name;
    cup.color = c.color;
    for (int t = 0; t < c.nTracks; t++) cup.tracks.push_back(c.tracks[t]);
    out.push_back(std::move(cup));
  }
  return out;
}

int cupFieldTintPct() { return TTP_CUP_FIELD_TINT_PCT; }

uint32_t cupTintRgb(const OptStr& cupId, double pct) {
  uint32_t base = TTP_CUP_COLOR_FALLBACK;
  if (cupId.has) {
    for (int i = 0; i < TTP_CUP_COUNT; i++) {
      if (cupId.v == TTP_CUPS[i].id) { base = TTP_CUPS[i].color; break; }
    }
  }
  // Clamped rather than trusted: `pct` comes from a shell, and a value outside
  // 0..100 would wrap the channel arithmetic into a colour nobody authored.
  const double k = (pct < 0 ? 0 : pct > 100 ? 100 : pct) / 100.0;
  uint32_t out = 0;
  for (int shift = 16; shift >= 0; shift -= 8) {
    const double c = (double) ((base >> shift) & 0xFF);
    // The other side of the mix is white, so the complement is 255 * (1 - k).
    const double mixed = c * k + 255.0 * (1.0 - k);
    const long v = std::lround(mixed);
    out |= ((uint32_t) (v < 0 ? 0 : v > 255 ? 255 : v)) << shift;
  }
  return out;
}

std::vector<CatalogEntry> shippedCatalog() {
  // CUPS order, flattened — the catalogue's own arrangement, which every picker
  // draws and which ttp_ui.h's contract requires ("a cup's difficulty is read
  // off its FIRST entry"). Walking the cups rather than TTP_TRACKS is what makes
  // that true by construction, and it is also what leaves the dev-only tracks
  // out: they belong to no cup, so they cannot appear in a player-visible list.
  std::vector<CatalogEntry> out;
  for (int i = 0; i < TTP_CUP_COUNT; i++) {
    const CupDef& c = TTP_CUPS[i];
    const int tendency = cupTendency(c);
    for (int t = 0; t < c.nTracks; t++) {
      const TrackDef* def = find_track_def(c.tracks[t]);
      if (!def) continue;
      CatalogEntry e;
      e.id = def->id;
      e.name = def->name;
      e.cup = OptStr::Of(c.id);
      e.cupDifficulty = OptNum::Of((double) tendency);
      out.push_back(std::move(e));
    }
  }
  return out;
}

}  // namespace ui
}  // namespace rt
}  // namespace ttp
