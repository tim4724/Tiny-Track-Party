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
 * (ttp_ui_item_pushes_json) carries three fields per car, and the shell picks how
 * often to ask — the web one folds it into the same tick as the HUD read.
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
 * The catalogue must be in CUPS order — a cup's difficulty is read off its
 * FIRST entry, which is public/shared/tracks.js's own arrangement.
 *
 * Returns 1 when the text parsed, 0 otherwise (the previous catalogue then
 * stands). Unset, every lookup simply misses: a cup slot resolves no name, a
 * seat grid pads to nothing. */
TTP_ABI int ttp_ui_configure(const char* json);

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

/* The roster as the seat grid sees it, with the host marked. Pure projection —
 * the ORDER is the room's (join order) and is never re-sorted.
 *   roster  [{"peerIndex":id,"name","colorIndex":n,"carIndex":n|null,
 *             "connected":bool,"ready":bool}, ...]
 *   host    a JSON scalar id, or "null"
 *   ->      [{"name","colorIndex","carIndex","connected","host","ready"}, ...] */
TTP_ABI const char* ttp_ui_roster_seats_json(const char* rosterJson, const char* hostIdJson);

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

/* START_GAME gate: 1 when the race may begin. The host's start IS their
 * commitment, so they never ready up; everyone else must, and an empty lobby
 * cannot start. Same roster/host arguments as above. */
TTP_ABI int ttp_ui_all_racers_ready(const char* rosterJson, const char* hostIdJson);

/* Who a race would seat: connected seats only — a dropped racer's seat lingers
 * (dimmed, with a reconnect QR) but gets no car until they are back.
 *   -> a JSON array of INDICES into `roster`, ascending.
 * Indices rather than the entries, so the shell keeps its own objects (and
 * whatever it hangs off them) instead of racing a copy that came back through
 * a serializer. */
TTP_ABI const char* ttp_ui_connected_players_json(const char* rosterJson);

/* The lobby's right-rail race card, from the room's pick.
 *   {"mode":"cup"|"track"|"random"|null, "cupId":"id"|null, "trackId":"id"|null,
 *    "randomRaces": n|null}
 * randomRaces is RANDOM mode's run length — 0 endless, a positive integer that
 * many races, absent/null endless (what `random` meant before run lengths). The
 * shell clamps it before it gets here; the other two modes ignore it.
 *   -> null                      no pick yet — the slot stays empty
 *   -> {"nameKey":"cup"|"track"|"random",   what the name IS
 *       "name": str|null,                   null for random / an unresolved id
 *       "racesKey":"count"|"one"|"endless", how many races the pick means
 *       "raceCount": n|null,                meaningful only for "count"
 *       "difficulty": n|null,
 *       "maps":[{"trackId":str|null,"n":n?}, ...],
 *       "cupId": str|null}
 * `maps` names the circuits to draw as minis BY TRACK ID; the schematic payload
 * is the shell's to look up. A cup numbers them (n = 1..4) — that numbering is
 * the GP menu at a glance and belongs to the model. */
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

/* Which phones need an ITEM push this tick. The held item lights the phone's
 * USE button, it is per-owner, and it rides its own message sent ONLY ON
 * CHANGE. A finished car is on a victory lap with no usable slot, so its item
 * reads empty however full the engine says it is. AI cars have no phone.
 *   cars      [{"id":id,"item":str|null,"finished":bool}, ...]
 *   aiIds     [id, ...]
 *   lastItem  [{"id":id,"item":str|null}, ...] what each phone was last told,
 *             in Map insertion order
 *   ->        [{"id":id,"item":str|null}, ...]
 *
 * THREE STATES, not two, and this is why the `item` key may be ABSENT rather
 * than null in any of the three arrays above: JS distinguishes a missing item
 * field from an explicit null and `!==` sees the difference, so a car whose
 * slot went from null to absent pushes again. The empty string is a fourth
 * value and is NOT folded to null here (the HUD block does fold it — a drawn
 * slot and a USE button are different questions).
 *
 * PURE: the caller applies the answers to its own map, and clears that map per
 * race so the first tick resends every phone's empty slot. The map is one of
 * the three pieces of state that stay with the shell. */
TTP_ABI const char* ttp_ui_item_pushes_json(const char* carsJson, const char* aiIdsJson,
                                            const char* lastItemJson);

/* The same rule for a single car, for the one-shot relight a (re)joining phone
 * gets. `car` is one entry of the array above, or "null" for a seat with no
 * live car. Returns the item as a bare JSON value: a quoted string, or null. */
TTP_ABI const char* ttp_ui_welcome_item_json(const char* carJson);

/* ---- race flow ----------------------------------------------------------- */

/* The two answers the finish moment needs, off one car list.
 *   {"carIds":[id,...],"aiIds":[id,...],"disconnectedIds":[id,...],
 *    "finishedIds":[id,...]}
 *   -> {"allDone":bool, "forfeit":[id, ...]}
 * allDone is true once every CONNECTED human car has crossed the line (CPU cars
 * may still be out) — the cue to fast-forward the deterministic sim to the flag
 * instead of making the humans watch bots crawl home. False with no connected
 * humans left at all; the race-timeout failsafe covers that field.
 * forfeit names the ghosts to remove at that moment: a dropped human's car can
 * never cross the line, so the burst would otherwise run to its guard cap on a
 * car that cannot finish. */
