package com.couchgames.tinytrackparty

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Stands each screen up from fake data, so it can be photographed without a relay,
 * a phone, or a party.
 *
 * The Android twin of `shells/tvos/TinyTrackParty/Harness/Scenarios.swift` and of
 * `public/display/TestHarness.js`, and the scenario NAMES are shared:
 * `public/shared/galleryScenarios.js` is the one list, read by the live web
 * gallery, by all three capture scripts and by the coverage test. A scenario that
 * exists here and not there is a screenshot nobody asks for; one that exists there
 * and not here shows up as a missing card, which is the failure mode you want
 * (visible) rather than the other one (silently stale).
 *
 * DEV-ONLY, reached by nothing on the shipping path: [read] finds no extra in a
 * normal launch, so [requested] stays null and `GameCoordinator.boot` takes the
 * ordinary road. It is compiled into the app rather than kept behind a build flag
 * because the screenshot has to be of the SHIPPING binary for the picture to mean
 * anything — a `debugImplementation`-only harness would photograph a build nobody
 * ships.
 *
 * ## What it may not do
 *
 * **It may fabricate its INPUTS; it must not own a second copy of the road.** Every
 * screen below is reached through the same `ttp_*` walk the live game takes:
 * [PartyNet.applyPick] for a pick, `ttp_room_add_player` for a party,
 * `ttp_race_start_live_json` for a launch, `ttp_ui_seat_grid_json` for padding,
 * `ttp_ui_results_view_json` for a board. The first tvOS harness reached
 * `ttp_race_launch_json` directly and photographed fifteen perfect race screens for
 * a build whose Start button had never once worked (`docs/native-port/shells.md`).
 *
 * ## Why there is no instrumentation test here
 *
 * tvOS needs XCUITest to take the picture at all — `devicectl` has no screenshot
 * verb. Android has `adb exec-out screencap`, which photographs the SurfaceView
 * composited under the Compose chrome from outside the process entirely, so the
 * whole runner is `scripts/capture-shots-androidtv.mjs` and this shell keeps no
 * `androidTest` source set. That also decides the readiness signal: it has to be
 * something adb can observe, so it is a LOG LINE (see [signal]) — which is already
 * this shell's idiom, since `scripts/androidtv-party-check.mjs` reads the room code
 * out of logcat the same way.
 */
object Scenarios {

    /**
     * The logcat tag the capture script greps. Deliberately not "ttp": a scenario's
     * two lines have to be findable in a log that a race fills at 6 Hz.
     */
    private const val TAG = "TtpShot"

    /**
     * The intent extras, spelled once. The capture script passes them as
     * `am start -n <activity> --es ttpScenario racing --es ttpTrack sidewinder`,
     * which is this platform's answer to the web's `?scenario=` and tvOS's
     * `-ttpScenario` launch argument.
     */
    const val EXTRA_SCENARIO = "ttpScenario"
    const val EXTRA_TRACK = "ttpTrack"

    /** The scenario this launch was asked for. Null in every normal launch. */
    var requested: String? = null
        private set

    /**
     * `?track=` / `-ttpTrack`: pin the circuit for the race-family scenarios, which
     * is what the gallery's `racing-sidewinder` card is. An id the catalogue does
     * not hold is refused by the pick walk, same as any other wrong pick.
     */
    private var trackOverride: String? = null

    /** True while a scenario owns this launch, which is what gates the relay. */
    val active: Boolean get() = requested != null

    private val main = Handler(Looper.getMainLooper())

    // The fake party, identical to `public/display/TestHarness.js`'s FAKE_NAMES and
    // FAKE_TIMES. NOT a fresh set of names: the gallery exists to put this shell's
    // screen beside the browser's, and a column that renamed the players would
    // differ in a way that has nothing to do with the UI under inspection. (The
    // tvOS harness picked its own — Ann/Bo/Cy/Di — and every side-by-side since has
    // carried that as noise.)
    private val NAMES = listOf("Mia", "Theo", "Ava", "Leo", "Zoe", "Max", "Ivy", "Sam")
    private val TIMES = listOf(28.4, 30.7, 33.1, 35.8, 38.2, 41.0, 44.3, 47.6)

    /** Banked cup points, so the standings table beats this race's finishing order. */
    private val BANKED = listOf(10, 15, 6, 3, 2, 1, 0, 0)

