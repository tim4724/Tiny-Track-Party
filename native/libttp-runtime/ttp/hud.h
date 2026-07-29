// hud — the per-player race HUD, read off the live Game into a packed block.
//
// This is public/display/uiModel.js's `hudRows`, ported. That function is four
// copies and one decision, and the decision is the item gate: a finished car is
// on a victory lap with no usable slot, so its item reads empty however full the
// engine says it is. Everything else here is the SNAPSHOT's own derivation
// (Game::displayLap, Car::rank, the empty-string-is-null item), taken from the
// sim rather than restated, so the block and `ttp_snapshot_json` cannot answer
// differently.
//
// CONFORMANCE. hudRows is covered by tests/fixtures/ui-corpus.jsonl, recorded
// against the JS while it existed — the only class of fixture that settles a
// parity question (tests/fixtures/traces/README.md). runtimetest/hud_check.cc
// replays every `hud` step of it through `hudSlot` below. That is why the rule
// is a free function over plain values rather than a method on Game: the corpus
// carries snapshot-level values, not a race.
//
// Split out of frame_builder.cc on purpose. The frame builder assembles what the
// RENDERER draws, sixty times a second; this assembles what the SHELL reads, six
// times a second. They share a DisplayState and nothing else.
#pragma once

#include <cstdint>
#include <string>

#include "ttp/frame_builder.h"
#include "ttp_hud.h"

namespace ttp {

struct Car;
class Game;

namespace rt {

// The item vocabulary as a TTP_ITEM_* code: the index of `id` in ttp::ITEM_IDS
// plus one. "" is TTP_ITEM_NONE (the sim's empty slot, and JS's `item || null`);
// anything else unrecognised is TTP_ITEM_UNKNOWN rather than NONE, so a shell is
// never told an occupied slot is empty.
int32_t itemCode(const std::string& id);

// One car's HUD values, from the values a snapshot would have carried. The whole
// of hudRows' behaviour lives here, which is what makes it replayable against
// the JS-recorded corpus without a Game.
//
// `hasFinishTime` is JSON's null distinction, kept: a car can be finished with
// no recorded time (a forfeit resolved at the flag), and the shell prints an
// empty string for that rather than "0.0s".
TtpHudSlot hudSlot(int32_t place, int32_t lap, int32_t totalLaps,
                   const std::string& item, bool finished,
                   bool hasFinishTime, double finishTime);

// The block for `d.roster`, in slot order, off the bound session's live Game
// (nullptr = no session: every slot comes back dead). Never returns null; the
// pointer is valid until the next buildHud on the same state.
//
// The body of ttp_display_hud, here rather than in the ABI shim: it names no
// platform API, and the shim compiles only with a Filament SDK, where no ctest
// on any leg would ever run it. (This used to cite cellRects as the precedent.
// It was a bad one — that declaration was dead and its premise was wrong; see
// frame_builder.h. This one is the real article: hud_check executes it.)
const TtpHudBlock* buildHud(DisplayState& d, const Game* eng);

}  // namespace rt
}  // namespace ttp
