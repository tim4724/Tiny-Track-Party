// Catalogue sweep — races EVERY shipped track and pins what happened.
//
// The golden traces cover race dynamics on three tracks (tidepool, helix,
// skysnake). The other seventeen were proven only as GEOMETRY: trackbuilder and
// sampler corpora cover all twenty, so the road is right, but nothing checked that
// cars, bots, items and hazards behave on it. A change to cornering, to the item
// roll, or to a hazard radius could leave the three traced tracks byte-identical
// and quietly alter the seventeen the traces never race.
//
// Two things are asserted per track:
//
//   1. FROZEN DIGEST. Snapshot hashes at fixed frame checkpoints plus each car's
//      end state, compared against tests/fixtures/catalogue-sweep-corpus.jsonl.
//      This is C++-AUTHORED evidence, NOT cross-implementation evidence: the JS
//      engine was gone before it existed, so it proves "the sim still does what it
//      did when this was recorded" and nothing about JS parity. The golden traces
//      remain the only artifacts that speak to parity. Re-record deliberately with
//      --record when a sim change is intended, exactly like a golden trace.
//
//   2. ORDER INDEPENDENCE. The whole catalogue is raced again in REVERSE order and
//      every digest must be unchanged. Racing twenty tracks in one process, twice,
//      in two orders is the widest cheap net we have for state that survives a Game
//      — the failure mode that cost a real bug (a racing-line cache keyed by a
//      recycled Centerline*) and that every one-race-per-process fixture is blind to.
//
//      Be clear about which half does the work. Reinstating that bug was measured
//      against this check: the frozen digest fails on 18 of 20 tracks, while the
//      reverse pass reports between 1 and 9 order dependencies depending on the
//      frame budget, because whether two races collide on an address is the
//      allocator's business. So the digest is the reliable detector and the reverse
//      pass is an opportunistic second opinion that can name the leak for what it
//      is. Neither replaces race_isolation, which FORCES the collision with
//      placement new and therefore fails deterministically.
//
// Usage: catalogue_sweep_check <corpus.jsonl>
//        catalogue_sweep_check --record --out=<f>

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

#include "corpus_diff.h"
#include "ttp/ai_driver.h"
#include "ttp/canonical.h"
#include "ttp/game.h"
#include "ttp/race_track.h"

using namespace ttp;
using namespace ttp::corpus;

namespace {

// A FULL LAP, not a slice. 400 frames (the first draft) moved the cars ~12% of a
// lap: they never reached a second corner, so most of each track went unraced and
// the gate only looked broad. At 60 Hz a catalogue lap is 40-55 s, so 3300 frames
// clears one everywhere, through every corner, hazard, item box and the lap seam —
// 3600 rather than 3300 so that even avalanche (the longest track, and the slowest
// lap) crosses the line, which puts lap counting on the byte path for all 20.
// Cost of the whole sweep, both passes: about 3 s.
const int FRAMES = 3600;
const int CHECKPOINT = 300;  // hash the snapshot every CHECKPOINT frames
const double DT = 1000.0 / 60.0;
const int LAPS = 3;

// The trace personas, so the sweep exercises the same AI differentiation the
// golden traces do (caution x laneBias is what separates the bots).
struct Persona { const char* id; double caution, laneBias; uint32_t aiSeed; };
const Persona PERSONAS[] = {
    {"cpu-bolt", 1.05, -0.6, 218u},
    {"cpu-pixel", 1.0, 0.6, 219u},
    {"cpu-rusty", 0.97, -0.25, 220u},
    {"cpu-zippy", 0.94, 0.25, 221u},
};

// A per-track seed that is a pure function of the id, so the corpus never depends
// on catalogue ORDER (adding a track must not renumber everyone else's race).
constexpr size_t BOTS = sizeof(PERSONAS) / sizeof(PERSONAS[0]);

uint32_t seedFor(const std::string& id) {
  uint32_t h = 2166136261u;
  for (char ch : id) { h ^= (unsigned char)ch; h *= 16777619u; }
  return h ? h : 1u;
}

// One race, digested. Deliberately does NOT include the whole snapshot: hashes at
// checkpoints catch any divergence, and the end state makes a failure readable.
Value raceDigest(const std::string& trackId, std::string& err) {
  BuiltRaceTrack bt;
  if (!build_race_track_by_id(trackId, LAPS, seedFor(trackId), bt, err)) return Value();

  std::vector<PlayerDesc> players;
  for (const Persona& p : PERSONAS) players.push_back(PlayerDesc{Id::Str(p.id), false, Stats{}});

  Game game(players, bt.game, [](const Event&) {});
  std::vector<AiController> ais;
  ais.reserve(BOTS);
  for (const Persona& p : PERSONAS) {
    ais.emplace_back(p.caution, LOOKAHEAD, STEER_GAIN, p.laneBias, p.aiSeed);
  }

  Value hashes = Value::Arr();
  for (int f = 1; f <= FRAMES; f++) {
    for (size_t i = 0; i < BOTS; i++) {
      Input in;
      game.driveBot(Id::Str(PERSONAS[i].id), ais[i], &in);
    }
    game.update(DT);
    if (f % CHECKPOINT == 0) hashes.push(Value::Str(fnv1a_hex(canonical_stringify(game.getSnapshot()))));
  }

  Value d = Value::Obj();
  d.set("trackId", Value::Str(trackId));
  d.set("seed", Value::Num((double)seedFor(trackId)));
  d.set("frames", Value::Num((double)FRAMES));
  d.set("length", Value::Num(bt.game.length));
  d.set("hashes", std::move(hashes));

  Value cars = Value::Arr();
  for (const auto& c : game.cars()) {
    Value o = Value::Obj();
    o.set("id", c->id.toValue());
    o.set("totalS", Value::Num(c->totalS));
    o.set("lat", Value::Num(c->lat));
    o.set("v", Value::Num(c->v));
    o.set("lap", Value::Num(c->lap));
    o.set("rank", Value::Num((double)c->rank));
    cars.push(std::move(o));
  }
  d.set("cars", std::move(cars));
  return d;
}

}  // namespace

