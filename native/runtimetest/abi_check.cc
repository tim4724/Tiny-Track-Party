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
#include "ttp_party.h"
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

// ---------------------------------------------------------------------------
// Part 4: the PARTY ABI (ttp_party.h) — the room state machine, the relay framing
// and the fastlane netcode, all as C entry points.
//
// Same gap as the runtime ABI had, one file over: ttp_party.cc was compiled by the
// emscripten target alone, so ctest never saw its 58 exports. tests/party-abi.test.js
// covers them in Node against the shipped wasm, which is real coverage of the wasm the
// browser loads — but it leaves the desktop and tvOS legs blind, and those legs are
// exactly where a native shell would consume this ABI.
//
// The room replay below is a port of that Node test's corpus walk. Both replaying the
// SAME roomflow-corpus is the point: the JS-recorded oracle now reaches the C boundary
// on every platform rather than on one.
// ---------------------------------------------------------------------------

// A peer id crosses the ABI as a JSON scalar — `3` and `"3"` are different peers.
std::string idJson(const Value* v) {
  if (!v || v->type == Value::UNDEF) return "null";
  return canonical_stringify(*v);
}

Value parseOrNull(const char* text, const char* what) {
  Value v;
  std::string err;
  if (!read_line(text ? text : "null", v, &err)) {
    fail(std::string(what) + ": invalid JSON from the ABI (" + err + ")");
    return Value::Null();
  }
  return v;
}