    /** `native/libttp-sim/ttp/grand_prix.cc`'s ladder, for the fabricated podium. */
    private val POINTS_BY_RANK = listOf(9, 6, 3, 1)

    private const val PLAYERS = 4
    private const val ROOM_CODE = "TEST"

    // Timings. Every one of these is a FLOOR on something that has already been
    // waited for, never a substitute for waiting — see [standUp].
    private const val POLL_MS = 50L
    private const val RELEASE_BEAT_MS = 300L
    private const val SCENE_TIMEOUT_MS = 20_000L
    private const val SETTLE_MS = 1_000L

    /** How long the frozen previews let the field spread before freezing it. */
    private const val SPIN_MS = 3_000L
    private const val SPIN_LONG_MS = 5_000L

    /**
     * How many PRESENTED frames the dressed screen has to survive before the shot.
     *
     * A handful rather than one, because the compositor is a queue and a single
     * frame can still be in flight when the last one is counted.
     *
     * **THIS IS THE WHOLE REASON THE LATE BOARDS ARE PHOTOGRAPHABLE AT ALL.** On
     * this emulator the engine stops presenting for several seconds a little after
     * a scene lands — `ttp_display_frame` answers 0 for eight seconds straight —
     * and every card whose dressing runs a few seconds past the scene came back as
     * a perfectly drawn HUD over a BLACK surface. Screenshotting on a clock cannot
     * see that; screenshotting after N PRESENTS cannot miss it. The timeout is
     * therefore generous on purpose: it has to outlast the stall rather than expire
     * inside it, and expiring inside it is what produced the black boards.
     *
     * (`display.hold(true)` appears nowhere in this file. The web's frozen previews
     * hold so wheels stop spinning in a preview that runs forever; a screenshot is
     * one frame, so a still of moving cars is a still either way. It was also the
     * first suspect for the black surface and was NOT the cause — removing it made
     * two more cards black, which is what identified the stall.)
     */
    private const val PRESENT_FRAMES = 4
    private const val PRESENT_TIMEOUT_MS = 15_000L

    /** Read the launch request. Called from `MainActivity.onCreate`, before anything. */
    fun read(intent: Intent?) {
        requested = intent?.getStringExtra(EXTRA_SCENARIO)?.ifEmpty { null }
        trackOverride = intent?.getStringExtra(EXTRA_TRACK)?.ifEmpty { null }
    }

    /**
     * Stand [requested] up and then say so, once, in logcat.
     *
     * WAIT ON THE APP, NEVER ON A CLOCK. A bare sleep photographs a cold shader
     * compile about one run in five and fills the gallery with half-loaded scenes
     * that look plausible enough that nobody catches them.
     *
     * And wait for THIS scenario's scene, not whichever was up before it: a race
     * scenario's launch releases the lobby preview and rebuilds, so `hasScene` is
     * briefly the previous build's answer. The release beat below is what separates
     * the two; without it every race shot is an empty overview, with the cells
     * naming cars the surface does not hold.
     */
    fun standUp(game: GameCoordinator) {
        val id = requested ?: return
        val plan = try {
            apply(id, game)
        } catch (e: Throwable) {
            // A scenario that threw is a DEFECT, not a gap: say which, loudly, and
            // let the capture record a failure rather than photograph the lobby.
            Log.e(TAG, "failed $id: ${e.message}", e)
            game.state.fail("scenario $id: ${e.message}")
            return
        }
        if (plan == null) {
            // A screen this PLATFORM does not have. The runner SKIPS it rather than
            // failing: a gallery card with one column is the honest record of a
            // deliberate difference, and a red capture would train everyone to
            // ignore the runner.
            Log.i(TAG, "unsupported $id")
            return
        }
        after(RELEASE_BEAT_MS) {
            waitFor("a scene", SCENE_TIMEOUT_MS, { !plan.needsScene || game.display.hasScene }) { ok ->
                after(SETTLE_MS) {
                    settle(id, game) {
                        // AND THEN WAIT FOR THE GLASS. A scene that is BUILT is not
                        // a scene that has been PRESENTED, and the last thing most
                        // of these do is `hold(true)` — after which no further frame
                        // is submitted, so whatever the compositor happened to have
                        // is what the screenshot gets. Two boards came back with a
                        // black surface under a perfectly drawn HUD, reproducibly,
                        // while a shot taken by hand a second later was correct.
                        presented(game, PRESENT_FRAMES) {
                            // A scene that never arrived is a FAILED shot, not a
                            // ready one. The capture reads this word, so saying
                            // "ready" over a board with a black hole where the
                            // circuit should be would put that picture in the
                            // gallery as evidence.
                            Log.i(TAG, "${if (ok) "ready" else "failed"} $id")
                        }
                    }
                }
            }
        }
    }

