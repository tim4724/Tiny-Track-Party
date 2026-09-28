// dmath — the SIX transcendentals
// the sim routes through the vendored fdlibm instead of the platform libm, so
// results are bit-identical to the WASM build the retired JS engine shipped
// (fp-profile §2), which the math corpus was recorded against. sqrt stays
// std::sqrt everywhere (correctly rounded); it is NOT routed here.
#pragma once

#include "ttp_fd.h"

namespace ttp {
namespace dmath {
inline double sin(double x) { return ttp_fd_sin(x); }
inline double cos(double x) { return ttp_fd_cos(x); }
inline double atan2(double y, double x) { return ttp_fd_atan2(y, x); }
inline double exp(double x) { return ttp_fd_exp(x); }
inline double pow(double b, double e) { return ttp_fd_pow(b, e); }
inline double hypot(double a, double b) { return ttp_fd_hypot(a, b); }
}  // namespace dmath
}  // namespace ttp
