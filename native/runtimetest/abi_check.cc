// C ABI conformance check — drives runtime/ttp_runtime.h through its EXPORTED C
// entry points, the same surface public/display/engine/native/ttp_runtime.mjs
// hands the browser.
//
// WHY THIS EXISTS. The glue in runtime/ttp_runtime.cc + ttp_party.cc (~1500
// lines: handle tables, JSON marshalling, session-vs-bare-Game dispatch) used to
// be compiled by exactly ONE target — the emscripten browser module. ctest
// therefore never saw it: every other check links the libraries directly and
// calls C++ objects. Its only test was tests/runtime-abi.test.js in Node, which
// replays one trace and touches ten exports, so 21 of the 58 declared entry
// points were exercised by nothing anywhere. Marshalling bugs (a wrong key, a
// dropped null, an id parsed as the wrong JSON type) live exactly here and are
// invisible to a check that talks to Game directly.
//
// Three parts:
//   1. TRACE THROUGH THE ABI — replays a golden trace via ttp_process_input /
//      ttp_update and demands the recorded per-frame hash + events back out of
//      ttp_snapshot_json / ttp_events_json. Same fixture and recipe as the Node
//      test, but it now runs on every platform leg (linux/macOS/wasm/tvOS).
//   2. CUP SERIES THROUGH THE ABI — replays grandprix-corpus.jsonl through
//      ttp_gp_*, so the JS-recorded scoring oracle also covers the marshalled
//      path (standings JSON, the ""-means-null next track, JSON-scalar ids).
//   3. BOUNDARY + MUTATION EXPORTS — the rest of the surface, each asserted
//      against its documented contract in ttp_runtime.h.
//
// Part 3 is a behavioural gate, not conformance evidence: no JS twin of the glue
// survives to record an oracle from, so the assertions encode what the header
// PROMISES. Where a promise is vague the check asserts self-consistency instead
// of inventing a number.

#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "corpus_diff.h"  // read_line + diff_val
#include "ttp/canonical.h"
#include "ttp_runtime.h"

using namespace ttp;
using namespace ttp::corpus;

