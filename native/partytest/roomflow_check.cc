// RoomFlow conformance check — replays tests/fixtures/roomflow-corpus.jsonl (the
// behavioural oracle recorded off the retired partyplug/RoomFlow.js, since
// re-emitted from C++) against libttp-party's RoomFlow. Line 1 is a header {scripts,events}; each further
// line is one scripted run: {name, config, steps:[{op, ret, events, digest}...]}.
//
// For every step it builds the RoomFlow from config (masterProvider modeled as a
// settable value driven by setMaster ops), applies
// the op, and demands the port reproduce ret + the events emitted during that op
// (exact order + detail) + a public-surface digest — compared as canonical JSON.
// First divergent piece prints script/step/op + expected-vs-got; spew capped at 20.
//
// `--record <fixture> --out=<f>` RE-EMITS (corpus_record.h): each script's own
// recorded config and ops are fed back through the port and the answers written
// out; record_roomflow holds the result byte-identical to the committed file.
// The JS generator is gone, so this is how the corpus follows a deliberate
// change to the room machine — green-first, under tests/CLAUDE.md.

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

#include "corpus_diff.h"   // read_line + the shared structural diff_val
#include "corpus_record.h"
#include "ttp/canonical.h"
#include "ttp/jsonnum.h"
#include "ttp/room_flow.h"

using namespace ttp;
using namespace ttp::corpus;

// ---------------------------------------------------------------------------
// Corpus Value -> port types.
// ---------------------------------------------------------------------------
static PeerId peerFrom(const Value& v) {
  if (v.type == Value::NUM) return PeerId::Num(v.num);
  if (v.type == Value::STR) return PeerId::Str(v.str);
  return PeerId::None();
}

// ---------------------------------------------------------------------------
// Accumulating peer set for the perPeer digest (mirrors the generator: union of
// every op's p/oldId/newId, sorted ascending). Numeric ids sort numerically.
// ---------------------------------------------------------------------------
struct PeerSet {
  std::vector<PeerId> ids;
  void add(const PeerId& p) {
    for (const auto& e : ids) if (e == p) return;
    ids.push_back(p);
  }
  std::vector<PeerId> sorted() const {
    std::vector<PeerId> out = ids;
    std::sort(out.begin(), out.end(), [](const PeerId& a, const PeerId& b) {
      if (a.kind == PeerId::NUM && b.kind == PeerId::NUM) return a.num < b.num;
      if (a.kind == PeerId::STR && b.kind == PeerId::STR) return a.str < b.str;
      return a.kind < b.kind;  // mixed types never occur in the corpus
    });
    return out;
  }
};

static Value buildDigest(const RoomFlow& flow, const PeerSet& peers) {
  Value d = Value::Obj();
  d.set("state", Value::Str(flow.stateName()));
  d.set("host", flow.host().toValue());
  d.set("size", Value::Num((double)flow.size()));
  d.set("connectedCount", Value::Num((double)flow.connectedCount()));
  d.set("list", flow.listValue());
  d.set("allDisconnected", Value::Bool(flow.allParticipantsDisconnected()));
  Value pp = Value::Arr();
  for (const PeerId& p : peers.sorted()) {
    Value e = Value::Obj();
    e.set("p", p.toValue());
    e.set("has", Value::Bool(flow.has(p)));
    e.set("isHost", Value::Bool(flow.isHost(p)));
    e.set("disc", Value::Bool(flow.isDisconnected(p)));
    pp.push(std::move(e));
  }
  d.set("perPeer", std::move(pp));
  return d;
}


