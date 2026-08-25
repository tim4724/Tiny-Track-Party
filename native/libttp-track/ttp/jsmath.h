// ECMA-262 scalar math helpers, header-only. These reproduce JS Number
// semantics that the C standard library gets subtly wrong; see
// docs/native-port/fp-profile.md §3.1/§3.4. Do NOT substitute the std::
// lookalikes — each disagrees with JS on a case the sim reaches.
#pragma once

#include <cmath>

namespace ttp {

// ECMA-262 Math.round — round-half-toward-+inf, NOT C round (half-away) nor
// rint (ties-to-even) nor floor(x+0.5) (which pre-rounds 0.49999999999999994
// up to 1). ±0 and the sub-0.5 boundary are spec-special-cased. fp-profile §3.1.
inline double js_round(double x) {
  if (!std::isfinite(x) || x == 0.0) return x;   // NaN / ±inf / ±0 pass through
  if (x > 0.0 && x < 0.5) return 0.0;            // spec branch 2 → +0
  if (x < 0.0 && x >= -0.5) return -0.0;         // spec branch 3 → -0
  double f = std::floor(x);
  double frac = x - f;                           // exact in binary64
  return frac < 0.5 ? f : f + 1.0;               // frac == 0.5 tie → toward +inf
}

// ECMA-262 Math.max (2-arg). NaN-propagating and orders -0 < +0, unlike
// std::max (order-dependent on ±0) and std::fmax (drops NaN). fp-profile §3.4.
inline double js_max(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == 0.0 && b == 0.0) return std::signbit(a) ? b : a;  // -0 < +0
  return a > b ? a : b;
}

// ECMA-262 Math.min (2-arg).
inline double js_min(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == 0.0 && b == 0.0) return std::signbit(a) ? a : b;  // -0 < +0
  return a < b ? a : b;
}

// ECMA-262 Math.sign — preserves ±0 and NaN.
inline double js_sign(double x) {
  if (std::isnan(x) || x == 0.0) return x;       // -0 → -0, +0 → +0
  return x > 0.0 ? 1.0 : -1.0;
}

}  // namespace ttp