namespace {

int failures = 0;
int checks = 0;

void fail(const std::string& what) {
  if (++failures <= 25) std::fprintf(stderr, "FAIL %s\n", what.c_str());
}

void check(bool ok, const std::string& what) {
  checks++;
  if (!ok) fail(what);
}

// ---------------------------------------------------------------------------
// Part 1: a golden trace, through the ABI.
// ---------------------------------------------------------------------------
bool traceThroughAbi(const std::string& path) {
  std::ifstream in(path);
  if (!in) { fail("cannot open trace " + path); return false; }

  std::string line;
  if (!std::getline(in, line)) { fail("empty trace"); return false; }
  Value header;
  std::string err;
  if (!read_line(line, header, &err)) { fail("trace header: " + err); return false; }

  const std::string trackId = header.find("trackId")->str;
  const uint32_t seed = (uint32_t)header.find("seed")->num;
  const int laps = (int)header.find("laps")->num;
  const double dt = header.find("dt")->num;

  const int h = ttp_session_begin(trackId.c_str(), seed, laps, nullptr);
  if (h <= 0) { fail("ttp_session_begin returned " + std::to_string(h)); return false; }

  // The fixture was recorded on a BARE Game, so every car is added as a human
  // (no internal AI) and every recorded input is fed in. Keep the JSON-scalar id
  // text per car: String(id) is the recorded input key, but `3` and `"3"` are
  // different ids to the ABI, so the roster's own JSON form is what we replay.
  std::vector<std::pair<std::string, std::string>> keyToIdJson;  // String(id) -> id JSON
  for (const Value& r : header.find("roster")->arr) {
    const Value* id = r.find("id");
    const std::string idJson = canonical_stringify(*id);
    const std::string key = id->type == Value::STR ? id->str : js_number_to_string(id->num);
    keyToIdJson.emplace_back(key, idJson);
    ttp_add_human(h, idJson.c_str(), nullptr);
  }
  ttp_session_start(h, -1);  // no countdown: racing from frame 0, bare-Game equivalent
  check(ttp_racing(h) == 1, "ttp_racing == 1 immediately in no-countdown mode");

  int frames = 0, badHash = 0, badEvents = 0;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value rec;
    if (!read_line(line, rec, &err)) { fail("trace frame: " + err); return false; }

    if (const Value* inputs = rec.find("inputs")) {
      for (const auto& kv : inputs->obj) {
        if (kv.second.type == Value::UNDEF) continue;
        const std::string* idJson = nullptr;
        for (const auto& m : keyToIdJson) if (m.first == kv.first) { idJson = &m.second; break; }
        if (!idJson) { fail("input for unknown car key " + kv.first); return false; }

        const Value* s = kv.second.find("s");
        const Value* b = kv.second.find("b");
        const Value* u = kv.second.find("u");
        int mask = 0;
        if (s && s->type == Value::NUM) mask |= 1;
        if (b && (b->type == Value::NUM || b->type == Value::BOOL)) mask |= 2;
        if (u && u->type == Value::NUM) mask |= 4;
        const double bv = !b ? 0.0 : (b->type == Value::BOOL ? (b->b ? 1.0 : 0.0) : b->num);
        ttp_process_input(h, idJson->c_str(), mask, s ? s->num : 0.0, bv, u ? u->num : 0.0);
      }
    }
    ttp_update(h, dt);
    frames++;

    // Snapshot hash: the canonical serializer end-to-end, through the ABI's
    // own string buffer.
    const std::string hash = fnv1a_hex(ttp_snapshot_json(h));
    const Value* want = rec.find("hash");
    if (want && hash != want->str) {
      if (badHash++ == 0) {
        fail("frame " + js_number_to_string(rec.find("frame")->num) +
             ": snapshot hash " + hash + ", recorded " + want->str);
      }
    }

    // ttp_events_json also carries the reconstructed session beats
    // (_countdown/_raceStart/_raceEnd); the fixture records only race events.
    Value got;
    if (!read_line(ttp_events_json(h), got, &err)) { fail("events json: " + err); return false; }
    Value filtered = Value::Arr();
    for (const Value& e : got.arr) {
      const Value* t = e.find("type");
      if (t && !t->str.empty() && t->str[0] == '_') continue;
      filtered.push(e);
    }
    const Value* recEvents = rec.find("events");
    Value empty = Value::Arr();
    const Diff d = diff_val(recEvents ? *recEvents : empty, filtered, "events");
    if (d.differ && badEvents++ == 0) {
      fail("frame " + js_number_to_string(rec.find("frame")->num) + " events at " +
           d.path + ": recorded " + d.expected + ", actual " + d.actual);
    }
  }

  check(badHash == 0, "every frame's snapshot hash matched (" + std::to_string(badHash) + " bad)");
  check(badEvents == 0, "every frame's events matched (" + std::to_string(badEvents) + " bad)");
  ttp_dispose(h);
  std::printf("  trace through the ABI: %d frames\n", frames);
  return badHash == 0 && badEvents == 0;
}

