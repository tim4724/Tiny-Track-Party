// showcase — the ASSET GALLERY's world: every biome's vocabulary at once.
//
// The gallery (/gallery-assets.html) exists to answer one question — "what does
// this game actually draw?" — and the honest answer is spread across six
// biomes. A grass track carries three landmark kinds and two tree models; the
// snow cup's pines and the playroom's wind-up train are drawn by the same
// renderer and are simply never in the same scene. So this layer builds the
// scene that has never existed in play: the picked biome's PALETTE (its sky,
// ground, road, light rig, water and ice — the look), carrying the UNION of
// every biome's VOCABULARY (its scenery models, hero landmarks, ground clutter
// and fliers — the things).
//
// The split is deliberate and is the whole design. What a thing IS gets unioned;
// what it LOOKS LIKE stays the picked biome's, because a gallery that averaged
// six palettes together would show a world that ships nowhere. Flying the same
// showroom in `grass` and then in `canyon` is how the same cactus gets judged
// under two suns.
//
// Here rather than in the renderer for the reason everything else in
// libttp-runtime is here: it names no platform API, so every leg compiles AND
// ctests it (showcase_check). And here rather than in theme.cc because that file
// is held byte-for-byte against a frozen JS-recorded corpus — this is new data
// with no JS twin, and it must not be able to move a single number of the
// palette the shipping game draws with.
#pragma once

#include <string>
#include <vector>

#include "ttp/theme.h"

namespace ttp {
namespace rt {

// The scenery GLBs the showcase stages, in the slot order a shell must provide
// them in (scenery<i>.glb — the renderer binds its instanced props by that
// index). Deduped by first appearance walking the biomes in ?biome= list order,
// so it is a function of the palette tables alone: a shell asks, it does not
// keep a list of its own.
const std::vector<std::string>& showcase_models();

// The showcase world for `biomeName`, on `trackId`. Everything a track's own
// theme decides is unchanged (resolve_theme's per-track ambient patch and
// shoreline seed included); what is added is the rest of the kit.
//
// NOT reachable from resolve_theme and never resolved for a race: a shell asks
// for this explicitly (ttp_display_showcase), and nothing on the shipping path
// does.
Theme showcase_theme(const char* biomeName, const char* trackId);

// What that world holds, for the gallery's legend:
//
//   {"scenery":[…GLB names…],"landmarks":[…names…],"clutter":[…names…],
//    "fliers":[…names…]}
//
// Canonical JSON, keys sorted, as every ttp_*_json boundary but ttp_ui.h's is.
// The names are for HUMANS to read beside the thing they name — they are not an
// id anything resolves by, which is why a legend can live here at all: a shell
// that drew its own list would be maintaining a second copy of what is staged.
std::string showcase_inventory_json();

// ---------------------------------------------------------------------------
// THE STANDING EXHIBITS.
//
// Three of the things the renderer draws exist ONLY while cars are racing: a
// rocket in flight, the monster truck, and a dropped banana. A gallery that can
// show them only under its Drive toggle is showing them the way a race does,
// which is to say briefly and from behind.
//
// The BANANAS need nothing here — the showroom track authors three of them
// (shared/devTracks.js) and an authored banana respawns, so it is live from the
// first frame. The other two cannot be authored into a track descriptor at all:
// a rocket is a homing projectile with an owner and a fuse, and the monster
// truck is a TRANSFORM OF A CAR rather than a prop. So they are staged at frame
// time instead (frame_builder.cc), and only while the field is PARKED. The
// moment Drive lets the AI out, what is on screen should be what the sim
// actually produced.
//
// Here rather than in the frame builder for the same reason the theme union is
// here: this is the gallery deciding what to exhibit, and the gallery's
// decisions sit in one dev-only file that the shipping path cannot reach.
// ---------------------------------------------------------------------------

// A rocket stood on the showroom's furniture straight: its track position as a
// LAP FRACTION (the unit a track descriptor places furniture in) and a lateral
// offset in the same units a banana's is. The renderer hovers and whizz-rolls
// it exactly as it does one in flight, so the exhibit IS the in-race object and
// not a still of it.
struct ShowcaseRocket { float u, lat; };
const std::vector<ShowcaseRocket>& showcase_rockets();

// Which roster slot wears the monster rig while the field is parked, or -1 for
// a field with no slot to spare. The LAST one, which on a grid is the back row:
// where a catch-up item belongs, and behind the lineup shot the gallery opens
// on rather than in the middle of it.
int showcase_monster_slot(int rosterSize);

}  // namespace rt
}  // namespace ttp
