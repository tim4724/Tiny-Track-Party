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
// Four parts:
//   1. TRACE THROUGH THE ABI — replays golden traces via ttp_process_input /
//      ttp_update and demands the recorded per-frame hash + events back out of
//      ttp_snapshot_json / ttp_events_json. Same fixtures and recipe as the Node
//      test, but it now runs on every platform leg (linux/macOS/wasm/tvOS).
//   2. CUP SERIES THROUGH THE ABI — replays grandprix-corpus.jsonl through
//      ttp_gp_*, so the JS-recorded scoring oracle also covers the marshalled
//      path (standings JSON, the ""-means-null next track, JSON-scalar ids).
//   3. BOUNDARY + MUTATION EXPORTS — the rest of ttp_runtime.h, each asserted
//      against its documented contract.
//   4. THE PARTY ABI (ttp_party.h) — the room corpus and the framing corpus
//      through the C boundary, plus a fastlane plumbing pass. Same gap one file
//      over: ttp_party.cc was emscripten-only too.
//   5. THE UI ABI (ttp_ui.h) — ui-corpus.jsonl through the C boundary, so the
//      screen decisions a native shell will consume are marshalled on every leg
//      and the standings board's WIRE BYTES are asserted where they are made.
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
#include "generated/track_defs.h"
#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/json_read.h"
#include "ttp/race_track.h"       // find_track_def — the levels the tendency cases pick by
#include "ttp/race_track_json.h"
#include "ttp/trackbuilder.h"
// The ONE library header this ABI check reaches past its own boundary for.
// ttp::rt::ui::cupTendency has no export of its own — the only ABI path to it
// is the shipped catalogue, which exposes five answers and none of the edges —
// and it is a RULE, so it needs a gate on every leg. See uiCupTendency below.
#include "ttp/ui_model.h"
#include "ttp_audio.h"
#include "ttp_net.h"
#include "ttp_party.h"
#include "ttp_runtime.h"
#include "ttp_theme.h"
#include "ttp_race.h"
#include "ttp_ui.h"

using namespace ttp;
using namespace ttp::corpus;
namespace ui = ttp::rt::ui;

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

