/* ttp_ui.h — the UI MODEL half of the runtime C ABI: every "what should the
 * screen say" decision the display owns. Sibling of ttp_runtime.h (sim),
 * ttp_party.h (party), ttp_display.h (renderer) and ttp_audio.h (sound), same
 * conventions (ttp_abi.h) except for the one stated below.
 *
 * WHAT IS BEHIND IT. libttp-runtime/ttp/ui_model.{h,cc} — the seat grid, the
 * lobby readiness rule, the lobby race card, the ITEM-push gate, the
 * reconnect-card diff, the race-flow predicates, the pause arbitration, the
 * standings board + the cup chip + the results overlay, and the screen enum
 * with its per-screen back EFFECT. Pure functions of plain data, replayed step
 * for step against tests/fixtures/ui-corpus.jsonl (recorded off
 * public/display/uiModel.js while it was live) by runtimetest/ui_check.cc on
 * every leg. This header is only how a SHELL reaches them.
 *
 * WHY JSON, AND NOT A PACKED BLOCK. ttp_hud.h and ttp_audio.h pack because they
 * are read on the frame path and every field is a number. This layer is the
 * opposite on both counts: it answers ONCE PER EVENT — a join, a rename, a
 * pick, a car crossing the line, a race ending — and half of what it answers is
 * TEXT of unbounded length (player names, cup and track names, track ids). A
 * packed record cannot hold a name without inventing a string table and a
 * second read, so the precedent that fits is ttp_room_events_json's: bursty,
 * string-shaped data, drained as JSON. The one call on anything like a cadence
 * (ttp_ui_item_pushes_live_json) is a live gather with one shell-owned input,
 * and the shell picks how often to ask — the web one folds it into the same
 * tick as the HUD read.
 *
 * There is a second reason, and it is the deciding one for the standings board:
 * that answer IS a JSON message. The shell puts it on the relay verbatim, so a
 * JSON ABI hands it straight through instead of decoding a struct only to
 * re-encode the same object.
 *
 * THE ONE DEVIATION FROM ttp_abi.h. Returned JSON here is NOT canonical: keys
 * come out in the MODEL'S OWN order, not sorted. That is deliberate and it is
 * about those wire bytes — the board's key order is the order the phones have
 * received since the JS model wrote it, and sorting it would silently re-spell
 * a shipped message. Nothing hashes a UI answer, so the canonical convention
 * buys nothing here and costs that. (libttp-json's ordered_stringify is the
 * emitter; canonical_stringify keeps its sort and its evidence-only job.)
 *
 * STRINGS ARE KEYS, NOT COPY. Nothing user-facing crosses as English. A title,
 * a subtitle, a row's trailing cell, a race count and the back gesture's
 * meaning all come out as stable KEYS ("cup_champs", "points", "end-party")
 * plus data; player, cup and track names pass through as DATA. The copy tables
 * live in each shell, next to the elements they fill. A formatted sentence
 * coming out of here would be a defect.
 *
 * STATELESS, WITH ONE EXCEPTION. Every call is a pure function of its
 * arguments. The exception is the CATALOGUE (ttp_ui_configure): the cups, the
 * track list and the two field sizes are authored data that changes when the
 * game ships, not while it runs, so a shell sets it once at boot rather than
 * re-sending ~2 KB of it on every rename. ui_model.cc itself stays
 * catalogue-agnostic — it looks ids up in whatever list it is handed — which is
 * what lets the conformance corpus carry a synthetic world of its own.
 *
 * IDS. A player id crosses as a JSON scalar, exactly as in ttp_party.h: the
 * token `3` is the number 3 and `"3"` is the string "3", and they are different
 * players. Peer indices are numbers and bots are strings like "ai-0"; both flow
 * through the same board.
 *
 * NULL IS NOT ZERO. Half this layer's contract is which field is null — a seat
 * with no car pick, a cup with no difficulty, a DNF with no lap time, an
 * endless series with no "of N". Those come out as JSON null, never as 0 or "".
 */
#ifndef TTP_UI_H
#define TTP_UI_H

#include <stdint.h>   /* the cup tint answers a packed 0xRRGGBB */

#include "ttp_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---- the catalogue ------------------------------------------------------- */

