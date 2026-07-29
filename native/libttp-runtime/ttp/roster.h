// roster — who is in this race and what their cars look like, parsed once per
// scene build.
//
// This is the last thing about a race that the SHELL genuinely knows and C++
// does not: the sim's cars carry no livery and no display name, because neither
// changes an outcome. So a roster crosses the ttp_display_build boundary, and
// this is where it stops being text.
//
// IT USED TO CROSS TWICE, in two shapes. The ids went as a JSON array
// (ttp_display_build's second argument) and the liveries went as "track.bin" —
// a version-stamped little-endian buffer that public/shared/trackBin.js packed
// and TtpRenderer.cpp unpacked, with the layout written down in a comment on
// each side. Two encoders of one list, in two languages, is exactly the drift
// the corpora exist to catch and the one thing they could never see: no fixture
// anywhere held a track.bin. Worse, it was work every shell had to redo, since
// a tvOS display would have needed its own byte-exact writer to render a name
// plate. Both halves are gone; the roster is one JSON argument and the
// arithmetic below is written once.
//
// Nothing here names a platform API, which is why it is in libttp-runtime and
// not beside the ABI: runtimetest/frame_check.cc compiles and runs it on all
// four legs, where the shim is built only with a Filament SDK and no ctest ever
// reaches it.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "ttp/scalar_id.h"
#include "ttp_render.h"

namespace ttp {
namespace rt {

// A parsed roster, split the way the two consumers want it: the frame builder
// tracks SLOTS by id, and the renderer dresses them. Both vectors are in slot
// order and always the same length.
struct Roster {
  std::vector<ScalarId> ids;
  std::vector<TtpRosterCar> cars;
};

// Parse ttp_display_build's roster argument:
//
//   [{"id": <scalar>, "name": "…", "carIndex": <n>, "color": "#rrggbb"}, …]
//
// Lenient in the ABI's usual way — a malformed argument yields an EMPTY roster
// rather than a failure, because a scene with no name plates is a better answer
// than no scene. Entries missing `id` are dropped (a slot with no identity can
// never be matched to a car); every other field falls back.
Roster parseRoster(const char* json);

// The rear name plate's height on a model's back panel, in world Y, indexed by
// the car's position in CAR_MODELS. Hand-tuned per model because the plate sits
// on a flat rear surface the renderer cannot raycast for the way a scene graph
// could.
//
// TOTAL over int: an index past the last model wraps, matching the shell's own
// modulo, and a NEGATIVE one wraps forward rather than falling through. That
// last part is a small, deliberate divergence from the retired JS, where
// `PLATE_Y[i % 4] ?? null` handed a negative index the -1 "auto" fallback. A
// carIndex is a seat's chosen car (0..3), so neither answer is reachable; this
// one is stated because frame_check pins it.
float plateY(int carIndex);

// '#rrggbb' -> the 0xAABBGGRR word the renderer wants, opaque.
//
// Parsing is JS `parseInt(hex, 16)`: leading hex digits only, stopping at the
// first byte that is not one, and NO digits at all reads as 0 (parseInt's NaN,
// which the JS writer's bit-ops then turned into opaque black). An ABSENT
// colour is the grey the JS default was; an unparseable one is that black. The
// two answers differ, and they did before the port too.
uint32_t liveryABGR(const std::string& css);

}  // namespace rt
}  // namespace ttp
