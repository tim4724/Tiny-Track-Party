/* ttp_race.h — the RACE ORCHESTRATION half of the runtime C ABI: the state
 * machine that starts a race, launches one, walks the countdown, ends it,
 * chains a cup and returns to the lobby. Sibling of ttp_ui.h (the screen
 * decisions), ttp_runtime.h (sim), ttp_party.h (party), ttp_display.h
 * (renderer) and ttp_audio.h (sound), same conventions (ttp_abi.h) except for
 * the deviation ttp_ui.h states and this header inherits.
 *
 * WHAT IS BEHIND IT. libttp-runtime/ttp/race_flow.{h,cc} — public/display/
 * raceFlow.js ported. ttp_ui.h took the PREDICATES out of main.js
 * (allRacersReady, canPause, raceFlow, autoPause); this is the machine that
 * calls them in order, replayed step for step against
 * tests/fixtures/raceflow-corpus.jsonl (recorded off the live raceFlow.js) by
 * runtimetest/raceflow_check.cc on every leg. This header is only how a SHELL
 * reaches it.
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
 * not an optional step.
 *
 * WHY JSON. The same two reasons as ttp_ui.h. This layer answers ONCE PER EVENT
 * — a start, a beat, a car crossing the line, a cup chaining — never on the
 * frame path; and half of what it answers is TEXT of unbounded length (player
 * names, track ids, the opaque car-stats rows that pass straight through to the
 * sim). There is nothing to pack the way ttp_hud.h and ttp_audio.h pack their
 * per-frame numbers.
 *
 * KEY PRESENCE IS CONTRACT, not incidental. JSON.stringify drops undefined, so
 * several answers differ in WHICH keys exist: a rejected start carries `reason`
 * and no `series`, an accepted one carries `series`+`drawsUsed` and no
 * `reason`; a cup plan carries only {kind,cupId} while a random plan also
 * carries cupName and tracks; the no-op lobby return has no `trackSwap` at all.
 * Those are the bytes raceflow-corpus.jsonl recorded and abi_check replays.
 *
 * THE OPAQUE PASS-THROUGH. A car's `stats` row is copied from the configured
 * table into the field entry and never read. That is what keeps CAR_STATS out
 * of libttp-runtime and lets the corpus carry a synthetic world; a shell gets
 * back exactly the JSON it configured.
 *
 * STATELESS, WITH ONE EXCEPTION — the same shape as ttp_ui.h's. The WORLD
 * (ttp_race_configure: the field sizes, the persona table, the car-stats rows,
 * the cups) is authored data that changes when the game ships, not while it
 * runs, so a shell sets it once at boot. race_flow.cc itself stays
 * world-agnostic.
 *
 * PERSONAS ARE NOT DUPLICATED ANY MORE. The web shell used to keep
 * public/display/aiPersonas.js as a hand-synced copy of libttp-sim's
 * ttp::AI_PERSONALITIES, held together by a prose "keep in sync" comment —
 * exactly the drift CLAUDE.md's manifest rule exists to stop. A shell now reads
 * the table out of ttp_race_personas_json and configures it back, so there is
 * one table and the wasm owns it.
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

/* ---- the field ----------------------------------------------------------- */

/* The race grid: the connected humans plus CPU racers topping it up to
 * fieldSize. CPU seats take the lowest free livery, the model that livery maps
 * to, and a persona cycled by CPU index; their ids are strings ("ai-0"...) that
 * never collide with the integer phone slots.
 *
 *   players  [{"peerIndex":id,"name","colorIndex":n,"carIndex":n|null}, ...]
 *   seed     the race seed; each bot's wander seeds from seed + its NUMERIC
 *            index, so the bots differ from each other and from last race
 *   botCap   the ?bots=<n> debug cap as a JSON number, or "null" to fill
 *   ->  {"field":[{"peerIndex","name","colorIndex","carIndex","stats","ai"},...],
 *        "bots": [{"peerIndex","caution","laneBias","seed"}, ...],
 *        "aiIds":[id, ...]} */
TTP_ABI const char* ttp_race_build_field_json(const char* playersJson, double seed,
                                              const char* botCapJson);

/* The lobby attract grid. Same CPU fill, different ids ("demo-<peer>",
 * "demo-cpu-<n>"), and one extra rule: persona by FINAL grid index so they
 * spread across the whole field, each CPU taking that persona's name.
 *   -> [{"id","name","colorIndex","carIndex","stats","persona"}, ...] */
TTP_ABI const char* ttp_race_build_demo_field_json(const char* playersJson,
                                                   const char* botCapJson);

/* Cheap signature of what the attract demo renders, so a refresh can skip a
 * no-op rebuild: track + each car's id/livery/model. A rename alone will not
 * re-grid. Takes the array ttp_race_build_demo_field_json returned. */
TTP_ABI const char* ttp_race_demo_sig(const char* demoFieldJson, const char* trackId);

/* ---- start / launch ------------------------------------------------------ */

/* The START_GAME go/no-go, re-checked here so a stale or forged START_GAME
 * cannot jump the lobby. The readiness rule itself is ttp_ui_all_racers_ready's.
 *
 *   {"roomState":"lobby"|..., "sceneReady":bool, "selectedTrackId":"id"|null,
 *    "players":[...], "mode":"cup"|"random"|..., "cupId":"id"|null,
 *    "trackId":"id", "randomRaces":n, "draws":["id",...]}
 *
 * `draws` is the shell's pre-pulled shuffle-bag output — the bag stays in the
 * shell on purpose (page RNG, not sim state), so this offers draws and reports
 * how many a rule actually took.
 *
 *   -> {"action":"none","reason":"room-state"|"scene"|"no-track"|"no-players"}
 *    | {"action":"launch","series":null|{...},"drawsUsed":n}
 * where a series is {"kind":"cup","cupId"} or
 * {"kind":"random-endless"|"random-card","cupId","cupName","tracks":[...]}. */
