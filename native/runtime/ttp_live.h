// ttp_live.h — INTERNAL gathers shared by the runtime shims, not an ABI.
// Sibling of ttp_room.h / ttp_session.h: the shell names handles, C++ reads
// what is behind them. These three exist because the same gather feeds more
// than one shim file (ttp_ui.cc and ttp_race.cc), and a second spelling of a
// gather is exactly the drift the seams exist to stop. Implemented in
// ttp_ui.cc, which already owns every reader they compose.
#ifndef TTP_LIVE_H
#define TTP_LIVE_H

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

#endif  // TTP_LIVE_H
