// Session-model conformance check — replays tests/fixtures/session-corpus.jsonl
// against native/libttp-party/ttp/session.h.
//
// JS-RECORDED evidence, like the roomflow/ui/audio corpora and unlike the
// C++-authored ones: every line here was taken off the live
// public/display/sessionModel.js before the port, so it settles whether the port
// matches the JS it replaced.
//
// --record RE-EMITS, IT DOES NOT REGENERATE. `--record <fixture> --out=<f>`
// replays the fixture's own recorded INPUTS through the port and writes the
// corpus back with the C++'s answers; record_session holds the result
// byte-identical. It cannot invent a case — the scenarios are read off the
// committed file, not rebuilt — so what it proves is that the port reproduces
// every recorded answer and its exact JSON spelling, which is strictly more than
// the structural replay below asserts. It is NOT parity evidence: the committed
// bytes carry that, and the JS wrote them. If a re-record ever differs, the
// committed file is right.
//
// Line 1 is a header {kind,scenarios,steps}. Then {case:"scenario",name} starts a
// scenario and {case:"step",name,step,op,in,out,state} is one step. Each step's
// `in` is the FULLY RESOLVED input, so a step replays standalone; `state` is the
// heartbeat state the driver threads, checked separately because a port that
// answers right but threads wrong is still broken.
//
// The comparison is structural through corpus_diff's diff_val, which compares
// numbers via js_number_to_string — so a recorded decimal matches iff it
// round-trips to the same double.
//
// THE SNAPSHOT'S KEY ORDER IS NOT COMPARED HERE, and nothing else compares it
// either: diff_val is structural and canonical, tests/wire-compat.test.js sorts
// both sides before it compares key SETS against the real unmodified controller,
// and the frame encoder canonicalizes everything that leaves. (This note used to
// claim wire-compat pinned the order. It never did.)
//
// ONE THING THIS CHECK DELIBERATELY REPRODUCES BY HAND rather than reading off
// the port, because it is the contract:
//   * `in.absent` distinguishes a MISSING rejoinToken (JS undefined) from an
//     explicit null. They answer differently and that is frozen; see session.h.

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

#include "corpus_diff.h"
#include "corpus_record.h"
#include "ttp/canonical.h"
#include "ttp/json_read.h"
#include "ttp/session.h"

using namespace ttp;
using namespace ttp::corpus;
namespace ns = ttp::session;

