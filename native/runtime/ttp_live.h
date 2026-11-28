// ttp_live.h — INTERNAL gathers shared by the runtime shims, not an ABI.
// Sibling of ttp_room.h / ttp_session.h: the shell names handles, C++ reads
// what is behind them. These exist because the same gather feeds more than
// one shim file (ttp_ui.cc and ttp_race.cc), and a second spelling of a
// gather is exactly the drift the seams exist to stop. Implemented in
// ttp_ui.cc, which already owns every reader they compose, except the bag
// (ttp_net.cc) and the lobby preview order (ttp_race.cc).
#ifndef TTP_LIVE_H
#define TTP_LIVE_H

#include <string>
#include <vector>

#include "ttp/ui_model.h"

namespace ttp {
struct Value;
}

// The auto-pause arbitration, whole: input gathered off the two handles, the
// consult rule asked, the party layer's answer read through the synced seam
// exactly when the decision wants it. Answers the decision's Value
// ({action, asked[, autoPaused]}) — the shape ui::autoPause spells.
ttp::Value ttp_live_auto_pause_decision(int sessionHandle, int roomHandle, int raceEnded);

// The finish moment's "every connected human is home", off the live handles —
// the same role-set gather ttp_ui_race_flow_live_json answers from.
bool ttp_live_humans_all_done(int sessionHandle, int roomHandle);

// The room's roster as ui entries, whole and in join order. `connectedOnly`
// applies the ui model's connectedPlayers rule (who a race would seat).
std::vector<ttp::rt::ui::RosterEntry> ttp_live_roster_players(int roomHandle,
                                                              bool connectedOnly);

// COMPOSE the standings board off the live handles and RETAIN it behind the
// room (ttp_room_store_board) — the only write path onto that slot other than
// the in-place patches. `resultsRowsOrNull` is the end-of-race walk's own
// result rows, which no effect can carry; null reads the live session instead,
// the either-or broadcastStandings always had.
//
// ANSWERS false AND STORES NOTHING WHEN THERE IS NO LIVE SESSION. That guard
// was shell state — all three broadcastStandings implementations bailed on it —
// and it is not cosmetic: without a session the compose yields an EMPTY board,
// which is not "no board" to a phone (the results overlay is raised by
// `standings` being non-null) but an empty results screen over every wheel.
bool ttp_live_store_standings(int sessionHandle, int roomHandle, bool over,
                              const ttp::Value* resultsRowsOrNull, double autoAdvanceMs);

// One draw from the room's shuffle bag ("" when unseeded or the catalogue is
// empty — the bagless refusal). Implemented in ttp_net.cc, which owns the
// chooser catalogue the deck shuffles over; drawn by the net mode-pick walk
// and the race start/return/apply walks.
std::string ttp_live_bag_draw(int roomHandle);

// The same bag rng RESTRICTED to one cup's tracks (the World Tour's draws) —
// advances the seed, leaves the global deck alone. Same "" refusals.
std::string ttp_live_bag_draw_cup(int roomHandle, const std::string& cupId);

// The next `n` global draws, computed on a copy of the bag. The room's bag
// is unchanged — a preview that consumed draws would race Start for them.
// Stops early on the same "" refusal bagDraw returns.
std::vector<std::string> ttp_live_peek_draws(int roomHandle, int n);

// One cup-restricted draw per cup id, in the order given, on a copy. Stops
// on the first "" (an unknown cup, an unseeded bag). The room's bag is
// unchanged.
std::vector<std::string> ttp_live_peek_cups(int roomHandle,
                                            const std::vector<std::string>& cups);

// The no-repeat walk still in this shuffle: the deck from the cursor on, or,
// when the deck is spent, the whole deck one refill would deal. Never a
// second refill, and never stored. A fresh {seed} bag is the spent case.
std::vector<std::string> ttp_live_peek_walk(int roomHandle);

// The circuits the lobby preview tours, in the order Start will race them.
// Empty when the pick names no track. A cup is its authored list; a fixed
// random or a tour is race 1 plus the peeks Start would draw (capped the
// same way); endless is race 1 plus one peek_walk. Does not draw.
std::vector<std::string> ttp_live_preview_order(int roomHandle);

#endif  // TTP_LIVE_H
