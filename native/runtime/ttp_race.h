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
 * every leg. This header is how a SHELL reaches it, and the walks here are
 * EXECUTORS: each gathers its inputs off the live handles, runs the
 * corpus-pinned rules, PERFORMS the ops whose object lives behind the room —
 * the cup series, the retained race field, the pick's track, the shuffle
 * bag's draws — and answers only the ops that name a platform API. The
 * decision layer still emits the full corpus-pinned list; the `abi` ctest
 * gates the split by composing the same rules in-run and checking both the
 * answer AND the stored state the executor moved.
 *
 * EVERY ANSWER IS AN ORDERED EFFECT LIST, and that is the whole design. A
 * shell WALKS the array in index order and performs each op. It may not
 * reorder, batch or skip. Four constraints live in the order alone:
 *
 *   * COUNTDOWN is published only AFTER the session exists (the statechange
 *     republishes the room snapshot and each player's inRace is read from the
 *     live session);
 *   * the post-GO auto-pause re-check is DEFERRED off the launch stack (it runs
 *     inside the session update, whose no-seats-left branch tears the session
 *     down under the caller) — it crosses as {"deferred":true} and a shell that
 *     performs it synchronously is broken;
 *   * cup points are banked BEFORE the final board is broadcast (the executor
 *     banks them inside the event drain, in exactly that slot);
 *   * the session is disposed BEFORE the flow flips to LOBBY.
 *
 * Anything a shell cannot perform is a missing capability, not an optional
 * step — and ttp_race_effect_ops_json below hands over the answerable op
 * vocabulary so a shell can prove its switch total AT BOOT instead of
 * discovering a hole mid-race. An answer may also carry NET-vocabulary ops
 * (the executor merges the set-track walk's tail — track-change, publish —
 * in place), so a shell's performer covers this list PLUS
 * ttp_net_effect_ops_json's; the web shell's perform() falls through to its
 * net performer for exactly that reason.
 *
 * WHAT STAYS WITH THE SHELL, deliberately: the per-race SEED and the E2E
 * budget overrides (countdownSeconds / intermissionMs cross as arguments so a
 * test can shrink them), the timers an effect names, and the ?item / ?bots
 * URL debug hooks. There is no draws protocol and no series handle anymore:
 * the shuffle bag and the cup series live behind the room, and a shell that
 * wants to SHOW the series reads ttp_race_series_state_json.
 *
 * IDS. A player id crosses as a JSON scalar, exactly as in ttp_party.h and
 * ttp_ui.h: the token `3` is the number 3 and `"3"` is the string "3", and they
 * are different players. Peer indices are numbers and bots are strings like
 * "ai-0"; both flow through the same field.
 *
 * NULL IS NOT ZERO. A seat with no car pick, a launch with no ?item override
 * and a drain that crossed no race end all come out as JSON null, never 0
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
 *    "personas": [{"name","caution","laneBias"}, ...],   ABSENT = libttp-sim's
 *                              own table (the single source; a shell passes
 *                              nothing and no boot round trip exists)
 *    "carStats": [ <opaque>, ... ],    copied into a field entry, never read
 *    "cups":     [{"id","name","tracks":["id",...]}, ...]}
 *
 * Returns 1 when the text parsed, 0 otherwise (the previous world then stands).
 * Unset, a start resolves no cup and the CPU fill seats nobody. */
TTP_ABI int ttp_race_configure(const char* json);

/* libttp-sim's persona table as data — the drift pin's read
 * (tests/display-abi.test.js) and the test surfaces'. configure defaults to
 * this table when `personas` is absent, so a shipping shell never calls it. */
TTP_ABI const char* ttp_race_personas_json(void);

/* DEV/BENCH LATCH — off the shipping path, and a shell that races real people
 * never calls it.
 *
 * On, every launch from here gives its PLAYER seats a controller as well: the
 * field, the grid, the cells and the ids are a real launch's to the byte, and
 * the sim supplies the steering a phone would. That is what makes a perf bench,
 * a screenshot run and an attract race an AUTHENTIC race — an unsteered seat
 * does not sit on the grid, because throttle is automatic: it accelerates away,
 * never turns, and piles into the first corner.
 *
 * The seats stay PARTICIPANTS (ttp/race_flow.h, BotSpec::player): they are not
 * in `aiIds`, they keep their split-screen cells, and the session still counts
 * them, so the auto-pause rule does not tear the race down. Latched rather than
 * passed per walk because it is a property of the RUN, not of one launch, and
 * every walk that launches would otherwise grow a parameter no shipping caller
 * would ever pass. */
TTP_ABI void ttp_race_autopilot_players(int on);