// Re-spell a parsed JSON tree in the frozen corpus's hexJSON: numbers become
// x<16-hex IEEE-754 bits>, everything else keeps its JSON form, keys stay in the
// order they were parsed in. Used to compare ttp_track_json's decimal output
// against the hex writer bit-for-bit — decimals cannot be diffed as text (two
// spellings of one double), bit patterns can.
std::string rehex(const Value& v) {
  switch (v.type) {
    case Value::NUM: {
      std::string o;
      ttp::rtjson::hex_number(o, v.num);
      return o;
    }
    case Value::BOOL: return v.b ? "true" : "false";
    case Value::NUL: return "null";
    case Value::STR: return json_quote(v.str);
    case Value::ARR: {
      std::string o = "[";
      for (size_t i = 0; i < v.arr.size(); i++) {
        if (i) o += ",";
        o += rehex(v.arr[i]);
      }
      return o + "]";
    }
    case Value::OBJ: {
      std::string o = "{";
      bool first = true;
      for (const auto& kv : v.obj) {
        if (kv.second.type == Value::UNDEF) continue;
        if (!first) o += ",";
        first = false;
        o += json_quote(kv.first);
        o += ":";
        o += rehex(kv.second);
      }
      return o + "}";
    }
    default: return "null";
  }
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

  // Cars are added as humans (the ABI is fed every recorded input) UNLESS the
  // trace is ai-live, in which case its bots are added with ttp_add_bot and
  // ttp_update drives them INSIDE the wasm from their persona knobs — the exact
  // path the shipped game runs, and the only way this check exercises it.
  const bool aiLive = header.has("aiLive") && header.find("aiLive")->b;

  std::vector<std::pair<std::string, std::string>> keyToIdJson;  // String(id) -> id JSON
  std::vector<std::string> botKeys;                              // driven in-wasm, inputs skipped
  for (const Value& r : header.find("roster")->arr) {
    const Value* id = r.find("id");
    const std::string idJson = canonical_stringify(*id);
    const std::string key = id->type == Value::STR ? id->str : js_number_to_string(id->num);
    keyToIdJson.emplace_back(key, idJson);

    const Value* kind = r.find("kind");
    if (aiLive && kind && kind->str == "bot") {
      const Value* caution = r.find("caution");
      const Value* laneBias = r.find("laneBias");
      const Value* aiSeed = r.find("aiSeed");
      ttp_add_bot(h, idJson.c_str(), caution ? caution->num : 1.0,
                  laneBias ? laneBias->num : 0.0,
                  aiSeed ? (uint32_t)aiSeed->num : 0u, nullptr);
      botKeys.push_back(key);
    } else {
      ttp_add_human(h, idJson.c_str(), nullptr);
    }
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
        // An in-wasm bot's recorded input is the ORACLE, not an instruction:
        // feeding it back would prove nothing about the AI the game runs.
        bool isBot = false;
        for (const auto& bk : botKeys) if (bk == kv.first) { isBot = true; break; }
        if (isBot) continue;
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

  // ---- ttp_track_json: the Node scripts' only way to read a built track.
  //
  // The check re-spells the JSON it returns in the frozen corpus's own hexJSON
  // and demands byte identity with the hex writer's output for the same track.
  // That chains three things together: the returned text really is parseable
  // JSON, its tree and key order are the contract's, and every double survived
  // the decimal round-trip to the bit. Since kHex.object() is what
  // trackbuilder_check diffs against the JS-recorded corpus, a green run here
  // means the bytes handed to a Node script equal what the retired JS builder
  // produced — the scripts inherit the port's conformance evidence instead of
  // trusting a second implementation.
  {
    check(ttp_track_json("no-such-track", 3, 1u) == nullptr,
          "ttp_track_json on an unknown trackId returns NULL");
    check(ttp_track_json(nullptr, 3, 1u) == nullptr,
          "ttp_track_json with a null trackId returns NULL");
    check(ttp_track_json("gym", 3, 1u) != nullptr,
          "ttp_track_json resolves a DEV-only range (?solo&track=gym)");

    const ttp::rtjson::Writer hex(ttp::rtjson::hex_number);
    long bad = 0;
    for (int i = 0; i < ttp::TTP_TRACK_COUNT; i++) {
      const char* id = ttp::TTP_TRACKS[i].id;
      const char* jsonText = ttp_track_json(id, 3, 1u);
      // The ORDINARY parser, not corpus::read_line: that one additionally demands
      // every token already be in JSON.stringify's canonical form, which "-0" is
      // deliberately not (see rtjson::decimal_number). This is the parser a caller
      // actually reads the ABI's output with.
      bool parsed = false;
      const Value v = jsonText ? ttp::json::parse(jsonText, &parsed) : Value();
      if (!parsed) {
        std::fprintf(stderr, "ttp_track_json(%s): did not parse\n", id);
        bad++;
        continue;
      }
      const std::string want = hex.object(ttp::build_race_track(ttp::TTP_TRACKS[i], 3, 1u));
      const std::string got = rehex(v);
      if (want != got) {
        std::fprintf(stderr, "ttp_track_json(%s) diverges from the hex writer\n", id);
        bad++;
      }
    }
    check(bad == 0, "ttp_track_json is bit-identical to the corpus-gated writer on every"
                    " catalogue track (" + std::to_string(bad) + " diverged)");
  }

  // ---- ttp_track_build_json: the same builder, driven by a descriptor.
  //
  // That the descriptor parser AGREES with the compile-time codegen is checked in
  // Node (tests/native-track.test.js), where the authored descriptors actually
  // live — every catalogue track built both ways, demanding identical bytes.
  // What is checked here is that a malformed descriptor is refused rather than
  // half-read into a track that looks plausible and is wrong.
  {
    check(ttp_track_build_json(nullptr, 3, 1u) == nullptr, "a null descriptor returns NULL");
    check(ttp_track_build_json("not json", 3, 1u) == nullptr, "a non-JSON descriptor returns NULL");
    check(ttp_track_build_json("[]", 3, 1u) == nullptr, "a non-object descriptor returns NULL");
    check(ttp_track_build_json("{}", 3, 1u) == nullptr,
          "a descriptor with neither segments nor waypoints returns NULL");
    check(ttp_track_build_json("{\"segments\":[{\"kind\":\"straight\",\"length\":10}],"
                               "\"waypoints\":[{\"x\":0,\"z\":0}]}", 3, 1u) == nullptr,
          "a descriptor with BOTH segments and waypoints returns NULL");
    check(ttp_track_build_json("{\"segments\":[{\"kind\":\"spiral\",\"length\":10}]}", 3, 1u) == nullptr,
          "an unknown segment kind returns NULL (a typo is not a track)");
    check(ttp_track_build_json("{\"waypoints\":[{\"x\":0}]}", 3, 1u) == nullptr,
          "a waypoint missing z returns NULL");
    check(ttp_track_build_json("{\"segments\":[{\"kind\":\"straight\",\"length\":10}],"
                               "\"boxes\":[{\"lat\":0}]}", 3, 1u) == nullptr,
          "a furniture entry missing u returns NULL");
    check(ttp_track_build_json("{\"segments\":[]}", 3, 1u) == nullptr,
          "an empty segment list returns NULL");

    // A real (if tiny) closed oval, to prove the happy path reaches the builder.
    const char* oval = "{\"id\":\"abi-oval\",\"segments\":["
        "{\"kind\":\"straight\",\"length\":20},{\"kind\":\"arc\",\"radius\":5,\"angle\":180},"
        "{\"kind\":\"straight\",\"length\":20},{\"kind\":\"arc\",\"radius\":5,\"angle\":180}],"
        "\"boxes\":[{\"u\":0.5,\"lat\":0}]}";
    const char* built = ttp_track_build_json(oval, 3, 7u);
    check(built != nullptr, "a well-formed descriptor builds");
    if (built) {
      bool parsedOk = false;
      const Value v = ttp::json::parse(built, &parsedOk);
      check(parsedOk, "ttp_track_build_json returns valid JSON");
      const Value* id = v.find("trackId");
      check(id && id->str == "abi-oval", "the descriptor's own id rides through");
      const Value* len = v.find("length");
      check(len && len->num > 0, "the built track has a positive length");
      const Value* cl = v.find("centerline");
      const Value* samples = cl ? cl->find("samples") : nullptr;
      check(samples && samples->arr.size() > 2, "the built track has a sampled centerline");
      const Value* boxes = v.find("boxes");
      check(boxes && boxes->arr.size() == 1, "the authored box survived furniture resolution");
      const Value* seed = v.find("seed");
      check(seed && seed->num == 7, "the requested seed is stamped on the built track");
    }
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

  // A malformed id must be ABSENT, not silently car 0. Both ABIs parse the id
  // text with the same JSON scalar parser (ttp/scalar_id.h); the sim side used
  // to run its own strtod-based scanner, which read "" and "oops" as the number
  // 0 and so aimed every such call at whichever car holds id 0.
  check(ttp_has_car(h, "") == 0, "an empty id is not car 0");
  check(ttp_has_car(h, "oops") == 0, "a non-JSON id is not car 0");
  check(ttp_has_car(h, "null") == 0, "a null id is not car 0");
  check(ttp_car_finished(h, "") == -1, "an empty id reads as an unknown car");

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

  // ---- pause DURING the countdown replays the held beat, and the GO! banner is
  // cleared by the resume that follows it. This is the whole reason the session
  // remembers the countdown as state rather than a running total, and nothing
  // else in the suite drives it.
  {
    auto beats = [&]() {                     // the _countdown n's drained this call
      Value evs; std::string err;
      std::vector<double> out;
      if (!read_line(ttp_events_json(h), evs, &err)) return out;
      for (const Value& e : evs.arr) {
        const Value* t = e.find("type");
        const Value* n = e.find("n");
        if (t && t->type == Value::STR && t->str == "_countdown" && n) out.push_back(n->num);
      }
      return out;
    };
    beats();                                  // discard whatever is queued

    ttp_pause(h);
    ttp_update(h, 5000.0);                    // a paused session must not tick the count
    check(beats().empty(), "a paused countdown emits no beats");
    ttp_resume(h);
    const std::vector<double> replay = beats();
    check(replay.size() == 1 && replay[0] == 3.0,
          "resume during the countdown re-shows the held beat");

    for (int i = 0; i < 300; i++) ttp_update(h, 1000.0 / 60.0);  // 5 s: past the clear
    const std::vector<double> ran = beats();
    std::string got;
    for (double n : ran) got += (got.empty() ? "" : ",") + js_number_to_string(n);
    check(got == "2,1,0,-1", "the countdown runs 2,1,0(GO),-1(clear) — got " + got);
  }
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

  // Error paths first: no handle required, and a room getter must still answer.
  check(ttp_room_state(0) != nullptr, "ttp_room_state on handle 0 returns a string, not null");
  check(ttp_room_size(0) == 0, "ttp_room_size on handle 0 is 0");
  check(std::strcmp(ttp_room_list_json(0), "[]") == 0, "ttp_room_list_json on handle 0 is []");

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

// ---------------------------------------------------------------------------
// Part 4b: the ABANDONED-RACE policy — hand-authored, because the frozen oracle
// cannot reach it.
//
// graceTick is called 146 times across the corpus's 36 scripts and returns true
// in NONE of them: the recorded oracle never once let a deadline expire, so the
// arm → fire → disarm path crossed into C++ carrying no cross-implementation
// evidence whatsoever. The display now RUNS this policy (display/Net.js polls it
// on the liveness tick and returns to the lobby when it fires), so it needs a
// gate. This is C++-AUTHORED, i.e. REGRESSION evidence only — it proves the
// policy still does what it does, never that the port was right
// (tests/fixtures/traces/README.md). ttp_room_late_joiners_json is likewise
// newer than the corpus.
//
// It also pins the wiring display/Net.js depends on. That module feeds the active
// order "every seat holding a car, plus every dropped seat", so the leftover set
// — what hasLateJoiners/lateJoiners answer for — is exactly a CONNECTED seat with
// no car. A dropped, car-less ghost must therefore never be the thing that keeps
// the room waiting, and must never appear as a "joining" row.
// ---------------------------------------------------------------------------
void abandonedRacePolicy() {
  const int h = ttp_room_create("{\"liveness\":{\"timeoutMs\":3000,\"graceMs\":1500}}");
  if (h <= 0) { fail("abandoned-race: ttp_room_create returned no handle"); return; }

  check(std::strcmp(ttp_room_late_joiners_json(0), "[]") == 0,
        "ttp_room_late_joiners_json on handle 0 is []");

  auto add = [&](const char* id, const char* name) {
    ttp_room_add_player(h, id, (std::string("{\"name\":\"") + name + "\",\"colorIndex\":0}").c_str());
  };
  auto lateIds = [&]() {
    Value v = parseOrNull(ttp_room_late_joiners_json(h), "late_joiners_json");
    std::string out;
    for (const Value& e : v.arr) out += canonical_stringify(*e.find("peerIndex")) + ";";
    return out;
  };
  // The predicate and the list are the same set, always.
  auto agree = [&](const char* where) {
    const bool anyBool = ttp_room_has_late_joiners(h) != 0;
    const bool anyList = !lateIds().empty();
    check(anyBool == anyList,
          std::string("hasLateJoiners agrees with lateJoiners (") + where + ")");
  };

  add("0", "Ada");
  add("1", "Bo");
  agree("lobby");
  // In the LOBBY the order is empty, so everyone is outside it — the corpus
  // records exactly this (a room with no active order has only late joiners).
  check(lateIds() == "0;1;", "lobby: the whole roster sits outside an empty order");

  ttp_room_transition_to(h, "countdown");   // snapshots the order: [0, 1]
  ttp_room_transition_to(h, "playing");
  check(lateIds().empty(), "the countdown snapshot leaves no late joiners");
  check(ttp_room_all_participants_disconnected(h) == 0, "two live racers are not all gone");
  check(ttp_room_grace_tick(h, 1000) == 0, "no grace while the racers are here");

  // Both racers drop. Their seats are held (a car and a reconnect QR each), so
  // there is still nobody WAITING — the room must sit tight indefinitely.
  ttp_room_mark_disconnected(h, "0");
  ttp_room_mark_disconnected(h, "1");
  check(ttp_room_all_participants_disconnected(h) == 1, "every participant is gone");
  check(ttp_room_grace_tick(h, 1100) == 0, "no grace with nobody waiting");
  check(ttp_room_grace_tick(h, 99999) == 0, "…and no deadline was armed to expire");

  // A phone scans in mid-race: now someone IS waiting, and the clock starts.
  add("2", "Cy");
  agree("late joiner present");
  check(lateIds() == "2;", "the mid-race joiner is the only late joiner");
  check(ttp_room_grace_tick(h, 2000) == 0, "the first qualifying tick only ARMS");
  check(ttp_room_grace_tick(h, 3499) == 0, "…and holds until graceMs has elapsed");
  check(ttp_room_grace_tick(h, 3500) == 1, "fires at exactly nowMs + graceMs");
  check(ttp_room_grace_tick(h, 3500) == 0, "fires exactly ONCE (it re-arms, not re-fires)");
  check(ttp_room_grace_tick(h, 9999) == 1, "the re-armed deadline expires in its turn");

  // A racer coming back disarms it: the room is being played again.
  ttp_room_mark_reconnected(h, "0");
  check(ttp_room_grace_tick(h, 20000) == 0, "a reconnected racer disarms the deadline");
  check(ttp_room_grace_tick(h, 99999) == 0, "…and it stays disarmed while they are here");

  // Leaving PLAYING disarms it too — the results board is not an abandoned race.
  ttp_room_mark_disconnected(h, "0");
  check(ttp_room_grace_tick(h, 100000) == 0, "re-arms on the first qualifying tick");
  ttp_room_transition_to(h, "results");
  check(ttp_room_grace_tick(h, 200000) == 0, "RESULTS is not a race to abandon");
  ttp_room_transition_to(h, "countdown");
  ttp_room_transition_to(h, "playing");
  check(ttp_room_grace_tick(h, 300000) == 0, "the state change dropped the armed deadline");

  ttp_room_dispose(h);

  // ---- the participant set, computed against a LIVE RACE ---------------------
  // ttp_room_sync_active_order is the whole definition of "who this race is for",
  // taken here rather than in each shell: every seat holding a car, plus every
  // dropped seat. It reads the sim through ttp_session.h, so this section drives
  // it with a REAL session — a room fed from a hand-written array proves the
  // room's half and nothing about the join.
  //
  // The case that matters is a late joiner who has ALSO dropped: a ghost seat, no
  // car, no phone. Against the raw COUNTDOWN snapshot it counts as someone
  // waiting and would yank a blipped party's whole race back to the lobby.
  const int g = ttp_room_create("{\"liveness\":{\"timeoutMs\":3000,\"graceMs\":1500}}");
  if (g <= 0) { fail("abandoned-race/ghost: ttp_room_create returned no handle"); return; }
  // The race: Ada (seat 0) plus a bot. The bot is deliberate — a car id that is
  // no seat at all must never become a participant.
  const int s = ttp_session_begin("tidepool", 42u, 3, nullptr);
  if (s <= 0) { fail("abandoned-race/ghost: ttp_session_begin returned no handle"); return; }
  ttp_add_human(s, "0", nullptr);
  ttp_add_bot(s, "\"ai-1\"", 1.0, 0.0, 7u, nullptr);
  ttp_session_start(s, 3);

  ttp_room_add_player(g, "0", "{\"name\":\"Ada\"}");
  ttp_room_transition_to(g, "countdown");
  ttp_room_transition_to(g, "playing");
  ttp_room_add_player(g, "2", "{\"name\":\"Cy\"}");
  ttp_room_mark_disconnected(g, "0");
  ttp_room_mark_disconnected(g, "2");
  check(ttp_room_has_late_joiners(g) == 1, "raw: a dropped ghost still reads as a late joiner");
  check(ttp_room_grace_tick(g, 1000) == 0 && ttp_room_grace_tick(g, 3000) == 1,
        "raw: …and would abandon the race for nobody");
  // Synced: seat 0 holds a car and seat 2 is dropped, so both are participants.
  ttp_room_sync_active_order(g, s);
  check(ttp_room_has_late_joiners(g) == 0, "synced: a dropped ghost is absent, not waiting");
  check(std::strcmp(ttp_room_late_joiners_json(g), "[]") == 0,
        "synced: …so it is no 'joining' row either");
  // The bot is racing and will never disconnect, so an order that swallowed cars
  // with no seat behind them could not read "every participant is gone" here.
  check(ttp_room_all_participants_disconnected(g) == 1,
        "synced: a bot's car is nobody's seat, so the race still counts as abandoned");
  check(ttp_room_grace_tick(g, 4000) == 0 && ttp_room_grace_tick(g, 9999) == 0,
        "synced: the blipped party keeps its race");
  // The ghost's phone comes back — car-less and connected, which is a late joiner.
  ttp_room_mark_reconnected(g, "2");
  ttp_room_sync_active_order(g, s);
  check(ttp_room_has_late_joiners(g) == 1, "synced: a returning ghost is waiting again");
  {
    Value v = parseOrNull(ttp_room_late_joiners_json(g), "late_joiners_json/synced");
    check(v.arr.size() == 1 && canonical_stringify(*v.arr[0].find("peerIndex")) == "2",
          "synced: the car-less seat is the one waiting");
  }
  check(ttp_room_grace_tick(g, 10000) == 0 && ttp_room_grace_tick(g, 11500) == 1,
        "synced: and the deadline runs for them");
  // The cars really come from the SIM, not from presence. With both seats back,
  // the ONLY thing separating them is that 0 holds a car and 2 does not — and
  // against session handle 0 (no session: the lobby, or a shell between races)
  // there are no cars and no dropped seats, so the order empties and both wait.
  ttp_room_mark_reconnected(g, "0");
  ttp_room_sync_active_order(g, s);
  {
    Value v = parseOrNull(ttp_room_late_joiners_json(g), "late_joiners_json/live");
    check(v.arr.size() == 1, "synced: the car-holder is a participant, the car-less seat is not");
  }
  ttp_room_sync_active_order(g, 0);
  {
    Value v = parseOrNull(ttp_room_late_joiners_json(g), "late_joiners_json/no-session");
    check(v.arr.size() == 2, "no session: no cars and no dropped seats leaves an empty order");
  }
  ttp_dispose(s);
  ttp_room_dispose(g);
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
}

// ---------------------------------------------------------------------------
// The BIOME ABI (ttp_theme.h).
// ---------------------------------------------------------------------------
// theme_check already proves the tables themselves against the recorded JS
// palette; what is unproven there is this marshalling layer, which is the only
// part of the biome the browser actually calls. Three things can break here and
// nowhere else: a name pointer that does not survive the return, an out-of-range
// index that returns garbage instead of the documented empty answer, and the
// scenery model list — whose ORDER is the scenery<i>.glb slot contract between
// the shell's fetches and the renderer's instanced props.
void themeThroughAbi() {
  const int n = ttp_theme_biome_count();
  check(n > 0, "ttp_theme_biome_count is non-zero");
  check(std::strcmp(ttp_theme_biome_name(0), "grass") == 0,
        "the first biome is grass — the canonical fallback look leads the list");
  check(ttp_theme_biome_name(-1)[0] == 0 && ttp_theme_biome_name(n)[0] == 0,
        "an out-of-range biome index is the empty string, not null");
  for (int i = 0; i < n; i++) {
    check(ttp_theme_has_biome(ttp_theme_biome_name(i)) == 1,
          std::string("ttp_theme_has_biome accepts ") + ttp_theme_biome_name(i));
  }
  check(ttp_theme_has_biome("no-such-biome") == 0, "an unknown ?biome= name is rejected");
  check(ttp_theme_has_biome(nullptr) == 0, "a null biome name is rejected");

  // The two resolution entry points, including both grass fallbacks.
  check(std::strcmp(ttp_theme_biome_for_cup("rooftop"), "playroom") == 0,
        "the stunt cup resolves to the playroom biome");
  check(std::strcmp(ttp_theme_biome_for_cup("nope"), "grass") == 0,
        "an unmapped cup falls back to grass");
  check(std::strcmp(ttp_theme_biome_for_cup(nullptr), "grass") == 0,
        "no cup at all falls back to grass");
  check(std::strcmp(ttp_theme_biome_for_track("tidepool"), "beach") == 0,
        "a track resolves through its own cup");
  check(std::strcmp(ttp_theme_biome_for_track("gym"), "grass") == 0,
        "a dev-only track, which no cup lists, falls back to grass");
  check(std::strcmp(ttp_theme_biome_for_track("no-such-track"), "grass") == 0,
        "an unknown track falls back to grass");

  // The HUD chip stroke. Value pinned by theme_check against the recorded JS
  // boostShades; here it only has to survive the C boundary as a u32.
  check(ttp_theme_boost_icon("grass") == 0x1ba192u,
        "the grass boost chip stroke is the recorded icon shade");
  check(ttp_theme_boost_icon("no-such-biome") == ttp_theme_boost_icon("grass"),
        "an unknown biome yields grass's accent rather than 0");

  check(ttp_theme_hill_color("playroom", 3) == 0x6cbf6cu,
        "the playroom's fourth block colour survives — a truncated hills list would lose it");
  check(ttp_theme_hill_color("playroom", 4) == 0u, "an out-of-range hill index is 0");
  check(ttp_theme_hill_color("grass", -1) == 0u, "a negative hill index is 0");

  // Slot order is the contract, and the bush donor must not get a slot of its
  // own when it is already one of the trees (grass sinks the oak as its bush).
  check(std::strcmp(ttp_theme_scenery_models("grass"), "[\"tree\",\"tree-pine\"]") == 0,
        "grass stamps two scenery models, the bush donor sharing the oak's slot");
  check(std::strcmp(ttp_theme_scenery_models("playroom"), "[]") == 0,
        "the playroom stamps no scenery models — no trees indoors");
}

// ---------------------------------------------------------------------------
// The AUDIO ABI (ttp_audio.h).
// ---------------------------------------------------------------------------
// The `audio` ctest already replays audio-corpus.jsonl through the DECISIONS on
// every leg, and tests/audio-abi.test.js races the shipped wasm against the JS
// oracle command for command. Neither covers what is only here: this bus reads
// the live race itself, so its rules about WHICH race and WHEN are C++ and
// nothing above the ABI can see them. Three of them, and each is a silent
// failure — an audible bug with no error anywhere:
//   - only the BOUND session is heard (the lobby's attract race must not sing);
//   - the fast-forward burst is MUTED (it skips a race, it does not play one);
//   - a disposed handle takes its queued beats with it.
void audioThroughAbi() {
  // The two lookups a shell derives its tables from.
  check(ttp_audio_cue_id(0) == nullptr, "cue code 0 is 'no cue', not the first one");
  check(ttp_audio_cue_id(-1) == nullptr, "no cue below the table");
  check(ttp_audio_cue_id(TTP_CUE_ENGINE_PUTT) != nullptr
        && std::strcmp(ttp_audio_cue_id(TTP_CUE_ENGINE_PUTT), "engine_putt") == 0,
        "TTP_CUE_ENGINE_PUTT names the engine loop");
  check(ttp_audio_cue_id(TTP_CUE_ROCKET_FIRE) != nullptr, "the last code names a cue");
  check(ttp_audio_cue_id(TTP_CUE_ROCKET_FIRE + 1) == nullptr, "and nothing past it");
  {
    Value s = parseOrNull(ttp_audio_song_json(0), "audio_song_json(0)");
    check(s.type == Value::OBJ && s.find("file") && s.find("gain") && s.find("artist"),
          "a song carries its file, its trim and its credit");
    check(std::strcmp(ttp_audio_song_json(-1), "null") == 0, "no song below the catalogue");
  }

  // Drain whatever earlier sections left behind, so the counts below are ours.
  ttp_audio_bind(0);
  ttp_audio_drain();

  auto count = [](int kind) {
    const TtpAudioBlock* b = ttp_audio_drain();
    if (!b) return -1;
    int n = 0;
    const TtpAudioCmd* cmds = ttp_audio_cmds(b);
    for (uint32_t i = 0; i < b->count; i++) if (kind < 0 || cmds[i].kind == kind) n++;
    return n;
  };

  const TtpAudioBlock* empty = ttp_audio_drain();
  check(empty != nullptr && empty->version == TTP_AUDIO_BLOCK_VERSION
        && empty->stride == sizeof(TtpAudioCmd) && empty->count == 0,
        "an idle drain answers a zero-count block rather than null");

  // Two races at once: one bound (the party can hear it), one not (the lobby's
  // attract demo). Same track, same field, so the only difference is the bind.
  const int heard = ttp_session_begin("tidepool", 42, 3, "rocket");
  const int unheard = ttp_session_begin("tidepool", 42, 3, "rocket");
  check(heard && unheard, "two sessions opened");
  for (int h : {heard, unheard}) {
    ttp_add_human(h, "0", nullptr);
    ttp_add_bot(h, "\"ai-1\"", 1, 0, 7, nullptr);
    ttp_add_bot(h, "\"ai-2\"", 0.9, 0.3, 11, nullptr);
    ttp_add_bot(h, "\"ai-3\"", 1.1, -0.2, 13, nullptr);
  }
  ttp_audio_bind(heard);
  ttp_session_start(heard, 3);
  ttp_session_start(unheard, 3);

  // The countdown beats of the BOUND race, and only its beats: three ticks and
  // a GO, with the unbound race counting down beside it in silence.
  int ticks = 0, gos = 0, voices = 0;
  double nowMs = 0;
  for (int f = 0; f < 260; f++) {
    ttp_process_input(heard, "0", 7, 0.2, 0, 0);
    ttp_process_input(unheard, "0", 7, 0.2, 0, 0);
    ttp_update(heard, 1000.0 / 60.0);
    ttp_update(unheard, 1000.0 / 60.0);
    ttp_events_json(heard);
    ttp_events_json(unheard);
    nowMs += 1000.0 / 60.0;
    ttp_audio_frame(nowMs);
    const TtpAudioBlock* b = ttp_audio_drain();
    const TtpAudioCmd* cmds = ttp_audio_cmds(b);
    for (uint32_t i = 0; i < b->count; i++) {
      if (cmds[i].kind == TTP_AUD_COUNTDOWN) { (cmds[i].flags & TTP_AUD_F_GO) ? gos++ : ticks++; }
      if (cmds[i].kind == TTP_AUD_VOICE) {
        voices++;
        check(cmds[i].subject != 0, "a voice names a subject");
        check(cmds[i].code >= 1 && ttp_audio_cue_id(cmds[i].code) != nullptr,
              "a voice names a cue this build has");
      }
    }
  }
  check(ticks == 3 && gos == 1, "exactly one countdown was heard: "
        + std::to_string(ticks) + " ticks, " + std::to_string(gos) + " GO");
  check(voices > 100, "the human's state voices ran (" + std::to_string(voices) + ")");

  // The fast-forward is SILENT. It fires a burst of laps and finishes with no
  // frame between them, so anything it decided would land in one lump on the
  // next drain — which is precisely the noise the shell used to suppress.
  ttp_fast_forward(heard);
  ttp_events_json(heard);
  check(count(-1) == 0, "the fast-forward burst decided nothing");

  // A disposed race says nothing more, even with beats still queued.
  ttp_update(unheard, 1000.0 / 60.0);
  ttp_dispose(heard);
  ttp_audio_frame(nowMs);
  check(count(-1) == 0, "a disposed session is silent");

  // ... and the one that was never bound stayed silent throughout.
  ttp_audio_bind(unheard);
  ttp_audio_bind(0);
  check(count(-1) == 0, "binding does not release a race's backlog");
  ttp_dispose(unheard);

  // stop_car and stop_voices answer whether or not a race is bound: both are
  // teardown paths the shell can reach with the session already gone.
  ttp_audio_stop_car("0");
  ttp_audio_stop_voices();
  check(count(TTP_AUD_STOP_CAR) == 1, "stop_car answers with no session bound");
  ttp_audio_stop_voices();
  check(count(TTP_AUD_STOP_ALL) == 1, "stop_voices answers with no session bound");

  // Music needs no race at all — it is picked by BIOME.
  ttp_audio_music(TTP_AUD_MUSIC_START, "beach");
  {
    const TtpAudioBlock* b = ttp_audio_drain();
    const TtpAudioCmd* cmds = ttp_audio_cmds(b);
    check(b->count == 1 && cmds[0].kind == TTP_AUD_MUSIC
          && cmds[0].code == TTP_AUD_MUSIC_START,
          "a music start is one command");
    if (b->count == 1) {
      Value song = parseOrNull(ttp_audio_song_json(cmds[0].subject), "the picked song");
      check(song.type == Value::OBJ, "the picked song resolves through its index");
      check(cmds[0].level > 0 && cmds[0].level < 1, "and comes with a bed level");
    }
  }
  ttp_audio_music(TTP_AUD_MUSIC_STOP, nullptr);
  ttp_audio_drain();
}

// ---------------------------------------------------------------------------
// Part 6: the UI ABI (ttp_ui.h) — the display's screen decisions as C entry
// points.
//
// Same gap, third file over: runtime/ttp_ui.cc is compiled by the emscripten
// module and by this target and by nothing else, so without this the desktop
// and tvOS legs would never see a line of the marshalling a native shell is
// going to consume.
//
// It replays ui-corpus.jsonl — the SAME JS-recorded fixture ui_check.cc holds
// the RULES to — through the C boundary instead of through C++ objects. The
// driver is much shorter than ui_check's for one reason worth stating: the ABI
// speaks JSON, and the corpus is JSON, so a step's recorded `in` goes across
// almost untouched and the recorded `out` is diffed against what comes back.
// There is no second transcription of the corpus's shapes here, which is what
// keeps this from becoming a copy of ui_check that can drift from it.
//
// The two things the boundary can break that the library cannot are exactly
// what this catches: a key spelled differently on the way out (the corpus
// records every one), and an id crossing as the wrong JSON type (`3` vs `"3"` —
// the corpus's bots are strings and its seats are numbers).
// ---------------------------------------------------------------------------

// gen-ui-corpus.mjs's synthetic world is READ OUT OF THE CORPUS HEADER, not
// transcribed here. It arrives in exactly ttp_ui_configure's shape (the
// generator writes cups/catalog/maxPlayers/carCount verbatim into line 1), so
// the ABI is configured by handing the header's `world` straight back across
// the boundary — which also makes the configure export's own contract part of
// what this replay proves. Two C++ replayers used to carry a copy of that world
// and a count guard to catch it going stale; ui_check.cc reads the header too
// now, and nothing downstream of the generator transcribes anything. See
// tests/fixtures/traces/README.md, "A corpus carries its own world".
double UI_INTERMISSION_MS = 0;

// A parsed ABI answer, or a typed hole that will diff loudly.
Value uiJson(const char* text) {
  if (!text) return Value::Null();
  bool ok = false;
  Value v = json::parse(text, &ok);
  return ok ? v : Value::Str(std::string("<unparseable> ") + text);
}
// The subset of a step's `in` that an export takes, re-emitted as a JSON string.
// Passing the whole object through would work too (every reader ignores keys it
// does not name), but naming the fields is what makes a renamed input visible.
std::string uiArg(const Value& v) { return canonical_stringify(v); }
Value uiField(const Value& in, const char* k) {
  const Value* v = in.find(k);
  return v ? *v : Value::Null();
}
std::string uiArgField(const Value& in, const char* k) { return uiArg(uiField(in, k)); }

// The shell state the corpus threads. Only what the ABI's own arguments need:
// the current screen name, the reconnect cards that actually landed, and the
// per-race item map (which crosses as an array, in Map insertion order).
struct UiShell {
  std::string screen;      // "" = no board yet, which reads as the root
  std::vector<Value> shown;
  std::vector<std::pair<Value, Value>> lastItem;   // id -> item (Null = no key)

  void reset(const Value* s) {
    screen = (s && s->type == Value::STR) ? s->str : std::string();
    shown.clear();
    lastItem.clear();
  }
  // JS Map.set: an existing key keeps its position.
  void setItem(const Value& id, const Value& item) {
    for (auto& kv : lastItem) {
      if (canonical_stringify(kv.first) == canonical_stringify(id)) { kv.second = item; return; }
    }
    lastItem.emplace_back(id, item);
  }
  std::string itemsArg() const {
    Value a = Value::Arr();
    for (const auto& kv : lastItem) {
      Value e = Value::Obj();
      e.set("id", kv.first);
      // UNDEF is dropped by the stringifier — which is the ABSENT item the
      // three-state rule turns on, so it must NOT become null here.
      if (kv.second.type != Value::UNDEF) e.set("item", kv.second);
      a.push(e);
    }
    return canonical_stringify(a);
  }
  std::string shownArg() const {
    Value a = Value::Arr();
    for (const Value& v : shown) a.push(v);
    return canonical_stringify(a);
  }
};

// One step through the C exports, answering in the corpus's `out` shape.
Value uiStep(UiShell& st, const std::string& op, const Value& in) {
  Value out = Value::Obj();

  if (op == "show") {
    const Value* to = in.find("to");
    const std::string next = (to && to->type == Value::STR) ? to->str : std::string();
    const int step = ttp_ui_screen_step(st.screen.c_str(), next.c_str());
    st.screen = next;
    out.set("step", Value::Num(step));
    out.set("nav", Value::Str(step > 0 ? "push" : step < 0 ? "pop" : "none"));
    return out;
  }
  if (op == "back") {
    out.set("effect", Value::Str(ttp_ui_back_effect(st.screen.c_str())));
    return out;
  }
  if (op == "roster") {
    const std::string roster = uiArgField(in, "roster");
    const std::string host = uiArgField(in, "host");
    const Value seats = uiJson(ttp_ui_roster_seats_json(roster.c_str(), host.c_str()));
    const std::string seatsArg = canonical_stringify(seats);
    out.set("seats", seats);
    out.set("grid", uiJson(ttp_ui_seat_grid_json(seatsArg.c_str())));
    out.set("ready", Value::Bool(ttp_ui_all_racers_ready(roster.c_str(), host.c_str()) != 0));
    // The ABI answers with INDICES so a shell keeps its own objects; the corpus
    // recorded the ids, so resolving them back is also what pins the indices.
    const Value idx = uiJson(ttp_ui_connected_players_json(roster.c_str()));
    const Value* rosterV = in.find("roster");
    Value conn = Value::Arr();
    if (idx.type == Value::ARR && rosterV && rosterV->type == Value::ARR) {
      for (const Value& i : idx.arr) {
        const size_t n = (size_t) i.num;
        conn.push(n < rosterV->arr.size() ? uiField(rosterV->arr[n], "peerIndex") : Value::Str("<out of range>"));
      }
    }
    out.set("connected", conn);
    return out;
  }
  if (op == "pick") {
    Value pick = Value::Obj();
    pick.set("mode", uiField(in, "mode"));
    pick.set("cupId", uiField(in, "cupId"));
    pick.set("trackId", uiField(in, "trackId"));
    pick.set("randomRaces", uiField(in, "randomRaces"));
    const std::string arg = uiArg(pick);
    out.set("slot", uiJson(ttp_ui_cup_slot_json(arg.c_str())));
    return out;
  }
  if (op == "reconnect") {
    const Value* seatsV = in.find("seats");
    Value seatIds = Value::Arr();
    if (seatsV && seatsV->type == Value::ARR) {
      for (const Value& s : seatsV->arr) seatIds.push(uiField(s, "peerIndex"));
    }
    const std::string shownArg = st.shownArg();
    const std::string seatsArg = canonical_stringify(seatIds);
    const Value d = uiJson(ttp_ui_reconnect_diff_json(shownArg.c_str(), seatsArg.c_str()));
    const Value* remove = d.find("remove");
    const Value* add = d.find("add");
    const Value* land = in.find("land");
    const auto landed = [&land](const Value& id) {
      if (!land || land->type != Value::ARR) return true;
      for (const Value& e : land->arr) if (canonical_stringify(e) == canonical_stringify(id)) return true;
      return false;
    };
    std::vector<Value> kept;
    for (const Value& id : st.shown) {
      bool gone = false;
      if (remove && remove->type == Value::ARR) {
        for (const Value& r : remove->arr) if (canonical_stringify(r) == canonical_stringify(id)) { gone = true; break; }
      }
      if (!gone) kept.push_back(id);
    }
    st.shown = kept;
    Value addIds = Value::Arr();
    if (add && add->type == Value::ARR) {
      for (const Value& i : add->arr) {
        const size_t n = (size_t) i.num;
        const Value id = n < seatIds.arr.size() ? seatIds.arr[n] : Value::Str("<out of range>");
        addIds.push(id);
        if (landed(id)) st.shown.push_back(id);
      }
    }
    out.set("remove", remove ? *remove : Value::Null());
    out.set("add", addIds);
    return out;
  }
  if (op == "hud") {
    // `rows` is hudRows, which ttp_display_hud answers for off a LIVE session —
    // unreachable from a scripted car list, so it is not re-checked here (that
    // is hud_check's and ui_check's job). This step exists for `pushes`, which
    // is the one rule whose answer depends on the map threaded above.
    const std::string cars = uiArgField(in, "cars");
    const std::string ai = uiArgField(in, "aiIds");
    const std::string last = st.itemsArg();
    const Value pushes = uiJson(ttp_ui_item_pushes_json(cars.c_str(), ai.c_str(), last.c_str()));
    if (pushes.type == Value::ARR) {
      for (const Value& p : pushes.arr) {
        const Value* item = p.find("item");
        st.setItem(uiField(p, "id"), item ? *item : Value{});   // absent -> UNDEF
      }
    }
    out.set("pushes", pushes);
    return out;
  }
  if (op == "clearItems") {
    st.lastItem.clear();
    out.set("cleared", Value::Bool(true));
    return out;
  }
  if (op == "welcomeItem") {
    const std::string car = uiArgField(in, "car");
    out.set("item", uiJson(ttp_ui_welcome_item_json(car.c_str())));
    return out;
  }
  if (op == "flow") {
    const std::string arg = uiArg(in);
    const Value r = uiJson(ttp_ui_race_flow_json(arg.c_str()));
    out.set("allDone", r.find("allDone") ? *r.find("allDone") : Value::Null());
    out.set("forfeit", r.find("forfeit") ? *r.find("forfeit") : Value::Null());
    return out;
  }
  if (op == "autopause") {
    const std::string arg = uiArg(in);
    const int asks = ttp_ui_auto_pause_asks(arg.c_str());
    const bool allDown = asks && in.find("allDisconnected") &&
                         in.find("allDisconnected")->type == Value::BOOL &&
                         in.find("allDisconnected")->b;
    out.set("asks", Value::Bool(asks != 0));
    out.set("decision", uiJson(ttp_ui_auto_pause_json(arg.c_str(), allDown ? 1 : 0)));
    return out;
  }
  if (op == "freeze") {
    const auto flag = [&in](const char* k) {
      const Value* v = in.find(k);
      return (v && v->type == Value::BOOL && v->b) ? 1 : 0;
    };
    const Value* rsV = in.find("roomState");
    const std::string rs = (rsV && rsV->type == Value::STR) ? rsV->str : std::string();
    out.set("move", Value::Str(ttp_ui_freeze_transition(flag("paused"), flag("autoPaused"),
                                                        flag("sessionPaused"))));
    out.set("canPause", Value::Bool(ttp_ui_can_pause(flag("hasSession"), flag("paused"),
                                                     rs.c_str()) != 0));
    out.set("canResume", Value::Bool(ttp_ui_can_resume(flag("hasSession"), flag("paused")) != 0));
    return out;
  }
  if (op == "board") {
    // The cup chip is its own export, and the board takes its answer back —
    // exactly how a shell composes them, so a mismatch between the two spellings
    // of SeriesInfo shows up here rather than on a phone.
    Value cup = Value::Null();
    const Value* sV = in.find("series");
    if (sV && sV->type == Value::OBJ) {
      Value si = *sV;
      si.set("autoAdvanceMs", Value::Num(UI_INTERMISSION_MS));
      const std::string siArg = uiArg(si);
      cup = Value::Obj();
      cup.set("standings", uiField(*sV, "standings"));
      cup.set("info", uiJson(ttp_ui_series_info_json(siArg.c_str())));
    }
    Value board = Value::Obj();
    board.set("results", uiField(in, "results"));
    board.set("field", uiField(in, "field"));
    board.set("cup", cup);
    board.set("lateJoiners", uiField(in, "lateJoiners"));
    board.set("hostPeerIndex", uiField(in, "hostPeerIndex"));
    board.set("over", uiField(in, "over"));
    const std::string arg = uiArg(board);
    const char* bytes = ttp_ui_standings_json(arg.c_str());
    const std::string wire = bytes ? bytes : "";
    out.set("board", uiJson(bytes));
    // The WIRE bytes, and this is the assertion that only the ABI can make:
    // ui_check proves the C++ builds the right board, this proves the exported
    // string IS those bytes in the phones' key order rather than a sorted
    // re-spelling of them.
    out.set("wire", Value::Str(wire));
    const Value* over = in.find("over");
    out.set("view", (over && over->type == Value::BOOL && over->b)
                        ? uiJson(ttp_ui_results_view_json(wire.c_str(), UI_INTERMISSION_MS))
                        : Value::Null());
    return out;
  }
  if (op == "intermission") {
    out.set("secs", Value::Num(ttp_ui_intermission_secs(json::num_field(in, "deadlineMs"),
                                                        json::num_field(in, "nowMs"))));
    return out;
  }
  fail("unknown ui-corpus op '" + op + "'");
  return out;
}

// The catalogue fallback and its getter — the ABI half of "a shell configures
// nothing and gets the shipped game". The DATA is checked in
// tests/ui-model.test.js, which is the one place that can see both
// shared/tracks.js and the wasm; what is checked here is the wiring, on every
// leg: that omitting the lists installs a world rather than an empty one, that
// giving them still overrides, and that the getter ignores the override.
void uiShippedCatalogue() {
  check(ttp_ui_configure("{\"maxPlayers\":4,\"carCount\":6}") == 1,
        "configure with no lists is accepted");
  const std::string shipped = ttp_ui_catalogue_json();
  bool ok = false;
  const Value cat = json::parse(shipped.c_str(), &ok);
  check(ok && cat.type == Value::OBJ, "the catalogue getter answers an object");
  const Value* cups = cat.find("cups");
  const Value* list = cat.find("catalog");
  check(cups && cups->type == Value::ARR && !cups->arr.empty(),
        "omitting the lists installs the SHIPPED cups, not an empty world");
  check(list && list->type == Value::ARR && !list->arr.empty(),
        "…and the shipped catalogue with them");
  if (cups && list && !cups->arr.empty() && !list->arr.empty()) {
    // Every catalogue entry names a cup and carries that cup's tendency: the
    // getter's whole job is that a shell never resolves either itself.
    size_t inCups = 0;
    for (const Value& c : cups->arr) {
      const Value* t = c.find("tracks");
      if (t && t->type == Value::ARR) inCups += t->arr.size();
    }
    check(inCups == list->arr.size(), "the catalogue is exactly the cups, flattened");
    bool everyEntryResolved = true;
    for (const Value& e : list->arr) {
      const Value* cup = e.find("cup");
      const Value* diff = e.find("cupDifficulty");
      const Value* name = e.find("name");
      if (!cup || cup->type != Value::STR || !diff || diff->type != Value::NUM ||
          !name || name->type != Value::STR || name->str.empty()) {
        everyEntryResolved = false;
      }
    }
    check(everyEntryResolved, "every entry carries a name, its cup and that cup's tendency");
  }

  // The override still overrides — and the getter still answers SHIPPED, so a
  // synthetic conformance world can never reach a picker through it. Any
  // override does; this one is written here rather than borrowed from the ui
  // corpus because nothing is being replayed, so it is not a world that has to
  // match a recording.
  check(ttp_ui_configure("{\"maxPlayers\":2,\"carCount\":2,"
                         "\"cups\":[{\"id\":\"c\",\"name\":\"C\",\"tracks\":[\"t\"]}],"
                         "\"catalog\":[{\"id\":\"t\",\"name\":\"T\",\"cup\":\"c\","
                         "\"cupDifficulty\":1}]}") == 1,
        "the synthetic world still overrides");
  check(std::string(ttp_ui_catalogue_json()) == shipped,
        "the getter ignores whatever was configured");
}

// cupTendency, the one RULE that came with the catalogue — and the reason it is
// pinned here rather than left to tests/ui-model.test.js.
//
// That test compares the wasm's answer against shared/tracks.js and is the right
// place for the DATA. But it runs in node against the shipped artifact, so it is
// invisible to `npm run mutation-check`, whose contract is "break the engine and
// require the matching CTEST to go red". Swap std::lround for std::trunc in
// ui_model.cc and every one of the 47 ctests stays green today: only Playroom's
// mean (3.75) is far enough from an integer to move, and no ctest looks at it.
//
// So the cases below are synthetic CUPS over real track ids, chosen for their
// LEVELS rather than their names, and they pin the rounding at the tie — which
// ui_model.h flags as the fragile part precisely because no shipped cup lands
// there, so nothing would notice the day one did.
void uiCupTendency() {
  const auto levelOf = [](const char* id) {
    const ttp::TrackDef* d = ttp::find_track_def(id);
    return d ? d->difficulty : -1;
  };
  // Premise first: if these stop being the levels the ladder is built from, the
  // cases below stop testing rounding and start testing nothing.
  check(levelOf("tidepool") == 1 && levelOf("powder") == 2 && levelOf("wash") == 3 &&
        levelOf("gauntlet") == 4,
        "premise: the four difficulty levels are all present in the catalogue");

  const char* two[] = { "powder", "wash" };            // 2, 3 -> mean 2.5
  const char* twoLow[] = { "tidepool", "powder" };     // 1, 2 -> mean 1.5
  const char* four[] = { "wash", "gauntlet", "gauntlet", "gauntlet" };  // 3.75
  const ttp::CupDef tie{ "t", "Tie", two, 2, 0 };
  const ttp::CupDef tieLow{ "tl", "Tie Low", twoLow, 2, 0 };
  const ttp::CupDef high{ "h", "High", four, 4, 0 };
  check(ui::cupTendency(tie) == 3, "a mean of exactly 2.5 rounds UP, as Math.round does");
  check(ui::cupTendency(tieLow) == 2, "…and 1.5 does too, so it is half-up and not half-even");
  check(ui::cupTendency(high) == 4, "3.75 rounds to 4 — the case std::trunc would silently drop");

  // The override wins outright, and is not averaged with anything.
  const ttp::CupDef pinned{ "p", "Pinned", four, 4, 1 };
  check(ui::cupTendency(pinned) == 1, "an authored tendency is used verbatim");

  // A cup with no tracks has no mean; JS `sum/0` was NaN and Math.round(NaN) is
  // NaN, which the picker read as no meter. The C++ answers the middling 2
  // rather than propagating a NaN through an int.
  const ttp::CupDef empty{ "e", "Empty", nullptr, 0, 0 };
  check(ui::cupTendency(empty) == 2, "an empty cup falls back rather than dividing by zero");
}

void uiCorpusThroughAbi(const char* path) {
  std::ifstream in(path);
  if (!in) { fail(std::string("cannot open ") + path); return; }

  UiShell st;
  std::string line, scenario;
  int steps = 0;
  bool header = false;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    std::string err;
    if (!read_line(line, root, &err)) { fail("ui corpus parse: " + err); return; }
    const Value* kind = root.find("case");
    if (!kind) {
      if (header) continue;
      header = true;
      // The world the generator recorded against, handed straight to the ABI.
      const Value* world = root.find("world");
      if (!world || world->type != Value::OBJ) {
        fail("the ui corpus header carries no `world` — regenerate it: "
             "node scripts/gen-ui-corpus.mjs");
        return;
      }
      const Value* ims = world->find("intermissionMs");
      UI_INTERMISSION_MS = (ims && ims->type == Value::NUM) ? ims->num : 0;
      check(ttp_ui_configure(canonical_stringify(*world).c_str()) == 1,
            "the corpus's own catalogue configured through ttp_ui_configure");
      continue;
    }
    if (kind->str == "scenario") {
      const Value* nm = root.find("name");
      scenario = nm && nm->type == Value::STR ? nm->str : "?";
      st.reset(root.find("screen"));
      continue;
    }
    if (kind->str != "step") continue;
    const Value* opV = root.find("op");
    const Value* wantOut = root.find("out");
    if (!opV || opV->type != Value::STR || !wantOut) { fail("malformed ui step"); return; }
    const Value empty = Value::Obj();
    const Value* inV = root.find("in");
    const Value got = uiStep(st, opV->str, inV && inV->type == Value::OBJ ? *inV : empty);
    steps++;
    // Only the keys this driver answers: `rows` is a live-session readback and
    // is checked by hud_check / ui_check, not here.
    for (const auto& kv : got.obj) {
      const Value* want = wantOut->find(kv.first);
      if (!want) { fail("ui " + scenario + ": corpus has no " + kv.first); continue; }
      const Diff d = diff_val(*want, kv.second, kv.first);
      check(!d.differ, "ui " + opV->str + " " + scenario + " step " + std::to_string(steps) +
                       ": " + d.path + " expected " + d.expected + " got " + d.actual);
    }
  }
  check(header && steps > 0, "ui corpus replayed through the ABI (" + std::to_string(steps) + " steps)");
}


// ---------------------------------------------------------------------------
// The RACE-ORCHESTRATION ABI (ttp_race.h), replayed against the same corpus
// runtimetest/raceflow_check.cc drives the C++ objects with.
//
// The two checks are not redundant, and the difference is the same one the ui
// and session pairs have: raceflow_check proves the RULES, this proves the
// MARSHALLING. What can only go wrong here is invisible there — an effect's
// payload key dropped on the way out, a bot id emitted as a number instead of
// the string "ai-0", the opaque car-stats row not surviving the round trip, or
// the key-PRESENCE contract (a rejected start must carry `reason` and no
// `series`) collapsing into a null.
//
// Four of the corpus's ops have no export of their own — carStatsAt,
// lowestFreeSlot and cpuSeats are internals reached through buildField, and the
// shell never calls them across the boundary — so they are skipped here and
// covered by raceflow_check alone.
const char* RACE_WORLD =
    "{\"fieldSize\":4,\"carCount\":6,\"colorCount\":8,\"aiPrefix\":\"ai-\","
    "\"personas\":["
    "{\"name\":\"Alpha\",\"caution\":1.1,\"laneBias\":-0.5},"
    "{\"name\":\"Beta\",\"caution\":1,\"laneBias\":0.5},"
    "{\"name\":\"Gamma\",\"caution\":0.95,\"laneBias\":-0.2},"
    "{\"name\":\"Delta\",\"caution\":0.9,\"laneBias\":0.2}],"
    "\"carStats\":["
    "{\"accel\":1,\"top\":1,\"turn\":1,\"weight\":1},"
    "{\"accel\":1.1,\"top\":0.95,\"turn\":1.05,\"weight\":0.9},"
    "{\"accel\":0.9,\"top\":1.1,\"turn\":0.95,\"weight\":1.1},"
    "{\"accel\":1.05,\"top\":1,\"turn\":0.9,\"weight\":1},"
    "{\"accel\":0.95,\"top\":1.05,\"turn\":1.1,\"weight\":0.95},"
    "{\"accel\":1,\"top\":0.9,\"turn\":1,\"weight\":1.2}],"
    "\"cups\":["
    "{\"id\":\"cup-a\",\"name\":\"Sunrise\",\"tracks\":[\"a1\",\"a2\",\"a3\",\"a4\"]},"
    "{\"id\":\"cup-b\",\"name\":\"Thunder\",\"tracks\":[\"b1\",\"b2\",\"b3\",\"b4\"]},"
    "{\"id\":\"cup-empty\",\"name\":\"Hollow\",\"tracks\":[]}]}";

// The corpus's `in` is already the ABI's input shape for most ops, so the step
// mostly re-stringifies it. Returns UNDEF for an op with no export.
Value raceStep(const std::string& op, const Value& in) {
  const auto J = [](const Value& v) { return ordered_stringify(v); };
  const auto jsonOf = [](const char* s) {
    bool ok = false;
    Value v = json::parse(s ? s : "", &ok);
    return ok ? v : Value::Null();
  };
  const auto sub = [&in](const char* k) {
    const Value* v = in.find(k);
    return v ? ordered_stringify(*v) : std::string("null");
  };
  const auto numIn = [&in](const char* k) {
    const Value* v = in.find(k);
    return (v && v->type == Value::NUM) ? v->num : 0.0;
  };
  const auto strIn = [&in](const char* k) {
    const Value* v = in.find(k);
    return (v && v->type == Value::STR) ? v->str : std::string();
  };
  const auto truthyIn = [&in](const char* k) {
    const Value* v = in.find(k);
    if (!v) return false;
    if (v->type == Value::BOOL) return v->b;
    if (v->type == Value::NUM) return v->num != 0;
    if (v->type == Value::STR) return !v->str.empty();
    return v->type == Value::ARR || v->type == Value::OBJ;
  };

  if (op == "buildField") {
    return jsonOf(ttp_race_build_field_json(sub("humans").c_str(), numIn("seed"),
                                            sub("botCap").c_str()));
  }
  if (op == "buildDemoField") {
    return jsonOf(ttp_race_build_demo_field_json(sub("humans").c_str(), sub("botCap").c_str()));
  }
  if (op == "demoSig") {
    return Value::Str(ttp_race_demo_sig(sub("field").c_str(), strIn("trackId").c_str()));
  }
  if (op == "drawsNeeded") return Value::Num(ttp_race_draws_needed(J(in).c_str()));
  if (op == "startRace") return jsonOf(ttp_race_start_json(J(in).c_str()));
  if (op == "launchRace") return jsonOf(ttp_race_launch_json(J(in).c_str()));
  if (op == "countdownTick") return jsonOf(ttp_race_countdown_tick_json(numIn("n")));
  if (op == "raceStart") {
    return jsonOf(ttp_race_start_beat_json(strIn("biome").c_str(), truthyIn("audioReady") ? 1 : 0));
  }
  if (op == "raceEvent") return jsonOf(ttp_race_event_json(J(in).c_str()));
  if (op == "endRace") return jsonOf(ttp_race_end_json(J(in).c_str()));
  if (op == "advanceSeriesRace") return jsonOf(ttp_race_advance_json(J(in).c_str()));
  if (op == "returnToLobby") return jsonOf(ttp_race_return_json(J(in).c_str()));
  if (op == "forfeitCar") {
    return jsonOf(ttp_race_forfeit_json(truthyIn("removed") ? 1 : 0, sub("peerIndex").c_str()));
  }
  if (op == "rekeyCarPlayer") {
    return jsonOf(ttp_race_rekey_json(truthyIn("hasSeries") ? 1 : 0, truthyIn("rekeyed") ? 1 : 0,
                                      sub("oldId").c_str(), sub("newId").c_str()));
  }
  if (op == "autoPauseEffects") return jsonOf(ttp_race_auto_pause_json(sub("decision").c_str()));
  if (op == "seriesForStart") {
    // No export of its own: startRace is how a shell reaches it, and the plan it
    // returns is the same object. Replay it through the accepting path.
    Value si = Value::Obj();
    si.set("roomState", Value::Str("lobby"));
    si.set("sceneReady", Value::Bool(true));
    si.set("selectedTrackId", Value::Str("a1"));
    Value players = Value::Arr();
    Value p = Value::Obj();
    p.set("peerIndex", Value::Num(1));
    p.set("name", Value::Str("P"));
    p.set("colorIndex", Value::Num(0));
    p.set("carIndex", Value::Num(0));
    players.push(p);
    si.set("players", players);
    for (const char* k : {"mode", "cupId", "trackId", "randomRaces", "draws"}) {
      const Value* v = in.find(k);
      if (v) si.set(k, *v);
    }
    const Value got = jsonOf(ttp_race_start_json(ordered_stringify(si).c_str()));
    // startRace's answer wraps the same plan under `series` + `drawsUsed`.
    Value out = Value::Obj();
    const Value* s = got.find("series");
    out.set("series", s ? *s : Value::Null());
    const Value* d = got.find("drawsUsed");
    out.set("drawsUsed", d ? *d : Value::Num(0));
    return out;
  }
  return Value();   // UNDEF: no export, covered by raceflow_check
}

void raceCorpusThroughAbi(const char* path) {
  std::ifstream in(path);
  if (!in) { fail(std::string("cannot open ") + path); return; }
  check(ttp_race_configure(RACE_WORLD) == 1, "the synthetic race world configured");

  std::string line, scenario;
  int steps = 0, skipped = 0;
  bool header = false;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    std::string err;
    if (!read_line(line, root, &err)) { fail("raceflow corpus parse: " + err); return; }
    const Value* kind = root.find("case");
    if (!kind) {
      if (header) continue;
      header = true;
      const auto n = [&root](const char* k) {
        const Value* v = root.find(k);
        return (v && v->type == Value::NUM) ? v->num : -1.0;
      };
      check(n("fieldSize") == 4 && n("carCount") == 6 && n("colorCount") == 8 &&
                n("personas") == 4 && n("carStats") == 6,
            "raceflow corpus recorded against abi_check's synthetic world");
      continue;
    }
    if (kind->str == "scenario") {
      const Value* nm = root.find("name");
      scenario = nm && nm->type == Value::STR ? nm->str : "?";
      continue;
    }
    if (kind->str != "step") continue;
    const Value* opV = root.find("op");
    const Value* wantOut = root.find("out");
    if (!opV || opV->type != Value::STR || !wantOut) { fail("malformed raceflow step"); return; }
    const Value empty = Value::Obj();
    const Value* inV = root.find("in");
    const Value got = raceStep(opV->str, inV && inV->type == Value::OBJ ? *inV : empty);
    if (got.type == Value::UNDEF) { skipped++; continue; }
    steps++;
    // WHOLE-VALUE diff, not key-by-key: key PRESENCE is this ABI's contract, so
    // an extra key the corpus does not have has to fail too.
    const Diff d = diff_val(*wantOut, got, "out");
    check(!d.differ, "race " + opV->str + " " + scenario + " step " + std::to_string(steps) +
                     ": " + d.path + " expected " + d.expected + " got " + d.actual);
  }
  check(header && steps > 0,
        "raceflow corpus replayed through the ABI (" + std::to_string(steps) + " steps, " +
            std::to_string(skipped) + " internals skipped)");
  // Printed rather than silent: the four skipped ops make "it ran" and "it ran
  // over nothing" look alike from the assertion count alone.
  std::printf("  raceflow corpus through the race ABI: %d steps (%d internals skipped)\n",
              steps, skipped);
}

// ---------------------------------------------------------------------------
// The SESSION-POLICY ABI (ttp_net.h), replayed against the same corpus
// partytest/session_check.cc drives the C++ objects with.
//
// The two checks are not redundant and the difference is the whole point: the
// session check proves the RULES, this one proves the MARSHALLING. Everything
// that can go wrong only here is invisible there — an absent rejoinToken
// arriving as an explicit null (they answer differently, and that is frozen), a
// snapshot key dropped on the way out, a carIndex string coerced to a number
// somewhere in the parse, the chooser payload leaking into a non-lobby snapshot.
// ---------------------------------------------------------------------------
Value netStep(const std::string& op, const Value& in) {
  const auto txt = [](const Value* v) -> std::string {
    return v ? canonical_stringify(*v) : std::string();
  };
  // The shared readers (ttp/json_read.h), bound to this step's `in`.
  const auto num = [&in](const char* k) { return json::num_field(in, k); };
  const auto str = [&in](const char* k) { return json::str_field(in, k); };
  const auto flag = [&in](const char* k) { return json::truthy(in, k); };
  const auto parse = [](const char* json) {
    bool ok = false;
    Value v = json::parse(json ? json : "null", &ok);
    return ok ? v : Value::Null();
  };

  Value out = Value::Obj();
  if (op == "roster") {
    out.set("rows", parse(ttp_net_roster_rows_json(txt(in.find("roster")).c_str(),
                                                   txt(in.find("inRace")).c_str())));
  } else if (op == "snapshot") {
    const Value* chooser = in.find("chooser");
    // Set once per step here rather than once per run: the corpus deliberately
    // walks a configured and an UNCONFIGURED chooser, and "the three keys are
    // simply absent" is part of the contract.
    check(ttp_net_configure(chooser && chooser->type == Value::OBJ
                                ? canonical_stringify(*chooser).c_str() : "") == 1,
          "net chooser configured");
    out.set("snapshot", parse(ttp_net_lobby_snapshot_json(canonical_stringify(in).c_str())));
  } else if (op == "joinUrl") {
    out.set("url", Value::Str(ttp_net_join_url(str("base").c_str(), str("room").c_str(),
                                               str("instance").c_str())));
  } else if (op == "claimUrl") {
    out.set("url", Value::Str(ttp_net_claim_url(str("url").c_str(), num("peerIndex"))));
  } else if (op == "template") {
    const std::string t = ttp_net_controller_url_template(str("base").c_str());
    out.set("template", t.empty() ? Value::Null() : Value::Str(t));
  } else if (op == "normIndex") {
    // NULL is JS undefined; "null" is an explicit null. Passing the wrong one
    // here is exactly the marshalling bug this driver exists to catch.
    const std::string arg = flag("absent") ? std::string() : txt(in.find("value"));
    out.set("index", parse(ttp_net_norm_index_json(arg.empty() ? nullptr : arg.c_str())));
  } else if (op == "seat") {
    out.set("defaults", parse(ttp_net_seat_defaults_json(num("colorIndex"))));
  } else if (op == "addPeer") {
    out.set("plan", parse(ttp_net_add_peer_plan_json(flag("has") ? 1 : 0, num("size"),
                                                     num("maxPlayers"), num("colorIndex"))));
  } else if (op == "presence") {
    out.set("action", Value::Str(ttp_net_presence_action(str("roomState").c_str())));
  } else if (op == "leave") {
    out.set("action", Value::Str(ttp_net_leave_action(str("roomState").c_str())));
  } else if (op == "card") {
    out.set("card", parse(ttp_net_reconnect_card_json(txt(in.find("seat")).c_str(),
                                                      str("url").c_str())));
  } else if (op == "route") {
    out.set("route", Value::Str(ttp_net_inbound_route(num("from"), str("type").c_str())));
  } else if (op == "action") {
    out.set("action", Value::Str(ttp_net_message_action(str("type").c_str())));
  } else if (op == "setCar") {
    const std::string idx = txt(in.find("carIndex"));
    out.set("accept", Value::Bool(ttp_net_set_car(flag("ready") ? 1 : 0, str("roomState").c_str(),
                                                  flag("inRace") ? 1 : 0,
                                                  idx.empty() ? nullptr : idx.c_str(),
                                                  num("carCount")) != 0));
  } else if (op == "setReady") {
    out.set("accept", Value::Bool(ttp_net_set_ready(flag("isHost") ? 1 : 0,
                                                    str("roomState").c_str(),
                                                    flag("ready") ? 1 : 0,
                                                    flag("current") ? 1 : 0) != 0));
  } else if (op == "stateChange") {
    out.set("plan", parse(ttp_net_state_change_json(str("to").c_str())));
  } else if (op == "hostChange") {
    out.set("plan", parse(ttp_net_host_change_json()));
  } else if (op == "hb") {
    out.set("tick", parse(ttp_net_heartbeat_tick_json(flag("inRoom") ? 1 : 0,
                                                      flag("hbPending") ? 1 : 0,
                                                      num("hbSentAt"), num("now"))));
  } else if (op == "claim") {
    Value hello = Value::Obj();
    if (!flag("absent")) {
      const Value* tok = in.find("rejoinToken");
      hello.set("rejoinToken", tok ? *tok : Value::Null());
    }
    out.set("plan", parse(ttp_net_claim_plan_json(canonical_stringify(hello).c_str(),
                                                  num("fromId"), flag("hasOld") ? 1 : 0,
                                                  flag("oldDisconnected") ? 1 : 0)));
  } else if (op == "resync") {
    out.set("plan", parse(ttp_net_resync_plan_json(txt(in.find("rosterIds")).c_str(),
                                                   txt(in.find("relayPeers")).c_str())));
  }
  return out;
}

void sessionCorpusThroughAbi(const char* path) {
  std::ifstream in(path);
  if (!in) { fail(std::string("cannot open ") + path); return; }
  std::string line, scenario;
  int steps = 0;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    std::string err;
    if (!read_line(line, root, &err)) { fail("session corpus parse: " + err); return; }
    const Value* kind = root.find("case");
    if (!kind || kind->type != Value::STR) continue;
    if (kind->str == "scenario") {
      const Value* nm = root.find("name");
      scenario = nm && nm->type == Value::STR ? nm->str : "?";
      continue;
    }
    if (kind->str != "step") continue;
    const Value* opV = root.find("op");
    const Value* wantOut = root.find("out");
    if (!opV || opV->type != Value::STR || !wantOut) { fail("malformed session step"); return; }
    const Value empty = Value::Obj();
    const Value* inV = root.find("in");
    const Value got = netStep(opV->str, inV && inV->type == Value::OBJ ? *inV : empty);
    if (got.obj.empty()) { fail("session: unhandled op " + opV->str); return; }
    steps++;
    for (const auto& kv : got.obj) {
      const Value* want = wantOut->find(kv.first);
      if (!want) { fail("session " + scenario + ": corpus has no " + kv.first); continue; }
      const Diff d = diff_val(*want, kv.second, kv.first);
      check(!d.differ, "session " + opV->str + " " + scenario + " step " + std::to_string(steps) +
                       ": " + d.path + " expected " + d.expected + " got " + d.actual);
    }
  }
  check(steps > 0, "session corpus replayed through the ABI (" + std::to_string(steps) + " steps)");
  ttp_net_configure("");  // leave no configured chooser behind
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 8) {
    std::fprintf(stderr, "usage: abi_check <grandprix-corpus> <roomflow-corpus> "
                         "<framing-corpus> <ui-corpus> <session-corpus> <raceflow-corpus> "
                         "<trace.jsonl>...\n");
    return 2;
  }
  std::printf("abi check:\n");
  // More than one trace, because the marshalling a trace exercises is only the
  // marshalling its recorded inputs contain: tidepool's four bots never brake, so
  // on that fixture alone ttp_process_input's brake bit could be deleted outright
  // and every frame would still hash correctly. helix carries 402 braking inputs.
  for (int i = 7; i < argc; i++) traceThroughAbi(argv[i]);
  gpThroughAbi(argv[1]);
  boundaryExports();
  roomCorpusThroughAbi(argv[2]);
  abandonedRacePolicy();
  framingCorpusThroughAbi(argv[3]);
  fastlaneThroughAbi();
  themeThroughAbi();
  audioThroughAbi();
  uiShippedCatalogue();
  uiCupTendency();
  uiCorpusThroughAbi(argv[4]);
  sessionCorpusThroughAbi(argv[5]);
  raceCorpusThroughAbi(argv[6]);

  std::printf("  %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