/* The world every id in this ABI is resolved against, plus the two field sizes
 * the seat grid needs. Set once at boot; a later call replaces it wholesale.
 *
 *   {"maxPlayers": 4,          seats the lobby pads out to
 *    "carCount": 12,           models the thumbnail wraps a car pick into
 *    "cups":    [{"id","name","tracks":["id",...]}, ...],
 *    "catalog": [{"id","name","cup": "id"|null, "cupDifficulty": n|null}, ...]}
 *
 * OMIT BOTH LISTS AND YOU GET THE SHIPPED GAME. The cups, their display names,
 * every track name and the cup-tendency rule are codegen'd into this build
 * (generated/track_defs.h), so a shell that wants the real catalogue passes the
 * two field sizes and nothing else. It used to have to send ~2 KB of JSON
 * assembled out of its own copy of the catalogue — which meant every shell
 * carried the names and re-implemented the tendency, for data the wasm already
 * held. Read it back with ttp_ui_catalogue_json if you need to draw a picker.
 *
 * Given, the two lists OVERRIDE, and that is what the conformance corpus rides:
 * a synthetic two-cup world is the case that proves ui_model.cc looks ids up in
 * whatever list it is handed. Both or neither — a cups list with no catalog
 * would leave one lookup resolving while its neighbour missed.
 *
 * An overriding catalogue must be in CUPS order — a cup's difficulty is read
 * off its FIRST entry, which is public/shared/tracks.js's own arrangement.
 *
 * Returns 1 when the text parsed, 0 otherwise (the previous catalogue then
 * stands). Never called at all, every lookup simply misses: a cup slot resolves
 * no name, a seat grid pads to nothing. */
TTP_ABI int ttp_ui_configure(const char* json);

/* The SHIPPED catalogue, in the shape ttp_ui_configure takes it:
 *
 *   {"cups": [...], "catalog": [...]}
 *
 * This is data, not a decision, and it is here because a shell has to DRAW the
 * thing — the lobby's mode picker is a list of cup names with a difficulty
 * meter on each, and the phones' chooser payload is a list of track names. What
 * it deliberately does not carry is anything the shell already knows (the field
 * sizes) or anything only the renderer needs (geometry, palette).
 *
 * Always the shipped tables, never whatever ttp_ui_configure last installed:
 * the override exists for a synthetic conformance world, and answering with one
 * here would let a test's fiction reach a picker.
 *
 * Each cup row additionally carries the couch's DERIVED progression — `stars`
 * (0..3), `locked`, and on a locked row `unlockDone`/`unlockNeed` — and the
 * answer's top level carries `tour: {stars}` for the World Tour's own badge.
 * Derived from whatever ttp_ui_progress_load installed (nothing loaded = a
 * fresh couch: zero stars everywhere, the Playroom locked), so a shell reads
 * ONE catalogue and never re-implements a star threshold or the unlock rule. */
TTP_ABI const char* ttp_ui_catalogue_json(void);

/* ---- the couch's progression record -----------------------------------------
 *
 * The star record persists ON THE SHELL (localStorage / NSUserDefaults) but is
 * DECIDED here. At boot the shell hands the stored blob over once, exactly as
 * ttp_net_init_pick hands over the page's entropy:
 *
 *   ttp_ui_progress_load('{"v":1,"cups":{"beach":{"best":2}}}', 0)
 *
 * Null, empty or corrupt text loads a fresh couch rather than failing — a bad
 * save must not brick a boot. `unlockAll` nonzero is the dev/test override
 * (?unlockAll=1): the record still loads and banks, only the lock stops.
 *
 * From then on the engine owns the record: a finished Grand Prix banks the best
 * human's final standing and the race walk answers a `persist-progression`
 * effect carrying the new blob (`progress`), which the shell writes back
 * verbatim. ttp_ui_progress_json is the same blob on demand — canonical
 * key-sorted JSON, byte-stable for a given record. */
TTP_ABI int ttp_ui_progress_load(const char* jsonOrNull, int unlockAll);
TTP_ABI const char* ttp_ui_progress_json(void);

