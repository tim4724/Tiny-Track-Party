#include "ttp/protocol.h"

#include <cmath>

namespace ttp {
namespace protocol {

static Value carStatValue(const CarStat& s) {
  Value o = Value::Obj();
  o.set("accel", Value::Num(s.accel));
  o.set("vmax", Value::Num(s.vmax));
  o.set("turn", Value::Num(s.turn));
  o.set("mass", Value::Num(s.mass));
  o.set("halfLen", Value::Num(s.halfLen));
  o.set("halfWid", Value::Num(s.halfWid));
  return o;
}

Value car_stats(const Value& carIndex) {
  const double len = static_cast<double>(CAR_STATS.size());
  double i;
  // `carIndex == null` (JS) catches null/undefined; `isNaN` catches NaN. Both
  // fall back to slot 0.
  if (carIndex.type != Value::NUM || std::isnan(carIndex.num)) {
    i = 0.0;
  } else {
    // JS `%` is fmod on finite doubles; the double-mod normalises to [0, len).
    i = std::fmod(std::fmod(carIndex.num, len) + len, len);
  }
  // JS array access with a non-integer index yields undefined -> null.
  if (i == std::floor(i) && i >= 0.0 && i < len) {
    return carStatValue(CAR_STATS[static_cast<size_t>(i)]);
  }
  return Value::Null();
}

Value manifest() {
  Value m = Value::Obj();

  Value msg = Value::Obj();
  for (const auto& kv : MSG) msg.set(kv.first, Value::Str(kv.second));
  m.set("MSG", std::move(msg));

  Value fast = Value::Obj();
  for (const auto& kv : FASTLANE_TYPES) fast.set(kv.first, Value::Bool(kv.second));
  m.set("FASTLANE_TYPES", std::move(fast));

  Value rs = Value::Obj();
  for (const auto& kv : ROOM_STATE) rs.set(kv.first, Value::Str(kv.second));
  m.set("ROOM_STATE", std::move(rs));

  m.set("RELAY_URL", Value::Str(RELAY_URL));
  m.set("STUN_URL", Value::Str(STUN_URL));
  m.set("STUN_FALLBACK_URL", Value::Str(STUN_FALLBACK_URL));
  m.set("MAX_PLAYERS", Value::Num(MAX_PLAYERS));
  m.set("TOTAL_LAPS", Value::Num(TOTAL_LAPS));
  m.set("COUNTDOWN_SECONDS", Value::Num(COUNTDOWN_SECONDS));
  m.set("SCHEMATIC_EPS", Value::Num(SCHEMATIC_EPS));

  Value steer = Value::Obj();
  steer.set("EXPO", Value::Num(STEER_EXPO));
  steer.set("ROLL_LOCK_DEG", Value::Num(STEER_ROLL_LOCK_DEG));
  steer.set("DEADZONE", Value::Num(STEER_DEADZONE));
  steer.set("SMOOTH", Value::Num(STEER_SMOOTH));
  steer.set("GATE_THRESHOLD", Value::Num(STEER_GATE_THRESHOLD));
  steer.set("STRONG_THRESHOLD", Value::Num(STEER_STRONG_THRESHOLD));
  steer.set("SEND_INTERVAL_MS", Value::Num(STEER_SEND_INTERVAL_MS));
  steer.set("SEND_MIN_INTERVAL_MS", Value::Num(STEER_SEND_MIN_INTERVAL_MS));
  m.set("STEER", std::move(steer));

  Value liveness = Value::Obj();
  liveness.set("PING_INTERVAL_MS", Value::Num(LIVENESS_PING_INTERVAL_MS));
  liveness.set("TIMEOUT_MS", Value::Num(LIVENESS_TIMEOUT_MS));
  liveness.set("TICK_MS", Value::Num(LIVENESS_TICK_MS));
  liveness.set("HEARTBEAT_DEAD_MS", Value::Num(LIVENESS_HEARTBEAT_DEAD_MS));
  liveness.set("ABANDONED_RACE_GRACE_MS", Value::Num(LIVENESS_ABANDONED_RACE_GRACE_MS));
  liveness.set("CREATE_TIMEOUT_MS", Value::Num(LIVENESS_CREATE_TIMEOUT_MS));
  m.set("LIVENESS", std::move(liveness));

  Value randomRaces = Value::Obj();
  randomRaces.set("DEFAULT", Value::Num(RANDOM_RACES_DEFAULT));
  randomRaces.set("MAX", Value::Num(RANDOM_RACES_MAX));
  m.set("RANDOM_RACES", std::move(randomRaces));

  Value colors = Value::Arr();
  for (const auto& c : CAR_COLORS) colors.push(Value::Str(c));
  m.set("CAR_COLORS", std::move(colors));

  Value models = Value::Arr();
  for (const auto& c : CAR_MODELS) models.push(Value::Str(c));
  m.set("CAR_MODELS", std::move(models));

  Value names = Value::Arr();
  for (const auto& c : CAR_NAMES) names.push(Value::Str(c));
  m.set("CAR_NAMES", std::move(names));

  Value yaw = Value::Arr();
  for (double y : CAR_MODEL_YAW) yaw.push(Value::Num(y));
  m.set("CAR_MODEL_YAW", std::move(yaw));

  Value stats = Value::Arr();
  for (const auto& s : CAR_STATS) stats.push(carStatValue(s));
  m.set("CAR_STATS", std::move(stats));

  return m;
}

}  // namespace protocol
}  // namespace ttp
