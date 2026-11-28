// showcase — the ASSET GALLERY's world: the kit stood on flat ground.
//
// /gallery-assets.html answers "what does this game actually draw?" by standing
// every model the shipping biomes and catalogue tracks use, on coloured pads,
// one pad per biome plus a neutral pad for the cars and the items. There is no
// race, no single biome palette, and no model bench: a filter mask drops a
// category's spots and leaves the model lists alone, so the shell's GLB slots
// do not move when a chip is toggled.
//
// Here rather than in the renderer because it names no platform API, so every
// leg compiles and ctests it (showcase_check). And here rather than in theme.cc
// because that file is held against a frozen corpus — this must not be able to
// move a number the shipping game draws with. The renderer reads the result off
// Theme and does not call these functions.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "ttp/theme.h"

namespace ttp {
namespace rt {

// Scenery GLBs the gallery stages, in scenery<i>.glb slot order. Deduped by
// first appearance walking the biomes, then each biome's catalogue tracks.
// Independent of the filter mask and of which biome a caller names.
const std::vector<std::string>& showcase_models();

// Prop GLBs, in prop<i>.glb slot order. The showcase_models() contract.
const std::vector<std::string>& showcase_prop_models();

// Set-piece GLBs, in set<i>.glb slot order: every catalogue track's pieces,
// first appearance wins, filed onto that track's biome pad.
const std::vector<std::string>& showcase_set_models();

// The gallery world. `biomeName` and `trackId` do not restyle it — the sky is
// a fixed studio and the pads are every biome — and are kept so the two-arg
// call sites stay valid. `mask` is GalleryCat bits; 0 is pads with no spots,
// and is not coerced to GAL_ALL. Model lists are the full union either way.
//
// NOT reachable from resolve_theme and never resolved for a race: a shell asks
// for this explicitly (ttp_display_showcase).
Theme showcase_theme(const char* biomeName, const char* trackId, uint32_t mask = GAL_ALL);

// Where the pads are, and the category vocabulary, for the gallery chrome:
//
//   {"bounds":{"x0","x1","z0","z1"},
//    "categories":["cars","items","scenery","props","landmarks","clutter","set"],
//    "pads":[{"name","x0","x1","z0","z1"}, ...]}
//
// Canonical JSON, metres rounded to millimetres. `bounds` is the OPENING pad
// for this mask: the one with the most spots, else the kit. It is not the
// whole row. `pads` is every pad in order (kit, then each biome), empty ones
// included, so a button can frame one after a filter has moved it. Categories
// are the vocabulary, always in bit order, not the filter.
std::string showcase_inventory_json(uint32_t mask = GAL_ALL);

}  // namespace rt
}  // namespace ttp
