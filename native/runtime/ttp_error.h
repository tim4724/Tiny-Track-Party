// ttp_error.h — why the last call refused.
//
// THE ONE THING THIS ABI COULD NEVER SAY. Every refusal in the tree is a `0`, a
// `null` or an empty array: `ttp_session_begin` failed, `ttp_ui_configure`
// returned 0, `ttp_display_build` was non-zero. None of them carries a reason,
// so each shell invents one at its own throw site — and inventing it means
// guessing:
//
//     throw new Error(`ttp_session_begin failed for track '${track.trackId}'`)
//
// That message names the symptom. Unknown track? A lap count the builder
// refused? A catalogue nobody configured? The shell cannot tell, because it was
// not told. Three shells write three such guesses, and a fourth writes a fourth.
//
// It is also, in practice, the thing that costs the most: the tvOS port shipped
// six bugs and every one of them was SILENT — a legal-looking `0` or a key that
// read as absent. A refusal that says why turns a device round trip into a line
// of output.
//
// THE PATTERN IS NOT NEW, it is just not everywhere. `ttp_race_start_json`
// already answers `{"action":"none","reason":"room-state"|"scene"|"no-track"|
// "no-players"}` and is the nicest ABI in the tree to call precisely because of
// it. This generalises that to the calls whose return has no room for a reason.
//
// USAGE, and the whole contract:
//
//     if (!ttp_session_begin(id, seed, laps, nullptr))
//         log(ttp_last_error());          // read it IMMEDIATELY
//
// It is only meaningful straight after a call that reported failure. There is no
// clearing, no error codes and no severity — a string a human reads, in the same
// spirit as the `reason` above. Keeping it that small is deliberate: an error
// system that a shell has to interpret is another contract to get wrong, and
// this exists to remove one.
#ifndef TTP_ERROR_H
#define TTP_ERROR_H

#include "ttp_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Why the last failing call refused, or "" if nothing has failed yet.
 *
 * Points into a static buffer that the NEXT failing call overwrites, so copy it
 * out at once — the same rule every other const char* return in this ABI has.
 * Never null. */
TTP_ABI const char* ttp_last_error(void);

#ifdef __cplusplus
}  /* extern "C" */

#include <string>

namespace ttp {

// Record why a call is about to refuse. Returns nothing: every caller is on a
// path that already knows what it is returning, and threading a value through
// would only invite `return ttp_fail(...)` at sites whose failure value differs.
void set_error(std::string why);

// The offending input, quoted and BOUNDED, for a message that has to name what
// arrived. A chooser payload is ~7 KB and a rejected one is usually wrong in its
// first few bytes, so the whole thing in an error string is noise that hides the
// answer. Empty input reads as `(empty)` rather than `""`, because the two are
// different mistakes: a shell that passed nothing, and one that passed "".
std::string error_excerpt(const char* json, size_t max = 80);

}  // namespace ttp
#endif

#endif  /* TTP_ERROR_H */
