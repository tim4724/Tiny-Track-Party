// The renamed fdlibm entry points (TTP_FDLIBM_RENAMES in native/CMakeLists.txt).
// The -D rename means no vendored header declares them, and an extern "C"
// signature mismatch is silent UB, not a link error — so declare them here once
// and nowhere else. Lives beside the vendored build, not inside vendor/fdlibm/,
// which is taken whole from upstream.
#pragma once

extern "C" {
double ttp_fd_sin(double);
double ttp_fd_cos(double);
double ttp_fd_atan2(double, double);
double ttp_fd_exp(double);
double ttp_fd_pow(double, double);
double ttp_fd_hypot(double, double);
}
