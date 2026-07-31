/* ttp_race.h — the RACE ORCHESTRATION half of the runtime C ABI: the state
 * machine that starts a race, launches one, walks the countdown, ends it,
 * chains a cup and returns to the lobby. Sibling of ttp_ui.h (the screen
 * decisions), ttp_runtime.h (sim), ttp_party.h (party), ttp_display.h
 * (renderer) and ttp_audio.h (sound), same conventions (ttp_abi.h) except for
 * the deviation ttp_ui.h states and this header inherits.
 *
 * WHAT IS BEHIND IT. libttp-runtime/ttp/race_flow.{h,cc} — public/display/
 * raceFlow.js ported, replayed step for step against
 * tests/fixtures/raceflow-corpus.jsonl by runtimetest/raceflow_check.cc on
 * every leg. This header is only how a SHELL reaches it — and it reaches it
 * THE WAY ttp_net.h's walks do: every entry point takes the LIVE HANDLES
 * (room, session, cup series) and gathers its own inputs off them in C++.
 * Nothing about a roster, a pick or a race is serialized out of one layer by
 * the shell only to be handed straight back into this one. The hand-assembled
 * JSON spellings this surface used to carry are gone; the corpus replays the
 * decision layer directly (raceflow_check), and the `abi` ctest holds each
 * walk here to the same decision functions over the same state.
 *
 * EVERY ANSWER IS AN ORDERED EFFECT LIST, and that is the whole design. Nothing
 * here returns a verdict for a shell to sequence, because the sequencing is the
 * part that is load-bearing and silent when wrong. Four constraints live in the
 * order alone:
 *
 *   * COUNTDOWN is published only AFTER the session exists (the statechange
 *     republishes the room snapshot and each player's inRace is read from the
 *     live session);
 *   * the post-GO auto-pause re-check is DEFERRED off the launch stack (it runs
 *     inside the session update, whose no-seats-left branch tears the session
 *     down under the caller) — it crosses as {"deferred":true} and a shell that
 *     performs it synchronously is broken;
 *   * cup points are banked BEFORE the final board is broadcast;
 *   * the session is disposed BEFORE the flow flips to LOBBY.
 *
 * So a shell WALKS the array in index order and performs each op. It may not
 * reorder, batch or skip. Anything it cannot perform is a missing capability,
 * not an optional step — and ttp_race_effect_ops_json below hands over the
 * whole op vocabulary so a shell can prove its switch total AT BOOT instead of
 * discovering a hole mid-race.
 *
 * WHAT STAYS WITH THE SHELL, deliberately: the page RNG (the per-race seed and
 * the shuffle BAG — the walks ask for draws rather than owning randomness),
 * the timers an effect names, the cup-series HANDLE (an effect says
 * "series-advance"; the shell performs it against the ttp_gp_* handle it
 * owns), and the E2E budget overrides (countdownSeconds / intermissionMs cross
 * as arguments so a test can shrink them).
 *
 * THE DRAWS PROTOCOL. A shuffle-bag draw cannot be put back, so a walk that
 * may spend draws (start, return-to-lobby) runs in two phases THROUGH THE SAME
 * EXPORT: called with drawsJson NULL it answers the verdict — and, when the
 * verdict needs randomness, {"action":"draws","drawsNeeded":n}. The shell
 * draws exactly n and calls again with them; the walk re-checks its own gate.
 * A pick that needs no draws completes on the first call. The old shape — a
 * separate draws-needed export and a gate the shell called twice by
 * convention — drifted at one call site and was transcribed wrongly by the
 * first TV shell; the protocol is one export's contract now.
 *
 * IDS. A player id crosses as a JSON scalar, exactly as in ttp_party.h and
 * ttp_ui.h: the token `3` is the number 3 and `"3"` is the string "3", and they
 * are different players. Peer indices are numbers and bots are strings like
 * "ai-0"; both flow through the same field.
 *
 * NULL IS NOT ZERO. A seat with no car pick, a launch with no ?item override
 * and a lobby return with no track swap all come out as JSON null, never 0
 * or "".
 */
#ifndef TTP_RACE_H
#define TTP_RACE_H

#include "ttp_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---- the world ----------------------------------------------------------- */

/* Everything the field rules and the series lookups resolve against. Set once
 * at boot; a later call replaces it wholesale.
 *
 *   {"fieldSize": 4,           seats every race fills (humans + CPU)
 *    "carCount": 12,           models a livery slot wraps into
 *    "colorCount": 12,         liveries the CPU fill draws from
 *    "aiPrefix": "ai-",        id namespace for CPU racers
 *    "personas": [{"name","caution","laneBias"}, ...],
 *    "carStats": [ <opaque>, ... ],    copied into a field entry, never read
 *    "cups":     [{"id","name","tracks":["id",...]}, ...]}
 *
 * Returns 1 when the text parsed, 0 otherwise (the previous world then stands).
 * Unset, a start resolves no cup and the CPU fill seats nobody. */