int main(int argc, char** argv) {
  bool record = false;
  std::string outPath, corpusPath;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    if (a == "--record") record = true;
    else if (a.rfind("--out=", 0) == 0) outPath = a.substr(6);
    else corpusPath = a;
  }
  if (!record && corpusPath.empty()) {
    std::fprintf(stderr, "usage: catalogue_sweep_check <corpus.jsonl> | --record --out=<f>\n");
    return 2;
  }

  // Forward pass over the catalogue, in declaration order.
  std::vector<std::string> ids;
  for (int i = 0; i < TTP_TRACK_COUNT; i++) ids.push_back(TTP_TRACKS[i].id);

  std::vector<Value> forward;
  std::string err;
  for (const std::string& id : ids) {
    Value d = raceDigest(id, err);
    if (d.type != Value::OBJ) { std::fprintf(stderr, "FAIL %s: %s\n", id.c_str(), err.c_str()); return 2; }
    forward.push_back(std::move(d));
  }

  if (record) {
    if (outPath.empty()) { std::fprintf(stderr, "--record needs --out=<file>\n"); return 2; }
    std::ofstream out(outPath, std::ios::binary);
    if (!out) { std::fprintf(stderr, "cannot write %s\n", outPath.c_str()); return 2; }
    Value header = Value::Obj();
    header.set("kind", Value::Str("catalogue-sweep"));
    header.set("tracks", Value::Num((double)ids.size()));
    header.set("frames", Value::Num((double)FRAMES));
    header.set("checkpoint", Value::Num((double)CHECKPOINT));
    header.set("laps", Value::Num((double)LAPS));
    out << canonical_stringify(header) << "\n";
    for (const Value& d : forward) out << canonical_stringify(d) << "\n";
    std::printf("recorded %zu tracks to %s\n", forward.size(), outPath.c_str());
    return 0;
  }

  // ---- 1. compare the forward pass against the frozen corpus.
  std::ifstream in(corpusPath);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", corpusPath.c_str()); return 2; }
  std::string line;
  if (!std::getline(in, line)) { std::fprintf(stderr, "empty corpus\n"); return 2; }

  int failures = 0, compared = 0;
  size_t idx = 0;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value want;
    if (!read_line(line, want, &err)) { std::fprintf(stderr, "parse error: %s\n", err.c_str()); return 2; }
    if (idx >= forward.size()) {
      std::fprintf(stderr, "FAIL corpus has more tracks than the catalogue\n");
      failures++;
      break;
    }
    const Diff d = diff_val(want, forward[idx], "track");
    if (d.differ) {
      failures++;
      if (failures <= 10) {
        std::fprintf(stderr, "FAIL %s at %s\n  recorded %s\n  actual   %s\n",
                     want.find("trackId") ? want.find("trackId")->str.c_str() : "?",
                     d.path.c_str(), d.expected.c_str(), d.actual.c_str());
      }
    }
    compared++;
    idx++;
  }
  if (compared != (int)forward.size()) {
    std::fprintf(stderr, "FAIL corpus covers %d tracks, catalogue has %zu — re-record\n",
                 compared, forward.size());
    failures++;
  }

  // ---- 2. reverse pass: same races, opposite order, same digests.
  int orderDiffs = 0;
  for (size_t i = ids.size(); i-- > 0;) {
    Value again = raceDigest(ids[i], err);
    if (again.type != Value::OBJ) { std::fprintf(stderr, "FAIL %s: %s\n", ids[i].c_str(), err.c_str()); return 2; }
    const Diff d = diff_val(forward[i], again, "track");
    if (d.differ) {
      orderDiffs++;
      if (orderDiffs <= 10) {
        std::fprintf(stderr,
                     "FAIL %s raced differently in reverse catalogue order at %s\n"
                     "  forward %s\n  reverse %s\n"
                     "  => state survived a Game and coloured a later race\n",
                     ids[i].c_str(), d.path.c_str(), d.expected.c_str(), d.actual.c_str());
      }
    }
  }

  std::printf("catalogue sweep: %d tracks x %d frames, %d digest failures, "
              "%d order dependencies\n",
              compared, FRAMES, failures, orderDiffs);
  return (failures == 0 && orderDiffs == 0) ? 0 : 1;
}
