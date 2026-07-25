// RoomFlow conformance check — replays tests/fixtures/roomflow-corpus.jsonl (the
// behavioural oracle from scripts/gen-roomflow-corpus.mjs) against the C++
// libttp-party RoomFlow port. Line 1 is a header {scripts,events}; each further
// line is one scripted run: {name, config, steps:[{op, ret, events, digest}...]}.
//
// For every step it builds the RoomFlow from config (masterProvider/enabledProvider
// modeled as settable values driven by setMaster/setLivenessEnabled ops), applies
// the op, and demands the port reproduce ret + the events emitted during that op
// (exact order + detail) + a public-surface digest — compared as canonical JSON.
// First divergent piece prints script/step/op + expected-vs-got; spew capped at 20.

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

#include "corpus_diff.h"   // read_line + the shared structural diff_val
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
  d.set("hasLateJoiners", Value::Bool(flow.hasLateJoiners()));
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
int main(int argc, char** argv) {
  if (argc != 2) { std::fprintf(stderr, "usage: roomflow_check <roomflow-corpus.jsonl>\n"); return 2; }
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
    std::string name = root.find("name")->str;

    // ---- build the RoomFlow from config -------------------------------------
    const Value* cfgV = root.find("config");
    RoomFlow::Config cfg;
    cfg.hasMasterProvider = cfgV->find("useMasterProvider")->b;
    const Value* masterV = cfgV->find("master");
    cfg.master = masterV ? peerFrom(*masterV) : PeerId::None();
    const Value* livV = cfgV->find("liveness");
    if (livV && livV->type == Value::OBJ) {
      cfg.hasLiveness = true;
      if (const Value* x = livV->find("timeoutMs")) cfg.timeoutMs = x->num;
      if (const Value* x = livV->find("graceMs")) cfg.graceMs = x->num;
      if (const Value* x = livV->find("useEnabledProvider")) cfg.hasEnabledProvider = x->b;
    }

    std::vector<std::pair<std::string, Value>> captured;
    RoomFlow flow(cfg, [&](const std::string& type, const Value& detail) {
      captured.emplace_back(type, detail);
    });

    PeerSet peers;
    bool scriptOk = true;
    const Value* steps = root.find("steps");
    for (size_t si = 0; si < steps->arr.size(); si++) {
      const Value& step = steps->arr[si];
      const Value& op = *step.find("op");
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
      } else if (opName == "clearDisc") {
        const Value* t = op.find("t");
        flow.clearDisconnected(t != nullptr, t ? t->num : 0);
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
      } else if (opName == "seen") {
        flow.onSeen(peerFrom(*op.find("p")), op.find("t")->num);
      } else if (opName == "isExpired") {
        ret = Value::Bool(flow.isExpired(peerFrom(*op.find("p")), op.find("t")->num));
      } else if (opName == "expiredPeers") {
        Value a = Value::Arr();
        for (const PeerId& p : flow.expiredPeers(op.find("t")->num)) a.push(p.toValue());
        ret = std::move(a);
      } else if (opName == "graceTick") {
        ret = Value::Bool(flow.graceTick(op.find("t")->num));
      } else if (opName == "setMaster") {
        flow.setMasterValue(peerFrom(*op.find("v")));
      } else if (opName == "setLivenessEnabled") {
        flow.setLivenessEnabled(op.find("v")->b);
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
        std::fprintf(stderr, "FAIL %s step %zu: unknown op '%s'\n", name.c_str(), si, opName.c_str());
        return 2;
      }

      // events emitted during this op, in order
      Value events = Value::Arr();
      for (auto& ev : captured) {
        Value e = Value::Obj();
        e.set("type", Value::Str(ev.first));
        e.set("detail", ev.second);
        events.push(std::move(e));
      }
      Value digest = buildDigest(flow, peers);

      // compare the three pieces; first divergence localizes and fails the step
      struct Piece { const char* label; const Value* exp; const Value* act; };
      const Value* expEvents = step.find("events");
      const Value* expDigest = step.find("digest");
      const Value* expRet = step.find("ret");
      Piece pieces[3] = {
        {"ret", expRet, &ret}, {"events", expEvents, &events}, {"digest", expDigest, &digest}};
      for (const Piece& pc : pieces) {
        if (!pc.exp) continue;
        Diff d = diff_val(*pc.exp, *pc.act, pc.label);
        if (d.differ) {
          scriptOk = false;
          if (spew++ < 20) {
            std::fprintf(stderr,
                         "FAIL %s  step %zu  op %s\n  piece %s  path %s\n  expected %s\n  actual   %s\n",
                         name.c_str(), si, opName.c_str(), pc.label, d.path.c_str(),
                         d.expected.c_str(), d.actual.c_str());
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