    /** Wait until the engine has presented [n] more frames. */
    private fun presented(game: GameCoordinator, n: Int, then: () -> Unit) {
        val target = game.display.framesPresented + n
        waitFor("$n presented frames", PRESENT_TIMEOUT_MS,
            { game.display.framesPresented >= target }) { _ -> then() }
    }

    /** What [apply] answers: the screen is standing, and whether it owns 3D. */
    private class Plan(val needsScene: Boolean = true)

    /**
     * Stand [id] up. Null means this platform does not have that screen.
     *
     * Ordering rules that are NOT stylistic, and that both other shells learned the
     * expensive way, are called out at each site.
     */
    private fun apply(id: String, game: GameCoordinator): Plan? {
        val state = game.state

        when (id) {
            // NOT A SCREEN ON THIS PLATFORM, and `RootScreen`'s own comment says why:
            // the web's title board exists to collect the user GESTURE that unlocks
            // an AudioContext and enters fullscreen. A TV has neither restriction, so
            // this app boots straight to the lobby and there is nothing here to
            // photograph. The gallery showing a web shot with no Android counterpart
            // is the correct record of that.
            "welcome" -> return null

            // THE FIRST THING A VIEWER EVER SEES, and the only board on which the
            // PAPER DIORAMA is visible — every other lobby card previews a circuit,
            // so the 3D surface covers it. A defect in the paper is invisible to
            // every other card in the gallery.
            //
            // The state is boot's, before anything has arrived: no circuit previewed
            // (which is what `refreshBackdrop` reads to keep the paper up), no room,
            // no seats, no pick.
            "lobby-loading" -> {
                fakeProgress(game)
                game.show(GameState.Screen.LOBBY)
                game.releaseScene()
                // FOUR OPEN SEATS, not an empty dock. `display/index.html` ships the
                // same four placeholders statically for its pre-JS paint, because
                // the dock is part of the board from the first frame — and with no
                // dock the rails have no floor to stop at, so the join ticket
                // centred on the whole screen and sat 50 px low.
                state.seats.clear()
                state.seats.addAll((0 until PLAYERS).map { GameState.Seat.open(it) })
                state.cupSlot = null
                return Plan(needsScene = false)
            }

            "lobby-empty" -> {
                fakeProgress(game)
                game.show(GameState.Screen.LOBBY)
                state.seats.clear()
                state.seats.addAll((0 until PLAYERS).map { GameState.Seat.open(it) })
                state.cupSlot = null
                game.net.fakeRoom(ROOM_CODE)
            }

            // THROUGH THE PICK WALK, not around it. A harness may fabricate its
            // INPUTS — a scripted roster, a named cup, WHICH random draw (its
            // privilege: a real one would make this a different circuit every
            // capture) — but everything downstream has to be the road the live lobby
            // drives: the same select-mode walk a host's pick takes, whose
            // track-change effect stages the preview and refreshes the card.
            //
            // Assigning `state.cupSlot` directly instead would photograph a cup card
            // floating on PAPER, and would hide the defect that costs most: a picked
            // lobby with no 3D preview behind it.
            "lobby-track", "lobby-tour", "lobby-random" -> {
                fakeProgress(game)
                game.show(GameState.Screen.LOBBY)
                game.net.fakeRoom(ROOM_CODE)
                // WHICH circuit each card names is the SHARED TABLE's
                // (`galleryScenarios.js` carries `params.track` for both), arriving
                // as `--es ttpTrack`. Restating the ids here would be a second copy
                // of the gallery's own data, and the web column would drift off this
                // one the first time either changed.
                game.net.applyPick(
                    when (id) {
                        "lobby-track" -> JSONObject().put("mode", "track")
                            .put("trackId", trackOverride ?: "driftwood")
                        "lobby-tour" -> JSONObject().put("mode", "tour")
                        else -> JSONObject().put("mode", "random").put("randomRaces", 4)
                    }
                )
                // The random pick's draw belongs to the ROOM BAG (entropy-seeded), so
                // the photographed circuit is pinned AFTER the pick, through the same
                // set-track walk a cup advance takes: the MODE stays random, only the
                // preview is made deterministic.
                if (id == "lobby-random") game.net.setTrack(trackOverride ?: "powder")
                // The scripted seats go on LAST. The pick's track-change refreshes
                // the lobby off the (empty, relay-less) room, and a refresh after
                // this write would photograph four Open placeholders instead of the
                // party the scenario names.
                seat(state)
            }

            // The race family. The pick carries the circuit, so `racing-sidewinder`
            // is the same code as `racing` with `--es ttpTrack sidewinder` — which is
            // also why the override goes through the pick rather than being written
            // onto the coordinator: a track this build does not ship is refused by
            // the walk, at the walk, instead of failing three steps later inside
            // ttp_session_begin.
            //
            // MATCHED ON `id`, NOT ON `key`, and `racing-sidewinder` is why the two
            // are worth keeping straight: the gallery's table gives every card a
            // unique `id` (the shot's filename) over a shared harness `key`, and this
            // switch is reached with the id. A case list that names only the keys
            // answers `unsupported` for every card that shares one — which is silent,
            // because unsupported is a legitimate answer.
            "countdown", "racing", "racing-sidewinder", "rocket", "monster",
            "paused", "reconnect", "finished" -> {
                game.show(GameState.Screen.RACE)
                game.startDemoRace(trackPick(), forceItem(id))
            }

            // The boards. Fabricated rather than raced, and both halves of that are
            // deliberate:
            //
            //   the BOARD is fake, because the three dressings a viewer needs to
            //   compare (single race, mid-cup intermission, closing podium) are four
            //   races apart in a real cup, and a gallery that took ten minutes to
            //   capture would not be captured;
            //
            //   the VIEW is real. Every key below is one `ttp_ui_results_view_json`
            //   reads, so the podium split, the AI suffix, the two phases, the row
            //   kinds and the footer are all the model's answers — a renamed field
            //   breaks the shot rather than quietly drawing a different board.
            //
            // This is also where the tvOS twin is wrong and worth not copying: its
            // fabricated board carries no `series`, and BOTH `podium` and
            // `intermission` are derived from one, so all three of its cards
            // photograph the same plain results board.
            // THE BOARD IS BUILT IN `settle`, NOT HERE, and that is not tidiness: it
            // is composed from the RACE'S OWN FIELD, and the launch's grid top-up has
            // not run at this point in the walk — `sceneCars` still holds the four
            // seated cars. Fabricated here, all three boards photographed four rows
            // while the HUD frozen behind the glass showed places up to 8th, and the
            // two-column split and the late-joiner row were never drawn at all.
            "results", "intermission", "podium" -> {
                game.show(GameState.Screen.RACE)
                game.startDemoRace(trackPick(), forceItem = null)
            }

            // THE ONE CARD THAT IS A BEHAVIOUR RATHER THAN A PICTURE: results
            // straight into the next countdown, with no lobby step between. It is
            // raced for real (a cup pick, then the humans finished, then the live
            // race-over road, then the same advance walk the intermission's own
            // timer fires) precisely because a fabricated one would photograph a
            // countdown that proves nothing. If the cup chain is broken on this
            // shell, this card is what says so.
            "chain" -> {
                game.show(GameState.Screen.RACE)
                val cupId = firstCupId()
                    ?: throw IllegalStateException("the shipped catalogue has no cups")
                game.startDemoRace(JSONObject().put("mode", "cup").put("cupId", cupId), null)
            }

            else -> return null
        }
        return Plan()
    }

