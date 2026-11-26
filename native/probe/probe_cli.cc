// probe_cli — the car/track BALANCE INSTRUMENTS, on the native engine.
//
// These are tuning tools, not conformance tests: they
// answer "is this car dominant?", "how long is a lap here?", "does weight pay off
// in traffic?". They were the last load-bearing reason the JS engine had to stay
// runnable in Node — the numbers a stat edit is judged by came out of it.
//
// Output formatting mirrors the JS scripts so a run is readable the same way, but
// THE NUMBERS ARE NOT INTERCHANGEABLE WITH OLD JS PROBE OUTPUT, because the JS
// probes carried two accidental quirks this does not reproduce:
//
//   1. They called `bot.drive(car, centerline)` — a 3-arg function invoked with 2 —
//      so the AI ran with NO game context: no hazard/pole/banana dodging, no
//      blocking or gap logic, no item use, and maxLat defaulted to 1.5 instead of
//      the track's. Solo pace was therefore measured on a car that drove straight
//      through oil.
//   2. They never set `track.seed`, so the engine's item-roll RNG ran unseeded.
//
// This drives bots exactly as a real race does (game passed, seed explicit), so it
// measures the pace cars actually achieve. That makes it a better instrument and a
// DIFFERENT baseline: re-read the matrix before trusting pre-existing stat notes.
//
//   probe_cli laptime            per-track lap time, one benchmark car
//   probe_cli matrix             car x track steady-state lap matrix + summary
//   probe_cli packed             all four cars together, every grid rotation; also how
//                                often an empty-handed car leaves a box row holding an item
//   probe_cli cost               CPU cost of a sim frame (see runCost)
//   probe_cli balance            HUMAN driver models (casual/regular/expert) in every
//                                car, raced through each cup's Grand Prix against its
//                                bots as a live cup seats them (see runBalance)
//   probe_cli balance --runs=N   Grand Prix per cup x driver x car (default 8)
//   probe_cli <mode> --track=ID  restrict to one track (quick iteration)
//   probe_cli <mode> --seed=N    item-roll RNG seed (default 1)
//   probe_cli <mode> --nobrake   force b=0: humans hold flat-out, so this is the
//                                pace/balance the couch actually sees
//   probe_cli laptime --json     one JSON object per track (probe-difficulty.mjs)
//   probe_cli <mode> --skill=X   bot skill 0..1 (AI_TIER_SKILL; default 1, the full bot)
//   probe_cli laptime --item=ID  every box rolls ID: what each item is worth to a solo lap
//
// Determinism: fixed 60 Hz step, AI personas taken from AiDriver.js's
// AI_PERSONALITIES, and the same seeds the JS probes used (the JS AiController
// defaults seed=1 when a persona omits it, which every persona does).
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "ttp/ai_driver.h"
#include "ttp/game.h"
#include "ttp/grand_prix.h"   // POINTS_BY_RANK, POINTS_RANKS, CupSeries
#include "ttp/protocol.h"
#include "ttp/race_session.h"
#include "ttp/race_track.h"

using namespace ttp;

