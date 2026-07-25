// relay-framing conformance check — replays tests/fixtures/framing-corpus.jsonl
// (scripts/gen-framing-corpus.mjs, recorded by driving the real PartyConnection)
// against ttp::framing. Line 1 header; each further line is one op — encode /
// classify / close / backoff / pin — carrying its inputs and the recorded
// `expect`. Each drives the port from the inputs and compares to expect via the
// shared structural diff. First divergence localizes and fails; spew capped at 20.

#include <cstdio>
#include <fstream>
#include <string>

#include "json_check.h"
#include "ttp/relay_framing.h"

using namespace ttp;
using namespace ttp::jsoncheck;

static Value classifyToValue(const framing::Inbound& in) {
  Value o = Value::Obj();
  const char* route = in.route == framing::Inbound::MESSAGE ? "message"
                    : in.route == framing::Inbound::STATE   ? "state"
                                                            : "protocol";
  o.set("route", Value::Str(route));
  if (in.route == framing::Inbound::MESSAGE) {
    o.set("from", in.from);  // UNDEF drops under canonical compare
    o.set("data", in.data);
  } else if (in.route == framing::Inbound::STATE) {
    o.set("data", in.data);
  } else {
    o.set("type", in.type);
    o.set("msg", in.msg);
  }
  return o;
}

static Value closeToValue(const framing::CloseOutcome& c) {
  Value o = Value::Obj();
  o.set("stopReconnect", Value::Bool(c.stopReconnect));
  o.set("closeAttempt", Value::Num(c.closeAttempt));
  o.set("closeMax", Value::Num(c.closeMax));
  o.set("meta", c.meta);
  o.set("willReconnect", Value::Bool(c.willReconnect));
  return o;
}

int main(int argc, char** argv) {
  if (argc != 2) { std::fprintf(stderr, "usage: framing_check <framing-corpus.jsonl>\n"); return 2; }
  std::ifstream in(argv[1]);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }

  std::string line;
  if (!std::getline(in, line)) { std::fprintf(stderr, "empty corpus\n"); return 2; }  // header

  int cases = 0, passed = 0, spew = 0;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    JV root;
    if (!parseLine(line, root)) { std::fprintf(stderr, "parse error on op line\n"); return 2; }
    const std::string& op = root.get("op")->str;
    const JV* expect = root.get("expect");

    Value got;
    std::string label = op;

    if (op == "encode") {
      const std::string& kind = root.get("kind")->str;
      label = "encode:" + kind;
      if (kind == "create") {
        std::string url;
        bool hasUrl = root.has("url");
        if (hasUrl) url = root.get("url")->str;
        got = framing::encode_create(root.get("clientId")->str, root.get("maxClients")->num,
                                     hasUrl ? &url : nullptr);
      } else if (kind == "join") {
        got = framing::encode_join(root.get("clientId")->str, root.get("room")->str);
      } else if (kind == "sendTo") {
        got = framing::encode_send_to(jvToValue(*root.get("to")), jvToValue(*root.get("data")));
      } else if (kind == "broadcast") {
        got = framing::encode_broadcast(jvToValue(*root.get("data")));
      } else if (kind == "setState") {
        got = framing::encode_set_state(jvToValue(*root.get("data")));
      } else if (kind == "closeRoom") {
        got = framing::encode_close_room();
      } else {
        std::fprintf(stderr, "unknown encode kind '%s'\n", kind.c_str());
        return 2;
      }
    } else if (op == "classify") {
      got = classifyToValue(framing::classify_inbound(jvToValue(*root.get("wire"))));
    } else if (op == "close") {
      const JV* codeJV = root.get("code");
      got = closeToValue(framing::close_outcome(
          root.get("hasCode")->b, codeJV && codeJV->t == JV::NUM ? codeJV->num : 0.0,
          root.get("attemptBefore")->num, root.get("maxAttempts")->num,
          root.get("shouldReconnectBefore")->b));
    } else if (op == "backoff") {
      got = Value::Num(framing::backoff_delay_ms(root.get("attempt")->num));
    } else if (op == "pin") {
      const JV* instJV = root.get("instance");
      std::string inst = (instJV && instJV->t == JV::STR) ? instJV->str : "";
      got = Value::Str(framing::pin_instance_url(root.get("base")->str, root.get("room")->str, inst));
    } else {
      std::fprintf(stderr, "unknown op '%s'\n", op.c_str());
      return 2;
    }

    cases++;
    Diff d = diffVal(*expect, got, label);
    if (d.differ) {
      if (spew++ < 20) {
        std::fprintf(stderr, "FAIL %s  path %s\n  expected %s\n  actual   %s\n",
                     label.c_str(), d.path.c_str(), d.expected.c_str(), d.actual.c_str());
      }
    } else {
      passed++;
    }
  }

  std::printf("framing corpus: %d/%d cases passed\n", passed, cases);
  return passed == cases ? 0 : 1;
}
