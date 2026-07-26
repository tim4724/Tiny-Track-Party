// ScalarId — the identity that crosses every ABI: a JSON scalar that is either a
// number (a peerIndex) or a string ('cpu-bolt'), with null/absent as a third
// state. Numbers and strings are DISTINCT identities, exactly like JS: `3` and
// `"3"` are different cars and different peers.
//
// It lives in libttp-json because both libttp-sim (as `Id`) and libttp-party (as
// `PeerId`) need it and both already depend on this library for Value. They used
// to declare the same struct twice and parse the same wire format two different
// ways — the sim ABI with a hand-rolled scanner, the party ABI through the real
// parser — which disagreed on malformed input.
#pragma once

#include <string>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/jsonnum.h"

namespace ttp {

struct ScalarId {
  enum Kind { NONE, NUM, STR };
  Kind kind = NONE;
  double num = 0.0;
  std::string str;

  static ScalarId None() { return ScalarId{}; }
  static ScalarId Num(double n) { ScalarId i; i.kind = NUM; i.num = n; return i; }
  static ScalarId Str(std::string s) { ScalarId i; i.kind = STR; i.str = std::move(s); return i; }

  bool isNull() const { return kind == NONE; }
  bool operator==(const ScalarId& o) const {
    if (kind != o.kind) return false;
    if (kind == NUM) return num == o.num;
    if (kind == STR) return str == o.str;
    return true;  // NONE == NONE
  }
  bool operator!=(const ScalarId& o) const { return !(*this == o); }

  // String(id) — the map key the trace's per-frame input map and rekey
  // bookkeeping use. NUM goes through Number::toString, not printf.
  std::string key() const {
    if (kind == STR) return str;
    if (kind == NUM) return js_number_to_string(num);
    return "";
  }
  Value toValue() const {
    if (kind == STR) return Value::Str(str);
    if (kind == NUM) return Value::Num(num);
    return Value::Null();
  }
};

// Parse the ABI's JSON-scalar id text. nullptr, "", "null" and anything that is
// not a JSON number or string all mean "absent" — a malformed id must not decay
// into car 0.
inline ScalarId parse_scalar_id(const char* json) {
  if (!json || !*json) return ScalarId::None();
  bool ok = false;
  Value v = json::parse(json, &ok);
  if (!ok) return ScalarId::None();
  if (v.type == Value::NUM) return ScalarId::Num(v.num);
  if (v.type == Value::STR) return ScalarId::Str(v.str);
  return ScalarId::None();
}

}  // namespace ttp
