package games.couchpad.tinytrack

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlin.random.Random

/**
 * The display's whole net edge: the Kotlin twin of `public/display/Net.js` and of
 * `shells/tvos/.../PartyNet.swift`.
 *
 * **It performs; it does not sequence.** Every inbound trigger — a relay protocol
 * frame, a peer message, the socket closing, the liveness tick, a drained
 * hostchange/statechange event — is ONE call into `ttp_net.h`'s choreography
 * walks, which mutate the room inside the engine and answer an ordered effect
 * list of platform ops. [perform] below is the whole remaining shape of what used
 * to be the protocol switch, the peer switch, the seat lifecycle, the reconnect
 * claim and the heartbeat canary, each of which the first shell hand-sequenced
 * from the fine-grained exports — which is exactly where its launch bugs lived,
 * twice over. The walks are gated by `abi_check`'s netWalksMatchMultiCallPath.
 *
 * What is left here is the part the ABI deliberately leaves with a shell: the
 * socket, three timers, one small file, and the reconnect backoff bookkeeping
 * (`ttp_framing_close_outcome` is the kit half `PartyConnection` keeps on the
 * web).
 *
 * **THE FASTLANE IS [Fastlane]** — the WebRTC transport over the C++ Link. So
 * the `__rtc` envelopes play their web double role here: the fastlane consumes
 * them (offer/ICE to answer) AND they stay this shell's SIGNAL for the walk,
 * which stamps liveness (any traffic is proof of life) and stops.
 *
 * It remains an ENHANCEMENT: CONTROL falls back to the relay per-message, so a
 * phone with no WebRTC, or a symmetric NAT with no TURN to escape it, plays
 * exactly as before (`tests/wire-no-webrtc.test.js` pins that this is allowed).
 *
 * THREE TIMERS, all here: the 1 Hz liveness tick, the create watchdog, the
 * reconnect backoff. The results failsafe and the cup intermission are the RACE
 * layer's.
 */