// ---------------------------------------------------------------------------
// One scripted run, shared by the replay and --record: builds the RoomFlow from
// the line's config and answers {op, ret, events, digest} for every step, in
// the shape the generator recorded. False (with a message) on an unknown op.
// ---------------------------------------------------------------------------
static bool runScript(const Value& root, std::vector<Value>& answers, std::string& why) {
  const Value* cfgV = root.find("config");
  RoomFlow::Config cfg;
  cfg.hasMasterProvider = cfgV->find("useMasterProvider")->b;
  const Value* masterV = cfgV->find("master");
  cfg.master = masterV ? peerFrom(*masterV) : PeerId::None();
  const Value* livV = cfgV->find("liveness");
  if (livV && livV->type == Value::OBJ) {
    if (const Value* x = livV->find("graceMs")) cfg.graceMs = x->num;
  }

  std::vector<std::pair<std::string, Value>> captured;
  RoomFlow flow(cfg, [&](const std::string& type, const Value& detail) {
    captured.emplace_back(type, detail);
  });

  PeerSet peers;
  const Value* steps = root.find("steps");
  for (size_t si = 0; si < steps->arr.size(); si++) {
    const Value& op = *steps->arr[si].find("op");
    const std::string& opName = op.find("op")->str;
    // accumulate peer ids for the digest (before applying, as the generator does)
    for (const char* k : {"p", "oldId", "newId"})
      if (const Value* x = op.find(k)) peers.add(peerFrom(*x));

    captured.clear();
    Value ret = Value::Null();

    if (opName == "add") {
      std::vector<std::pair<std::string, Value>> fields;
      if (const Value* f = op.find("fields"))
        for (auto& kv : f->obj) fields.emplace_back(kv.first, (kv.second));
      const Player* p = flow.addPlayer(peerFrom(*op.find("p")), fields);
      ret = p->toValue();
    } else if (opName == "remove") {
      flow.removePlayer(peerFrom(*op.find("p")));
    } else if (opName == "rekey") {
      ret = Value::Bool(flow.rekey(peerFrom(*op.find("oldId")), peerFrom(*op.find("newId"))));
    } else if (opName == "markDisc") {
      flow.markDisconnected(peerFrom(*op.find("p")));
    } else if (opName == "markReconn") {
      flow.markReconnected(peerFrom(*op.find("p")));
    } else if (opName == "transition") {
      ret = Value::Bool(flow.transitionTo(op.find("to")->str));
    } else if (opName == "endGame") {
      ret = Value::Bool(flow.endGame());
    } else if (opName == "returnToLobby") {
      ret = Value::Bool(flow.returnToLobby());
    } else if (opName == "setOrder") {
      std::vector<PeerId> ord;
      if (const Value* o = op.find("order")) for (auto& e : o->arr) ord.push_back(peerFrom(e));
      flow.setActiveOrder(ord);
    } else if (opName == "graceTick") {
      ret = Value::Bool(flow.graceTick(op.find("t")->num));
    } else if (opName == "setMaster") {
      flow.setMasterValue(peerFrom(*op.find("v")));
    } else if (opName == "setField") {
      // The live-record write the display does directly on the kit's mutable
      // record; behind an ABI it is a setter. Emits nothing, kit keys refused.
      const std::string& key = op.find("key")->str;
      Value v = *op.find("value");
      const bool ok = flow.setField(peerFrom(*op.find("p")), key, v);
      if (ok) {
        const Player* p2 = flow.get(peerFrom(*op.find("p")));
        ret = Value::Null();
        if (p2) for (const auto& kv : p2->fields) if (kv.first == key) ret = kv.second;
      } else {
        ret = Value::Null();   // unknown peer (or a kit key) -> JS records null
      }
    } else if (opName == "reset") {
      flow.reset();
    } else {
      why = "step " + std::to_string(si) + ": unknown op '" + opName + "'";
      return false;
    }

    // events emitted during this op, in order
    Value events = Value::Arr();
    for (auto& ev : captured) {
      Value e = Value::Obj();
      e.set("type", Value::Str(ev.first));
      e.set("detail", ev.second);
      events.push(std::move(e));
    }
    Value answer = Value::Obj();
    answer.set("op", op);
    answer.set("ret", std::move(ret));
    answer.set("events", std::move(events));
    answer.set("digest", buildDigest(flow, peers));
    answers.push_back(std::move(answer));
  }
  return true;
}

