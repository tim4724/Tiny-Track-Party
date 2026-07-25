// corpus_diff — THE shared corpus-replay machinery for every conformance check
// in this tree (mathlib/tracktest/simtest/partytest/replay). Two jobs:
//
//   read_line()  one JSONL line -> ttp::Value, via the single parser
//                (ttp/json_parse.h — the same one the C ABIs use).
//   diff_val()   structural first-divergence between the RECORDED side and the
//                PORT's side, localized to a field path, both sides rendered as
//                canonical JSON.
//
// Both sides are ttp::Value, so there is ONE parser and ONE comparator in the
// build. This matters more than the line count: the comparator decides pass/fail
// for the whole conformance scheme, and the three hand-copied versions that
// preceded this header had already drifted (two of them truncated \uXXXX escapes
// to a single byte where the third encoded UTF-8 — harmless only because every
// id on the byte path happens to be ASCII).
//
// Numbers compare through js_number_to_string, so a recorded decimal matches iff
// it round-trips to the same double (double-conversion == JSON.stringify).
//
// DELIBERATELY NOT USED BY three checks: mathlib/corpus_check, tracktest/
// sampler_check and simtest/serializer_check read corpora whose payload is hex
// BIT PATTERNS, not JSON trees, and they scan the few fields they need with a
// substring reader. mathlib_corpus_check in particular must keep linking nothing
// but ttp_mathlib — it is the check that proves the math library alone, so it does
// not get to depend on the JSON layer.
#pragma once

#include <algorithm>
#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/jsonnum.h"

namespace ttp {
namespace corpus {

// Parse one corpus line, with STRICT number checking: every token must reformat
// to itself, so correctly-rounded strtod is proven per value rather than assumed
// (the numbers are the evidence in a conformance corpus). Returns false — with
// `err` filled where the parser can be precise — on malformed input; corpus files
// are our own JSON.stringify output, so a failure means damage, not exotic input.
inline bool read_line(const std::string& line, Value& out, std::string* err = nullptr) {
  json::Parser p(line, json::STRICT_NUMBERS);
  if (p.parse(out)) return true;
  if (err) *err = p.error().empty() ? "parse error" : p.error();
  return false;
}

// ---- structural first-diff ---------------------------------------------------

struct Diff {
  bool differ = false;
  std::string path, expected, actual;
};

inline std::string type_name(const Value& v) {
  switch (v.type) {
    case Value::NUL:
    case Value::UNDEF: return "null";   // JS: an absent/undefined leaf reads as null
    case Value::BOOL: return "bool";
    case Value::NUM: return "num";
    case Value::STR: return "str";
    case Value::ARR: return "arr";
    case Value::OBJ: return "obj";
  }
  return "?";
}

inline Diff mismatch(const Value& e, const Value& a, const std::string& path) {
  return {true, path, canonical_stringify(e), canonical_stringify(a)};
}

// First divergence between `expected` (recorded) and `actual` (the port), in
// canonical key order so the reported path is stable across runs.
inline Diff diff_val(const Value& e, const Value& a, const std::string& path) {
  const std::string te = type_name(e), ta = type_name(a);
  if (te != ta) return mismatch(e, a, path);
  if (te == "num") {
    if (js_number_to_string(e.num) != js_number_to_string(a.num)) return mismatch(e, a, path);
    return {};
  }
  if (te == "bool") return e.b != a.b ? mismatch(e, a, path) : Diff{};
  if (te == "str") return e.str != a.str ? mismatch(e, a, path) : Diff{};
  if (te == "null") return {};
  if (te == "arr") {
    const size_t n = std::min(e.arr.size(), a.arr.size());
    for (size_t i = 0; i < n; i++) {
      Diff d = diff_val(e.arr[i], a.arr[i], path + "[" + std::to_string(i) + "]");
      if (d.differ) return d;
    }
    if (e.arr.size() != a.arr.size())
      return {true, path + ".length", std::to_string(e.arr.size()), std::to_string(a.arr.size())};
    return {};
  }
  // Objects: union of both key sets (undefined-valued keys excluded, exactly as
  // canonical_stringify excludes them), walked sorted.
  std::vector<std::string> keys;
  const auto add = [&keys](const Value& v) {
    for (const auto& kv : v.obj) {
      if (kv.second.type == Value::UNDEF) continue;
      if (std::find(keys.begin(), keys.end(), kv.first) == keys.end()) keys.push_back(kv.first);
    }
  };
  add(e);
  add(a);
  std::sort(keys.begin(), keys.end());
  for (const std::string& k : keys) {
    const Value* ec = e.find(k);
    const Value* ac = a.find(k);
    const std::string cp = path.empty() ? k : path + "." + k;
    if (!ec) return {true, cp, "<absent>", ac ? canonical_stringify(*ac) : "<absent>"};
    if (!ac) return {true, cp, canonical_stringify(*ec), "<absent>"};
    Diff d = diff_val(*ec, *ac, cp);
    if (d.differ) return d;
  }
  return {};
}

}  // namespace corpus
}  // namespace ttp