/* ---- cup paper colours ------------------------------------------------------
 *
 * The picker's five surface colours. They are AUTHORED — not derived from the
 * biome, which was tried and broke on two cups of five (a colour picked for a 3D
 * horizon is not legible as a pale paper wash; public/shared/trackPicker.js
 * records which two and how). So do not reach for ttp_theme.h to rebuild them.
 *
 * PORT SURFACE, same relationship as ttp_protocol_manifest_json:
 * public/shared/trackPicker.js stays the AUTHORED source (the phone picker is
 * permanent JS and both browser pages import it), the WEB shell deliberately
 * does not call these, and tests/ui-model.test.js pins this mirror to the JS.
 * A native TV shell reads these instead of hand-copying the table — the first
 * one copied it anyway, against a comment claiming no export existed. It does.
 *
 * The catalogue above carries each cup's `color` as packed 0xRRGGBB. These two
 * exist so that no shell re-implements the WASH:
 *
 * `pct` is how much of the colour survives a mix with white. The mix is in sRGB
 * on the ENCODED values — a straight per-channel lerp, which is what CSS
 * `color-mix(in srgb, …)` does. Mixing the same pair in linear light is a
 * one-line difference that comes out visibly darker and would match nothing
 * else on screen. A null/empty cup id gets the cup-less fallback, which is what
 * Random wears. */
TTP_ABI uint32_t ttp_ui_cup_tint_rgb(const char* cupIdOrNull, double pct);

/* FIELD_TINT: how much colour a schematic's field keeps. Shared so the phone's
 * picker and every TV lobby wash the same map to the same shade. */
TTP_ABI int ttp_ui_cup_field_tint_pct(void);

/* ---- screens ------------------------------------------------------------- */

/* The display's three boards are strictly ordered, so "forward" and "back" are
 * a subtraction: >0 = a forward step (the shell pushes one history entry), <0 =
 * a retreat (pop one), 0 = same level. Names are "welcome" / "lobby" / "race";
 * NULL, "" and any name this build does not know all count as the root, which
 * is what makes the first show() a push. */
TTP_ABI int ttp_ui_screen_step(const char* prevScreen, const char* nextScreen);

/* What the back gesture MEANS on a screen — the part every shell shares.
 * "swallow" | "end-party" | "return-to-lobby". HOW the gesture arrives
 * (popstate, the tvOS Menu button, Android's back stack) and how the stack is
 * WALKED are each shell's; only the table is here. */
TTP_ABI const char* ttp_ui_back_effect(const char* screen);

/* ---- the lobby ----------------------------------------------------------- */


/* THE SAME SEATS, READ STRAIGHT OFF A LIVE ROOM. Hand over a ttp_room_create
 * handle instead of the roster it holds.
 *
 * NO SESSION HANDLE, and the absence is the point: a Seat carries name,
 * colorIndex, carIndex, connected, host and ready — never inRace — so the seat
 * grid is a projection of the ROOM alone. The shell used to reach it by pulling
 * the roster out of the party ABI, ferrying it through the retained snapshot's
 * `players` rows and handing those back here, which made the lobby's own grid
 * depend on the wire message next to it.
 *
 * The roster crosses as ttp_room_roster_value (ttp_room.h), so this file gains
 * no edge on libttp-party — the LIBRARY rule (ui_model.h mirrors ROOM_STATE
 * rather than import it) is untouched; only this shim, which already links
 * both, reads across. */
TTP_ABI const char* ttp_ui_roster_seats_room_json(int roomHandle, const char* hostIdJson);

/* The seat grid itself: those seats padded with OPEN placeholders up to
 * maxPlayers, so the lobby card keeps a fixed size as players trickle in and
 * never shrinks below the field that actually races. Takes the array
 * ttp_ui_roster_seats_json returned.
 *   -> [{"open":true} | {"open":false,"name","colorIndex","carIndex",
 *       "modelIndex","off","host","ready"}, ...]
 * `off` is a held, dropped seat — dimmed, not removed. `modelIndex` wraps the
 * car pick into the model roster and is JS `%`, so a negative pick stays
 * negative: the shell's problem, not this layer's to launder. */
TTP_ABI const char* ttp_ui_seat_grid_json(const char* seatsJson);