/* The bench field, WITHOUT a room: `players` player seats plus the CPU fill,
 * gridded by the game's own rule (players at the back), every seat autopiloted.
 * Answers {"field":[...],"bots":[...]} — the two arguments ttp_session_begin_field
 * takes — so a harness with no relay draws the same picture the walk would.
 *
 * It is launchRace() itself behind this, not a second field builder: the whole
 * point is that a bench on a browser and a bench on a television are measuring
 * one arrangement. Names/liveries/cars for the player seats are the bench
 * roster's, which is why they are decided here and not re-typed per platform. */
TTP_ABI const char* ttp_race_bench_field_json(const char* trackId, int players,
                                              double seed);

/* The ops a walk's ANSWER can carry, as a JSON array of keys in a stable
 * order. A shell walks it at boot and asserts its performer switch covers
 * every op — the unperformable-op throw, moved from mid-race to startup. The
 * executor-owned ops (series, field, pick) are NOT in it: they never reach a
 * shell. Answers may also carry net-vocabulary ops (see the header note). */
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

/* The lobby start, whole: the START_GAME go/no-go (re-checked here so a stale
 * or forged START_GAME cannot jump the lobby), the shuffle-bag draws a random
 * pick needs, the cup series stood up and stored behind the room, and the
 * launch — ONE call. roomState, the connected players, the stored pick and
 * the bag are all the room handle's.
 *
 *   sceneReady        the shell's "the 3D scene is built" latch (only it knows)
 *   seed              the per-race seed (page RNG; the shell mints it)
 *   countdownSeconds  protocol COUNTDOWN_SECONDS, or the E2E override
 *   forceItemOrNull   ?item=<id> debug hook: every box rolls this
 *   botCapJson        ?bots=<n> debug cap as a JSON number, or NULL to fill
 *
 *   -> {"action":"none","reason":"room-state"|"scene"|"no-track"|"no-players"}
 *    | {"action":"launch","effects":[...]}
 *
 * The refusal is asked BEFORE any draw — a start that is going to be refused
 * never advances the bag, and a draw can never be put back. */
TTP_ABI const char* ttp_race_start_live_json(int roomHandle, int sceneReady,
                                             double seed, double countdownSeconds,
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
 * exactly when a finish asks for it. At the race's end the executor banks the
 * cup points against the room's series and retained field — before the board
 * effects, the order the corpus pins.
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
 * ranked board endRace hands its callback, which the show-results and final
 * broadcast-standings effects read as their context. No effect can carry it,
 * so it rides the answer. */
TTP_ABI const char* ttp_race_events_live_json(int sessionHandle, int roomHandle,
                                              const char* biome,
                                              int audioReady, int fastForwarding,
                                              double intermissionMs, double nowMs,
                                              double resultsFailsafeMs);

/* ---- the cup chain / the way out ----------------------------------------- */

/* Chain into the cup's next race straight from the intermission — RESULTS →
 * COUNTDOWN in ONE walk: the verdict, the series advanced, the pick re-aimed
 * at the cup's next circuit (the net set-track tail merges into the answer),
 * and the launch, all executed here. Same trailing arguments as the start.
 *   -> {"action":"none"|"return-to-lobby"|"advance","effects":[...]} */
TTP_ABI const char* ttp_race_advance_live_json(int roomHandle, int sceneReady,
                                               double seed, double countdownSeconds,
                                               const char* forceItemOrNull,
                                               const char* botCapJson);

/* Back to the lobby from anywhere; every exit route cancels a running cup
 * (the executor disposes the room's series) and a random pick re-rolls the
 * next lobby's track from the room's bag (the re-aim's net tail merges into
 * the answer). A call that is already a no-op draws nothing.
 *   -> {"action":"none"|"return","effects":[...]} */
TTP_ABI const char* ttp_race_return_live_json(int roomHandle);

/* Ending the PARTY (back from the lobby): the ordered teardown effects AFTER
 * the shell's own return-to-lobby walk — close-room, clear-pick,
 * render-lobby-pick, refresh-lobby-demo, show-screen welcome,
 * update-backdrop, in that order (the order is the contract; the corpus pins
 * it). Takes nothing: a party end has no mode. */
TTP_ABI const char* ttp_race_end_party_json(void);

/* The room's live cup series as ONE read — ttp_gp_state_json's answer shape —
 * or "null" for a single race. The DISPLAY of a series (the E2E surface, a
 * debug panel) reads here; no shell holds a series handle. */
TTP_ABI const char* ttp_race_series_state_json(int roomHandle);

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

/* A dropped player reconnected on a different device. The session rekey, the
 * series' banked points (they follow the PLAYER) and the retained field row
 * all move HERE; what comes back is only the scene op. -> {"effects":[...]} */
TTP_ABI const char* ttp_race_rekey_live_json(int sessionHandle, int roomHandle,
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
