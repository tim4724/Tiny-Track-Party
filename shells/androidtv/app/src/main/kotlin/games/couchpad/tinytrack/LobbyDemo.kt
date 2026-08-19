package games.couchpad.tinytrack

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

/**
 * The lobby's attract race: a field of CPU cars driving the picked track behind
 * the join ticket, so the board is never a still photograph of an empty circuit.
 *
 * It is a SHELL concern and stayed one deliberately. `race_flow.cc`'s header
 * names LobbyDemo among the things that did not cross, alongside the shuffle bag
 * and the host's mode pick: what it needs is a session, a track and a timer, all
 * three of which are the shell's to own, and the field composition it does need
 * is already an ABI (`ttp_race_demo_live_json`, off the live room handle).
 *
 * It is SILENT for free. The audio layer only ever hears the BOUND session
 * (`abi_check` asserts it), and this one is never bound — so nothing here has to
 * remember to mute anything, and nothing can forget to.
 */
class LobbyDemo {

    private var handle = 0
    private val main = Handler(Looper.getMainLooper())
    private var tick: Runnable? = null
    private var lastTickMs = 0L

    /**
     * What the running demo was built from, for the in-place swap check: the
     * re-dress path only qualifies while the TRACK and the car-id SET both stand
     * (a join/leave or a track switch reorders slots, which is a full build by the
     * renderer's own contract).
     */
    private var field: List<JSONObject> = emptyList()
    private var track = ""

    /**
     * The cheap signature of what is currently on screen. `ttp_race_demo_sig`
     * exists so a roster change that does not change the PICTURE (a rename, a
     * ready toggle) does not tear the race down and rebuild it, which would read
     * as a stutter every time someone pressed a button on their phone.
     */
    private var signature: String? = null

    /** Where the field comes from and what track to drive. */
    var room: () -> Int = { 0 }
    var trackId: () -> String = { "" }

    /** Handed the session so the coordinator can put the scene on it. Never binds audio. */
    var onSession: ((Int) -> Unit)? = null

    /**
     * Handed the attract field so the coordinator can put those cars in the SCENE
     * ROSTER, before the session is bound.
     *
     * **A BOUND SESSION IS NOT A DRAWN CAR**, and that is the whole reason this
     * callback exists rather than the demo just binding and being done. The
     * renderer's field is `ttp_display_build`'s roster: `buildFrame` walks the
     * ROSTER and looks each slot's car up in the bound session, so a car the
     * session has and the roster does not is simulated, stepped, and drawn by
     * nothing. No error, no warning, no missing-asset log — an empty circuit.
     *
     * The tvOS shell bound the demo session and left the roster at whatever the
     * last race had put there, which in a fresh lobby is EMPTY. So the attract
     * race ran perfectly, invisibly, for the whole of every lobby.
     */
    var onField: ((JSONArray) -> Unit)? = null

    /**
     * Same track, same set of cars, only the PICKS changed (a player switched
     * their car or livery): hand the new field over for an in-place re-dress
     * (`ttp_display_reroster`) so the demo race keeps driving and the preview
     * camera keeps its orbit phase. The session is deliberately NOT restarted: the
     * new handling stats only land on the next full rebuild, exactly as on the web
     * (handling differences are invisible in eye-candy, and re-seating would pop
     * the field back to the grid).
     */
    var onRedress: ((JSONArray) -> Unit)? = null

    /**
     * Whether a [refresh] right now would stand a new attract race up on `track` —
     * and therefore rebuild the scene with its field in the roster.
     *
     * It exists so `setTrack` does not build the same scene first, with an EMPTY
     * roster, only for this to build it again a moment later. Two full track
     * meshes and two 2048x2048 shadow bakes, back to back, on the main thread:
     * that pair is what made switching cups look like a hang.
     */
    fun willRebuild(forTrack: String): Boolean {
        if (forTrack.isEmpty()) return false
        val live = TtpJson.obj(Ttp.ttp_race_demo_live_json(
            room(), TtpJson.arg(forTrack), TtpJson.arg("null")))
        return live.optString("sig") != signature || handle == 0
    }

