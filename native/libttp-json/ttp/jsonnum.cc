#include "ttp/jsonnum.h"

#include "double-conversion/double-to-string.h"

namespace ttp {

namespace {
// EcmaScriptConverter() == Number.prototype.toString config: flags
// UNIQUE_ZERO | EMIT_POSITIVE_EXPONENT_SIGN, exponent char 'e', decimal-in-
// shortest-low/high = -6 / 21. ToShortest() picks the shortest round-tripping
// digit string and lays out integer / fixed / exponent forms per ECMA-262.
const char* to_shortest(double v, char (&buf)[128]) {
  double_conversion::StringBuilder sb(buf, sizeof buf);
  double_conversion::DoubleToStringConverter::EcmaScriptConverter().ToShortest(v, &sb);
  return sb.Finalize();
}
}  // namespace

std::string js_number_to_string(double v) {
  char buf[128];
  return std::string(to_shortest(v, buf));
}

void js_number_into(double v, std::string& out) {
  char buf[128];
  out += to_shortest(v, buf);
}

}  // namespace ttp