    /**
     * What has to be written AFTER the screen has settled, immediately before the
     * shot — and the one place this harness is allowed to wait on real time, because
     * what it is waiting for is the race developing.
     *
     * [done] rather than a return, because three of these are themselves waits.
     */
    private fun settle(id: String, game: GameCoordinator, done: () -> Unit) {
        when (id) {
            // THE COUNTDOWN BANNER IS THE ONE PIECE OF CHROME THE RACE FLOW ALSO
            // WRITES, so it cannot be staged at stand-up. `startDemoRace` launches
            // with no countdown, which puts up GO the instant the race starts and
            // clears it about a second later — over the top of anything written
            // earlier. Writing it at stand-up + 1 s lands on the same beat as that
            // clear, and the clear usually wins, which reads as the view not
            // rendering rather than as a value being overwritten.
            //
            // Waiting past the clear makes it deterministic: after it, a running
            // race emits no further countdown effects, so nothing can take the
            // banner down again. Every countdown photograph the tvOS shell took
            // before it learned this was of no countdown at all.
            "countdown" -> after(1_200L) {
                game.state.countdown = "3"
                done()
            }

            // Spin the field forward so it reads mid-race rather than as a start
            // grid, then FREEZE it: a held field spins no wheels and lays no rubber,
            // which is what makes a still photograph of a race look still.
            "paused" -> after(SPIN_MS) {
                // Through the real walk. `state.paused = true` would paint the
                // overlay over a race that is still running, and the pause the model
                // arbitrates (auto-pause, who may resume) would never have happened.
                game.pauseRace()
                done()
            }

            "reconnect" -> after(SPIN_MS) {
                dropOneSeat(game)
                done()
            }

            // One racer home while the rest race on. The FINISHER MUST BE A HUMAN:
            // the FINISHED card lives in a split-screen cell and the CPU fill has
            // none, so this asks the HUD which of the celled cars is leading rather
            // than assuming the roster's first.
            "finished" -> after(SPIN_LONG_MS) {
                finishLeader(game)
                done()
            }

            // The board goes up over a race that has spread out, and it is built
            // HERE because only now does `sceneCars` hold the whole grid.
            //
            // A PODIUM WAITS FOR ITS OWN REVEAL. `ResultsScreen` holds phase 1 for
            // `racePhaseMs` and then accounts the points out one at a time, and the
            // title, the medals and the footer all wait for the last one — so a shot
            // taken before that is a photograph of a board mid-sentence. The plain
            // single-race board has no phases and needs none of this.
            "results", "intermission", "podium" -> {
                val view = GameState.ResultsView.from(
                    TtpJson.obj(
                        Ttp.ttp_ui_results_view_json(
                            TtpJson.arg(board(id, game).toString()),
                            Ttp.ttp_race_intermission_ms()
                        )
                    )
                )
                game.state.results = view
                if (id == "intermission") game.state.intermissionSecs = 5
                // The live race-over road emits `show-music-credit {on:false}`
                // with the board, and a fabricated board fires no effects — so
                // without this the credit chip survives onto all three results
                // shots, where the real game has already taken it down.
                game.state.musicCredit = null
                // phase 1 + the tally + a beat. The tally is bounded at the winner's
                // gain (9 points) times a tick that is itself a fraction of phase 1,
                // so twice the phase plus a second clears it however slow the board.
                val settleMs = if (view?.twoPhase == true)
                    (view.racePhaseMs * 2 + 1_000).toLong() else 0L
                after(settleMs, done)
            }

            // Race one of the cup, resolved: every human finished (their times are
            // the harness's fabricated input), which is exactly what the live
            // `allDone` road watches for. The slow tick then fast-forwards the bots,
            // the drain ends the race and the board goes up; the advance walk that
            // follows is the same one the intermission's own timer calls.
            "chain" -> after(SPIN_MS) {
                finishEveryHuman(game)
                waitFor("the cup board", 20_000L, { game.state.results != null }) { _ ->
                    game.advanceSeriesRace()
                    // Far enough into the new countdown that the banner is up and the
                    // next circuit has been staged behind it, and not so far that the
                    // beats have run out.
                    after(1_200L, done)
                }
            }

            else -> done()
        }
    }

