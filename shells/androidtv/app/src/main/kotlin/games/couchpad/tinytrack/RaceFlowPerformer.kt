package games.couchpad.tinytrack

import org.json.JSONArray
import org.json.JSONObject

/**
 * Walks the ordered effect list `ttp_race.h` answers with, and performs each op.
 *
 * **The order is the contract.** Nothing in `libttp-runtime/ttp/race_flow.cc`
 * returns a verdict for a shell to sequence, because the sequencing is the part
 * that is both load-bearing and silent when wrong. Four constraints live in the
 * order alone, and none of them type-checks:
 *
 * 1. COUNTDOWN is published only **after** the session exists. The state change
 *    republishes the room snapshot and every player's `inRace` is read from the
 *    live session, so flipping first makes every racer's phone flash "you're in
 *    the next race".
 * 2. The post-GO auto-pause re-check is **deferred off the launch stack**. It
 *    runs inside `session.update()`, whose no-seats-left branch tears the session
 *    down underneath the caller. `deferred` is a flag on the op, and performing
 *    it synchronously is the bug that flag exists for.
 * 3. Cup points are banked **before** the final board goes out, because the board
 *    carries this race's gains.
 * 4. The session is disposed **before** the flow flips to LOBBY, because that
 *    transition sweeps held disconnected seats and would otherwise race an
 *    `endRace` on the way out.
 *
 * So this walker **may not reorder, batch, coalesce or skip.** An op it cannot
 * perform is reported rather than dropped: an unperformable effect is a missing
 * capability, and dropping one leaves a half-built race that looks like a
 * rendering bug three screens later.
 *
 * The web twin is `perform()` / `applyEffect()` in `public/display/main.js`, and
 * the three switches are deliberately line-for-line comparable.
 */
class RaceFlowPerformer(private val game: GameCoordinator) {

    // NO PERFORM CONTEXT. It used to carry `endRace`'s results object down to
    // `show-results` and the final `broadcast-standings`, untyped and paired with
    // its two readers by nothing at all. Both read the ROOM-RETAINED board now
    // (the walk's executor composes and retains it before it spells either op),
    // so every effect is self-contained.

    fun perform(effects: JSONArray) {
        for (i in 0 until effects.length()) {
            val e = effects.optJSONObject(i)
            if (e == null) { game.state.fail("raceFlow: unperformable effect <malformed>"); continue }
            apply(e.optString("op"), e)
        }
    }

