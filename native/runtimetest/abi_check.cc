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
// TWO KINDS OF GATE LIVE HERE, and which one a section can use follows from
// what the export IS.
//
//   A CORPUS REPLAY, wherever a JSON-taking spelling still exists. The frozen
//   fixture was recorded off the JS twin, so replaying it through the C
//   boundary puts JS-recorded evidence on every platform leg: the golden
//   traces (ttp_process_input/ttp_update), grandprix-corpus (ttp_gp_*),
//   framing-corpus, and the surviving arms of ui-corpus.
//
//   AN EQUIVALENCE, wherever the export is a HANDLE WALK. A walk adds no rule —
//   it GATHERS what a shell used to gather and SEQUENCES rules a shell used to
//   sequence — so no corpus can cover it and none should be invented. The
//   expected value is composed IN THE SAME RUN out of the C++ decision
//   functions the walk calls (race::, ttp::rt::ui::, ttp::session::, RoomFlow)
//   over the same state, and compared with the walk's answer. That keeps the
//   gate true when a shape changes and stops it becoming a stale second copy
//   of the wire format.
//
// THE JSON-TAKING SPELLINGS THAT DIED took their replays with them, and that is
// a deliberate trade rather than lost coverage: the corpora they replayed are
// still authoritative through the C++-level checks (roomflow_check,
// session_check, raceflow_check, ui_check), which is where the RULES were
// always proven. What is gone is the second, marshalling-level pass over the
// same fixture — replaced here by the equivalences above.
//
// Nothing in this file re-records a corpus, and nothing here may become the
// oracle for a rule: a rule's oracle is the frozen JS recording, always.

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
// TWO library headers this ABI check reaches past its own boundary for, each
// for its own reason.
//
// ttp::rt::ui::cupTendency has no export of its own — the only ABI path to it is
// the shipped catalogue, which exposes five answers and none of the edges — and
// it is a RULE, so it needs a gate on every leg. See uiCupTendency below.
#include "ttp/ui_model.h"
// ttp::protocol::manifest() is the ORACLE for ttp_protocol_manifest_json: the
// export's only claim is that it hands the library's own tables over unchanged,
// and the sole way to state that is to hold the two side by side.
#include "ttp/protocol.h"
#include "ttp/schematic.h"
// The DECISION LAYERS the handle walks sequence, reached directly so the
// expected side of every equivalence is the rule itself rather than a
// transcription of it. race_flow.h and ui_model.h are libttp-runtime's;
// room_flow.h and session.h are libttp-party's. This check already links both
// libraries and recompiles the shims, which is the same standing this file's
// includes of ttp_room.h / ttp_session.h have.
#include "ttp/race_flow.h"
#include "ttp/room_flow.h"
#include "ttp/session.h"
#include "ttp_audio.h"
#include "ttp_live.h"     // the shared live gathers the race + ui walks compose over
#include "ttp_room.h"     // the room seam: the pick slot, the machine, the synced reads
#include "ttp_session.h"  // the session seam: the live Game, the cup series
#include "ttp_net.h"
#include "ttp_party.h"
#include "ttp_runtime.h"
#include "ttp_theme.h"
#include "ttp_race.h"
#include "ttp_ui.h"

using namespace ttp;
using namespace ttp::corpus;
namespace ui = ttp::rt::ui;
namespace race = ttp::rt::race;
namespace ns = ttp::session;

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

// One field of a parsed ABI answer, or a typed hole that diffs loudly rather
// than defaulting into agreement.
Value at(const Value& v, const char* key) {
  const Value* f = v.find(key);
  return f ? *f : Value::Str(std::string("<missing ") + key + ">");
}

// A roster (ttp_room_list_json's answer) as the ui model's entries. The
// composed expectations run the rules over the SAME rows the walk reads, so
// this is the one place a roster is turned into rule input here.
std::vector<ui::RosterEntry> rosterEntriesOf(const Value& arr) {
  std::vector<ui::RosterEntry> out;
  if (arr.type != Value::ARR) return out;
  for (const Value& p : arr.arr) {
    ui::RosterEntry e;
    e.peerIndex = json::id_of<ui::Id>(p.find("peerIndex"));
    e.name = json::str_field(p, "name");
    e.colorIndex = json::num_field(p, "colorIndex");
    e.carIndex = json::opt_num<ui::OptNum>(p.find("carIndex"));
    e.connected = json::truthy(p.find("connected"));
    e.ready = json::truthy(p.find("ready"));
    out.push_back(std::move(e));
  }
  return out;
}

Value optVal(const ui::OptNum& n) { return n.has ? Value::Num(n.v) : Value::Null(); }
Value optVal(const ui::OptStr& s) { return s.has ? Value::Str(s.v) : Value::Null(); }

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

      // Rebuild the recorded digest from ONE state read. The digest's keys are
      // the JS oracle's, so they are re-spelled off the state object rather
      // than renamed in the fixture — `currentTrackId` for `currentTrack`, and
      // `nextTrackId`, which the state answers as a REAL null where the retired
      // getter spelled "".
      const Value st = parseOrNull(ttp_gp_state_json(g), "gp state");
      Value got = Value::Obj();
      got.set("raceIndex", at(st, "raceIndex"));
      got.set("raceCount", at(st, "raceCount"));
      got.set("currentTrackId", at(st, "currentTrack"));
      got.set("nextTrackId", at(st, "nextTrack"));
      got.set("finished", at(st, "finished"));
      got.set("endless", at(st, "endless"));
      got.set("tracks", at(at(st, "cup"), "tracks"));
      got.set("standings", at(st, "standings"));

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
  // The codec tolerance and the retry budget are manifest numbers now; the
  // C++ owners must BE those numbers (the getSteerExpo pattern).
  check(ttp::schematic::EPS == ttp::protocol::SCHEMATIC_EPS,
        "schematic.h EPS == the manifest's SCHEMATIC_EPS");
  check(ttp_framing_max_reconnect_attempts() == 5,
        "the retry budget the JS transports default to");

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

  // ---- removing a car takes it OFF the finished board too.
  //
  // raceOver() is `finishedOrder_.size() >= cars_.size()`, so a finished car
  // that leaves must come off BOTH sides or the count is one too high forever
  // after and the race ends a car early. Nothing gated that: deleting the erase
  // in Game::removeCar left all 48 tests green.
  //
  // It is not a corner case. The live route is a mid-race disconnect —
  // display/Net.js holds the seat, the grace window elapses, `playerleave` ->
  // main.js forfeitCar -> forceRemoveCar — and forceRemoveCar has no "only if
  // unfinished" filter, so a player who crossed the line and then closed their
  // phone is exactly this. The remaining racers would be shown the results
  // board mid-lap.
  //
  // The sequence below is the discriminating one: removing the finished car is
  // NOT enough to tell the two versions apart (2 >= 3 is false either way).
  // Finishing the NEXT car is — with the erase [2,3] is 2 of 3 and the race runs
  // on; without it [1,2,3] is 3 of 3 and the flag drops.
  // raceOver() is only CONSULTED by RaceSession::update, so each step below is
  // followed by a tick — that tick is the moment the flag would drop early.
  {
    const int r = ttp_session_begin("tidepool", 7, 3, nullptr);
    check(r != 0, "a session for the finished-board removal case");
    for (const char* id : { "1", "2", "3", "4" }) ttp_add_human(r, id, nullptr);
    ttp_session_start(r, 3);
    const auto tick = [&]() { ttp_update(r, 1000.0 / 60.0); };
    for (int i = 0; i < 4 * 60; i++) tick();   // walk the 3 s countdown out
    check(ttp_racing(r) == 1, "premise: four cars, none finished, still racing");

    ttp_force_finish(r, "1", 10.0);
    ttp_force_finish(r, "2", 11.0);
    tick();
    check(ttp_racing(r) == 1, "two of four home is not a finished race");

    check(ttp_force_remove_car(r, "1") == 1, "the FINISHED car leaves the field");
    tick();
    check(ttp_racing(r) == 1, "…three cars, one home: still racing");

    ttp_force_finish(r, "3", 12.0);
    tick();
    check(ttp_racing(r) == 1,
          "two of the three REMAINING cars are home — the departed car's finish "
          "left with it, so the race runs on");

    ttp_force_finish(r, "4", 13.0);
    tick();
    check(ttp_racing(r) == 0, "…and ends when the last of them is actually home");
    ttp_dispose(r);
  }


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
// Part 4: the PARTY ABI (ttp_party.h) — the room machine's remaining SHELL
// SURFACE, the relay framing and the fastlane netcode, as C entry points.
//
// The room surface used to be 30-odd exports and this section replayed
// roomflow-corpus through all of them. It is eleven now: create/dispose, one
// mutator pair (add_player / set_field), transition_to, the three describe
// reads (state / list / host), the event drain and the two provider setters.
// Everything the corpus drove — remove, rekey, presence, the liveness
// predicates, the active order — is reached by the choreography walks in C++,
// so there is no ABI path left to replay it down.
//
// The corpus did not lose a reader: partytest/roomflow_check.cc replays it
// against RoomFlow itself on every leg, which is where the RULES always were.
// What only the boundary can say is what this section says instead — that the
// eleven survivors MARSHAL correctly. Hand-authored, so it is regression
// evidence, never parity evidence.
// ---------------------------------------------------------------------------
void roomShellSurface() {
  {
    Value v = parseOrNull(ttp_party_version(), "ttp_party_version");
    const Value* layer = v.find("layer");
    check(layer && layer->str == "party", "ttp_party_version reports the party layer");
    check(v.has("contractVersion"), "ttp_party_version carries contractVersion");
  }

  // The shared manifest across the boundary. partytest/protocol_check.cc already
  // holds ttp::protocol::manifest() to the JS-recorded corpus, so all this must
  // add is that the EXPORT hands over that same object unaltered — which is the
  // whole claim a shell reading it at boot depends on. Byte comparison, not a
  // field walk: the export's job is to be the manifest, not a projection of it.
  check(ttp_protocol_manifest_json() == canonical_stringify(protocol::manifest()),
        "ttp_protocol_manifest_json is ttp::protocol::manifest() verbatim");

  // ---- error paths first: a room read must answer without a handle.
  // "" — the same spelling the internal seam has always used, so both paths
  // read identically (the old literal "null" forced a carve-out here).
  check(std::strcmp(ttp_room_state(0), "") == 0,
        "ttp_room_state on handle 0 spells the absent phase as \"\"");
  check(std::strcmp(ttp_room_list_json(0), "[]") == 0, "ttp_room_list_json on handle 0 is []");
  check(std::strcmp(ttp_room_host_json(0), "null") == 0, "ttp_room_host_json on handle 0 is null");
  check(std::strcmp(ttp_room_events_json(0), "[]") == 0, "ttp_room_events_json on handle 0 is []");
  check(std::strcmp(ttp_room_add_player(0, "1", "{}"), "null") == 0,
        "ttp_room_add_player on handle 0 is null");
  check(ttp_room_set_field(0, "1", "ready", "true") == 0, "ttp_room_set_field on handle 0 fails");
  check(ttp_room_transition_to(0, "lobby") == 0, "ttp_room_transition_to on handle 0 fails");

  // ---- create parses its config, and the parse is OBSERVABLE through the
  // master provider: with one configured the room's host is whatever the
  // provider says, so a config the parser dropped shows up as an elected host.
  {
    const int h = ttp_room_create("{\"master\":2}");
    if (h <= 0) { fail("room surface: ttp_room_create returned no handle"); return; }
    ttp_room_add_player(h, "1", "{\"name\":\"Ada\"}");
    ttp_room_add_player(h, "2", "{\"name\":\"Bo\"}");
    check(std::strcmp(ttp_room_host_json(h), "2") == 0,
          "a configured master provider is the effective host, so `master` parsed");
    ttp_room_set_master(h, "null");
    check(std::strcmp(ttp_room_host_json(h), "1") == 0,
          "…and clearing it falls back to the elected host");
    ttp_room_dispose(h);
  }
  {
    // Junk config is the DEFAULTS, not a refusal: create has no failure return.
    for (const char* cfg : {(const char*)nullptr, "", "null", "not json", "[]", "{}"}) {
      const int h = ttp_room_create(cfg);
      check(h > 0, std::string("ttp_room_create tolerates ") + (cfg ? cfg : "<null>"));
      if (h > 0) {
        check(std::strcmp(ttp_room_state(h), "lobby") == 0, "…and opens in the lobby");
        ttp_room_dispose(h);
      }
    }
  }

  const int h = ttp_room_create("{\"liveness\":{\"timeoutMs\":3000,\"graceMs\":1500}}");
  if (h <= 0) { fail("room surface: ttp_room_create returned no handle"); return; }

  // ---- add_player's answer: the three KIT-OWNED keys plus the caller's fields,
  // and nothing invented. peerIndex keeps its JSON type.
  {
    Value rec = parseOrNull(
        ttp_room_add_player(h, "1", "{\"name\":\"Ada\",\"colorIndex\":0,\"carIndex\":null}"),
        "add_player");
    check(rec.type == Value::OBJ, "add_player answers the player record");
    check(canonical_stringify(at(rec, "peerIndex")) == "1",
          "the record carries the peer index as the scalar it was given");
    check(rec.has("joinedAt") && rec.find("joinedAt")->type == Value::NUM,
          "…the kit's joinedAt");
    check(json::truthy(rec.find("connected")), "…the kit's connected, true on arrival");
    check(canonical_stringify(at(rec, "name")) == "\"Ada\"", "…and the caller's own fields");
    check(rec.find("carIndex") && rec.find("carIndex")->type == Value::NUL,
          "an explicit null field survives as null rather than being dropped");

    // A STRING id is a different peer from the number, all the way through.
    Value s = parseOrNull(ttp_room_add_player(h, "\"1\"", "{\"name\":\"Bo\"}"), "add_player str");
    check(canonical_stringify(at(s, "peerIndex")) == "\"1\"",
          "the string \"1\" seats a peer distinct from the number 1");
    Value roster = parseOrNull(ttp_room_list_json(h), "list_json");
    check(roster.arr.size() == 2, "…and both sit on the roster");

    // A re-add of a live seat is the kit's same-device reconnect: no duplicate.
    ttp_room_add_player(h, "1", "{\"name\":\"Ada II\"}");
    check(parseOrNull(ttp_room_list_json(h), "list_json").arr.size() == 2,
          "re-adding a seated peer does not seat them twice");
    ttp_room_events_json(h);
  }

  // ---- set_field writes an opaque game field and REFUSES the kit's own keys.
  {
    check(ttp_room_set_field(h, "1", "ready", "true") == 1, "set_field writes a game field");
    Value roster = parseOrNull(ttp_room_list_json(h), "list_json");
    check(json::truthy(roster.arr[0].find("ready")), "…and the roster shows it");
    for (const char* kitKey : {"peerIndex", "joinedAt", "connected"}) {
      check(ttp_room_set_field(h, "1", kitKey, "99") == 0,
            std::string("set_field refuses the kit-owned key ") + kitKey);
    }
    roster = parseOrNull(ttp_room_list_json(h), "list_json");
    check(canonical_stringify(at(roster.arr[0], "peerIndex")) == "1",
          "…and the refused write left the record alone");
    check(ttp_room_set_field(h, "404", "ready", "true") == 0, "set_field misses an unseated peer");
    check(ttp_room_set_field(h, "1", "ready", "not json") == 0,
          "a value that is not JSON is refused rather than stored as text");
    check(ttp_room_set_field(h, "1", nullptr, "true") == 0, "a null key is refused");
    // Emits nothing, exactly like the JS record assignment it replaces.
    check(std::strcmp(ttp_room_events_json(h), "[]") == 0, "set_field emits no event");
  }

  // ---- transition_to accepts the four phases and refuses anything else.
  {
    for (const char* to : {"countdown", "playing", "results", "lobby"}) {
      check(ttp_room_transition_to(h, to) == 1, std::string("transition to ") + to);
      check(std::strcmp(ttp_room_state(h), to) == 0, "…and the state reads back");
    }
    check(ttp_room_transition_to(h, "nowhere") == 0, "an unknown phase is refused");
    check(ttp_room_transition_to(h, "") == 0, "an empty phase is refused");
    check(ttp_room_transition_to(h, "playing") == 0,
          "a legal phase reached ILLEGALLY is refused too (lobby never jumps to playing)");
    check(std::strcmp(ttp_room_state(h), "lobby") == 0, "…and the phase did not move");
    ttp_room_events_json(h);
  }

  // ---- events drain in EMISSION order and empty the queue. Two mutations in
  // one drain is the case that can only fail here: a queue that answered per
  // call, or in reverse, would still pass a one-event test.
  {
    ttp_room_add_player(h, "3", "{\"name\":\"Cy\"}");
    ttp_room_transition_to(h, "countdown");
    Value evs = parseOrNull(ttp_room_events_json(h), "events_json");
    std::string types;
    for (const Value& e : evs.arr) types += (types.empty() ? "" : ",") + json::str_field(e, "type");
    check(types == "playerjoin,rosterchange,statechange",
          "the queue drains in emission order — got " + types);
    check(std::strcmp(ttp_room_events_json(h), "[]") == 0, "…and the drain emptied it");

    // The detail rides across whole — the listener reads from/to off it.
    ttp_room_transition_to(h, "playing");
    evs = parseOrNull(ttp_room_events_json(h), "events_json");
    check(evs.arr.size() == 1, "one statechange for one transition");
    if (evs.arr.size() == 1) {
      const Value detail = at(evs.arr[0], "detail");
      check(json::str_field(detail, "from") == "countdown" &&
                json::str_field(detail, "to") == "playing",
            "…carrying the phases it moved between");
    }
  }

  // ---- the liveness-enabled setter, observable through the walk that reads it:
  // with liveness off nothing expires however long a seat is silent.
  {
    // useEnabledProvider is what makes the setter consulted at all — without
    // it the flag is inert, which is the config parse being asserted here too.
    const int q = ttp_room_create(
        "{\"liveness\":{\"timeoutMs\":10,\"graceMs\":10,\"useEnabledProvider\":true}}");
    ttp_net_restore_room(q, "ROOM", "");
    ttp_net_on_protocol_json(q, "created", "{\"room\":\"ROOM\",\"instance\":\"m-1\"}", 0);
    ttp_net_on_protocol_json(q, "peer_joined", "{\"index\":1}", 0);
    ttp_room_transition_to(q, "countdown");
    ttp_room_transition_to(q, "playing");
    ttp_room_events_json(q);
    ttp_room_set_liveness_enabled(q, 0);
    Value off = parseOrNull(ttp_net_liveness_json(q, 0, 100000), "liveness off");
    bool dropped = false;
    for (const Value& e : at(off, "effects").arr)
      dropped = dropped || json::str_field(e, "op") == "show-reconnect";
    check(!dropped, "liveness disabled: a silent seat is never expired");
    // The canary comes home, so the next tick sends again instead of declaring
    // the socket dead and skipping its sweep.
    ttp_net_on_peer_message_json(q, 0, "0", "{\"type\":\"_heartbeat\"}", 0, 100000);
    ttp_room_set_liveness_enabled(q, 1);
    Value on = parseOrNull(ttp_net_liveness_json(q, 0, 200000), "liveness on");
    for (const Value& e : at(on, "effects").arr)
      dropped = dropped || json::str_field(e, "op") == "show-reconnect";
    check(dropped, "…and re-enabling it drops them on the next sweep");
    ttp_room_dispose(q);
  }

  ttp_room_dispose(h);
  // A disposed handle is an unknown one again.
  check(std::strcmp(ttp_room_list_json(h), "[]") == 0, "a disposed room has no roster");
  ttp_room_dispose(h);  // twice is safe
  std::printf("  the room ABI's surviving shell surface\n");
}