/* The lobby's right-rail race card, from the room's pick.
 *   {"mode":"cup"|"track"|"random"|"tour"|null, "cupId":"id"|null,
 *    "trackId":"id"|null, "randomRaces": n|null}
 * randomRaces is RANDOM mode's run length — 0 endless, a positive integer that
 * many races, absent/null endless (what `random` meant before run lengths). The
 * shell clamps it before it gets here; every other mode ignores it (the TOUR's
 * count is the cup list itself).
 *   -> null                      no pick yet — the slot stays empty
 *   -> {"nameKey":"cup"|"track"|"random"|"tour",   what the name IS
 *       "name": str|null,                   null for random/tour / an unresolved id
 *       "racesKey":"count"|"one"|"endless", how many races the pick means
 *       "raceCount": n|null,                meaningful only for "count"
 *       "difficulty": n|null,
 *       "maps":[{"trackId":str|null,"n":n?,"cup":str?}, ...],
 *       "cupId": str|null}
 * `maps` names the circuits to draw as minis BY TRACK ID; the schematic payload
 * is the shell's to look up. A cup numbers them (n = 1..4) — that numbering is
 * the GP menu at a glance and belongs to the model. A chip with a null trackId
 * is an UNDRAWN race ("?" placeholder); only the tour emits those — ALL of its
 * chips, the already-drawn first race included, so the card spoils nothing —
 * and they carry `cup` so each placeholder wears that cup's colour. */
TTP_ABI const char* ttp_ui_cup_slot_json(const char* pickJson);

/* ---- dropped-seat reconnect cards ---------------------------------------- */

/* Which cards to take down and which to put up, given what is already showing.
 *   shownIds  [id, ...] the cards actually on screen, in the order they went up
 *   seatIds   [id, ...] the seats that want one, in seat order
 *   -> {"remove":[id, ...], "add":[index, ...]}   indices into seatIds
 * The CALLER keeps the shown set, which is why this only proposes: putting a
 * card up can FAIL (the seat's car may have no cell), so only the shell knows
 * what actually landed. */
TTP_ABI const char* ttp_ui_reconnect_diff_json(const char* shownIdsJson, const char* seatIdsJson);

/* ---- the ITEM push ------------------------------------------------------- */

/* Which phones need an ITEM push this tick, off the LIVE race: the cars (id /
 * held item / finished — a finished car is on a victory lap with no usable
 * slot, so its item reads empty) and the CPU set come off the session handle;
 * the shell supplies only lastItem — what each phone was last told, in Map
 * insertion order — because the push rides its own message sent ONLY ON
 * CHANGE and the map is the shell's outbox state.
 *   lastItem  [{"id":id,"item":str|null}, ...]
 *   ->        [{"id":id,"item":str|null}, ...]
 *
 * THREE STATES, not two: JS distinguishes a missing `item` key from an
 * explicit null and `!==` sees the difference, so a car whose slot went from
 * null to absent pushes again. The empty string is a fourth value and is NOT
 * folded to null here. PURE over the map: the caller applies the answers to
 * its own map, and clears it per race so the first tick resends every phone's
 * empty slot. */
TTP_ABI const char* ttp_ui_item_pushes_live_json(int sessionHandle, const char* lastItemJson);

/* The same rule for the one-shot relight a (re)joining phone gets: the
 * welcome-item effect names a seat, this answers that seat's held item off
 * the live race as a bare JSON value — a quoted string, or null (no live car,
 * or an empty slot; the relight message carries `item` directly). */
TTP_ABI const char* ttp_ui_welcome_item_live_json(int sessionHandle, const char* peerIdJson);

/* ---- race flow ----------------------------------------------------------- */


/* THE SAME PAIR, READ STRAIGHT OFF THE LIVE RACE. Hand over the session and
 * room handles instead of the four role sets — carIds and finishedIds come off
 * the engine, aiIds off the bot registry (the same set by construction: the
 * layer's buildField registers exactly those as bot personas), disconnectedIds
 * off the room. The shell used to assemble them by crossing the C boundary
 * twice per car per slow tick; the tvOS twin then misspelled the keys and the
 * absent sets read as legal. sessionHandle 0 answers the no-race constants
 * ({"allDone":false,"forfeit":[]}). */
TTP_ABI const char* ttp_ui_race_flow_live_json(int sessionHandle, int roomHandle);

/* ---- pause arbitration --------------------------------------------------- */






