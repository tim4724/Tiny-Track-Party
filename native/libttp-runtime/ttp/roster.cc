#include "ttp/roster.h"

#include <cstring>

#include "ttp/json_parse.h"

namespace ttp {
namespace rt {
namespace {

// Per-model plate height (world Y on the rear face), indexed by CAR_MODELS
// position: racer, speedster, racer-low, vintage-racer.
constexpr float PLATE_Y[] = { 0.157f, 0.245f, 0.156f, 0.134f };
constexpr int PLATE_Y_COUNT = (int) (sizeof(PLATE_Y) / sizeof(PLATE_Y[0]));

int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// The next UTF-16 code UNIT sequence of a UTF-8 string, appended to `out`.
//
// Code units, not code points, and that is deliberate: the plate's 8 slots are
// filled by JS `charCodeAt`, so an astral character (an emoji) has always eaten
// TWO of them and masked down to '=' plus a NUL that ends the plate early.
// Decoding to code points instead would silently change what the back of a car
// says for exactly the names most likely to carry one. A malformed byte yields
// itself, so a truncated name can never spin here.
void utf16Units(const std::string& s, std::vector<uint32_t>& out) {
  for (size_t i = 0; i < s.size();) {
    const unsigned char c = (unsigned char) s[i];
    uint32_t cp;
    size_t len;
    if (c < 0x80) { cp = c; len = 1; }
    else if ((c & 0xE0) == 0xC0) { cp = c & 0x1Fu; len = 2; }
    else if ((c & 0xF0) == 0xE0) { cp = c & 0x0Fu; len = 3; }
    else if ((c & 0xF8) == 0xF0) { cp = c & 0x07u; len = 4; }
    else { out.push_back(c); i++; continue; }
    if (i + len > s.size()) { out.push_back(c); i++; continue; }
    bool ok = true;
    for (size_t k = 1; k < len; k++) {
      const unsigned char cc = (unsigned char) s[i + k];
      if ((cc & 0xC0) != 0x80) { ok = false; break; }
      cp = (cp << 6) | (cc & 0x3Fu);
    }
    if (!ok) { out.push_back(c); i++; continue; }
    i += len;
    if (cp >= 0x10000u) {
      const uint32_t v = cp - 0x10000u;
      out.push_back(0xD800u + (v >> 10));
      out.push_back(0xDC00u + (v & 0x3FFu));
    } else {
      out.push_back(cp);
    }
  }
}

void writePlate(const std::string& name, char out[9]) {
  std::vector<uint32_t> units;
  utf16Units(name, units);
  for (int i = 0; i < 8; i++) {
    out[i] = (char) (i < (int) units.size() ? (units[(size_t) i] & 0x7Fu) : 0u);
  }
  out[8] = 0;
}

}  // namespace

float plateY(int carIndex) {
  int i = carIndex % PLATE_Y_COUNT;
  if (i < 0) i += PLATE_Y_COUNT;
  return PLATE_Y[i];
}

uint32_t liveryABGR(const std::string& css) {
  const std::string s = css.empty() ? "#888888" : css;
  // Everything after the '#', as parseInt(_, 16) reads it: hex digits from the
  // front, stopping at the first byte that is not one. No digits at all is
  // parseInt's NaN, whose bit-ops in the retired JS writer produced 0 — opaque
  // black — so that is what an unparseable colour still gets.
  uint32_t rgb = 0;
  for (size_t i = (s[0] == '#' ? 1 : 0); i < s.size(); i++) {
    const int d = hexDigit(s[i]);
    if (d < 0) break;
    rgb = (rgb << 4) | (uint32_t) d;
  }
  return 0xFF000000u | ((rgb & 0xFFu) << 16) | (rgb & 0xFF00u) | ((rgb >> 16) & 0xFFu);
}

Roster parseRoster(const char* json) {
  Roster out;
  if (!json) return out;
  bool ok = false;
  const Value v = ttp::json::parse(json, &ok);
  if (!ok || v.type != Value::ARR) return out;
  for (const Value& e : v.arr) {
    if (e.type != Value::OBJ) continue;
    const Value* id = e.find("id");
    if (!id) continue;
    if (id->type == Value::NUM) out.ids.push_back(ScalarId::Num(id->num));
    else if (id->type == Value::STR) out.ids.push_back(ScalarId::Str(id->str));
    else continue;

    const Value* name = e.find("name");
    const Value* carIndex = e.find("carIndex");
    const Value* color = e.find("color");
    TtpRosterCar car{};
    car.colorABGR = liveryABGR(color && color->type == Value::STR ? color->str : std::string());
    writePlate(name && name->type == Value::STR ? name->str : std::string(), car.name);
    car.plateY = plateY(carIndex && carIndex->type == Value::NUM ? (int) carIndex->num : 0);
    out.cars.push_back(car);
  }
  return out;
}

}  // namespace rt
}  // namespace ttp
