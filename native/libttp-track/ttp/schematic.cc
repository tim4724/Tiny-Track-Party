#include "ttp/schematic.h"

#include <cmath>
#include <cstdlib>
#include <limits>
#include <vector>

#include "double-conversion/double-conversion.h"
#include "ttp/jsmath.h"
#include "ttp/jsonnum.h"

namespace ttp {
namespace schematic {
namespace {

const std::string kViewBox = "0 0 256 256";

// Rounding can produce -0 (e.g. +(-0.001).toFixed(2)), which JSON flattens to 0
// — so a baked schematic would never compare equal to the runtime value.
// Normalize it away everywhere a number leaves this module, exactly as the JS
// `z0` helper does.
double z0(double n) { return n == 0 ? 0 : n; }

std::string fixedText(double v, int digits) {
  char buf[128];
  double_conversion::StringBuilder sb(buf, sizeof(buf));
  const auto& conv = double_conversion::DoubleToStringConverter::EcmaScriptConverter();
  if (!conv.ToFixed(v, digits, &sb)) return js_number_to_string(v);
  return std::string(sb.Finalize());
}

// btoa/atob's alphabet. The codec ships two bytes per point and nothing else, so
// there is no line wrapping and no URL-safe variant to worry about.
const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string toB64(const std::vector<unsigned char>& bytes) {
  std::string out;
  out.reserve((bytes.size() + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < bytes.size(); i += 3) {
    const unsigned v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += kB64[(v >> 18) & 63];
    out += kB64[(v >> 12) & 63];
    out += kB64[(v >> 6) & 63];
    out += kB64[v & 63];
  }
  if (i + 1 == bytes.size()) {
    const unsigned v = bytes[i] << 16;
    out += kB64[(v >> 18) & 63];
    out += kB64[(v >> 12) & 63];
    out += "==";
  } else if (i + 2 == bytes.size()) {
    const unsigned v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += kB64[(v >> 18) & 63];
    out += kB64[(v >> 12) & 63];
    out += kB64[(v >> 6) & 63];
    out += '=';
  }
  return out;
}

int b64Digit(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

std::vector<unsigned char> fromB64(const std::string& s) {
  std::vector<unsigned char> out;
  unsigned acc = 0;
  int bits = 0;
  for (char c : s) {
    const int d = b64Digit(c);
    if (d < 0) continue;  // '=' padding and anything else
    acc = (acc << 6) | static_cast<unsigned>(d);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<unsigned char>((acc >> bits) & 0xFF));
    }
  }
  return out;
}

// Number.prototype.toFixed(digits) followed by the implicit ToNumber the JS
// does (`+x.toFixed(1)`), i.e. the value snapped to `digits` decimals.
double js_fixed(double v, int digits) {
  const std::string t = fixedText(v, digits);
  return std::strtod(t.c_str(), nullptr);
}

// The path text of a schematic's points, in JS's exact spelling: "M" then the
// first pair, " L" before each later pair, a space between x and y, numbers
// through Number::toString, and a trailing " Z".
std::string path_of(const std::vector<Point>& pts) {
  if (pts.empty()) return std::string();
  std::string d;
  for (size_t i = 0; i < pts.size(); i++) {
    d += (i == 0 ? "M" : " L");
    d += js_number_to_string(pts[i].x);
    d += ' ';
    d += js_number_to_string(pts[i].y);
  }
  d += " Z";
  return d;
}

// Ramer-Douglas-Peucker on an OPEN polyline (both endpoints fixed: the loop's
// start point is meaningful, it is the grid). Iterative, so a pathological
// track cannot blow a stack.
std::vector<Point> rdp(const std::vector<Point>& pts, double eps) {
  if (pts.size() < 3) return pts;
  std::vector<unsigned char> keep(pts.size(), 0);
  keep[0] = 1;
  keep[pts.size() - 1] = 1;
  std::vector<std::pair<size_t, size_t>> stack;
  stack.emplace_back(0, pts.size() - 1);
  while (!stack.empty()) {
    const size_t i = stack.back().first, j = stack.back().second;
    stack.pop_back();
    const double ax = pts[i].x, ay = pts[i].y;
    const double dx = pts[j].x - ax, dy = pts[j].y - ay;
    const double L2 = dx * dx + dy * dy;
    double md = -1;
    size_t mi = 0;
    bool found = false;
    for (size_t k = i + 1; k < j; k++) {
      const double px = pts[k].x, py = pts[k].y;
      // perpendicular distance from point k to the chord i->j; a degenerate
      // chord (the two endpoints coincide) falls back to the point distance
      const double dist = L2 ? std::fabs((px - ax) * dy - (py - ay) * dx) / std::sqrt(L2)
                             : std::hypot(px - ax, py - ay);
      if (dist > md) { md = dist; mi = k; found = true; }
    }
    if (found && md > eps) {
      keep[mi] = 1;
      stack.emplace_back(i, mi);
      stack.emplace_back(mi, j);
    }
  }
  std::vector<Point> out;
  for (size_t i = 0; i < pts.size(); i++) {
    if (keep[i]) out.push_back(pts[i]);
  }
  return out;
}

}  // namespace

std::vector<Point> points_of(const std::string& d) {
  std::vector<Point> pts;
  if (d.empty()) return pts;
  // /^M/ then / Z$/, then split on " L" — the exact JS reader, and it only ever
  // sees text this module wrote.
  size_t begin = (d[0] == 'M') ? 1 : 0;
  size_t end = d.size();
  if (end >= begin + 2 && d.compare(end - 2, 2, " Z") == 0) end -= 2;
  const std::string body = d.substr(begin, end - begin);

  size_t pos = 0;
  while (pos <= body.size()) {
    size_t next = body.find(" L", pos);
    const std::string tok = body.substr(pos, (next == std::string::npos ? body.size() : next) - pos);
    // trim, then split on the single space between x and y
    size_t a = tok.find_first_not_of(" \t\n\r");
    if (a != std::string::npos) {
      const size_t b = tok.find_last_not_of(" \t\n\r");
      const std::string t = tok.substr(a, b - a + 1);
      const size_t sp = t.find(' ');
      Point p;
      p.x = std::strtod(t.c_str(), nullptr);
      p.y = (sp == std::string::npos) ? std::numeric_limits<double>::quiet_NaN()
                                      : std::strtod(t.c_str() + sp + 1, nullptr);
      pts.push_back(p);
    }
    if (next == std::string::npos) break;
    pos = next + 2;
  }
  return pts;
}

Schematic build(const RaceTrack& track) {
  Schematic out;
  out.viewBox = kViewBox;
  if (track.samples.empty()) return out;   // d "", start null, and NO proj key

  double minX = std::numeric_limits<double>::infinity();
  double maxX = -std::numeric_limits<double>::infinity();
  double minZ = std::numeric_limits<double>::infinity();
  double maxZ = -std::numeric_limits<double>::infinity();
  for (const OutSample& s : track.samples) {
    minX = js_min(minX, s.pos.x);
    maxX = js_max(maxX, s.pos.x);
    minZ = js_min(minZ, s.pos.z);
    maxZ = js_max(maxZ, s.pos.z);
  }
  double span = js_max(maxX - minX, maxZ - minZ);
  if (!(span != 0) || span != span) span = 1;   // JS `|| 1`: 0 and NaN both fall through
  const double scale = (VIEW - 2.0 * PAD) / span;
  // Centre the (possibly non-square) extent inside the square viewBox.
  const double offX = PAD + (VIEW - 2.0 * PAD - (maxX - minX) * scale) / 2;
  const double offZ = PAD + (VIEW - 2.0 * PAD - (maxZ - minZ) * scale) / 2;

  // 0..VIEW-1 space at 0.1 precision, kept SUB-INTEGER on purpose: pack() runs
  // RDP on these smooth points and only then rounds survivors to bytes.
  // The projection keeps everything inside [PAD, VIEW-PAD]; the clamp is
  // belt-and-braces (and is where a -0 would otherwise appear).
  const auto q = [](double n) {
    return z0(js_fixed(js_max(0.0, js_min(VIEW - 1.0, n)), 1));
  };

  std::vector<Point> pts;
  pts.reserve(track.samples.size());
  for (const OutSample& s : track.samples) {
    Point p;
    p.x = q(offX + (s.pos.x - minX) * scale);
    p.y = q(offZ + (s.pos.z - minZ) * scale);
    pts.push_back(p);
  }

  out.d = path_of(pts);
  out.hasStart = true;
  out.start = pts.front();
  out.hasProj = true;
  out.proj.minX = z0(js_fixed(minX, 2));
  out.proj.minZ = z0(js_fixed(minZ, 2));
  out.proj.scale = z0(js_fixed(scale, 4));
  out.proj.offX = z0(js_fixed(offX, 2));
  out.proj.offZ = z0(js_fixed(offZ, 2));
  return out;
}

std::string pack(const std::string& d, double eps) {
  const std::vector<Point> pts = rdp(points_of(d), eps);
  std::vector<unsigned char> buf;
  buf.reserve(pts.size() * 2);
  for (const Point& p : pts) {
    // A byte IS the coordinate: coordinates already live in 0..255 (VIEW), so
    // this is Math.round + a & 255 wrap, not a rescale.
    buf.push_back(static_cast<unsigned char>(static_cast<long long>(js_round(p.x)) & 255));
    buf.push_back(static_cast<unsigned char>(static_cast<long long>(js_round(p.y)) & 255));
  }
  return toB64(buf);
}

Schematic unpack(const std::string& b64) {
  Schematic out;
  out.viewBox = kViewBox;
  if (b64.empty()) return out;   // d "", start null (JS returns no proj either)
  const std::vector<unsigned char> b = fromB64(b64);
  const size_t n = b.size() >> 1;
  std::vector<Point> pts;
  pts.reserve(n);
  for (size_t i = 0; i < n; i++) {
    Point p;
    p.x = b[i * 2];
    p.y = b[i * 2 + 1];
    pts.push_back(p);
  }
  // JS builds the path even for an empty point list, giving a bare " Z" —
  // faithfully reproduced rather than tidied, because the phone renders it.
  out.d = pts.empty() ? std::string(" Z") : path_of(pts);
  if (!pts.empty()) {
    out.hasStart = true;
    out.start = pts.front();
  } else {
    out.hasStart = true;   // JS: { x: sx, y: sy } with both left at 0
    out.start = Point{0, 0};
  }
  return out;
}

}  // namespace schematic
}  // namespace ttp
