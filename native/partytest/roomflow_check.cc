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

#include "json_check.h"   // JV/JParse reader, canonJV, structural diffVal
#include "ttp/canonical.h"
#include "ttp/jsonnum.h"
#include "ttp/room_flow.h"

using namespace ttp;
using namespace ttp::jsoncheck;

// ---------------------------------------------------------------------------
// JV -> port types.
// ---------------------------------------------------------------------------
static PeerId peerFromJV(const JV& v) {
  if (v.t == JV::NUM) return PeerId::Num(v.num);
  if (v.t == JV::STR) return PeerId::Str(v.str);
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
    JV root;
    if (!parseLine(line, root)) { std::fprintf(stderr, "parse error on script line\n"); return 2; }

    // lowestFreeSlot cases are their own line kind (no RoomFlow instance).
    if (const JV* sc = root.get("slotCase")) {
      std::vector<double> used;
      if (const JV* u = sc->get("used")) for (const JV& e : u->arr) used.push_back(e.num);
      const int max = static_cast<int>(sc->get("max")->num);
      const int want = static_cast<int>(sc->get("expect")->num);
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
    std::string name = root.get("name")->str;

    // ---- build the RoomFlow from config -------------------------------------
    const JV* cfgJV = root.get("config");
    RoomFlow::Config cfg;
    cfg.hasMasterProvider = cfgJV->get("useMasterProvider")->b;
    const JV* masterJV = cfgJV->get("master");
    cfg.master = masterJV ? peerFromJV(*masterJV) : PeerId::None();
    const JV* livJV = cfgJV->get("liveness");
    if (livJV && livJV->t == JV::OBJ) {
      cfg.hasLiveness = true;
      if (const JV* x = livJV->get("timeoutMs")) cfg.timeoutMs = x->num;
      if (const JV* x = livJV->get("graceMs")) cfg.graceMs = x->num;
      if (const JV* x = livJV->get("useEnabledProvider")) cfg.hasEnabledProvider = x->b;
    }

    std::vector<std::pair<std::string, Value>> captured;
    RoomFlow flow(cfg, [&](const std::string& type, const Value& detail) {
      captured.emplace_back(type, detail);
    });

    PeerSet peers;
    bool scriptOk = true;
    const JV* steps = root.get("steps");
    for (size_t si = 0; si < steps->arr.size(); si++) {
      const JV& step = steps->arr[si];
      const JV& op = *step.get("op");
      const std::string& opName = op.get("op")->str;
      // accumulate peer ids for the digest (before applying, as the generator does)
      for (const char* k : {"p", "oldId", "newId"})
        if (const JV* x = op.get(k)) peers.add(peerFromJV(*x));

      captured.clear();
      Value ret = Value::Null();

      if (opName == "add") {
        std::vector<std::pair<std::string, Value>> fields;
        if (const JV* f = op.get("fields"))
          for (auto& kv : f->obj) fields.emplace_back(kv.first, jvToValue(kv.second));
        const Player* p = flow.addPlayer(peerFromJV(*op.get("p")), fields);
        ret = p->toValue();
      } else if (opName == "remove") {
        flow.removePlayer(peerFromJV(*op.get("p")));
      } else if (opName == "rekey") {
        ret = Value::Bool(flow.rekey(peerFromJV(*op.get("oldId")), peerFromJV(*op.get("newId"))));
      } else if (opName == "markDisc") {
        flow.markDisconnected(peerFromJV(*op.get("p")));
      } else if (opName == "markReconn") {
        flow.markReconnected(peerFromJV(*op.get("p")));
      } else if (opName == "clearDisc") {
        const JV* t = op.get("t");
        flow.clearDisconnected(t != nullptr, t ? t->num : 0);
      } else if (opName == "transition") {
        ret = Value::Bool(flow.transitionTo(op.get("to")->str));
      } else if (opName == "endGame") {
        ret = Value::Bool(flow.endGame());
      } else if (opName == "returnToLobby") {
        ret = Value::Bool(flow.returnToLobby());
      } else if (opName == "setOrder") {
        std::vector<PeerId> ord;
        if (const JV* o = op.get("order")) for (auto& e : o->arr) ord.push_back(peerFromJV(e));
        flow.setActiveOrder(ord);
      } else if (opName == "seen") {
        flow.onSeen(peerFromJV(*op.get("p")), op.get("t")->num);
      } else if (opName == "isExpired") {
        ret = Value::Bool(flow.isExpired(peerFromJV(*op.get("p")), op.get("t")->num));
      } else if (opName == "expiredPeers") {
        Value a = Value::Arr();
        for (const PeerId& p : flow.expiredPeers(op.get("t")->num)) a.push(p.toValue());
        ret = std::move(a);
      } else if (opName == "graceTick") {
        ret = Value::Bool(flow.graceTick(op.get("t")->num));
      } else if (opName == "setMaster") {
        flow.setMasterValue(peerFromJV(*op.get("v")));
      } else if (opName == "setLivenessEnabled") {
        flow.setLivenessEnabled(op.get("v")->b);
      } else if (opName == "setField") {
        // The live-record write the display does directly on the kit's mutable
        // record; behind an ABI it is a setter. Emits nothing, kit keys refused.
        const std::string& key = op.get("key")->str;
        Value v = jvToValue(*op.get("value"));
        const bool ok = flow.setField(peerFromJV(*op.get("p")), key, v);
        if (ok) {
          const Player* p2 = flow.get(peerFromJV(*op.get("p")));
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
      struct Piece { const char* label; const JV* exp; const Value* act; };
      const JV* expEvents = step.get("events");
      const JV* expDigest = step.get("digest");
      const JV* expRet = step.get("ret");
      Piece pieces[3] = {
        {"ret", expRet, &ret}, {"events", expEvents, &events}, {"digest", expDigest, &digest}};
      for (const Piece& pc : pieces) {
        if (!pc.exp) continue;
        Diff d = diffVal(*pc.exp, *pc.act, pc.label);
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
