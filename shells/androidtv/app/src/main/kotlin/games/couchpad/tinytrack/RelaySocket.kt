package games.couchpad.tinytrack

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * An OkHttp WebSocket driver, and nothing else.
 *
 * It opens, sends text, receives text, closes, and reports which of those
 * happened. It parses no relay frame and holds no game state, because both are
 * already C++: `ttp_framing_classify` reads the RAW inbound text (JSON parsing
 * included, so "not even an object" is the ported code's call), the encoders
 * produce the exact bytes to write, and `ttp_framing_close_outcome` decides what
 * a close code means. [PartyNet] is the only caller and does all of that; this
 * file is the platform half the ABI deliberately left behind (`ttp_party.h`:
 * "the transport stays on the host side BY DESIGN").
 *
 * **The close code is reported, never interpreted.** Two are terminal and for
 * different reasons: 4000 means another client presented our clientId and evicted
 * us, and 4001 means the ROOM died (the host sent `close_room`, or the relay's
 * ~2 min hostless grace elapsed). 4001 in particular must not become a plain
 * "disconnected" — it is terminal for the room, not for the display, and the
 * display's answer is to forget the room and warm a fresh one. That decision
 * lives in [PartyNet] over `ttp_framing_close_outcome`, which is why [onClose]
 * carries `(hasCode, code)` verbatim rather than a verdict.
 *
 * **Protocol-level PING is not the game's PING.** The relay is Bun/uWS with
 * `idleTimeout: 10`, which sends WebSocket PING control frames on a quiet socket
 * and closes at 1006 if nothing pongs. OkHttp answers those inside its own reader
 * thread, exactly as a browser does — there is nothing to write here for it.
 * `MSG.PING` from a phone is a GAME message that arrives as socket text and is
 * answered with `MSG.PONG`; that is [PartyNet]'s job, because answering it
 * requires knowing which peer asked.
 *
 * **EVERY CALLBACK HOPS TO THE MAIN THREAD.** OkHttp delivers on its own reader
 * thread, and everything downstream of here calls into the engine — a documented
 * singleton with per-call scratch returns. The shell's one-thread rule
 * (`shells/androidtv/CLAUDE.md`) is enforced right here, at the only place in the
 * app where another thread would otherwise arrive.
 *
 * **THE HOP IS TIMED, because it is the one interval nothing else can see.** A
 * frame arrives on the reader thread and then WAITS for whatever the main thread
 * is doing — a scene build freezes it for the whole build — and the wait is spent
 * before any `ttp_` call, so no engine readout, no `ttp:` trace marker and no
 * frame-loop span covers it. Measured here and handed to [onText] rather than
 * logged here, because the number is only meaningful next to what the walk that
 * follows it then cost: see [PartyNet.handleText].
 */
class RelaySocket {

    /** The socket reached OPEN. [PartyNet] sends its one first frame here. */
    var onOpen: (() -> Unit)? = null

    /**
     * One inbound text frame, unparsed, plus the NANOSECONDS it spent waiting for
     * the main thread (see the class header).
     */
    var onText: ((String, Long) -> Unit)? = null

    /** `(hasCode, code)` — straight into `ttp_framing_close_outcome`. */
    var onClose: ((Boolean, Double) -> Unit)? = null

    var isOpen = false
        private set

    private val main = Handler(Looper.getMainLooper())

    /**
     * readTimeout 0 because this socket is quiet for minutes at a time and the
     * default would fail it as a stall. The relay's own PING/PONG is the
     * liveness the transport actually has; the GAME's liveness is a separate
     * contract entirely and lives in `ttp_net_liveness_json`.
     */
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var socket: WebSocket? = null

    /**
     * Which connection attempt the callbacks in flight belong to.
     *
     * The web's equivalent is `PartyConnection`'s `if (this.ws !== ws) return`
     * guard on every handler: a socket that has been replaced (by a reconnect, by
     * the fresh-room fallback) must not report anything, or a dying connection's
     * close event heals a connection that is already healthy. A counter says the
     * same thing without holding a second reference.
     */
    private var generation = 0

    /**
     * One close report per connection. OkHttp's `onClosing`, `onClosed` and
     * `onFailure` can fire for the same drop, and the second would spend another
     * reconnect attempt.
     */
    private var reported = false

    fun open(url: String) {
        discard()
        generation += 1
        reported = false
        val gen = generation

        socket = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    main.post { opened(gen) }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    deliver(gen, text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
                    // The relay only ever sends text. A binary frame that happens
                    // to be UTF-8 is handed on anyway rather than dropped, because
                    // `ttp_framing_classify` is what decides what is and is not a
                    // frame.
                    deliver(gen, bytes.utf8())
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    // The peer sent a close frame. Report the CODE here rather
                    // than waiting for onClosed: 4001 is how a room ends, and the
                    // display's answer to it is a fresh room, which should not
                    // wait on a handshake completing.
                    main.post { report(gen, true, code.toDouble()) }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    main.post { report(gen, true, code.toDouble()) }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    // A dead link, a refused connect, a TLS failure: no close
                    // frame, so no code — which is exactly what
                    // `ttp_framing_close_outcome`'s hasCode=0 models, and it
                    // spends a reconnect attempt rather than stopping.
                    main.post { report(gen, false, 0.0) }
                }
            },
        )
    }

    /**
     * `done` reports whether the frame was ENQUEUED, which is weaker than the
     * tvOS shell's "flushed" and the difference matters for exactly one caller:
     * [PartyNet]'s shutdown keeps its crash-recovery blob when the `close_room`
     * did not make it out, because then the room is still alive and the next
     * launch should regather the party rather than abandon it.
     *
     * OkHttp has no per-message flush callback. What it does have is [close],
     * which sends the close frame AFTER draining the write queue — so the
     * shutdown path enqueues, then closes gracefully, and a frame that was
     * accepted here does reach the wire unless the process dies first. That is a
     * genuinely weaker guarantee than URLSession's; it is recorded rather than
     * papered over.
     */
    fun send(text: String, done: ((Boolean) -> Unit)? = null) {
        val ok = isOpen && socket?.send(text) == true
        done?.invoke(ok)
    }

    /**
     * Close and DETACH: no [onClose] fires.
     *
     * This is the web's `party.close()`, and the detaching is the point — on the
     * end-party path our own 4001 echo would otherwise race a fresh room into
     * existence behind the board that replaced it.
     */
    fun close() = discard()

    /**
     * Close GRACEFULLY, draining the write queue first, then detach.
     *
     * The shutdown path's `close_room` is the whole reason this is separate from
     * [close]: cancelling the socket outright would drop that frame and leave the
     * room alive until the relay's hostless grace killed it — at which point a
     * phone still holding the code gets a terminal 4001 and "that race has ended"
     * while a freshly warmed QR sits on the television. That is the exact bug the
     * tvOS shell shipped, and it shipped it by having no caller at all rather
     * than by closing wrongly.
     */
    fun closeGracefully() {
        generation += 1
        isOpen = false
        socket?.close(1000, null)
        socket = null
    }

    private fun discard() {
        generation += 1     // everything already in flight is now stale
        isOpen = false
        socket?.cancel()
        socket = null
    }

    /**
     * Post one frame to the main thread, carrying how long the hop took.
     *
     * The stamp is taken on the READER thread, which is the only place the start
     * of the wait exists — by the time the posted block runs, the wait is over and
     * unrecoverable.
     */
    private fun deliver(gen: Int, text: String) {
        val queuedNs = SystemClock.elapsedRealtimeNanos()
        main.post {
            if (generation != gen) return@post
            onText?.invoke(text, SystemClock.elapsedRealtimeNanos() - queuedNs)
        }
    }

    private fun opened(gen: Int) {
        if (generation != gen) return
        isOpen = true
        onOpen?.invoke()
    }

    private fun report(gen: Int, hasCode: Boolean, code: Double) {
        if (generation != gen || reported) return
        reported = true
        isOpen = false
        onClose?.invoke(hasCode, code)
    }
}
