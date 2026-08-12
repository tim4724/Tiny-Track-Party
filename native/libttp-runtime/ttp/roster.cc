#include "ttp/roster.h"

#include "ttp/json_parse.h"

namespace ttp {
namespace rt {
namespace {

int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

}  // namespace

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

    const Value* carIndex = e.find("carIndex");
    const Value* color = e.find("color");
    TtpRosterCar car{};
    car.colorABGR = liveryABGR(color && color->type == Value::STR ? color->str : std::string());
    car.carIndex = carIndex && carIndex->type == Value::NUM ? (int32_t) carIndex->num : 0;
    out.cars.push_back(car);
  }
  return out;
}

RerosterPlan planReroster(const Roster& prev, const Roster& next) {
  RerosterPlan plan;
  // Same slots, same order — slot identity is baked into the scene.
  if (prev.ids.size() != next.ids.size()) return plan;
  for (size_t i = 0; i < prev.ids.size(); i++) {
    if (!(prev.ids[i] == next.ids[i])) return plan;
  }
  plan.ok = true;
  for (size_t i = 0; i < next.cars.size(); i++) {
    const TtpRosterCar& a = prev.cars[i];
    const TtpRosterCar& b = next.cars[i];
    if (a.carIndex != b.carIndex) {
      plan.remodel.push_back((uint32_t) i);
    } else if (a.colorABGR != b.colorABGR) {
      plan.redress.push_back((uint32_t) i);
    }
  }
  return plan;
}

}  // namespace rt
}  // namespace ttp
