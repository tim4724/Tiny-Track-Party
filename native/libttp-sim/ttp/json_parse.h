// json_parse — text -> ttp::Value, the inverse of canonical.h's stringify. Used
// by the C ABIs, where arbitrary JSON crosses the boundary (room configs, opaque
// player fields, fastlane packets) and the ad-hoc field scanning that suffices
// for a fixed stats shape does not.
//
// Deliberately small and total: it accepts the JSON that our own JS side emits
// (JSON.stringify output) and reports failure rather than throwing. Numbers go
// through strtod, which is correctly rounded for decimal->binary64, so a value
// round-trips exactly: parse(canonical_stringify(v)) == v for finite numbers.
//
// NOT a validating parser for hostile input: it trusts structure it has already
// matched (the peer here is our own adapter, and the relay's JSON is re-encoded
// by the browser before it reaches us).
#pragma once

#include <cctype>
#include <cstdlib>
#include <string>

#include "ttp/canonical.h"

namespace ttp {
namespace json {

class Parser {
 public:
  explicit Parser(const std::string& src) : s_(src) {}

  // Parse one value. Returns false on malformed input (out is then undefined).
  bool parse(Value& out) {
    ws();
    if (!value(out)) return false;
    ws();
    return true;  // trailing bytes tolerated (one value per call site)
  }

 private:
  void ws() {
    while (p_ < s_.size() && (s_[p_] == ' ' || s_[p_] == '\t' || s_[p_] == '\n' || s_[p_] == '\r')) p_++;
  }
  bool eof() const { return p_ >= s_.size(); }

  // Append code point cp as UTF-8. Surrogate pairs are combined by the caller.
  static void utf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
      out += static_cast<char>(cp);
    } else if (cp < 0x800) {
      out += static_cast<char>(0xC0 | (cp >> 6));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += static_cast<char>(0xE0 | (cp >> 12));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (cp >> 18));
      out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    }
  }

  bool hex4(unsigned& v) {
    v = 0;
    for (int i = 0; i < 4; i++) {
      if (eof()) return false;
      char h = s_[p_++];
      v <<= 4;
      if (h >= '0' && h <= '9') v |= static_cast<unsigned>(h - '0');
      else if (h >= 'a' && h <= 'f') v |= static_cast<unsigned>(h - 'a' + 10);
      else if (h >= 'A' && h <= 'F') v |= static_cast<unsigned>(h - 'A' + 10);
      else return false;
    }
    return true;
  }

  bool str(std::string& out) {
    if (eof() || s_[p_] != '"') return false;
    p_++;
    out.clear();
    while (!eof()) {
      char c = s_[p_++];
      if (c == '"') return true;
      if (c != '\\') { out += c; continue; }
      if (eof()) return false;
      char e = s_[p_++];
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
          unsigned cp = 0;
          if (!hex4(cp)) return false;
          // Combine a surrogate pair into one code point (JSON.stringify emits
          // pairs for astral characters when it escapes at all).
          if (cp >= 0xD800 && cp <= 0xDBFF && p_ + 1 < s_.size() &&
              s_[p_] == '\\' && s_[p_ + 1] == 'u') {
            size_t save = p_;
            p_ += 2;
            unsigned lo = 0;
            if (hex4(lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            } else {
              p_ = save;  // not a valid low surrogate; emit the high one as-is
            }
          }
          utf8(out, cp);
          break;
        }
        default: return false;
      }
    }
    return false;  // unterminated
  }

  bool value(Value& v) {
    ws();
    if (eof()) return false;
    const char c = s_[p_];
    if (c == '{') {
      p_++;
      v = Value::Obj();
      ws();
      if (!eof() && s_[p_] == '}') { p_++; return true; }
      while (true) {
        ws();
        std::string key;
        if (!str(key)) return false;
        ws();
        if (eof() || s_[p_] != ':') return false;
        p_++;
        Value child;
        if (!value(child)) return false;
        v.set(std::move(key), std::move(child));
        ws();
        if (eof()) return false;
        if (s_[p_] == ',') { p_++; continue; }
        if (s_[p_] == '}') { p_++; return true; }
        return false;
      }
    }
    if (c == '[') {
      p_++;
      v = Value::Arr();
      ws();
      if (!eof() && s_[p_] == ']') { p_++; return true; }
      while (true) {
        Value child;
        if (!value(child)) return false;
        v.push(std::move(child));
        ws();
        if (eof()) return false;
        if (s_[p_] == ',') { p_++; continue; }
        if (s_[p_] == ']') { p_++; return true; }
        return false;
      }
    }
    if (c == '"') {
      std::string out;
      if (!str(out)) return false;
      v = Value::Str(std::move(out));
      return true;
    }
    if (s_.compare(p_, 4, "true") == 0) { p_ += 4; v = Value::Bool(true); return true; }
    if (s_.compare(p_, 5, "false") == 0) { p_ += 5; v = Value::Bool(false); return true; }
    if (s_.compare(p_, 4, "null") == 0) { p_ += 4; v = Value::Null(); return true; }
    // number
    const size_t start = p_;
    if (!eof() && (s_[p_] == '-' || s_[p_] == '+')) p_++;
    bool anyDigit = false;
    while (!eof() && (std::isdigit(static_cast<unsigned char>(s_[p_])) || s_[p_] == '.' ||
                      s_[p_] == 'e' || s_[p_] == 'E' || s_[p_] == '-' || s_[p_] == '+')) {
      if (std::isdigit(static_cast<unsigned char>(s_[p_]))) anyDigit = true;
      p_++;
    }
    if (!anyDigit) return false;
    v = Value::Num(std::strtod(s_.substr(start, p_ - start).c_str(), nullptr));
    return true;
  }

  const std::string& s_;
  size_t p_ = 0;
};

// Convenience: parse `text`, returning Value::Null() (and false via `ok`) on
// malformed input. A nullptr/empty string parses as null.
inline Value parse(const char* text, bool* ok = nullptr) {
  if (!text || !*text) { if (ok) *ok = false; return Value::Null(); }
  std::string s(text);
  Parser p(s);
  Value v;
  const bool good = p.parse(v);
  if (ok) *ok = good;
  return good ? v : Value::Null();
}

}  // namespace json
}  // namespace ttp
