// fastlane netcode conformance check — replays tests/fixtures/fastlane-corpus.jsonl
// (scripts/gen-fastlane-corpus.mjs, recorded by driving the REAL PartyFastlane
// with a controlled clock + fake DataChannel) against ttp::fastlane::Link.
//
// Line 1 is a header carrying the netcode constants (asserted against the port's
// own, so a drifted TTL/alpha fails loudly rather than silently). Each further
// line is one scripted link: {name, config, steps:[{op, ret, sent, applied, rtt,
// digest}]}. Per step it applies the op at the recorded clock and demands the
// port reproduce the enqueue return, the packet written, the events applied, the
// RTT sample, and the full link-state digest — compared as canonical JSON.
// First divergent piece prints script/step/op + expected-vs-got; spew capped at 20.

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

#include "corpus_diff.h"
#include "ttp/fastlane.h"

using namespace ttp;
using namespace ttp::fastlane;
using namespace ttp::corpus;

static Value digestOf(const Link& link) {
  Value d = Value::Obj();
  d.set("eventSeq", Value::Num(link.eventSeq()));
  Value ring = Value::Arr();
  for (const RingEntry& e : link.ring()) {
    Value r = Value::Obj();
    r.set("es", Value::Num(e.es));
    r.set("expires", Value::Num(e.expires));
    ring.push(std::move(r));
  }
  d.set("ring", std::move(ring));
  d.set("lastAckedEs", Value::Num(link.lastAckedEs()));
  d.set("lastAppliedEs", Value::Num(link.lastAppliedEs()));
  d.set("srtt", Value::Num(link.srtt()));
  d.set("out", Value::Num(link.stats().out));
  d.set("received", Value::Num(link.stats().received));
  d.set("lastPsSeen", Value::Num(link.stats().lastPsSeen));
  return d;
}

int main(int argc, char** argv) {
  if (argc != 2) { std::fprintf(stderr, "usage: fastlane_check <fastlane-corpus.jsonl>\n"); return 2; }
  std::ifstream in(argv[1]);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }

  std::string line;
  if (!std::getline(in, line)) { std::fprintf(stderr, "empty corpus\n"); return 2; }

  // ---- header: the recorded netcode constants must match the port's ----------
  {
    Value h;
    if (!read_line(line, h)) { std::fprintf(stderr, "parse error on header\n"); return 2; }
    struct K { const char* key; double ours; };
    const K keys[] = {
        {"TTL_MS", TTL_MS}, {"TICK_MS", TICK_MS}, {"IDLE_MS", IDLE_MS},
        {"WATCHDOG_MS", WATCHDOG_MS}, {"RTT_ALPHA", RTT_ALPHA},
    };
    for (const K& k : keys) {
      const Value* v = h.find(k.key);
      if (!v || v->type != Value::NUM || js_number_to_string(v->num) != js_number_to_string(k.ours)) {
        std::fprintf(stderr, "FAIL header %s: corpus %s, port %s\n", k.key,
                     v ? canonical_stringify(*v).c_str() : "<absent>", js_number_to_string(k.ours).c_str());
        return 1;
      }
    }
  }

  int scripts = 0, scriptsPassed = 0, spew = 0;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    if (!read_line(line, root)) { std::fprintf(stderr, "parse error on script line\n"); return 2; }
    scripts++;
    const std::string& name = root.find("name")->str;

    Link link;
    bool scriptOk = true;
    const Value* steps = root.find("steps");
    for (size_t si = 0; si < steps->arr.size(); si++) {
      const Value& step = steps->arr[si];
      const Value& op = *step.find("op");
      const std::string& opName = op.find("op")->str;
      const double t = op.find("t")->num;   // the clock for this op

      Outcome oc;
      Value ret = Value::Null();
      if (opName == "enqueue") {
        oc = link.enqueue(*op.find("ev"), t);
        ret = Value::Str(oc.dropped ? "dropped" : "p2p");
      } else if (opName == "sendTick") {
        oc = link.sendDataPacket(t);
      } else if (opName == "idle") {
        oc = link.sendIdleHeartbeat(t);
      } else if (opName == "recv") {
        oc = link.handleInbound(*op.find("packet"), t);
      } else if (opName == "closeChannel") {
        link.setChannelOpen(false);
      } else {
        std::fprintf(stderr, "FAIL %s step %zu: unknown op '%s'\n", name.c_str(), si, opName.c_str());
        return 2;
      }

      Value sent = oc.sent ? oc.packet : Value::Null();
      Value applied = Value::Arr();
      for (const Value& ev : oc.applied) applied.push(ev);
      Value rtt = oc.hasRtt ? Value::Num(oc.rtt) : Value::Null();
      Value digest = digestOf(link);

      struct Piece { const char* label; const Value* exp; const Value* act; };
      const Piece pieces[5] = {
          {"ret", step.find("ret"), &ret},
          {"sent", step.find("sent"), &sent},
          {"applied", step.find("applied"), &applied},
          {"rtt", step.find("rtt"), &rtt},
          {"digest", step.find("digest"), &digest},
      };
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
      if (!scriptOk) break;
    }
    if (scriptOk) scriptsPassed++;
  }

  std::printf("fastlane corpus: %d/%d scripts passed\n", scriptsPassed, scripts);
  return scriptsPassed == scripts ? 0 : 1;
}
