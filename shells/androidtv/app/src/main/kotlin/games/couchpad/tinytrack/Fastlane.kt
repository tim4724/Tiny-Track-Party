package games.couchpad.tinytrack

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer

/**
 * The input fastlane's Android transport: one `PeerConnection` per controller,
 * with the NETCODE untouched in C++ — `ttp::fastlane::Link` behind the four
 * receive-side `ttp_link_*` calls, exactly as the web display drives it
 * (`NativePartyFastlane.js`) and the tvOS twin does (`Net/Fastlane.swift`).
 * Nothing here classifies a packet, dedups a sequence or composes an ack; this
 * file owns sockets-and-timers only:
 *
 *   TRANSPORT   [PeerConnection] + the unreliable/unordered DataChannel the
 *               PHONE opens, over the prebuilt `io.github.webrtc-sdk:android`
 *               distribution (`org.webrtc.*` — the same build HexStacker's TV
 *               shell device-proved). Android ships no system WebRTC either.
 *   SIGNALLING  the `__rtc` envelopes riding the relay ([PartyNet] intercepts
 *               them and calls [handleSignal]). The display is relay slot 0 and
 *               ANSWER-ONLY: the phone opens the connection, so glare cannot
 *               arise on this side.
 *   TIMERS      the WATCHDOG only. The kit's send/idle timers are the SENDER's;
 *               a receiver emits nothing but the acks the Link hands back.
 *
 * LIVENESS IS NOT STAMPED HERE, deliberately: the phone pings at its manifest
 * cadence over the relay socket whenever that socket is alive, and a relay
 * socket that died is a `peer_left` — which outranks liveness on every platform.
 *
 * **EVERYTHING HERE IS ON MAIN** — every peer, every Link, every timer —
 * because `ttp_link_*` is a `ttp_*` call and the shell's one-thread rule binds
 * it (see `shells/androidtv/CLAUDE.md`, which also records why the obvious
 * serial-executor port is wrong here). libwebrtc's observers fire on its own
 * signalling thread, so each hops through [main] before touching anything,
 * reading whatever state the callback carries BEFORE the hop — by the time it
 * runs the channel may have been replaced.
 *
 * The one thing that must NOT be on main is [PeerConnectionFactory] creation:
 * it loads `libjingle_peerconnection_so`, which is long enough to matter on a
 * TV CPU and this object is constructed during boot. So the factory is built on
 * a one-shot thread and handed back to main, and a signal that lands in the
 * meantime is QUEUED rather than dropped. Dropping it would be permanent for
 * the session: the phone re-offers only when a channel it already had closes
 * (`public/controller/Net.js`'s `onPeerClosed`), so an offer that never gets an
 * answer leaves that seat on the relay until it rejoins.
 */