    // -- the fabricated inputs -------------------------------------------------

    /**
     * The pick a race scenario races: `--es ttpTrack` if given, else the CATALOGUE'S
     * FIRST circuit.
     *
     * NOT whatever boot previewed, and the difference is a whole capture. Boot
     * restores `tinytrack_last_track` from preferences, and a lobby scenario WRITES
     * that key as a side effect of its pick — so `lobby-random` (which pins its
     * preview to Powder) silently re-aimed every race card that followed it, and the
     * gallery's Race column came back a snow circuit while the web's was a beach.
     * Order-dependent, machine-dependent, and invisible: both pictures are of a
     * legitimate race.
     */
    private fun trackPick(): JSONObject {
        val id = trackOverride ?: firstTrackId()
        // No literal fallback. A hardcoded track id the catalogue does not hold
        // fails INSIDE the pick walk, a long way from the line that guessed it.
            ?: throw IllegalStateException("the shipped catalogue is empty — was ttp_ui_configure called?")
        return JSONObject().put("mode", "track").put("trackId", id)
    }

    private fun firstTrackId(): String? {
        val catalog = TtpJson.obj(Ttp.ttp_ui_catalogue_json()).optJSONArray("catalog") ?: return null
        return catalog.optJSONObject(0)?.optString("id")?.ifEmpty { null }
    }