TTP_ABI const char* ttp_ui_race_flow_json(const char* json);

/* ---- pause arbitration --------------------------------------------------- */

/* The manual overlay pause (any player's controller, or the on-screen button).
 * roomState is the wire spelling ("lobby"/"countdown"/"playing"/"results"); any
 * other string is simply not a race state. */
TTP_ABI int ttp_ui_can_pause(int hasSession, int paused, const char* roomState);
TTP_ABI int ttp_ui_can_resume(int hasSession, int paused);

/* The SILENT auto-pause — a race with no connected human driving is a race
 * nobody is playing. Input for both calls below:
 *   {"hasSession":bool,"raceEnded":bool,"roomState":str,
 *    "carIds":[id,...],"aiIds":[id,...],"seatedIds":[id,...]}
 *
 * Would the decision CONSULT the party layer for this input? Reading that
 * answer is not free on the shell side — it pushes the live car set into the
 * room machine first — so a shell asks here and reads it exactly on the ticks
 * the decision needs it, instead of eagerly on every roster change. */
TTP_ABI int ttp_ui_auto_pause_asks(const char* json);

/* The decision itself.
 *   -> {"action":"none"|"return-to-lobby"|"set", "asked":bool, "autoPaused":bool?}
 *   none             nothing to arbitrate (no race, or already over)
 *   return-to-lobby  no human seat is left in this race at all — nothing to
 *                    wait for, so the room goes back to the lobby and any late
 *                    joiners get seated in the next race immediately
 *   set              carry on, with `autoPaused` as given (that key is present
 *                    only for "set")
 * The freeze is a PLAYING-state thing on purpose: freezing the COUNTDOWN would
 * strand the room short of the only state the abandoned-race grace runs in, so
 * a field that dropped during the beats would never reach the deadline that
 * recovers the room. Nothing moves before GO anyway.
 *
 * `allParticipantsDisconnected` is NOT re-derived here: it is the party layer's
 * answer over the same participant set the abandoned-race grace waits on, which
 * is what keeps the silent freeze and that policy from ever disagreeing. Pass
 * 0 when ttp_ui_auto_pause_asks said no. */
TTP_ABI const char* ttp_ui_auto_pause_json(const char* json, int allParticipantsDisconnected);

/* What the combined freeze state means for the SIM's clock, given where the sim
 * currently is: "freeze" | "thaw" | "none". One writer, so neither pause path
 * drives pause()/resume() itself — a manual resume while every racer is still
 * gone keeps the field frozen, and a reconnect during a manual pause keeps the
 * overlay's authority. */
TTP_ABI const char* ttp_ui_freeze_transition(int paused, int autoPaused, int sessionPaused);

/* ---- the Grand Prix chip ------------------------------------------------- */

/* The cup's progress chip carried on every standings board.
 *   {"cupId":str|null,"cupName":str|null,"endless":bool,"raceIndex":n,
 *    "raceCount":n|null,"finished":bool,"nextTrackId":str|null,
 *    "autoAdvanceMs":n}
 *   -> {"cupId","cupName","endless","raceIndex","raceCount","nextTrackId",
 *       "nextTrackName","final","autoAdvanceMs"}
 * raceCount is null for endless random play (there is no "of N"), nextTrack* is
 * null after a cup's last race, and `final` marks the podium (never for
 * endless). autoAdvanceMs lets the phones caption the auto-start. */
TTP_ABI const char* ttp_ui_series_info_json(const char* json);

/* ---- the standings board ------------------------------------------------- */

/* ONE board, rendered by the TV and by every phone — pushed as each car
 * finishes (over=false) and once more at race end (over=true, so DNF/AFK cars
 * resolve and everyone, not just finishers, sees the final board).
 *   {"results":[{"playerId":id,"finished":bool,"time":n|null}, ...],
 *    "field":  [{"peerIndex":id,"name","colorIndex":n,"ai":bool}, ...],
 *    "cup":    null | {"standings":[{"playerId":id,"points":n,"gained":n}, ...],
 *                      "info": <a ttp_ui_series_info_json answer>},
 *    "lateJoiners":[{"peerIndex":id,"name","colorIndex":n}, ...],
 *    "hostPeerIndex": id, "over": bool}
 *   -> {"over","hostPeerIndex",["series"],"total","order":[row, ...]}
 *
 * The board is enriched from the race FIELD because the AI racers are not in
 * the lobby roster the phones know, so the display is the only side that can
 * name and colour them. Late joiners are listed UNDER the racers, flagged
 * `joining`, so every board shows who is waiting on the next race instead of
 * silently omitting them; a joining row carries nothing else — it is a
 * different shape on the wire, not a racer with empty fields.
 *
 * A cup board stamps every racer's banked points and re-sorts the FINAL board
 * into cup-standings order; live boards stay in RACE order, because mid-race
 * the drama is who crosses the line, not the tally.
 *
 * THE KEY ORDER OF THIS ANSWER IS THE WIRE'S. See the deviation note at the top
 * of this header. */
TTP_ABI const char* ttp_ui_standings_json(const char* json);

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
