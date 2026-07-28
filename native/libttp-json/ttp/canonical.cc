#include "ttp/canonical.h"

#include <algorithm>
#include <cstdio>

#include "ttp/jsonnum.h"

namespace ttp {
namespace {

// Every node appends into ONE buffer. The obvious recursive shape — each node
// returning its own std::string for the parent to concatenate — allocated a
// temporary per node and copied every byte once per level of nesting; a per-frame
// 8-car snapshot is ~330 nodes, so it dominated the render readback.
void quote_into(const std::string& s, std::string& o) {
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
}

// The two stringifiers differ in ONE line — whether an object's kept keys are
// sorted — so they are one walker with a flag rather than two copies that can
// drift. Everything else (undefined dropping, shortest-form numbers, escaping)
// is shared by construction.
void stringify_into(const Value& v, std::string& o, bool sortKeys) {
  switch (v.type) {
    case Value::NUL:
    case Value::UNDEF:  // only reachable as an array element; JS maps undefined -> null
      o += "null";
      return;
    case Value::BOOL:
      o += v.b ? "true" : "false";
      return;
    case Value::NUM:
      js_number_into(v.num, o);
      return;
    case Value::STR:
      quote_into(v.str, o);
      return;
    case Value::ARR:
      o += '[';
      for (size_t i = 0; i < v.arr.size(); i++) {
        if (i) o += ',';
        stringify_into(v.arr[i], o, sortKeys);  // UNDEF elements fall through to "null"
      }
      o += ']';
      return;
    case Value::OBJ: {
      // Object.keys(...).filter(v[k] !== undefined)[.sort()]
      std::vector<const std::pair<std::string, Value>*> kept;
      kept.reserve(v.obj.size());
      for (const auto& kv : v.obj)
        if (kv.second.type != Value::UNDEF) kept.push_back(&kv);
      if (sortKeys)
        std::sort(kept.begin(), kept.end(),
                  [](const auto* a, const auto* b) { return a->first < b->first; });
      o += '{';
      for (size_t i = 0; i < kept.size(); i++) {
        if (i) o += ',';
        quote_into(kept[i]->first, o);
        o += ':';
        stringify_into(kept[i]->second, o, sortKeys);
      }
      o += '}';
      return;
    }
  }
  o += "null";
}

}  // namespace

std::string json_quote(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 2);
  quote_into(s, o);
  return o;
}

std::string canonical_stringify(const Value& v) {
  std::string o;
  // Only containers are worth pre-sizing: a lone scalar (an id, a number) stays
  // inside the small-string buffer and must not be charged a 4 KB allocation.
  if (v.type == Value::ARR || v.type == Value::OBJ) o.reserve(4096);
  stringify_into(v, o, true);
  return o;
}

void canonical_stringify_into(const Value& v, std::string& out) {
  out.clear();
  stringify_into(v, out, true);
}

std::string ordered_stringify(const Value& v) {
  std::string o;
  if (v.type == Value::ARR || v.type == Value::OBJ) o.reserve(4096);
  stringify_into(v, o, false);
  return o;
}

void ordered_stringify_into(const Value& v, std::string& out) {
  out.clear();
  stringify_into(v, out, false);
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
