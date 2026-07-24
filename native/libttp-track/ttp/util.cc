#include "ttp/util.h"

#include <cmath>

#include "ttp/jsmath.h"

namespace ttp {

double wrap_delta(double ds, double len) {
  return ds - js_round(ds / len) * len;
}

double wrap_s(double s, double len) {
  return std::fmod(std::fmod(s, len) + len, len);
}

}  // namespace ttp