namespace {

constexpr double DT_MS = 1000.0 / 60.0;

// ttp::AI_PERSONALITIES itself, not a copy of it. Persona 0 ("Bolt", the
// overdriver) is the single driver used by laptime + matrix, so the only variable
// there is the car; packed deals one per grid slot, in table order.
//
// This file used to hand-transcribe the four {caution, laneBias} pairs under a
// comment pointing at a JS file that no longer exists, which is the exact drift
// the tree single-sourced everywhere else (ttp_race_personas_json hands the same
// table to the shell rather than letting it keep one). A probe reading different
// personas from the game would not fail anything — it would just quietly report
// lap times for bots nobody races.
using ttp::AI_PERSONALITIES;
// The JS AiController's default seed when a persona carries none.
constexpr uint32_t DEFAULT_AI_SEED = 1;
// --skill: every bot this run drives. 1 = the full bot.
double g_skill = 1.0;
std::string g_item;  // --item=: every box rolls this (Game forceItem), "" = the roll table

std::string mmss(double secs) {
  const int m = (int)std::floor(secs / 60.0);
  const double s = secs - m * 60.0;
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%d:%04.1f", m, s);
  return buf;
}
std::string fixed(double v, int prec, int width) {
  char fmtbuf[16], buf[64];
  std::snprintf(fmtbuf, sizeof(fmtbuf), "%%%d.%df", width, prec);
  std::snprintf(buf, sizeof(buf), fmtbuf, v);
  return buf;
}
std::string padEnd(const std::string& s, size_t n) {
  std::string o = s;
  while (o.size() < n) o += ' ';
  return o;
}
std::string padStart(const std::string& s, size_t n) {
  std::string o = s;
  while (o.size() < n) o.insert(o.begin(), ' ');
  return o;
}

Stats statsOf(const protocol::CarStat& cs) {
  Stats st;
  st.accel = cs.accel; st.vmax = cs.vmax; st.turn = cs.turn;
  st.mass = cs.mass; st.halfLen = cs.halfLen; st.halfWid = cs.halfWid;
  return st;
}

// The engine's own results board, one row per car.
struct Placing { double id; int rank; bool finished; double time; };
std::vector<Placing> placings(Game& game) {
  std::vector<Placing> out;
  Value res = game.getResults();
  const Value* rows = res.find("results");
  if (!rows || rows->type != Value::ARR) return out;
  for (const Value& row : rows->arr) {
    Placing p{-1, 0, false, 0};
    for (const auto& kv : row.obj) {
      if (kv.first == "playerId") p.id = kv.second.num;
      else if (kv.first == "rank") p.rank = (int)kv.second.num;
      else if (kv.first == "finished") p.finished = kv.second.b;
      else if (kv.first == "time") p.time = kv.second.num;
    }
    out.push_back(p);
  }
  return out;
}

// Game::driveBot minus the brake: the AI decides steering and item use as in a
// real race, but the applied brake is forced to 0 — the flat-out driving humans
// actually do. `out` still reports the ASKED brake so brakeFrac keeps measuring
// what the track demands rather than what was applied. Relies on the same roster
// guarantee the rest of this file does: cars() is insertion order, so slot i is
// Id::Num(i).
bool driveBotNoBrake(Game& game, size_t slot, AiController& ai, Input* out) {
  Car* c = game.cars()[slot].get();
  if (!c || c->finished) return false;
  Input m = ai.drive(*c, *game.centerline(), game);
  if (out) *out = m;
  m.b = 0;
  game.processInput(Id::Num((double)slot), m);
  return true;
}

// One solo run: drive a single car with persona 0 and collect its lap splits.
// `laps` is the race distance; MAX_S caps a car that can never finish.
// brakeFracOut (optional): fraction of FLYING-lap frames the AI asked for brake
// (b > 0.15), i.e. how much of the lap this track makes a bot slow down for. The
// standing-start lap is excluded, as in the retired JS aiProbe.
std::vector<double> soloLaps(const std::string& trackId, int laps, bool hasStats,
                             const protocol::CarStat& cs, double maxS, uint32_t seed, bool noBrake,
                             double& totalOut, double* brakeFracOut = nullptr) {
  BuiltRaceTrack bt;
  std::string err;
  if (!build_race_track_by_id(trackId, laps, seed, bt, err)) { totalOut = 0; return {}; }

  Stats st;
  if (hasStats) st = statsOf(cs);
  std::vector<PlayerDesc> players{PlayerDesc{Id::Num(0), hasStats, st, true}};
  Game game(players, bt.game, [](const Event&) {}, g_item);
  AiController ai(AI_PERSONALITIES[0].caution, LOOKAHEAD, STEER_GAIN, AI_PERSONALITIES[0].laneBias, DEFAULT_AI_SEED,
                  g_skill);

  double t = 0, sum = 0;
  int lastLap = 0;
  long measured = 0, braking = 0;
  std::vector<double> splits;
  while (!game.raceOver() && t < maxS) {
    Input out;
    if (noBrake) driveBotNoBrake(game, 0, ai, &out);
    else game.driveBot(Id::Num(0), ai, &out);   // applies the control, like processInput(bot.drive(...))
    if (!game.cars().empty() && game.cars()[0]->lap >= 1) {
      measured++;
      if (out.b > 0.15) braking++;
    }
    game.update(DT_MS);
    t += DT_MS / 1000.0;
    // Game::find is private; cars() is the public roster (insertion order).
    const Car* car = game.cars().empty() ? nullptr : game.cars()[0].get();
    if (car && car->lap > lastLap) {
      // JS: laps.push(t - laps.reduce(sum)) — each split is elapsed minus the
      // splits banked so far, so `sum` trails the recorded total.
      splits.push_back(t - sum);
      sum = 0;
      for (double x : splits) sum += x;
      lastLap = car->lap;
    }
  }
  totalOut = t;
  if (brakeFracOut) *brakeFracOut = measured ? (double)braking / (double)measured : 0.0;
  return splits;
}

std::vector<std::string> trackIds(const std::string& only) {
  std::vector<std::string> ids;
  for (int i = 0; i < TTP_TRACK_COUNT; i++) {
    const std::string id = TTP_TRACKS[i].id;
    if (only.empty() || id == only) ids.push_back(id);
  }
  return ids;
}

// ---- laptime -----------------------------------------------------------------
// `json` emits one object per track instead of the human table: the difficulty
// report card (scripts/probe-difficulty.mjs) reads it, having lost the in-process
// aiProbe with the JS engine.
int runLaptime(const std::string& only, uint32_t seed, bool json, bool noBrake) {
  const int LAPS = 3;
  const double MAX_S = 600;
  for (const std::string& id : trackIds(only)) {
    double total = 0, brakeFrac = 0;
    protocol::CarStat none{};
    std::vector<double> splits = soloLaps(id, LAPS, false, none, MAX_S, seed, noBrake, total, &brakeFrac);
    // Flying laps only: the standing start is not representative pace (the matrix
    // mode does the same, and the retired JS aiProbe did too).
    double avg = 0;
    if (splits.size() > 1) {
      for (size_t i = 1; i < splits.size(); i++) avg += splits[i];
      avg /= (double)(splits.size() - 1);
    } else if (!splits.empty()) {
      avg = splits[0];
    }
    BuiltRaceTrack bt; std::string err;
    build_race_track_by_id(id, LAPS, seed, bt, err);
    if (json) {
      std::printf("{\"track\":\"%s\",\"length\":%s,\"lapSec\":%s,\"brakeFrac\":%s,\"laps\":%d}\n",
                  id.c_str(), fixed(bt.game.length, 3, 0).c_str(), fixed(avg, 1, 0).c_str(),
                  fixed(brakeFrac, 3, 0).c_str(), (int)splits.size());
      continue;
    }
    std::string lapList;
    for (size_t i = 0; i < splits.size(); i++) {
      if (i) lapList += ", ";
      lapList += fixed(splits[i], 1, 0);
    }
    std::printf("%s len=%s  lap≈%ss  brake=%s  race(%d)≈%s  laps=[%s]\n",
                padEnd(id, 11).c_str(), padStart(fixed(bt.game.length, 0, 0), 3).c_str(),
                padStart(fixed(avg, 1, 0), 5).c_str(), fixed(brakeFrac, 2, 0).c_str(), LAPS,
                padStart(mmss(total), 5).c_str(), lapList.c_str());
  }
  return 0;
}

// ---- matrix ------------------------------------------------------------------
// Steady-state lap: average laps 2..N so the standing start doesn't colour pace.
double steadyLap(const std::string& id, const protocol::CarStat& cs, int laps, double maxS, uint32_t seed, bool noBrake) {
  double total = 0;
  std::vector<double> splits = soloLaps(id, laps, true, cs, maxS, seed, noBrake, total);
  if (splits.size() > 1) {
    double sum = 0;
    for (size_t i = 1; i < splits.size(); i++) sum += splits[i];
    return sum / (double)(splits.size() - 1);
  }
  // Never completed a steady lap: fall back to lap 1, else the cap. A 0 here
  // would read as "fastest" and poison the table.
  return splits.empty() ? maxS : splits[0];
}

int runMatrix(const std::string& only, uint32_t seed, bool noBrake) {
  const int LAPS = 4;
  const double MAX_S = 600;
  const size_t N = protocol::CAR_STATS.size();

  std::string head = padEnd("track", 11) + "len  ";
  for (size_t i = 0; i < N; i++) head += padStart(protocol::CAR_NAMES[i], 8);
  head += "   spread winner";
  std::printf("%s\n", head.c_str());

  std::vector<int> wins(N, 0), worst(N, 0), rankSum(N, 0);
  int nTracks = 0;
  for (const std::string& id : trackIds(only)) {
    std::vector<double> times;
    for (size_t i = 0; i < N; i++) times.push_back(steadyLap(id, protocol::CAR_STATS[i], LAPS, MAX_S, seed, noBrake));
    const double fast = *std::min_element(times.begin(), times.end());
    const double slow = *std::max_element(times.begin(), times.end());
    const size_t wi = (size_t)(std::min_element(times.begin(), times.end()) - times.begin());
    const size_t li = (size_t)(std::max_element(times.begin(), times.end()) - times.begin());
    wins[wi]++; worst[li]++; nTracks++;

    std::vector<size_t> order(N);
    for (size_t i = 0; i < N; i++) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return times[a] < times[b]; });
    for (size_t r = 0; r < N; r++) rankSum[order[r]] += (int)r + 1;