// ---------------------------------------------------------------------------
// Part 2: the cup-series corpus, through ttp_gp_*.
// ---------------------------------------------------------------------------
bool gpThroughAbi(const std::string& path) {
  std::ifstream in(path);
  if (!in) { fail("cannot open gp corpus " + path); return false; }

  std::string line;
  if (!std::getline(in, line)) { fail("empty gp corpus"); return false; }

  int scripts = 0, bad = 0;
  std::string err;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    if (!read_line(line, root, &err)) { fail("gp corpus: " + err); return false; }
    if (root.has("bagCase")) continue;  // ShuffleBag is C++-internal; grandprix_check owns it

    const Value* config = root.find("config");
    const Value* cup = config->find("cup");
    const bool endless = config->find("endless")->b;

    const int g = ttp_gp_create(canonical_stringify(*cup).c_str(), endless ? 1 : 0);
    if (g <= 0) { fail("ttp_gp_create returned " + std::to_string(g)); return false; }
    scripts++;
    const std::string name = root.find("name")->str;

    int step = 0;
    for (const Value& s : root.find("steps")->arr) {
      const std::string op = s.find("op")->str;
      const Value* digest = s.find("digest");

      if (op == "applyRace") {
        // Endless draws are the HOST's in this ABI (ttp_gp_apply_race takes the
        // next draw as an argument, so the page RNG stays out of the sim). The
        // corpus recorded a C++-side bag, so replay its appended id as the draw:
        // the tracks list in the digest names it.
        std::string drawn;
        if (endless) {
          const Value* tracks = digest->find("tracks");
          if (tracks && !tracks->arr.empty()) drawn = tracks->arr.back().str;
        }
        const Value* field = s.find("field");
        Value emptyArr = Value::Arr();
        ttp_gp_apply_race(g,
                          canonical_stringify(*s.find("results")).c_str(),
                          canonical_stringify(field ? *field : emptyArr).c_str(),
                          endless && !drawn.empty() ? drawn.c_str() : nullptr);
      } else if (op == "advance") {
        ttp_gp_advance(g);
      } else if (op == "rekey") {
        ttp_gp_rekey(g,
                     canonical_stringify(*s.find("oldId")).c_str(),
                     canonical_stringify(*s.find("newId")).c_str());
      }

      // Rebuild the recorded digest from the ABI's own getters.
      Value got = Value::Obj();
      got.set("raceIndex", Value::Num((double)ttp_gp_race_index(g)));
      got.set("raceCount", Value::Num((double)ttp_gp_race_count(g)));
      got.set("currentTrackId", Value::Str(ttp_gp_current_track(g)));
      const std::string next = ttp_gp_next_track(g);
      got.set("nextTrackId", next.empty() ? Value::Null() : Value::Str(next));
      got.set("finished", Value::Bool(ttp_gp_finished(g) != 0));
      got.set("endless", Value::Bool(ttp_gp_endless(g) != 0));
      Value cupBack;
      if (!read_line(ttp_gp_cup_json(g), cupBack, &err)) { fail("gp cup json: " + err); return false; }
      got.set("tracks", cupBack.find("tracks") ? *cupBack.find("tracks") : Value::Arr());
      Value standings;
      if (!read_line(ttp_gp_standings_json(g), standings, &err)) { fail("gp standings: " + err); return false; }
      got.set("standings", standings);

      const Diff d = diff_val(*digest, got, "digest");
      if (d.differ) {
        bad++;
        if (failures < 25) {
          fail(name + " step " + std::to_string(step) + " (" + op + ") at " + d.path +
               ": recorded " + d.expected + ", actual " + d.actual);
        }
        break;
      }
      step++;
    }
    ttp_gp_dispose(g);
  }
  check(bad == 0, "cup-series corpus through the ABI (" + std::to_string(bad) + " scripts diverged)");
  std::printf("  cup series through the ABI: %d scripts\n", scripts);
  return bad == 0;
}

