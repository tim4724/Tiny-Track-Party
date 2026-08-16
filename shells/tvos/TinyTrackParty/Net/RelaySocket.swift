import Foundation

/// A `URLSessionWebSocketTask` driver, and nothing else.
///
/// It opens, sends text, receives text, closes, and reports which of those
/// happened. It parses no relay frame and holds no game state, because both are
/// already C++: `ttp_framing_classify` reads the RAW inbound text (JSON parsing
/// included, so "not even an object" is the ported code's call), the encoders
/// produce the exact bytes to write, and `ttp_framing_close_outcome` decides what
/// a close code means. `PartyNet` is the only caller and does all of that; this
/// file is the platform half the ABI deliberately left behind
/// (`ttp_party.h`: "the transport stays on the host side BY DESIGN").
///
/// **The close code is reported, never interpreted.** Two of them are terminal
/// and they are terminal for different reasons: 4000 means another client
/// presented our clientId and evicted us, and 4001 means the ROOM died (the host
/// sent `close_room`, or the relay's ~2 min hostless grace elapsed). 4001 in
/// particular must not become a plain "disconnected" — it is terminal for the
/// room, not for the display, and the display's answer to it is to forget the
/// room and warm a fresh one. That decision lives in `PartyNet`, over
/// `ttp_framing_close_outcome`, which is why `onClose` carries `(hasCode, code)`
/// verbatim rather than a verdict. `hasCode == false` models a close with no code
/// at all, which is the ABI's own first argument.
///
/// **Protocol-level PING is not the game's PING.** The relay is Bun/uWS with
/// `idleTimeout: 10`, which sends WebSocket PING control frames on a quiet socket
/// and closes at 1006 if nothing pongs (`tests/wire-compat/relay.js` documents the
/// measured cadence). URLSession answers those inside its own networking stack,
/// exactly as a browser does — there is nothing to write here for it, and nothing
/// to schedule. `MSG.PING` from a phone is a GAME message that arrives as socket
/// text and is answered with `MSG.PONG`; that is `PartyNet`'s job, because
/// answering it requires knowing which peer asked.
@MainActor
final class RelaySocket {

    /// The socket reached OPEN. `PartyNet` sends its one first frame here.
    var onOpen: (() -> Void)?
    /// One inbound text frame, unparsed.
    var onText: ((String) -> Void)?
    /// `(hasCode, code)` — straight into `ttp_framing_close_outcome`.
    var onClose: ((Bool, Double) -> Void)?

    private(set) var isOpen = false

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?

    /// Which connection attempt the callbacks in flight belong to.
    ///
    /// The web's equivalent is `PartyConnection`'s `if (this.ws !== ws) return`
    /// guard on every handler: a socket that has been replaced (by a reconnect,
    /// by the fresh-room fallback) must not report anything, or a dying
    /// connection's close event heals a connection that is already healthy. A
    /// counter says the same thing without holding a second reference.
    private var generation = 0
    /// One close report per connection. The delegate's `didCloseWith` and the
    /// receive/send failure paths can both fire for the same drop, and the second
    /// one would spend another reconnect attempt.
    private var reported = false

    // MARK: - Lifecycle

    func open(_ url: URL) {
        discard()
        generation += 1
        reported = false
        let gen = generation

        let delegate = Delegate(
            onOpened: { [weak self] in Task { @MainActor in self?.opened(gen) } },
            onClosed: { [weak self] hasCode, code in
                Task { @MainActor in self?.report(gen, hasCode: hasCode, code: code) }
            })
        // No delegate queue of our own: every callback below hops to the main
        // actor itself, so the queue URLSession picks is irrelevant.
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        let task = session.webSocketTask(with: url)
        self.session = session
        self.task = task
        task.resume()
        receive(gen)
    }

    /// `done` reports whether the frame actually FLUSHED, which matters for
    /// exactly one caller: `PartyNet.shutdown` keeps its crash-recovery blob when
    /// the `close_room` did not make it out, because then the room is still alive
    /// and the next launch should regather the party rather than abandon it.
    ///
    /// A send failure is not reported as a close: the socket is about to close on
    /// its own and that path already spends the reconnect attempt.
    func send(_ text: String, then done: ((Bool) -> Void)? = nil) {
        guard let task, isOpen else { done?(false); return }
        task.send(.string(text)) { error in
            Task { @MainActor in done?(error == nil) }
        }
    }