    BuiltRaceTrack bt; std::string err;
    build_race_track_by_id(id, LAPS, seed, bt, err);
    std::string cells;
    for (size_t i = 0; i < N; i++) cells += padStart(fixed(times[i], 1, 0), 7) + (i == wi ? "*" : " ");
    std::printf("%s%s  %s  %s%% %s\n",
                padEnd(id, 11).c_str(), padStart(fixed(bt.game.length, 0, 0), 3).c_str(),
                cells.c_str(), padStart(fixed((slow - fast) / fast * 100.0, 1, 0), 5).c_str(),
                protocol::CAR_NAMES[wi].c_str());
  }
  std::printf("\nper-car summary (lower avgRank = faster overall; 1=always fastest, %zu=always slowest):\n", N);
  for (size_t i = 0; i < N; i++) {
    std::printf("  %s wins=%d  worst=%d  avgRank=%s\n",
                padEnd(protocol::CAR_NAMES[i], 8).c_str(), wins[i], worst[i],
                fixed(nTracks ? (double)rankSum[i] / nTracks : 0.0, 2, 0).c_str());
  }
  return 0;
}

// ---- packed ------------------------------------------------------------------
// All four cars on track together with collisions, items, hazards and traffic.
// Every car rotates through every grid/persona slot once, so slot and lane bias
// are sampled without making the probe too slow for routine tuning.
int runPacked(const std::string& only, uint32_t seed, bool noBrake) {
  const int LAPS = 3;
  const double MAX_S = 180;
  const size_t N = protocol::CAR_STATS.size();

  std::vector<int> points(N, 0), wins(N, 0);
  std::vector<double> timeSum(N, 0.0);
  std::vector<int> finishes(N, 0);
  int races = 0, emptyRows = 0, emptyGot = 0;

  for (const std::string& id : trackIds(only)) {
    for (size_t rot = 0; rot < N; rot++) {
      // order[slot] = which car index starts in that grid slot
      std::vector<size_t> order(N);
      for (size_t i = 0; i < N; i++) order[i] = (i + rot) % N;

      BuiltRaceTrack bt; std::string err;
      if (!build_race_track_by_id(id, LAPS, seed, bt, err)) continue;

      std::vector<PlayerDesc> players;
      for (size_t slot = 0; slot < N; slot++)
        players.push_back(PlayerDesc{Id::Num((double)slot), true, statsOf(protocol::CAR_STATS[order[slot]]), true});
      Game game(players, bt.game, [](const Event&) {});
      std::vector<std::unique_ptr<AiController>> ais;
      for (size_t slot = 0; slot < N; slot++) {
        ais.push_back(std::make_unique<AiController>(AI_PERSONALITIES[slot].caution, LOOKAHEAD, STEER_GAIN,
                                                     AI_PERSONALITIES[slot].laneBias, DEFAULT_AI_SEED, g_skill));
      }

      std::vector<double> rowS;
      for (const BoxRt& b : game.boxes())
        if (std::find(rowS.begin(), rowS.end(), b.s) == rowS.end()) rowS.push_back(b.s);
      const double L = game.length();
      std::vector<int> pending(game.cars().size(), -1);
      double t = 0;
      while (!game.raceOver() && t < MAX_S) {
        for (size_t slot = 0; slot < N; slot++) {
          Input out;
          if (noBrake) driveBotNoBrake(game, slot, *ais[slot], &out);
          else game.driveBot(Id::Num((double)slot), *ais[slot], &out);
        }
        std::vector<double> prevS;
        std::vector<bool> wasEmpty;
        for (const auto& c : game.cars()) { prevS.push_back(c->totalS); wasEmpty.push_back(c->item.empty()); }
        game.update(DT_MS);
        // An EMPTY-handed approach to a box row (2 m short of it), and whether the
        // car leaves it (2 m past) holding one. A box is taken before its centre,
        // so the centre itself is too late to ask "was the hand empty".
        auto crossed = [&](size_t i, double at) {
          return std::floor((prevS[i] - at) / L) != std::floor((game.cars()[i]->totalS - at) / L);
        };
        for (size_t i = 0; i < game.cars().size(); i++) {
          const Car& c = *game.cars()[i];
          for (size_t r = 0; r < rowS.size(); r++) {
            if (crossed(i, rowS[r] - 2) && wasEmpty[i] && !c.finished) pending[i] = (int)r;
            if (pending[i] == (int)r && crossed(i, rowS[r] + 2)) {
              emptyRows++;
              if (!c.item.empty()) emptyGot++;
              pending[i] = -1;
            }
          }
        }
        t += DT_MS / 1000.0;
      }

      // Rank by the engine's own results board, then credit the CAR (not the slot).
      const std::vector<Placing> board = placings(game);
      if (board.empty()) continue;
      races++;
      for (const Placing& p : board) {
        if (p.id < 0 || p.id >= (double)N) continue;
        const size_t car = order[(size_t)p.id];
        if (p.rank >= 1 && p.rank <= POINTS_RANKS) points[car] += POINTS_BY_RANK[p.rank - 1];
        if (p.rank == 1) wins[car]++;
        if (p.finished) { timeSum[car] += p.time; finishes[car]++; }
      }
    }
  }

  std::printf("packed races: %d (all %zu cars, every grid rotation, collisions+items on), "
              "empty-handed rows hit %d/%d\n",
              races, N, emptyGot, emptyRows);
  std::printf("%s%s%s%s%s\n", padEnd("car", 10).c_str(), padStart("points", 8).c_str(),
              padStart("wins", 6).c_str(), padStart("finished", 10).c_str(),
              padStart("avgTime", 10).c_str());
  for (size_t i = 0; i < N; i++) {
    std::printf("%s%s%s%s%s\n",
                padEnd(protocol::CAR_NAMES[i], 10).c_str(),
                padStart(std::to_string(points[i]), 8).c_str(),
                padStart(std::to_string(wins[i]), 6).c_str(),
                padStart(std::to_string(finishes[i]), 10).c_str(),
                padStart(finishes[i] ? fixed(timeSum[i] / finishes[i], 2, 0) : std::string("-"), 10).c_str());
  }
  return 0;
}