class PartyNet(
    private val proto: GameProtocol,
    private val socket: RelaySocket,
    /**
     * For [roomFile] (the crash-recovery blob) and for the fastlane's
     * `PeerConnectionFactory`, which is the one thing here that needs one.
     */
    context: Context,
) {

    // NOT private: PERFORMABLE below is the boot proof's input, and the coordinator
    // is what runs it. Everything else in here stays internal by being unreferenced.
    companion object {
        private const val TAG = "PartyNet"

        /**
         * This shell's CouchPad `cpp` value (CONTRACT §6). The join URL is the
         * only place a display declares which box it is, and the contract requires
         * the QR and the registered controller-URL template to carry the SAME one
         * — so both read this, and neither spells it inline.
         */
        const val CP_PLATFORM = "androidtv"

        /**
         * The walks' shared no-op answer, compared as BYTES so the common case
         * skips the parse — the same trick as `Net.js`'s EMPTY_EFFECTS.
         */
        const val EMPTY_EFFECTS = "{\"effects\":[]}"

        /**
         * The arms of [perform]'s switch, as data, for the boot proof.
         * `ttp_net.h` asks for it in as many words: a missing arm becomes a
         * STARTUP failure instead of a step silently dropped mid-party, which is
         * the only kind of net bug that costs a room its host and leaves no trace.
         * The web runs the same check in `Net.js`; tvOS omits it.
         */
        val PERFORMABLE: Set<String> = setOf(
            "clear-create-timer", "arm-create-watchdog", "join-room", "create-room",
            "pin-instance", "save-room", "forget-room", "room-ready", "start-liveness",
            "reset-reconnect-count", "connect-fresh", "fail-attempt", "reconnect",
            "send-to", "publish", "announce", "close-fastlane", "show-reconnect",
            "clear-reconnect", "rekey-player", "player-renamed", "welcome-item",
            "game-message", "race-abandoned", "track-change", "clear-standings",
        )

    }

    // -- what the coordinator listens to ------------------------------------

    /** `(roomCode, joinUrl)` — the join ticket. Only the QR BITMAP is this platform's. */
    var onRoomReady: ((String, String) -> Unit)? = null

    /**
     * The room this display was advertising is gone (the `forget-room` effect):
     * the join ticket must come DOWN now, not when the next room warms, or a phone
     * scans a dead code while the replacement dials.
     */
    var onRoomGone: (() -> Unit)? = null

    /**
     * The roster moved: re-read it off [roomHandle] with
     * `ttp_ui_roster_seats_room_json`. Deliberately carries no payload — the roster
     * never becomes a Kotlin value, exactly as it never becomes a JS one.
     */
    var onRosterChanged: (() -> Unit)? = null

    /** The `race-abandoned` effect: no racer left and someone is waiting for the next race. */
    var onRaceAbandoned: (() -> Unit)? = null

    /** The socket closed. `true` means the ROOM died (4001) rather than the link. */
    var onClose: ((Boolean) -> Unit)? = null

    /**
     * The `game-message` effect: a message the session policy does not name —
     * START_GAME, CONTROL, the pause requests, SERIES_NEXT.
     */
    var onControllerMessage: ((EngineId, JSONObject) -> Unit)? = null

    /**
     * The `welcome-item` effect. Emitted only when the live race holds this seat's
     * car (the predicate is C++'s, off the session handle).
     */
    var onPlayerWelcomed: ((EngineId) -> Unit)? = null

    /**
     * The `player-renamed` effect: a SEATED player changed their name. The lobby
     * recovers on its own; this exists for the surfaces a RACE froze at its start.
     */
    var onPlayerRenamed: ((EngineId, String) -> Unit)? = null

    /** A seat left the roster for good (the drained `playerleave` event): forfeit its car. */
    var onPlayerLeave: ((EngineId) -> Unit)? = null

    /**
     * The `rekey-player` effect: a dropped player came back on a DIFFERENT device.
     * Move their still-racing car onto the new slot.
     */
    var onPlayerRekey: ((EngineId, EngineId) -> Unit)? = null

    /**
     * The set of dropped seats offering a reconnect QR, in the order they dropped.
     * Each entry is `ttp_net_reconnect_card_json`'s answer.
     */
    var onReconnectSeats: ((List<JSONObject>) -> Unit)? = null

    /** The `track-change` effect: the stored pick resolved a (possibly new) preview circuit. */
    var onTrackChange: ((String) -> Unit)? = null

    // -- what the coordinator answers ---------------------------------------

    /**
     * The live race's session handle, or 0 between races. Handed to the walks and
     * `ttp_net_lobby_frame`, which read every seat's `inRace` off the Game
     * themselves — no car id is ever serialized out and handed back.
     */
    var sessionHandle: () -> Int = { 0 }

    /**
     * Asked per publish: is the race manually paused? A rejoiner must re-raise the
     * pause overlay it missed while away, or its wheel just feels dead.
     */
    var isPaused: () -> Boolean = { false }

    /** Whatever the relay refused, verbatim. */
    var onRelayError: ((String) -> Unit)? = null

    // -- state --------------------------------------------------------------

    /**
     * The RoomFlow handle. Read-through for everyone else: `ttp_room_state`,
     * `ttp_room_list_json` and `ttp_ui_roster_seats_room_json` are all asked of it
     * directly, so nothing anywhere keeps a second copy of the roster. The walks
     * mutate the room through this same handle; the mirrors below exist only to
     * dial sockets and compose URLs, and are written only while performing
     * `save-room` / `forget-room` / `pin-instance`.
     */
    var roomHandle: Int = 0
        private set

    var roomCode: String? = null
        private set
    var instance: String? = null
        private set

    /** The room phase, straight off the machine that owns it. */
    val roomState: String get() = TtpJson.strOrEmpty(Ttp.ttp_room_state(roomHandle))

    /** The effective host as a JSON scalar, or "null". */
    val hostIdJson: String get() = TtpJson.strOrEmpty(Ttp.ttp_room_host_json(roomHandle))

    /**
     * The slot-0 BEARER SECRET, not a name.
     *
     * The relay keys the authoritative seat by it and a socket presenting it
     * EVICTS the incumbent (close 4000). A constant would be no secret at all: the
     * room code is on the TV screen and this source is public, so anyone could
     * claim slot 0 and hijack the big screen out from under the host. Minted from
     * [UUID.randomUUID] (a CSPRNG) and persisted beside the room so a crash
     * recovery still reclaims slot 0.
     */
    private var clientId = ""

    private var standings: JSONObject? = null

    // The reconnect budget, mirroring PartyConnection's. This is the KIT half:
    // `ttp_framing_close_outcome` spends and caps it, `ttp_framing_backoff_ms`
    // schedules it, and the walks never see it.
    private var reconnectAttempt = 0.0
    private var shouldReconnect = true

    /**
     * Dropped seats currently offering a reconnect QR. A LIST rather than a map
     * because `ttp_ui_reconnect_diff_json` is fed this order and a map's is not
     * stable. The SET is driven by the `show-reconnect` / `clear-reconnect`
     * effects; the claim URL is composed here because it needs this shell's base
     * origin.
     */
    private val reconnectSeats = ArrayList<Pair<EngineId, JSONObject>>()

    private val main = Handler(Looper.getMainLooper())

    /**
     * The input fastlane's transport half ([Fastlane]); its netcode is C++'s.
     * Constructed here rather than injected because the only thing it needs from
     * outside is the STUN pair, which is the manifest's.
     */
    private val fastlane = Fastlane(
        context,
        listOf(proto.stunUrl, proto.stunFallbackUrl),
    ) { idx, data -> sendTo(EngineId.number(idx), data.toString()) }

    private var livenessTick: Runnable? = null
    private var createWatchdog: Runnable? = null
    private var reconnectRunnable: Runnable? = null

    /** The app is going away; nothing may reconnect. */
    private var shuttingDown = false

    /** Re-entrancy guard on the event drain (see [drainRoomEvents]). */
    private var draining = false

    /**
     * One small blob: `{room, instance, clientId}`. No roster, no snapshot, no
     * track pick.
     *
     * NOT SharedPreferences, and the reason is a real behaviour difference. The
     * web uses `sessionStorage` PLUS a `pagehide → close_room`: a clean exit ends
     * the party, and only a crash leaves a room to be regathered. Preferences
     * survive a clean quit, so the next launch would dial a DEAD room — it
     * self-heals (the join bounces off "Room not found" into the error walk's
     * fallback), but it costs a round trip and briefly shows a wrong room code on
     * a 1080p screen. A cache file deleted on every `close_room` path gives the
     * web's semantics exactly, and being purgeable is a feature: the blob is only
     * ever crash recovery.
     */
    private val roomFile = File(context.cacheDir, "tinytrack_display_room.json")

    // -- boot ---------------------------------------------------------------

    init {
        // The room machine exists before the socket does, so `roomHandle` is valid
        // for every reader from the first frame drawn. The two windows are the
        // manifest's, fed straight into RoomFlow's own liveness config — this
        // shell picks neither.
        roomHandle = Ttp.ttp_room_create(
            TtpJson.arg(
                JSONObject().put(
                    "liveness",
                    JSONObject()
                        .put("timeoutMs", proto.liveness.timeoutMs)
                        .put("graceMs", proto.liveness.abandonedRaceGraceMs),
                ).toString()
            )
        )
        // 0 is a documented failure, and its consequence is that every later room
        // call is a silent no-op: a lobby that never warms, with nothing in the
        // log to say why.
        if (roomHandle == 0) Log.e(TAG, "ttp_room_create refused — no room machine, nothing will warm")

        // The stored pick's constructor rule. No default track (the coordinator
        // seeds its own idle pick through the walk); hasBag is TRUE and the seed is
        // entropy — the ONE random thing this shell still supplies for the pick
        // machinery. The bag itself (deck, cursor, the walk-the-whole-catalogue
        // rule) lives behind the room handle and only walks draw from it.
        // UNSIGNED 32-bit, like both siblings (Net.js `(Math.random() * 0x100000000) >>> 0`,
        // PartyNet.swift `UInt32.random`). NOT a signed 64-bit value: the bag reads
        // it back as `(uint64_t)seedV->num` (ttp_net.cc), and a negative double
        // converts to 0 on both shipped ABIs — whereupon bagNext(0) substitutes a
        // FIXED constant and the refill deals the same permutation of the whole
        // catalogue every time. `UUID.mostSignificantBits` is signed, so that was
        // half of all launches, and it is invisible to anyone who plays one party.
        Ttp.ttp_net_init_pick(roomHandle, null, 1, Random.nextInt().toUInt().toDouble())

        socket.onOpen = { handleOpen() }
        socket.onText = { handleText(it) }
        socket.onClose = { hasCode, code -> handleClose(hasCode, code) }

        // Fastlane input joins the SAME funnel a relay game-message takes, so the
        // dedup, the CONTROL short-circuit and the button verdict stay
        // single-sourced in the coordinator.
        fastlane.onInput = { idx, ev -> onControllerMessage?.invoke(EngineId.number(idx), ev) }
    }

    /**
     * Warm the room. Called at boot: nothing on this platform gates the room on a
     * board being revealed.
     *
     * The web resolves its base URL here (`/api/baseurl`, localhost only). A TV app
     * has no origin of its own, so the base URL was injected at construction and
     * there is nothing to fetch.
     */
    fun start() {
        restoreRoom()
        connect()
    }

    // -- the connection -----------------------------------------------------

    private fun connect() {
        if (shuttingDown) return
        socket.close()              // the fresh-room fallback replaces the connection
        shouldReconnect = true
        // Reopening a saved room dials the SHARD, and the string comes from the
        // same encoder the room was pinned with. Hand-building it is how `Net.js`
        // used to spell this eleven lines above the call that asks C++ for it.
        val code = roomCode
        val url = if (code == null) proto.relayUrl else TtpJson.strOrEmpty(
            Ttp.ttp_framing_pin_url(TtpJson.arg(proto.relayUrl), TtpJson.arg(code),
                TtpJson.arg(instance ?: ""))
        )
        if (url.isEmpty()) return
        socket.open(url)
    }

    /**
     * Socket OPEN. Join-vs-create is the walk's (it holds the restored room
     * identity); what comes back is `join-room` or `create-room` plus the watchdog
     * arm.
     */
    private fun handleOpen() {
        walk(TtpJson.strOrEmpty(Ttp.ttp_net_on_open_json(roomHandle)))
    }

    private fun handleText(text: String) {
        // The RAW text crosses, unparsed: whether it is even a JSON object is the
        // ported code's call, not a Kotlin paraphrase of it.
        val r = TtpJson.obj(Ttp.ttp_framing_classify(TtpJson.arg(text)))
        when (r.optString("route")) {
            "message" -> handleMessage(r.opt("from"), r.opt("data"))
            // The display AUTHORS the retained snapshot; it does not consume its
            // own replay.
            "state" -> Unit
            "protocol" -> handleProtocol(
                r.optString("type"),
                r.optJSONObject("msg") ?: JSONObject(),
            )
            // "none" — not a JSON object. Dropped, exactly as the kit does.
            else -> Unit
        }
    }

    /**
     * A relay protocol frame: created / joined (post-reload reconciliation
     * included) / peer_joined / peer_left / error. One walk; the seating, the
     * resync and the dead-room fallback all happen inside it.
     */
    private fun handleProtocol(type: String, msg: JSONObject) {
        // SURFACED, always — the web at least warns and a TV has no console, so an
        // unhandled relay error left literally no trace anywhere. That cost the
        // tvOS shell an hour: a room went missing under a display that was still
        // connected and still advertising its code, and the only evidence anyone
        // could gather was a phone saying "Room not found" at a QR that looked
        // perfectly fine.
        if (type == "error") {
            val why = msg.optString("message")
            if (why.isNotEmpty()) onRelayError?.invoke(why)
        }
        walk(TtpJson.strOrEmpty(Ttp.ttp_net_on_protocol_json(
            roomHandle, TtpJson.arg(type), TtpJson.arg(msg.toString()), nowMs())))
    }

    /**
     * A relay message. The walk routes slot-0 echoes (the heartbeat closes its loop
     * there), stamps liveness, and runs the whole peer switch — hello, leave,
     * set_car, set_ready, select_mode, ping — inside the engine.
     */
    private fun handleMessage(from: Any?, data: Any?) {
        if (data == null || data === JSONObject.NULL) return
        val payload = data as? JSONObject
        // The `__rtc` envelopes play their web double role: the fastlane consumes
        // them (offer/ICE to answer), AND they stay this shell's "signal" for the
        // walk, which stamps liveness (any traffic is proof of life) and stops.
        val isSignal = payload?.has(Fastlane.RTC_KEY) == true
        if (isSignal) {
            // The display is relay slot 0 and the signalling peer is a NUMBERED
            // seat; a string-identified peer has no fastlane index to answer on.
            val idx = (from as? Number)?.toInt()
            if (idx != null) fastlane.handleSignal(idx, payload)
        }
        // A payload that is not an object still crosses: JS reads `data.type` off
        // anything without throwing, so a peer sending a bare number stamps its
        // seat. Getting that wrong drops a live phone's seat three seconds later,
        // which is the expensive direction.
        val msgJson = payload?.toString() ?: jsonScalar(data)
        // ONE walk, draws included: the shuffle bag lives behind the room handle
        // (seeded at init_pick), so a random pick draws inside the walk.
        walk(
            TtpJson.strOrEmpty(Ttp.ttp_net_on_peer_message_json(
                roomHandle, sessionHandle(), TtpJson.arg(jsonScalar(from)),
                TtpJson.arg(msgJson), if (isSignal) 1 else 0, nowMs())),
            from = EngineId.from(from),
            data = payload ?: JSONObject(),
        )
    }

    private fun handleClose(hasCode: Boolean, code: Double) {
        cancel(createWatchdog); createWatchdog = null

        // The KIT half: what this close code means for the reconnect budget.
        val o = TtpJson.obj(Ttp.ttp_framing_close_outcome(
            // READ, never re-typed: ttp_party.h declares this export so the kit's
            // budget is stated once (root rule 1). Called here rather than cached in
            // the companion, whose initializer can run before System.loadLibrary.
            if (hasCode) 1 else 0, code, reconnectAttempt,
            Ttp.ttp_framing_max_reconnect_attempts(),
            if (shouldReconnect) 1 else 0))
        if (o.optBoolean("stopReconnect")) shouldReconnect = false
        // 0 for the terminal codes, matching the kit.
        reconnectAttempt = o.optDouble("closeAttempt", 0.0)

        val roomClosed = o.optJSONObject("meta")?.optBoolean("roomClosed") == true

        if (!shuttingDown) {
            // The ROOM half is the walk's: on roomClosed it forgets the room,
            // expires every seat (close_room sends no peer_lefts, so the old roster
            // would haunt the fresh lobby) and answers connect-fresh — that order
            // is load-bearing and lives in C++ now.
            walk(TtpJson.strOrEmpty(Ttp.ttp_net_on_close_json(
                roomHandle, if (roomClosed) 1 else 0)))
        }
        // AFTER the walk, deliberately: the coordinator's room-closed landing seeds
        // a fresh default pick, and the seed's null sender is only the host once
        // the walk has emptied the roster.
        onClose?.invoke(roomClosed)
        if (shuttingDown) return
        if (o.optBoolean("willReconnect")) scheduleReconnect()
    }

    /**
     * The delay is `ttp_framing_backoff_ms`'s (1 s, 1.5, 2.25, 3.375, capped at
     * 5 s), never a schedule invented here.
     */
    private fun scheduleReconnect() {
        cancel(reconnectRunnable)
        val r = Runnable { connect() }
        reconnectRunnable = r
        main.postDelayed(r, Ttp.ttp_framing_backoff_ms(reconnectAttempt).toLong())
    }

    private fun reconnectNow() {
        cancel(reconnectRunnable); reconnectRunnable = null
        connect()
    }

    /**
     * A socket that opened and never got an answer never fires a close, so it
     * drives the same budgeted-retry decision as a codeless one.
     */
    private fun failAttempt() {
        if (!shouldReconnect) return
        socket.close()
        handleClose(hasCode = false, code = 0.0)
    }

    // -- ending the party ---------------------------------------------------

    /**
     * End the party while the app stays up: tell the relay to close the room
     * (every phone bails terminally to its party-over screen) and let our own 4001
     * self-heal into a fresh room. The web's `closeRoom()`, performed by the race
     * flow's `close-room` effect; unlike [shutdown] nothing here stops timers or
     * suppresses the reconnect — the self-heal IS the point.
     */
    fun closeRoom() {
        if (!socket.isOpen) return
        socket.send(TtpJson.strOrEmpty(Ttp.ttp_framing_encode_close_room())) { sent ->
            if (sent) forgetRoomFile()
        }
    }

    /**
     * Come back from the suspension [shutdown] ended the party in.
     *
     * A FRESH room, deliberately, rather than a rejoin: we told the relay to close
     * the old one, so dialling it again would spend a round trip to be told "Room
     * not found" and would put a dead code on a 1080p screen in the meantime. It is
     * the same rule the web runs on a reload — the display going away IS the party
     * ending, so coming back is a new party.
     *
     * The crash-recovery blob is a different road and is untouched here: a crash
     * runs no [shutdown] at all, so the next LAUNCH goes through [start] /
     * [restoreRoom] and regathers the party that outlived us.
     */
    fun resumeWithFreshRoom() {
        shuttingDown = false
        shouldReconnect = true
        reconnectAttempt = 0.0
        walk(TtpJson.strOrEmpty(Ttp.ttp_net_on_close_json(roomHandle, 1)))
    }

    /**
     * The app going away IS the party ending.
     *
     * Same teardown, plus: stop every timer and suppress reconnection, so a close
     * arriving on the way out cannot warm a room nobody will ever see.
     *
     * The saved blob is dropped ONLY once the `close_room` has gone out. That
     * asymmetry is the whole crash-recovery story: a room the relay was told about
     * is dead, and a blob pointing at it would make the next launch dial a corpse.
     * A `close_room` that never made it out leaves the room ALIVE, and then the
     * blob is exactly what turns the next launch into a party-regathering recovery.
     *
     * **THIS MUST HAVE A CALLER.** The tvOS twin shipped complete, documented as
     * running "on termination", and called by nothing — so every exit leaked a
     * room until the relay's ~2 min hostless grace killed it, and a phone still
     * holding that code got a terminal 4001 while a freshly warmed QR sat on the
     * television. A method nothing invokes reads as implemented.
     */
    fun shutdown() {
        shuttingDown = true
        shouldReconnect = false
        cancel(livenessTick); livenessTick = null
        cancel(createWatchdog); createWatchdog = null
        cancel(reconnectRunnable); reconnectRunnable = null
        // Backgrounded: close every RTC link promptly, so the phones' watchdogs
        // notice and re-offer on the way back in.
        fastlane.closeAll()
        if (!socket.isOpen) { socket.close(); return }
        socket.send(TtpJson.strOrEmpty(Ttp.ttp_framing_encode_close_room())) { sent ->
            if (sent) forgetRoomFile()
            // GRACEFUL, so the frame just enqueued drains before the close frame
            // goes. `close()` would cancel it outright.
            socket.closeGracefully()
        }
    }

    /**
     * The process is going away for good (the Activity's `onDestroy`), so the
     * `PeerConnectionFactory` and its native peers go with it. Separate from
     * [shutdown], which ends a PARTY and must leave the fastlane able to answer
     * the next one — Android calls `onStop` on every trip to the home screen.
     */
    fun release() {
        fastlane.dispose()
    }

    // -- the walk -----------------------------------------------------------

    /**
     * Perform a walk's answer: drain the room events the mutations queued (the
     * announce a mutation used to fire mid-walk lands before the walk's own
     * trailing sends — the ABI's stated order), then the effects IN INDEX ORDER.
     *
     * **Nothing here may reorder, batch or skip** — several correctness constraints
     * (the close teardown order, publish-after-store, rekey-player before
     * welcome-item) live in that order alone.
     *
     * `from`/`data` carry the one thing an effect names but the walk does not
     * re-cross: the triggering message (`game-message` hands it to the game layer).
     * Only the peer-message walks pass them.
     */
    private fun walk(
        answer: String,
        from: EngineId? = null,
        data: JSONObject = JSONObject(),
    ): JSONObject {
        drainRoomEvents()
        if (answer == EMPTY_EFFECTS) return JSONObject()
        val ans = try { JSONObject(answer) } catch (_: Throwable) { return JSONObject() }
        val effects = ans.optJSONArray("effects") ?: return ans
        for (i in 0 until effects.length()) {
            val e = effects.optJSONObject(i) ?: continue
            perform(e, from, data)
        }
        return ans
    }

    private fun perform(e: JSONObject, from: EngineId?, data: JSONObject) {
        when (e.optString("op")) {
            "clear-create-timer" -> { cancel(createWatchdog); createWatchdog = null }

            // A socket that opens but never gets a created/joined answer would hang
            // forever — no close event ever fires — so the walk arms a watchdog and
            // the expiry asks C++ whether the attempt is still unanswered.
            "arm-create-watchdog" -> {
                cancel(createWatchdog)
                val r = Runnable {
                    walk(TtpJson.strOrEmpty(Ttp.ttp_net_create_timeout_json(roomHandle)))
                }
                createWatchdog = r
                main.postDelayed(r, e.optDouble("delayMs", 8000.0).toLong())
            }

            "join-room" -> {
                val room = e.optString("room")
                if (room.isNotEmpty()) {
                    socket.send(TtpJson.strOrEmpty(Ttp.ttp_framing_encode_join(
                        TtpJson.arg(clientId), TtpJson.arg(room))))
                }
            }

            "create-room" -> {
                // "" from the model means REGISTER NONE, which is a different thing
                // from registering an empty template: the relay accepts only
                // absolute https templates and rejects the WHOLE create on an
                // invalid one, so a plain-http origin must send no key at all.
                val maxClients = e.optDouble("maxClients", (proto.maxPlayers + 1).toDouble())
                val template = TtpJson.str(Ttp.ttp_net_controller_url_template(
                    TtpJson.arg(proto.baseUrl), TtpJson.arg(CP_PLATFORM)))
                socket.send(TtpJson.strOrEmpty(Ttp.ttp_framing_encode_create(
                    TtpJson.arg(clientId), maxClients, TtpJson.arg(template))))
            }

            // The shell dials from its mirror (connect), so pinning the shard IS
            // updating the mirror — the web's kit re-points its dial URL the same
            // way.
            "pin-instance" -> {
                roomCode = e.optString("room").ifEmpty { null }
                instance = TtpJson.optStr(e, "instance")
            }

            // `instance` is spelled JSON null whenever the room is not sharded,
            // which is the ordinary case. Read with optStr or the mirror becomes
            // the string "null" and the QR on the television carries `#null` as a
            // shard pin — a routing failure for every phone that scans it.
            "save-room" -> {
                roomCode = e.optString("room").ifEmpty { null }
                instance = TtpJson.optStr(e, "instance")
                saveRoomFile()
            }

            "forget-room" -> {
                forgetRoomFile()
                roomCode = null
                instance = null
                // The advertised room is gone: the join ticket comes down NOW, not
                // when the replacement warms, or its QR stays scannable for as long
                // as the fresh create takes.
                onRoomGone?.invoke()
            }

            "room-ready" -> announceRoomReady()

            // The timer guard is all that is left here: the in-flight heartbeat
            // reset that had to precede it happens inside the engine, on the
            // created/joined walk itself.
            "start-liveness" -> startLiveness()

            "reset-reconnect-count" -> reconnectAttempt = 0.0

            "connect-fresh" -> connect()

            "fail-attempt" -> failAttempt()

            "reconnect" -> reconnectNow()

            // The frame data arrives composed (PONG, the self-heartbeat) — this
            // side puts it on the socket and adds nothing.
            "send-to" -> {
                val to = EngineId.from(e.opt("to"))
                val payload = e.opt("data")
                if (to != null && payload != null) {
                    sendTo(to, payload as? String ?: payload.toString())
                }
            }

            "publish" -> publishSnapshot()

            "announce" -> announce()

            // A seat left, was rekeyed or expired: its link dies with it. Closing
            // transport AND Link together is the point — a netcode-only close
            // would strand a connection still in offer/ICE.
            "close-fastlane" -> {
                val idx = (e.opt("peerIndex") as? Number)?.toInt()
                if (idx != null) fastlane.close(idx)
            }

            "show-reconnect" -> {
                val seat = e.optJSONObject("seat")
                val id = EngineId.from(seat?.opt("peerIndex"))
                if (seat != null && id != null) {
                    // The claim URL needs this shell's base origin, so it is
                    // spliced here; the card payload and the DIFF over the set stay
                    // C++'s.
                    val claim = TtpJson.strOrEmpty(Ttp.ttp_net_claim_url(
                        TtpJson.arg(joinUrl()), seat.optDouble("peerIndex")))
                    val card = TtpJson.obj(Ttp.ttp_net_reconnect_card_json(
                        TtpJson.arg(seat.toString()), TtpJson.arg(claim)))
                    reconnectSeats.removeAll { it.first == id }
                    reconnectSeats.add(id to card)
                    onReconnectSeats?.invoke(reconnectSeats.map { it.second })
                }
            }

            "clear-reconnect" -> {
                val id = EngineId.from(e.opt("peerIndex"))
                if (id != null) {
                    val before = reconnectSeats.size
                    reconnectSeats.removeAll { it.first == id }
                    if (reconnectSeats.size != before) {
                        onReconnectSeats?.invoke(reconnectSeats.map { it.second })
                    }
                }
            }

            "rekey-player" -> {
                val old = EngineId.from(e.opt("oldId"))
                val new = EngineId.from(e.opt("newId"))
                if (old != null && new != null) onPlayerRekey?.invoke(old, new)
            }

            "player-renamed" -> {
                val id = EngineId.from(e.opt("peerIndex"))
                val name = TtpJson.optStr(e, "name") ?: ""
                if (id != null) onPlayerRenamed?.invoke(id, name)
            }

            "welcome-item" -> EngineId.from(e.opt("peerIndex"))?.let { onPlayerWelcomed?.invoke(it) }

            "game-message" -> if (from != null) onControllerMessage?.invoke(from, data)

            "race-abandoned" -> onRaceAbandoned?.invoke()

            // trackId can be spelled null by storePickAndPush; "null" would be
            // persisted as the remembered track and previewed at the next boot.
            "track-change" -> {
                TtpJson.optStr(e, "trackId")?.let { onTrackChange?.invoke(it) }
            }

            "clear-standings" -> standings = null

            else -> {
                // An op this build cannot perform is a MISSING CAPABILITY, not an
                // optional step — say so loudly rather than dropping it and leaving
                // a half-set-up room.
                val op = e.optString("op").ifEmpty { "<malformed>" }
                Log.e(TAG, "unperformable effect $op")
                // tokenRequire, not kotlin.assert — that one is inert on ART, so
                // this branch logged and carried on even in a debug build.
                tokenRequire(false) { "net: unperformable effect $op" }
                onRelayError?.invoke("net: unperformable effect $op")
            }
        }
    }

    /**
     * A join ticket for a room that was never created, for [Scenarios].
     *
     * THROUGH `announceRoomReady`, which is the point: the code, the composed join
     * URL and the QR a scenario photographs are then the same three values the
     * `room-ready` effect publishes in a real party, rather than a plausible string
     * this file made up. The tvOS twin writes `"tinytrack.party/\(code)"` by hand and
     * its lobby shots have advertised a URL the app does not serve ever since.
     */
    fun fakeRoom(code: String) {
        roomCode = code
        announceRoomReady()
    }

    private fun announceRoomReady() {
        val room = roomCode ?: return
        // Logged as well as shown: a TV has no address bar and no console, so
        // without this the only way to learn which room the app is in is to read it
        // off the screen with your eyes — which makes joining from a script (or
        // diagnosing a party that will not form) need a person in front of the set.
        Log.i(TAG, "room $room — ${joinUrl()}")
        onRoomReady?.invoke(room, joinUrl())
    }

    // -- the pick -----------------------------------------------------------

    /**
     * The stored lobby pick, read where the walks keep it. One crossing per ask, at
     * button-press frequency; there is no mirror to drift.
     */
    val pick: JSONObject get() = TtpJson.obj(Ttp.ttp_net_pick_json(roomHandle))

    /**
     * A pick made by the DISPLAY ITSELF, riding the same peer-message walk a host's
     * SELECT_MODE takes.
     *
     * ONE CALLER, and it is [Scenarios]. The boot seed that used to be the other one
     * is gone on both shells, replaced by `previewLastCircuit`, which PREVIEWS a
     * circuit without picking one so Start stays gated until a phone picks; this
     * method sat here uncalled until the screenshot harness landed, and
     * `tests/shell-deadcode.test.js` is what said so out loud.
     *
     * THE NULL SENDER IS THE WHOLE MECHANISM, and it is the walk's rule rather than
     * this shell's: `ttp_net_on_peer_message_json` admits a SELECT_MODE from nobody
     * only while the room has NO HOST. So a harness must pick BEFORE it seats
     * anyone — the first seated player becomes host, and a pick after that is
     * refused, which surfaces two steps later as a launch dying with `no-track`.
     */
    fun applyPick(pick: JSONObject) {
        handleMessage(null, JSONObject(pick.toString()).put("type", proto.msgSelectMode))
    }

    /**
     * Perform ONE net-vocabulary effect on behalf of the RACE walker: a race answer
     * may carry net ops in place (the executor merges the set-track walk's tail —
     * track-change, publish — into it), and those belong to this switch. The web's
     * applyEffect falls through to its net performer for the same reason.
     */
    fun performNetEffect(e: JSONObject) = perform(e, null, JSONObject())

    /**
     * The game-layer track swap that keeps mode and cup as they are: same
     * catalogue-membership and same-pick gates as a mode pick, same store / publish
     * / track-change tail.
     *
     * ONE CALLER, and it is [Scenarios]'s random lobby — live play reaches the same
     * walk from the far side, because the executor merges its tail into the race
     * answer (`track-change` -> `onTrackChange`) rather than calling this.
     *
     * NAME COLLISION WORTH KNOWING: `GameCoordinator` has a `setTrack` too, and it
     * is a different thing (it stages the SCENE for a track already picked). The
     * dead-code gate matches a bare `\bsetTrack\b` and cannot tell them apart, so
     * this one's call site is spelled `net.setTrack(...)` on purpose — the gate
     * would have stayed green with this method deleted.
     */
    fun setTrack(id: String) {
        walk(TtpJson.strOrEmpty(Ttp.ttp_net_set_track_json(roomHandle, TtpJson.arg(id))))
    }

    // -- room events --------------------------------------------------------

    /**
     * Drain and re-fire, after every walk (the walks mutate; the ABI queues).
     *
     * The hostchange/statechange bodies are walks themselves: what a host promotion
     * or a phase flip implies (the ready-clear, the countdown restamp, the lobby
     * sweep of dropped seats, when to republish) is decided and MUTATED inside the
     * engine; the effects that come back are performed like any other walk's.
     *
     * The re-entrancy guard is the one real difference from the kit: a nested walk
     * here may itself mutate (freeing disconnected seats on the lobby transition
     * emits more roster changes), and where JS would nest synchronously this
     * appends to the queue the outer loop is already walking. Order is preserved
     * either way.
     */
    private fun drainRoomEvents() {
        if (draining) return
        draining = true
        try {
            while (true) {
                val events = TtpJson.arr(Ttp.ttp_room_events_json(roomHandle))
                if (events.length() == 0) break
                for (i in 0 until events.length()) {
                    val e = events.optJSONObject(i) ?: continue
                    val detail = e.optJSONObject("detail") ?: JSONObject()
                    when (e.optString("type")) {
                        "rosterchange" -> announce()
                        "hostchange" -> walk(TtpJson.strOrEmpty(
                            Ttp.ttp_net_host_change_apply_json(
                                roomHandle, TtpJson.arg(jsonScalar(detail.opt("hostPeerIndex"))))))
                        "statechange" -> walk(TtpJson.strOrEmpty(
                            Ttp.ttp_net_state_change_apply_json(
                                roomHandle, TtpJson.arg(detail.optString("to")), nowMs())))
                        "playerleave" ->
                            EngineId.from(detail.opt("peerIndex"))?.let { onPlayerLeave?.invoke(it) }
                    }
                }
            }
        } finally {
            draining = false
        }
    }

    /**
     * `ttp_room_transition_to` + drain. The race-flow performer's `transition` op;
     * the statechange walk above is what the drain then runs.
     */
    fun transition(state: String) {
        // The web round-trips through its ROOM_STATE table, which is a case fold
        // and nothing else; the ABI takes the state NAME.
        Ttp.ttp_room_transition_to(roomHandle, TtpJson.arg(state.lowercase()))
        drainRoomEvents()
    }

    // -- liveness -----------------------------------------------------------

    private fun startLiveness() {
        if (livenessTick != null) return
        val period = proto.liveness.tickMs.toLong()
        val r = object : Runnable {
            override fun run() {
                // The 1 Hz tick, one walk: the self-heartbeat state machine
                // (in-flight pair lives in the engine — overdue is a FLAG, never an
                // echo age, so a suspended app's starved ticks cannot read as a
                // dead link), then on a sweep the expiry drops, the active-order
                // re-sync and the abandoned-race deadline, in that order on the one
                // clock reading.
                walk(TtpJson.strOrEmpty(Ttp.ttp_net_liveness_json(
                    roomHandle, sessionHandle(), nowMs())))
                main.postDelayed(this, period)
            }
        }
        livenessTick = r
        main.postDelayed(r, period)
    }

    // -- outbound -----------------------------------------------------------

    /**
     * The room's single outbound roster message: the retained host snapshot.
     *
     * There is no per-phone WELCOME. The relay pushes this live to every controller
     * and replays it to each (re)joiner right after `joined`, so a phone recovers
     * its whole state from the replay alone.
     *
     * TRAP: `ttp_net_lobby_frame` returns the FINISHED socket text — composed and
     * framed without leaving C++, reading the roster, every seat's `inRace` AND the
     * stored pick off the handles. Do not parse it, do not re-encode it, and do not
     * route it through `ttp_framing_encode_set_state`: a JSON string is itself a
     * legal `set_state` payload, so there is no way to sniff "already encoded", and
     * guessing publishes a quoted blob the phones cannot read.
     */
    fun publishSnapshot() {
        if (!socket.isOpen) return
        val extra = JSONObject()
            .put("paused", isPaused())
            .put("standings", standings ?: JSONObject.NULL)
        socket.send(TtpJson.strOrEmpty(Ttp.ttp_net_lobby_frame(
            roomHandle, sessionHandle(), TtpJson.arg(extra.toString()))))
    }

    /**
     * Whether a standings board has already gone out this race.
     *
     * It gates the re-push after a rename: re-sending a board that is already up
     * corrects it, but sending a FIRST one early would raise every phone's results
     * overlay mid-race, because that overlay is triggered by a non-null standings.
     */
    fun hasStandings(): Boolean = standings != null

    /**
     * Mirror the latest standings board into the snapshot, so a phone that
     * reconnects on the results screen recovers it by replay. Takes the board's
     * JSON TEXT, which is what `ttp_ui_standings_json` answers.
     */
    fun setStandings(json: String) {
        val board = try { JSONObject(json) } catch (_: Throwable) { JSONObject() }
        standings = if (board.length() == 0) null else board
        publishSnapshot()
    }

    /** Broadcast to every controller. The only broadcast in the game is `MSG.COUNTDOWN`. */
    fun broadcast(json: String) {
        if (!socket.isOpen) return
        socket.send(TtpJson.strOrEmpty(Ttp.ttp_framing_encode_broadcast(TtpJson.arg(json))))
    }

    /**
     * Unicast to one seat: `MSG.ITEM`, and the composed frames the `send-to` effect
     * carries (PONG, the self-heartbeat).
     */
    fun sendTo(id: EngineId, json: String) {
        if (!socket.isOpen) return
        socket.send(TtpJson.strOrEmpty(Ttp.ttp_framing_encode_send_to(
            TtpJson.arg(id.json), TtpJson.arg(json))))
    }

    /**
     * Publish, then tell the shell. One call, because the roster is read off the
     * room HANDLE in both places — publishing does not hand a roster back for
     * rendering to re-serialize.
     */
    private fun announce() {
        publishSnapshot()
        onRosterChanged?.invoke()
    }

    // -- urls ---------------------------------------------------------------

    private fun joinUrl(): String = TtpJson.strOrEmpty(Ttp.ttp_net_join_url(
        TtpJson.arg(proto.baseUrl), TtpJson.arg(roomCode ?: ""),
        TtpJson.arg(instance ?: ""), TtpJson.arg(CP_PLATFORM)))

    // -- room persistence ---------------------------------------------------

    private fun restoreRoom() {
        try {
            if (roomFile.exists()) {
                val saved = JSONObject(roomFile.readText())
                val room = saved.optString("room")
                if (room.isNotEmpty()) {
                    roomCode = room
                    instance = TtpJson.optStr(saved, "instance")
                    // Reuse the secret to land on slot 0.
                    clientId = saved.optString("clientId")
                }
            }
        } catch (_: Throwable) {
            // A corrupt blob is a cold boot, not a crash. It is crash recovery by
            // definition, so there is nothing to salvage and nothing to report.
        }
        // Mint on a cold boot, HERE — before connecting — so the create/join always
        // carries a clientId.
        if (clientId.isEmpty()) clientId = "display-" + UUID.randomUUID()
        // Hand the restored identity to the engine, whose open walk is what decides
        // join-vs-create. The mirror above exists only to dial URLs.
        Ttp.ttp_net_restore_room(roomHandle, TtpJson.arg(roomCode ?: ""),
            TtpJson.arg(instance ?: ""))
    }

    private fun saveRoomFile() {
        val room = roomCode ?: return
        val blob = JSONObject()
            .put("room", room)
            .put("instance", instance ?: JSONObject.NULL)
            .put("clientId", clientId)
        try { roomFile.writeText(blob.toString()) } catch (_: Throwable) { }
    }

    private fun forgetRoomFile() {
        try { roomFile.delete() } catch (_: Throwable) { }
    }

    // -- small conversions --------------------------------------------------

    private fun cancel(r: Runnable?) { if (r != null) main.removeCallbacks(r) }

    /**
     * MONOTONIC, matching the coordinator's — see its `nowMs`. Every LIVENESS
     * window is measured against this, and all of them are stamped by this same
     * shell, so the domain is self-consistent.
     */
    private fun nowMs(): Double = SystemClock.elapsedRealtime().toDouble()

    /**
     * A decoded JSON value back as its own JSON TEXT — the spelling every identity
     * and every untrusted field crosses the ABI as. Absent and JSON null both
     * become `"null"`, which is the half of the absent-vs-null distinction that
     * must survive.
     */
    private fun jsonScalar(value: Any?): String {
        if (value == null || value === JSONObject.NULL) return "null"
        // A one-element array, unwrapped: JSONArray is the only encoder here that
        // takes a bare scalar and spells it the way the ABI reads it.
        val text = JSONArray().put(value).toString()
        return text.substring(1, text.length - 1)
    }
}
