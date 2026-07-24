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

#include "ttp/canonical.h"
#include "ttp/jsonnum.h"
#include "ttp/room_flow.h"

using namespace ttp;

// ---------------------------------------------------------------------------
// Minimal JSON reader (structural; numbers via strtod).
// ---------------------------------------------------------------------------
struct JV {
  enum T { OBJ, ARR, STR, NUM, BOOL, NUL } t = NUL;
  std::vector<std::pair<std::string, JV>> obj;
  std::vector<JV> arr;
  std::string str;
  double num = 0;
  bool b = false;
  const JV* get(const char* key) const {
    for (auto& kv : obj) if (kv.first == key) return &kv.second;
    return nullptr;
  }
  bool has(const char* key) const { return get(key) != nullptr; }
};

struct JParse {
  const std::string& s;
  size_t p = 0;
  explicit JParse(const std::string& src) : s(src) {}
  void ws() { while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == '\n' || s[p] == '\r')) p++; }
  bool str(std::string& out) {
    if (s[p] != '"') return false;
    p++;
    out.clear();
    while (p < s.size()) {
      char c = s[p++];
      if (c == '"') return true;
      if (c == '\\') {
        char e = s[p++];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            int v = 0;
            for (int i = 0; i < 4; i++) {
              char h = s[p++]; v <<= 4;
              if (h >= '0' && h <= '9') v |= h - '0';
              else if (h >= 'a' && h <= 'f') v |= h - 'a' + 10;
              else if (h >= 'A' && h <= 'F') v |= h - 'A' + 10;
            }
            out += (char)v;
            break;
          }
          default: out += e;
        }
      } else out += c;
    }
    return false;
  }
  bool value(JV& v) {
    ws();
    if (p >= s.size()) return false;
    char c = s[p];
    if (c == '{') {
      v.t = JV::OBJ; p++; ws();
      if (s[p] == '}') { p++; return true; }
      while (true) {
        ws();
        std::string key;
        if (!str(key)) return false;
        ws();
        if (s[p] != ':') return false;
        p++;
        JV child;
        if (!value(child)) return false;
        v.obj.emplace_back(std::move(key), std::move(child));
        ws();
        if (s[p] == ',') { p++; continue; }
        if (s[p] == '}') { p++; return true; }
        return false;
      }
    }
    if (c == '[') {
      v.t = JV::ARR; p++; ws();
      if (s[p] == ']') { p++; return true; }
      while (true) {
        JV child;
        if (!value(child)) return false;
        v.arr.push_back(std::move(child));
        ws();
        if (s[p] == ',') { p++; continue; }
        if (s[p] == ']') { p++; return true; }
        return false;
      }
    }
    if (c == '"') { v.t = JV::STR; return str(v.str); }
    if (c == 't') { v.t = JV::BOOL; v.b = true; p += 4; return true; }
    if (c == 'f') { v.t = JV::BOOL; v.b = false; p += 5; return true; }
    if (c == 'n') { v.t = JV::NUL; p += 4; return true; }
    v.t = JV::NUM;
    size_t start = p;
    while (p < s.size() && (std::isdigit((unsigned char)s[p]) || s[p] == '-' || s[p] == '+' ||
                            s[p] == '.' || s[p] == 'e' || s[p] == 'E')) p++;
    v.num = std::strtod(s.substr(start, p - start).c_str(), nullptr);
    return true;
  }
};

static bool parseLine(const std::string& line, JV& out) {
  JParse jp(line);
  return jp.value(out);
}

// ---------------------------------------------------------------------------
// Canonical stringify of a parsed JV (the expected/recorded side).
// ---------------------------------------------------------------------------
static std::string canonJV(const JV& v) {
  switch (v.t) {
    case JV::NUL: return "null";
    case JV::BOOL: return v.b ? "true" : "false";
    case JV::NUM: return js_number_to_string(v.num);
    case JV::STR: return json_quote(v.str);
    case JV::ARR: {
      std::string o = "[";
      for (size_t i = 0; i < v.arr.size(); i++) { if (i) o += ","; o += canonJV(v.arr[i]); }
      return o + "]";
    }
    case JV::OBJ: {
      std::vector<const std::pair<std::string, JV>*> kept;
      for (auto& kv : v.obj) kept.push_back(&kv);
      std::sort(kept.begin(), kept.end(), [](auto* a, auto* b) { return a->first < b->first; });
      std::string o = "{";
      for (size_t i = 0; i < kept.size(); i++) {
        if (i) o += ",";
        o += json_quote(kept[i]->first) + ":" + canonJV(kept[i]->second);
      }
      return o + "}";
    }
  }
  return "null";
}

