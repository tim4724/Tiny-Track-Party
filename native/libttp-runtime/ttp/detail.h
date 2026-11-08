// ttp/detail.h — THE DETAIL TIER: how much world a platform's GPU is handed.
//
// Two tiers. FULL is the world as authored. LITE is the same world with what a
// racer barely sees taken off the frame (native/renderer/CLAUDE.md, "The
// detail tier", has what and what each saves), so the weakest device can hold
// four players while the stronger ones keep the full world and the headroom
// over it.
//
// Header-only and inline: the display shim decides it, and the renderer, which
// may not link libttp-runtime, never needs more than the answer.
#pragma once

#include <cstring>

namespace ttp {
namespace rt {

enum class Detail { Full, Lite };

// A platform's tier, by the shell's Paper Balloon `pbp` value ("web", "tvos",
// "androidtv"; ttp_net.h). LITE ON THE ANDROID TV BOX ALONE: the Google TV
// Streamer at four players and 540 lines is the bar the scene budget's box
// calibration gates (scripts/scene-budget.mjs), and the Apple TV and the
// browser are stronger. `ask` ("full" or "lite") overrides the platform, so a
// tier can be filmed and priced where it does not ship (the web's ?detail=,
// the box's debug.ttp.detail); anything else, null included, leaves the
// platform's.
inline Detail detail_for(const char* platform, const char* ask) {
    if (ask && std::strcmp(ask, "lite") == 0) return Detail::Lite;
    if (ask && std::strcmp(ask, "full") == 0) return Detail::Full;
    return platform && std::strcmp(platform, "androidtv") == 0 ? Detail::Lite : Detail::Full;
}

inline const char* detail_name(Detail d) { return d == Detail::Lite ? "lite" : "full"; }

// THE TIER IN FORCE: what ttp_display_detail last handed a display, Full until
// one is told otherwise, as a fresh renderer is. Process state like the one
// display, and the live display's because every shell asks after each
// ttp_display_create. The frame-cost readout states it (ttp_perf.h), so a
// bench reports the world it measured, not the flag it passed — read here,
// never through a shell.
inline Detail& detail_in_force() {
    static Detail d = Detail::Full;
    return d;
}

}  // namespace rt
}  // namespace ttp