    /**
     * A MID-GAME couch: three cups starred, the fourth blank, the Playroom still
     * locked and part-way to its unlock.
     *
     * A fresh couch has nothing to show, so the star shelf and the race card's star
     * badge would photograph as five empty rows — the two dressings the gallery
     * exists to check would be invisible, and every column would agree about
     * nothing. The web harness fabricates the same shape and for the same reason
     * (`PREVIEW_SHELF`: 3/2/1/0 stars, the Playroom locked at 3 of 4).
     *
     * FABRICATED AS AN INPUT, at the seam the live shell uses: the stored blob
     * `ttp_ui_progress_load` takes at boot. The stars, the lock and the unlock
     * counts are all still DERIVED from it in C++, so this cannot photograph a
     * record the game could not reach — and it touches no preference, so the next
     * ordinary launch is the couch it always was.
     */
    private fun fakeProgress(game: GameCoordinator) {
        val cups = TtpJson.obj(Ttp.ttp_ui_catalogue_json()).optJSONArray("cups") ?: return
        val record = JSONObject()
        for (i in 0 until cups.length()) {
            val id = cups.optJSONObject(i)?.optString("id")?.ifEmpty { null } ?: continue
            PREVIEW_BEST.getOrNull(i)?.let { record.put(id, JSONObject().put("best", it)) }
        }
        Ttp.ttp_ui_progress_load(
            TtpJson.arg(JSONObject().put("v", 1).put("cups", record).toString()), 0)
        // Through the LIVE road, which is the one place that re-reads the catalogue
        // and re-publishes the chooser. `null` skips the preference write.
        game.persistProgression(null)
    }

    /**
     * `best` is a FINISHING RANK, not a star count — the record stores where the
     * couch placed and `progression.cc` derives the stars (1st -> 3, 2nd/3rd -> 2,
     * anything else -> 1). Writing 3/2/1 here as if they were stars produced a
     * shelf reading 2/2/3, which is a rule this side does not get to have an
     * opinion about.
     *
     * 1st / 2nd / 4th on the first three cups is the web's `PREVIEW_SHELF` — three
     * stars, two, one, then two blank cups and the Playroom part-way to its unlock.
     */
    private val PREVIEW_BEST = listOf(1, 2, 4)

    /** The shipped catalogue's first cup. */
    private fun firstCupId(): String? {
        val cups = TtpJson.obj(Ttp.ttp_ui_catalogue_json()).optJSONArray("cups") ?: return null
        return cups.optJSONObject(0)?.let { TtpJson.optStr(it, "id") }
    }

    /**
     * The item scenarios force a roulette, so the thing they are named after is on
     * screen rather than showing up once a lap.
     *
     * The two FROZEN previews force a boost for a different reason: they spin the
     * field for several seconds before the shot, and a forced roulette is what
     * fills their cells' item slots on the way past the boxes. The web dresses its
     * frozen previews by hand for the same purpose ("so the cell item indicator
     * shows populated rather than a field of empty squares") — this reaches it
     * through the real pickup instead, which also exercises the filled slot's own
     * outline, shadow and icon.
     */
    private fun forceItem(id: String): String? = when (id) {
        "rocket" -> "rocket"
        "monster" -> "monster"
        "reconnect", "finished" -> "boost"
        else -> null
    }

    /** The scripted party's name for seat [i]. Read by [GameCoordinator.startDemoRace]
     *  too, so the racing HUD and the lobby dock name the same four players. */
    fun nameFor(i: Int): String = NAMES[i % NAMES.size]

    /** Four scripted players, one per livery and one per car model, so a
     *  photographed field shows four different cars rather than four of the same. */
    private fun scriptedSeats(): List<GameState.Seat> = (0 until PLAYERS).map { i ->
        GameState.Seat(
            index = i, open = false, name = nameFor(i),
            colorIndex = i, carIndex = i, modelIndex = i,
            // EVERYONE BUT THE HOST IS READY, which is the web harness's
            // `ready: s !== hostPeerIndex` and the state a real lobby sits in a beat
            // before Start. `ready = i != 1` instead left seat 1 with no mark at all
            // while seat 0 carried both eligibilities — so the dock photographed
            // three different card dressings and the ready check went unexercised on
            // the seat that should have had it.
            off = false, host = i == 0, ready = i != 0,
        )
    }

