package games.couchpad.tinytrack

import android.graphics.Bitmap
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONArray
import org.json.JSONObject

/**
 * Everything the Compose screens render from, and nothing else.
 *
 * The shape of this type is the shell's half of the project's central rule:
 * **C++ decides, the shell renders.** Every property below was produced by a
 * named `ttp_*` call and is stored verbatim — no view derives a rule, and nothing
 * in this file computes a game answer. When a value looks like it wants a
 * computed property, that is the signal the rule belongs in
 * `libttp-runtime/ttp/ui_model.cc` where the other shells can reach it too.
 *
 * Strings arriving from the model are KEYS plus data (`titleKey`, `racesKey`,
 * `newGameKey`), never composed English — see [Copy] for the tables that turn
 * them into words. That is why this holds `titleKey` and `cupName` as two fields
 * rather than one sentence.
 */
class GameState {

    /**
     * `ttp_ui.h`'s screen enum. The ORDER is the model's (`ui_model.cc`), and
     * `ttp_ui_back_effect` maps each to what BACK does.
     */
    enum class Screen { WELCOME, LOBBY, RACE }

    var screen by mutableStateOf(Screen.WELCOME)

    /**
     * What the 3D surface is doing behind the chrome. The lobby crossfades to the
     * live track preview once a scene is built.
     */
    var sceneVisible by mutableStateOf(false)

    /**
     * `ttp_ui_cover`'s answer — "none" | "boot". A full-bleed board over whichever
     * screen is up, and deliberately NOT a screen of its own: it is not navigable,
     * pushes nothing and has no back behaviour. See `ttp/ui_model.h`, and
     * [RootScreen]'s cover for why it never animates.
     *
     * The literal here is never the one a viewer sees: [GameCoordinator]'s init
     * asks the model for the real answer before the first composition, which it
     * has to because Compose draws long before `boot()` runs. Left to this
     * default the shell answered "no cover owed" for exactly the boot the cover
     * exists to cover, and what a viewer got was BLACK — the SurfaceView punches
     * through the paper windowBackground, so an undrawn surface is not paper, it
     * is a hole.
     */
    var cover by mutableStateOf("none")

    // -- room (the join ticket) ---------------------------------------------

    var roomCode by mutableStateOf("")
    var joinUrl by mutableStateOf("")

    /**
     * Rendered by ZXing. The URL composition is shared C++ (`session.h`'s
     * `join_url`); only the bitmap is per-platform.
     */
    var joinQr by mutableStateOf<Bitmap?>(null)

    // -- lobby ---------------------------------------------------------------

    /**
     * One entry per grid cell, already padded to `maxPlayers` with open seats by
     * `ttp_ui_seat_grid_json`. The padding is the model's job precisely so three
     * shells cannot pad differently.
     */
    val seats = mutableStateListOf<Seat>()

    data class Seat(
        val index: Int,
        val open: Boolean,
        val name: String,
        val colorIndex: Int,
        val carIndex: Int,
        val modelIndex: Int,
        /**
         * A held seat whose phone dropped. Dimmed, deliberately NOT removed — the
         * seat is still theirs to come back to.
         */
        val off: Boolean,
        val host: Boolean,
        val ready: Boolean,
    ) {
        /**
         * The seat as `ttp_ui_seat_grid_json` wants it back — the padding rule is
         * the model's, so a shell that wants a padded grid hands its seats over
         * rather than padding them itself.
         */
        fun wire(): JSONObject = if (open) JSONObject().put("open", true) else JSONObject()
            .put("open", false)
            .put("name", name)
            .put("colorIndex", colorIndex)
            .put("carIndex", carIndex)
            // `connected`, NOT `off`. The grid model TAKES a roster row and
            // DERIVES the dimming from it (ttp_ui.h: roster_seats answers
            // `connected`, seat_grid answers `off`) — so sending `off` sends a key
            // it does not read, leaves `connected` absent, and every seat comes
            // back dimmed. On tvOS that cost every lobby and results photograph
            // the shell ever took: the whole dock at 50%, in the gallery that
            // exists to verify the look.
            .put("connected", !off)
            .put("modelIndex", modelIndex)
            .put("host", host)
            .put("ready", ready)

        companion object {
            fun open(index: Int) = Seat(index, true, "", 0, 0, 0, false, false, false)

            /** Transcription only: no field computed, defaulted to something the model did not say, or renamed. */
            fun from(d: JSONObject, index: Int) = Seat(
                index = index,
                // `open` is the model's own word for a padded placeholder;
                // everything else on the record is absent when it is true.
                open = d.optBoolean("open"),
                name = TtpJson.optStr(d, "name") ?: "",
                colorIndex = d.optInt("colorIndex"),
                carIndex = d.optInt("carIndex"),
                modelIndex = d.optInt("modelIndex"),
                off = d.optBoolean("off"),
                host = d.optBoolean("host"),
                ready = d.optBoolean("ready"),
            )
        }
    }