// ---- cost --------------------------------------------------------------------
// What a sim frame COSTS, in CPU microseconds. Nothing else in the tree can see
// this: `perf:race` measures the RENDERED frame, where the whole sim is ~10 us
// inside ~8000, three orders of magnitude under the noise, and the balance modes
// above report seconds of race time rather than seconds of CPU.
//
// So this exists to answer "what did that cost?" for a sim change — the
// collision passes are the worked example, at about 0.8 us each.
//
// It measures CPU time (std::clock), not wall-clock, because this tree is worked
// in many worktrees at once and a wall-clock reading taken while another build
// runs is noise. Min of three, for the same reason.
//
// The AI and the step are timed SEPARATELY: both run every frame in a real race,
// but they are different code owned by different changes, and a single total
// hides which one moved.
int runCost(const std::string& only, uint32_t seed, int cars) {
  const int LAPS = 3;
  const int FRAMES = 2400;          // 40 s of race at 60 Hz, well past the opening scrum
  const int REPS = 3;
  if (cars < 1) cars = 1;

  const std::vector<std::string> ids = trackIds(only);
  if (ids.empty()) { std::fprintf(stderr, "no such track\n"); return 2; }

  // Built once and reused: track building is not what is being measured.
  std::vector<BuiltRaceTrack> built;
  for (const std::string& id : ids) {
    BuiltRaceTrack bt; std::string err;
    if (build_race_track_by_id(id, LAPS, seed, bt, err)) built.push_back(std::move(bt));
  }
  if (built.empty()) { std::fprintf(stderr, "no track built\n"); return 2; }

  double bestAi = 1e18, bestStep = 1e18;
  long frames = 0;
  for (int rep = 0; rep < REPS; rep++) {
    double aiTicks = 0, stepTicks = 0;
    frames = 0;
    for (const BuiltRaceTrack& bt : built) {
      std::vector<PlayerDesc> players;
      for (int i = 0; i < cars; i++)
        players.push_back(PlayerDesc{Id::Num((double)i), true,
                                     statsOf(protocol::CAR_STATS[(size_t)i % protocol::CAR_STATS.size()]), true});
      Game game(players, bt.game, [](const Event&) {});
      std::vector<std::unique_ptr<AiController>> ais;
      for (int i = 0; i < cars; i++) {
        const Persona& p = AI_PERSONALITIES[(size_t)i % 7];
        ais.push_back(std::make_unique<AiController>(p.caution, LOOKAHEAD, STEER_GAIN,
                                                     p.laneBias, DEFAULT_AI_SEED));
      }
      for (int f = 0; f < FRAMES; f++) {
        std::clock_t t0 = std::clock();
        for (int i = 0; i < cars; i++) game.driveBot(Id::Num((double)i), *ais[(size_t)i], nullptr);
        std::clock_t t1 = std::clock();
        game.update(DT_MS);
        std::clock_t t2 = std::clock();
        aiTicks += (double)(t1 - t0);
        stepTicks += (double)(t2 - t1);
        frames++;
      }
    }
    const double us = 1e6 / (double)CLOCKS_PER_SEC;
    if (aiTicks * us / frames < bestAi) bestAi = aiTicks * us / frames;
    if (stepTicks * us / frames < bestStep) bestStep = stepTicks * us / frames;
  }

  const double budget = 1e6 / 60.0;   // one 60 Hz frame, in the same microseconds
  std::printf("\n# sim cost - %d cars - %zu track(s) - %d frames each - min of %d (CPU time)\n\n",
              cars, built.size(), FRAMES, REPS);
  std::printf("%-16s %10s %12s\n", "", "us/frame", "% of 60Hz");
  std::printf("%-16s %10.2f %11.3f%%\n", "bots (AI)", bestAi, 100 * bestAi / budget);
  std::printf("%-16s %10.2f %11.3f%%\n", "step (sim)", bestStep, 100 * bestStep / budget);
  std::printf("%-16s %10.2f %11.3f%%\n", "total", bestAi + bestStep,
              100 * (bestAi + bestStep) / budget);
  return 0;
}