    /**
     * Publish the scripted party, PADDED BY THE MODEL.
     *
     * The padding rule is `ttp_ui_seat_grid_json`'s precisely so three shells cannot
     * pad differently, so this round-trips through it rather than topping the list
     * up here — the photographed grid is then the grid the live lobby draws.
     */
    private fun seat(state: GameState) {
        val wire = JSONArray()
        for (s in scriptedSeats()) wire.put(s.wire())
        val grid = TtpJson.arr(Ttp.ttp_ui_seat_grid_json(TtpJson.arg(wire.toString())))
        state.seats.clear()
        for (i in 0 until grid.length()) {
            grid.optJSONObject(i)?.let { state.seats.add(GameState.Seat.from(it, i)) }
        }
    }

    /**
     * A finished BOARD in the shape `ttp_ui_standings_live_json` answers, then run
     * through the REAL results view.
     *
     * Fabricated because its gatherer reads LIVE handles — the session's ranked rows
     * and the room-retained field — and neither holds a finished race a second after
     * a demo launch. The same privilege the web harness takes, and the same fake
     * numbers, so the two columns differ only where the UI differs.
     */
    private fun board(kind: String, game: GameCoordinator): JSONObject {
        val cup = kind != "results"
        // THE WHOLE FIELD, off the race that is standing behind the board — not four
        // invented rows. The demo launch tops the grid up to FIELD_SIZE with CPUs, so
        // `sceneCars` already holds the eight cars the HUD behind this glass is
        // drawing, with the engine's own names and liveries. Four rows would have
        // photographed a board the game cannot produce, and would have compared badly
        // against the web card, whose fake board is the full grid.
        val field = game.sceneCars
        val order = JSONArray()
        val rows = field.mapIndexed { i, car ->
            JSONObject()
                .put("playerId", car.id.boxed())
                .put("name", car.name)
                .put("colorIndex", car.colorIndex)
                .put("finished", true)
                .put("time", TIMES[i % TIMES.size])
                // LOAD-BEARING ON THE ROUND TRIP, not just here: racePlace is what
                // carries the FINISHING order through the cup re-sort below, and a
                // board that drops it collapses phase 1 into a table where everyone
                // came first.
                .put("racePlace", i + 1)
                .apply {
                    if (cup) {
                        put("gained", POINTS_BY_RANK.getOrElse(i) { 0 })
                        put("points", BANKED[i % BANKED.size] + POINTS_BY_RANK.getOrElse(i) { 0 })
                    }
                }
        }
        // Built in FINISHING order, then sorted into CUP order — the two orders
        // `standingsPayload` produces. The leader swap (row 2 leads the cup despite
        // row 1 winning this race) is the whole point of photographing phase 2: it
        // is the only thing on the board that shows what the race DID.
        val sorted = if (cup) rows.sortedByDescending { it.optInt("points") } else rows
        for (r in sorted) order.put(r)
        // The LATE JOINER riding along under the field, which is a row shape nothing
        // else on the board has: `rowValue` returns early for it, so every other cell
        // is absent and the card says "Next race" instead of a time. Only the
        // single-race card carries one, matching the web's.
        if (!cup) {
            order.put(JSONObject()
                .put("playerId", field.size + 1)
                .put("name", NAMES[PLAYERS % NAMES.size])
                .put("colorIndex", PLAYERS)
                .put("joining", true))
        }

        val b = JSONObject()
            .put("over", true)
            .put("hostPeerIndex", sorted.firstOrNull()?.opt("playerId") ?: JSONObject.NULL)
            .put("order", order)
        if (cup) {
            val final = kind == "podium"
            val cupRow = TtpJson.obj(Ttp.ttp_ui_catalogue_json())
                .optJSONArray("cups")?.optJSONObject(0) ?: JSONObject()
            val tracks = cupRow.optJSONArray("tracks") ?: JSONArray()
            val raceIndex = if (final) maxOf(tracks.length() - 1, 0) else 1
            val next = if (final) null else tracks.optString(raceIndex + 1).ifEmpty { null }
            b.put(
                "series", JSONObject()
                    .put("cupId", cupRow.optString("id"))
                    // optStr, not optString: a cup's `name` is a nullable engine key,
                    // and org.json reads an explicit JSON null back as the STRING
                    // "null" — so the podium's headline would read "null CHAMPS!".
                    // tests/androidtv-nullable-json.test.js derives that key set from
                    // the C++ writers and caught this line on its first run.
                    .put("cupName", TtpJson.optStr(cupRow, "name") ?: JSONObject.NULL)
                    .put("endless", false)
                    .put("raceIndex", raceIndex)
                    .put("raceCount", maxOf(tracks.length(), 1))
                    .put("nextTrackId", next ?: JSONObject.NULL)
                    .put("nextTrackName", next?.let { trackName(it) } ?: JSONObject.NULL)
                    // `final` on the wire, `isFinal` in C++, and it is what BOTH the
                    // podium and the intermission dressings are derived from.
                    .put("final", final)
                    .put("autoAdvanceMs", Ttp.ttp_race_intermission_ms())
            )
        }
        return b
    }