bool roomCorpusThroughAbi(const std::string& path) {
  std::ifstream in(path);
  if (!in) { fail("cannot open room corpus " + path); return false; }

  std::string line;
  if (!std::getline(in, line)) { fail("empty room corpus"); return false; }
  Value header;
  std::string err;
  if (!read_line(line, header, &err)) { fail("room corpus header: " + err); return false; }

  {
    Value v = parseOrNull(ttp_party_version(), "ttp_party_version");
    const Value* layer = v.find("layer");
    check(layer && layer->str == "party", "ttp_party_version reports the party layer");
    check(v.has("contractVersion"), "ttp_party_version carries contractVersion");
  }

  int scripts = 0, steps = 0, slotCases = 0, bad = 0;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value rec;
    if (!read_line(line, rec, &err)) { fail("room corpus: " + err); return false; }

    // lowestFreeSlot lines are a static helper with no handle.
    if (const Value* sc = rec.find("slotCase")) {
      const std::string used = canonical_stringify(*sc->find("used"));
      const int max = (int)sc->find("max")->num;
      const int want = (int)sc->find("expect")->num;
      if (ttp_room_lowest_free_slot(used.c_str(), max) != want) {
        bad++;
        fail("ttp_room_lowest_free_slot(" + used + ", " + std::to_string(max) + ") != " +
             std::to_string(want));
      }
      slotCases++;
      continue;
    }

    // Rebuild the room from the recorded config, mirroring the JS side: `master`
    // present at all means a masterProvider exists; `liveness` absent disables it.
    const Value* cfg = rec.find("config");
    Value abiCfg = Value::Obj();
    if (cfg) {
      const Value* ump = cfg->find("useMasterProvider");
      if (ump && ump->b) {
        const Value* m = cfg->find("master");
        abiCfg.set("master", m ? *m : Value::Null());
      }
      if (const Value* lv = cfg->find("liveness")) abiCfg.set("liveness", *lv);
    }
    const int h = ttp_room_create(canonical_stringify(abiCfg).c_str());
    if (h <= 0) { fail("ttp_room_create returned " + std::to_string(h)); return false; }
    scripts++;
    const std::string name = rec.find("name") ? rec.find("name")->str : "?";

    int si = 0;
    for (const Value& step : rec.find("steps")->arr) {
      const Value* op = step.find("op");
      const std::string kind = op->find("op")->str;
      const std::string p = idJson(op->find("p"));
      Value ret;  // UNDEF unless this op returns something the corpus recorded

      if (kind == "add") {
        const Value* f = op->find("fields");
        Value fields = f ? *f : Value::Obj();
        ret = parseOrNull(ttp_room_add_player(h, p.c_str(),
                                              canonical_stringify(fields).c_str()), "add_player");
      } else if (kind == "remove") {
        ttp_room_remove_player(h, p.c_str());
      } else if (kind == "rekey") {
        ret = Value::Bool(ttp_room_rekey(h, idJson(op->find("oldId")).c_str(),
                                         idJson(op->find("newId")).c_str()) == 1);
      } else if (kind == "markDisc") {
        ttp_room_mark_disconnected(h, p.c_str());
      } else if (kind == "markReconn") {
        ttp_room_mark_reconnected(h, p.c_str());
      } else if (kind == "clearDisc") {
        const Value* t = op->find("t");
        ttp_room_clear_disconnected(h, t ? 1 : 0, t ? t->num : 0.0);
      } else if (kind == "transition") {
        ret = Value::Bool(ttp_room_transition_to(h, op->find("to")->str.c_str()) == 1);
      } else if (kind == "endGame") {
        ret = Value::Bool(ttp_room_transition_to(h, "results") == 1);
      } else if (kind == "returnToLobby") {
        ret = Value::Bool(ttp_room_transition_to(h, "lobby") == 1);
      } else if (kind == "setOrder") {
        const Value* o = op->find("order");
        Value order = o ? *o : Value::Arr();
        ttp_room_set_active_order(h, canonical_stringify(order).c_str());
      } else if (kind == "seen") {
        ttp_room_on_seen(h, p.c_str(), op->find("t")->num);
      } else if (kind == "isExpired") {
        ret = Value::Bool(ttp_room_is_expired(h, p.c_str(), op->find("t")->num) == 1);
      } else if (kind == "expiredPeers") {
        ret = parseOrNull(ttp_room_expired_peers_json(h, op->find("t")->num), "expired_peers");
      } else if (kind == "graceTick") {
        ret = Value::Bool(ttp_room_grace_tick(h, op->find("t")->num) == 1);
      } else if (kind == "setMaster") {
        ttp_room_set_master(h, idJson(op->find("v")).c_str());
      } else if (kind == "setLivenessEnabled") {
        const Value* v = op->find("v");
        ttp_room_set_liveness_enabled(h, (v && v->b) ? 1 : 0);
      } else if (kind == "reset") {
        ttp_room_reset(h);
      } else if (kind == "setField") {
        const Value* val = op->find("value");
        const std::string key = op->find("key")->str;
        const bool applied = ttp_room_set_field(h, p.c_str(), key.c_str(),
                                                idJson(val).c_str()) == 1;
        if (applied) {
          Value back = parseOrNull(ttp_room_get_json(h, p.c_str()), "get_json");
          const Value* got = back.type == Value::OBJ ? back.find(key) : nullptr;
          ret = got ? *got : Value::Null();
        } else {
          ret = Value::Null();
        }
      } else {
        fail(name + " step " + std::to_string(si) + ": unknown op '" + kind + "'");
        return false;
      }

      // Events emitted during THIS op, in order — the queue drains per op, so
      // ordering across the boundary is asserted, not just membership.
      Value events = parseOrNull(ttp_room_events_json(h), "events_json");
      if (const Value* want = step.find("events")) {
        const Diff d = diff_val(*want, events, "events");
        if (d.differ) {
          bad++;
          fail(name + " step " + std::to_string(si) + " (" + kind + ") events at " + d.path +
               ": recorded " + d.expected + ", actual " + d.actual);
        }
      }
      if (const Value* want = step.find("ret")) {
        const Diff d = diff_val(*want, ret, "ret");
        if (d.differ) {
          bad++;
          fail(name + " step " + std::to_string(si) + " (" + kind + ") ret at " + d.path +
               ": recorded " + d.expected + ", actual " + d.actual);
        }
      }

      if (const Value* d0 = step.find("digest")) {
        Value got = Value::Obj();
        got.set("state", Value::Str(ttp_room_state(h)));
        got.set("host", parseOrNull(ttp_room_host_json(h), "host_json"));
        got.set("size", Value::Num((double)ttp_room_size(h)));
        got.set("connectedCount", Value::Num((double)ttp_room_connected_count(h)));
        got.set("list", parseOrNull(ttp_room_list_json(h), "list_json"));
        got.set("allDisconnected", Value::Bool(ttp_room_all_participants_disconnected(h) != 0));
        got.set("hasLateJoiners", Value::Bool(ttp_room_has_late_joiners(h) != 0));
        Value pp = Value::Arr();
        if (const Value* recorded = d0->find("perPeer")) {
          for (const Value& e : recorded->arr) {
            const std::string pj = idJson(e.find("p"));
            Value o = Value::Obj();
            o.set("p", e.find("p") ? *e.find("p") : Value::Null());
            o.set("has", Value::Bool(ttp_room_has(h, pj.c_str()) != 0));
            o.set("isHost", Value::Bool(ttp_room_is_host(h, pj.c_str()) != 0));
            o.set("disc", Value::Bool(ttp_room_is_disconnected(h, pj.c_str()) != 0));
            pp.push(std::move(o));
          }
        }
        got.set("perPeer", std::move(pp));

        const Diff d = diff_val(*d0, got, "digest");
        if (d.differ) {
          bad++;
          fail(name + " step " + std::to_string(si) + " (" + kind + ") digest at " + d.path +
               ": recorded " + d.expected + ", actual " + d.actual);
        }
      }
      steps++;
      si++;
    }
    ttp_room_dispose(h);
  }

  const Value* wantScripts = header.find("scripts");
  const Value* wantSlots = header.find("slotCases");
  check(!wantScripts || scripts == (int)wantScripts->num, "every corpus script replayed");
  check(!wantSlots || slotCases == (int)wantSlots->num, "every lowestFreeSlot case replayed");
  std::printf("  room corpus through the party ABI: %d scripts / %d steps / %d slot cases\n",
              scripts, steps, slotCases);
  return bad == 0;
}