// ---- balance -----------------------------------------------------------------
// Every mode above prices a car with the BOT at the wheel, and the bot is the
// wrong driver for the couch's question. It reacts on the frame, never wavers,
// and leans exactly as far as the corner asks, so its lap prices a car for
// nobody who plays.
//
// A driver model keeps the bot's INTENT (its line, its dodges, its box-seeking:
// what a player is trying to do) and puts a person between that intent and the
// car: a reaction delay, a hand that wanders, a lean that stops short, and a
// person's habits with the brake and the item button. DRIVERS is a first guess,
// to be fitted to real players: the "how they drive" table is what a logged
// player is compared against.
//
// Each model then races every cup the way a live cup runs it: an 8-car grid with
// the human starting last and each next race gridding on the last finish, the
// cup's bot skill, RaceSession's DNF ladder and CupSeries' points. One human
// per race, the single-player couch: the hardest seat to reach the top half from.
struct DriverModel {
  const char* name;
  double lagSec;  // reaction + the phone-to-screen path: the steer applied is the one wanted this long ago
  double noise;   // the hand's wander, steer units (1 = full lock = STEER.ROLL_LOCK_DEG of tilt)
  double cap;     // the furthest this player leans, steer units
  double slide;   // share of hard corners slid with the brake held through, 0..1
  bool aims;      // holds an item for its moment (the bot's rule), else fires it on pickup
};
const DriverModel DRIVERS[] = {
    {"casual", 0.30, 0.08, 0.75, 0.0, false},
    {"regular", 0.22, 0.05, 0.90, 0.5, true},
    {"expert", 0.15, 0.03, 1.00, 1.0, true},
};
constexpr int N_DRIVERS = (int)(sizeof(DRIVERS) / sizeof(DRIVERS[0]));
constexpr double HAND_TAU = 0.5;                    // s: how slowly the hand's wander turns over
constexpr double SLIDE_RELEASE = 0.2;               // the slide's brake comes up once the lean eases under this
constexpr double FIRE_MIN = 0.4, FIRE_SPAN = 0.8;   // s: a thumb that fires on pickup
constexpr int HUMAN = protocol::FIELD_SIZE - 1;     // the human's entrant id; bots are 0..HUMAN-1

class HumanDriver {
 public:
  HumanDriver(const DriverModel& m, uint32_t seed)
      : m_(m), intent_(1.0, LOOKAHEAD, STEER_GAIN, 0.0, seed, 1.0), rng_(seed ^ 0x68756d61u),
        lagFrames_((size_t)std::lround(m.lagSec * 60.0)) {}

  Input drive(Car& car, Game& game) {
    const Input want = intent_.drive(car, *game.centerline(), game);
    // The hand: an Ornstein-Uhlenbeck wander of standard deviation m_.noise.
    const double dt = DT_MS / 1000.0;
    const double g = (rng_.next() + rng_.next() + rng_.next() + rng_.next() - 2.0) * std::sqrt(3.0);
    hand_ += -hand_ * dt / HAND_TAU + m_.noise * std::sqrt(2.0 * dt / HAND_TAU) * g;
    seen_.push_back(std::max(-m_.cap, std::min(m_.cap, want.s + hand_)));
    double s = 0;   // nothing has reached the wheel yet: straight
    if (seen_.size() > lagFrames_) { s = seen_.front(); seen_.pop_front(); }

    // The slide, by the bot's own rule but on the steer this player applies.
    const bool hard = std::fabs(s) >= (hard_ ? SLIDE_RELEASE : DRIFT_START);
    if (hard && !hard_) slideCorner_ = rng_.next() < m_.slide;
    hard_ = hard;

    Input out;
    out.hasS = true; out.s = s;
    out.hasB = true; out.b = slideCorner_ && hard && (car.drifting || canStartSlide(car)) ? 1 : 0;
    out.hasU = true; out.u = m_.aims ? want.u : fireOnPickup(car);
    return out;
  }

 private:
  double fireOnPickup(const Car& car) {
    if (car.item != held_) {
      held_ = car.item;
      heldFor_ = 0;
      fireAt_ = FIRE_MIN + rng_.next() * FIRE_SPAN;
    }
    if (!held_.empty() && (heldFor_ += DT_MS / 1000.0) >= fireAt_) useSeq_ = (useSeq_ + 1) & 255;
    return useSeq_;
  }

  DriverModel m_;
  AiController intent_;
  Mulberry32 rng_;
  size_t lagFrames_;
  std::deque<double> seen_;
  double hand_ = 0;
  bool hard_ = false, slideCorner_ = false;
  std::string held_;
  double heldFor_ = 0, fireAt_ = 0;
  int useSeq_ = 0;
};

// What a driven car did, for the table a logged player is compared against.
struct DriveStats {
  long frames = 0, wall = 0, sand = 0, slide = 0;
  int spins = 0;
  void tally(const Car& c, double& prevSpinT) {
    frames++;
    wall += c.onWall;
    sand += c.onSand;
    slide += c.drifting;
    if (c.spinT > 0 && prevSpinT <= 0) spins++;
    prevSpinT = c.spinT;
  }
  void add(const DriveStats& o) { frames += o.frames; wall += o.wall; sand += o.sand; slide += o.slide; spins += o.spins; }
};

// The balance modes race many sessions at once. build_catalogue_track keeps a
// one-entry cache in statics, so building is the one step that must not overlap.
std::mutex g_trackMu;
bool buildTrack(const std::string& id, uint32_t seed, BuiltRaceTrack& bt) {
  std::lock_guard<std::mutex> lock(g_trackMu);
  std::string err;
  return build_race_track_by_id(id, protocol::TOTAL_LAPS, seed, bt, err);
}