    /**
     * `CAR_MODELS`, from the protocol manifest, held once so a seat card can look
     * its baked thumbnail up by NAME. The seat grid answers a `modelIndex` and the
     * renders are filed under the model's id, and this is the table between them —
     * held here rather than re-read per seat because it never changes after boot.
     */
    var carModels: List<String> = emptyList()

    /**
     * The couch's RECORD: one row per cup, straight off `ttp_ui_catalogue_json`.
     *
     * **The lobby SHOWS the record** (`docs/native-port/shells.md`), and that is a
     * fourth obligation the other three do not imply: a shell can bank, persist and
     * publish stars correctly and still never show the couch a single one — the
     * reward arc then exists only on the phones, which is where nobody is looking.
     *
     * Every number here is DERIVED IN C++ off the stamped catalogue: the star
     * thresholds, the Playroom lock and the unlock progress. A shell that
     * recomputed one has copied a rule that will drift.
     */
    val cups = mutableStateListOf<CupRow>()

    data class CupRow(
        val id: String,
        val name: String,
        /** 0..3. */
        val stars: Int,
        val locked: Boolean,
        /** Only on a locked row: how far along its unlock is. */
        val unlockDone: Int,
        val unlockNeed: Int,
    ) {
        companion object {
            fun from(d: JSONObject): CupRow? {
                val id = d.optString("id").ifEmpty { return null }
                return CupRow(
                    id = id,
                    name = TtpJson.optStr(d, "name") ?: id,
                    stars = d.optInt("stars"),
                    locked = d.optBoolean("locked"),
                    unlockDone = d.optInt("unlockDone"),
                    unlockNeed = d.optInt("unlockNeed"),
                )
            }
        }
    }

    /** `ttp_ui_cup_slot_json`. Null before the host has picked anything, and the whole card is hidden then. */
    var cupSlot by mutableStateOf<CupSlot?>(null)