    /// Close and DETACH: no `onClose` fires.
    ///
    /// This is the web's `party.close()`, and the detaching is the point — on the
    /// end-party path our own 4001 echo would otherwise race a fresh room into
    /// existence behind the title board.
    func close() {
        discard()
    }

    private func discard() {
        generation += 1     // everything already in flight is now stale
        isOpen = false
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        // URLSession holds its delegate STRONGLY until it is invalidated, so
        // dropping the reference is not enough to free the delegate (and through
        // it, this object).
        session?.invalidateAndCancel()
        session = nil
    }

    // MARK: - Receiving

    /// Arm one receive.
    ///
    /// `URLSessionWebSocketTask` delivers exactly ONE message per `receive(_:)`
    /// call — unlike a browser's `onmessage`, which stays attached. Every success
    /// path below therefore re-arms, and a dropped re-arm stops all inbound
    /// traffic with the socket still open and nothing logged: the room would sit
    /// there answering nobody.
    private func receive(_ gen: Int) {
        // BOTH guards. `task` here is the CURRENT task, so a stale generation's
        // re-arm (its socket was replaced while its last message was being
        // processed) would otherwise queue a receive on the NEW task — and
        // URLSession hands each inbound message to exactly one caller, so that
        // stale receive EATS one frame and discards it as stale. After a
        // fresh-room fallback the eaten frame is the first heartbeat echo,
        // which reads as a dead link and re-mints the room every few seconds.
        guard let task, generation == gen else { return }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.generation == gen else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        self.onText?(text)
                    case .data(let data):
                        // The relay only ever sends text. A binary frame that
                        // happens to be UTF-8 is handed on anyway rather than
                        // dropped, because `ttp_framing_classify` is the one that
                        // decides what is and is not a frame.
                        if let text = String(data: data, encoding: .utf8) { self.onText?(text) }
                    @unknown default:
                        break
                    }
                    self.receive(gen)
                case .failure:
                    // A read failure IS the close on this API when no close frame
                    // arrived (a dead link, a 1006). The task knows whether a code
                    // was ever received.
                    let code = task.closeCode
                    self.report(gen, hasCode: code != .invalid, code: Double(code.rawValue))
                }
            }
        }
    }

    // MARK: - Reporting

    fileprivate func opened(_ gen: Int) {
        guard generation == gen else { return }
        isOpen = true
        onOpen?()
    }

    fileprivate func report(_ gen: Int, hasCode: Bool, code: Double) {
        guard generation == gen, !reported else { return }
        reported = true
        isOpen = false
        onClose?(hasCode, code)
    }

    /// The `URLSessionWebSocketDelegate` half, kept as a separate object so
    /// `RelaySocket` can stay `@MainActor` without its protocol conformance
    /// having to be.
    ///
    /// It holds two closures rather than a back-reference: `URLSessionDelegate`
    /// is `Sendable`, and a mutable stored property (which a `weak var` has to
    /// be) is exactly what that forbids. The closures capture the socket weakly
    /// and the generation by value, which is the same guard by another spelling.
    private final class Delegate: NSObject, URLSessionWebSocketDelegate {
        private let onOpened: @Sendable () -> Void
        private let onClosed: @Sendable (Bool, Double) -> Void

        init(onOpened: @escaping @Sendable () -> Void,
             onClosed: @escaping @Sendable (Bool, Double) -> Void) {
            self.onOpened = onOpened
            self.onClosed = onClosed
        }

        func urlSession(_ session: URLSession,
                        webSocketTask: URLSessionWebSocketTask,
                        didOpenWithProtocol proto: String?) {
            onOpened()
        }

        func urlSession(_ session: URLSession,
                        webSocketTask: URLSessionWebSocketTask,
                        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                        reason: Data?) {
            onClosed(closeCode != .invalid, Double(closeCode.rawValue))
        }

        func urlSession(_ session: URLSession,
                        task: URLSessionTask,
                        didCompleteWithError error: Error?) {
            // The failure path for a connection that never opened (DNS, TLS,
            // refused): no close frame, so no code — which is exactly what
            // `ttp_framing_close_outcome`'s hasCode=0 models, and it spends a
            // reconnect attempt rather than stopping.
            let code = (task as? URLSessionWebSocketTask)?.closeCode ?? .invalid
            onClosed(code != .invalid, Double(code.rawValue))
        }
    }
}