template <class Job>
void runAll(size_t n, Job job) {
#ifdef __EMSCRIPTEN__
  for (size_t i = 0; i < n; i++) job(i);   // no threads in the wasm build
#else
  std::atomic<size_t> next{0};
  std::vector<std::thread> pool;
  const unsigned k = std::max(1u, std::thread::hardware_concurrency());
  for (unsigned w = 0; w < k; w++)
    pool.emplace_back([&] { for (size_t i; (i = next++) < n;) job(i); });
  for (std::thread& t : pool) t.join();
#endif
}

auto noEvent = [](const Event&) {};
auto noEnd = [](const Value&) {};
auto noTick = [](int) {};

// One human alone on a track: the flying-lap pace of a driver in a car, and how they drove it.
struct SoloOut { double lap = 0; int laps = 0; DriveStats st; };
SoloOut runSolo(const std::string& trackId, const DriverModel& model, size_t car, uint32_t seed) {
  SoloOut out;
  BuiltRaceTrack bt;
  if (!buildTrack(trackId, seed, bt)) return out;
  std::vector<PlayerDesc> players{PlayerDesc{Id::Num(0), true, statsOf(protocol::CAR_STATS[car]), false}};
  RaceSession session(players, bt.game, noEvent, noEnd, noTick);
  session.startCountdown(0);
  Game& game = session.engine();
  Car& c = *game.cars()[0];
  HumanDriver human(model, seed);
  double t = 0, lapStart = 0, prevSpinT = 0;
  int lastLap = 0;
  while (!session.ended()) {
    if (!c.finished) session.processInput(c.id, human.drive(c, game));
    session.update(DT_MS);
    t += DT_MS / 1000.0;
    if (!c.finished) out.st.tally(c, prevSpinT);
    if (c.lap > lastLap) {
      // Lap 1 is the standing start; the flying laps after it are the pace.
      if (lastLap >= 1) { out.lap += t - lapStart; out.laps++; }
      lapStart = t;
      lastLap = (int)c.lap;
    }
  }
  if (out.laps) out.lap /= out.laps;
  return out;
}

// One cup's Grand Prix with the human in `car` against the cup's bots. The bots'
// cars, personas and seeds come off `seed`, as a live cup deals them once per series.
const char* const SPIN_CAUSES[] = {"banana", "oil", "rocket", "monster"};
constexpr int N_CAUSES = 4;
struct GpOut {
  int final = 0, races = 0;
  int place[8] = {};
  double gap4[8] = {};    // s behind the car in 4th at the flag (0 when the human is 4th, < 0 ahead)
  bool timed[8] = {};     // both the human and 4th took the flag, so gap4 means something
  int spins[N_CAUSES] = {};
};
GpOut runGp(const CupDef& cup, const DriverModel& model, size_t car, uint32_t seed) {
  GpOut out;
  const size_t nCars = protocol::CAR_STATS.size();
  const double skill = aiSkillForTier(cup.difficulty);
  GpCup gc{cup.id, cup.name, std::vector<std::string>(cup.tracks, cup.tracks + cup.nTracks)};
  CupSeries series(gc);
  std::vector<GpFieldEntry> field;
  for (int e = 0; e <= HUMAN; e++) field.push_back(GpFieldEntry{Id::Num(e), "", e, e != HUMAN});

  std::vector<int> grid;   // entrants, pole first: the human starts last
  for (int e = 0; e <= HUMAN; e++) grid.push_back(e);
  for (int r = 0; r < cup.nTracks; r++) {
    const uint32_t raceSeed = seed * 1000u + (uint32_t)r + 1u;
    BuiltRaceTrack bt;
    if (!buildTrack(cup.tracks[r], raceSeed, bt)) return out;
    std::vector<PlayerDesc> players;
    for (int e : grid) {
      const size_t c = e == HUMAN ? car : (size_t)(e + seed) % nCars;
      players.push_back(PlayerDesc{Id::Num(e), true, statsOf(protocol::CAR_STATS[c]), e != HUMAN});
    }
    auto onEvent = [&out](const Event& ev) {
      if (ev.type != "spin" || !(ev.id == Id::Num(HUMAN))) return;
      for (int i = 0; i < N_CAUSES; i++) if (ev.cause == SPIN_CAUSES[i]) out.spins[i]++;
    };
    RaceSession session(players, bt.game, onEvent, noEnd, noTick);
    session.startCountdown(0);
    Game& game = session.engine();
    std::vector<std::unique_ptr<AiController>> bots;
    for (int e = 0; e < HUMAN; e++) {
      const Persona& p = AI_PERSONALITIES[(size_t)(e + seed) % 7];
      bots.push_back(std::make_unique<AiController>(
          p.caution, LOOKAHEAD, STEER_GAIN, p.laneBias, raceSeed + (uint32_t)e, skill,
          aiSeatMistakes(cup.botMistakes, e, HUMAN)));
    }
    Car* me = nullptr;
    for (const auto& c : game.cars()) if (c->id == Id::Num(HUMAN)) me = c.get();
    HumanDriver human(model, raceSeed ^ 0x9e3779b9u);
    while (!session.ended()) {
      for (int e = 0; e < HUMAN; e++) game.driveBot(Id::Num(e), *bots[(size_t)e], nullptr);
      if (!me->finished) session.processInput(me->id, human.drive(*me, game));
      session.update(DT_MS);
    }
    std::vector<GpResult> results;
    const Placing* mine = nullptr;
    const Placing* fourth = nullptr;
    const std::vector<Placing> board = placings(game);
    for (const Placing& p : board) {
      results.push_back(GpResult{Id::Num(p.id), p.rank, p.finished});
      if ((int)p.id == HUMAN) mine = &p;
      if (p.rank == 4) fourth = &p;
    }
    if (mine) out.place[r] = mine->rank;
    if (mine && fourth && mine->finished && fourth->finished) {
      out.timed[r] = true;
      out.gap4[r] = mine->time - fourth->time;
    }
    series.applyRace(results, field);
    series.advance();
    out.races++;
    grid.clear();
    for (const Id& id : series.lastRaceOrder()) grid.push_back((int)id.num);
  }
  const std::vector<GpStanding> table = series.standings();
  for (size_t i = 0; i < table.size(); i++)
    if ((int)table[i].playerId.num == HUMAN) out.final = (int)i + 1;
  return out;
}