    private fun trackName(trackId: String): String? {
        val catalog = TtpJson.obj(Ttp.ttp_ui_catalogue_json()).optJSONArray("catalog")
            ?: return null
        for (i in 0 until catalog.length()) {
            val t = catalog.optJSONObject(i) ?: continue
            if (t.optString("id") == trackId) return TtpJson.optStr(t, "name")
        }
        return null
    }

    // -- the frozen previews' dressing ----------------------------------------

    /**
     * Float a reconnect QR over one racer's cell — the last one, so the leader's
     * card is not the one obscured.
     *
     * THROUGH THE PERFORMER, not around it. `show-reconnect` is a net-vocabulary
     * effect the walk emits when a seat drops, and `performNetEffect` is the switch
     * that performs it — already public, because the race walker hands it net ops in
     * place. What is fabricated is the INPUT (which seat dropped), which is the same
     * privilege every scenario here takes; the claim URL, the card payload and the
     * diff over the shown set all stay C++'s.
     */
    private fun dropOneSeat(game: GameCoordinator) {
        val dropped = game.sceneCars.filter { it.cell }.lastOrNull() ?: return
        val seat = JSONObject()
            .put("peerIndex", dropped.id.boxed())
            .put("name", dropped.name)
            .put("colorIndex", dropped.colorIndex)
        game.net.performNetEffect(JSONObject().put("op", "show-reconnect").put("seat", seat))
    }

    /** The leading car that owns a cell, home with a plausible time. */
    private fun finishLeader(game: GameCoordinator) {
        val celled = game.sceneCars.filter { it.cell }
        if (celled.isEmpty()) return
        val hud = game.display.hud()
        // The HUD's slot index is the ROSTER's, so the leading celled car is the one
        // whose slot has the lowest place among them.
        val best = celled.indices.minByOrNull { i -> hud.getOrNull(i)?.place ?: Int.MAX_VALUE }
            ?: return
        Ttp.ttp_force_finish(game.sessionHandle, TtpJson.arg(celled[best].id.json), TIMES[0])
    }

    /** Everybody home: the state the live `allDone` road watches for. */
    private fun finishEveryHuman(game: GameCoordinator) {
        for ((i, car) in game.sceneCars.filter { it.cell }.withIndex()) {
            Ttp.ttp_force_finish(game.sessionHandle, TtpJson.arg(car.id.json), TIMES[i % TIMES.size])
        }
    }

    // -- waiting ---------------------------------------------------------------

    private fun after(ms: Long, block: () -> Unit) {
        main.postDelayed(block, ms)
    }

    /**
     * Poll [cond] on the main looper until it holds or the clock runs out, then run
     * [then] either way.
     *
     * A TIMEOUT IS NOT A FAILURE HERE, it is a warning plus a photograph: a shot of
     * whatever did come up is evidence, and a runner that gave up silently would
     * leave the gallery with a gap that looks like a deliberate one.
     *
     * On the main looper, and it has to be: every `ttp_*` call in this shell happens
     * on that thread (`shells/androidtv/CLAUDE.md` rule 1), and a poll thread reading
     * `hasScene` while the frame loop draws is a data race with no diagnostic.
     */
    private fun waitFor(what: String, timeoutMs: Long, cond: () -> Boolean, then: (Boolean) -> Unit) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        fun poll() {
            if (cond()) { then(true); return }
            if (SystemClock.uptimeMillis() >= deadline) {
                Log.w(TAG, "timed out waiting for $what")
                then(false)
                return
            }
            after(POLL_MS) { poll() }
        }
        poll()
    }
}