/* The transition AND what performing it means, in one answer:
 *   -> {"transition":"freeze"|"thaw"|"none",
 *       "ops":["pause-session","stop-voices","pause-music","hold-cars"]}   (freeze)
 *       ops ["resume-session","release-cars","resume-music"]               (thaw)
 *       ops []                                                             (none)
 * THE ORDER OF ops IS THE CONTRACT, and thaw is not freeze reversed —
 * deliberately (voices never restart on thaw; cars release before the music
 * returns). A shell walks the list and performs each op; re-spelling the
 * composition at the call site is how one shell already shipped frozen cars
 * that kept squealing. */
TTP_ABI const char* ttp_ui_freeze_plan_json(int paused, int autoPaused, int sessionPaused);

/* ---- the Grand Prix chip ------------------------------------------------- */


/* THE SAME CHIP, READ STRAIGHT OFF A ttp_gp_create HANDLE — all eight input
 * fields come from the series state (cup id/name off the cup, "" from
 * ttp_gp_next_track spelling null), so no caller can omit one and ship a
 * board whose podium never says `final` (the first TV shell did, over the
 * old per-field route). NOT SHELL SURFACE: no shell holds a series handle —
 * a shell's chip rides the standings board's `cup.info`, and its series read
 * is ttp_race_series_state_json. This export is the CONFORMANCE surface:
 * tests/ui-model.test.js pins the chip rule against the shipped catalogue
 * through it, and the abi ctest pins the board's chip to it. autoAdvanceMs
 * stays a parameter: the intermission budget is the caller's. gpHandle must
 * be live — 0 is not a series and answers "null". */
TTP_ABI const char* ttp_ui_series_info_live_json(int gpHandle, double autoAdvanceMs);

/* What the results board's one button DOES: "advance" mid-cup, else
 * "return-to-lobby". The LABEL for the same button is resultsView's
 * newGameKey; this is the branch behind the click, which the shells used to
 * re-derive from their series wrappers while the label came from here — the
 * two could disagree. gpHandle 0 (no cup) returns to the lobby. */
TTP_ABI const char* ttp_ui_results_action_json(int roomHandle);

/* ---- the standings board ------------------------------------------------- */


/* THE BOARD, GATHERED OFF THE LIVE HANDLES — every input:
 *   results      the race's own results OBJECT (the event drain's `results`
 *                answer, which no effect can carry), or "null"/NULL to read
 *                the live session — the same either-or broadcastStandings
 *                always had
 * The race FIELD is the room-retained launch copy (rename/rekey repairs
 * applied by the walks), the cup half is the room's stored series, and
 * lateJoiners + the host come off the room seam — no shell assembles a row.
 * autoAdvanceMs as in ttp_ui_series_info_live_json. */
TTP_ABI const char* ttp_ui_standings_live_json(int sessionHandle, int roomHandle,
                                               int over,
                                               const char* resultsJsonOrNull,
                                               double autoAdvanceMs);

/* The results overlay in its three dressings, as semantic values, off the board
 * above (pass its JSON straight back).
 *   plain single-race board  titleKey "results",    rows carry a lap time
 *   cup intermission         titleKey "standings" + a sub + a "next up" footer
 *   cup podium               titleKey "cup_champs", top three on the steps
 *   -> {"podium","intermission","titleKey","cupName",
 *       "sub": null|{"key":"cup_race"|"cup_race_of","cupName","race","of"},
 *       "podiumRows": null|[row, ...],
 *       "listRows":[row + {"kind":"time"|"points"|"joining"}, ...],
 *       "next": null|{"trackName","secs"},
 *       "newGameKey":"new_game"|"next_race"}
 * Rows come from the same board the phones get, so both screens always tell the
 * same story. Note the podium's split: the STEPS take the top three non-joining
 * rows while the list starts at index 3 of the RAW order, so a joining row
 * inside the first three shortens the steps without shifting the list. That is
 * deliberate and frozen — a shell that "fixes" it drops a racer off both. */
TTP_ABI const char* ttp_ui_results_view_json(const char* boardJson, double intermissionMs);

/* The intermission's "starting in N", against the auto-advance deadline. A
 * fresh ceil each beat rather than a decrementing counter, so it cannot drift. */
TTP_ABI double ttp_ui_intermission_secs(double deadlineMs, double nowMs);

#ifdef __cplusplus
}
#endif

#endif /* TTP_UI_H */
