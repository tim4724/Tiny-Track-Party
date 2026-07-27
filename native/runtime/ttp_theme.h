// ttp_theme.h — the BIOME half of the runtime C ABI: what a shell still needs
// to know about the per-cup look. Sibling of ttp_runtime.h (sim), ttp_party.h
// (party) and ttp_display.h (surface/scene/frame), same conventions
// (ttp_abi.h).
//
// The point of this layer is how little is in it. The palette itself —
// ~120 colours and intensities per biome, the light rig, the road, the scenery,
// the air — never crosses: ttp_display_build resolves the biome from the track's
// own cup and hands libttp-renderer the whole thing in-process. What a shell
// gets is only what a shell genuinely draws or names for itself:
//
//   - the biome NAME, because the shell owns the music (the race song is picked
//     from a per-biome pool) and the ?biome= override list,
//   - one COLOUR each for two 2D widgets the renderer does not draw: the HUD
//     boost chip's stroke and the biome swatch in the music gallery,
//   - the scenery MODEL LIST, because fetching bytes is a platform job and the
//     shell has to know which GLBs to fetch and in what slot order.
//
// Anything beyond that belongs on the C++ side of ttp_display_build. Adding a
// getter here to re-implement a piece of the look in a shell is the thing this
// header exists to make obviously wrong.
//
// Unlike the rest of the display ABI this is NOT behind the Filament gate: the
// biome tables are plain data in libttp-runtime, so a shell can name a biome
// (for its music, its debug panel) with no renderer in the build at all.
#ifndef TTP_THEME_H
#define TTP_THEME_H

#include <stdint.h>

#include "ttp_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

/* How many biomes there are, and the name of one by index. The ORDER is the
 * order a biome picker shows them in, and is user-visible. Out of range returns
 * "" rather than null, so a shell can loop without a null check. */
TTP_ABI int ttp_theme_biome_count(void);
TTP_ABI const char* ttp_theme_biome_name(int index);

/* Whether `name` names a biome — the validity test for a ?biome= override, whose
 * contract is that an unknown name is IGNORED (the cup decides) rather than
 * being an error. 1 = yes, 0 = no. */
TTP_ABI int ttp_theme_has_biome(const char* name);

/* The biome a cup, or a track, resolves to. Both fall back to "grass" (the
 * canonical Sunny Circuit look) for an unknown/absent argument, so a cup with no
 * biome mapping and a dev-only track with no cup are both safe to ask about.
 * The returned pointer is a static table entry and stays valid. */
TTP_ABI const char* ttp_theme_biome_for_cup(const char* cupId);
TTP_ABI const char* ttp_theme_biome_for_track(const char* trackId);

/* The HUD item chip's boost stroke for a biome, as 0xRRGGBB (sRGB).
 *
 * This is boostShades().icon — the biome accent darkened for contrast on paper.
 * The chip is DOM/SwiftUI/Compose, not 3D, which is the whole reason a colour
 * crosses here at all: every other surface that wears the accent (the pad disc,
 * the launch strip, the under-car aura, the wind streaks) is drawn by the
 * renderer from the same one recipe, in C++. An unknown biome yields grass's. */
TTP_ABI uint32_t ttp_theme_boost_icon(const char* biomeName);

/* A biome's horizon-hill colours, as 0xRRGGBB — hills[0] is the biome's identity
 * swatch (the music gallery's per-cup dot). Out of range returns 0. */
TTP_ABI uint32_t ttp_theme_hill_color(const char* biomeName, int index);

/* The scenery GLBs this biome stamps, as a JSON array of base names in SLOT
 * order: the shell fetches them and hands each back as "scenery<i>.glb", where i
 * is its index here. The renderer binds its instanced props by that index, so
 * the order is the contract, not a suggestion.
 *
 * Points at a static scratch buffer valid until the next call. */
TTP_ABI const char* ttp_theme_scenery_models(const char* biomeName);

#ifdef __cplusplus
}
#endif

#endif /* TTP_THEME_H */