// ---------------------------------------------------------------------------
// Structural first-diff: recorded JV (expected) vs port Value (actual). Returns
// the first divergent path in canonical (sorted-key) order. Mirrors replay_cli.
// ---------------------------------------------------------------------------
struct Diff { bool differ = false; std::string path, expected, actual; };

static std::string valType(const Value& v) {
  switch (v.type) {
    case Value::NUL: case Value::UNDEF: return "null";
    case Value::BOOL: return "bool"; case Value::NUM: return "num";
    case Value::STR: return "str"; case Value::ARR: return "arr"; case Value::OBJ: return "obj";
  }
  return "?";
}
static std::string jvType(const JV& v) {
  switch (v.t) {
    case JV::NUL: return "null"; case JV::BOOL: return "bool"; case JV::NUM: return "num";
    case JV::STR: return "str"; case JV::ARR: return "arr"; case JV::OBJ: return "obj";
  }
  return "?";
}
static Diff leafMismatch(const JV& e, const Value& a, const std::string& path) {
  return {true, path, canonJV(e), canonical_stringify(a)};
}
static Diff diffVal(const JV& e, const Value& a, const std::string& path) {
  std::string te = jvType(e), ta = valType(a);
  if (te != ta) return leafMismatch(e, a, path);
  if (te == "num") {
    if (js_number_to_string(e.num) != js_number_to_string(a.num)) return leafMismatch(e, a, path);
    return {};
  }
  if (te == "bool") { if (e.b != a.b) return leafMismatch(e, a, path); return {}; }
  if (te == "str") { if (e.str != a.str) return leafMismatch(e, a, path); return {}; }
  if (te == "null") return {};
  if (te == "arr") {
    size_t n = std::min(e.arr.size(), a.arr.size());
    for (size_t i = 0; i < n; i++) {
      Diff d = diffVal(e.arr[i], a.arr[i], path + "[" + std::to_string(i) + "]");
      if (d.differ) return d;
    }
    if (e.arr.size() != a.arr.size())
      return {true, path + ".length", std::to_string(e.arr.size()), std::to_string(a.arr.size())};
    return {};
  }
  std::vector<std::string> keys;
  for (auto& kv : e.obj) keys.push_back(kv.first);
  for (auto& kv : a.obj) if (kv.second.type != Value::UNDEF) {
    bool seen = false; for (auto& k : keys) if (k == kv.first) { seen = true; break; }
    if (!seen) keys.push_back(kv.first);
  }
  std::sort(keys.begin(), keys.end());
  for (const std::string& k : keys) {
    const JV* ec = e.get(k.c_str());
    const Value* ac = nullptr;
    for (auto& kv : a.obj) if (kv.first == k && kv.second.type != Value::UNDEF) { ac = &kv.second; break; }
    std::string cp = path.empty() ? k : path + "." + k;
    if (!ec) return {true, cp, "<absent>", ac ? canonical_stringify(*ac) : "<absent>"};
    if (!ac) return {true, cp, canonJV(*ec), "<absent>"};
    Diff d = diffVal(*ec, *ac, cp);
    if (d.differ) return d;
  }
  return {};
}

// ---------------------------------------------------------------------------
// JV -> port types.
// ---------------------------------------------------------------------------
static PeerId peerFromJV(const JV& v) {
  if (v.t == JV::NUM) return PeerId::Num(v.num);
  if (v.t == JV::STR) return PeerId::Str(v.str);
  return PeerId::None();
}
static Value jvToValue(const JV& v) {
  switch (v.t) {
    case JV::NUL: return Value::Null();
    case JV::BOOL: return Value::Bool(v.b);
    case JV::NUM: return Value::Num(v.num);
    case JV::STR: return Value::Str(v.str);
    case JV::ARR: {
      Value o = Value::Arr();
      for (auto& e : v.arr) o.push(jvToValue(e));
      return o;
    }
    case JV::OBJ: {
      Value o = Value::Obj();
      for (auto& kv : v.obj) o.set(kv.first, jvToValue(kv.second));
      return o;
    }
  }
  return Value::Null();
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
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    JV root;
    if (!parseLine(line, root)) { std::fprintf(stderr, "parse error on script line\n"); return 2; }
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

  std::printf("roomflow corpus: %d/%d scripts passed\n", scriptsPassed, scripts);
  return scriptsPassed == scripts ? 0 : 1;
}