    private fun apply(op: String, e: JSONObject) {
        when (op) {
            // ---- setup ------------------------------------------------------
            "stop-lobby-demo" -> game.lobbyDemo.stop()

            // ---- screens ----------------------------------------------------
            "show-screen" -> when (e.optString("screen")) {
                "welcome" -> game.show(GameState.Screen.WELCOME)
                "lobby" -> game.show(GameState.Screen.LOBBY)
                "race" -> game.show(GameState.Screen.RACE)
            }

            "hide-results" -> game.state.results = null

            "set-race-flags" -> {
                game.state.paused = e.optBoolean("paused")
                game.autoPaused = e.optBoolean("autoPaused")
                game.raceEnded = e.optBoolean("raceEnded")
            }

            "set-pause-overlay" -> game.state.paused = e.optBoolean("on")

            // The web hides its chrome after a pointer goes idle and reveals it on
            // movement, and shows/hides its clickable #pause-btn. A TV has no
            // pointer — the focus system decides what is visible, and the remote's
            // play/pause key is this platform's pause button (MainActivity.onKeyDown)
            // — so these three are genuine no-ops here rather than unhandled.
            "set-pause-button", "reveal-chrome", "hold-chrome" -> Unit

            // ---- the scene --------------------------------------------------
            "reset-scene-cars" -> {
                game.sceneCars = SceneCar.list(e.optJSONArray("cars"))
                game.rebuildScene()
            }

            "create-session" -> game.createSession(
                field = e.optJSONArray("field") ?: JSONArray(),
                seed = e.optDouble("seed", 1.0),
                // TtpJson.optStr, NOT optString: the key is always present and is
                // JSON null whenever there is no ?item, and optString would hand the
                // sim the string "null" as the forced item for every box in the race.
                forceItem = TtpJson.optStr(e, "forceItem"),
                bots = e.optJSONArray("bots") ?: JSONArray(),
            )

            "transition" -> {
                val to = e.optString("to")
                if (to.isNotEmpty()) game.net.transition(to)
                // The backdrop rule reads the room state as well as the pick: a
                // race shows the 3D whether or not the lobby had one, and coming
                // back to LOBBY with no pick drops to paper again.
                game.refreshBackdrop()
            }

            "bind-session" -> {
                // The renderer reads the grid poses (and then every frame) straight
                // off the engine; the audio hears only the BOUND session, which is
                // why the lobby's attract race is silent for free.
                game.display.bind(game.sessionHandle)
                game.audio.bind(game.sessionHandle)
            }

            // The renderer reads the grid poses straight off the engine; there is
            // nothing to copy across. Kept as a named no-op rather than dropped, so
            // the op stays performable and a future HUD that DOES need priming has
            // a home.
            "paint-initial-hud" -> Unit

            // ---- the countdown ----------------------------------------------
            "start-countdown" ->
                Ttp.ttp_session_start(game.sessionHandle, e.optInt("seconds", 3))

            // `Copy.countdown` spells the beat (digit / GO! / banner gone). The
            // beat's SOUND is the wasm's (it taps the same tick), so there is no
            // cue call here.
            "show-countdown" -> game.state.countdown = Copy.countdown(e.optInt("n", -1))

            "broadcast-countdown" -> game.net.broadcast(
                JSONObject().put("type", game.proto.msgCountdown)
                    .put("n", e.optDouble("n", 0.0)).toString()
            )

            "refresh-auto-pause" ->
                if (e.optBoolean("deferred")) {
                    // Constraint 2. We are inside session.update(); its
                    // no-seats-left branch disposes the session under this caller.
                    game.post { game.refreshAutoPause() }
                } else {
                    game.refreshAutoPause()
                }

            // ---- audio ------------------------------------------------------
            "start-music" -> game.audio.music(e.optString("biome").ifEmpty { null })
            "stop-music" -> game.audio.music(null)
            "stop-voices" -> game.audio.stopVoices()
            "stop-car-audio" -> EngineId.from(e.opt("id"))?.let { game.audio.stopCar(it) }

            // ---- in-race effects --------------------------------------------
            "item-pickup" -> EngineId.from(e.opt("id"))?.let { game.itemPickup(it) }
            "rocket-impact" -> EngineId.from(e.opt("id"))?.let { game.display.burst(it, 0.0, 0.0) }
            "rocket-expire" ->
                game.display.burst(null, e.optDouble("s", 0.0), e.optDouble("lat", 0.0))

            // ---- the finish --------------------------------------------------
            // The board itself was composed and RETAINED behind the room inside
            // the walk — nothing about it crosses to this side, and the op is now
            // bare. What is left to perform is the republish that carries it to
            // the phones.
            "broadcast-standings" -> game.net.publishSnapshot()

            // The points banking (constraint 3: BEFORE the final board goes out)
            // happens inside the event drain's executor — no op crosses.
            "show-results" -> game.showResults()

            "arm-intermission" ->
                game.armIntermission(e.optDouble("ms", 0.0), e.optDouble("deadline", 0.0))
            "clear-intermission" -> game.clearIntermission()

            // ---- the cup chain ------------------------------------------------
            // The series ops (advance, clear, set-track-from-series, rekey, the
            // points banking) are EXECUTOR-OWNED: the cup lives behind the room
            // handle and the walks perform them inside the wasm. Only the platform
            // ops below ever reach this switch.

            // Explicit because a chained start has NO lobby step: selecting a track
            // outside the lobby skips the scene swap, so the new circuit is placed
            // here and the results overlay covers the pop.
            "place-track" -> game.placeTrack()

            // ---- teardown -----------------------------------------------------
            "dispose-session" -> game.disposeSession()   // constraint 4
            "fade-to-lobby" -> game.fadeToLobby(e.optBoolean("placeTrack"))
            "remove-scene-car" -> EngineId.from(e.opt("id"))?.let { game.removeSceneCar(it) }
            "sync-state" -> game.net.publishSnapshot()
            "persist-progression" -> game.persistProgression(e.opt("progress"))

            // ---- the roster-driven repairs -------------------------------------
            "rekey-scene-car" -> {
                val old = EngineId.from(e.opt("oldId"))
                val new = EngineId.from(e.opt("newId"))
                if (old != null && new != null) game.rekeySceneCar(old, new)
            }

            "set-auto-paused" -> game.autoPaused = e.optBoolean("on")
            "sync-frozen" -> game.syncSessionFrozen()
            "return-to-lobby" -> game.returnToLobby()

            // ---- the party's way out --------------------------------------------
            // endParty's teardown — close-room bails every phone terminally while
            // the display's own 4001 self-heals into a FRESH room; a fresh party
            // then starts clean of the ended one's pick.
            "close-room" -> game.net.closeRoom()

            // The PICK dies with the party; the PREVIEW deliberately survives
            // (`game.trackId` keeps the ended party's circuit), so the next lobby
            // keeps its 3D attract race instead of dipping back to the paper
            // diorama — the web's own clear-pick rule since the boot-time attract.
            "clear-pick" -> Ttp.ttp_net_clear_pick(game.net.roomHandle)

            "render-lobby-pick" -> game.refreshCupSlot()
            "refresh-lobby-demo" -> game.lobbyDemo.refresh()
            "update-backdrop" -> game.refreshBackdrop()

            else ->
                // A race answer may carry NET-vocabulary ops in place: the executor
                // merges the set-track walk's tail (track-change, publish, …) into
                // it. Those belong to PartyNet's switch — whose own default is the
                // same loud missing-capability contract.
                game.net.performNetEffect(e)
        }
    }

