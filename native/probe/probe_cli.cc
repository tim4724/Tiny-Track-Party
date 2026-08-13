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
//   probe_cli packed             all four cars together, every grid rotation
//   probe_cli <mode> --track=ID  restrict to one track (quick iteration)
//   probe_cli <mode> --seed=N    item-roll RNG seed (default 1)
//   probe_cli <mode> --nobrake   force b=0: humans hold flat-out, so this is the
//                                pace/balance the couch actually sees
//   probe_cli laptime --json     one JSON object per track (probe-difficulty.mjs)
//
// Determinism: fixed 60 Hz step, AI personas taken from AiDriver.js's
// AI_PERSONALITIES, and the same seeds the JS probes used (the JS AiController
// defaults seed=1 when a persona omits it, which every persona does).
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "ttp/ai_driver.h"
#include "ttp/game.h"
#include "ttp/grand_prix.h"   // POINTS_BY_RANK
#include "ttp/protocol.h"
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
  if (hasStats) {
    st.accel = cs.accel; st.vmax = cs.vmax; st.turn = cs.turn;
    st.mass = cs.mass; st.halfLen = cs.halfLen; st.halfWid = cs.halfWid;
  }
  std::vector<PlayerDesc> players{PlayerDesc{Id::Num(0), hasStats, st}};
  Game game(players, bt.game, [](const Event&) {});
  AiController ai(AI_PERSONALITIES[0].caution, LOOKAHEAD, STEER_GAIN, AI_PERSONALITIES[0].laneBias, DEFAULT_AI_SEED);

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
  int races = 0;

  for (const std::string& id : trackIds(only)) {
    for (size_t rot = 0; rot < N; rot++) {
      // order[slot] = which car index starts in that grid slot
      std::vector<size_t> order(N);
      for (size_t i = 0; i < N; i++) order[i] = (i + rot) % N;

      BuiltRaceTrack bt; std::string err;
      if (!build_race_track_by_id(id, LAPS, seed, bt, err)) continue;

      std::vector<PlayerDesc> players;
      for (size_t slot = 0; slot < N; slot++) {
        const protocol::CarStat& cs = protocol::CAR_STATS[order[slot]];
        Stats st;
        st.accel = cs.accel; st.vmax = cs.vmax; st.turn = cs.turn;
        st.mass = cs.mass; st.halfLen = cs.halfLen; st.halfWid = cs.halfWid;
        players.push_back(PlayerDesc{Id::Num((double)slot), true, st});
      }
      Game game(players, bt.game, [](const Event&) {});
      std::vector<std::unique_ptr<AiController>> ais;
      for (size_t slot = 0; slot < N; slot++) {
        ais.push_back(std::make_unique<AiController>(AI_PERSONALITIES[slot].caution, LOOKAHEAD, STEER_GAIN,
                                                     AI_PERSONALITIES[slot].laneBias, DEFAULT_AI_SEED));
      }

      double t = 0;
      while (!game.raceOver() && t < MAX_S) {
        for (size_t slot = 0; slot < N; slot++) {
          Input out;
          if (noBrake) driveBotNoBrake(game, slot, *ais[slot], &out);
          else game.driveBot(Id::Num((double)slot), *ais[slot], &out);
        }
        game.update(DT_MS);
        t += DT_MS / 1000.0;
      }

      // Rank by the engine's own results board, then credit the CAR (not the slot).
      Value res = game.getResults();
      const Value* rows = nullptr;
      for (const auto& kv : res.obj) if (kv.first == "results") rows = &kv.second;
      if (!rows || rows->type != Value::ARR) continue;
      races++;
      for (const Value& row : rows->arr) {
        double slot = -1, rank = 0, time = 0; bool fin = false;
        for (const auto& kv : row.obj) {
          if (kv.first == "playerId") slot = kv.second.num;
          else if (kv.first == "rank") rank = kv.second.num;
          else if (kv.first == "finished") fin = kv.second.b;
          else if (kv.first == "time") time = kv.second.num;
        }
        if (slot < 0 || slot >= (double)N) continue;
        const size_t car = order[(size_t)slot];
        if (rank >= 1 && rank <= 4) points[car] += POINTS_BY_RANK[(int)rank - 1];
        if ((int)rank == 1) wins[car]++;
        if (fin) { timeSum[car] += time; finishes[car]++; }
      }
    }
  }

  std::printf("packed races: %d (all %zu cars, every grid rotation, collisions+items on)\n", races, N);
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

}  // namespace

int main(int argc, char** argv) {
  std::string mode, only;
  uint32_t seed = 1;
  bool json = false, noBrake = false;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a.compare(0, 8, "--track=") == 0) only = a.substr(8);
    else if (a.compare(0, 7, "--seed=") == 0) seed = (uint32_t)std::strtoul(a.substr(7).c_str(), nullptr, 10);
    else if (a == "--json") json = true;
    else if (a == "--nobrake") noBrake = true;
    else if (a.compare(0, 2, "--") == 0) { std::fprintf(stderr, "unknown option %s\n", a.c_str()); return 2; }
    else if (mode.empty()) mode = a;
    else { std::fprintf(stderr, "unexpected argument %s\n", a.c_str()); return 2; }
  }
  if (mode == "laptime") return runLaptime(only, seed, json, noBrake);
  if (mode == "matrix") return runMatrix(only, seed, noBrake);
  if (mode == "packed") return runPacked(only, seed, noBrake);
  std::fprintf(stderr, "usage: probe_cli <laptime|matrix|packed> [--track=ID] [--seed=N] [--nobrake] [--json]\n");
  return 2;
}