bool framingCorpusThroughAbi(const std::string& path) {
  std::ifstream in(path);
  if (!in) { fail("cannot open framing corpus " + path); return false; }
  std::string line;
  if (!std::getline(in, line)) { fail("empty framing corpus"); return false; }

  int cases = 0, bad = 0;
  std::string err;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value rec;
    if (!read_line(line, rec, &err)) { fail("framing corpus: " + err); return false; }
    const std::string op = rec.find("op") ? rec.find("op")->str : "";
    const Value* expect = rec.find("expect");
    if (!expect) continue;

    Value got;
    if (op == "encode") {
      const std::string kind = rec.find("kind")->str;
      if (kind == "create") {
        const Value* url = rec.find("url");
        const std::string u = url ? url->str : std::string();
        got = parseOrNull(ttp_framing_encode_create(rec.find("clientId")->str.c_str(),
                                                    rec.find("maxClients")->num,
                                                    url ? u.c_str() : nullptr), "encode_create");
      } else if (kind == "join") {
        got = parseOrNull(ttp_framing_encode_join(rec.find("clientId")->str.c_str(),
                                                  rec.find("room")->str.c_str()), "encode_join");
      } else if (kind == "sendTo") {
        got = parseOrNull(ttp_framing_encode_send_to(idJson(rec.find("to")).c_str(),
                                                     canonical_stringify(*rec.find("data")).c_str()),
                          "encode_send_to");
      } else if (kind == "broadcast") {
        got = parseOrNull(ttp_framing_encode_broadcast(
                              canonical_stringify(*rec.find("data")).c_str()), "encode_broadcast");
      } else if (kind == "setState") {
        got = parseOrNull(ttp_framing_encode_set_state(
                              canonical_stringify(*rec.find("data")).c_str()), "encode_set_state");
      } else if (kind == "closeRoom") {
        got = parseOrNull(ttp_framing_encode_close_room(), "encode_close_room");
      } else {
        fail("unknown framing encode kind '" + kind + "'");
        return false;
      }
    } else if (op == "classify") {
      // Deliberately hands the ABI RAW socket text, which is its contract: the host
      // does not parse frames.
      const Value* wire = rec.find("wire");
      const Value* raw = rec.find("raw");
      const std::string text = raw ? raw->str : canonical_stringify(*wire);
      got = parseOrNull(ttp_framing_classify(text.c_str()), "classify");
    } else if (op == "close") {
      const Value* code = rec.find("code");
      const Value* hasCode = rec.find("hasCode");
      const Value* recon = rec.find("shouldReconnectBefore");
      got = parseOrNull(ttp_framing_close_outcome(hasCode && hasCode->b ? 1 : 0,
                                                  code ? code->num : 0,
                                                  rec.find("attemptBefore")->num,
                                                  rec.find("maxAttempts")->num,
                                                  (recon && recon->b) ? 1 : 0), "close_outcome");
    } else if (op == "backoff") {
      got = Value::Num(ttp_framing_backoff_ms(rec.find("attempt")->num));
    } else if (op == "pin") {
      got = Value::Str(ttp_framing_pin_url(rec.find("base")->str.c_str(),
                                           rec.find("room")->str.c_str(),
                                           rec.find("instance")->str.c_str()));
    } else {
      continue;
    }

    const Diff d = diff_val(*expect, got, op);
    if (d.differ) {
      bad++;
      fail("framing " + op + " at " + d.path + ": recorded " + d.expected + ", actual " + d.actual);
    }
    cases++;
  }
  std::printf("  framing corpus through the party ABI: %d cases\n", cases);
  return bad == 0;
}