TTP_ABI const char* ttp_race_start_json(const char* inputJson);

/* How many bag draws a start with these settings WOULD consume, without
 * deciding anything and without being handed any.
 *
 * It exists because a draw cannot be put back. A shell that pre-draws for the
 * call above and is then told "none / no-players" has already advanced the
 * shuffle for a race that never happened — which makes "random" repeat sooner
 * and silently skip a track nobody saw. So a shell asks this FIRST, draws
 * exactly this many, and only then calls ttp_race_start_json.
 *
 * Takes the same input object; reads only `mode` and `randomRaces`. */
TTP_ABI int ttp_race_draws_needed(const char* inputJson);

/* The launch itself, shared by the lobby start and the cup chain. Assumes the
 * guards above already passed.
 *
 *   {"players":[...], "seed":n, "trackId":"id", "countdownSeconds":n,
 *    "forceItem":"id"|null, "botCap":n|null}
 *   -> {"effects":[...], "field":[...], "aiIds":[...], "bots":[...]}
 *
 * THE EFFECT ORDER IS THE CONTRACT — see this header's opening. */
TTP_ABI const char* ttp_race_launch_json(const char* inputJson);

/* One countdown beat. n>0 is "3/2/1", n==0 is "GO!", n<0 is banner-gone. The
 * n<0 beat clears the LOCAL banner only and is deliberately never broadcast:
 * the phones' COUNTDOWN handler flips them onto the drive HUD, so a race that
 * ends within a second of GO would otherwise have this trailing beat land after
 * the final standings and yank their results board back to the wheel.
 *   -> {"effects":[...]} */
TTP_ABI const char* ttp_race_countdown_tick_json(double n);

/* The "GO!" beat: physics live, banner still up. `audioReady` gates the music
 * pick — a device that cannot play yet picks no song at all.
 *   -> {"effects":[...]} */
TTP_ABI const char* ttp_race_start_beat_json(const char* biome, int audioReady);

/* ---- the finish ---------------------------------------------------------- */

/* A sim race event, filtered to what a shell must DO about it. No audio: a
 * pickup, a banana, a spin and a lap chime are decided into sound inside the
 * wasm as the sim fires them (ttp_audio.h). `fastForwarding` silences the
 * visuals for the same reason it silences the sound — the burst is skipping,
 * not racing.
 *   {"event":{"type","id","item","cause","finished","s","lat"}|null,
 *    "fastForwarding":bool, "humansAllDone":bool}
 *   -> {"effects":[...]} */
TTP_ABI const char* ttp_race_event_json(const char* inputJson);

/* The race is over.
 *   {"hasSeries":bool,"seriesFinished":bool,"intermissionMs":n,"nowMs":n,
 *    "resultsFailsafeMs":n}
 *   -> {"effects":[...]}
 * Points are banked before the board goes out, and the intermission is armed
 * only mid-cup. */
TTP_ABI const char* ttp_race_end_json(const char* inputJson);

/* ---- the cup chain / the way out ----------------------------------------- */

/* Chain into the cup's next race straight from the intermission (RESULTS →
 * COUNTDOWN, no lobby between). The shell runs ttp_race_launch_json next.
 *   {"roomState","hasSeries","seriesFinished","sceneReady","players":[...]}
 *   -> {"action":"none"|"return-to-lobby"|"advance","effects":[...]} */
TTP_ABI const char* ttp_race_advance_json(const char* inputJson);

/* Back to the lobby from anywhere; every exit route cancels a running cup.
 *   {"roomState","mode","cupId":"id"|null,"trackId":"id"|null,"draws":[...]}
 *   -> {"action":"none","effects":[],"drawsUsed":0}
 *    | {"action":"return","effects":[...],"trackSwap":"id"|null,"drawsUsed":n}
 * `trackSwap` re-aims the next lobby's pick: random re-rolls every visit, a cup
 * rewinds to its race 1. */
TTP_ABI const char* ttp_race_return_json(const char* inputJson);

/* ---- the roster-driven repairs ------------------------------------------- */

/* Pull a player's car out of the live race (a clean LEAVE, or a dropped seat
 * whose reconnect grace elapsed). `removed` is whether the session actually
 * held that car — only the shell holds the handle, so it asks and passes the
 * answer in. -> {"effects":[...]} */
TTP_ABI const char* ttp_race_forfeit_json(int removed, const char* peerIdJson);

/* A dropped player reconnected on a different device. Banked cup points follow
 * the PLAYER, so the series rekey happens even with no car to move.
 * -> {"effects":[...]} */
TTP_ABI const char* ttp_race_rekey_json(int hasSeries, int rekeyed,
                                        const char* oldIdJson, const char* newIdJson);

/* The auto-pause arbitration's EFFECT half. The RULE is ttp_ui_auto_pause_json's
 * — which seats count, when the freeze may apply, what an empty field means —
 * and its answer is handed straight back in here.
 *   {"action":"none"|"return-to-lobby"|...,"autoPaused":bool}|null
 *   -> {"effects":[...]} */
TTP_ABI const char* ttp_race_auto_pause_json(const char* decisionJson);

#ifdef __cplusplus
}
#endif
#endif /* TTP_RACE_H */