namespace {

const Value* field(const Value& o, const char* k) { return o.find(k); }

// Everything a corpus field needs read out of it is ttp/json_read.h — the same
// readers runtime/ttp_net.cc marshals this layer's ABI with, so a step replayed
// here and the same step crossing the boundary in abi_check.cc read their input
// exactly alike.
ns::RoomState stateOf(const Value& o, const char* k) {
  return ns::room_state_of(json::str_field(o, k));
}

Value seatValue(const ns::SeatDefaults& d) {
  Value v = Value::Obj();
  v.set("nameKey", Value::Str(d.nameKey));
  v.set("nameArg", Value::Num(d.nameArg));
  v.set("colorIndex", Value::Num(d.colorIndex));
  v.set("carIndex", Value::Num(d.carIndex));
  v.set("ready", Value::Bool(d.ready));
  return v;
}

// The threaded shell state: exactly what Net.js keeps beside the model.
struct Shell {
  bool hbPending = false;
  double hbSentAt = 0;
};

Value shellState(const Shell& st) {
  Value v = Value::Obj();
  v.set("hbPending", Value::Bool(st.hbPending));
  v.set("hbSentAt", Value::Num(st.hbSentAt));
  return v;
}

// One step. Returns the answer in the same shape the generator recorded.
bool applyOp(Shell& st, const std::string& op, const Value& in, Value& out, std::string& why) {
  out = Value::Obj();

  if (op == "roster") {
    out.set("rows", ns::roster_rows(json::arr_field(in, "roster"), json::arr_field(in, "inRace")));
    return true;
  }
  if (op == "snapshot") {
    const Value* chooser = field(in, "chooser");
    out.set("snapshot", ns::lobby_snapshot(
                            in, (chooser && chooser->type == Value::OBJ) ? *chooser : Value::Obj()));
    return true;
  }
  if (op == "joinUrl") {
    // `cpp` postdates the frozen corpus: absent reads as "" (declare nothing),
    // which is exactly the URL every recorded line asserts.
    out.set("url", Value::Str(ns::join_url(json::str_field(in, "base"), json::str_field(in, "room"),
                                           json::str_field(in, "instance"),
                                           json::str_field(in, "cpp"))));
    return true;
  }
  if (op == "claimUrl") {
    out.set("url", Value::Str(ns::claim_url(json::str_field(in, "url"), json::num_field(in, "peerIndex"))));
    return true;
  }
  if (op == "template") {
    std::string t;
    out.set("template",
            ns::controller_url_template(json::str_field(in, "base"), json::str_field(in, "cpp"), &t)
                ? Value::Str(t)
                : Value::Null());
    return true;
  }
  if (op == "normIndex") {
    // `absent` is JS undefined; otherwise the recorded value, INCLUDING null.
    const Value* v = json::truthy(field(in, "absent")) ? nullptr : field(in, "value");
    double n = 0;
    out.set("index", ns::norm_index(v, &n) ? Value::Num(n) : Value::Null());
    return true;
  }
  if (op == "seat") {
    out.set("defaults", seatValue(ns::seat_defaults(json::num_field(in, "colorIndex"))));
    return true;
  }
  if (op == "addPeer") {
    const ns::AddPeerPlan p = ns::add_peer_plan(json::truthy(field(in, "has")), json::num_field(in, "size"),
                                                json::num_field(in, "maxPlayers"), json::num_field(in, "colorIndex"));
    Value plan = Value::Obj();
    plan.set("seat", p.hasSeat ? seatValue(p.seat) : Value::Null());
    plan.set("stamp", Value::Bool(p.stamp));
    out.set("plan", std::move(plan));
    return true;
  }
  if (op == "presence") {
    out.set("action", Value::Str(ns::key(ns::presence_action(stateOf(in, "roomState")))));
    return true;
  }
  if (op == "leave") {
    out.set("action", Value::Str(ns::key(ns::leave_action(stateOf(in, "roomState")))));
    return true;
  }
  if (op == "card") {
    const Value* seat = field(in, "seat");
    out.set("card", ns::reconnect_card(seat ? *seat : Value::Obj(), json::str_field(in, "url")));
    return true;
  }
  if (op == "route") {
    out.set("route", Value::Str(ns::key(ns::inbound_route(json::num_field(in, "from"), json::str_field(in, "type")))));
    return true;
  }
  if (op == "action") {
    out.set("action", Value::Str(ns::key(ns::message_action(json::str_field(in, "type")))));
    return true;
  }
  if (op == "setCar") {
    out.set("accept", Value::Bool(ns::set_car_decision(
                          json::truthy(field(in, "ready")), stateOf(in, "roomState"),
                          json::truthy(field(in, "inRace")), field(in, "carIndex"),
                          json::num_field(in, "carCount"))));
    return true;
  }
  if (op == "setReady") {
    out.set("accept", Value::Bool(ns::set_ready_decision(
                          json::truthy(field(in, "isHost")), stateOf(in, "roomState"),
                          json::truthy(field(in, "ready")), json::truthy(field(in, "current")))));
    return true;
  }
  if (op == "stateChange") {
    const ns::StateChangePlan p = ns::state_change_plan(stateOf(in, "to"));
    Value plan = Value::Obj();
    plan.set("restampConnected", Value::Bool(p.restampConnected));
    plan.set("freeDisconnected", Value::Bool(p.freeDisconnected));
    plan.set("clearStandings", Value::Bool(p.clearStandings));
    plan.set("publish", Value::Bool(p.publish));
    out.set("plan", std::move(plan));
    return true;
  }
  if (op == "hostChange") {
    const ns::HostChangePlan p = ns::host_change_plan();
    Value plan = Value::Obj();
    plan.set("clearReady", Value::Bool(p.clearReady));
    plan.set("publish", Value::Bool(p.publish));
    out.set("plan", std::move(plan));
    return true;
  }
  if (op == "hb") {
    const ns::HeartbeatTick t = ns::heartbeat_tick(json::truthy(field(in, "inRoom")),
                                                   json::truthy(field(in, "hbPending")),
                                                   json::num_field(in, "hbSentAt"), json::num_field(in, "now"));
    st.hbPending = t.hbPending;
    st.hbSentAt = t.hbSentAt;
    Value tick = Value::Obj();
    tick.set("act", Value::Str(ns::key(t.act)));
    tick.set("hbPending", Value::Bool(t.hbPending));
    tick.set("hbSentAt", Value::Num(t.hbSentAt));
    tick.set("sweep", Value::Bool(t.sweep));
    out.set("tick", std::move(tick));
    return true;
  }
  if (op == "claim") {
    const Value* token = json::truthy(field(in, "absent")) ? nullptr : field(in, "rejoinToken");
    const ns::ClaimPlan p = ns::claim_plan(json::num_field(in, "fromId"), token,
                                           json::truthy(field(in, "hasOld")),
                                           json::truthy(field(in, "oldDisconnected")));
    Value plan = Value::Obj();
    plan.set("claim", Value::Bool(p.claim));
    if (p.claim) {
      plan.set("oldId", Value::Num(p.oldId));
      plan.set("restamp", Value::Bool(p.restamp));
    }
    out.set("plan", std::move(plan));
    return true;
  }
  if (op == "resync") {
    const ns::ResyncPlan p = ns::resync_plan(json::num_list(in, "rosterIds"),
                                             json::num_list(in, "relayPeers"));
    Value expire = Value::Arr();
    for (double id : p.expire) expire.push(Value::Num(id));
    Value add = Value::Arr();
    for (double id : p.add) add.push(Value::Num(id));
    Value plan = Value::Obj();
    plan.set("expire", std::move(expire));
    plan.set("add", std::move(add));
    plan.set("publish", Value::Bool(p.publish));
    out.set("plan", std::move(plan));
    return true;
  }

  why = "unknown op '" + op + "'";
  return false;
}

}  // namespace