    companion object {
        /**
         * The race-op arms of the switch above, as data, for the boot proof
         * (`ttp_race_effect_ops_json` must be a subset). Net-vocabulary ops are
         * deliberately absent — they fall through to PartyNet's switch.
         */
        val PERFORMABLE: Set<String> = setOf(
            "stop-lobby-demo",
            "show-screen", "hide-results", "set-race-flags", "set-pause-overlay",
            "set-pause-button", "reveal-chrome", "hold-chrome",
            "reset-scene-cars", "create-session", "transition", "bind-session",
            "paint-initial-hud", "start-countdown", "show-countdown",
            "broadcast-countdown", "refresh-auto-pause", "persist-progression",
            "start-music", "stop-music", "stop-voices",
            "stop-car-audio", "item-pickup", "rocket-impact", "rocket-expire",
            "broadcast-standings", "show-results",
            "arm-intermission", "clear-intermission", "place-track",
            "dispose-session", "fade-to-lobby", "remove-scene-car",
            "sync-state", "rekey-scene-car", "set-auto-paused", "sync-frozen",
            "return-to-lobby", "close-room", "clear-pick", "render-lobby-pick",
            "refresh-lobby-demo", "update-backdrop",
        )
    }
}

/** One grid entry as `reset-scene-cars` describes it. */
data class SceneCar(
    val id: EngineId,
    val colorIndex: Int,
    val name: String,
    /**
     * Whether this car owns a split-screen view. A BOOLEAN, not an index: the
     * model answers `cell: true` / `cell: false`, and a car's CELL NUMBER is its
     * position among the cars that have one, in roster order.
     *
     * Decoding it as a number is the trap, and it does not look like one: a JSON
     * `true` read as a number is 1, so every car claims cell 1 — the renderer
     * still draws four views (it only counts them), so the picture is right and
     * only the shell's chrome lands on one quadrant.
     */
    val cell: Boolean,
    /**
     * Kept nullable: a player who never picked drives car 0 but is not the same
     * input as one who picked it.
     */
    val carIndex: Int?,
) {
    companion object {
        fun list(a: JSONArray?): List<SceneCar> {
            if (a == null) return emptyList()
            return (0 until a.length()).mapNotNull { i ->
                val d = a.optJSONObject(i) ?: return@mapNotNull null
                val id = EngineId.from(d.opt("id")) ?: return@mapNotNull null
                SceneCar(
                    id = id,
                    colorIndex = d.optInt("colorIndex"),
                    name = TtpJson.optStr(d, "name") ?: "",
                    cell = d.optBoolean("cell"),
                    carIndex = if (d.has("carIndex") && !d.isNull("carIndex"))
                        d.optInt("carIndex") else null,
                )
            }
        }
    }
}