// Re-emit the corpus from the port (corpus_record.h). The header and the
// lowestFreeSlot lines copy through; each script line is rebuilt from its own
// recorded config and ops with the C++'s answers.
static int recordCorpus(const std::string& fixture, const std::string& outPath) {
  bool bad = false;
  bool header = true;
  const int rc = corpus::record(fixture, outPath, [&](const Value& root) {
    if (header) { header = false; return Value(); }   // UNDEF: copy through
    if (root.find("slotCase")) return Value();
    std::vector<Value> answers;
    std::string why;
    if (!runScript(root, answers, why)) {
      std::fprintf(stderr, "--record %s: %s\n", root.find("name")->str.c_str(), why.c_str());
      bad = true;
      return Value();
    }
    Value steps = Value::Arr();
    for (Value& a : answers) steps.push(std::move(a));
    Value line = Value::Obj();
    line.set("config", *root.find("config"));
    line.set("name", *root.find("name"));
    line.set("steps", std::move(steps));
    return line;
  });
  return (rc == 0 && !bad) ? 0 : 1;
}

// ---------------------------------------------------------------------------
int main(int argc, char** argv) {
  {
    std::string fixture, outPath;
    if (corpus::wants_record(argc, argv, &fixture, &outPath)) return recordCorpus(fixture, outPath);
  }
  if (argc != 2) {
    std::fprintf(stderr, "usage: roomflow_check <roomflow-corpus.jsonl>\n"
                         "       roomflow_check --record <corpus> --out=<file>\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }

  std::string headerLine;
  if (!std::getline(in, headerLine)) { std::fprintf(stderr, "empty corpus\n"); return 2; }

  int scripts = 0, scriptsPassed = 0, spew = 0;
  int slotCases = 0, slotPassed = 0;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    if (!read_line(line, root)) { std::fprintf(stderr, "parse error on script line\n"); return 2; }

    // lowestFreeSlot cases are their own line kind (no RoomFlow instance).
    if (const Value* sc = root.find("slotCase")) {
      std::vector<double> used;
      if (const Value* u = sc->find("used")) for (const Value& e : u->arr) used.push_back(e.num);
      const int max = static_cast<int>(sc->find("max")->num);
      const int want = static_cast<int>(sc->find("expect")->num);
      const int got = lowest_free_slot(used, max);
      slotCases++;
      if (got == want) {
        slotPassed++;
      } else if (spew++ < 20) {
        std::fprintf(stderr, "FAIL lowestFreeSlot(max %d): expected %d, actual %d\n", max, want, got);
      }
      continue;
    }

    scripts++;
    const std::string& name = root.find("name")->str;
    std::vector<Value> answers;
    std::string why;
    if (!runScript(root, answers, why)) {
      std::fprintf(stderr, "FAIL %s %s\n", name.c_str(), why.c_str());
      return 2;
    }

    // compare the three pieces; first divergence localizes and fails the step
    bool scriptOk = true;
    const Value* steps = root.find("steps");
    for (size_t si = 0; si < answers.size(); si++) {
      const Value& step = steps->arr[si];
      for (const char* label : {"ret", "events", "digest"}) {
        const Value* exp = step.find(label);
        if (!exp) continue;
        Diff d = diff_val(*exp, *answers[si].find(label), label);
        if (d.differ) {
          scriptOk = false;
          if (spew++ < 20) {
            std::fprintf(stderr,
                         "FAIL %s  step %zu  op %s\n  piece %s  path %s\n  expected %s\n  actual   %s\n",
                         name.c_str(), si, step.find("op")->find("op")->str.c_str(), label,
                         d.path.c_str(), d.expected.c_str(), d.actual.c_str());
          }
          break;  // one divergence per step
        }
      }
      if (!scriptOk) break;  // stop the script at first bad step
    }
    if (scriptOk) scriptsPassed++;
  }

  std::printf("roomflow corpus: %d/%d scripts, %d/%d lowestFreeSlot cases passed\n",
              scriptsPassed, scripts, slotPassed, slotCases);
  return (scriptsPassed == scripts && slotPassed == slotCases) ? 0 : 1;
}
