#include "ttp_error.h"

#include <cstddef>

namespace {
// One buffer, not one per handle. A refusal is read immediately or not at all
// (ttp_error.h states the contract), and the alternative — a slot per handle —
// would need the handle to still exist, which is exactly what a failed factory
// does not have.
std::string g_lastError;
}  // namespace

namespace ttp {

void set_error(std::string why) { g_lastError = std::move(why); }

std::string error_excerpt(const char* json, size_t max) {
  if (!json) return "(null)";
  if (!*json) return "(empty)";
  std::string s(json);
  if (s.size() <= max) return "\"" + s + "\"";
  return "\"" + s.substr(0, max) + "\"… (" + std::to_string(s.size()) + " bytes)";
}

}  // namespace ttp

extern "C" const char* ttp_last_error(void) { return g_lastError.c_str(); }