class Fastlane(
    context: Context,
    /** The manifest's STUN pair. No TURN anywhere — a symmetric NAT falls back to the relay. */
    iceServers: List<String>,
    /** Ship an `__rtc` envelope to a controller over the relay. */
    private val sendSignal: (Int, JSONObject) -> Unit,
) {

    /**
     * A fastlane event to surface — the same funnel a relay `game-message`
     * takes, so dedup, the CONTROL short-circuit and the button-press verdict
     * stay single-sourced downstream.
     */
    var onInput: ((Int, JSONObject) -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private val ice = iceServers.map { PeerConnection.IceServer.builder(it).createIceServer() }
    private val peers = HashMap<Int, Peer>()
    private var factory: PeerConnectionFactory? = null

    /** Signals that arrived before the factory landed. See the class comment. */
    private val queued = ArrayList<Pair<Int, JSONObject>>()

    /**
     * [dispose] has run. Checked by the factory's own completion, which is the
     * one thing here that can outlive it: the build is off-thread, so a teardown
     * inside that window would otherwise find `factory` still null, dispose
     * NOTHING, and then be handed a freshly built native factory by a post that
     * also drains [queued] — building peers on an object nothing will ever
     * release. The Swift twin needs no such flag: it builds its factory
     * synchronously, so the window does not exist there.
     */
    private var disposed = false

    /** Per-controller state: the connection, the adopted channel, the C++ Link handle. */
    private class Peer(val pc: PeerConnection) {
        var channel: DataChannel? = null
        var link = 0
        var watchdog: Runnable? = null
        /** For the one-time "input is riding P2P" line — see [apply]. */
        var inputs = 0
        /** Candidates can arrive before the remote description; capped so a peer that
         *  spams ICE without ever completing an offer cannot grow it unbounded. */
        val pending = ArrayList<IceCandidate>()
    }

    init {
        val appContext = context.applicationContext
        Thread({
            ensureFactoryInit(appContext)
            val f = PeerConnectionFactory.builder().createPeerConnectionFactory()
            main.post {
                if (disposed) {
                    runCatching { f.dispose() }
                    return@post
                }
                factory = f
                Log.i(TAG, "factory ready, iceServers=$iceServers")
                val drain = queued.toList()
                queued.clear()
                for ((from, data) in drain) handleSignal(from, data)
            }
        }, "fastlane-init").start()
    }

    // -- signalling (answerer) ------------------------------------------------

    /**
     * Consume an `__rtc` envelope. The kit's test is the KEY's presence alone,
     * never the value, so a malformed envelope is swallowed here rather than
     * leaking into app dispatch.
     */
    fun handleSignal(from: Int, data: JSONObject) {
        if (!data.has(RTC_KEY)) return
        if (factory == null) {
            if (queued.size < MAX_QUEUED) queued.add(from to data)
            return
        }
        when (data.optString(RTC_KEY)) {
            "offer" -> data.optJSONObject("sdp")?.let { handleOffer(from, it) }
            "ice" -> data.optJSONObject("candidate")?.let { handleIce(from, it) }
            // The display never offers, so it can never receive an answer that
            // means anything; unknown kinds are consumed for the same reason
            // malformed ones are.
            else -> Unit
        }
    }

    /**
     * EVERY OFFER STARTS FRESH. A phone re-opens its fastlane by building a new
     * PeerConnection (its kit's `closeAll()` + `open(0)` on every `joined`), so
     * an offer landing on a peer we already hold means the old connection is
     * stale on the far side — and the old LINK is stale with it: the fresh
     * sender's sequences restart, and a surviving `lastAppliedEs` would dedup
     * every subsequent input away. Teardown of both is the one move that keeps
     * transport and netcode lifetimes glued.
     */
    private fun handleOffer(from: Int, sdp: JSONObject) {
        val text = TtpJson.optStr(sdp, "sdp") ?: return
        close(from)
        val f = factory ?: return
        val cfg = PeerConnection.RTCConfiguration(ice)
            .apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
        val pc = f.createPeerConnection(cfg, PeerObserver(from)) ?: return
        val peer = Peer(pc)
        peer.link = Ttp.ttp_link_create()
        peers[from] = peer
        Log.i(TAG, "peer $from: offer received")

        pc.setRemoteDescription(
            onSet {
                val live = peers[from] ?: return@onSet
                if (live.pc !== pc) return@onSet
                for (c in live.pending) runCatching { pc.addIceCandidate(c) }
                live.pending.clear()
                createAnswer(from, live)
            },
            SessionDescription(SessionDescription.Type.OFFER, text),
        )
    }

    private fun createAnswer(from: Int, peer: Peer) {
        peer.pc.createAnswer(
            object : SdpAdapter() {
                override fun onCreateSuccess(desc: SessionDescription) {
                    peer.pc.setLocalDescription(
                        onSet {
                            if (peers[from] !== peer) return@onSet
                            Log.i(TAG, "peer $from: answer sent")
                            sendSignal(
                                from,
                                JSONObject()
                                    .put(RTC_KEY, "answer")
                                    .put("sdp", JSONObject()
                                        .put("type", "answer")
                                        .put("sdp", desc.description)),
                            )
                        },
                        desc,
                    )
                }
            },
            MediaConstraints(),
        )
    }

    private fun handleIce(from: Int, candidate: JSONObject) {
        val peer = peers[from] ?: return
        val sdp = TtpJson.optStr(candidate, "candidate") ?: return
        val ice = IceCandidate(
            TtpJson.optStr(candidate, "sdpMid"),
            candidate.optInt("sdpMLineIndex", 0),
            sdp,
        )
        if (peer.pc.remoteDescription == null) {
            if (peer.pending.size < MAX_PENDING_ICE) peer.pending.add(ice)
        } else {
            runCatching { peer.pc.addIceCandidate(ice) }
        }
    }

    // -- teardown -------------------------------------------------------------

    /**
     * The `close-fastlane` performer, and this side of the watchdog. Closes
     * transport AND link: the netcode-only close would strand a connection still
     * in offer/ICE (leaking the PeerConnection until ICE gives up ~30 s later,
     * and handing the next offer a stale pc).
     */
    fun close(peerIdx: Int) {
        val peer = peers.remove(peerIdx) ?: return
        Log.i(TAG, "peer $peerIdx: teardown (channel=${peer.channel != null}, inputs=${peer.inputs})")
        peer.watchdog?.let { main.removeCallbacks(it) }
        // `dispose()` only releases the DataChannel reference — it does NOT free
        // the observer registered in onDataChannel, so skipping this leaks the
        // native observer plus the Kotlin object graph it pins on every
        // controller reconnect.
        peer.channel?.let {
            runCatching { it.unregisterObserver() }
            runCatching { it.close() }
            runCatching { it.dispose() }
        }
        runCatching { peer.pc.close() }
        runCatching { peer.pc.dispose() }
        if (peer.link != 0) Ttp.ttp_link_dispose(peer.link)
    }

    fun closeAll() {
        for (idx in peers.keys.toList()) close(idx)
        queued.clear()
    }

    /** Release the factory too (the Activity is going away for good). */
    fun dispose() {
        disposed = true
        closeAll()
        factory?.let { runCatching { it.dispose() } }
        factory = null
    }

    // -- the channel (forwarded from PeerObserver, already hopped to main) -----

    private fun emitIceCandidate(peerIdx: Int, candidate: IceCandidate) {
        sendSignal(
            peerIdx,
            JSONObject()
                .put(RTC_KEY, "ice")
                .put("candidate", JSONObject()
                    .put("candidate", candidate.sdp)
                    .put("sdpMid", candidate.sdpMid ?: JSONObject.NULL)
                    .put("sdpMLineIndex", candidate.sdpMLineIndex)),
        )
    }

    private fun adoptChannel(peerIdx: Int, channel: DataChannel) {
        val peer = peers[peerIdx] ?: return
        // Detach a replaced channel rather than closing it: an orphan from a
        // rolled-back offer shares the SCTP stream id, and close() would tear
        // down the adopted channel remotely (the kit's _wireChannel only nulls
        // the handlers for the same reason).
        peer.channel?.let { if (it !== channel) runCatching { it.unregisterObserver() } }
        peer.channel = channel
        peer.inputs = 0
        Log.i(TAG, "peer $peerIdx: data channel ${channel.label()}")
        // The channel can already be open by the time we adopt it (the state
        // callback may have fired against the un-adopted channel and been
        // dropped by the identity guard in onChannelState).
        if (runCatching { channel.state() }.getOrNull() == DataChannel.State.OPEN) {
            channelOpened(peerIdx, peer)
        }
    }

    /**
     * `channel` identifies WHICH channel transitioned: a detached orphan can
     * still deliver a queued callback, and acting on it would tear down the
     * adopted channel or reset the Link mid-session.
     */
    private fun onChannelState(peerIdx: Int, channel: DataChannel, state: DataChannel.State?) {
        val peer = peers[peerIdx] ?: return
        if (peer.channel !== channel) return
        when (state) {
            DataChannel.State.OPEN -> channelOpened(peerIdx, peer)
            DataChannel.State.CLOSED -> close(peerIdx)
            else -> Unit
        }
    }

    private fun onChannelMessage(peerIdx: Int, text: String) {
        val peer = peers[peerIdx] ?: return
        if (peer.link == 0) return
        resetWatchdog(peerIdx, peer)
        // The REAL readyState is pushed before every op: the Link's belief about
        // the channel is what decides whether its ack write counts.
        syncOpen(peer)
        apply(TtpJson.obj(Ttp.ttp_link_inbound(peer.link, TtpJson.arg(text), nowMs())), peerIdx, peer)
    }

    private fun onConnectionState(peerIdx: Int, state: PeerConnection.PeerConnectionState?) {
        if (state == PeerConnection.PeerConnectionState.FAILED ||
            state == PeerConnection.PeerConnectionState.CLOSED
        ) {
            close(peerIdx)
        }
    }

    // -- driving the Link -----------------------------------------------------

    private fun syncOpen(peer: Peer) {
        val open = runCatching { peer.channel?.state() }.getOrNull() == DataChannel.State.OPEN
        Ttp.ttp_link_set_channel_open(peer.link, if (open) 1 else 0)
    }

    /**
     * Apply an outcome: write the packet the Link produced (the ack — this side
     * enqueues nothing), then surface the applied events in order.
     */
    private fun apply(outcome: JSONObject, peerIdx: Int, peer: Peer) {
        if (outcome.optBoolean("sent") && !outcome.isNull("packet")) {
            val channel = peer.channel
            val packet = outcome.opt("packet")
            if (channel != null && packet != null) {
                runCatching {
                    channel.send(DataChannel.Buffer(
                        ByteBuffer.wrap(packet.toString().toByteArray(Charsets.UTF_8)), false))
                }
            }
        }
        val applied = outcome.optJSONArray("applied") ?: return
        // ONCE PER PEER, and it is the only line that distinguishes a fastlane
        // that WORKS from one whose channel merely opened. A Link that opens and
        // then applies nothing (a sender-sequence mismatch dedups every input
        // away, silently) looks identical in every other log here, and the seat
        // just quietly steers over the relay instead.
        if (applied.length() > 0 && peer.inputs == 0) Log.i(TAG, "peer $peerIdx: input is riding P2P")
        peer.inputs += applied.length()
        for (i in 0 until applied.length()) {
            val ev = applied.optJSONObject(i) ?: continue
            onInput?.invoke(peerIdx, ev)
        }
    }

    private fun channelOpened(peerIdx: Int, peer: Peer) {
        syncOpen(peer)
        resetWatchdog(peerIdx, peer)
    }

    private fun resetWatchdog(peerIdx: Int, peer: Peer) {
        peer.watchdog?.let { main.removeCallbacks(it) }
        val r = Runnable {
            Log.w(TAG, "peer $peerIdx: watchdog fired (no inbound in ${WATCHDOG_MS}ms)")
            close(peerIdx)
        }
        peer.watchdog = r
        main.postDelayed(r, WATCHDOG_MS)
    }

    /** MONOTONIC, matching [PartyNet]'s and the coordinator's. */
    private fun nowMs(): Double = SystemClock.elapsedRealtime().toDouble()

    // -- observers ------------------------------------------------------------

    /** An [SdpObserver] that runs [block] on MAIN when the set succeeds. */
    private fun onSet(block: () -> Unit): SdpObserver = object : SdpAdapter() {
        override fun onSetSuccess() { main.post(block) }
    }

    /**
     * One observer per PeerConnection so the peer index travels with the
     * callbacks (the API only hands back the connection). Every callback arrives
     * on libwebrtc's signalling thread and hops to main before touching the
     * owner.
     */
    private inner class PeerObserver(private val from: Int) : PeerConnection.Observer {

        override fun onIceCandidate(candidate: IceCandidate) {
            main.post { emitIceCandidate(from, candidate) }
        }

        override fun onDataChannel(dc: DataChannel) {
            // Registered SYNCHRONOUSLY so no early packet is dropped; only the
            // per-message handling and the state mutation hop onto main.
            dc.registerObserver(object : DataChannel.Observer {
                override fun onMessage(buffer: DataChannel.Buffer) {
                    val bytes = ByteArray(buffer.data.remaining())
                    buffer.data.get(bytes)   // must copy here — the buffer is reused after return
                    val text = bytes.toString(Charsets.UTF_8)
                    main.post { onChannelMessage(from, text) }
                }

                override fun onStateChange() {
                    val state = runCatching { dc.state() }.getOrNull()
                    main.post { onChannelState(from, dc, state) }
                }

                override fun onBufferedAmountChange(previousAmount: Long) {}
            })
            main.post { adoptChannel(from, dc) }
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            Log.i(TAG, "peer $from: connectionState=$newState")
            main.post { onConnectionState(from, newState) }
        }

        // ICE state is the key P2P-reachability signal: CONNECTED = a candidate
        // pair works; FAILED = none did (a symmetric NAT with STUN only, or an
        // emulator's SLIRP network) and the controller stays on the relay.
        override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
            Log.i(TAG, "peer $from: iceConnectionState=$newState")
        }

        // Unused observer surface (data-only, answerer).
        override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {}
        override fun onSignalingChange(newState: PeerConnection.SignalingState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
    }

    /**
     * A failed create/set means this peer never gets a data channel and silently
     * stays on the relay fallback — log it so a no-P2P device leaves a trail
     * (`PartyFastlane.js` warns on the same failures).
     */
    private abstract class SdpAdapter : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) { Log.w(TAG, "sdp create failed: $error") }
        override fun onSetFailure(error: String?) { Log.w(TAG, "sdp set failed: $error") }
    }

    companion object {
        private const val TAG = "Fastlane"

        /**
         * The kit's envelope key (`partyplug/PartyFastlane.js`'s `RTC_KEY`),
         * spelled once per side. `tests/androidtv-fastlane.test.js` holds the
         * spellings together.
         */
        const val RTC_KEY = "__rtc"

        /**
         * `fastlane.h`'s WATCHDOG_MS (an inline constexpr, so there is no export
         * to read; the test above holds the two spellings together). Inbound
         * silence past this on an OPEN channel tears the peer down; the phone's
         * own watchdog then re-offers.
         */
        private const val WATCHDOG_MS = 3000L

        private const val MAX_PENDING_ICE = 32
        private const val MAX_QUEUED = 16

        @Volatile private var factoryInitialized = false

        /** `PeerConnectionFactory.initialize` must run exactly once per process. */
        @Synchronized
        private fun ensureFactoryInit(context: Context) {
            if (factoryInitialized) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context)
                    .createInitializationOptions(),
            )
            factoryInitialized = true
        }
    }
}