    fun refresh() {
        val t = trackId()
        if (t.isEmpty()) { stop(); return }

        // The grid and its signature in ONE crossing, off the live room. The last
        // argument is a bot CAP as a JSON scalar, not a seed: the attract grid is a
        // deterministic fill (persona by final grid index), so there is nothing
        // random to seed. "null" means fill to the field size.
        val live = TtpJson.obj(Ttp.ttp_race_demo_live_json(
            room(), TtpJson.arg(t), TtpJson.arg("null")))
        val sig = live.optString("sig")
        // Same picture as the one already running: leave it alone.
        if (sig == signature && handle != 0) return

        val rawField = live.optJSONArray("field") ?: JSONArray()
        val fresh = (0 until rawField.length()).mapNotNull { rawField.optJSONObject(it) }

        // Same track + same set of cars → swap the picks in place; anything else is
        // a full teardown and rebuild.
        if (handle != 0 && t == track && sameCarSet(fresh, field)) {
            field = fresh
            signature = sig
            onRedress?.invoke(rawField)
            return
        }

        stop()
        signature = sig
        field = fresh
        track = t
        start(rawField, t)
    }

    /**
     * The two fields cover the exact same set of car ids, so only liveries, models
     * or names could have changed — the cue to swap in place.
     */
    private fun sameCarSet(a: List<JSONObject>, b: List<JSONObject>): Boolean {
        if (a.size != b.size) return false
        val ids = b.mapNotNull { it.opt("id")?.toString() }.toSet()
        return a.all { it.opt("id")?.toString() in ids }
    }

    fun stop() {
        tick?.let { main.removeCallbacks(it) }
        tick = null
        signature = null
        field = emptyList()
        track = ""
        if (handle == 0) return
        Ttp.ttp_dispose(handle)
        handle = 0
        onSession?.invoke(0)
    }

    private fun start(rawField: JSONArray, track: String) {
        // The ROSTER first, then the cars, then the bind. See [onField]: a slot the
        // roster does not name is a car nothing draws.
        onField?.invoke(rawField)

        // Laps are irrelevant to an attract race that nobody finishes; a seed of 0
        // keeps it reproducible, which makes a lobby screenshot the same picture
        // twice. `begin_field` is the one construction road (the demo grid is all
        // bots, so every entry carries a spec). The persona rides NESTED on the
        // demo field entry — reading caution/laneBias off the top level finds
        // nothing and every bot drives the default persona on the same wander seed.
        // 0x5eed is the web twin's DEMO_SEED: lobby determinism, distinct weave per
        // grid slot.
        val rows = JSONArray()
        val bots = JSONArray()
        for (i in 0 until rawField.length()) {
            val b = rawField.optJSONObject(i) ?: continue
            rows.put(JSONObject()
                .put("peerIndex", b.opt("id") ?: JSONObject.NULL)
                .put("stats", b.opt("stats") ?: JSONObject.NULL))
            val persona = b.optJSONObject("persona") ?: JSONObject()
            bots.put(JSONObject()
                .put("peerIndex", b.opt("id") ?: JSONObject.NULL)
                .put("caution", if (persona.has("caution")) persona.opt("caution") else 1)
                .put("laneBias", if (persona.has("laneBias")) persona.opt("laneBias") else 0)
                .put("seed", 0x5eed + i * 2 + 1))
        }

        handle = Ttp.ttp_session_begin_field(
            TtpJson.arg(track), 0, 3, null,
            TtpJson.arg(rows.toString()), TtpJson.arg(bots.toString()))
        if (handle == 0) return

        // BARE start (< 0): racing from frame 0, no countdown. A countdown of ZERO
        // is not the same thing: it still runs the countdown state machine, whose
        // GO rides the event drain, and this demo deliberately never drains events
        // (it is scenery) — so the grid sat parked at the gantry forever, a track
        // preview with no ongoing race.
        Ttp.ttp_session_start(handle, -1)
        onSession?.invoke(handle)

        // Its own clock rather than the display loop's. The demo runs while the
        // lobby board is up, which is exactly when the shell has no reason to be
        // doing anything at 60 Hz — 30 Hz is invisible on a slow orbit and halves
        // the work behind a static board.
        lastTickMs = SystemClock.elapsedRealtime()
        val r = object : Runnable {
            override fun run() {
                if (handle == 0) return
                val now = SystemClock.elapsedRealtime()
                // Clamped for the same reason the race loop clamps: a suspended app
                // must not resume by simulating the minutes it was away.
                Ttp.ttp_update(handle, minOf((now - lastTickMs).toDouble(), 50.0))
                lastTickMs = now
                main.postDelayed(this, 33)
            }
        }
        tick = r
        main.postDelayed(r, 33)
    }
}
