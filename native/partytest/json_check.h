// json_check — shared JSONL-corpus test machinery for the libttp-party checks
// (protocol_check, framing_check). A minimal structural JSON reader (JV), a
// canonical stringify of the recorded side, a JV<->ttp::Value bridge, and a
// structural first-diff that localizes the divergent path — the same approach
// roomflow_check.cc uses inline. Numbers compare via js_number_to_string, so a
// decimal round-trip is bit-exact (double-conversion == JSON.stringify).
#pragma once

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <string>
#include <utility>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/jsonnum.h"

namespace ttp {
namespace jsoncheck {

// ---- structural JSON reader (numbers via strtod) ----------------------------
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
            unsigned v = 0;
            for (int i = 0; i < 4; i++) {
              char h = s[p++]; v <<= 4;
              if (h >= '0' && h <= '9') v |= h - '0';
              else if (h >= 'a' && h <= 'f') v |= h - 'a' + 10;
              else if (h >= 'A' && h <= 'F') v |= h - 'A' + 10;
            }
            // Encode the code point as UTF-8 (corpus escapes are BMP only).
            if (v < 0x80) {
              out += (char)v;
            } else if (v < 0x800) {
              out += (char)(0xC0 | (v >> 6));
              out += (char)(0x80 | (v & 0x3F));
            } else {
              out += (char)(0xE0 | (v >> 12));
              out += (char)(0x80 | ((v >> 6) & 0x3F));
              out += (char)(0x80 | (v & 0x3F));
            }
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

inline bool parseLine(const std::string& line, JV& out) {
  JParse jp(line);
  return jp.value(out);
}

// ---- canonical stringify of a parsed JV (the recorded/expected side) --------
inline std::string canonJV(const JV& v) {
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

// ---- JV -> ttp::Value -------------------------------------------------------
inline Value jvToValue(const JV& v) {
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

// ---- structural first-diff: recorded JV (expected) vs port Value (actual) ---
struct Diff { bool differ = false; std::string path, expected, actual; };

inline std::string valType(const Value& v) {
  switch (v.type) {
    case Value::NUL: case Value::UNDEF: return "null";
    case Value::BOOL: return "bool"; case Value::NUM: return "num";
    case Value::STR: return "str"; case Value::ARR: return "arr"; case Value::OBJ: return "obj";
  }
  return "?";
}
inline std::string jvType(const JV& v) {
  switch (v.t) {
    case JV::NUL: return "null"; case JV::BOOL: return "bool"; case JV::NUM: return "num";
    case JV::STR: return "str"; case JV::ARR: return "arr"; case JV::OBJ: return "obj";
  }
  return "?";
}
inline Diff leafMismatch(const JV& e, const Value& a, const std::string& path) {
  return {true, path, canonJV(e), canonical_stringify(a)};
}
inline Diff diffVal(const JV& e, const Value& a, const std::string& path) {
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

}  // namespace jsoncheck
}  // namespace ttp