// Re-emit the corpus from the port. Same driver as the replay below, same shell
// threading; only the comparison is replaced by a write.
int recordCorpus(const std::string& fixture, const std::string& outPath) {
  Shell st;
  bool bad = false;
  const int rc = corpus::record(fixture, outPath, [&](const Value& rec) {
    const std::string kind = json::str_field(rec, "case");
    if (kind == "scenario") { st = Shell{}; return Value(); }   // UNDEF: copy through
    if (kind != "step") return Value();
    const Value* in = field(rec, "in");
    Value out;
    std::string why;
    if (!applyOp(st, json::str_field(rec, "op"), in ? *in : Value::Obj(), out, why)) {
      std::fprintf(stderr, "--record: %s\n", why.c_str());
      bad = true;
      return Value();
    }
    // The same key SET the generator wrote; canonical_stringify sorts them.
    Value line = Value::Obj();
    line.set("case", Value::Str("step"));
    line.set("name", Value::Str(json::str_field(rec, "name")));
    line.set("step", Value::Num(json::num_field(rec, "step")));
    line.set("op", Value::Str(json::str_field(rec, "op")));
    line.set("in", in ? *in : Value::Obj());
    line.set("out", out);
    line.set("state", shellState(st));
    return line;
  });
  return (rc == 0 && !bad) ? 0 : 1;
}

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: session_check <session-corpus.jsonl>\n"
                         "       session_check --record <corpus> --out=<file>\n");
    return 2;
  }
  {
    std::string fixture, outPath;
    if (corpus::wants_record(argc, argv, &fixture, &outPath)) return recordCorpus(fixture, outPath);
  }
  std::ifstream f(argv[1]);
  if (!f) {
    std::fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }

  std::string line;
  if (!std::getline(f, line)) {
    std::fprintf(stderr, "empty corpus\n");
    return 2;
  }
  Value header;
  std::string err;
  if (!read_line(line, header, &err)) {
    std::fprintf(stderr, "bad header: %s\n", err.c_str());
    return 2;
  }
  const int wantSteps = static_cast<int>(json::num_field(header, "steps", -1));
  const int wantScenarios = static_cast<int>(json::num_field(header, "scenarios", -1));

  Shell st;
  std::string scenario;
  int scenarios = 0, steps = 0, spew = 0, failures = 0;

  while (std::getline(f, line)) {
    if (line.empty()) continue;
    Value rec;
    if (!read_line(line, rec, &err)) {
      std::fprintf(stderr, "bad line: %s\n", err.c_str());
      return 2;
    }
    const std::string kind = json::str_field(rec, "case");
    if (kind == "scenario") {
      scenario = json::str_field(rec, "name");
      st = Shell{};
      scenarios++;
      continue;
    }
    if (kind != "step") continue;

    const std::string op = json::str_field(rec, "op");
    const Value* in = field(rec, "in");
    Value out;
    std::string why;
    if (!applyOp(st, op, in ? *in : Value::Obj(), out, why)) {
      std::fprintf(stderr, "FAIL %s step %d: %s\n", scenario.c_str(),
                   static_cast<int>(json::num_field(rec, "step")), why.c_str());
      return 2;
    }
    steps++;

    const Value* expOut = field(rec, "out");
    const Value* expState = field(rec, "state");
    Value state = shellState(st);
    struct Piece { const char* label; const Value* exp; const Value* act; };
    const Piece pieces[2] = {{"out", expOut, &out}, {"state", expState, &state}};
    for (const Piece& pc : pieces) {
      if (!pc.exp) continue;
      const Diff d = diff_val(*pc.exp, *pc.act, pc.label);
      if (!d.differ) continue;
      failures++;
      if (spew++ < 20) {
        std::fprintf(stderr,
                     "FAIL %s  step %d  op %s\n  piece %s  path %s\n  expected %s\n  actual   %s\n",
                     scenario.c_str(), static_cast<int>(json::num_field(rec, "step")), op.c_str(),
                     pc.label, d.path.c_str(), d.expected.c_str(), d.actual.c_str());
      }
      break;
    }
  }

  if (wantSteps >= 0 && steps != wantSteps) {
    std::fprintf(stderr, "FAIL: replayed %d steps, header says %d\n", steps, wantSteps);
    failures++;
  }
  if (wantScenarios >= 0 && scenarios != wantScenarios) {
    std::fprintf(stderr, "FAIL: saw %d scenarios, header says %d\n", scenarios, wantScenarios);
    failures++;
  }

  std::printf("session corpus: %d scenarios, %d steps, %d failures\n", scenarios, steps, failures);
  return failures ? 1 : 0;
}
