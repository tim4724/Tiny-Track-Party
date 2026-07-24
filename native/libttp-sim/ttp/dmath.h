// dmath — the C++ twin of public/display/engine/math.js: the SIX transcendentals
// the sim routes through the vendored fdlibm instead of the platform libm, so
// results are bit-identical to the WASM build the JS engine ships (fp-profile §2).
// The entry points are the renamed ttp_fd_* symbols (native/CMakeLists.txt). sqrt
// stays std::sqrt everywhere (correctly rounded); it is NOT routed here.
#pragma once

extern "C" {
double ttp_fd_sin(double);
double ttp_fd_cos(double);
double ttp_fd_atan2(double, double);
double ttp_fd_exp(double);
double ttp_fd_pow(double, double);
double ttp_fd_hypot(double, double);
}

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
