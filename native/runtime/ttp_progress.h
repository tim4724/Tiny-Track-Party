// ttp_progress.h — INTERNAL seam over the couch's progression record. Not an
// ABI: the record itself is owned by ttp_ui.cc (loaded via ttp_ui_progress_load,
// read back via ttp_ui_progress_json), and this header is how the OTHER shims in
// this module reach the same store — the race executor banks a finished series
// here, and the net walks ask the lock before accepting a pick or dealing a
// draw. A second copy of the record in any shim is the drift this seam exists
// to prevent (see native/CLAUDE.md, "Seams").
#pragma once

#include <string>
#include <vector>

#include "ttp/canonical.h"

// Bank a finished series' final standings under `cupId` ("tour" included;
// "random" and unknown ids are refused inside). `aiByRank` is the standings'
// ai flags in rank order. Returns 1 when the stored record improved.
int ttp_progress_bank(const std::string& cupId, const std::vector<bool>& aiByRank);

// The current record as a Value — the persist effect's payload.
ttp::Value ttp_progress_value(void);

// The lock, honouring the dev unlockAll override. Unknown cup ids are open.
bool ttp_progress_cup_unlocked(const std::string& cupId);