    data class CupSlot(
        val nameKey: String,        // "random" | "cup" | "track" | "tour"
        val name: String?,
        val racesKey: String,       // "one" | "endless" | "count" -> Copy.races
        val raceCount: Int,
        /** 0..4 pips; null hides the meter entirely. */
        val difficulty: Int?,
        val maps: List<Map>,
        val cupId: String?,
    ) {
        data class Map(
            val index: Int,
            /**
             * Null is an UNDRAWN race — the "?" chip. The tour's chips all say so
             * (the drawn first race included, so the card spoils nothing), and the
             * shell's own random veil manufactures the rest.
             */
            val trackId: String?,
            /**
             * A cup's running order (1..4); 0 stands in for absent — an exact track
             * has nothing to number, and neither does a "?" chip.
             */
            val n: Int,
            /**
             * The undrawn chip's own cup wash (the tour's ladder). Null on a "?"
             * chip means the picker's neutral grey — an unknown must not borrow the
             * drawn race's colour.
             */
            val cup: String?,
            /**
             * A LOCKED rung of the tour's ladder — `{trackId: null, cup, locked}`.
             * It is not an undrawn race: the chip shows the ladder without selling
             * the cup as a race, and the races pill never counts it.
             */
            val locked: Boolean,
            /** What a "?" chip shows: "?" unless the chip says otherwise (endless carries ∞). */
            val glyph: String,
        )

        /**
         * The web's random veil (`renderLobbyPick`) and its "?" padding
         * (`renderCupSlot`), folded.
         *
         * RANDOM SPOILS NOTHING: a counted card is `raceCount` grey "?" boxes,
         * endless one grey ∞ box — even the drawn race 1 is not the card's to sell.
         * The veil lives HERE rather than in the model because the frozen ui corpus
         * pins cupSlot's random answers to the drawn chip. RANDOM ONLY: a cup's
         * racesKey is 'count' too, and a cup card must never pad — its chips are
         * the model's, "?" placeholders (the tour) included.
         */
        fun veiled(): CupSlot {
            if (nameKey != "random") return this
            val veil = if (racesKey == "endless") {
                listOf(Map(0, null, 0, null, locked = false, glyph = "∞"))
            } else {
                (0 until maxOf(raceCount, 0)).map {
                    Map(it, null, 0, null, locked = false, glyph = "?")
                }
            }
            return copy(maps = veil)
        }

        companion object {
            fun from(d: JSONObject): CupSlot? {
                if (d.length() == 0) return null
                val rawMaps = d.optJSONArray("maps") ?: JSONArray()
                val maps = (0 until rawMaps.length()).map { i ->
                    val m = rawMaps.optJSONObject(i) ?: JSONObject()
                    Map(
                        index = i,
                        // Null/absent is an UNDRAWN race, and it must stay null: an
                        // empty-string id would ask the schematic for a track that
                        // does not exist instead of drawing the "?" chip.
                        // optStr: an UNDRAWN race is spelled JSON null, and
                        // optString would make it the string "null" — which is not
                        // empty, so the "?" chip would never draw and the tile would
                        // ask the schematic for a track named "null".
                        trackId = TtpJson.optStr(m, "trackId"),
                        // 0 stands in for absent (the web tests `m.n != null`): a
                        // cup numbers its maps 1..4, nothing else numbers anything,
                        // and an i+1 default badges "1" onto single-map cards the
                        // web leaves bare.
                        n = m.optInt("n", 0),
                        cup = TtpJson.optStr(m, "cup"),
                        // The tour's ladder shows its LOCKED rungs. Undecoded, a
                        // locked cup painted as an ordinary undrawn "?" — the one
                        // distinction the chip row exists to draw.
                        locked = m.optBoolean("locked"),
                        glyph = "?",
                    )
                }
                return CupSlot(
                    nameKey = d.optString("nameKey"),
                    name = TtpJson.optStr(d, "name"),
                    racesKey = d.optString("racesKey"),
                    raceCount = d.optInt("raceCount"),
                    // null and 0 are different: null hides the whole meter, 0 would
                    // draw four unlit pips.
                    difficulty = if (d.has("difficulty") && !d.isNull("difficulty"))
                        d.optInt("difficulty") else null,
                    maps = maps,
                    cupId = TtpJson.optStr(d, "cupId"),
                )
            }
        }
    }

    // NO `canStart` HERE, and its absence is the design. The readiness gate is
    // `ttp_ui_all_racers_ready`, and the thing it gates is the HOST'S PHONE — this
    // display re-checks it when a START_GAME arrives (`ttp_race_start_json` asks
    // again) and has nothing of its own to enable. A Start button on the TV was a
    // second road into startRace, i.e. a duplicate authority rather than a missing
    // affordance.

    // -- race ----------------------------------------------------------------

    /**
     * One per split-screen cell, in the order `ttp_display_cells` named them, with
     * the rect the RENDERER letterboxed for that cell.
     */
    val cells = mutableStateListOf<CellHUD>()

    data class CellHUD(
        val index: Int,
        /**
         * Whose cell this is. Carried so the item slot can find this car's pickup
         * counter — the slot re-spins on a fresh PICKUP, not on the item changing,
         * and those differ when a box re-rolls the same id.
         */
        val car: EngineId,
        /** Top-left origin, in the SURFACE's physical pixels, exactly as the ABI answered. */
        val rect: CellRect,
        val name: String,
        val colorIndex: Int,
        /**
         * The car MODEL index — what `--icon-car` paints the monster chip's cab
         * with. The MODEL's body tone, not the livery: the livery (`colorIndex`)
         * only ever paints the name chip.
         */
        val carIndex: Int,
        val place: Int,
        val lap: Int,
        val totalLaps: Int,
        /** `TTP_ITEM_*` as a key, or null for an empty slot. Never shown while finished. */
        val item: String?,
        val finished: Boolean,
        /**
         * Null unless the row is TIMED. A forfeit resolved at the flag is
         * `finished` with no time, and printing "0.0s" for it would be a lie the
         * packed block deliberately makes distinguishable.
         */
        val finishTime: Double?,
        val reconnecting: Boolean,
        /** The claim URL this seat's phone should scan to come back. Only set while reconnecting. */
        val reconnectUrl: String?,
    )