int runBalance(uint32_t seed, int runs) {
  const size_t nCars = protocol::CAR_STATS.size();
  const int SOLO_SEEDS = 8;
  std::vector<std::string> tracks;    // the cups' tracks, in cup order
  std::vector<int> cupOf;
  for (int ci = 0; ci < TTP_CUP_COUNT; ci++)
    for (int t = 0; t < TTP_CUPS[ci].nTracks; t++) { tracks.push_back(TTP_CUPS[ci].tracks[t]); cupOf.push_back(ci); }

  // Jobs, flattened: solo = track x driver x car x seed, gp = cup x driver x car x run.
  const size_t nSolo = tracks.size() * N_DRIVERS * nCars * SOLO_SEEDS;
  const size_t nGp = (size_t)TTP_CUP_COUNT * N_DRIVERS * nCars * (size_t)runs;
  std::vector<SoloOut> solo(nSolo);
  std::vector<GpOut> gps(nGp);
  const std::clock_t t0 = std::clock();
  runAll(nSolo + nGp, [&](size_t i) {
    if (i < nSolo) {
      const size_t k = i % SOLO_SEEDS, car = i / SOLO_SEEDS % nCars, d = i / SOLO_SEEDS / nCars % N_DRIVERS;
      const size_t tr = i / SOLO_SEEDS / nCars / N_DRIVERS;
      solo[i] = runSolo(tracks[tr], DRIVERS[d], car, seed + (uint32_t)k);
    } else {
      const size_t j = i - nSolo;
      const size_t k = j % (size_t)runs, car = j / (size_t)runs % nCars, d = j / (size_t)runs / nCars % N_DRIVERS;
      const size_t ci = j / (size_t)runs / nCars / N_DRIVERS;
      gps[j] = runGp(TTP_CUPS[ci], DRIVERS[d], car, seed + (uint32_t)k);
    }
  });
  const double cpu = (double)(std::clock() - t0) / CLOCKS_PER_SEC;
  auto soloAt = [&](size_t tr, size_t d, size_t car, size_t k) -> const SoloOut& {
    return solo[((tr * N_DRIVERS + d) * nCars + car) * SOLO_SEEDS + k];
  };
  auto gpAt = [&](size_t ci, size_t d, size_t car, size_t k) -> const GpOut& {
    return gps[((ci * N_DRIVERS + d) * nCars + car) * (size_t)runs + k];
  };
  auto pct = [](int n, int of) { return padStart(std::to_string(of ? (int)std::lround(100.0 * n / of) : 0), 4) + "%"; };

  std::printf("# balance: human drivers against each cup's bots, run as a live cup runs\n");
  std::printf("# %d-car grid, the human starts last, then grids on the last finish; %d laps; DNF ladder\n",
              protocol::FIELD_SIZE, protocol::TOTAL_LAPS);
  std::printf("# %d Grands Prix per cup x driver x car, solo pace over %d seeds per track (%.0f s CPU)\n\n",
              runs, SOLO_SEEDS, cpu);
  std::printf("drivers (a first guess, to be fitted to logged players):\n");
  for (const DriverModel& m : DRIVERS)
    std::printf("  %-8s lag %3.0f ms  hand %.2f  leans to %.2f  slides %3.0f%%  items %s\n", m.name,
                m.lagSec * 1000, m.noise, m.cap, m.slide * 100, m.aims ? "aimed" : "on pickup");

  std::string carHead;
  for (size_t c = 0; c < nCars; c++) carHead += padStart(protocol::CAR_NAMES[c], 7);

  std::printf("\nthe cup: final standing (share of Grands Prix), and its single races\n");
  std::printf("%-9s%-10s%8s%8s%6s%11s%7s%9s  spins/race: ban  oil  rkt  mon   top 4 by car:%s\n", "driver",
              "cup", "top 4", "podium", "win", "race top4", "place", "gap 4th", carHead.c_str());
  for (int d = 0; d < N_DRIVERS; d++) {
    for (int ci = 0; ci < TTP_CUP_COUNT; ci++) {
      int n = 0, top = 0, pod = 0, win = 0, races = 0, raceTop = 0, placeSum = 0, timed = 0;
      int spins[N_CAUSES] = {};
      double gapSum = 0;
      std::string byCar;
      for (size_t car = 0; car < nCars; car++) {
        int carN = 0, carTop = 0;
        for (int k = 0; k < runs; k++) {
          const GpOut& g = gpAt((size_t)ci, (size_t)d, car, (size_t)k);
          if (!g.final) continue;
          n++; carN++;
          if (g.final <= 4) { top++; carTop++; }
          if (g.final <= 3) pod++;
          if (g.final == 1) win++;
          for (int r = 0; r < g.races; r++) {
            races++;
            placeSum += g.place[r];
            if (g.place[r] <= 4) raceTop++;
            if (g.timed[r]) { timed++; gapSum += g.gap4[r]; }
          }
          for (int i = 0; i < N_CAUSES; i++) spins[i] += g.spins[i];
        }
        byCar += padStart(std::to_string(carN ? (int)std::lround(100.0 * carTop / carN) : 0), 7);
      }
      std::string spinCells;
      for (int i = 0; i < N_CAUSES; i++) spinCells += fixed(races ? (double)spins[i] / races : 0, 1, 5);
      std::printf("%-9s%-10s%8s%8s%6s%11s%7s%9s%12s%s%15s%s\n", DRIVERS[d].name, TTP_CUPS[ci].id,
                  pct(top, n).c_str(), pct(pod, n).c_str(), pct(win, n).c_str(), pct(raceTop, races).c_str(),
                  fixed(races ? (double)placeSum / races : 0, 1, 0).c_str(),
                  timed ? fixed(gapSum / timed, 1, 0).c_str() : "-", "", spinCells.c_str(), "", byCar.c_str());
    }
  }

  std::printf("\nsolo pace: flying lap, %% behind the fastest car for that driver, track by track\n");
  std::printf("%-9s%-10s%s%9s\n", "driver", "cup", carHead.c_str(), "lap s");
  for (int d = 0; d < N_DRIVERS; d++) {
    std::vector<double> allBehind(nCars, 0);
    int allTracks = 0;
    for (int ci = 0; ci <= TTP_CUP_COUNT; ci++) {   // the extra row is the whole catalogue
      const bool all = ci == TTP_CUP_COUNT;
      std::vector<double> behind(nCars, 0);
      double lapSum = 0;
      int nTracks = 0;
      for (size_t tr = 0; tr < tracks.size(); tr++) {
        if (all || cupOf[tr] != ci) continue;
        std::vector<double> lap(nCars, 0);
        for (size_t car = 0; car < nCars; car++) {
          for (int k = 0; k < SOLO_SEEDS; k++) lap[car] += soloAt(tr, (size_t)d, car, (size_t)k).lap;
          lap[car] /= SOLO_SEEDS;
        }
        const double best = *std::min_element(lap.begin(), lap.end());
        for (size_t car = 0; car < nCars; car++) {
          behind[car] += 100.0 * (lap[car] - best) / best;
          lapSum += lap[car] / nCars;
        }
        nTracks++;
      }
      if (all) { behind = allBehind; nTracks = allTracks; }
      std::string cells;
      for (size_t car = 0; car < nCars; car++) {
        cells += padStart("+" + fixed(nTracks ? behind[car] / nTracks : 0, 1, 0), 7);
        if (!all) allBehind[car] += behind[car];
      }
      if (!all) allTracks += nTracks;
      std::printf("%-9s%-10s%s%9s\n", DRIVERS[d].name, all ? "all" : TTP_CUPS[ci].id, cells.c_str(),
                  all ? "" : fixed(nTracks ? lapSum / nTracks : 0, 1, 0).c_str());
    }
  }

  std::printf("\nhow they drive: solo, per lap of the race, every car (compare a logged player here)\n");
  std::printf("%-9s%-10s%8s%8s%8s%8s%8s\n", "driver", "cup", "lap s", "curb s", "sand s", "slide s", "spins");
  for (int d = 0; d < N_DRIVERS; d++) {
    for (int ci = 0; ci < TTP_CUP_COUNT; ci++) {
      DriveStats st;
      double lapSum = 0;
      int laps = 0, runsN = 0;
      for (size_t tr = 0; tr < tracks.size(); tr++) {
        if (cupOf[tr] != ci) continue;
        for (size_t car = 0; car < nCars; car++)
          for (int k = 0; k < SOLO_SEEDS; k++) {
            const SoloOut& o = soloAt(tr, (size_t)d, car, (size_t)k);
            st.add(o.st);
            lapSum += o.lap;
            laps += protocol::TOTAL_LAPS;
            runsN++;
          }
      }
      auto perLap = [&](long frames) { return fixed(laps ? frames / 60.0 / laps : 0, 2, 8); };
      std::printf("%-9s%-10s%8s%s%s%s%8s\n", DRIVERS[d].name, TTP_CUPS[ci].id,
                  fixed(runsN ? lapSum / runsN : 0, 1, 0).c_str(), perLap(st.wall).c_str(),
                  perLap(st.sand).c_str(), perLap(st.slide).c_str(),
                  fixed(laps ? (double)st.spins / laps : 0, 2, 0).c_str());
    }
  }
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  std::string mode, only;
  uint32_t seed = 1;
  int cars = protocol::FIELD_SIZE;
  int runs = 8;
  bool json = false, noBrake = false;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a.compare(0, 8, "--track=") == 0) only = a.substr(8);
    else if (a.compare(0, 7, "--seed=") == 0) seed = (uint32_t)std::strtoul(a.substr(7).c_str(), nullptr, 10);
    else if (a == "--json") json = true;
    else if (a == "--nobrake") noBrake = true;
    else if (a.compare(0, 8, "--skill=") == 0) g_skill = std::strtod(a.substr(8).c_str(), nullptr);
    else if (a.compare(0, 7, "--item=") == 0) g_item = a.substr(7);
    else if (a.compare(0, 7, "--cars=") == 0) cars = (int)std::strtol(a.substr(7).c_str(), nullptr, 10);
    else if (a.compare(0, 7, "--runs=") == 0) runs = std::max(1, (int)std::strtol(a.substr(7).c_str(), nullptr, 10));
    else if (a.compare(0, 2, "--") == 0) { std::fprintf(stderr, "unknown option %s\n", a.c_str()); return 2; }
    else if (mode.empty()) mode = a;
    else { std::fprintf(stderr, "unexpected argument %s\n", a.c_str()); return 2; }
  }
  if (mode == "laptime") return runLaptime(only, seed, json, noBrake);
  if (mode == "matrix") return runMatrix(only, seed, noBrake);
  if (mode == "packed") return runPacked(only, seed, noBrake);
  if (mode == "cost") return runCost(only, seed, cars);
  if (mode == "balance") return runBalance(seed, runs);
  std::fprintf(stderr,
               "usage: probe_cli <laptime|matrix|packed|cost|balance> [--track=ID] [--seed=N] "
               "[--cars=N] [--runs=N] [--skill=X] [--item=ID] [--nobrake] [--json]\n");
  return 2;
}
