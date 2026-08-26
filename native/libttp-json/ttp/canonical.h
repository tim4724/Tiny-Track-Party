// Canonical JSON + FNV-1a — the digest format every corpus and trace is written
// in (docs/native-port/fp-profile.md §4). A small tagged Value union stands
// in for the plain-data snapshot/event trees; canonical_stringify walks it with a
// recursive key sort and shortest-form numbers (ttp/jsonnum.h), byte-identical to
// JSON.stringify-with-sorted-keys. fnv1a hashes the UTF-8 bytes of that string.
//
// Key ordering: JS Array.prototype.sort() orders by UTF-16 code unit; every key on
// the sim path is ASCII, so a plain std::string byte compare is identical.
#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace ttp {

struct Value {
  enum Type { UNDEF, NUL, BOOL, NUM, STR, ARR, OBJ };
  Type type = UNDEF;
  bool b = false;
  double num = 0.0;
  std::string str;
  std::vector<Value> arr;
  std::vector<std::pair<std::string, Value>> obj;

  static Value Null() { Value v; v.type = NUL; return v; }
  static Value Bool(bool x) { Value v; v.type = BOOL; v.b = x; return v; }
  static Value Num(double x) { Value v; v.type = NUM; v.num = x; return v; }
  static Value Str(std::string s) { Value v; v.type = STR; v.str = std::move(s); return v; }
  static Value Arr() { Value v; v.type = ARR; return v; }
  static Value Obj() { Value v; v.type = OBJ; return v; }

  // Object member lookup; nullptr when the key is absent OR present-but-undefined
  // (the two are indistinguishable in JS, and canonical_stringify drops both).
  const Value* find(const std::string& key) const {
    for (const auto& kv : obj)
      if (kv.first == key && kv.second.type != UNDEF) return &kv.second;
    return nullptr;
  }
  bool has(const std::string& key) const { return find(key) != nullptr; }

  // Array append.
  void push(Value x) { arr.push_back(std::move(x)); }
  // Object set (insertion order irrelevant — canonical_stringify sorts keys). A
  // value of type UNDEF is dropped at stringify time, mirroring JS `v[k] !== undefined`.
  // JS assignment semantics: an existing key is REPLACED in place (its
  // position kept), a new one appended. The old blind emplace_back silently
  // duplicated the key when a parsed object was repaired — and find() then
  // answered the stale first copy, which bit both walk-side field repairs.
  void set(std::string key, Value x) {
    for (auto& kv : obj) {
      if (kv.first == key) { kv.second = std::move(x); return; }
    }
    obj.emplace_back(std::move(key), std::move(x));
  }
};

// JSON.stringify with a recursive key sort and shortest-form numbers.
std::string canonical_stringify(const Value& v);

// Same bytes, appended into a caller-owned buffer (cleared first). The ABI's
// per-handle scratch string reuses its capacity across frames, so the readback
// path allocates nothing steady-state.
void canonical_stringify_into(const Value& v, std::string& out);

// JSON.stringify with NO key sort — each object's own INSERTION order, which for
// a parsed tree is the order it was read in. Everything else is identical
// (undefined dropped, shortest-form numbers, the same escaping), so the two
// share one walker.
//
// WHEN TO USE WHICH, and it is not a taste question. canonical_stringify is the
// default and is what every ABI return and every outbound frame is emitted with:
// it is also for EVIDENCE — every corpus digest, every recorded frame hash and
// every readback whose bytes are compared to a fixture depends on the sort — so
// it must never grow an ordering mode.
//
// This one has ONE caller: the glTF document libttp-runtime/ttp/glb.cc rewrites.
// cgltf reads a glTF's keys in any order, so the sort would buy nothing and cost
// the only thing that makes that rewrite debuggable — a readable diff of the
// source chunk against the re-emitted one. (It also served the standings board,
// on the theory that the board's key order was the wire's. It was not: the frame
// encoder canonicalizes, so the model order stopped at framing.)
//
// Note what neither emitter touches: ARRAY order. An answer whose order matters
// because it is a LIST needs nothing from this one.
std::string ordered_stringify(const Value& v);

// JSON string escaping identical to JSON.stringify's QuoteJSONString: escapes
// " \ and control chars (\b \t \n \f \r, else \u00XX lowercase), passes bytes
// >= 0x20 through verbatim (no forward-slash escaping, no non-ASCII escaping).
std::string json_quote(const std::string& s);

// 32-bit FNV-1a over UTF-8 bytes, lowercase 8-hex (record-trace.mjs fnv1a).
// h *= prime on uint32_t wraps exactly like Math.imul.
uint32_t fnv1a(const std::string& utf8);
std::string fnv1a_hex(const std::string& utf8);

}  // namespace ttp