    /** "3" / "2" / "1" / "GO!" / null. */
    var countdown by mutableStateOf<String?>(null)
    var paused by mutableStateOf(false)
    var pauseButtonShown by mutableStateOf(false)

    /**
     * The CC-BY attribution for the playing song. A LICENSING obligation, not
     * chrome: the catalogue is Kevin MacLeod's under CC-BY and a shell that plays
     * it owes a visible credit.
     */
    var musicCredit by mutableStateOf<MusicCredit?>(null)

    data class MusicCredit(
        val title: String,
        val artist: String,
        val license: String,
        val source: String,
    )

    /**
     * The BOOST item icon's chevron accent for the biome the current scene
     * resolved to. `ttp_theme_boost_icon(biome)` answers it, and it is one of
     * exactly two colours a shell may ask the theme for. Wanting a third means the
     * look is being rebuilt in the UI layer instead of by the renderer.
     *
     * Kept as the ABI's own 0xRRGGBB rather than a Color: what consumes it is the
     * `--icon-accent` SUBSTITUTION into the shared SVG, which needs the hex back.
     */
    var boostAccent by mutableStateOf(ItemIcon.DEFAULT_ACCENT)

    // -- results -------------------------------------------------------------

    /**
     * `ttp_ui_results_view_json`. The same board goes on the wire to the phones
     * (`ttp_ui_standings_json`), so the TV and the phones can never tell different
     * stories.
     */
    var results by mutableStateOf<ResultsView?>(null)