TTP_ABI int ttp_race_configure(const char* json);

/* libttp-sim's own persona table, so a shell can configure it back rather than
 * keeping a second copy. -> [{"name","caution","laneBias"}, ...] */
TTP_ABI const char* ttp_race_personas_json(void);

/* The effect vocabulary this build can emit, as a JSON array of op keys in a
 * stable order. A shell walks it at boot and asserts its performer switch
 * covers every op — the unperformable-op throw, moved from mid-race to
 * startup. The same trick as ttp_audio_cue_id and ttp_item_id: the table
 * lives here, the shell builds FROM it, and no mirror can drift. */
TTP_ABI const char* ttp_race_effect_ops_json(void);

/* ---- the lobby attract demo ---------------------------------------------- */

/* The lobby attract grid, off the live room: the seated players plus CPU
 * racers topping the field up, demo ids ("demo-<peer>", "demo-cpu-<n>"),
 * persona by FINAL grid index so they spread across the whole field — plus the
 * cheap signature of what that grid renders (track + each car's
 * id/livery/model), so a refresh can compare and skip a no-op rebuild. A
 * rename alone will not re-grid.
 *   -> {"field":[{"id","name","colorIndex","carIndex","stats","persona"},...],
 *       "sig":"..."} */
TTP_ABI const char* ttp_race_demo_live_json(int roomHandle, const char* trackId,
                                            const char* botCapJson);

/* ---- start / launch ------------------------------------------------------ */

/* The lobby start, off the live room: the START_GAME go/no-go (re-checked here
 * so a stale or forged START_GAME cannot jump the lobby), the series plan, and
 * — once accepted — the full launch, in ONE walk. roomState, the connected
 * players and the stored pick are read off roomHandle; the readiness rule
 * itself is the ui model's.
 *
 *   sceneReady        the shell's "the 3D scene is built" latch (only it knows)
 *   drawsJson         NULL for the ask phase; a JSON array of drawn track ids
 *                     for the launch phase (see THE DRAWS PROTOCOL above)
 *   seed              the per-race seed (page RNG; the shell mints it)
 *   countdownSeconds  protocol COUNTDOWN_SECONDS, or the E2E override
 *   forceItemOrNull   ?item=<id> debug hook: every box rolls this
 *   botCapJson        ?bots=<n> debug cap as a JSON number, or NULL to fill
 *
 *   -> {"action":"none","reason":"room-state"|"scene"|"no-track"|"no-players"}
 *    | {"action":"draws","drawsNeeded":n}
 *    | {"action":"launch","series":null|{...},"drawsUsed":n,"effects":[...]}
 *
 * A launch's `series` is the plan the shell builds its cup-series handle from
 * BEFORE performing the effects: null (single race), or
 * {"kind":"cup","cupId"} — the shell already holds the cup — or
 * {"kind":"random-endless"|"random-card","cupId","cupName","tracks":[...]},
 * where random-endless is the one shape that keeps a live draw at every
 * intermission. */
TTP_ABI const char* ttp_race_start_live_json(int roomHandle, int sceneReady,
                                             const char* drawsJson, double seed,
                                             double countdownSeconds,
                                             const char* forceItemOrNull,
                                             const char* botCapJson);

/* The launch alone, for the cup chain: after ttp_race_advance_live_json's
 * effects are performed (the series advanced, the room's pick re-aimed at the
 * cup's next track), this reads the connected players and the pick back off
 * the handles and answers the launch effects. Same trailing arguments as the
 * start walk. -> {"effects":[...]} */
TTP_ABI const char* ttp_race_launch_live_json(int roomHandle, double seed,
                                              double countdownSeconds,
                                              const char* forceItemOrNull,
                                              const char* botCapJson);

/* ---- the frame's event drain --------------------------------------------- */

/* Drain the session's queued race events and answer everything a shell must DO
 * about them, in fire order, as one effect list. The three LIFECYCLE beats the
 * sim reconstructs (_countdown, _raceStart, _raceEnd) are routed INTERNALLY to
 * the countdown, GO and end-of-race rules — the first TV shell fed them to the
 * ordinary-event filter, where they vanish and the room sits in COUNTDOWN
 * forever; that routing table is not a shell concern any more. Ordinary events
 * run the finish/visuals rule, with humans-all-done read off the live handles
 * exactly when a finish asks for it.
 *
 *   biome             the built scene's biome (the GO beat's music pick)
 *   audioReady        the device can play (a locked AudioContext picks no song)
 *   fastForwarding    inside the AI-only fast-forward burst: visuals silenced
 *   intermissionMs    ttp_race_intermission_ms(), or the E2E override
 *   nowMs             the shell's clock (the intermission deadline is absolute)
 *   resultsFailsafeMs ttp_race_results_failsafe_ms()
 *
 *   -> {"effects":[...], "results": obj|null}
 *
 * `results` is non-null exactly when the drain crossed the race's end: the
 * ranked board endRace hands its callback, which three effects
 * (apply-race-points, show-results, the final broadcast-standings) read as
 * their context. No effect can carry it, so it rides the answer. */
