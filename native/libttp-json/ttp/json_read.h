// json_read — THE shared field readers for JSON that crossed a boundary.
//
// Every C ABI in this tree takes plain data as JSON text and has to answer the
// same handful of questions about it: is this key present and a number, is it
// present and a string, is it JS-TRUTHY, and what does an unparseable payload
// fall back to. Before this header each ABI and each conformance check answered
// them with its own copy — runtime/ttp_ui.cc, runtime/ttp_party.cc,
// runtimetest/ui_check.cc, partytest/session_check.cc and two more, all
// copy-paste identical bar a name. That is the same shape testsupport/
// corpus_diff.h was pulled out of, and for the same reason: three hand-copied
// comparators had already drifted from each other. These readers had not drifted
// yet. The point is that they no longer can, and that the next ABI writes none
// of them.
//
// THE ONE RULE WORTH READING. `truthy` is JS truthiness, not a bool test, and
// that is load-bearing rather than convenient. Fields arriving here were written
// by JS and are read back into decisions the JS made with `if (x)`: a missing
// key, `false`, `0`, `""` and `null` are all false, and every other value —
// including `[]` and `{}` — is true. A C++ `v && v->b` would answer differently
// for `{"ready": 1}`, which the corpora contain.
//
// LIVES IN libttp-json, NOT testsupport, because half the callers SHIP: the C
// ABIs parse their arguments with exactly these readers. testsupport/ is for
// things only a check may link.
#pragma once

#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"

namespace ttp {
namespace json {

// ---- presence + type ---------------------------------------------------------
// `find` already returns nullptr for an absent OR present-but-undefined key, so
// every reader below takes the nullptr case as "the JS side sent nothing".

inline bool is_num(const Value* v) { return v && v->type == Value::NUM; }
inline bool is_str(const Value* v) { return v && v->type == Value::STR; }
inline bool is_arr(const Value* v) { return v && v->type == Value::ARR; }
inline bool is_obj(const Value* v) { return v && v->type == Value::OBJ; }

// JS truthiness. See the note up top before changing anything here.
inline bool truthy(const Value* v) {
  if (!v) return false;
  switch (v->type) {
    case Value::BOOL: return v->b;
    case Value::NUM: return v->num != 0 && v->num == v->num;   // NaN is falsy
    case Value::STR: return !v->str.empty();
    case Value::ARR:
    case Value::OBJ: return true;
    default: return false;                                     // undefined, null
  }
}

// ---- fields of an object -----------------------------------------------------
// A wrong-typed field reads as absent rather than as garbage: the ABI's contract
// is that it answers for any JSON its adapter can emit, and a shell that sends
// `{"laps": "3"}` gets the default, not a coerced 3. (JS coercion is NOT
// reproduced on purpose — where a specific export needs it, it says so and does
// it locally; session.h's `norm_index` is the one frozen case.)

inline bool truthy(const Value& o, const char* k) { return truthy(o.find(k)); }

inline double num_field(const Value& o, const char* k, double dflt = 0.0) {
  const Value* v = o.find(k);
  return is_num(v) ? v->num : dflt;
}

inline std::string str_field(const Value& o, const char* k,
                             const char* dflt = "") {
  const Value* v = o.find(k);
  return is_str(v) ? v->str : std::string(dflt);
}

// An array field as itself, or an empty array — so a caller can iterate without
// a null check.
inline Value arr_field(const Value& o, const char* k) {
  const Value* v = o.find(k);
  return is_arr(v) ? *v : Value::Arr();
}

// The numbers of an array field, skipping anything that is not one.
inline std::vector<double> num_list(const Value& o, const char* k) {
  std::vector<double> out;
  const Value* v = o.find(k);
  if (!is_arr(v)) return out;
  for (const Value& e : v->arr) {
    if (e.type == Value::NUM) out.push_back(e.num);
  }
  return out;
}

// The strings of an array field, same rule.
inline std::vector<std::string> str_list(const Value& o, const char* k) {
  std::vector<std::string> out;
  const Value* v = o.find(k);
  if (!is_arr(v)) return out;
  for (const Value& e : v->arr) {
    if (e.type == Value::STR) out.push_back(e.str);
  }
  return out;
}

// ---- whole payloads ----------------------------------------------------------

// The ABI's front door: parse an argument, or fall back. Null and empty text are
// the same thing as unparseable text here — an export must answer for all three
// rather than crash a shell that passed nothing.
inline Value parse_or(const char* json, Value fallback) {
  if (!json || !*json) return fallback;
  bool ok = false;
  Value v = parse(json, &ok);
  return ok ? v : fallback;
}

// ---- into a layer's own option types -----------------------------------------
// Each ported layer spells "a number that may be absent" in its own header
// (ui::OptNum, ui::OptStr, ui::Id) because the layers must not gain dependency
// edges on each other. The MAPPING from JSON is identical every time, so it is
// written once here and named by the caller's type:
//
//   e.cupDifficulty = json::opt_num<ui::OptNum>(v.find("cupDifficulty"));
//
// Opt must offer `Of(x)` and `None()`; Id must offer `Num(double)`, `Str(string)`
// and `None()`. Nothing else is assumed, and no layer's header is included here.

template <class Opt>
inline Opt opt_num(const Value* v) {
  return is_num(v) ? Opt::Of(v->num) : Opt::None();
}

template <class Opt>
inline Opt opt_str(const Value* v) {
  return is_str(v) ? Opt::Of(v->str) : Opt::None();
}

// A JS scalar id: `3` and `"3"` are DIFFERENT ids and must stay so all the way
// through (a peer index off the wire is a number, a bot's id is a string).
// Anything else — absent, null, an object — is no id at all.
template <class Id>
inline Id id_of(const Value* v) {
  if (is_num(v)) return Id::Num(v->num);
  if (is_str(v)) return Id::Str(v->str);
  return Id::None();
}

}  // namespace json
}  // namespace ttp