    data class ResultsView(
        val podium: Boolean,
        val intermission: Boolean,
        /** PHASE 2's header. Phase 1 uses [raceTitleKey] — crowning a champion while rows can still overtake would mark the wrong one. */
        val titleKey: String,       // -> Copy.title
        /** PHASE 1's header: still just "race 4 of 4". */
        val raceTitleKey: String,
        val cupName: String?,
        val sub: Sub?,
        /**
         * **A CUP BOARD IS TWO PHASES** (`ttp_ui.h`). [raceRows] is who won the
         * RACE, in finishing order with lap times, and it holds for [racePhaseMs];
         * then it becomes [listRows], the cup table it rewrote, in standings order
         * with points. A shell that paints only listRows states the delta and never
         * shows the change.
         */
        val twoPhase: Boolean,
        val racePhaseMs: Double,
        val raceRows: List<Row>,
        val listRows: List<Row>,
        val next: Next?,
        val newGameKey: String,     // -> Copy.newGame
    ) {
        data class Sub(val key: String, val cupName: String, val race: Int, val of: Int?)

        /**
         * `secs` is what the model emits, and it is a SNAPSHOT taken when the board
         * was composed. The live number comes from `ttp_ui_intermission_secs` on the
         * coordinator's 500 ms ticker, so a stalled frame or a suspended app cannot
         * drift it away from the deadline the phones were told.
         */
        data class Next(val trackName: String, val secs: Int)

        /**
         * One board row, exactly as `rowValue` emits it.
         *
         * Note what is NOT here: no `place` and no `dnf`. The model sends neither —
         * rank is the row's POSITION (which is why the podium's offset matters), and
         * "did not finish" is `finished == false`. A decoder that invented those two
         * fields would be re-deriving the model's answer in Kotlin.
         */
        data class Row(
            /** `playerId`, kept as the identity's JSON so it is stable across re-decodes. */
            val id: String,
            val name: String,
            val ai: Boolean,
            val colorIndex: Int,
            val finished: Boolean,
            val time: Double?,
            /**
             * A seat that joined mid-race and races next. Such a row carries NOTHING
             * ELSE — `rowValue` returns early — so every other field here is its
             * neutral value, by the model's design.
             */
            val joining: Boolean,
            val points: Int?,
            val gained: Int?,
            /**
             * What this row had coming IN.
             *
             * On every `time_gain` and `points` row, and it is the whole reason the
             * total can CLIMB rather than jump: phase 1 shows this, phase 2 counts
             * up to `points`. **No shell subtracts `gained` for itself** — the model
             * sends the before-value precisely so nobody has to.
             */
            val pointsBefore: Int?,
            /** 1|2|3 on the podium's top three. */
            val medal: Int?,
            /** `time` | `time_gain` | `points` | `joining` — which trailing cell. */
            val kind: String?,
        )

        companion object {
            fun from(d: JSONObject): ResultsView? {
                if (d.length() == 0) return null
                val sub = d.optJSONObject("sub")?.let {
                    Sub(
                        it.optString("key"), TtpJson.optStr(it, "cupName") ?: "", it.optInt("race"),
                        if (it.has("of") && !it.isNull("of")) it.optInt("of") else null,
                    )
                }
                val next = d.optJSONObject("next")?.let {
                    Next(it.optString("trackName"), it.optInt("secs"))
                }
                return ResultsView(
                    podium = d.optBoolean("podium"),
                    intermission = d.optBoolean("intermission"),
                    titleKey = d.optString("titleKey"),
                    raceTitleKey = d.optString("raceTitleKey"),
                    cupName = TtpJson.optStr(d, "cupName"),
                    sub = sub,
                    twoPhase = d.optBoolean("twoPhase"),
                    racePhaseMs = d.optDouble("racePhaseMs", 0.0),
                    // `raceRows`, NOT `podiumRows`. The tvOS twin decodes the latter
                    // and there is no such key anywhere in the C++ — its board has
                    // therefore always been handed an empty list for phase 1. Read
                    // ttp_ui.h, not a sibling shell's transcription of it.
                    raceRows = rows(d.optJSONArray("raceRows")),
                    listRows = rows(d.optJSONArray("listRows")),
                    next = next,
                    newGameKey = d.optString("newGameKey"),
                )
            }

            private fun rows(a: JSONArray?): List<Row> {
                if (a == null) return emptyList()
                return (0 until a.length()).mapNotNull { i ->
                    val d = a.optJSONObject(i) ?: return@mapNotNull null
                    Row(
                        // `playerId`, not `id`. Falling back to the name keeps a row
                        // identifiable even if the model ever omitted it; a fresh
                        // random id would make every re-decode a new row and
                        // re-animate the board.
                        id = EngineId.from(d.opt("playerId"))?.json ?: (TtpJson.optStr(d, "name") ?: ""),
                        name = TtpJson.optStr(d, "name") ?: "",
                        ai = d.optBoolean("ai"),
                        colorIndex = d.optInt("colorIndex"),
                        finished = d.optBoolean("finished"),
                        // `time` is explicitly null for a car that did not finish,
                        // so null here IS the DNF signal — there is no separate flag.
                        time = if (d.has("time") && !d.isNull("time")) d.optDouble("time") else null,
                        joining = d.optBoolean("joining"),
                        points = if (d.has("points") && !d.isNull("points")) d.optInt("points") else null,
                        gained = if (d.has("gained") && !d.isNull("gained")) d.optInt("gained") else null,
                        pointsBefore = if (d.has("pointsBefore") && !d.isNull("pointsBefore"))
                            d.optInt("pointsBefore") else null,
                        medal = if (d.has("medal") && !d.isNull("medal")) d.optInt("medal") else null,
                        kind = d.optString("kind").ifEmpty { null },
                    )
                }
            }
        }
    }

    /**
     * Seconds left on the intermission, re-read from `ttp_ui_intermission_secs`
     * every 500 ms rather than counted down locally.
     */
    var intermissionSecs by mutableStateOf<Int?>(null)

    // -- diagnostics ---------------------------------------------------------

    /**
     * Bumped every time a car takes a FRESH pickup, keyed by identity.
     *
     * The item slot re-spins its slot machine even when the new item is the same id
     * as the old one, so "did the item change" is not the trigger — a pickup is.
     * The model decides when one happened (`item-pickup`); this is the counter the
     * HUD animates off.
     */
    val itemPickupTick = mutableStateMapOf<EngineId, Int>()

    /**
     * The last thing that went wrong, and the ONLY channel this app has for saying
     * so.
     *
     * It logs as well as publishing, and that is not debug scaffolding: a TV has no
     * console, no devtools and no way for a viewer to report anything but "the
     * screen is black". Every failure path in this shell is a silent one by
     * construction — a missing material degrades quietly, a rejected scene build
     * leaves the previous frame up — so the one place they converge has to be
     * audible in `adb logcat`.
     */
    var lastError by mutableStateOf<String?>(null)
        private set

    fun fail(message: String) {
        lastError = message
        Log.e("ttp", message)
    }

    /** Whatever it said is no longer true. See the room-ready hook. */
    fun clearError() { lastError = null }
}
