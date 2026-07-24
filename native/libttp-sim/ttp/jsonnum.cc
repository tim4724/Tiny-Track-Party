#include "ttp/jsonnum.h"

#include "double-conversion/double-to-string.h"

namespace ttp {

std::string js_number_to_string(double v) {
  // EcmaScriptConverter() == Number.prototype.toString config: flags
  // UNIQUE_ZERO | EMIT_POSITIVE_EXPONENT_SIGN, exponent char 'e', decimal-in-
  // shortest-low/high = -6 / 21. ToShortest() picks the shortest round-tripping
  // digit string and lays out integer / fixed / exponent forms per ECMA-262.
  char buf[128];
  double_conversion::StringBuilder sb(buf, sizeof buf);
  double_conversion::DoubleToStringConverter::EcmaScriptConverter().ToShortest(v, &sb);
  return std::string(sb.Finalize());
}

}  // namespace ttp