// The fastlane's LOGIC is already pinned bit-exactly by fastlane_check against the
// same corpus; what is unproven here is the marshalling — handles, JSON in and out,
// raw packet text. So this is a shape-and-plumbing pass, not a second oracle.
void fastlaneThroughAbi() {
  const int a = ttp_link_create();
  check(a > 0, "ttp_link_create returns a handle");
  ttp_link_set_channel_open(a, 1);

  Value out = parseOrNull(ttp_link_enqueue(a, "{\"a\":1}", 0.0), "link_enqueue");
  check(out.has("sent") && out.has("applied") && out.has("dropped"),
        "an enqueue outcome carries sent/applied/dropped");
  const Value* pkt = out.find("packet");
  check(pkt && pkt->type == Value::OBJ, "an open channel produces a packet to write");

  // Feed that packet back into a SECOND link: the events must surface on the far
  // side, which is the whole job of the wire format.
  const int b = ttp_link_create();
  ttp_link_set_channel_open(b, 1);
  const std::string wire = canonical_stringify(*pkt);
  Value in = parseOrNull(ttp_link_inbound(b, wire.c_str(), 1.0), "link_inbound");
  const Value* applied = in.find("applied");
  check(applied && applied->arr.size() == 1, "the peer applies the one event that was sent");
  if (applied && !applied->arr.empty()) {
    const Value* av = applied->arr[0].find("a");
    check(av && av->num == 1, "the applied event is the payload that was enqueued");
  }

  // A closed channel must not write, and must not count a write.
  ttp_link_set_channel_open(a, 0);
  Value closed = parseOrNull(ttp_link_enqueue(a, "{\"b\":2}", 2.0), "link_enqueue closed");
  const Value* sent = closed.find("sent");
  check(sent && !sent->b, "a closed channel does not write");

  Value stats = parseOrNull(ttp_link_stats_json(a), "link_stats");
  check(stats.type == Value::OBJ && !stats.obj.empty(), "ttp_link_stats_json returns a stats object");

  // Idle and tick are host-scheduled; here they only have to marshal cleanly.
  parseOrNull(ttp_link_send_tick(a, 3.0), "link_send_tick");
  parseOrNull(ttp_link_idle(a, 4.0), "link_idle");

  ttp_link_dispose(a);
  ttp_link_dispose(b);

  // Error paths need no handle.
  Value bogus = parseOrNull(ttp_link_stats_json(0), "link_stats(0)");
  check(bogus.type == Value::OBJ || bogus.type == Value::NUL,
        "ttp_link_stats_json on handle 0 returns JSON rather than garbage");
  check(ttp_room_state(0) != nullptr, "ttp_room_state on handle 0 returns a string, not null");
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 5) {
    std::fprintf(stderr, "usage: abi_check <grandprix-corpus> <roomflow-corpus> "
                         "<framing-corpus> <trace.jsonl>...\n");
    return 2;
  }
  std::printf("abi check:\n");
  // More than one trace, because the marshalling a trace exercises is only the
  // marshalling its recorded inputs contain: tidepool's four bots never brake, so
  // on that fixture alone ttp_process_input's brake bit could be deleted outright
  // and every frame would still hash correctly. helix carries 402 braking inputs.
  for (int i = 4; i < argc; i++) traceThroughAbi(argv[i]);
  gpThroughAbi(argv[1]);
  boundaryExports();
  roomCorpusThroughAbi(argv[2]);
  framingCorpusThroughAbi(argv[3]);
  fastlaneThroughAbi();

  std::printf("  %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