// ---------------------------------------------------------------------------
// Part 4b: the ABANDONED-RACE policy — hand-authored, because the frozen oracle
// cannot reach it.
//
// graceTick is called 146 times across roomflow-corpus's 36 scripts and returns
// true in NONE of them: the recorded oracle never once let a deadline expire, so
// the arm → fire → disarm path crossed into C++ carrying no cross-implementation
// evidence whatsoever. The display RUNS this policy (the liveness walk polls it
// and answers `race-abandoned`), so it needs a gate. This is C++-AUTHORED, i.e.
// REGRESSION evidence only — it proves the policy still does what it does, never
// that the port was right (tests/fixtures/traces/README.md).
//
// It is driven THROUGH THE WALK that owns each step — the liveness tick for the
// deadline, peer_joined/peer_left for presence, _seen for the lift — because
// none of them has a one-rule export any more. The waiting set is read off the
// machine through ttp_room.h's seam, which is the only reader left.
//
// It also pins the wiring the walks depend on. The active order is "every seat
// holding a car, plus every dropped seat", so the leftover set — what
// hasLateJoiners/lateJoiners answer for — is exactly a CONNECTED seat with no
// car. A dropped, car-less ghost must therefore never be the thing that keeps
// the room waiting, and must never appear as a "joining" row.
// ---------------------------------------------------------------------------
void abandonedRacePolicy() {
  // graceMs is the subject; the expiry timeout is pushed far out so this
  // section isolates the ABANDONED-RACE deadline from the per-seat expiry
  // sweep that shares its tick (which has its own case in
  // netWalksMatchMultiCallPath).
  const int h = ttp_room_create("{\"liveness\":{\"timeoutMs\":600000,\"graceMs\":1500}}");
  if (h <= 0) { fail("abandoned-race: ttp_room_create returned no handle"); return; }
  RoomFlow* flow = ttp_room_flow(h);
  if (!flow) { fail("abandoned-race: no machine behind the room handle"); return; }
  // The deadline only runs inside a room, because the walk's heartbeat half
  // gates the sweep on being in one.
  ttp_net_on_protocol_json(h, "created", "{\"room\":\"ABCD\",\"instance\":\"m-1\"}", 0);
  ttp_room_events_json(h);
  // A REAL race behind the room. The tick re-syncs the active order off it, so
  // a room with no session would have its participant set wiped on the first
  // tick and could never read "every participant is gone" — the sync is the
  // definition of the set, not a refinement of it.
  const int race = ttp_session_begin("tidepool", 42u, 3, nullptr);
  if (race <= 0) { fail("abandoned-race: ttp_session_begin returned no handle"); return; }
  ttp_add_human(race, "1", nullptr);
  ttp_add_human(race, "2", nullptr);
  ttp_session_start(race, 3);

  // ONE 1 Hz tick, exactly as the display performs it: the walk, then the
  // relay's echo of the canary it just sent — without the echo the next tick
  // would read the socket as dead and skip its sweep, which is the heartbeat's
  // own rule and not this policy's. Answers whether the race was abandoned.
  const auto tick = [&](double nowMs) {
    const Value w = parseOrNull(ttp_net_liveness_json(h, race, nowMs), "liveness");
    bool abandoned = false;
    for (const Value& e : at(w, "effects").arr)
      abandoned = abandoned || json::str_field(e, "op") == "race-abandoned";
    ttp_net_on_peer_message_json(h, 0, "0", "{\"type\":\"_heartbeat\"}", 0, nowMs);
    ttp_room_events_json(h);
    return abandoned;
  };
  const auto join = [&](int id, double nowMs) {
    char msg[48];
    std::snprintf(msg, sizeof msg, "{\"index\":%d}", id);
    ttp_net_on_protocol_json(h, "peer_joined", msg, nowMs);
    ttp_room_events_json(h);
  };
  const auto leave = [&](int id, double nowMs) {
    char msg[48];
    std::snprintf(msg, sizeof msg, "{\"index\":%d}", id);
    ttp_net_on_protocol_json(h, "peer_left", msg, nowMs);
    ttp_room_events_json(h);
  };
  // The waiting set, off the machine. No export answers it: the only ABI
  // reader left is the standings board, which takes it already synced.
  const auto lateIds = [&]() {
    std::string out;
    for (const Value& e : flow->lateJoinersValue().arr)
      out += canonical_stringify(*e.find("peerIndex")) + ";";
    return out;
  };
  // The predicate and the list are the same set, always.
  const auto agree = [&](const char* where) {
    check(flow->hasLateJoiners() == !lateIds().empty(),
          std::string("hasLateJoiners agrees with lateJoiners (") + where + ")");
  };

  join(1, 0);
  join(2, 0);
  agree("lobby");
  // In the LOBBY the order is empty, so everyone is outside it — the corpus
  // records exactly this (a room with no active order has only late joiners).
  check(lateIds() == "1;2;", "lobby: the whole roster sits outside an empty order");

  ttp_room_transition_to(h, "countdown");   // snapshots the order: [1, 2]
  ttp_room_transition_to(h, "playing");
  ttp_room_events_json(h);
  check(lateIds().empty(), "the countdown snapshot leaves no late joiners");
  check(!flow->allParticipantsDisconnected(), "two live racers are not all gone");
  check(!tick(1000), "no grace while the racers are here");

  // Both racers drop. Their seats are held (a car and a reconnect QR each), so
  // there is still nobody WAITING — the room must sit tight indefinitely.
  leave(1, 1000);
  leave(2, 1000);
  check(flow->allParticipantsDisconnected(), "every participant is gone");
  check(!tick(1100), "no grace with nobody waiting");
  check(!tick(1200), "…and no deadline was armed to expire");

  // A phone scans in mid-race: now someone IS waiting, and the clock starts.
  join(3, 2000);
  agree("late joiner present");
  check(lateIds() == "3;", "the mid-race joiner is the only late joiner");
  check(!tick(2000), "the first qualifying tick only ARMS");
  check(!tick(3499), "…and holds until graceMs has elapsed");
  check(tick(3500), "fires at exactly nowMs + graceMs");
  check(!tick(3500), "fires exactly ONCE (it re-arms, not re-fires)");
  check(tick(9999), "the re-armed deadline expires in its turn");

  // A racer coming back disarms it: the room is being played again. `_seen` is
  // the single writer that lifts a drop, so the walk that owns it is the way in.
  ttp_net_on_seen_json(h, "1", 10000);
  ttp_room_events_json(h);
  check(!tick(20000), "a reconnected racer disarms the deadline");
  check(!tick(99999), "…and it stays disarmed while they are here");

  // Leaving PLAYING disarms it too — the results board is not an abandoned race.
  leave(1, 100000);
  check(!tick(100001), "re-arms on the first qualifying tick");
  ttp_room_transition_to(h, "results");
  ttp_room_events_json(h);
  check(!tick(200000), "RESULTS is not a race to abandon");
  ttp_room_transition_to(h, "countdown");
  ttp_room_transition_to(h, "playing");
  ttp_room_events_json(h);
  check(!tick(300000), "the state change dropped the armed deadline");

  ttp_dispose(race);
  ttp_room_dispose(h);

  // ---- the participant set, computed against a LIVE RACE ---------------------
  // ttp_room_sync_active_order is the whole definition of "who this race is for",
  // taken in C++ rather than in each shell: every seat holding a car, plus every
  // dropped seat. It reads the sim through ttp_session.h, so this section drives
  // it with a REAL session — a room fed from a hand-written array proves the
  // room's half and nothing about the join.
  //
  // The case that matters is a late joiner who has ALSO dropped: a ghost seat, no
  // car, no phone. Against the raw COUNTDOWN snapshot it counts as someone
  // waiting and would yank a blipped party's whole race back to the lobby.
  const int g = ttp_room_create("{\"liveness\":{\"timeoutMs\":600000,\"graceMs\":1500}}");
  if (g <= 0) { fail("abandoned-race/ghost: ttp_room_create returned no handle"); return; }
  RoomFlow* gflow = ttp_room_flow(g);
  // The race: Ada (seat 1) plus a bot. The bot is deliberate — a car id that is
  // no seat at all must never become a participant.
  const int s = ttp_session_begin("tidepool", 42u, 3, nullptr);
  if (s <= 0 || !gflow) { fail("abandoned-race/ghost: no session or machine"); return; }
  ttp_add_human(s, "1", nullptr);
  ttp_add_bot(s, "\"ai-1\"", 1.0, 0.0, 7u, nullptr);
  ttp_session_start(s, 3);

  ttp_net_on_protocol_json(g, "created", "{\"room\":\"WXYZ\",\"instance\":\"m-2\"}", 0);
  ttp_net_on_protocol_json(g, "peer_joined", "{\"index\":1}", 0);
  ttp_room_transition_to(g, "countdown");
  ttp_room_transition_to(g, "playing");
  ttp_net_on_protocol_json(g, "peer_joined", "{\"index\":2}", 0);
  ttp_net_on_protocol_json(g, "peer_left", "{\"index\":1}", 0);
  ttp_net_on_protocol_json(g, "peer_left", "{\"index\":2}", 0);
  ttp_room_events_json(g);

  // RAW — the countdown snapshot, before anything syncs. Read and driven off
  // the machine because every ABI path to the deadline now syncs on its way in,
  // which is precisely the fix being demonstrated.
  check(gflow->hasLateJoiners(), "raw: a dropped ghost still reads as a late joiner");
  check(!gflow->graceTick(1000) && gflow->graceTick(3000),
        "raw: …and would abandon the race for nobody");

  // The walk's own tick, which syncs first: seat 1 holds a car and seat 2 is
  // dropped, so both are participants and nobody is waiting.
  const auto gtick = [&](double nowMs, int sessionHandle) {
    const Value w = parseOrNull(ttp_net_liveness_json(g, sessionHandle, nowMs), "liveness/ghost");
    bool abandoned = false;
    for (const Value& e : at(w, "effects").arr)
      abandoned = abandoned || json::str_field(e, "op") == "race-abandoned";
    ttp_net_on_peer_message_json(g, 0, "0", "{\"type\":\"_heartbeat\"}", 0, nowMs);
    ttp_room_events_json(g);
    return abandoned;
  };
  check(!gtick(4000, s) && !gtick(9999, s), "synced: the blipped party keeps its race");
  check(!gflow->hasLateJoiners(), "synced: a dropped ghost is absent, not waiting");
  check(gflow->lateJoinersValue().arr.empty(), "synced: …so it is no 'joining' row either");
  // The bot is racing and will never disconnect, so an order that swallowed cars
  // with no seat behind them could not read "every participant is gone" here.
  check(ttp_room_all_participants_disconnected_synced(g, s) == 1,
        "synced: a bot's car is nobody's seat, so the race still counts as abandoned");

  // The ghost's phone comes back — car-less and connected, which is a late joiner.
  ttp_net_on_seen_json(g, "2", 10000);
  ttp_room_events_json(g);
  check(!gtick(10000, s), "synced: a returning ghost re-arms rather than firing");
  check(gflow->hasLateJoiners(), "synced: a returning ghost is waiting again");
  {
    const Value v = ttp_room_late_joiners_synced(g, s);
    check(v.arr.size() == 1 && canonical_stringify(*v.arr[0].find("peerIndex")) == "2",
          "synced: the car-less seat is the one waiting");
  }
  check(gtick(11500, s), "synced: and the deadline runs for them");

  // The cars really come from the SIM, not from presence. With both seats back,
  // the ONLY thing separating them is that 1 holds a car and 2 does not — and
  // against session handle 0 (no session: the lobby, or a shell between races)
  // there are no cars and no dropped seats, so the order empties and both wait.
  ttp_net_on_seen_json(g, "1", 12000);
  ttp_room_events_json(g);
  check(ttp_room_late_joiners_synced(g, s).arr.size() == 1,
        "synced: the car-holder is a participant, the car-less seat is not");
  check(ttp_room_late_joiners_synced(g, 0).arr.size() == 2,
        "no session: no cars and no dropped seats leaves an empty order");
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

  // The gallery's showroom (ttp_display_showcase). The `showcase` ctest holds
  // the layer itself; what only this boundary can say is that the marshalled
  // list is one list, whichever biome is about to be built — the shell fetches
  // it BEFORE the build picks a look, and slot i must be the same model on both
  // sides of that gap. The playroom is the case that would catch a
  // biome-dependent answer here, since its own list is empty.
  const std::string showModels = ttp_theme_showcase_models();
  check(showModels.find("\"tree\"") != std::string::npos
                && showModels.find("\"cactus-tall\"") != std::string::npos
                && showModels.find("\"tree-snow-c\"") != std::string::npos,
        "the showcase model list spans every biome's scenery");
  check(showModels != ttp_theme_scenery_models("playroom"),
        "…and does not collapse to the picked biome's own list");
  check(showModels == ttp_theme_showcase_models(), "it is stable across calls");
  const std::string inventory = ttp_showcase_inventory_json();
  check(inventory.rfind("{\"clutter\":", 0) == 0, "the legend is canonical JSON");
  check(inventory.find("\"wind-up train\"") != std::string::npos,
        "…and names the kinds no single biome carries");
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

  // ttp_audio_roster — the join plink. This was the one shipped audio export
  // with no coverage anywhere: not here, not in a corpus, not in a JS test,
  // while main.js calls it on every roster change. Both of its arguments carry a
  // rule that a silent swap would break, and both are pinned here:
  //   the COUNT is remembered, so only a RISE is a join (a rename or a car pick
  //   keeps the count and must stay silent),
  //   and inLobby GATES it, because a mid-race arrival is a reconnect.
  auto joins = []() {
    const TtpAudioBlock* b = ttp_audio_drain();
    int n = 0;
    const TtpAudioCmd* cmds = ttp_audio_cmds(b);
    for (uint32_t i = 0; i < b->count; i++)
      if (cmds[i].kind == TTP_AUD_CUE && cmds[i].code == TTP_CUE_JOIN) n++;
    return n;
  };
  ttp_audio_roster(1, 1);                            // first sighting, seats the count
  ttp_audio_drain();
  ttp_audio_roster(2, 1);
  check(joins() == 1, "a roster that GREW in the lobby plinks");
  ttp_audio_roster(2, 1);
  check(joins() == 0, "the same roster again is a rename, not a guest");
  ttp_audio_roster(3, 0);
  check(joins() == 0, "a mid-race arrival is a reconnect and stays silent");
  ttp_audio_roster(4, 1);
  check(joins() == 1, "and the lobby plinks again once it is back");

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
//
// Not every op still has a way in. The roster projection, race flow, the pause
// arbitration and the standings board are handle walks now, so their JSON
// spellings are gone; those steps are SKIPPED and counted, and the count is
// printed so a skip set quietly swallowing the corpus cannot read as a pass.
// Two arms survive by being driven FROM the recording rather than compared
// against it — the seat grid off the recorded seats, the results overlay off
// the recorded board — which is legitimate: both are pure functions of a frozen
// JS answer, and holding them to one is the strongest input available.
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
// A `world` off a corpus header, checked before it is handed to a configure
// export. The type test alone is not enough: ttp_ui_configure treats "neither
// cups nor catalog" as "install the SHIPPED catalogue" and returns 1, so a
// hollow world configures CLEANLY and then diffs a hundred steps later against
// a catalogue nobody asked for. Refuse it where the cause is still visible.
const Value* corpusWorld(const Value& header, const char* what,
                         std::initializer_list<const char*> lists) {
  const Value* w = header.find("world");
  if (!json::is_obj(w)) {
    fail(std::string(what) + " corpus header carries no `world` object");
    return nullptr;
  }
  for (const char* k : lists) {
    const Value* v = w->find(k);
    if (!json::is_arr(v) || v->arr.empty()) {
      fail(std::string(what) + " corpus header's `world` has no " + k +
           " — configuring from it would silently install a different world");
      return nullptr;
    }
  }
  return w;
}

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

// One step through the C exports, answering in the corpus's `out` shape — or
// UNDEF for an op whose JSON-taking export is gone, which the caller counts and
// reports. `want` is the recorded answer, read by the one arm that is driven
// FROM the recording rather than compared against it (see "board").
Value uiStep(UiShell& st, const std::string& op, const Value& in, const Value& want) {
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
    // roster_seats / all_racers_ready / connected_players took a roster ARRAY;
    // all three read the live room now, so there is no JSON path to drive them
    // down. The seat GRID survives and still takes the seats array, so the
    // recorded seats feed it — a frozen JS seat list is a legitimate input.
    const Value* seats = want.find("seats");
    if (!seats) return Value();
    out.set("grid", uiJson(ttp_ui_seat_grid_json(canonical_stringify(*seats).c_str())));
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
  if (op == "flow" || op == "autopause" || op == "freeze") {
    // race_flow / auto_pause / the three freeze predicates were all replaced by
    // handle walks (ttp_ui_race_flow_live_json, ttp_race_auto_pause_live_json,
    // ttp_ui_freeze_plan_json), so their rules no longer take plain data at the
    // boundary. ui_check keeps replaying this corpus against the rules
    // themselves; the walks are gated by composition, not by replay.
    return Value();
  }
  if (op == "board") {
    // The board is gathered off live handles now — no JSON twin, so its gather
    // is gated in uiLiveTwinsMatchJsonPaths instead. What still replays is the
    // OVERLAY, driven from the board bytes the corpus RECORDED: resultsView is
    // a pure function of a board, and a frozen JS board is exactly the input it
    // should be held to.
    const Value* wire = want.find("wire");
    if (!wire || wire->type != Value::STR) return Value();
    const Value* over = in.find("over");
    out.set("view", (over && over->type == Value::BOOL && over->b)
                        ? uiJson(ttp_ui_results_view_json(wire->str.c_str(), UI_INTERMISSION_MS))
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
  const ttp::CupDef tie{ "t", "Tie", two, 2, 0, 0 };
  const ttp::CupDef tieLow{ "tl", "Tie Low", twoLow, 2, 0, 0 };
  const ttp::CupDef high{ "h", "High", four, 4, 0, 0 };
  check(ui::cupTendency(tie) == 3, "a mean of exactly 2.5 rounds UP, as Math.round does");
  check(ui::cupTendency(tieLow) == 2, "…and 1.5 does too, so it is half-up and not half-even");
  check(ui::cupTendency(high) == 4, "3.75 rounds to 4 — the case std::trunc would silently drop");

  // The override wins outright, and is not averaged with anything.
  const ttp::CupDef pinned{ "p", "Pinned", four, 4, 1, 0 };
  check(ui::cupTendency(pinned) == 1, "an authored tendency is used verbatim");

  // A cup with no tracks has no mean; JS `sum/0` was NaN and Math.round(NaN) is
  // NaN, which the picker read as no meter. The C++ answers the middling 2
  // rather than propagating a NaN through an int.
  const ttp::CupDef empty{ "e", "Empty", nullptr, 0, 0, 0 };
  check(ui::cupTendency(empty) == 2, "an empty cup falls back rather than dividing by zero");
}

void uiCorpusThroughAbi(const char* path) {
  std::ifstream in(path);
  if (!in) { fail(std::string("cannot open ") + path); return; }

  UiShell st;
  std::string line, scenario;
  int steps = 0, skipped = 0;
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
      const Value* world = corpusWorld(root, "ui", {"cups", "catalog"});
      if (!world) return;
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
    const Value got = uiStep(st, opV->str, inV && inV->type == Value::OBJ ? *inV : empty, *wantOut);
    if (got.type == Value::UNDEF) { skipped++; continue; }
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
  // Printed rather than silent: a skip count that quietly grows to swallow the
  // whole corpus reads exactly like a passing run from the assertion total.
  std::printf("  ui corpus through the ui ABI: %d steps (%d ops with no JSON spelling left)\n",
              steps, skipped);
}


}  // namespace

// ---------------------------------------------------------------------------
// The handle-taking gathers against the rules they gather for.
//
// NO CORPUS COVERS THIS, and that is exactly why it is here. Every frozen
// fixture in the tree feeds a layer plain data and reads its answer back, so it
// gates the RULES; ttp_net_lobby_frame and ttp_ui_roster_seats_room_json add no
// rule at all — they GATHER, in C++, what a shell used to gather in JS and hand
// back. The only thing that can be wrong with them is the gathering, so the
// statement of what "right" means is that each equals its rule composed over
// the state the room ABI still hands out.
//
// Assert the equivalence, not the bytes: the expected value is computed in the
// same run by composing the C++ RULES the walk calls, so this stays true when
// the snapshot's shape changes and can never become a second, stale copy of the
// wire format.
void handlePathsMatchJsonPaths() {
  const int room = ttp_room_create("{}");
  RoomFlow* flow = ttp_room_flow(room);
  if (room <= 0 || !flow) { fail("lobby-frame: ttp_room_create returned no handle"); return; }

  const char* kChooser = "{\"cars\":[{\"id\":\"dash\"}],\"colors\":[\"#f00\",\"#0f0\"],"
                         "\"tracks\":[{\"id\":\"tidepool\",\"name\":\"Tidepool\"}]}";
  ttp_net_configure(kChooser);
  // The same object the ABI now holds internally. lobby_snapshot keeps it
  // OPAQUE, so re-parsing the configured text is the whole of the copy.
  const Value chooser = parseOrNull(kChooser, "chooser");

  // Three seats: one that will hold a car, one that will not (a late joiner),
  // and one dropped — so `inRace`, `connected` and the host election all carry
  // something the comparison could catch.
  ttp_room_add_player(room, "1", "{\"name\":\"Ada\",\"colorIndex\":0,\"carIndex\":2,\"ready\":true}");
  ttp_room_add_player(room, "2", "{\"name\":\"Bo\",\"colorIndex\":1,\"carIndex\":null,\"ready\":false}");
  ttp_room_add_player(room, "3", "{\"name\":\"Cy\",\"colorIndex\":1,\"ready\":false}");
  flow->markDisconnected(PeerId::Num(3));

  const int sess = ttp_session_begin("tidepool", 7u, 3, nullptr);
  if (sess <= 0) { fail("lobby-frame: ttp_session_begin returned no handle"); return; }
  ttp_add_human(sess, "1", nullptr);
  ttp_add_human(sess, "3", nullptr);   // a dropped seat still holds its car

  // The shell hands over only what the walks cannot know; the pick rides the
  // room handle (staged here exactly as a select_mode walk would store it).
  const char* kFields = "{\"paused\":false,\"standings\":null}";
  const char* kPick =
      "{\"mode\":\"cup\",\"cupId\":\"beach\",\"randomRaces\":0,"
      "\"trackId\":\"tidepool\",\"hasBag\":false}";
  ttp_room_store_pick(room, parseOrNull(kPick, "staged pick"));

  // The old path, spelled out: the pick plus the four room keys the shell used
  // to gather, each through the ABI call it used to make — and then the two
  // RULES the walk folds together, called directly. session::lobby_snapshot is
  // the frozen, corpus-pinned composer; encode_set_state is the framer. The
  // walk may not be anything other than their composition.
  const auto twoCallFrame = [&](int r, int s) {
    Value input = parseOrNull(kFields, "lobby-frame fields");
    const Value pick = parseOrNull(kPick, "lobby-frame pick");
    for (const char* k : {"mode", "cupId", "randomRaces", "trackId"})
      input.set(k, *pick.find(k));
    Value roster = parseOrNull(ttp_room_list_json(r), "room list");
    Value inRace = Value::Arr();
    for (const Value& seat : roster.arr) {
      const std::string id = canonical_stringify(*seat.find("peerIndex"));
      inRace.push(Value::Bool(ttp_has_car(s, id.c_str()) != 0));
    }
    input.set("roster", roster);
    input.set("inRace", inRace);
    input.set("hostPeerIndex", parseOrNull(ttp_room_host_json(r), "room host"));
    input.set("roomState", Value::Str(ttp_room_state(r)));
    const std::string snapshot = ordered_stringify(ns::lobby_snapshot(input, chooser));
    return std::string(ttp_framing_encode_set_state(snapshot.c_str()));
  };

  const auto sameFrame = [&](int r, int s, const char* where) {
    const std::string want = twoCallFrame(r, s);
    const std::string got = ttp_net_lobby_frame(r, s, kFields);
    check(got == want, std::string("ttp_net_lobby_frame == snapshot+encode (") + where + ")");
  };

  // The seat projection, off the roster the room ABI hands out, against the
  // rule the walk calls. Field for field rather than byte for byte: the encoder
  // has no JSON twin left, and a writer spelled here would be the stale second
  // copy the charter above forbids.
  const auto sameSeats = [&](int r, const char* host, const char* where) {
    const std::vector<ui::Seat> want =
        ui::rosterSeats(rosterEntriesOf(parseOrNull(ttp_room_list_json(r), "room list")),
                        parse_scalar_id(host));
    const Value got = parseOrNull(ttp_ui_roster_seats_room_json(r, host), "roster seats");
    const std::string at_ = std::string("ttp_ui_roster_seats_room_json == ui::rosterSeats (") +
                            where + ")";
    if (got.arr.size() != want.size()) { fail(at_ + ": " + std::to_string(got.arr.size()) +
                                              " seats, rule says " + std::to_string(want.size()));
                                         checks++; return; }
    bool ok = true;
    for (size_t i = 0; i < want.size(); i++) {
      const Value& g = got.arr[i];
      ok = ok && json::str_field(g, "name") == want[i].name &&
           json::num_field(g, "colorIndex") == want[i].colorIndex &&
           canonical_stringify(at(g, "carIndex")) ==
               canonical_stringify(optVal(want[i].carIndex)) &&
           json::truthy(g.find("connected")) == want[i].connected &&
           json::truthy(g.find("host")) == want[i].host &&
           json::truthy(g.find("ready")) == want[i].ready;
    }
    check(ok, at_);
  };

  sameFrame(room, sess, "lobby, a live race");
  sameSeats(room, "1", "lobby, host 1");
  sameSeats(room, "null", "lobby, no host");

  // Phase matters: `tracks` rides the LOBBY snapshot only, and the frame has to
  // pick that up from the room rather than from an argument.
  ttp_room_transition_to(room, "countdown");
  sameFrame(room, sess, "countdown, tracks gated out");
  ttp_room_transition_to(room, "playing");
  sameFrame(room, sess, "playing");
  sameSeats(room, "1", "playing");

  // NO SESSION is the lobby's own case, and the one an inRace default could get
  // wrong in a direction nothing else would notice: every seat answers false.
  sameFrame(room, 0, "no session");
  {
    Value frame = parseOrNull(ttp_net_lobby_frame(room, 0, kFields), "frame, no session");
    const Value* players = frame.find("data") ? frame.find("data")->find("players") : nullptr;
    bool anyInRace = false;
    if (players && players->type == Value::ARR) {
      for (const Value& p : players->arr) anyInRace = anyInRace || json::truthy(p.find("inRace"));
    }
    check(players && players->type == Value::ARR && !anyInRace,
          "no session: every seat's inRace is false");
  }

  // A roster that MOVES under both spellings — the gathering reads it live, so a
  // stale read would show up here and nowhere else.
  flow->removePlayer(PeerId::Num(2));
  sameFrame(room, sess, "after a seat leaves");
  sameSeats(room, "1", "after a seat leaves");

  // Unknown handles: an empty room, not a crash and not a stale answer.
  //
  // NOT compared against the two-call path, and the reason is worth writing
  // down. ttp_room_state spells an unknown handle's phase as the literal text
  // "null" (it is a raw string return, so it has no other way to say "absent"),
  // while the seam spells it "". Every reader treats both as "not a phase" —
  // tracks gate out, presence/leave actions fall through — so the two frames
  // differ only in that one field's spelling, in a case no shell can reach:
  // DisplayNet creates its room in the constructor and never publishes without
  // one. Asserting the frames equal here would be asserting a wart.
  sameSeats(0, "null", "unknown room handle");
  check(std::strcmp(ttp_ui_roster_seats_room_json(0, "null"), "[]") == 0,
        "ttp_ui_roster_seats_room_json on handle 0 is []");
  {
    Value frame = parseOrNull(ttp_net_lobby_frame(0, 0, kFields), "frame, unknown room");
    const Value* data = frame.find("data");
    const Value* players = data ? data->find("players") : nullptr;
    check(players && players->type == Value::ARR && players->arr.empty(),
          "unknown room handle: a well-formed frame with no players");
  }

  ttp_dispose(sess);
  // A DISPOSED session must read as no race, not as the race it used to be.
  sameFrame(room, sess, "disposed session");
  ttp_room_dispose(room);
}

// ---------------------------------------------------------------------------
// The ui LIVE twins (ttp_ui.h's *_live_json) against the rules they gather for.
// Same charter as handlePathsMatchJsonPaths: a twin adds no rule — it GATHERS
// the input the shell used to assemble (main.js's raceRoleSets / seriesInfo /
// standingsPayload, transcribed below call for call) — so the statement of
// correctness is that each answer is its rule's output over that assembly, in
// the same run.
//
// Race flow is compared byte for byte: two values, no encoder restated. The
// chip and the board are compared FIELD for field, because their encoders lost
// their JSON twins and a writer spelled here would be the stale second copy of
// the wire format. The one byte comparison left inside the board is the one
// that matters most — its nested chip must BE the chip export's answer, which
// is the nesting a shell composing the two by hand got wrong.
// ---------------------------------------------------------------------------
// The chip's input off the ONE state read, spelled as ttp_ui.cc spells it off
// the series object. This is the gather the twin performs; running the rule
// over it is what says the twin gathered the right things.
ui::SeriesInput seriesInputOfState(const Value& state, double autoAdvanceMs) {
  const Value cup = at(state, "cup");
  ui::SeriesInput si;
  si.cupId = ui::OptStr::Of(json::str_field(cup, "id"));
  si.cupName = ui::OptStr::Of(json::str_field(cup, "name"));
  si.endless = json::truthy(state.find("endless"));
  si.raceIndex = json::num_field(state, "raceIndex");
  si.raceCount = ui::OptNum::Of(json::num_field(state, "raceCount"));
  si.finished = json::truthy(state.find("finished"));
  si.nextTrackId = json::opt_str<ui::OptStr>(state.find("nextTrack"));
  si.autoAdvanceMs = autoAdvanceMs;
  return si;
}

// The chip, field for field. Not byte for byte: seriesInfo's encoder has no
// JSON twin left, so a writer spelled here would be the stale second copy of
// the wire format the charter forbids. Every field the rule answers is checked.
void sameSeriesInfo(const Value& got, const ui::SeriesInfo& want, const std::string& where) {
  const auto same = [&](const char* key, const Value& expected) {
    check(canonical_stringify(at(got, key)) == canonical_stringify(expected),
          where + ": " + key + " expected " + canonical_stringify(expected) + ", got " +
              canonical_stringify(at(got, key)));
  };
  same("cupId", optVal(want.cupId));
  same("cupName", optVal(want.cupName));
  same("endless", Value::Bool(want.endless));
  same("raceIndex", Value::Num(want.raceIndex));
  same("raceCount", optVal(want.raceCount));
  same("nextTrackId", optVal(want.nextTrackId));
  same("nextTrackName", optVal(want.nextTrackName));
  same("final", Value::Bool(want.isFinal));   // `isFinal` in C++, `final` on the wire
  same("autoAdvanceMs", Value::Num(want.autoAdvanceMs));
}

void uiLiveTwinsMatchJsonPaths() {
  // The chip and the board resolve track NAMES against the configured
  // catalogue, so the composed expectations have to run over the same one.
  // Omitting both lists installs the shipped world, which ui::shippedCatalog()
  // is then the reader for — no second copy either side of the boundary.
  check(ttp_ui_configure("{\"maxPlayers\":4,\"carCount\":12}") == 1,
        "ui twins: the shipped catalogue configured");
  const std::vector<ui::CatalogEntry> catalog = ui::shippedCatalog();

  const int room = ttp_room_create("{}");
  RoomFlow* flow = ttp_room_flow(room);
  if (room <= 0 || !flow) { fail("ui-twins: ttp_room_create returned no handle"); return; }
  // Ada races and stays; Bo waits (late joiner); Cy races but dropped.
  ttp_room_add_player(room, "1", "{\"name\":\"Ada\",\"colorIndex\":0,\"carIndex\":2,\"ready\":true}");
  ttp_room_add_player(room, "2", "{\"name\":\"Bo\",\"colorIndex\":1,\"carIndex\":null,\"ready\":false}");
  ttp_room_add_player(room, "3", "{\"name\":\"Cy\",\"colorIndex\":3,\"ready\":true}");
  flow->markDisconnected(PeerId::Num(3));

  const int sess = ttp_session_begin("tidepool", 7u, 3, nullptr);
  if (sess <= 0) { fail("ui-twins: ttp_session_begin returned no handle"); return; }
  ttp_add_human(sess, "1", nullptr);
  ttp_add_human(sess, "3", nullptr);
  ttp_add_bot(sess, "\"ai-0\"", 1.0, 0.0, 1u, nullptr);
  ttp_add_bot(sess, "\"ai-1\"", 0.9, 0.2, 2u, nullptr);

  // ---- race flow: the role sets main.js gathered, then the two rules --------
  // Byte for byte here, because the answer is two values and no encoder is
  // being restated: {"allDone":bool,"forfeit":[id,...]}, in that order.
  const auto wantRaceFlow = [&](int s, int r) {
    std::vector<ui::Id> carIds;
    ui::IdSet ai, disc, fin;
    const Value ids = parseOrNull(ttp_car_ids_json(s), "car ids");
    RoomFlow* rf = ttp_room_flow(r);
    for (const Value& idV : ids.arr) {
      const ui::Id id = json::id_of<ui::Id>(&idV);
      carIds.push_back(id);
      if (rf && rf->isDisconnected(id)) disc.add(id);
      if (ttp_car_finished(s, canonical_stringify(idV).c_str()) == 1) fin.add(id);
    }
    // main.js kept its own aiCarIds Set; the twin reads the bot registry. The
    // comparison spells the shell's copy literally, exactly as it did.
    ai.add(ui::Id::Str("ai-0"));
    ai.add(ui::Id::Str("ai-1"));
    Value o = Value::Obj();
    o.set("allDone", Value::Bool(ui::humansAllDone(carIds, ai, disc, fin)));
    Value f = Value::Arr();
    for (const ui::Id& id : ui::forfeitCandidates(carIds, ai, disc)) f.push(id.toValue());
    o.set("forfeit", std::move(f));
    return ordered_stringify(o);
  };
  const auto sameRaceFlow = [&](const char* where) {
    const std::string want = wantRaceFlow(sess, room);
    const std::string got = ttp_ui_race_flow_live_json(sess, room);
    check(got == want, std::string("ttp_ui_race_flow_live_json == the two rules (") + where +
                           ")\n  want " + want + "\n  got  " + got);
  };
  sameRaceFlow("mid-race, one dropped");
  ttp_force_finish(sess, "1", 42.5);
  sameRaceFlow("after a finish");
  // No session: the shell answered its constant without crossing at all.
  check(std::string(ttp_ui_race_flow_live_json(0, room)) == "{\"allDone\":false,\"forfeit\":[]}",
        "ttp_ui_race_flow_live_json without a session is the no-race constant");

  ttp_room_transition_to(room, "countdown");
  ttp_room_transition_to(room, "playing");
  ttp_room_events_json(room);

  // ---- the Grand Prix chip --------------------------------------------------
  const int gp = ttp_gp_create(
      "{\"id\":\"cup-a\",\"name\":\"Sunrise\",\"tracks\":[\"tidepool\",\"helix\"]}", 0);
  if (gp <= 0) { fail("ui-twins: ttp_gp_create returned no handle"); return; }
  const double kMs = 10000;

  const auto chipRule = [&](int g) {
    return ui::seriesInfo(seriesInputOfState(parseOrNull(ttp_gp_state_json(g), "gp state"), kMs),
                          catalog);
  };
  sameSeriesInfo(parseOrNull(ttp_ui_series_info_live_json(gp, kMs), "series info live"),
                 chipRule(gp), "series_info_live, race 1 of the cup");
  check(std::string(ttp_ui_series_info_live_json(0, kMs)) == "null",
        "ttp_ui_series_info_live_json without a series is null");

  const char* kField =
      "[{\"peerIndex\":1,\"name\":\"Ada\",\"colorIndex\":0,\"ai\":false},"
      "{\"peerIndex\":3,\"name\":\"Cy\",\"colorIndex\":3,\"ai\":false},"
      "{\"peerIndex\":\"ai-0\",\"name\":\"Alpha\",\"colorIndex\":4,\"ai\":true},"
      "{\"peerIndex\":\"ai-1\",\"name\":\"Beta\",\"colorIndex\":5,\"ai\":true}]";

  // ---- the standings board --------------------------------------------------
  // broadcastStandings' four sources, gathered as the shell gathered them, then
  // ui::standingsPayload over them. The board's own encoder has no JSON twin
  // left, so the comparison walks the answer against the rule's Board.
  const auto wantBoard = [&](int g, bool over, const char* resultsJson) {
    const Value resultsObj = resultsJson ? parseOrNull(resultsJson, "explicit results")
                                         : parseOrNull(ttp_results_json(sess), "live results");
    std::vector<ui::ResultRow> results;
    for (const Value& r : at(resultsObj, "results").arr) {
      ui::ResultRow rr;
      rr.playerId = json::id_of<ui::Id>(r.find("playerId"));
      rr.finished = json::truthy(r.find("finished"));
      rr.time = json::opt_num<ui::OptNum>(r.find("time"));
      results.push_back(std::move(rr));
    }
    std::vector<ui::FieldRow> field;
    for (const Value& f : parseOrNull(kField, "field").arr) {
      ui::FieldRow fr;
      fr.peerIndex = json::id_of<ui::Id>(f.find("peerIndex"));
      fr.name = json::str_field(f, "name");
      fr.colorIndex = json::opt_num<ui::OptNum>(f.find("colorIndex"));
      fr.ai = json::truthy(f.find("ai"));
      field.push_back(std::move(fr));
    }
    std::vector<ui::StandingRow> standings;
    ui::CupBoard cup;
    if (g) {
      for (const Value& s : at(parseOrNull(ttp_gp_state_json(g), "gp state"), "standings").arr) {
        ui::StandingRow sr;
        sr.playerId = json::id_of<ui::Id>(s.find("playerId"));
        sr.points = json::num_field(s, "points");
        sr.gained = json::num_field(s, "gained");
        standings.push_back(std::move(sr));
      }
      cup.standings = &standings;
      cup.info = chipRule(g);
    }
    // DisplayNet.lateJoiners() pushes the live car set in BEFORE reading — the
    // late set is defined by subtraction from the active order, so the sync is
    // part of the gather, not an optimization. The seam holds the two together.
    std::vector<ui::LateJoiner> late;
    for (const Value& l : ttp_room_late_joiners_synced(room, sess).arr) {
      ui::LateJoiner lj;
      lj.peerIndex = json::id_of<ui::Id>(l.find("peerIndex"));
      lj.name = json::str_field(l, "name");
      lj.colorIndex = json::num_field(l, "colorIndex");
      late.push_back(std::move(lj));
    }
    const Value hostV = parseOrNull(ttp_room_host_json(room), "host");
    return ui::standingsPayload(results, field, cup.standings ? &cup : nullptr, late,
                                json::id_of<ui::Id>(&hostV), over);
  };

  const auto sameStandings = [&](int g, bool over, const char* resultsJson, const char* where) {
    const ui::Board want = wantBoard(g, over, resultsJson);
    const Value got = parseOrNull(
        ttp_ui_standings_live_json(sess, room, g, over ? 1 : 0, kField, resultsJson, kMs),
        "standings live");
    const std::string at_ = std::string("ttp_ui_standings_live_json == ui::standingsPayload (") +
                            where + ")";
    check(json::truthy(got.find("over")) == want.over, at_ + ": over");
    check(canonical_stringify(at(got, "hostPeerIndex")) ==
              canonical_stringify(want.hostPeerIndex.toValue()),
          at_ + ": hostPeerIndex");
    check(json::num_field(got, "total") == (double)want.total(), at_ + ": total");
    const Value order = at(got, "order");
    check(order.arr.size() == want.order.size(), at_ + ": row count");
    if (order.arr.size() != want.order.size()) return;
    bool rows = true;
    for (size_t i = 0; i < want.order.size(); i++) {
      const Value& r = order.arr[i];
      const ui::BoardRow& w = want.order[i];
      rows = rows && canonical_stringify(at(r, "playerId")) ==
                         canonical_stringify(w.playerId.toValue()) &&
             json::str_field(r, "name") == w.name &&
             json::num_field(r, "colorIndex") == w.colorIndex &&
             json::truthy(r.find("joining")) == w.joining &&
             (r.find("points") != nullptr) == w.hasPoints &&
             (!w.hasPoints || json::num_field(r, "points") == w.points) &&
             (!w.hasGained || json::num_field(r, "gained") == w.gained) &&
             (w.joining || (json::truthy(r.find("ai")) == w.ai &&
                            json::truthy(r.find("finished")) == w.finished &&
                            canonical_stringify(at(r, "time")) ==
                                canonical_stringify(optVal(w.time))));
    }
    check(rows, at_ + ": every row");
    // The cup half is NESTED — one `cup` object, never two sibling keys — and
    // the chip inside it must be the same bytes the chip export answers, which
    // is the one place a byte comparison is available and is exactly the
    // mismatch a shell composing the two by hand used to ship.
    if (g) {
      check(canonical_stringify(at(got, "series")) ==
                canonical_stringify(parseOrNull(ttp_ui_series_info_live_json(g, kMs), "chip")),
            at_ + ": the board's chip IS ttp_ui_series_info_live_json");
    } else {
      check(!got.has("series"), at_ + ": a plain race carries no chip at all");
    }
  };
  sameStandings(0, false, nullptr, "plain race, live board");
  sameStandings(gp, false, nullptr, "cup, live board");
  sameStandings(gp, true, nullptr, "cup, final board off the session");
  // endRace's own results object, as the perform context carries it.
  sameStandings(gp, true,
                "{\"results\":[{\"playerId\":1,\"finished\":true,\"time\":42.5},"
                "{\"playerId\":3,\"finished\":false,\"time\":null}]}",
                "cup, final board off the callback argument");

  // ---- the endless-draw gate ------------------------------------------------
  // NativeCupSeries spelled `drawNext && raceIndex >= raceCount - 1`; the state
  // object owns the index half now. A fixed cup never draws; an endless series
  // draws exactly while sitting on its last queued race.
  const auto needsDraw = [&](int g) {
    const Value st = parseOrNull(ttp_gp_state_json(g), "gp state");
    return json::truthy(st.find("needsDraw"));
  };
  const auto oldSpelling = [&](int g) {
    const Value st = parseOrNull(ttp_gp_state_json(g), "gp state");
    return json::truthy(st.find("endless")) &&
           json::num_field(st, "raceIndex") >= json::num_field(st, "raceCount") - 1;
  };
  check(!needsDraw(gp), "a fixed cup never needs a draw");
  const int egp = ttp_gp_create("{\"id\":\"random\",\"name\":\"Random\",\"tracks\":[\"tidepool\"]}", 1);
  check(needsDraw(egp) == oldSpelling(egp), "needsDraw == the adapter's old spelling (fresh)");
  check(needsDraw(egp), "a one-track endless series draws immediately");
  ttp_gp_apply_race(egp, "[{\"playerId\":1,\"rank\":1,\"finished\":true}]",
                    "[{\"peerIndex\":1,\"name\":\"Ada\",\"colorIndex\":0,\"ai\":false}]",
                    "\"helix\"");
  ttp_gp_advance(egp);
  check(needsDraw(egp) == oldSpelling(egp), "needsDraw == the adapter's old spelling (advanced)");
  check(std::strcmp(ttp_gp_state_json(0), "null") == 0, "gp state on handle 0 is null");

  // ---- the freeze plan ------------------------------------------------------
  // The plan's transition must agree with the frozen-corpus-pinned rule over
  // all eight inputs, and the two op lists are literal contracts.
  for (int p = 0; p <= 1; p++)
    for (int ap = 0; ap <= 1; ap++)
      for (int sp = 0; sp <= 1; sp++) {
        const Value plan = parseOrNull(ttp_ui_freeze_plan_json(p, ap, sp), "freeze plan");
        check(json::str_field(plan, "transition") ==
                  ui::key(ui::freezeTransition(p != 0, ap != 0, sp != 0)),
              "freeze plan transition == ui::freezeTransition");
      }
  check(std::string(ttp_ui_freeze_plan_json(1, 0, 0)) ==
            "{\"transition\":\"freeze\",\"ops\":[\"pause-session\",\"stop-voices\","
            "\"pause-music\",\"hold-cars\"]}",
        "freeze ops, in order");
  check(std::string(ttp_ui_freeze_plan_json(0, 0, 1)) ==
            "{\"transition\":\"thaw\",\"ops\":[\"resume-session\",\"release-cars\","
            "\"resume-music\"]}",
        "thaw ops, in order — voices never restart");
  check(std::string(ttp_ui_freeze_plan_json(0, 0, 0)) ==
            "{\"transition\":\"none\",\"ops\":[]}",
        "no transition, no ops");

  // ---- the results button's action ------------------------------------------
  check(std::string(ttp_ui_results_action_json(gp)) == "\"advance\"",
        "mid-cup: the button advances");
  check(std::string(ttp_ui_results_action_json(egp)) == "\"advance\"",
        "endless: the button always advances");
  check(std::string(ttp_ui_results_action_json(0)) == "\"return-to-lobby\"",
        "no series: the button returns to the lobby");
  {
    const int fgp = ttp_gp_create("{\"id\":\"c\",\"name\":\"C\",\"tracks\":[\"tidepool\"]}", 0);
    ttp_gp_apply_race(fgp, "[{\"playerId\":1,\"rank\":1,\"finished\":true}]",
                      "[{\"peerIndex\":1,\"name\":\"Ada\",\"colorIndex\":0,\"ai\":false}]",
                      nullptr);
    ttp_gp_advance(fgp);
    check(json::truthy(parseOrNull(ttp_gp_state_json(fgp), "gp state").find("finished")),
          "one-track cup is finished after its race");
    check(std::string(ttp_ui_results_action_json(fgp)) == "\"return-to-lobby\"",
          "finished cup: the button returns to the lobby");
    ttp_gp_dispose(fgp);
  }

  // ---- the controller-message verdict ---------------------------------------
  // Host is Ada (peer 1, earliest join). Bo (2) is not ready, so a start is
  // refused even FROM the host; flipping Bo ready opens the gate. The room is
  // back in the lobby for it — readiness is a lobby concept.
  ttp_room_transition_to(room, "results");
  ttp_room_transition_to(room, "lobby");
  ttp_room_events_json(room);
  const auto act = [&](const char* from, const char* type, int s) {
    return std::string(ttp_net_controller_action(room, s, from, type));
  };
  check(act("1", "start_game", sess) == "none", "start: host but not all ready");
  check(act("2", "start_game", sess) == "none", "start: not the host");
  check(act("2", "series_next", sess) == "none", "series-next: not the host");
  check(act("1", "series_next", sess) == "series-next", "series-next: the host");
  check(act("1", "pause_game", sess) == "pause", "pause: any player");
  check(act("3", "resume_game", sess) == "resume", "resume: any player");
  check(act("3", "return_to_lobby", sess) == "return-to-lobby", "new game: any player");
  check(act("1", "control", sess) == "control", "control: live race");
  check(act("1", "control", 0) == "none", "control: no race, no input");
  check(act("1", "no_such_type", sess) == "none", "unknown type is none");
  ttp_room_set_field(room, "2", "ready", "true");
  check(act("1", "start_game", sess) == "start-race", "start: host, everyone ready");

  ttp_gp_dispose(egp);
  ttp_gp_dispose(gp);
  ttp_dispose(sess);
  ttp_room_dispose(room);
}

// ---------------------------------------------------------------------------
// ttp_session_begin_field against the begin + add loop it replaces. The
// composite adds no rule — same buckets, same order, same defaults — so the
// two constructions must produce bit-identical worlds under identical driving.
// ---------------------------------------------------------------------------
void beginFieldMatchesManualPath() {
  const int a = ttp_session_begin_field(
      "tidepool", 7u, 3, nullptr,
      "[{\"peerIndex\":1,\"stats\":{\"accel\":1.05},\"name\":\"Ada\",\"colorIndex\":0},"
      "{\"peerIndex\":\"ai-7\",\"stats\":null},"
      "{\"peerIndex\":3}]",
      "[{\"peerIndex\":\"ai-7\",\"caution\":0.9,\"laneBias\":0.2,\"seed\":42},"
      "{\"peerIndex\":\"ai-9\"}]");   // a spec no field entry names is inert
  if (a <= 0) { fail("begin_field: no handle"); return; }

  // The manual path, spelled as the shells' one-pass loop spelled it —
  // including the defaults the loop applied for an all-absent bot spec.
  const int b = ttp_session_begin("tidepool", 7u, 3, nullptr);
  if (b <= 0) { fail("begin_field: manual twin got no handle"); return; }
  ttp_add_human(b, "1", "{\"accel\":1.05}");
  ttp_add_bot(b, "\"ai-7\"", 0.9, 0.2, 42u, nullptr);
  ttp_add_human(b, "3", nullptr);

  ttp_session_start(a, -1);
  ttp_session_start(b, -1);
  for (int i = 0; i < 30; i++) { ttp_update(a, 16.6667); ttp_update(b, 16.6667); }

  check(std::string(ttp_car_ids_json(a)) == ttp_car_ids_json(b),
        "begin_field: same grid as the manual loop");
  check(std::string(ttp_snapshot_json(a)) == ttp_snapshot_json(b),
        "begin_field: bit-identical world after 30 driven frames");
  check(std::string(ttp_events_json(a)) == ttp_events_json(b),
        "begin_field: same event stream");

  // An absent-knob spec means the defaults, not zeros: a bot spelled {} must
  // drive exactly like caution 1 / laneBias 0 / seed 1.
  const int c = ttp_session_begin_field("tidepool", 7u, 3, nullptr,
      "[{\"peerIndex\":\"ai-0\"}]", "[{\"peerIndex\":\"ai-0\"}]");
  const int d = ttp_session_begin("tidepool", 7u, 3, nullptr);
  ttp_add_bot(d, "\"ai-0\"", 1.0, 0.0, 1u, nullptr);
  ttp_session_start(c, -1);
  ttp_session_start(d, -1);
  for (int i = 0; i < 30; i++) { ttp_update(c, 16.6667); ttp_update(d, 16.6667); }
  check(std::string(ttp_snapshot_json(c)) == ttp_snapshot_json(d),
        "begin_field: {} spec == the engine defaults");

  ttp_dispose(a); ttp_dispose(b); ttp_dispose(c); ttp_dispose(d);
}

// ---------------------------------------------------------------------------
// The choreography walks (ttp_net.h's second section) against the multi-call
// path they replace.
//
// Same charter as handlePathsMatchJsonPaths, one level up: a walk adds no rule
// — it SEQUENCES the fine-grained exports against the live room the way
// public/display/Net.js used to inline — so the only statement of correctness
// is agreement with that sequence, executed here through the same exports the
// shell called, in the same order, in the same run. Each trigger is applied to
// TWO rooms: one through the walk, one through a shell twin transcribed from
// the pre-walk Net.js. After every trigger the roster (ttp_room_list_json),
// the room state and the drained event stream must be byte-identical, and the
// walk's effects must equal what the twin's sequence implies.
//
// The mode pick has no old multi-call path (it was shell JS), so its cases
// assert literal effect lists instead of derived ones.
// ---------------------------------------------------------------------------
namespace {

// Every op these scenarios actually raised, so the vocabulary export can be
// held to them at the end. A walk that grew an op nobody added to the table
// would ship a shell whose performer switch has no arm for it.
std::vector<std::string> g_netOpsSeen;

// The walk answer, parsed. canonical re-stringify normalizes the model key
// order away, so expected lists can be built with Value::set in any order.
Value walkOf(const char* answerJson, const char* where) {
  Value v = parseOrNull(answerJson, where);
  const Value* eff = v.find("effects");
  check(eff && eff->type == Value::ARR, std::string(where) + ": answer carries effects[]");
  if (eff && eff->type == Value::ARR) {
    for (const Value& e : eff->arr) {
      const std::string op = json::str_field(e, "op");
      bool seen = false;
      for (const std::string& s : g_netOpsSeen) seen = seen || s == op;
      if (!seen) g_netOpsSeen.push_back(op);
    }
  }
  return v;
}

Value peerEffect(const char* op, double peerIndex) {
  Value e = Value::Obj();
  e.set("op", Value::Str(op));
  e.set("peerIndex", Value::Num(peerIndex));
  return e;
}

Value bareEffect(const char* op) {
  Value e = Value::Obj();
  e.set("op", Value::Str(op));
  return e;
}

// The pre-walk shell, transcribed: every helper is one of Net.js's private
// methods, in the same order, RECORDING the platform ops it would have
// performed (the expected effect list).
//
// It used to spell each step as the ABI call the shell made. Those one-rule
// exports are gone, so each is now the RULE the walk itself calls —
// ttp::session::add_peer_plan / claim_plan / norm_index / state_change_plan and
// RoomFlow's own mutators — driven against a SECOND room machine. That is a
// stronger statement than before, not a weaker one: the twin can no longer
// agree with the walk by accident of sharing a marshaller.
struct ShellTwin {
  int room = 0;
  RoomFlow* flow = nullptr;
  Value expected = Value::Arr();

  void reset() { expected = Value::Arr(); }

  // Net.js _seen
  void seen(double id, double now) {
    const PeerId p = PeerId::Num(id);
    flow->onSeen(p, now);
    if (flow->isDisconnected(p)) {
      flow->markReconnected(p);
      expected.push(peerEffect("clear-reconnect", id));
    }
  }

  // Net.js _addPeer (colour scan + lowestFreeSlot + add_peer_plan + addPlayer)
  void addPeer(double id, double now) {
    std::vector<double> used;
    for (const Value& p : flow->listValue().arr)
      if (const Value* c = p.find("colorIndex"))
        if (c->type == Value::NUM) used.push_back(c->num);
    const int slot = lowest_free_slot(used, protocol::MAX_PLAYERS);
    const PeerId p = PeerId::Num(id);
    const ns::AddPeerPlan plan = ns::add_peer_plan(
        flow->has(p), static_cast<double>(flow->size()), protocol::MAX_PLAYERS, slot);
    if (plan.hasSeat) {
      std::vector<std::pair<std::string, Value>> fields;
      fields.emplace_back("name", Value::Str(ns::seat_name(plan.seat)));
      fields.emplace_back("colorIndex", Value::Num(plan.seat.colorIndex));
      fields.emplace_back("carIndex", Value::Num(plan.seat.carIndex));
      fields.emplace_back("ready", Value::Bool(plan.seat.ready));
      flow->addPlayer(p, fields);
    }
    if (plan.stamp) seen(id, now);
  }

  // Net.js _dropSeat
  void dropSeat(double id) {
    const PeerId p = PeerId::Num(id);
    expected.push(peerEffect("close-fastlane", id));
    flow->markDisconnected(p);
    const ttp::Player* rec = flow->get(p);
    if (!rec) return;
    Value seat = Value::Obj();
    seat.set("peerIndex", Value::Num(id));
    for (const auto& kv : rec->fields) {
      if (kv.first == "name" || kv.first == "colorIndex") seat.set(kv.first, kv.second);
    }
    Value e = bareEffect("show-reconnect");
    e.set("seat", std::move(seat));
    expected.push(std::move(e));
  }

  // Net.js _expireSeat
  void expireSeat(double id) {
    const PeerId p = PeerId::Num(id);
    expected.push(peerEffect("clear-reconnect", id));
    if (!flow->has(p)) return;
    expected.push(peerEffect("close-fastlane", id));
    flow->removePlayer(p);
  }

  // Net.js _claimReconnect
  void claim(double from, const Value& hello, double now) {
    const Value* token = hello.find("rejoinToken");
    double guess = 0;
    const bool hasGuess = ns::norm_index(token, &guess);
    const PeerId oldPeer = PeerId::Num(guess);
    const ns::ClaimPlan plan = ns::claim_plan(from, token, hasGuess && flow->has(oldPeer),
                                              hasGuess && flow->isDisconnected(oldPeer));
    if (!plan.claim) return;
    const double oldId = plan.oldId;
    expected.push(peerEffect("close-fastlane", oldId));
    expected.push(peerEffect("close-fastlane", from));
    flow->rekey(PeerId::Num(oldId), PeerId::Num(from));
    if (plan.restamp) flow->onSeen(PeerId::Num(from), now);
    Value e = bareEffect("rekey-player");
    e.set("oldId", Value::Num(oldId));
    e.set("newId", Value::Num(from));
    expected.push(std::move(e));
    expected.push(peerEffect("clear-reconnect", oldId));
    expected.push(peerEffect("clear-reconnect", from));
  }

  // Net.js _onMessage's HELLO arm, sessionHandle standing in for the inRace
  // callback exactly as the walk reads it.
  void hello(double from, const Value& msg, int sessionHandle, double now) {
    seen(from, now);
    claim(from, msg, now);
    const PeerId p = PeerId::Num(from);
    const std::string pj = canonical_stringify(Value::Num(from));
    const bool seated = flow->has(p);
    if (!seated) addPeer(from, now);
    const ttp::Player* rec = flow->get(p);
    const Value* nameV = msg.find("name");
    if (rec && json::truthy(nameV)) {
      const std::string name = ttp_net_clean_name(canonical_stringify(*nameV).c_str());
      const Value* cur = nullptr;
      for (const auto& kv : rec->fields) if (kv.first == "name") cur = &kv.second;
      const bool renamed = seated && !(cur && cur->type == Value::STR && cur->str == name);
      flow->setField(p, "name", Value::Str(name));
      if (renamed) {
        Value e = bareEffect("player-renamed");
        e.set("peerIndex", Value::Num(from));
        e.set("name", Value::Str(name));
        expected.push(std::move(e));
      }
    }
    if (ttp_has_car(sessionHandle, pj.c_str()))
      expected.push(peerEffect("welcome-item", from));
    expected.push(bareEffect("announce"));
  }
};

// Drain both rooms and demand the same event stream; then the same roster and
// state. Byte equality on all three, which is the whole gate.
void sameRooms(int walkRoom, ShellTwin& twin, const char* where) {
  const std::string walkEvents = ttp_room_events_json(walkRoom);
  const std::string twinEvents = ttp_room_events_json(twin.room);
  check(walkEvents == twinEvents, std::string("netwalk ") + where + ": event streams equal");
  const std::string walkRoster = ttp_room_list_json(walkRoom);
  const std::string twinRoster = ttp_room_list_json(twin.room);
  check(walkRoster == twinRoster, std::string("netwalk ") + where + ": rosters byte-identical");
  check(std::string(ttp_room_state(walkRoom)) == ttp_room_state(twin.room),
        std::string("netwalk ") + where + ": room state equal");
}

void sameEffects(const Value& walk, const ShellTwin& twin, const char* where) {
  const std::string got = canonical_stringify(*walk.find("effects"));
  const std::string want = canonical_stringify(twin.expected);
  check(got == want, std::string("netwalk ") + where + ": effects\n  want " + want +
                         "\n  got  " + got);
}

void literalEffects(const Value& walk, const Value& want, const char* where) {
  const std::string got = canonical_stringify(*walk.find("effects"));
  const std::string wantS = canonical_stringify(want);
  check(got == wantS, std::string("netwalk ") + where + ": effects\n  want " + wantS +
                          "\n  got  " + got);
}

void netWalksMatchMultiCallPath() {
  // The same chooser both the pick walk and the twin's expectations read.
  ttp_net_configure(
      "{\"cars\":[{\"id\":\"dash\"}],\"colors\":[\"#f00\",\"#0f0\"],"
      "\"tracks\":[{\"id\":\"tidepool\",\"name\":\"Tidepool\",\"cup\":\"beach\"},"
      "{\"id\":\"lagoon\",\"name\":\"Lagoon\",\"cup\":\"beach\"},"
      "{\"id\":\"summit\",\"name\":\"Summit\",\"cup\":\"alpine\"}]}");

  const int walkRoom = ttp_room_create("{\"liveness\":{\"timeoutMs\":3000,\"graceMs\":1500}}");
  ShellTwin twin;
  twin.room = ttp_room_create("{\"liveness\":{\"timeoutMs\":3000,\"graceMs\":1500}}");
  twin.flow = ttp_room_flow(twin.room);
  if (walkRoom <= 0 || twin.room <= 0 || !twin.flow) { fail("netwalk: no room handles"); return; }

  const auto walkPeerMsg = [&](double from, const char* msgJson, int sess, double now) {
    const std::string fromJson = canonical_stringify(Value::Num(from));
    return walkOf(ttp_net_on_peer_message_json(walkRoom, sess, fromJson.c_str(), msgJson,
                                               0, now),
                  "on_peer_message");
  };

  // --- open: a cold boot CREATES; a restored identity JOINS -----------------
  {
    Value w = walkOf(ttp_net_on_open_json(walkRoom), "on_open cold");
    Value want = Value::Arr();
    Value cr = bareEffect("create-room");
    cr.set("maxClients", Value::Num(5));
    want.push(std::move(cr));
    Value wd = bareEffect("arm-create-watchdog");
    wd.set("delayMs", Value::Num(8000));
    want.push(std::move(wd));
    literalEffects(w, want, "open/cold-create");

    ttp_net_restore_room(walkRoom, "OLDR", "m-9");
    Value w2 = walkOf(ttp_net_on_open_json(walkRoom), "on_open restored");
    Value want2 = Value::Arr();
    Value jr = bareEffect("join-room");
    jr.set("room", Value::Str("OLDR"));
    want2.push(std::move(jr));
    Value wd2 = bareEffect("arm-create-watchdog");
    wd2.set("delayMs", Value::Num(8000));
    want2.push(std::move(wd2));
    literalEffects(w2, want2, "open/restored-join");

    // Nothing answered yet, so the watchdog writes the attempt off...
    Value t1 = walkOf(ttp_net_create_timeout_json(walkRoom), "create_timeout");
    Value wantT = Value::Arr();
    wantT.push(bareEffect("fail-attempt"));
    literalEffects(t1, wantT, "watchdog/before-answer");
    ttp_net_restore_room(walkRoom, "", "");  // back to the cold-boot state
  }

  // --- created: adopt + persist + liveness + room-ready ---------------------
  {
    Value w = walkOf(ttp_net_on_protocol_json(walkRoom, "created",
                                              "{\"room\":\"ABCD\",\"instance\":\"m-1\"}", 1000),
                     "created");
    Value want = Value::Arr();
    want.push(bareEffect("clear-create-timer"));
    Value pin = bareEffect("pin-instance");
    pin.set("room", Value::Str("ABCD"));
    pin.set("instance", Value::Str("m-1"));
    want.push(std::move(pin));
    Value sv = bareEffect("save-room");
    sv.set("room", Value::Str("ABCD"));
    sv.set("instance", Value::Str("m-1"));
    want.push(std::move(sv));
    want.push(bareEffect("start-liveness"));
    Value rr = bareEffect("room-ready");
    rr.set("room", Value::Str("ABCD"));
    rr.set("instance", Value::Str("m-1"));
    want.push(std::move(rr));
    literalEffects(w, want, "created");

    // ...and once in the room, the watchdog is a no-op.
    Value t2 = walkOf(ttp_net_create_timeout_json(walkRoom), "create_timeout in-room");
    literalEffects(t2, Value::Arr(), "watchdog/after-answer");
    ttp_room_events_json(walkRoom);  // nothing queued, but keep the streams aligned
  }

  // --- two seats join, say hello, pick and ready ----------------------------
  ttp_net_on_protocol_json(walkRoom, "peer_joined", "{\"index\":1}", 2000);
  twin.reset();
  twin.addPeer(1, 2000);
  sameRooms(walkRoom, twin, "peer_joined 1");

  ttp_net_on_protocol_json(walkRoom, "peer_joined", "{\"index\":2}", 2100);
  twin.reset();
  twin.addPeer(2, 2100);
  sameRooms(walkRoom, twin, "peer_joined 2");

  {
    // First hello onto a placeholder seat. On a live wire the HELLO usually
    // lands BEFORE peer_joined (the relay answers `joined` first and the phone
    // HELLOs inside that handler), which is what keeps joins quiet; this
    // artificial order exercises the other branch — a named hello over a
    // "Player N" placeholder — and only demands the two paths AGREE on it.
    const char* helloMsg = "{\"type\":\"hello\",\"name\":\"Ada\",\"rejoinToken\":null}";
    Value w = walkPeerMsg(1, helloMsg, 0, 2200);
    twin.reset();
    twin.hello(1, parseOrNull(helloMsg, "hello msg"), 0, 2200);
    sameEffects(w, twin, "hello/first");
    sameRooms(walkRoom, twin, "hello/first");

    // Re-hello with a NEW name: exactly one player-renamed, before the announce.
    const char* rename = "{\"type\":\"hello\",\"name\":\"Zephyr\",\"rejoinToken\":null}";
    Value w2 = walkPeerMsg(1, rename, 0, 2300);
    twin.reset();
    twin.hello(1, parseOrNull(rename, "rename msg"), 0, 2300);
    sameEffects(w2, twin, "hello/rename");
    sameRooms(walkRoom, twin, "hello/rename");
    bool sawRename = false;
    for (const Value& e : w2.find("effects")->arr)
      sawRename = sawRename || json::str_field(e, "op") == "player-renamed";
    check(sawRename, "netwalk hello/rename: the rename signal was raised");
  }

  {
    // SET_CAR: an accepted pick stores + announces; a ready seat's is refused.
    const char* pick = "{\"type\":\"set_car\",\"carIndex\":1}";
    Value w = walkPeerMsg(2, pick, 0, 2400);
    twin.reset();
    twin.seen(2, 2400);
    {
      const ttp::Player* rec = twin.flow->get(PeerId::Num(2));
      bool ready = false;
      if (rec) for (const auto& kv : rec->fields) if (kv.first == "ready") ready = json::truthy(&kv.second);
      const Value idx = Value::Num(1);
      if (ns::set_car_decision(ready, ns::RoomState::LOBBY, false, &idx,
                               static_cast<double>(protocol::CAR_MODELS.size()))) {
        twin.flow->setField(PeerId::Num(2), "carIndex", Value::Num(1));
        twin.expected.push(bareEffect("announce"));
      }
    }
    sameEffects(w, twin, "set_car/accept");
    sameRooms(walkRoom, twin, "set_car/accept");

    Value r = walkPeerMsg(2, "{\"type\":\"set_ready\",\"ready\":true}", 0, 2500);
    twin.reset();
    twin.seen(2, 2500);
    ttp_room_set_field(twin.room, "2", "ready", "true");
    twin.expected.push(bareEffect("announce"));
    sameEffects(r, twin, "set_ready/accept");
    sameRooms(walkRoom, twin, "set_ready/accept");

    // Now the ready seat's car pick is locked...
    Value locked = walkPeerMsg(2, pick, 0, 2600);
    twin.reset();
    twin.seen(2, 2600);
    sameEffects(locked, twin, "set_car/ready-locked");
    sameRooms(walkRoom, twin, "set_car/ready-locked");
    // ...and a redundant ready toggle is suppressed (no republish).
    Value again = walkPeerMsg(2, "{\"type\":\"set_ready\",\"ready\":true}", 0, 2700);
    twin.reset();
    twin.seen(2, 2700);
    sameEffects(again, twin, "set_ready/redundant");
  }

  {
    // PING: the PONG is composed in C++, `t` echoed verbatim, absent stays absent.
    Value w = walkPeerMsg(2, "{\"type\":\"ping\",\"t\":1234567890123}", 0, 2800);
    twin.reset();
    twin.seen(2, 2800);
    Value data = Value::Obj();
    data.set("type", Value::Str("pong"));
    data.set("t", Value::Num(1234567890123.0));
    Value e = bareEffect("send-to");
    e.set("to", Value::Num(2));
    e.set("data", std::move(data));
    twin.expected.push(std::move(e));
    sameEffects(w, twin, "ping/echo-t");

    Value noT = walkPeerMsg(2, "{\"type\":\"ping\"}", 0, 2850);
    bool tAbsent = true;
    for (const Value& eff : noT.find("effects")->arr)
      if (json::str_field(eff, "op") == "send-to")
        tAbsent = !eff.find("data")->find("t");
    check(tAbsent, "netwalk ping/no-t: an absent t stays absent in the PONG");
    ttp_room_events_json(twin.room);  // drain the twin's stamp-only noise
    ttp_room_events_json(walkRoom);
  }

  // --- the mode pick (no old multi-call path; literal expectations). The pick
  // is STORED behind the handle now, so the cases stage it with the seam,
  // read it back with ttp_net_pick_json, and — where a walk stored it — lean
  // on the storage itself carrying state from one case to the next. ---------
  {
    const auto setPick = [&](const char* json) {
      ttp_room_store_pick(walkRoom, parseOrNull(json, "staged pick"));
    };
    const auto pickIs = [&](const char* want, const char* where) {
      check(std::string(ttp_net_pick_json(walkRoom)) == want,
            std::string("netwalk stored pick (") + where + ")");
    };
    // publish + track-change, the whole tail now that no set-pick effect
    // hands the pick back to a shell.
    const auto wantTail = [&](const char* trackId) {
      Value want = Value::Arr();
      want.push(bareEffect("publish"));
      Value tc = bareEffect("track-change");
      tc.set("trackId", Value::Str(trackId));
      want.push(std::move(tc));
      return want;
    };

    setPick("{\"mode\":null,\"cupId\":null,\"randomRaces\":0,\"trackId\":null,\"hasBag\":true}");
    // A non-host pick is refused outright, and stores nothing.
    Value nh = walkOf(ttp_net_on_peer_message_json(
                          walkRoom, 0, "2", "{\"type\":\"select_mode\",\"mode\":\"track\","
                                            "\"trackId\":\"tidepool\"}",
                          0, 2900),
                      "select_mode non-host");
    literalEffects(nh, Value::Arr(), "pick/non-host");
    pickIs("{\"mode\":null,\"cupId\":null,\"randomRaces\":0,\"trackId\":null}", "non-host untouched");

    // The host's exact-track pick stores and answers the tail.
    Value w = walkOf(ttp_net_on_peer_message_json(
                         walkRoom, 0, "1", "{\"type\":\"select_mode\",\"mode\":\"track\","
                                           "\"trackId\":\"tidepool\"}",
                         0, 3000),
                     "select_mode track");
    literalEffects(w, wantTail("tidepool"), "pick/track");
    pickIs("{\"mode\":\"track\",\"cupId\":null,\"randomRaces\":0,\"trackId\":\"tidepool\"}",
           "track stored");

    // Same pick again: a no-op — against the pick the WALK stored, no staging.
    Value same = walkOf(ttp_net_on_peer_message_json(
                            walkRoom, 0, "1", "{\"type\":\"select_mode\",\"mode\":\"track\","
                                              "\"trackId\":\"tidepool\"}",
                            0, 3100),
                        "select_mode same");
    literalEffects(same, Value::Arr(), "pick/same-noop");

    // A cup resolves to its first race; an unknown track is refused.
    Value cup = walkOf(ttp_net_on_peer_message_json(
                           walkRoom, 0, "1", "{\"type\":\"select_mode\",\"mode\":\"cup\","
                                             "\"cupId\":\"alpine\"}",
                           0, 3200),
                       "select_mode cup");
    literalEffects(cup, wantTail("summit"), "pick/cup-first-race");
    pickIs("{\"mode\":\"cup\",\"cupId\":\"alpine\",\"randomRaces\":0,\"trackId\":\"summit\"}",
           "cup stored");

    Value bad = walkOf(ttp_net_on_peer_message_json(
                           walkRoom, 0, "1", "{\"type\":\"select_mode\",\"mode\":\"track\","
                                             "\"trackId\":\"nowhere\"}",
                           0, 3300),
                       "select_mode unknown");
    literalEffects(bad, Value::Arr(), "pick/unknown-track");

    // Random: the two-step draw. First half answers needDraw, no effects, and
    // must leave the stored pick alone...
    Value rnd = walkOf(ttp_net_on_peer_message_json(
                           walkRoom, 0, "1", "{\"type\":\"select_mode\",\"mode\":\"random\","
                                             "\"randomRaces\":4}",
                           0, 3400),
                       "select_mode random");
    check(json::truthy(rnd.find("needDraw")), "netwalk pick/random: first half asks for a draw");
    literalEffects(rnd, Value::Arr(), "pick/random-needdraw");
    pickIs("{\"mode\":\"cup\",\"cupId\":\"alpine\",\"randomRaces\":0,\"trackId\":\"summit\"}",
           "needDraw stores nothing");
    // ...the second half lands the drawn track.
    Value drawn = walkOf(ttp_net_select_mode_draw_json(
                             walkRoom, "1", "{\"type\":\"select_mode\",\"mode\":\"random\","
                                            "\"randomRaces\":4}",
                             "lagoon"),
                         "select_mode_draw");
    literalEffects(drawn, wantTail("lagoon"), "pick/random-drawn");
    pickIs("{\"mode\":\"random\",\"cupId\":null,\"randomRaces\":4,\"trackId\":\"lagoon\"}",
           "drawn stored");

    // Changing only the LENGTH keeps the drawn track — no fresh draw.
    Value keep = walkOf(ttp_net_on_peer_message_json(
                            walkRoom, 0, "1", "{\"type\":\"select_mode\",\"mode\":\"random\","
                                              "\"randomRaces\":0}",
                            0, 3500),
                        "select_mode keepdraw");
    check(!json::truthy(keep.find("needDraw")), "netwalk pick/keepdraw: no draw asked");
    literalEffects(keep, wantTail("lagoon"), "pick/keepdraw");
    pickIs("{\"mode\":\"random\",\"cupId\":null,\"randomRaces\":0,\"trackId\":\"lagoon\"}",
           "the length changed, the track did not");

    // An out-of-range length clamps to the manifest default (ceiling, not range:
    // the 0 above already proved endless survives). Staged back to a TRACK pick
    // so the draw branch runs rather than keepDraw.
    setPick("{\"mode\":\"track\",\"cupId\":null,\"randomRaces\":0,\"trackId\":\"tidepool\","
            "\"hasBag\":true}");
    walkOf(ttp_net_select_mode_draw_json(
               walkRoom, "1", "{\"type\":\"select_mode\",\"mode\":\"random\","
                              "\"randomRaces\":999}",
               "lagoon"),
           "select_mode clamp");
    pickIs("{\"mode\":\"random\",\"cupId\":null,\"randomRaces\":4,\"trackId\":\"lagoon\"}",
           "999 races clamps to the default");

    // A bagless shell refuses random outright.
    setPick("{\"mode\":null,\"trackId\":null,\"hasBag\":false}");
    Value bagless = walkOf(ttp_net_on_peer_message_json(
                               walkRoom, 0, "1", "{\"type\":\"select_mode\","
                                                 "\"mode\":\"random\",\"randomRaces\":4}",
                               0, 3600),
                           "select_mode bagless");
    check(!json::truthy(bagless.find("needDraw")), "netwalk pick/bagless: refused, not deferred");
    literalEffects(bagless, Value::Arr(), "pick/bagless");

    // init_pick spells the constructor rule; clear_pick keeps only hasBag.
    ttp_net_init_pick(walkRoom, "tidepool", 1);
    pickIs("{\"mode\":\"track\",\"cupId\":null,\"randomRaces\":0,\"trackId\":\"tidepool\"}",
           "init with a default track");
    ttp_net_init_pick(walkRoom, nullptr, 1);
    pickIs("{\"mode\":null,\"cupId\":null,\"randomRaces\":0,\"trackId\":null}",
           "init without one");

    // setTrack: the game-layer swap keeps mode/cup, same tail, same gates.
    setPick("{\"mode\":\"random\",\"cupId\":null,\"randomRaces\":4,\"trackId\":\"lagoon\","
            "\"hasBag\":true}");
    Value st = walkOf(ttp_net_set_track_json(walkRoom, "tidepool"), "set_track");
    literalEffects(st, wantTail("tidepool"), "set_track/accept");
    pickIs("{\"mode\":\"random\",\"cupId\":null,\"randomRaces\":4,\"trackId\":\"tidepool\"}",
           "set_track keeps mode and length");
    literalEffects(walkOf(ttp_net_set_track_json(walkRoom, "tidepool"), "set_track same"),
                   Value::Arr(), "set_track/same-id-noop");
    literalEffects(walkOf(ttp_net_set_track_json(walkRoom, "nowhere"), "set_track unknown"),
                   Value::Arr(), "set_track/unknown");

    // clear_pick: End party's reset. Random still works after — hasBag survived.
    ttp_net_clear_pick(walkRoom);
    pickIs("{\"mode\":null,\"cupId\":null,\"randomRaces\":0,\"trackId\":null}", "cleared");
    Value stillBagged = walkOf(ttp_net_on_peer_message_json(
                                   walkRoom, 0, "1", "{\"type\":\"select_mode\","
                                                     "\"mode\":\"random\",\"randomRaces\":2}",
                                   0, 3700),
                               "select_mode after clear");
    check(json::truthy(stillBagged.find("needDraw")),
          "netwalk pick/clear: hasBag survives a clear");

    ttp_room_events_json(walkRoom);
    ttp_room_events_json(twin.room);
  }

  // --- the race: statechange restamp, a drop, liveness, the claim ----------
  {
    // Both rooms flip to countdown/playing; the statechange walk restamps.
    ttp_room_transition_to(walkRoom, "countdown");
    ttp_room_transition_to(twin.room, "countdown");
    Value sc = walkOf(ttp_net_state_change_apply_json(walkRoom, "countdown", 4000), "sc countdown");
    twin.reset();
    {
      // Net.js's statechange handler: restampConnected + clearStandings + publish.
      const ns::StateChangePlan plan = ns::state_change_plan(ns::RoomState::COUNTDOWN);
      if (plan.restampConnected) {
        for (const Value& p : twin.flow->listValue().arr)
          if (json::truthy(p.find("connected")))
            twin.flow->onSeen(json::id_of<PeerId>(p.find("peerIndex")), 4000);
      }
      if (plan.clearStandings) twin.expected.push(bareEffect("clear-standings"));
      if (plan.publish) twin.expected.push(bareEffect("publish"));
    }
    sameEffects(sc, twin, "statechange/countdown");
    sameRooms(walkRoom, twin, "statechange/countdown");
    ttp_room_transition_to(walkRoom, "playing");
    ttp_room_transition_to(twin.room, "playing");
    ttp_room_events_json(walkRoom);
    ttp_room_events_json(twin.room);

    // A live race: seat 1 holds a car, seat 2 does not (a late joiner).
    const int sess = ttp_session_begin("tidepool", 7u, 3, nullptr);
    ttp_add_human(sess, "1", nullptr);

    // peer_left mid-race: a soft drop, seat and car kept, QR offered.
    Value pl = walkOf(ttp_net_on_protocol_json(walkRoom, "peer_left", "{\"index\":1}", 5000),
                      "peer_left");
    twin.reset();
    twin.expected.push(peerEffect("close-fastlane", 1));
    twin.dropSeat(1);
    sameEffects(pl, twin, "peer_left/mid-race");
    sameRooms(walkRoom, twin, "peer_left/mid-race");

    // The liveness tick: heartbeat SEND first (in-room, nothing in flight),
    // then the sweep — nothing expired yet at 5100.
    Value lt = walkOf(ttp_net_liveness_json(walkRoom, sess, 5100), "liveness");
    {
      bool sentHb = false;
      for (const Value& e : lt.find("effects")->arr)
        if (json::str_field(e, "op") == "send-to")
          sentHb = json::num_field(e, "to") == 0 &&
                   json::str_field(*e.find("data"), "type") == "_heartbeat";
      check(sentHb, "netwalk liveness: the canary heartbeat is composed off the manifest");
    }
    // The twin's sweep half, over the same clock (its heartbeat state was JS
    // shell state; the sweep is what touches the room).
    twin.reset();
    {
      for (const PeerId& id : twin.flow->expiredPeers(5100)) twin.dropSeat(id.num);
      ttp_room_sync_active_order(twin.room, sess);
      if (twin.flow->graceTick(5100)) twin.expected.push(bareEffect("race-abandoned"));
    }
    sameRooms(walkRoom, twin, "liveness/no-expiry");

    // The echo comes home and clears the in-flight flag: the NEXT tick sends
    // again instead of reconnecting.
    walkPeerMsg(0, "{\"type\":\"_heartbeat\"}", sess, 5200);
    Value lt2 = walkOf(ttp_net_liveness_json(walkRoom, sess, 5300), "liveness 2");
    {
      bool sentAgain = false, reconnected = false;
      for (const Value& e : lt2.find("effects")->arr) {
        const std::string op = json::str_field(e, "op");
        sentAgain = sentAgain || op == "send-to";
        reconnected = reconnected || op == "reconnect";
      }
      check(sentAgain && !reconnected, "netwalk liveness: the echo closed the loop");
    }
    twin.reset();
    // (the echo routes 'self-heartbeat' in the twin too — no stamp, no effect)
    {
      for (const PeerId& id : twin.flow->expiredPeers(5300)) twin.dropSeat(id.num);
      ttp_room_sync_active_order(twin.room, sess);
      if (twin.flow->graceTick(5300)) twin.expected.push(bareEffect("race-abandoned"));
    }
    sameRooms(walkRoom, twin, "liveness/echoed");

    // Seat 2 goes silent past the timeout: the sweep drops it in both worlds.
    Value lt3 = walkOf(ttp_net_liveness_json(walkRoom, sess, 9000), "liveness expiry");
    twin.reset();
    {
      for (const PeerId& id : twin.flow->expiredPeers(9000)) twin.dropSeat(id.num);
      ttp_room_sync_active_order(twin.room, sess);
      if (twin.flow->graceTick(9000)) twin.expected.push(bareEffect("race-abandoned"));
    }
    // The heartbeat half differs (the twin holds no canary state), so compare
    // only the sweep's effects: strip send-to/reconnect from the walk's answer.
    {
      Value sweep = Value::Arr();
      for (const Value& e : lt3.find("effects")->arr) {
        const std::string op = json::str_field(e, "op");
        if (op != "send-to" && op != "reconnect") sweep.push(e);
      }
      const std::string got = canonical_stringify(sweep);
      const std::string want = canonical_stringify(twin.expected);
      check(got == want, "netwalk liveness/expiry: sweep effects\n  want " + want +
                             "\n  got  " + got);
    }
    sameRooms(walkRoom, twin, "liveness/expiry");

    // _seen lifts the dropped seat back: the single writer, in both worlds.
    Value seen = walkOf(ttp_net_on_seen_json(walkRoom, "2", 9100), "on_seen");
    twin.reset();
    twin.seen(2, 9100);
    sameEffects(seen, twin, "seen/lift");
    sameRooms(walkRoom, twin, "seen/lift");

    // The cross-device claim: seat 1 (dropped, car-holding) reclaimed from a
    // fresh connection as peer 7. welcome-item fires — the live race holds the
    // rekeyed car — and the twin's inRace callback agrees through ttp_has_car.
    const char* claimHello = "{\"type\":\"hello\",\"name\":\"Zephyr\",\"rejoinToken\":\"1\"}";
    Value cw = walkPeerMsg(7, claimHello, sess, 9200);
    // The walk rekeys the ROOM seat; the car moves under the shell's
    // rekey-player effect, so move it here before comparing welcome-item.
    ttp_rekey_car(sess, "1", "7");
    twin.reset();
    twin.hello(7, parseOrNull(claimHello, "claim hello"), sess, 9200);
    sameEffects(cw, twin, "claim/rekey");
    sameRooms(walkRoom, twin, "claim/rekey");

    // Back to the lobby: disconnected seats are freed, standings cleared.
    ttp_room_transition_to(walkRoom, "lobby");
    ttp_room_transition_to(twin.room, "lobby");
    ttp_room_events_json(walkRoom);
    ttp_room_events_json(twin.room);
    walkOf(ttp_net_on_seen_json(walkRoom, "2", 9300), "reseen");  // seat 2 is back
    twin.seen(2, 9300);
    ttp_room_events_json(walkRoom);
    ttp_room_events_json(twin.room);
    Value lob = walkOf(ttp_net_state_change_apply_json(walkRoom, "lobby", 9400), "sc lobby");
    twin.reset();
    {
      const ns::StateChangePlan plan = ns::state_change_plan(ns::RoomState::LOBBY);
      if (plan.freeDisconnected) {
        std::vector<double> disc;
        for (const Value& p : twin.flow->listValue().arr) {
          const PeerId id = json::id_of<PeerId>(p.find("peerIndex"));
          if (twin.flow->isDisconnected(id)) disc.push_back(id.num);
        }
        for (double id : disc) twin.expireSeat(id);
      }
      if (plan.clearStandings) twin.expected.push(bareEffect("clear-standings"));
      if (plan.publish) twin.expected.push(bareEffect("publish"));
    }
    sameEffects(lob, twin, "statechange/lobby");
    sameRooms(walkRoom, twin, "statechange/lobby");
    ttp_dispose(sess);
  }

  // --- host promotion clears the inherited ready flag -----------------------
  {
    ttp_room_set_field(walkRoom, "2", "ready", "true");
    ttp_room_set_field(twin.room, "2", "ready", "true");
    ttp_room_events_json(walkRoom);
    ttp_room_events_json(twin.room);
    Value hc = walkOf(ttp_net_host_change_apply_json(walkRoom, "2"), "host_change");
    twin.reset();
    {
      const ns::HostChangePlan plan = ns::host_change_plan();
      if (plan.clearReady) twin.flow->setField(PeerId::Num(2), "ready", Value::Bool(false));
      if (plan.publish) twin.expected.push(bareEffect("announce"));
    }
    sameEffects(hc, twin, "hostchange");
    sameRooms(walkRoom, twin, "hostchange");
  }

  // --- joined: the post-reload reconciliation -------------------------------
  {
    // The relay knows peers 2 and 5; seat 7 is stale. resync_plan decides, the
    // walk performs; the twin performs the same plan through the exports.
    Value w = walkOf(ttp_net_on_protocol_json(walkRoom, "joined",
                                              "{\"room\":\"ABCD\",\"peers\":[0,2,5]}", 10000),
                     "joined");
    twin.reset();
    twin.expected.push(bareEffect("clear-create-timer"));
    {
      std::vector<double> ids;
      for (const Value& p : twin.flow->listValue().arr)
        ids.push_back(json::num_field(p, "peerIndex"));
      const ns::ResyncPlan plan = ns::resync_plan(ids, {0, 2, 5});
      for (double id : plan.expire) twin.expireSeat(id);
      for (double id : plan.add) twin.addPeer(id, 10000);
      if (plan.publish) twin.expected.push(bareEffect("publish"));
    }
    twin.expected.push(bareEffect("reset-reconnect-count"));
    {
      Value sv = bareEffect("save-room");
      sv.set("room", Value::Str("ABCD"));
      sv.set("instance", Value::Str("m-1"));  // kept from `created` — joined never clears it
      twin.expected.push(std::move(sv));
      twin.expected.push(bareEffect("start-liveness"));
      Value rr = bareEffect("room-ready");
      rr.set("room", Value::Str("ABCD"));
      rr.set("instance", Value::Str("m-1"));
      twin.expected.push(std::move(rr));
    }
    sameEffects(w, twin, "joined/resync");
    sameRooms(walkRoom, twin, "joined/resync");
  }

  // --- close with the room gone: forget, expire EVERY seat, then re-dial ----
  {
    Value w = walkOf(ttp_net_on_close_json(walkRoom, 1), "close roomClosed");
    twin.reset();
    twin.expected.push(bareEffect("clear-create-timer"));
    twin.expected.push(bareEffect("forget-room"));
    {
      Value roster = parseOrNull(ttp_room_list_json(twin.room), "twin close roster");
      std::vector<double> ids;
      for (const Value& p : roster.arr) ids.push_back(p.find("peerIndex")->num);
      for (double id : ids) twin.expireSeat(id);
    }
    twin.expected.push(bareEffect("connect-fresh"));
    sameEffects(w, twin, "close/room-closed");
    sameRooms(walkRoom, twin, "close/room-closed");
    check(std::strcmp(ttp_room_list_json(walkRoom), "[]") == 0,
          "netwalk close: no seat survives into the fresh room");

    // ...and the next error with no room code counts a failed attempt.
    Value err = walkOf(ttp_net_on_protocol_json(walkRoom, "error",
                                                "{\"message\":\"Server draining\"}", 11000),
                       "error no-room");
    Value wantErr = Value::Arr();
    wantErr.push(bareEffect("fail-attempt"));
    literalEffects(err, wantErr, "error/create-rejected");
  }

  ttp_room_dispose(twin.room);
  ttp_room_dispose(walkRoom);
  ttp_net_configure("");  // leave no configured chooser behind

  // ---- the vocabulary, against what the scenarios above actually emitted ----
  // A shell asserts its performer switch covers ttp_net_effect_ops_json at
  // boot, so an op a walk can raise but the table omits is a step silently
  // dropped mid-party. The table is the shipped claim; this is the evidence
  // for it that no reading of the code gives you.
  {
    const Value ops = parseOrNull(ttp_net_effect_ops_json(), "net effect ops");
    check(ops.type == Value::ARR && !ops.arr.empty(),
          "ttp_net_effect_ops_json is a non-empty array");
    for (const std::string& op : g_netOpsSeen) {
      bool listed = false;
      for (const Value& v : ops.arr) listed = listed || (v.type == Value::STR && v.str == op);
      check(listed, "netwalk op '" + op + "' is in ttp_net_effect_ops_json");
    }
    std::printf("  net choreography walks against the composed rules: %d ops raised, %d declared\n",
                (int)g_netOpsSeen.size(), (int)ops.arr.size());
  }
}

// ---------------------------------------------------------------------------
// The RACE-ORCHESTRATION walks (ttp_race.h) against the decision functions they
// sequence.
//
// Every entry point here takes LIVE HANDLES and answers an ordered effect list,
// so there is no JSON-taking spelling left for raceflow-corpus to be replayed
// down and none should be invented — raceflow_check replays it against
// race_flow.{h,cc} on every leg, which is where the rules are. What only this
// boundary can say is that a walk GATHERED the right inputs off the handles and
// SEQUENCED the rules in the right order.
//
// THE ORDER IS THE ASSERTION. race_flow.h's header names four constraints that
// live in the effect ORDER alone and are silent when wrong, so the primary
// comparison below is the op sequence of a walk's answer against
// race::key(...) over the Effects the same rule produces for the same state.
// That needs no second copy of the payload writer, which is the thing this file
// may not grow (it would freeze bytes here and go stale on the first shape
// change).
//
// Payloads are covered two other ways: by BYTE equality between two answers
// that must agree by construction (a start's launch effects are the launch
// walk's effects), and by naming the specific fields a marshaller can drop — a
// bot id emitted as a number, a null forceItem coerced to "", the opaque
// car-stats row lost, `deferred` flattened.
// ---------------------------------------------------------------------------

// The op sequence of a walk's answer, and of a rule's Effects. Comparing these
// two strings is the ordering contract, stated once.
std::string opsOf(const Value& answer) {
  std::string s;
  for (const Value& e : at(answer, "effects").arr)
    s += (s.empty() ? "" : ",") + json::str_field(e, "op");
  return s;
}
std::string opsOf(const race::Effects& es) {
  std::string s;
  for (const race::Effect& e : es) s += (s.empty() ? "" : ",") + std::string(race::key(e.op));
  return s;
}
void sameOps(const Value& answer, const race::Effects& want, const std::string& where) {
  const std::string got = opsOf(answer), exp = opsOf(want);
  check(got == exp, where + "\n  want " + exp + "\n  got  " + got);
}

// One drained session event, as the finish rule reads it — the same parse the
// shim does, needed here because the expected side routes the SAME events.
race::RaceEvent raceEventOf(const Value& e) {
  race::RaceEvent ev;
  ev.present = true;
  ev.type = json::str_field(e, "type");
  ev.id = json::id_of<race::Id>(e.find("id"));
  ev.item = json::str_field(e, "item");
  ev.cause = json::str_field(e, "cause");
  ev.finished = json::truthy(e.find("finished"));
  ev.s = json::num_field(e, "s");
  ev.lat = json::num_field(e, "lat");
  return ev;
}

void raceLiveWalks() {
  // ---- the world, configured FROM the structs the rules will be run over, so
  // the two cannot drift into different worlds and quietly agree about nothing.
  const Value personas = parseOrNull(ttp_race_personas_json(), "personas");
  Value carStats = Value::Arr();
  for (int i = 0; i < 12; i++) {
    Value row = Value::Obj();                 // opaque: the layer copies, never reads
    row.set("accel", Value::Num(1.0 + i * 0.01));
    carStats.push(std::move(row));
  }
  Value cupsJson = Value::Arr();
  {
    Value cup = Value::Obj();
    cup.set("id", Value::Str("beach"));
    cup.set("name", Value::Str("Beach"));
    Value tracks = Value::Arr();
    tracks.push(Value::Str("tidepool"));
    tracks.push(Value::Str("helix"));
    cup.set("tracks", std::move(tracks));
    cupsJson.push(std::move(cup));
  }
  Value world = Value::Obj();
  world.set("fieldSize", Value::Num(4));
  world.set("carCount", Value::Num(12));
  world.set("colorCount", Value::Num(12));
  world.set("aiPrefix", Value::Str("ai-"));
  world.set("personas", personas);
  world.set("carStats", carStats);
  world.set("cups", cupsJson);
  check(ttp_race_configure(canonical_stringify(world).c_str()) == 1,
        "race walks: the world configured");
  check(ttp_race_configure("not json") == 0, "a malformed world is refused");

  race::FieldWorld W;
  W.fieldSize = 4;
  W.carCount = 12;
  W.colorCount = 12;
  W.aiPrefix = "ai-";
  for (const Value& p : personas.arr)
    W.personas.push_back({json::str_field(p, "name"), json::num_field(p, "caution"),
                          json::num_field(p, "laneBias")});
  for (const Value& r : carStats.arr) W.carStats.push_back(r);
  const std::vector<race::Cup> CUPS = {{"beach", "Beach", {"tidepool", "helix"}}};

  // ---- the vocabulary, first: a shell proves its performer switch against it
  // AT BOOT, so it has to be the enum itself and not a hand-kept mirror.
  {
    const Value ops = parseOrNull(ttp_race_effect_ops_json(), "race effect ops");
    check((int)ops.arr.size() == race::OP_COUNT,
          "ttp_race_effect_ops_json declares every op (" + std::to_string(ops.arr.size()) +
              " vs " + std::to_string(race::OP_COUNT) + ")");
    bool inOrder = ops.arr.size() == (size_t)race::OP_COUNT;
    for (int i = 0; inOrder && i < race::OP_COUNT; i++)
      inOrder = ops.arr[i].type == Value::STR &&
                ops.arr[i].str == race::key(static_cast<race::Op>(i));
    check(inOrder, "…in the enum's own order, key for key");
  }

  // ---- the room the walks read: two connected seats and one dropped, so
  // connectedPlayers has something to leave out.
  ttp_net_configure(
      "{\"cars\":[{\"id\":\"dash\"}],\"colors\":[\"#f00\",\"#0f0\"],"
      "\"tracks\":[{\"id\":\"tidepool\",\"name\":\"Tidepool\",\"cup\":\"beach\"},"
      "{\"id\":\"helix\",\"name\":\"Helix\",\"cup\":\"beach\"}]}");
  const int room = ttp_room_create("{}");
  RoomFlow* flow = ttp_room_flow(room);
  if (room <= 0 || !flow) { fail("race walks: ttp_room_create returned no handle"); return; }
  ttp_room_add_player(room, "1", "{\"name\":\"Ada\",\"colorIndex\":0,\"carIndex\":2,\"ready\":true}");
  ttp_room_add_player(room, "2", "{\"name\":\"Bo\",\"colorIndex\":1,\"carIndex\":null,\"ready\":true}");
  ttp_room_add_player(room, "3", "{\"name\":\"Cy\",\"colorIndex\":3,\"ready\":true}");
  flow->markDisconnected(PeerId::Num(3));
  ttp_net_init_pick(room, "tidepool", 1);
  ttp_room_events_json(room);

  // The gathers, spelled as the walk spells them: the roster through the room
  // ABI, the pick through its own reader, the rule for who a race seats.
  const auto humansOf = [&](bool connectedOnly) {
    std::vector<race::Human> out;
    const std::vector<ui::RosterEntry> roster =
        rosterEntriesOf(parseOrNull(ttp_room_list_json(room), "roster"));
    const auto push = [&out](const ui::RosterEntry& e) {
      race::Human h;
      h.peerIndex = e.peerIndex;
      h.name = e.name;
      h.colorIndex = static_cast<int>(e.colorIndex);
      h.carIndex = e.carIndex;
      out.push_back(std::move(h));
    };
    if (connectedOnly) {
      for (const ui::RosterEntry* e : ui::connectedPlayers(roster)) push(*e);
    } else {
      for (const ui::RosterEntry& e : roster) push(e);
    }
    return out;
  };
  const auto startInputOf = [&](int sceneReady, std::vector<std::string> draws) {
    race::StartInput si;
    si.roomState = ui::roomStateOf(ttp_room_state(room));
    si.sceneReady = sceneReady != 0;
    const Value pick = parseOrNull(ttp_net_pick_json(room), "pick");
    si.selectedTrackId = json::opt_str<race::OptStr>(pick.find("trackId"));
    si.mode = json::str_field(pick, "mode");
    si.cupId = json::opt_str<race::OptStr>(pick.find("cupId"));
    si.trackId = json::str_field(pick, "trackId");
    si.randomRaces = json::num_field(pick, "randomRaces");
    si.cups = CUPS;
    si.players = humansOf(true);
    si.draws = std::move(draws);
    return si;
  };
  const auto launchRule = [&](double seed, double countdownSeconds, const char* forceItem) {
    race::LaunchInput li;
    li.players = humansOf(true);
    li.seed = seed;
    li.trackId = json::str_field(parseOrNull(ttp_net_pick_json(room), "pick"), "trackId");
    li.countdownSeconds = countdownSeconds;
    if (forceItem && *forceItem) li.forceItem = race::OptStr::Of(forceItem);
    li.world = W;
    return race::launchRace(li);
  };

  // ---- start_live: the four refusals -----------------------------------------
  const auto refusal = [&](int sceneReady, const char* where) {
    const Value got = parseOrNull(
        ttp_race_start_live_json(room, sceneReady, nullptr, 1, 3, nullptr, nullptr), where);
    const race::StartResult want = race::startRace(startInputOf(sceneReady, {}));
    check(json::str_field(got, "action") == "none" &&
              want.action == race::StartAction::NONE,
          std::string("start_live refuses (") + where + ")");
    check(json::str_field(got, "reason") == race::key(want.reason),
          std::string("start_live's reason is the rule's (") + where + "): " +
              json::str_field(got, "reason"));
    // KEY PRESENCE is the contract: a refusal carries `reason` and nothing else.
    check(!got.has("series") && !got.has("effects") && !got.has("drawsNeeded"),
          std::string("…and carries no plan, effects or draws ask (") + where + ")");
  };
  refusal(0, "scene");
  ttp_room_transition_to(room, "countdown");
  ttp_room_events_json(room);
  refusal(1, "room-state");
  ttp_room_transition_to(room, "lobby");
  ttp_room_events_json(room);
  ttp_net_clear_pick(room);
  refusal(1, "no-track");
  ttp_net_init_pick(room, "tidepool", 1);
  flow->markDisconnected(PeerId::Num(1));
  flow->markDisconnected(PeerId::Num(2));
  refusal(1, "no-players");
  flow->markReconnected(PeerId::Num(1));
  flow->markReconnected(PeerId::Num(2));
  ttp_room_events_json(room);

  // ---- start_live: a TRACK pick completes on the FIRST call -------------------
  {
    const race::StartResult want = race::startRace(startInputOf(1, {}));
    const Value got = parseOrNull(
        ttp_race_start_live_json(room, 1, nullptr, 42, 3, nullptr, nullptr), "start track");
    check(json::str_field(got, "action") == "launch", "start_live launches a track pick at once");
    check(!got.has("drawsNeeded"), "…asking for no draws");
    check(json::num_field(got, "drawsUsed") == want.drawsUsed, "…and spending none");
    check(at(got, "series").type == Value::NUL && !want.series.has,
          "a single race commits to no series");
    sameOps(got, launchRule(42, 3, nullptr).effects, "start_live effects == race::launchRace");

    // The launch walk is the SAME composition over the same handles, so the two
    // answers must agree BYTE for byte — the one payload comparison available
    // without spelling a second writer, and it covers every field of every op.
    const std::string launched = ttp_race_launch_live_json(room, 42, 3, nullptr, nullptr);
    check(canonical_stringify(at(got, "effects")) ==
              canonical_stringify(at(parseOrNull(launched.c_str(), "launch"), "effects")),
          "start_live's effects ARE ttp_race_launch_live_json's, byte for byte");

    // The payload fields a marshaller can quietly drop.
    const Value effects = at(got, "effects");
    const Value* setField = nullptr;
    const Value* createSession = nullptr;
    for (const Value& e : effects.arr) {
      const std::string op = json::str_field(e, "op");
      if (op == "set-field") setField = &e;
      if (op == "create-session") createSession = &e;
    }
    check(setField && createSession, "the launch carries set-field and create-session");
    if (setField && createSession) {
      const Value bots = at(*setField, "bots");
      bool botIdsAreStrings = !bots.arr.empty();
      for (const Value& b : bots.arr)
        botIdsAreStrings = botIdsAreStrings && at(b, "peerIndex").type == Value::STR;
      check(botIdsAreStrings, "a bot's id crosses as the STRING \"ai-0\", never a number");
      check(canonical_stringify(at(*setField, "aiIds")).find("\"ai-") != std::string::npos,
            "…and aiIds names them the same way");
      bool statsSurvive = true;
      for (const Value& f : at(*setField, "field").arr)
        statsSurvive = statsSurvive && at(f, "stats").type == Value::OBJ;
      check(statsSurvive, "the opaque car-stats row survives the round trip");
      check(at(*createSession, "forceItem").type == Value::NUL,
            "no ?item override crosses as null, not \"\"");
      check(json::str_field(*createSession, "trackId") == "tidepool",
            "create-session names the picked track");
    }
    // ?item and ?bots are per-launch hooks, so they must reach the rule.
    const Value forced = parseOrNull(
        ttp_race_launch_live_json(room, 42, 3, "rocket", "1"), "launch forced");
    race::LaunchInput li;
    li.players = humansOf(true);
    li.seed = 42;
    li.trackId = "tidepool";
    li.countdownSeconds = 3;
    li.forceItem = race::OptStr::Of("rocket");
    li.world = W;
    li.world.botCap = race::OptNum::Of(1);
    sameOps(forced, race::launchRace(li).effects, "launch_live with ?item and ?bots");
    for (const Value& e : at(forced, "effects").arr)
      if (json::str_field(e, "op") == "create-session")
        check(json::str_field(e, "forceItem") == "rocket", "the ?item override rides through");
  }

  // ---- start_live: the draws protocol on a random pick ------------------------
  {
    // The host's random pick, through the walk that owns it.
    walkOf(ttp_net_select_mode_draw_json(
               room, "1", "{\"type\":\"select_mode\",\"mode\":\"random\",\"randomRaces\":2}",
               "helix"),
           "select random");
    ttp_room_events_json(room);
    const race::StartInput ask = startInputOf(1, {});
    const int need = race::drawsNeeded(ask.mode, ask.randomRaces);
    check(need > 0, "premise: a random pick needs draws");

    const Value phase1 = parseOrNull(
        ttp_race_start_live_json(room, 1, nullptr, 7, 3, nullptr, nullptr), "start draws ask");
    check(json::str_field(phase1, "action") == "draws", "phase 1 asks for draws");
    check(json::num_field(phase1, "drawsNeeded") == need,
          "…exactly race::drawsNeeded many");
    check(!phase1.has("effects"), "…and decides nothing yet — a draw cannot be put back");

    // The shell draws n and calls again. The walk re-checks its own gate.
    std::vector<std::string> draws;
    for (int i = 0; i < need; i++) draws.push_back(i % 2 ? "helix" : "tidepool");
    Value drawsJson = Value::Arr();
    for (const std::string& d : draws) drawsJson.push(Value::Str(d));
    const race::StartResult want = race::startRace(startInputOf(1, draws));
    const Value phase2 = parseOrNull(
        ttp_race_start_live_json(room, 1, canonical_stringify(drawsJson).c_str(), 7, 3, nullptr,
                                 nullptr),
        "start draws launch");
    check(json::str_field(phase2, "action") == "launch", "phase 2 launches");
    check(json::num_field(phase2, "drawsUsed") == want.drawsUsed,
          "…and reports the draws the rule actually spent");
    const Value plan = at(phase2, "series");
    check(want.series.has && plan.type == Value::OBJ, "a random run commits to a series");
    if (want.series.has && plan.type == Value::OBJ) {
      check(json::str_field(plan, "kind") == race::key(want.series.series.kind),
            "the plan's kind is the rule's: " + json::str_field(plan, "kind"));
      check(json::str_field(plan, "cupId") == want.series.series.cupId, "…and its cupId");
      check(at(plan, "tracks").arr.size() == want.series.series.tracks.size(),
            "…and it carries the drawn card");
    }
    sameOps(phase2, launchRule(7, 3, nullptr).effects, "start_live/random effects");

    // A CUP plan carries kind+cupId and nothing else — the shell already holds
    // the cup, so re-sending its tracks would be a second copy on the wire.
    walkOf(ttp_net_on_peer_message_json(
               room, 0, "1", "{\"type\":\"select_mode\",\"mode\":\"cup\",\"cupId\":\"beach\"}", 0,
               1000),
           "select cup");
    ttp_room_events_json(room);
    const Value cupStart = parseOrNull(
        ttp_race_start_live_json(room, 1, nullptr, 9, 3, nullptr, nullptr), "start cup");
    const Value cupPlan = at(cupStart, "series");
    check(json::str_field(cupStart, "action") == "launch", "a cup pick launches at once");
    check(json::str_field(cupPlan, "kind") == "cup" &&
              json::str_field(cupPlan, "cupId") == "beach",
          "the cup plan names the cup");
    check(!cupPlan.has("tracks") && !cupPlan.has("cupName"),
          "…and nothing else — the shell already holds it");
  }

  // ---- advance_live: the cup chain -------------------------------------------
  {
    const int gp = ttp_gp_create(
        "{\"id\":\"beach\",\"name\":\"Beach\",\"tracks\":[\"tidepool\",\"helix\"]}", 0);
    ttp_room_transition_to(room, "countdown");
    ttp_room_transition_to(room, "playing");
    ttp_room_transition_to(room, "results");
    ttp_room_events_json(room);

    const auto advanceRule = [&](int g, int sceneReady) {
      const Value st = parseOrNull(ttp_gp_state_json(g), "gp state");
      race::AdvanceInput ai;
      ai.roomState = ui::roomStateOf(ttp_room_state(room));
      ai.hasSeries = st.type == Value::OBJ;
      ai.seriesFinished = json::truthy(st.find("finished"));
      ai.sceneReady = sceneReady != 0;
      ai.players = humansOf(true);
      return race::advanceSeriesRace(ai);
    };
    const auto sameAdvance = [&](int g, int sceneReady, const char* where) {
      const race::AdvanceResult want = advanceRule(g, sceneReady);
      const Value got = parseOrNull(ttp_race_advance_live_json(room, g, sceneReady), where);
      check(json::str_field(got, "action") == race::key(want.action),
            std::string("advance_live's action is the rule's (") + where + "): " +
                json::str_field(got, "action"));
      sameOps(got, want.effects, std::string("advance_live effects (") + where + ")");
    };
    sameAdvance(gp, 1, "mid-cup");
    sameAdvance(0, 1, "no series at all");
    sameAdvance(gp, 0, "the scene is not built");

    // A finished cup goes back to the lobby rather than chaining.
    ttp_gp_apply_race(gp, "[{\"playerId\":1,\"rank\":1,\"finished\":true}]",
                      "[{\"peerIndex\":1,\"name\":\"Ada\",\"colorIndex\":0,\"ai\":false}]", nullptr);
    ttp_gp_advance(gp);
    ttp_gp_apply_race(gp, "[{\"playerId\":1,\"rank\":1,\"finished\":true}]",
                      "[{\"peerIndex\":1,\"name\":\"Ada\",\"colorIndex\":0,\"ai\":false}]", nullptr);
    ttp_gp_advance(gp);
    sameAdvance(gp, 1, "the cup is over");
    ttp_gp_dispose(gp);
  }

  // ---- return_live: the way out, with its own draws protocol -----------------
  {
    const auto returnRule = [&](std::vector<std::string> draws) {
      race::ReturnInput ri;
      ri.roomState = ui::roomStateOf(ttp_room_state(room));
      const Value pick = parseOrNull(ttp_net_pick_json(room), "pick");
      ri.mode = json::str_field(pick, "mode");
      ri.cupId = json::opt_str<race::OptStr>(pick.find("cupId"));
      ri.trackId = json::opt_str<race::OptStr>(pick.find("trackId"));
      ri.cups = CUPS;
      ri.draws = std::move(draws);
      return race::returnToLobby(ri);
    };
    // From the lobby it is a no-op, and a no-op MUST NOT advance the bag.
    ttp_room_transition_to(room, "lobby");
    ttp_room_events_json(room);
    {
      const Value got = parseOrNull(ttp_race_return_live_json(room, nullptr), "return noop");
      check(json::str_field(got, "action") == "none", "return_live from the lobby is a no-op");
      check(json::num_field(got, "drawsUsed") == 0, "…and spends no draw");
      check(at(got, "effects").arr.empty(), "…and performs nothing");
    }
    // Mid-race, on a RANDOM pick: the pick re-rolls, so the walk asks first.
    walkOf(ttp_net_select_mode_draw_json(
               room, "1", "{\"type\":\"select_mode\",\"mode\":\"random\",\"randomRaces\":2}",
               "helix"),
           "select random for return");
    ttp_room_transition_to(room, "countdown");
    ttp_room_transition_to(room, "playing");
    ttp_room_events_json(room);

    const int need = race::returnDrawsNeeded(
        json::str_field(parseOrNull(ttp_net_pick_json(room), "pick"), "mode"));
    check(need > 0, "premise: a random room re-rolls on the way back");
    const Value ask = parseOrNull(ttp_race_return_live_json(room, nullptr), "return ask");
    check(json::str_field(ask, "action") == "draws" &&
              json::num_field(ask, "drawsNeeded") == need,
          "return_live asks for its draws first");
    const race::ReturnResult want = returnRule({"tidepool"});
    const Value got = parseOrNull(ttp_race_return_live_json(room, "[\"tidepool\"]"), "return");
    check(json::str_field(got, "action") == "return", "…then returns");
    check(canonical_stringify(at(got, "trackSwap")) ==
              canonical_stringify(want.trackSwap.has ? Value::Str(want.trackSwap.v)
                                                     : Value::Null()),
          "trackSwap re-aims the next lobby's pick exactly as the rule says");
    check(json::num_field(got, "drawsUsed") == want.drawsUsed, "…spending the rule's draws");
    sameOps(got, want.effects, "return_live effects");

    // Ending the PARTY takes nothing and is a frozen order.
    sameOps(parseOrNull(ttp_race_end_party_json(), "end party"), race::endParty(),
            "end_party effects");
  }

  // ---- pause / resume ---------------------------------------------------------
  {
    const int sess = ttp_session_begin("tidepool", 7u, 3, nullptr);
    ttp_add_human(sess, "1", nullptr);
    ttp_session_start(sess, 3);
    const auto pauseInput = [&](int s, int paused, int autoPaused, int raceEnded) {
      race::PauseInput pi;
      pi.hasSession = s != 0;
      pi.paused = paused != 0;
      pi.autoPaused = autoPaused != 0;
      pi.raceEnded = raceEnded != 0;
      pi.roomState = ui::roomStateOf(ttp_room_state(room));
      return pi;
    };
    for (int s : {sess, 0})
      for (int p = 0; p <= 1; p++)
        for (int ap = 0; ap <= 1; ap++)
          for (int re = 0; re <= 1; re++) {
            const race::PauseInput in = pauseInput(s, p, ap, re);
            const Value gotP = parseOrNull(ttp_race_pause_live_json(s, room, p, ap, re), "pause");
            const race::PauseResult wantP = race::pauseRace(in);
            check(json::str_field(gotP, "action") == race::key(wantP.action),
                  "pause_live's verdict is race::pauseRace's");
            sameOps(gotP, wantP.effects, "pause_live effects");
            const Value gotR = parseOrNull(ttp_race_resume_live_json(s, room, p, ap, re), "resume");
            const race::PauseResult wantR = race::resumeRace(in);
            check(json::str_field(gotR, "action") == race::key(wantR.action),
                  "resume_live's verdict is race::resumeRace's");
            sameOps(gotR, wantR.effects, "resume_live effects");
          }
    ttp_dispose(sess);
  }

  // ---- the lobby attract demo -------------------------------------------------
  {
    const std::vector<race::DemoEntry> want = race::buildDemoField(humansOf(false), W);
    const Value got = parseOrNull(ttp_race_demo_live_json(room, "tidepool", nullptr), "demo");
    check(at(got, "field").arr.size() == want.size(),
          "demo_live seats the whole attract grid, dropped seats included");
    check(json::str_field(got, "sig") == race::demoSig(want, "tidepool"),
          "…and its signature is race::demoSig over that field");
    bool ids = at(got, "field").arr.size() == want.size();
    for (size_t i = 0; ids && i < want.size(); i++)
      ids = json::str_field(at(got, "field").arr[i], "id") == want[i].id &&
            json::str_field(at(at(got, "field").arr[i], "persona"), "name") ==
                want[i].persona.name;
    check(ids, "…with the demo ids and the by-grid-index personas the rule assigns");
    // The signature must move with the TRACK, or a cup change would keep the
    // stale grid on screen.
    check(json::str_field(parseOrNull(ttp_race_demo_live_json(room, "helix", nullptr), "demo2"),
                          "sig") != json::str_field(got, "sig"),
          "a different track is a different signature");
  }

  // ---- auto_pause_live: the ui rule plus the race layer's effects -------------
  {
    const int sess = ttp_session_begin("tidepool", 7u, 3, nullptr);
    ttp_add_human(sess, "1", nullptr);
    ttp_add_human(sess, "3", nullptr);
    ttp_add_bot(sess, "\"ai-0\"", 1.0, 0.0, 1u, nullptr);
    ttp_session_start(sess, 3);

    const auto autoPauseRule = [&](int s, int raceEnded) {
      ui::AutoPauseInput in;
      in.hasSession = s != 0;
      in.raceEnded = raceEnded != 0;
      in.roomState = ui::roomStateOf(ttp_room_state(room));
      const Value ids = s ? parseOrNull(ttp_car_ids_json(s), "car ids") : Value::Arr();
      for (const Value& idV : ids.arr) {
        const ui::Id id = json::id_of<ui::Id>(&idV);
        in.carIds.push_back(id);
        if (flow->has(id)) in.seatedIds.add(id);
      }
      if (s) in.aiIds.add(ui::Id::Str("ai-0"));
      const bool allDisc = ui::autoPauseAsksParticipants(in) &&
                           ttp_room_all_participants_disconnected_synced(room, s) != 0;
      const ui::AutoPauseDecision d = ui::autoPause(in, allDisc);
      race::AutoPauseDecision rd;
      rd.present = true;
      rd.action = ui::key(d.action);
      rd.autoPaused = d.hasAutoPaused && d.autoPaused;
      return race::autoPauseEffects(rd);
    };
    const auto sameAutoPause = [&](int s, int ended, const char* where) {
      sameOps(parseOrNull(ttp_race_auto_pause_live_json(s, room, ended), where),
              autoPauseRule(s, ended), std::string("auto_pause_live effects (") + where + ")");
    };
    sameAutoPause(sess, 0, "playing, one racer dropped");
    flow->markDisconnected(PeerId::Num(1));
    sameAutoPause(sess, 0, "playing, every racer dropped");
    sameAutoPause(sess, 1, "results overlay up");
    sameAutoPause(0, 0, "no session");
    flow->markReconnected(PeerId::Num(1));
    ttp_room_events_json(room);
    ttp_dispose(sess);
  }

  // ---- forfeit_live / rekey_live: the removal happens INSIDE the walk ---------
  {
    const int sess = ttp_session_begin_field(
        "tidepool", 7u, 3, nullptr,
        "[{\"peerIndex\":1},{\"peerIndex\":2},{\"peerIndex\":\"ai-0\"}]",
        "[{\"peerIndex\":\"ai-0\",\"caution\":1,\"laneBias\":0,\"seed\":1}]");
    ttp_session_start(sess, 3);
    check(ttp_has_car(sess, "2") == 1, "premise: seat 2 holds a car");

    const Value f1 = parseOrNull(ttp_race_forfeit_live_json(sess, "2"), "forfeit");
    check(ttp_has_car(sess, "2") == 0, "forfeit_live removed the car itself");
    sameOps(f1, race::forfeitCar(true, race::Id::Num(2)), "forfeit_live effects (removed)");
    const Value f2 = parseOrNull(ttp_race_forfeit_live_json(sess, "2"), "forfeit again");
    sameOps(f2, race::forfeitCar(false, race::Id::Num(2)),
            "forfeit_live effects (there was no car)");
    sameOps(parseOrNull(ttp_race_forfeit_live_json(0, "2"), "forfeit no session"),
            race::forfeitCar(false, race::Id::Num(2)), "forfeit_live with no race");

    const int gp = ttp_gp_create("{\"id\":\"beach\",\"name\":\"Beach\",\"tracks\":[\"tidepool\"]}", 0);
    const Value r1 = parseOrNull(ttp_race_rekey_live_json(sess, gp, "1", "9"), "rekey");
    check(ttp_has_car(sess, "9") == 1 && ttp_has_car(sess, "1") == 0,
          "rekey_live moved the car itself");
    sameOps(r1, race::rekeyCarPlayer(true, true, race::Id::Num(1), race::Id::Num(9)),
            "rekey_live effects (a car moved, a series is live)");
    // Banked points follow the PLAYER, so the series rekey fires with no car.
    const Value r2 = parseOrNull(ttp_race_rekey_live_json(sess, gp, "1", "8"), "rekey no car");
    sameOps(r2, race::rekeyCarPlayer(true, false, race::Id::Num(1), race::Id::Num(8)),
            "rekey_live effects (no car, but the cup still follows the player)");
    check(opsOf(r2).find("series-rekey") != std::string::npos,
          "…and series-rekey is in it");
    const Value r3 = parseOrNull(ttp_race_rekey_live_json(sess, 0, "9", "7"), "rekey no series");
    sameOps(r3, race::rekeyCarPlayer(false, true, race::Id::Num(9), race::Id::Num(7)),
            "rekey_live effects (no series)");
    ttp_gp_dispose(gp);
    ttp_dispose(sess);
  }

  // ---- events_live: the drain, its routing and its results -------------------
  //
  // The walk drains the queue, so the expected side cannot read the same events
  // after it. A SECOND session built identically stays bit-identical under
  // identical driving (beginFieldMatchesManualPath is the same trick), so its
  // ttp_events_json is the oracle for what the walk just consumed.
  {
    const char* kField = "[{\"peerIndex\":1},{\"peerIndex\":\"ai-0\"}]";
    const char* kBots = "[{\"peerIndex\":\"ai-0\",\"caution\":1,\"laneBias\":0,\"seed\":1}]";
    const int live = ttp_session_begin_field("tidepool", 7u, 3, nullptr, kField, kBots);
    const int twin = ttp_session_begin_field("tidepool", 7u, 3, nullptr, kField, kBots);
    ttp_session_start(live, 1);
    ttp_session_start(twin, 1);
    const double kInterMs = ttp_race_intermission_ms();
    const double kFailMs = ttp_race_results_failsafe_ms();
    check(kInterMs == race::INTERMISSION_MS && kFailMs == race::RESULTS_FAILSAFE_MS,
          "the two timing budgets read back as race_flow's own");

    // The expected effects for whatever the twin drained, routed the way the
    // walk routes them — the three lifecycle beats to their own rules, the rest
    // through the ordinary-event filter.
    const auto expectedFor = [&](const Value& events, const char* biome, int audioReady,
                                 int fastForwarding, double nowMs) {
      race::Effects all;
      for (const Value& e : events.arr) {
        const std::string type = json::str_field(e, "type");
        race::Effects es;
        if (type == "_countdown") {
          es = race::countdownTick(json::num_field(e, "n"));
        } else if (type == "_raceStart") {
          es = race::raceStart(biome, audioReady != 0);
        } else if (type == "_raceEnd") {
          race::EndRaceInput ei;
          ei.hasSeries = false;
          ei.seriesFinished = false;
          ei.intermissionMs = kInterMs;
          ei.nowMs = nowMs;
          ei.resultsFailsafeMs = kFailMs;
          es = race::endRace(ei);
        } else {
          const bool allDone = type == "finish" && !fastForwarding &&
                               ttp_live_humans_all_done(twin, room);
          es = race::raceEvent(raceEventOf(e), fastForwarding != 0, allDone);
        }
        for (race::Effect& x : es) all.push_back(std::move(x));
      }
      return all;
    };

    int beats = 0, gos = 0;
    for (int f = 0; f < 120; f++) {
      ttp_update(live, 1000.0 / 60.0);
      ttp_update(twin, 1000.0 / 60.0);
      const Value drained = parseOrNull(ttp_events_json(twin), "twin events");
      const Value got = parseOrNull(
          ttp_race_events_live_json(live, room, 0, "beach", 1, 0, kInterMs, f * 16.0, kFailMs),
          "events_live");
      sameOps(got, expectedFor(drained, "beach", 1, 0, f * 16.0), "events_live effects");
      for (const Value& e : drained.arr) {
        if (json::str_field(e, "type") != "_countdown") continue;
        beats++;
        if (json::num_field(e, "n") == 0) gos++;
      }
      check(at(got, "results").type == Value::NUL || json::str_field(got, "op") == "",
            "results stays null until the race ends");
    }
    check(beats >= 2 && gos == 1,
          "the countdown beats were routed, GO among them (" + std::to_string(beats) +
              " beats, " + std::to_string(gos) + " GO)");
    // The queue really empties: a second drain with nothing behind it.
    const Value empty = parseOrNull(
        ttp_race_events_live_json(live, room, 0, "beach", 1, 0, kInterMs, 9000, kFailMs),
        "events_live empty");
    check(at(empty, "effects").arr.empty() && at(empty, "results").type == Value::NUL,
          "a drained queue answers no effects and a null results");

    // The end of the race: `results` rides the ANSWER, because no effect can
    // carry it and three of them read it as their context.
    for (const char* id : {"1", "\"ai-0\""}) {
      ttp_force_finish(live, id, 12.5);
      ttp_force_finish(twin, id, 12.5);
    }
    ttp_update(live, 1000.0 / 60.0);
    ttp_update(twin, 1000.0 / 60.0);
    const Value drained = parseOrNull(ttp_events_json(twin), "twin end events");
    const Value ended = parseOrNull(
        ttp_race_events_live_json(live, room, 0, "beach", 1, 0, kInterMs, 10000, kFailMs),
        "events_live end");
    sameOps(ended, expectedFor(drained, "beach", 1, 0, 10000), "events_live effects at the flag");
    check(at(ended, "results").type == Value::OBJ,
          "the end of the race carries its ranked board on the answer");
    check(opsOf(ended).find("show-results") != std::string::npos,
          "…and the endRace composition is in the effects");
    ttp_dispose(live);
    ttp_dispose(twin);
  }

  ttp_room_dispose(room);
  ttp_net_configure("");
  std::printf("  race walks against the composed decision functions\n");
}

}  // namespace

int main(int argc, char** argv) {
  // Three corpora and the traces. The roomflow, session and raceflow fixtures
  // are NOT taken any more: the JSON-taking spellings they were replayed
  // through are gone, and roomflow_check / session_check / raceflow_check
  // replay them against the decision layers themselves on every leg. The walks
  // that replaced those spellings are gated by composition instead — see the
  // file header.
  if (argc < 4) {
    std::fprintf(stderr, "usage: abi_check <grandprix-corpus> <framing-corpus> <ui-corpus> "
                         "<trace.jsonl>...\n");
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
  roomShellSurface();
  abandonedRacePolicy();
  framingCorpusThroughAbi(argv[2]);
  fastlaneThroughAbi();
  themeThroughAbi();
  audioThroughAbi();
  uiShippedCatalogue();
  uiCupTendency();
  uiCorpusThroughAbi(argv[3]);
  handlePathsMatchJsonPaths();
  uiLiveTwinsMatchJsonPaths();
  beginFieldMatchesManualPath();
  netWalksMatchMultiCallPath();
  raceLiveWalks();

  std::printf("  %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