// ---------------------------------------------------------------------------
// Part 3: the boundary + mutation exports.
// ---------------------------------------------------------------------------
void boundaryExports() {
  // ---- error paths first: they must not need a valid handle.
  check(ttp_session_begin("no-such-track", 1u, 3, nullptr) == 0,
        "ttp_session_begin on an unknown trackId returns 0");
  check(ttp_has_car(0, "\"nobody\"") == 0, "ttp_has_car on handle 0 returns 0");
  check(ttp_car_finished(0, "\"nobody\"") == -1, "ttp_car_finished on handle 0 returns -1");
  check(std::strcmp(ttp_car_ids_json(0), "[]") == 0, "ttp_car_ids_json on handle 0 returns []");
  check(ttp_force_remove_car(0, "0") == 0, "ttp_force_remove_car on handle 0 returns 0");
  check(ttp_rekey_car(0, "0", "1") == 0, "ttp_rekey_car on handle 0 returns 0");
  double junk[3] = {-1, -1, -1};
  check(ttp_car_world_pos(0, "0", junk) == 0, "ttp_car_world_pos on handle 0 returns 0");
  check(junk[0] == -1 && junk[1] == -1 && junk[2] == -1,
        "a failed ttp_car_world_pos leaves out3 untouched");
  check(ttp_track_point(0, 0, 0, nullptr) == 0, "ttp_track_point with a null out3 returns 0");

  // ---- the version blob the adapter sanity-checks against.
  {
    Value v;
    std::string err;
    check(read_line(ttp_version(), v, &err), "ttp_version is valid JSON");
    check(v.has("contractVersion"), "ttp_version carries contractVersion");
    const Value* m = v.find("mathlib");
    check(m && !m->str.empty(), "ttp_version carries a non-empty mathlib stamp");
  }

  // ---- the global steer-expo tunable round-trips (and is restored).
  {
    const double was = ttp_get_steer_expo();
    ttp_set_steer_expo(was + 0.25);
    check(ttp_get_steer_expo() == was + 0.25, "ttp_set_steer_expo round-trips");
    ttp_set_steer_expo(was);
    check(ttp_get_steer_expo() == was, "steer expo restored");
  }

  // ---- a REAL RaceSession (countdown >= 0), which is the only path that reaches
  // RaceSession::pause/resume/rekeyCar/forceRemoveCar/fastForwardToEnd. The bare
  // no-countdown path used by the trace replay bypasses all of them.
  const int h = ttp_session_begin("tidepool", 42u, 3, nullptr);
  check(h > 0, "ttp_session_begin('tidepool') returns a handle");
  ttp_add_human(h, "0", nullptr);
  ttp_add_human(h, "\"phone-2\"", nullptr);
  ttp_add_bot(h, "\"ai-0\"", 1.0, -0.6, 218u, nullptr);
  ttp_add_bot(h, "\"ai-1\"", 0.97, 0.6, 219u, nullptr);
  ttp_session_start(h, 3);

  check(ttp_racing(h) == 0, "not racing during the countdown");
  check(ttp_paused(h) == 0, "not paused at the start");

  // Numeric and string ids must stay distinct through the JSON-scalar contract:
  // `0` is a car, `"0"` is not.
  check(ttp_has_car(h, "0") == 1, "ttp_has_car finds the numeric id 0");
  check(ttp_has_car(h, "\"0\"") == 0, "the string \"0\" is NOT the numeric id 0");
  check(ttp_has_car(h, "\"ai-0\"") == 1, "ttp_has_car finds a string id");
  check(ttp_has_car(h, "\"nobody\"") == 0, "ttp_has_car misses an unknown id");
  check(ttp_car_finished(h, "\"nobody\"") == -1, "ttp_car_finished is -1 for an unknown id");
  check(ttp_car_finished(h, "0") == 0, "ttp_car_finished is 0 for a racing car");

  {
    Value ids;
    std::string err;
    check(read_line(ttp_car_ids_json(h), ids, &err), "ttp_car_ids_json is valid JSON");
    check(ids.arr.size() == 4, "ttp_car_ids_json lists all four cars");
  }

  // ---- the two out3 writers, cross-checked against the snapshot rather than
  // merely asserted finite: the snapshot carries each car's pose.pos and its
  // (totalS, lat), so both writers have an independent second opinion inside the
  // same ABI. A swapped or zeroed component fails here.
  {
    Value snap;
    std::string err;
    check(read_line(ttp_snapshot_json(h), snap, &err), "ttp_snapshot_json is valid JSON");
    const Value* cars = snap.find("cars");
    const Value* car0 = nullptr;
    if (cars) {
      for (const Value& c : cars->arr) {
        const Value* id = c.find("id");
        if (id && id->type == Value::NUM && id->num == 0) { car0 = &c; break; }
      }
    }
    check(car0 != nullptr, "the snapshot carries the numeric-id car");
    if (car0) {
      const Value* p = car0->find("pose")->find("pos");
      double pos[3] = {0, 0, 0};
      check(ttp_car_world_pos(h, "0", pos) == 1, "ttp_car_world_pos succeeds for a live car");
      char seen[256];
      std::snprintf(seen, sizeof seen, " (abi %.17g,%.17g,%.17g vs snapshot %.17g,%.17g,%.17g)",
                    pos[0], pos[1], pos[2],
                    p->find("x")->num, p->find("y")->num, p->find("z")->num);
      check(pos[0] == p->find("x")->num && pos[1] == p->find("y")->num &&
            pos[2] == p->find("z")->num,
            std::string("ttp_car_world_pos agrees with the snapshot's pose.pos, "
                        "component for component") + seen);

      // ttp_track_point walks the centerline the car is driving, so the point at
      // the car's own (s, lat) sits essentially under the car. Distance, not
      // equality: the car's pose carries ride height and body attitude too.
      const double s = car0->find("totalS")->num;
      const double lat = car0->find("lat")->num;
      double tp[3] = {0, 0, 0};
      check(ttp_track_point(h, s, lat, tp) == 1, "ttp_track_point succeeds");
      const double dx = tp[0] - pos[0], dz = tp[2] - pos[2];
      check(std::sqrt(dx * dx + dz * dz) < 0.5,
            "ttp_track_point at the car's own (s,lat) lands under the car");
    }
  }

  // Run the countdown out, then a few racing frames.
  for (int i = 0; i < 200; i++) ttp_update(h, 1000.0 / 60.0);
  check(ttp_racing(h) == 1, "racing after the countdown elapses");

  // ---- pause freezes the sim: the snapshot must not move across an update.
  ttp_pause(h);
  check(ttp_paused(h) == 1, "ttp_paused reports the pause");
  const std::string frozen = ttp_snapshot_json(h);
  ttp_update(h, 1000.0 / 60.0);
  check(ttp_snapshot_json(h) == frozen, "ttp_update is a no-op while paused");
  ttp_resume(h);
  check(ttp_paused(h) == 0, "ttp_paused clears on resume");
  ttp_update(h, 1000.0 / 60.0);
  check(ttp_snapshot_json(h) != frozen, "the sim moves again after resume");

  // ---- rekey moves a car to a new id, keeping the field size.
  check(ttp_rekey_car(h, "0", "9") == 1, "ttp_rekey_car succeeds for a live car");
  check(ttp_has_car(h, "9") == 1, "the car answers to its new id");
  check(ttp_has_car(h, "0") == 0, "the car no longer answers to the old id");
  check(ttp_rekey_car(h, "0", "9") == 0, "rekeying a vanished id fails");

  // ---- force-finish puts a car on the results board with the synthetic time.
  ttp_force_finish(h, "9", 12.5);
  check(ttp_car_finished(h, "9") == 1, "ttp_car_finished reports a force-finished car");
  {
    Value results;
    std::string err;
    check(read_line(ttp_results_json(h), results, &err), "ttp_results_json is valid JSON");
    bool found = false;
    const Value* rows = results.find("results");
    if (rows) {
      for (const Value& r : rows->arr) {
        const Value* pid = r.find("playerId");
        if (pid && pid->type == Value::NUM && pid->num == 9) {
          found = true;
          const Value* t = r.find("time");
          check(t && t->num == 12.5, "the force-finished time is on the board");
        }
      }
    }
    check(found, "the force-finished car appears in ttp_results_json");
  }

  // ---- force-remove takes a car off the field.
  check(ttp_force_remove_car(h, "\"ai-1\"") == 1, "ttp_force_remove_car succeeds");
  check(ttp_has_car(h, "\"ai-1\"") == 0, "the removed car is gone");
  check(ttp_force_remove_car(h, "\"ai-1\"") == 0, "removing it twice fails");

  // ---- fast-forward drives the remaining bots to the flag and ends the race.
  ttp_fast_forward(h);
  check(ttp_racing(h) == 0, "the race is over after ttp_fast_forward");
  {
    Value results;
    std::string err;
    check(read_line(ttp_results_json(h), results, &err), "results parse after fast-forward");
    const Value* rows = results.find("results");
    check(rows && !rows->arr.empty(), "fast-forward produced a finishing board");
  }

  // ---- dispose invalidates the handle (and disposing twice is safe).
  ttp_dispose(h);
  check(ttp_has_car(h, "9") == 0, "a disposed handle has no cars");
  check(ttp_car_finished(h, "9") == -1, "a disposed handle answers -1");
  ttp_dispose(h);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: abi_check <grandprix-corpus.jsonl> <trace.jsonl>...\n");
    return 2;
  }
  std::printf("abi check:\n");
  // More than one trace, because the marshalling a trace exercises is only the
  // marshalling its recorded inputs contain: tidepool's four bots never brake, so
  // on that fixture alone ttp_process_input's brake bit could be deleted outright
  // and every frame would still hash correctly. helix carries 402 braking inputs.
  for (int i = 2; i < argc; i++) traceThroughAbi(argv[i]);
  gpThroughAbi(argv[1]);
  boundaryExports();

  std::printf("  %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
