// ttp_theme.cc — the marshalling for ttp_theme.h. Thin by construction: every
// answer is a lookup into libttp-runtime's biome tables (ttp/theme.h), and the
// only work here is turning a resolved value into a C type.
//
// Outside the Filament gate on purpose (native/CMakeLists.txt compiles this into
// the browser module unconditionally): naming a biome is not rendering, and a
// shell that has no renderer yet still has music and a debug panel.

#include "ttp_theme.h"

#include <string>

#include "ttp/canonical.h"
#include "ttp/showcase.h"
#include "ttp/theme.h"

namespace {

// The JSON array returns share one buffer, per the ABI's "valid until the next
// call" rule (ttp_abi.h).
std::string& scratch() {
  static std::string s;
  return s;
}

}  // namespace

extern "C" {

int ttp_theme_biome_count(void) { return ttp::rt::biome_count(); }

const char* ttp_theme_biome_name(int index) {
  const char* n = ttp::rt::biome_name(index);
  return n ? n : "";
}

int ttp_theme_has_biome(const char* name) { return ttp::rt::has_biome(name) ? 1 : 0; }

const char* ttp_theme_biome_for_cup(const char* cupId) { return ttp::rt::biome_for_cup(cupId); }

const char* ttp_theme_biome_for_track(const char* trackId) {
  return ttp::rt::biome_for_track(trackId);
}

uint32_t ttp_theme_boost_icon(const char* biomeName) {
  // The track only reaches the ambient patch and the shoreline seed, neither of
  // which touches the accent, so resolving against no track is exact here.
  return ttp::rt::boost_shades(ttp::rt::resolve_theme(biomeName, "").boost).icon;
}

uint32_t ttp_theme_hill_color(const char* biomeName, int index) {
  const ttp::rt::Theme t = ttp::rt::resolve_theme(biomeName, "");
  if (index < 0 || (size_t) index >= t.hills.size()) return 0;
  return t.hills[(size_t) index];
}

const char* ttp_theme_scenery_models(const char* biomeName) {
  const ttp::rt::Theme t = ttp::rt::resolve_theme(biomeName, "");
  ttp::Value a = ttp::Value::Arr();
  for (const std::string& m : t.scenery.models) a.push(ttp::Value::Str(m));
  ttp::canonical_stringify_into(a, scratch());
  return scratch().c_str();
}

const char* ttp_theme_prop_models(const char* biomeName) {
  const ttp::rt::Theme t = ttp::rt::resolve_theme(biomeName, "");
  ttp::Value a = ttp::Value::Arr();
  for (const std::string& m : t.props.models) a.push(ttp::Value::Str(m));
  ttp::canonical_stringify_into(a, scratch());
  return scratch().c_str();
}

const char* ttp_theme_showcase_models(void) {
  ttp::Value a = ttp::Value::Arr();
  for (const std::string& m : ttp::rt::showcase_models()) a.push(ttp::Value::Str(m));
  ttp::canonical_stringify_into(a, scratch());
  return scratch().c_str();
}

const char* ttp_theme_showcase_prop_models(void) {
  ttp::Value a = ttp::Value::Arr();
  for (const std::string& m : ttp::rt::showcase_prop_models()) a.push(ttp::Value::Str(m));
  ttp::canonical_stringify_into(a, scratch());
  return scratch().c_str();
}

const char* ttp_showcase_inventory_json(void) {
  scratch() = ttp::rt::showcase_inventory_json();
  return scratch().c_str();
}

}  // extern "C"
