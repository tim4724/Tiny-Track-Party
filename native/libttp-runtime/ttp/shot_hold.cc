#include "ttp/shot_hold.h"

#include <string>

#include "ttp/json_read.h"

namespace ttp {
namespace rt {
namespace shot_hold {

bool parse(const Value& blob, Spec* out) {
  if (!json::is_obj(&blob)) return false;
  const Value* sim = blob.find("simMs");
  if (!json::is_num(sim) || !(sim->num >= 0)) return false;
  out->simS = sim->num / 1000;
  return true;
}

double allow(const Spec& spec, State& state, double elapsedS, double dtS) {
  if (state.held) return 0;
  if (elapsedS >= spec.simS) {
    state.held = true;
    return 0;
  }
  return dtS < spec.simS - elapsedS ? dtS : spec.simS - elapsedS;
}

Showcase parseShowcase(const char* kind) {
  if (!kind) return Showcase::None;
  const std::string k(kind);
  if (k == "rocket") return Showcase::Rocket;
  if (k == "monster") return Showcase::Monster;
  return Showcase::None;
}

int showcasePick(Showcase kind, ShowcaseState& state, double dtS, const std::vector<CarView>& cars) {
  if (kind == Showcase::None) return -1;
  state.fireCd -= dtS;
  if (state.fireCd > 0) return -1;
  if (kind == Showcase::Monster) {
    for (const CarView& c : cars) if (c.monster) return -1;
  }
  int pick = -1;
  for (int i = 0; i < (int) cars.size(); i++) {
    const CarView& c = cars[i];
    if (c.finished) continue;
    if (kind == Showcase::Monster && !c.viewer) continue;
    // Strictly less: on a tie the earlier car wins, as a stable sort would.
    if (pick < 0 || c.totalS < cars[pick].totalS) pick = i;
  }
  if (pick < 0) return -1;
  state.fireCd = kind == Showcase::Monster ? SHOWCASE_MONSTER_GAP_S : SHOWCASE_ROCKET_GAP_S;
  return pick;
}

}  // namespace shot_hold
}  // namespace rt
}  // namespace ttp