TTP_ABI const char* ttp_race_events_live_json(int sessionHandle, int roomHandle,
                                              int gpHandle, const char* biome,
                                              int audioReady, int fastForwarding,
                                              double intermissionMs, double nowMs,
                                              double resultsFailsafeMs);

/* ---- the cup chain / the way out ----------------------------------------- */

/* Chain into the cup's next race straight from the intermission (RESULTS →
 * COUNTDOWN, no lobby between). roomState and the connected players come off
 * roomHandle; whether the series is live and finished off gpHandle (0 = no
 * series). The shell performs the effects — series-advance and
 * set-track-from-series among them — and then calls ttp_race_launch_live_json.
 *   -> {"action":"none"|"return-to-lobby"|"advance","effects":[...]} */
TTP_ABI const char* ttp_race_advance_live_json(int roomHandle, int gpHandle,
                                               int sceneReady);

/* Back to the lobby from anywhere; every exit route cancels a running cup.
 * roomState and the pick are read off roomHandle. Runs the draws protocol
 * (a random pick re-rolls the next lobby's track, and a call that is already
 * a no-op must not advance the bag):
 *   -> {"action":"none","effects":[],"drawsUsed":0}
 *    | {"action":"draws","drawsNeeded":n}
 *    | {"action":"return","effects":[...],"trackSwap":"id"|null,"drawsUsed":n}
 * `trackSwap` re-aims the next lobby's pick: random re-rolls every visit, a cup
 * rewinds to its race 1. */
TTP_ABI const char* ttp_race_return_live_json(int roomHandle, const char* drawsJson);

/* Ending the PARTY (back from the lobby): the ordered teardown effects AFTER
 * the shell's own return-to-lobby walk — close-room, clear-pick,
 * render-lobby-pick, refresh-lobby-demo, show-screen welcome,
 * update-backdrop, in that order (the order is the contract; the corpus pins
 * it). Takes nothing: a party end has no mode. */
TTP_ABI const char* ttp_race_end_party_json(void);

/* The manual overlay pause / resume, as walks. hasSession and roomState come
 * off the handles; the three flags are the shell's own latches (the model
 * threads them back through the set-race-flags effect, so the shell is their
 * one writer). The verdicts are asked INSIDE, and the five-op order is the
 * contract — a shell performs, it does not sequence.
 *   -> {"action":"none"|"pause"|"resume","effects":[...]} */
TTP_ABI const char* ttp_race_pause_live_json(int sessionHandle, int roomHandle,
                                             int paused, int autoPaused, int raceEnded);
TTP_ABI const char* ttp_race_resume_live_json(int sessionHandle, int roomHandle,
                                              int paused, int autoPaused, int raceEnded);

/* The two game-timing budgets (race_flow.h INTERMISSION_MS /
 * RESULTS_FAILSAFE_MS). Read them; the numbers have no shell home anymore. */
TTP_ABI double ttp_race_intermission_ms(void);
TTP_ABI double ttp_race_results_failsafe_ms(void);

/* ---- the roster-driven repairs ------------------------------------------- */

/* Pull a player's car out of the live race (a clean LEAVE, or a dropped seat
 * whose reconnect grace elapsed). The removal itself happens HERE, against the
 * live session — the shell no longer asks the engine and hands the answer
 * back. sessionHandle 0 means no race: the no-car effects. -> {"effects":[...]} */
TTP_ABI const char* ttp_race_forfeit_live_json(int sessionHandle, const char* peerIdJson);

/* A dropped player reconnected on a different device. The session rekey
 * happens HERE; banked cup points follow the PLAYER, so the series-rekey
 * effect is emitted (for the shell to perform against its gp handle) even with
 * no car to move. gpHandle 0 = no series. -> {"effects":[...]} */
TTP_ABI const char* ttp_race_rekey_live_json(int sessionHandle, int gpHandle,
                                             const char* oldIdJson, const char* newIdJson);

/* The silent auto-pause, whole: the consult rule, the participant read through
 * the synced seam, the decision AND its effects, off the two handles. raceEnded
 * stays a parameter — it is the shell's results-overlay latch, a fact neither
 * handle knows. Re-run on every roster change; the answer's effects are often
 * empty. -> {"effects":[...]} */
TTP_ABI const char* ttp_race_auto_pause_live_json(int sessionHandle, int roomHandle,
                                                  int raceEnded);

#ifdef __cplusplus
}
#endif
#endif /* TTP_RACE_H */
