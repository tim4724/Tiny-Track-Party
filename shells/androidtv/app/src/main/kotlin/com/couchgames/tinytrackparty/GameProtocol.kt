package com.couchgames.tinytrackparty

import org.json.JSONArray
import org.json.JSONObject

/**
 * The shared manifest, READ out of the engine rather than retyped into Kotlin.
 *
 * Every value here comes from one call — `ttp_protocol_manifest_json()` — which
 * exists FOR shells like this one. `ttp_party.h` says so in as many words: a C++
 * layer honours the config rule by including `ttp/protocol.h` and the web shell
 * by reading `public/shared/protocol.js`, and a shell that can do neither had no
 * third option, so its lobby would hand-copy the car list and its transport the
 * liveness windows, with nothing anywhere watching the copy.
 *
 * **A table retyped into Kotlin is pinned by nothing** and will drift the first
 * time a number moves. What pins the export instead: `tests/config-drift.test.js`
 * deep-equals it against the WHOLE of `public/shared/protocol.js`, and
 * `native/runtimetest/abi_check.cc` pins it to the library on every leg. So
 * reading it is the only legitimate source, and the parse below is deliberately
 * the only place in this shell that names any of these keys.
 */
class GameProtocol private constructor(
    /**
     * The web deployment serving the phone controller.
     *
     * `session.h`'s `join_url` needs an origin, and a TV app has none of its own —
     * so the web deployment is a RUNTIME DEPENDENCY of every TV app (shells.md
     * §8). This is the Android spelling of the web's `baseUrlOverride` seam, and
     * the reason nothing below composes a URL by hand: every one of the four URLs
     * a room's identity is spelled into is `ttp_net_*`'s answer over this string.
     */
    val baseUrl: String,

    val relayUrl: String,

    /**
     * The wire vocabulary, flat rather than nested so a call site reads
     * `proto.msgControl` and there is exactly one spelling of each type.
     *
     * Only the types this shell SENDS or matches are read: inbound routing never
     * compares a type string in Kotlin (`ttp_net_message_action` /
     * `ttp_net_inbound_route` do it), so the inbound-side constants have no caller
     * to exist for.
     */
    val msgControl: String,
    val msgItem: String,
    val msgCountdown: String,
    val msgSelectMode: String,

    val liveness: Liveness,

    /** The livery palette, indexed by the dense slot `ttp_room_lowest_free_slot` hands out. */
    val carColors: List<String>,

    /**
     * Kenney model base names, indexed by `carIndex`. The one roster field that
     * never crosses the display ABI — it names BYTES TO FETCH, a platform job.
     */
    val carModels: List<String>,
    val carNames: List<String>,

    /** Per-model handling stats, parallel to [carModels]. Handed straight to `ttp_race_configure`. */
    val carStats: JSONArray,

    /** The cap on PHONES, not on cars: a short-handed lobby is topped up with AI. */
    val maxPlayers: Int,

    /**
     * Cars in every race — humans plus the AI top-up. NOT [maxPlayers]: the tvOS
     * shell once handed `ttp_race_configure` the phone cap and raced half a field
     * while the web raced eight.
     */
    val fieldSize: Int,
    val totalLaps: Int,
    val countdownSeconds: Int,
) {
    /**
     * The presence WINDOWS this shell's own timers arm — never the timers
     * themselves. Only three of the manifest's are read: the phone's ping cadence
     * is the PHONE's, the heartbeat-dead window lives inside
     * `ttp_net_heartbeat_tick_json`, and the create watchdog's delay rides the
     * `arm-create-watchdog` effect.
     */
    class Liveness(
        /** DISPLAY. Silence longer than this drops a seat, through the same path as a real `peer_left`. */
        val timeoutMs: Double,
        /** DISPLAY. The cadence the display re-checks presence on. */
        val tickMs: Double,
        /** DISPLAY. Every racer gone while late joiners wait: hold the room this long, then return. */
        val abandonedRaceGraceMs: Double,
    )

    companion object {
        /**
         * Where the phones load the controller from when nothing overrides it.
         *
         * The fallback is the deploy every push produces
         * (`.github/workflows/preview.yml` builds
         * `https://tinytrack-<branch>.couchpad.games` for every branch, `main`
         * included) — a real, reachable origin rather than an invented hostname,
         * so a shell run with no configuration still shows a QR that works.
         *
         * It is NOT the right value for a shipping build.
         */
        const val DEFAULT_BASE_URL = "https://tinytrack-main.couchpad.games"

        /**
         * Parse the manifest once at boot. Main thread, like every `ttp_*` call.
         *
         * A missing key here is not a runtime condition. The manifest is compiled
         * into the same `.so` as the bridge that reads it, so it can only be
         * absent if the library and the Kotlin are from different builds — in
         * which case every wire type and window is suspect, and a black screen
         * with a wrong room code is a worse outcome than stopping here. Same
         * argument the materials make: assert, do not degrade.
         */
        fun load(baseUrl: String = DEFAULT_BASE_URL): GameProtocol {
            val m = TtpJson.obj(Ttp.ttp_protocol_manifest_json())
            val msg = m.optJSONObject("MSG") ?: JSONObject()
            val live = m.optJSONObject("LIVENESS") ?: JSONObject()

            fun str(o: JSONObject, key: String, block: String): String =
                o.optString(key, "").ifEmpty {
                    error("ttp_protocol_manifest_json(): $block.$key is missing or not a string")
                }

            fun num(o: JSONObject, key: String, block: String): Double {
                if (!o.has(key)) error("ttp_protocol_manifest_json(): $block.$key is missing")
                return o.getDouble(key)
            }

            // An empty CAR_MODELS would reach `ttp_ui_configure` as carCount 0 and
            // produce a lobby whose every car pick is refused, with nothing logged.
            fun strings(key: String): List<String> {
                val a = m.optJSONArray(key)
                    ?: error("ttp_protocol_manifest_json(): $key is missing or the wrong shape")
                return (0 until a.length()).map { a.getString(it) }
            }

            return GameProtocol(
                baseUrl = baseUrl,
                relayUrl = str(m, "RELAY_URL", "manifest"),

                msgControl = str(msg, "CONTROL", "MSG"),
                msgItem = str(msg, "ITEM", "MSG"),
                msgCountdown = str(msg, "COUNTDOWN", "MSG"),
                msgSelectMode = str(msg, "SELECT_MODE", "MSG"),

                liveness = Liveness(
                    timeoutMs = num(live, "TIMEOUT_MS", "LIVENESS"),
                    tickMs = num(live, "TICK_MS", "LIVENESS"),
                    abandonedRaceGraceMs = num(live, "ABANDONED_RACE_GRACE_MS", "LIVENESS"),
                ),

                carColors = strings("CAR_COLORS"),
                carModels = strings("CAR_MODELS"),
                carNames = strings("CAR_NAMES"),
                carStats = m.optJSONArray("CAR_STATS")
                    ?: error("ttp_protocol_manifest_json(): CAR_STATS is missing"),

                maxPlayers = num(m, "MAX_PLAYERS", "manifest").toInt(),
                fieldSize = num(m, "FIELD_SIZE", "manifest").toInt(),
                totalLaps = num(m, "TOTAL_LAPS", "manifest").toInt(),
                countdownSeconds = num(m, "COUNTDOWN_SECONDS", "manifest").toInt(),
            )
        }

        // RANDOM_RACES is deliberately NOT read: what a bare `random` pick means
        // and the ceiling a SELECT_MODE is clamped against are the pick walk's
        // (`ttp_net.cc` normRandomRaces over protocol.h). The tvOS shell shipped
        // its own default of 1 once, and the walk is what made that unrepeatable.
    }
}
