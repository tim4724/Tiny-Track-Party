// ECMA-262 Number::toString for the trace serializer. The golden-trace surface
// is byte-exact JSON, and JSON.stringify prints a number as the SHORTEST decimal
// that round-trips to the same binary64 (ECMA-262 Number::toString). printf
// families do not reproduce this — see docs/native-port/fp-profile.md §3.6.
//
// Backed by the vendored google/double-conversion: its EcmaScriptConverter is a
// DoubleToStringConverter preconfigured to Number.prototype.toString exactly
// (shortest digits, exponent form only outside [1e-6, 1e21), UNIQUE_ZERO so
// -0 -> "0"). For every finite value this equals JSON.stringify(value). The
// json-number-corpus gate (52,357 cases) proves the byte-exactness.
#pragma once

#include <string>

namespace ttp {

// JSON.stringify(v) for a finite double v. -0 -> "0". NaN/Infinity never reach
// this on the sim byte path (fp-profile §5); if one did, the emitted text would
// not be valid JSON, surfacing the sim bug rather than being silently absorbed.
std::string js_number_to_string(double v);

}  // namespace ttp
