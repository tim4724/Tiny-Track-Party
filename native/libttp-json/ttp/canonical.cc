#include "ttp/canonical.h"

#include <algorithm>
#include <cstdio>

#include "ttp/jsonnum.h"

namespace ttp {

std::string json_quote(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 2);
  o += '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\b': o += "\\b"; break;
      case '\t': o += "\\t"; break;
      case '\n': o += "\\n"; break;
      case '\f': o += "\\f"; break;
      case '\r': o += "\\r"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          o += buf;
        } else {
          o += (char)c;  // >= 0x20 (incl. UTF-8 continuation bytes) verbatim
        }
    }
  }
  o += '"';
  return o;
}

std::string canonical_stringify(const Value& v) {
  switch (v.type) {
    case Value::NUL:
    case Value::UNDEF:  // only reachable as an array element; JS maps undefined -> null
      return "null";
    case Value::BOOL:
      return v.b ? "true" : "false";
    case Value::NUM:
      return js_number_to_string(v.num);
    case Value::STR:
      return json_quote(v.str);
    case Value::ARR: {
      std::string o = "[";
      for (size_t i = 0; i < v.arr.size(); i++) {
        if (i) o += ",";
        // JS: undefined array elements serialize as null.
        o += v.arr[i].type == Value::UNDEF ? "null" : canonical_stringify(v.arr[i]);
      }
      o += "]";
      return o;
    }
    case Value::OBJ: {
      // Object.keys(...).filter(v[k] !== undefined).sort()
      std::vector<const std::pair<std::string, Value>*> kept;
      kept.reserve(v.obj.size());
      for (const auto& kv : v.obj)
        if (kv.second.type != Value::UNDEF) kept.push_back(&kv);
      std::sort(kept.begin(), kept.end(),
                [](const auto* a, const auto* b) { return a->first < b->first; });
      std::string o = "{";
      for (size_t i = 0; i < kept.size(); i++) {
        if (i) o += ",";
        o += json_quote(kept[i]->first);
        o += ":";
        o += canonical_stringify(kept[i]->second);
      }
      o += "}";
      return o;
    }
  }
  return "null";
}

uint32_t fnv1a(const std::string& utf8) {
  uint32_t h = 0x811c9dc5u;
  for (unsigned char b : utf8) { h ^= b; h *= 0x01000193u; }
  return h;
}

std::string fnv1a_hex(const std::string& utf8) {
  char b[9];
  std::snprintf(b, sizeof b, "%08x", fnv1a(utf8));
  return std::string(b);
}

}  // namespace ttp
