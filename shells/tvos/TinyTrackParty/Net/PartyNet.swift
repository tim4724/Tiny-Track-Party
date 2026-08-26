import Foundation

/// The display's whole net edge: the Swift twin of `public/display/Net.js`.
///
/// **It performs; it does not sequence.** Every inbound trigger — a relay
/// protocol frame, a peer message, the socket closing, the liveness tick, a
/// drained hostchange/statechange event — is ONE call into `ttp_net.h`'s
/// choreography walks, which mutate the room inside the engine and answer an
/// ordered effect list of platform ops. `perform` below is the whole remaining
/// shape of what used to be the protocol switch, the peer switch, the seat
/// lifecycle, the reconnect claim and the heartbeat canary, each of which this
/// file once hand-sequenced from the fine-grained exports — which is exactly
/// where the first shell's launch bugs lived, twice over. The walks are gated by
/// `abi_check`'s netWalksMatchMultiCallPath against those same exports.
///
/// What is left here is the part the ABI deliberately leaves with a shell: the
/// socket, three timers, one small file, the reconnect backoff bookkeeping
/// (`ttp_framing_close_outcome` is the kit half `PartyConnection` keeps on the
/// web), and the shuffle-bag draw a random pick asks for (`needDraw`).
///
/// THE FASTLANE IS `Fastlane.swift` — the WebRTC transport over the C++ Link
/// (`ttp_link_*`), added along the exact recipe this header used to carry for
/// it: the phone opens the connection so this side only ANSWERS, the `__rtc`
/// envelopes ride `sendTo`, the REAL `readyState` is pushed before every Link
/// op, and the `close-fastlane` performer actually closes something now. The
/// envelopes stay this shell's `isSignal` for the walk (any traffic is proof
/// of life) AND are handed to the fastlane — the same double role they play on
/// the web. CONTROL still falls back to the relay per-message: the phone tries
/// P2P and relays on the same call, so nothing here gates on the channel. No
/// new `wire-mutate` case was owed: this shell's only C++ send path is the
/// Link's ack, which the web display already exercises and the fastlane
/// mutations already anchor.
///
/// THE TIMERS THIS FILE OWNS are the 1 Hz liveness tick, the create watchdog and
/// the reconnect backoff, and no others: the cup intermission and its display
/// ticker are the RACE layer's and live in
/// `GameCoordinator+Race.swift`, and the fastlane's receive-side WATCHDOG is
/// `Fastlane.swift`'s (the kit's send/idle timers are the sender's and exist on
/// the phone, not here). Counted rather than named, this list was wrong within
/// two commits of being written — a timer arriving in one file renumbered the
/// comments in another.
@MainActor
final class PartyNet {

    // MARK: - What the coordinator listens to

    /// `(roomCode, joinUrl)` — the join ticket. The URL is `ttp_net_join_url`'s;
    /// only the QR BITMAP is this platform's (decision D3).
    var onRoomReady: ((String, String) -> Void)?
    /// The room this display was advertising is gone (the `forget-room` effect):
    /// the join ticket must come DOWN now, not when the next room warms, or a
    /// phone scans a dead code while the replacement dials.
    var onRoomGone: (() -> Void)?
    /// The roster moved: re-read it off `roomHandle` with
    /// `ttp_ui_roster_seats_room_json`. Deliberately carries no payload — the
    /// roster never becomes a Swift value, exactly as it never becomes a JS one.
    var onRosterChanged: (() -> Void)?
    /// The `race-abandoned` effect: mid-race, no racer left and someone waiting
    /// for the next one; on the results board, nobody connected at all.
    var onRaceAbandoned: (() -> Void)?
    /// The socket closed. `true` means the ROOM died (4001) rather than the link.
    var onClose: ((Bool) -> Void)?

    /// The `game-message` effect: a message the session policy does not name —
    /// START_GAME, CONTROL, the pause requests, SERIES_NEXT.
    var onControllerMessage: ((EngineIdentity, [String: Any]) -> Void)?
    /// The `welcome-item` effect. Emitted only when the live race holds this
    /// seat's car (the predicate is C++'s, off the session handle); the
    /// coordinator relights the per-owner ITEM.
    var onPlayerWelcomed: ((EngineIdentity) -> Void)?
    /// The `player-renamed` effect: a SEATED player changed their name. The lobby
    /// recovers on its own; this exists for the surfaces a RACE froze at its
    /// start.
    var onPlayerRenamed: ((EngineIdentity, String) -> Void)?
    /// A seat left the roster for good (the drained `playerleave` event): forfeit
    /// its car.
    var onPlayerLeave: ((EngineIdentity) -> Void)?
    /// The `rekey-player` effect: a dropped player came back on a DIFFERENT
    /// device. Move their still-racing car onto the new slot.
    var onPlayerRekey: ((EngineIdentity, EngineIdentity) -> Void)?
    /// The set of dropped seats offering a reconnect QR, in the order they
    /// dropped. Each entry is `ttp_net_reconnect_card_json`'s answer.
    var onReconnectSeats: (([[String: Any]]) -> Void)?
    /// The `track-change` effect: the stored pick resolved a (possibly new)
    /// preview circuit. The coordinator stages it and refreshes the race card.
    var onTrackChange: ((String) -> Void)?

    // MARK: - What the coordinator answers

    /// The live race's session handle, or 0 between races. Handed to the walks
    /// and `ttp_net_lobby_frame`, which read every seat's `inRace` off the Game
    /// themselves — no car id is ever serialized out and handed back.
    var sessionHandle: () -> Int32 = { 0 }
    /// Asked per publish: is the race manually paused? A rejoiner must re-raise
    /// the pause overlay it missed while away, or its wheel just feels dead.
    var isPaused: () -> Bool = { false }

    /// Asked per publish: is the display's own audio ON? It rides the snapshot as
    /// `soundOn`, which is what the host phone's Sound row renders — a shell that
    /// never answers leaves that switch showing "off" with the race audible.
    var isSoundOn: () -> Bool = { true }
    /// Whatever the relay refused, verbatim. A callback rather than a write into
    /// `GameState`, because this type holds no view state — see the error print
    /// in `perform` for what went undiagnosed without it.
    var onRelayError: ((String) -> Void)?

    // MARK: - State

    /// The RoomFlow handle. Read-through for everyone else: `ttp_room_state`,
    /// `ttp_room_list_json` and `ttp_ui_roster_seats_room_json` are all asked of
    /// it directly, so nothing anywhere keeps a second copy of the roster. The
    /// walks mutate the room through this same handle; the shell's mirrors below
    /// exist only to dial sockets and compose URLs, and are written only while
    /// performing `save-room` / `forget-room` / `pin-instance`.
    private(set) var roomHandle: Int32 = 0

    private(set) var roomCode: String?
    private(set) var instance: String?

    /// This shell's CouchPad `cpp` value (CONTRACT.md §6). The join URL is the
    /// only place a display declares which box it is, and the contract requires
    /// the QR and the registered controller-URL template to carry the SAME one —
    /// so both read this, and neither spells it inline.
    static let cpPlatform = "tvos"

    /// The room phase, straight off the machine that owns it.
    var roomState: String { TTP.strOrEmpty(ttp_room_state(roomHandle)) }
    /// The effective host as a JSON scalar, or "null".
    var hostIdJSON: String { TTP.strOrEmpty(ttp_room_host_json(roomHandle)) }

    private let proto: GameProtocol
    private let socket: RelaySocket
    /// The input fastlane's transport half (`Fastlane.swift`); its netcode is
    /// the C++ Link. Owned here because signalling rides this socket both ways.
    private var fastlane: Fastlane!

    /// The slot-0 BEARER SECRET, not a name.
    ///
    /// The relay keys the authoritative seat by it and a socket presenting it
    /// EVICTS the incumbent (close 4000). A constant would be no secret at all:
    /// the room code is on the TV screen and this source is public, so anyone
    /// could claim slot 0 and hijack the big screen out from under the host.
    /// Minted from `UUID` (a CSPRNG) and persisted beside the room so a crash
    /// recovery still reclaims slot 0.
    private var clientId = ""

    private var standings: [String: Any]?

    // The reconnect budget, mirroring PartyConnection's. This is the KIT half:
    // `ttp_framing_close_outcome` spends and caps it, `ttp_framing_backoff_ms`
    // schedules it, and the walks never see it (the web's PartyConnection keeps
    // it platform-side by design).
    private var reconnectAttempt: Double = 0
    private let maxReconnectAttempts: Double = 5
    private var shouldReconnect = true

    /// Dropped seats currently offering a reconnect QR. An ARRAY rather than a
    /// dictionary because `ttp_ui_reconnect_diff_json` is fed this order and a
    /// dictionary's is not stable. The SET is driven by the `show-reconnect` /
    /// `clear-reconnect` effects; the claim URL is composed here because it
    /// needs this shell's base origin (decision D3).
    private var reconnectSeats: [(id: EngineIdentity, card: [String: Any])] = []

    private var livenessTimer: Timer?
    private var createTimer: Timer?
    private var reconnectTimer: Timer?

    /// The app is going away; nothing may reconnect.
    private var shuttingDown = false
    /// Re-entrancy guard on the event drain (see `drainRoomEvents`).
    private var draining = false

    /// The walks' shared no-op answer, compared as BYTES so the common case
    /// skips the parse — the same trick as `Net.js`'s EMPTY_EFFECTS.
    private static let emptyEffects = "{\"effects\":[]}"

    // MARK: - Boot

    init(proto: GameProtocol, socket: RelaySocket) {
        self.proto = proto
        self.socket = socket

        // §4.5's boot order: the room machine exists before the socket does, so
        // `roomHandle` is valid for every reader from the first frame drawn. The
        // two windows are the manifest's, fed straight into RoomFlow's own
        // liveness config — this shell picks neither.
        roomHandle = ttp_room_create(TTP.json([
            "liveness": [
                "timeoutMs": proto.liveness.timeoutMs,
                "graceMs": proto.liveness.abandonedRaceGraceMs
            ]
        ]))
        // The stored pick's constructor rule. No default track (the coordinator
        // seeds its own idle pick through the walk); hasBag is TRUE and the
        // seed is page entropy — the ONE random thing this shell still supplies
        // for the pick machinery. The bag itself (deck, cursor, the
        // walk-the-whole-catalogue rule) lives behind the room handle and only
        // walks draw from it.
        ttp_net_init_pick(roomHandle, nil, 1, Double(UInt32.random(in: .min ... .max)))

        socket.onOpen = { [weak self] in self?.handleOpen() }
        socket.onText = { [weak self] text in self?.handleText(text) }
        socket.onClose = { [weak self] hasCode, code in self?.handleClose(hasCode: hasCode, code: code) }

        // The fastlane: signalling out over this socket, input in through the
        // SAME funnel a relay game-message takes (the CONTROL short-circuit
        // and the button verdict stay single-sourced in the coordinator).
        fastlane = Fastlane(iceServers: [proto.stunURL, proto.stunFallbackURL],
                            sendSignal: { [weak self] idx, data in
                                self?.sendTo(EngineIdentity.number(idx), TTP.json(data))
                            })
        fastlane.onInput = { [weak self] idx, ev in
            self?.onControllerMessage?(EngineIdentity.number(idx), ev)
        }
    }

    /// Warm the room. Called at boot, BEHIND the welcome board: the title screen
    /// is not a gate on the room, only on revealing the lobby.
    ///
    /// The web resolves its base URL here (`/api/baseurl`, localhost only). A TV
    /// app has no origin of its own, so the base URL was injected at
    /// construction and there is nothing to fetch.
    func start() {
        restoreRoom()
        connect()
    }

    // MARK: - The connection

    private func connect() {
        guard !shuttingDown else { return }
        socket.close()              // the fresh-room fallback replaces the connection
        shouldReconnect = true
        // Reopening a saved room dials the SHARD, and the string comes from the
        // same encoder the room was pinned with. Hand-building it is how
        // `Net.js` used to spell this eleven lines above the call that asks C++
        // for it.
        let base = proto.relayURL.absoluteString
        let text = roomCode.map { TTP.strOrEmpty(ttp_framing_pin_url(base, $0, instance ?? "")) } ?? base
        guard let url = URL(string: text) else { return }
        socket.open(url)
    }

    /// Socket OPEN. Join-vs-create is the walk's (it holds the restored room
    /// identity); what comes back is `join-room` or `create-room` plus the
    /// watchdog arm.
    private func handleOpen() {
        walk(TTP.strOrEmpty(ttp_net_on_open_json(roomHandle)))
    }

    private func handleText(_ text: String) {
        // The RAW text crosses, unparsed: whether it is even a JSON object is the
        // ported code's call, not a Swift paraphrase of it.
        let r = TTP.obj(ttp_framing_classify(text))
        switch r["route"] as? String {
        case "message":
            handleMessage(from: r["from"], data: r["data"])
        case "state":
            // The display AUTHORS the retained snapshot; it does not consume its
            // own replay.
            break
        case "protocol":
            handleProtocol(type: r["type"] as? String, msg: r["msg"] as? [String: Any] ?? [:])
        default:
            break   // "none" — not a JSON object. Dropped, exactly as the kit does.
        }
    }

    /// A relay protocol frame: created / joined (post-reload reconciliation
    /// included) / peer_joined / peer_left / error. One walk; the seating, the
    /// resync and the dead-room fallback all happen inside it.
    private func handleProtocol(type: String?, msg: [String: Any]) {
        // SURFACED, always — the web at least `console.warn`s this and a TV has
        // no console, so an unhandled relay error left literally no trace
        // anywhere. That cost an hour: a room went missing out from under a
        // display that was still connected and still advertising its code, and
        // the only evidence anyone could gather was a phone saying "Room not
        // found" at a QR that looked perfectly fine.
        if type == "error", let why = msg["message"] as? String {
            onRelayError?(why)
        }
        walk(TTP.strOrEmpty(ttp_net_on_protocol_json(roomHandle, type ?? "", TTP.json(msg), nowMs())))
    }

    /// A relay message. The walk routes slot-0 echoes (the heartbeat closes its
    /// loop there), stamps liveness, and runs the whole peer switch — hello,
    /// leave, set_car, set_ready, select_mode, ping — inside the engine.
    private func handleMessage(from: Any?, data: Any?) {
        guard let data, !(data is NSNull) else { return }
        let payload = data as? [String: Any]
        // The `__rtc` envelopes play their web double role: the fastlane
        // consumes them (offer/ICE → answer), AND they stay this shell's
        // "signal" for the walk, which stamps liveness (any traffic is proof
        // of life) and stops.
        let isSignal = payload?["__rtc"] != nil
        if isSignal, let payload, let idx = (from as? NSNumber)?.intValue {
            fastlane.handleSignal(from: idx, data: payload)
        }
        // A payload that is not an object still crosses: JS reads `data.type`
        // off anything without throwing, so a peer sending a bare number stamps
        // its seat. Getting that wrong drops a live phone's seat three seconds
        // later, which is the expensive direction.
        let msgJSON = payload.map { TTP.json($0) } ?? jsonScalar(data)
        // ONE walk, draws included: the shuffle bag lives behind the room
        // handle (seeded at init_pick), so a random pick draws inside the walk
        // — the needDraw round trip this shell used to answer is gone.
        walk(TTP.strOrEmpty(ttp_net_on_peer_message_json(
            roomHandle, sessionHandle(), jsonScalar(from), msgJSON,
            isSignal ? 1 : 0, nowMs())), from: EngineIdentity.from(from), data: payload ?? [:])
    }

    private func handleClose(hasCode: Bool, code: Double) {
        createTimer?.invalidate()

        // The KIT half: what this close code means for the reconnect budget.
        let o = TTP.obj(ttp_framing_close_outcome(hasCode ? 1 : 0, code,
                                                  reconnectAttempt, maxReconnectAttempts,
                                                  shouldReconnect ? 1 : 0))
        if o["stopReconnect"] as? Bool == true { shouldReconnect = false }
        // 0 for the terminal codes, matching the kit.
        reconnectAttempt = o["closeAttempt"] as? Double ?? 0

        let meta = o["meta"] as? [String: Any]
        let roomClosed = meta?["roomClosed"] as? Bool == true

        if !shuttingDown {
            // The ROOM half is the walk's: on roomClosed it forgets the room,
            // expires every seat (close_room sends no peer_lefts, so the old
            // roster would haunt the fresh lobby) and answers connect-fresh —
            // that order is load-bearing and lives in C++ now.
            walk(TTP.strOrEmpty(ttp_net_on_close_json(roomHandle, roomClosed ? 1 : 0)))
        }
        // AFTER the walk, deliberately: the coordinator's room-closed landing
        // seeds a fresh default pick, and the seed's null sender is only the
        // host once the walk has emptied the roster.
        onClose?(roomClosed)
        guard !shuttingDown else { return }
        if o["willReconnect"] as? Bool == true { scheduleReconnect() }
    }

    /// The reconnect backoff. The delay is `ttp_framing_backoff_ms`'s (1 s, 1.5, 2.25,
    /// 3.375, capped at 5 s), never a schedule invented here.
    private func scheduleReconnect() {
        reconnectTimer?.invalidate()
        let t = Timer(timeInterval: ttp_framing_backoff_ms(reconnectAttempt) / 1000, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.connect() }
        }
        RunLoop.main.add(t, forMode: .common)
        reconnectTimer = t
    }

    private func reconnectNow() {
        reconnectTimer?.invalidate()
        connect()
    }

    /// A socket that opened and never got an answer never fires a close, so it
    /// drives the same budgeted-retry decision as a codeless one.
    private func failAttempt() {
        guard shouldReconnect else { return }
        socket.close()
        handleClose(hasCode: false, code: 0)
    }

    // MARK: - Ending the party

    /// End the party while the app stays up: tell the relay to close the room
    /// (every phone bails terminally to its party-over screen) and let our own
    /// 4001 self-heal into a fresh room. The web's `closeRoom()`, performed by
    /// the race flow's `close-room` effect; unlike `shutdown()` nothing here
    /// stops timers or suppresses the reconnect — the self-heal IS the point.
    func closeRoom() {
        guard socket.isOpen else { return }
        socket.send(TTP.strOrEmpty(ttp_framing_encode_close_room())) { [weak self] flushed in
            if flushed { self?.forgetRoomFile() }
        }
    }

    /// Come back from the suspension `shutdown()` ended the party in.
    ///
    /// A FRESH room, deliberately, rather than a rejoin: we told the relay to
    /// close the old one, so dialling it again would spend a round trip to be
    /// told "Room not found" and would put a dead code on a 1080p screen in the
    /// meantime. It is the same rule the web runs on a reload — the display
    /// going away IS the party ending, so coming back is a new party.
    ///
    /// The teardown is the room-closed walk (forget the room, expire the old
    /// roster, dial fresh) — the same road the relay's own 4001 takes, minus the
    /// kit's close bookkeeping, because no socket closed here: it was closed and
    /// DETACHED on the way out.
    ///
    /// The crash-recovery blob is a different road and is untouched here: a
    /// crash runs no `shutdown()` at all, so the next LAUNCH goes through
    /// `start()`/`restoreRoom()` and regathers the party that outlived us.
    func resumeWithFreshRoom() {
        shuttingDown = false
        shouldReconnect = true
        reconnectAttempt = 0
        // The suspension closed every RTC link (shutdown); the phones' kits
        // re-offer on their next `joined`. Nothing to restore here.
        walk(TTP.strOrEmpty(ttp_net_on_close_json(roomHandle, 1)))
    }

    /// The app going away IS the party ending.
    ///
    /// Same teardown, plus: stop every timer and suppress reconnection, so a
    /// close arriving on the way out cannot warm a room nobody will ever see.
    ///
    /// The saved blob is dropped ONLY once the `close_room` has flushed. That
    /// asymmetry is the whole crash-recovery story: a room the relay was told
    /// about is dead, and a blob pointing at it would make the next launch dial a
    /// corpse (self-healing, but at the cost of a round trip and a briefly wrong
    /// room code on a 1080p screen). A `close_room` that never made it out leaves
    /// the room ALIVE, and then the blob is exactly what turns the next launch
    /// into a party-regathering recovery. The web cannot make this distinction —
    /// `pagehide` gives it no completion — and keeps the blob either way.
    func shutdown() {
        shuttingDown = true
        shouldReconnect = false
        livenessTimer?.invalidate(); livenessTimer = nil
        createTimer?.invalidate(); createTimer = nil
        reconnectTimer?.invalidate(); reconnectTimer = nil
        // Backgrounded: close every RTC link promptly (HexStacker's rule too),
        // so the phones' watchdogs notice and re-offer on the way back in.
        fastlane.closeAll()
        guard socket.isOpen else { socket.close(); return }
        socket.send(TTP.strOrEmpty(ttp_framing_encode_close_room())) { [weak self] flushed in
            guard let self else { return }
            if flushed { self.forgetRoomFile() }
            // STILL SHUTTING DOWN, or this close belongs to somebody else. The
            // flush completion is deferred — a backgrounded app's URLSession
            // tasks are suspended, so it can land AFTER the wake — and by then
            // `resumeWithFreshRoom` has dialled a NEW socket through the same
            // `RelaySocket`. Closing here would then detach the live connection
            // silently: `close()` reports nothing, so no reconnect is scheduled
            // and the room never warms again.
            guard self.shuttingDown else { return }
            self.socket.close()
        }
    }

    // MARK: - The walk

    /// Perform a walk's answer: drain the room events the mutations queued (the
    /// announce a mutation used to fire mid-walk lands before the walk's own
    /// trailing sends — the ABI's stated order), then the effects IN INDEX
    /// ORDER. Nothing here may reorder, batch or skip — several correctness
    /// constraints (the close teardown order, publish-after-store, rekey-player
    /// before welcome-item) live in that order alone.
    ///
    /// `from`/`data` carry the one thing an effect names but the walk does not
    /// re-cross: the triggering message (`game-message` hands it to the game
    /// layer). Only the peer-message walks pass them.
    @discardableResult
    private func walk(_ answer: String,
                      from: EngineIdentity? = nil,
                      data: [String: Any] = [:]) -> [String: Any] {
        drainRoomEvents()
        guard answer != PartyNet.emptyEffects else { return [:] }
        let ans = TTP.obj(answer)
        for case let e as [String: Any] in (ans["effects"] as? [Any] ?? []) {
            perform(e, from: from, data: data)
        }
        return ans
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private func perform(_ e: [String: Any], from: EngineIdentity?, data: [String: Any]) {
        switch e["op"] as? String {
        case "clear-create-timer":
            createTimer?.invalidate()

        // A socket that opens but never gets a created/joined answer would hang
        // forever — no close event ever fires — so the walk arms a watchdog and
        // the expiry asks C++ whether the attempt is still unanswered.
        case "arm-create-watchdog":
            createTimer?.invalidate()
            let t = Timer(timeInterval: (e["delayMs"] as? Double ?? 8000) / 1000, repeats: false) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.walk(TTP.strOrEmpty(ttp_net_create_timeout_json(self.roomHandle)))
                }
            }
            RunLoop.main.add(t, forMode: .common)
            createTimer = t

        case "join-room":
            if let room = e["room"] as? String {
                socket.send(TTP.strOrEmpty(ttp_framing_encode_join(clientId, room)))
            }

        case "create-room":
            // "" from the model means REGISTER NONE, which is a different thing
            // from registering an empty template: the relay accepts only
            // absolute https templates and rejects the WHOLE create on an
            // invalid one, so a plain-http origin must send no key at all.
            let maxClients = e["maxClients"] as? Double ?? Double(proto.maxPlayers + 1)
            let template = TTP.str(ttp_net_controller_url_template(proto.baseURL.absoluteString,
                                                                  Self.cpPlatform))
            let frame = template.map { TTP.strOrEmpty(ttp_framing_encode_create(clientId, maxClients, $0)) }
                ?? TTP.strOrEmpty(ttp_framing_encode_create(clientId, maxClients, nil))
            socket.send(frame)

        // The shell dials from its mirror (connect), so pinning the shard IS
        // updating the mirror — the web's kit re-points its dial URL the same
        // way.
        case "pin-instance":
            roomCode = e["room"] as? String
            instance = e["instance"] as? String

        case "save-room":
            roomCode = e["room"] as? String
            instance = e["instance"] as? String
            saveRoomFile()

        case "forget-room":
            forgetRoomFile()
            roomCode = nil
            instance = nil
            // The advertised room is gone: the join ticket comes down NOW, not
            // when the replacement warms, or its QR stays scannable for as long
            // as the fresh create takes.
            onRoomGone?()

        case "room-ready":
            announceRoomReady()

        case "start-liveness":
            // The timer guard is all that is left here: the in-flight heartbeat
            // reset that had to precede it happens inside the engine, on the
            // created/joined walk itself.
            startLiveness()

        case "reset-reconnect-count":
            reconnectAttempt = 0

        case "connect-fresh":
            connect()

        case "fail-attempt":
            failAttempt()

        case "reconnect":
            reconnectNow()

        // The frame data arrives composed (PONG, the self-heartbeat) — this
        // side puts it on the socket and adds nothing.
        case "send-to":
            if let to = EngineIdentity.from(e["to"]), let payload = e["data"] {
                sendTo(to, payload as? String ?? TTP.json(payload))
            }

        case "publish":
            publishSnapshot()

        case "announce":
            announce()

        // A seat left, was rekeyed or expired: its RTC link and its C++ Link
        // go together (the Link's applied-seq memory is per-connection).
        case "close-fastlane":
            if let idx = (e["peerIndex"] as? NSNumber)?.intValue { fastlane.close(idx) }

        case "show-reconnect":
            // The claim URL needs this shell's base origin (D3), so it is
            // spliced here; the card payload and the DIFF over the set stay
            // C++'s.
            if let seat = e["seat"] as? [String: Any],
               let peerIndex = (seat["peerIndex"] as? NSNumber)?.doubleValue,
               let id = EngineIdentity.from(seat["peerIndex"]) {
                let claim = TTP.strOrEmpty(ttp_net_claim_url(joinURL(), peerIndex))
                let card = TTP.obj(ttp_net_reconnect_card_json(TTP.json(seat), claim))
                reconnectSeats.removeAll { $0.id == id }
                reconnectSeats.append((id: id, card: card))
                onReconnectSeats?(reconnectSeats.map { $0.card })
            }

        case "clear-reconnect":
            if let id = EngineIdentity.from(e["peerIndex"]) {
                let before = reconnectSeats.count
                reconnectSeats.removeAll { $0.id == id }
                if reconnectSeats.count != before { onReconnectSeats?(reconnectSeats.map { $0.card }) }
            }

        case "rekey-player":
            if let old = EngineIdentity.from(e["oldId"]), let new = EngineIdentity.from(e["newId"]) {
                onPlayerRekey?(old, new)
            }

        case "player-renamed":
            if let id = EngineIdentity.from(e["peerIndex"]), let name = e["name"] as? String {
                onPlayerRenamed?(id, name)
            }

        case "welcome-item":
            if let id = EngineIdentity.from(e["peerIndex"]) { onPlayerWelcomed?(id) }

        case "game-message":
            if let from { onControllerMessage?(from, data) }

        case "race-abandoned":
            onRaceAbandoned?()

        case "track-change":
            if let id = e["trackId"] as? String { onTrackChange?(id) }

        case "clear-standings":
            standings = nil

        default:
            // An op this build cannot perform is a MISSING CAPABILITY, not an
            // optional step — say so loudly rather than dropping it and leaving
            // a half-set-up room. Same contract as RaceFlowPerformer's. The
            // boot proof over `performable` below is what turns this from a
            // failure at the WORST moment (mid-party) into one at load.
            let op = e["op"] as? String ?? "<malformed>"
            assertionFailure("net: unperformable effect \(op)")
            onRelayError?("net: unperformable effect \(op)")
        }
    }

    /// The arms of the switch above, as data, for the boot proof over
    /// `ttp_net_effect_ops_json` (see `GameCoordinator.configure`). The walk's
    /// whole vocabulary must be a subset: an op no arm performs is a step
    /// silently dropped in the middle of forming a party, and the `default`
    /// above only says so once it has already happened.
    ///
    /// `tests/shell-parity.test.js` pins this to the switch, so the set
    /// cannot claim an arm the switch stopped having.
    static let performable: Set<String> = [
        "clear-create-timer", "arm-create-watchdog", "join-room", "create-room",
        "pin-instance", "save-room", "forget-room", "room-ready", "start-liveness",
        "reset-reconnect-count", "connect-fresh", "fail-attempt", "reconnect",
        "send-to", "publish", "announce", "close-fastlane", "show-reconnect",
        "clear-reconnect", "rekey-player", "player-renamed", "welcome-item",
        "game-message", "race-abandoned", "track-change", "clear-standings",
    ]

    private func announceRoomReady() {
        guard let room = roomCode else { return }
        // Logged as well as shown, for the same reason `lastError` is: a TV has
        // no address bar and no console, so without this the only way to learn
        // which room the app is in is to read it off the screen with your eyes —
        // which makes joining from a script (or diagnosing a party that will not
        // form) need a person in front of the television.
        print("[ttp] room \(room) — \(joinURL())")
        onRoomReady?(room, joinURL())
    }

    // MARK: - The pick

    /// A pick made by the DISPLAY ITSELF — the boot seed, and the screenshot
    /// scenarios. The SAME peer-message walk a host's SELECT_MODE takes (draws
    /// included — the bag is the room's now), with the `type` stamped here so
    /// callers pass only the pick fields.
    ///
    /// The sender is `null`, which equals the EMPTY room's null host: until a
    /// phone joins there is no host, and the display is the null sender the
    /// host gate then admits. Both callers run against an empty room (boot,
    /// and the relay-less scenarios); once a party has a host this road is
    /// refused, which is exactly right — the pick is theirs then.
    func applyPick(_ msg: [String: Any]) {
        var m = msg
        m["type"] = proto.msgSelectMode
        walk(TTP.strOrEmpty(ttp_net_on_peer_message_json(
            roomHandle, sessionHandle(), "null", TTP.json(m), 0, nowMs())))
    }

    /// Perform ONE net-vocabulary effect on behalf of the RACE walker: a race
    /// answer may carry net ops in place (the executor merges the set-track
    /// walk's tail — track-change, publish — into it), and those belong to
    /// this switch. The web's applyEffect falls through to its net performer
    /// for exactly the same reason.
    func performNetEffect(_ e: [String: Any]) {
        perform(e, from: nil, data: [:])
    }

    /// The game-layer track swap that keeps mode/cup as they are (a cup
    /// advancing, a lobby re-draw). Same catalogue-membership and same-pick
    /// gates as the mode pick, same store/publish/track-change tail.
    func setTrack(_ id: String) {
        walk(TTP.strOrEmpty(ttp_net_set_track_json(roomHandle, id)))
    }

    // MARK: - Room events

    /// Drain and re-fire, after every walk (the walks mutate; the ABI queues).
    ///
    /// The hostchange/statechange bodies are walks themselves: what a host
    /// promotion or a phase flip implies (the ready-clear, the countdown
    /// restamp, the lobby sweep of dropped seats, when to republish) is decided
    /// and MUTATED inside the engine; the effects that come back are performed
    /// like any other walk's.
    ///
    /// The re-entrancy guard is the one real difference from the kit: a nested
    /// walk here may itself mutate (freeing disconnected seats on the lobby
    /// transition emits more roster changes), and where JS would nest
    /// synchronously this appends to the queue the outer loop is already
    /// walking. Order is preserved either way.
    private func drainRoomEvents() {
        guard !draining else { return }
        draining = true
        defer { draining = false }
        while true {
            let events = TTP.arr(ttp_room_events_json(roomHandle))
            if events.isEmpty { break }
            for entry in events {
                guard let e = entry as? [String: Any] else { continue }
                let detail = e["detail"] as? [String: Any] ?? [:]
                switch e["type"] as? String {
                case "rosterchange":
                    announce()
                case "hostchange":
                    walk(TTP.strOrEmpty(ttp_net_host_change_apply_json(
                        roomHandle, jsonScalar(detail["hostPeerIndex"]))))
                case "statechange":
                    walk(TTP.strOrEmpty(ttp_net_state_change_apply_json(
                        roomHandle, detail["to"] as? String ?? "", nowMs())))
                case "playerleave":
                    if let id = EngineIdentity.from(detail["peerIndex"]) { onPlayerLeave?(id) }
                default:
                    break
                }
            }
        }
    }

    /// `ttp_room_transition_to` + drain. The race-flow performer's `transition`
    /// op; the statechange walk above is what the drain then runs.
    func transition(to state: String) {
        // The web round-trips through its ROOM_STATE table, which is a case fold
        // and nothing else; the ABI takes the state NAME.
        _ = ttp_room_transition_to(roomHandle, state.lowercased())
        drainRoomEvents()
    }

    // MARK: - Liveness

    private func startLiveness() {
        guard livenessTimer == nil else { return }
        let t = Timer(timeInterval: proto.liveness.tickMs / 1000, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.livenessTick() }
        }
        RunLoop.main.add(t, forMode: .common)
        livenessTimer = t
    }

    /// The 1 Hz tick, one walk: the self-heartbeat state machine (in-flight
    /// pair lives in the engine — overdue is a FLAG, never an echo age, so a
    /// suspended app's starved ticks cannot read as a dead link), then on a
    /// sweep the expiry drops, the active-order re-sync and the abandoned-race
    /// deadline, in that order on the one clock reading.
    private func livenessTick() {
        walk(TTP.strOrEmpty(ttp_net_liveness_json(roomHandle, sessionHandle(), nowMs())))
    }

    // The active participant set has NO reader here anymore: the liveness walk
    // pushes the sync on its own ticks, and the two consumers that used to ask
    // through wrappers (the auto-pause arbitration, the standings' late
    // joiners) read it inside their live twins, through `ttp_room.h`'s synced
    // seam — the strongest form of the sync-before-read rule, because a caller
    // no longer exists that could drop the sync.

    // MARK: - Outbound

    /// The room's single outbound roster message: the retained host snapshot.
    ///
    /// There is no per-phone WELCOME. The relay pushes this live to every
    /// controller and replays it to each (re)joiner right after `joined`, so a
    /// phone recovers its whole state from the replay alone.
    ///
    /// TRAP: `ttp_net_lobby_frame` returns the FINISHED socket text — composed
    /// and framed without leaving C++, reading the roster, every seat's
    /// `inRace` AND the stored pick off the handles. Do not parse it, do not
    /// re-encode it, and do not route it through `ttp_framing_encode_set_state`:
    /// a JSON string is itself a legal `set_state` payload, so there is no way
    /// to sniff "already encoded", and guessing publishes a quoted blob the
    /// phones cannot read.
    func publishSnapshot() {
        guard socket.isOpen else { return }
        socket.send(TTP.strOrEmpty(ttp_net_lobby_frame(roomHandle, sessionHandle(), TTP.json([
            "paused": isPaused(),
            "soundOn": isSoundOn(),
            "standings": standings.map { $0 as Any } ?? NSNull()
        ]))))
    }

    /// Whether a standings board has already gone out this race.
    ///
    /// It gates the re-push after a rename: re-sending a board that is already up
    /// corrects it, but sending a FIRST one early would raise every phone's
    /// results overlay mid-race, because that overlay is triggered by a non-null
    /// standings.
    func hasStandings() -> Bool { standings != nil }

    /// Mirror the latest standings board into the snapshot, so a phone that
    /// reconnects on the results screen recovers it by replay. Takes the board's
    /// JSON TEXT, which is what `ttp_ui_standings_json` answers; the re-encode
    /// costs nothing at the wire (every outbound frame is canonicalized).
    func setStandings(_ json: String) {
        let board = TTP.obj(json)
        standings = board.isEmpty ? nil : board
        publishSnapshot()
    }

    /// Broadcast to every controller. The only broadcast in the game is
    /// `MSG.COUNTDOWN`.
    func broadcast(_ json: String) {
        guard socket.isOpen else { return }
        socket.send(TTP.strOrEmpty(ttp_framing_encode_broadcast(json)))
    }

    /// Unicast to one seat: `MSG.ITEM`, and the composed frames the `send-to`
    /// effect carries (PONG, the self-heartbeat).
    func sendTo(_ id: EngineIdentity, _ json: String) {
        guard socket.isOpen else { return }
        socket.send(TTP.strOrEmpty(ttp_framing_encode_send_to(id.json, json)))
    }

    /// Publish, then tell the shell. One call, because the roster is read off the
    /// room HANDLE in both places — publishing does not hand a roster back for
    /// rendering to re-serialize.
    private func announce() {
        publishSnapshot()
        onRosterChanged?()
    }

    // MARK: - URLs

    private func joinURL() -> String {
        TTP.strOrEmpty(ttp_net_join_url(proto.baseURL.absoluteString, roomCode ?? "",
                                        instance ?? "", Self.cpPlatform))
    }

    // MARK: - Room persistence

    /// One small blob: `{room, instance, clientId}`. No roster, no snapshot, no
    /// track pick.
    ///
    /// NOT `NSUserDefaults`, and the reason is a real behaviour difference. The
    /// web uses `sessionStorage` PLUS a `pagehide → close_room`: a clean exit ends
    /// the party, and only a crash leaves a room to be regathered. Defaults
    /// survive a clean quit, so the next launch would dial a DEAD room — it
    /// self-heals (the join bounces off "Room not found" into the error walk's
    /// fallback), but it costs a round trip and briefly shows a wrong room code
    /// on a 1080p screen. Memory plus a file deleted on every `close_room` path
    /// gives the web's semantics exactly.
    ///
    /// Caches is the directory because tvOS gives an app no persistent per-user
    /// storage bar `NSUserDefaults` — which is precisely what must not hold this.
    /// Purgeable is a feature here: the blob is only ever crash recovery.
    private var roomFile: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("tinytrack_display_room.json")
    }

    private func restoreRoom() {
        if let url = roomFile,
           let data = try? Data(contentsOf: url),
           let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let room = saved["room"] as? String {
            roomCode = room
            instance = saved["instance"] as? String
            clientId = saved["clientId"] as? String ?? ""   // reuse the secret to land on slot 0
        }
        // Mint on a cold boot, HERE — before connecting — so the create/join
        // always carries a clientId.
        if clientId.isEmpty { clientId = "display-" + UUID().uuidString }
        // Hand the restored identity to the engine, whose open walk is what
        // decides join-vs-create. The mirror above exists only to dial URLs.
        ttp_net_restore_room(roomHandle, roomCode ?? "", instance ?? "")
    }

    private func saveRoomFile() {
        guard let url = roomFile, let room = roomCode else { return }
        let blob: [String: Any] = ["room": room,
                                   "instance": instance.map { $0 as Any } ?? NSNull(),
                                   "clientId": clientId]
        try? JSONSerialization.data(withJSONObject: blob).write(to: url, options: .atomic)
    }

    private func forgetRoomFile() {
        guard let url = roomFile else { return }
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - Small conversions

    /// JS `Date.now()`, which is what every window in the LIVENESS block is
    /// measured against.
    private func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    /// A decoded JSON value back as its own JSON TEXT — the spelling every
    /// identity and every untrusted field crosses the ABI as. `NSNull` and `nil`
    /// become `"null"`, which is the half of the absent-vs-null distinction that
    /// must survive.
    private func jsonScalar(_ value: Any?) -> String {
        TTP.json([value ?? NSNull()]).jsonArrayElement
    }
}

private extension String {
    /// `"[3]"` → `"3"`. `TTP.json` needs a container at the top level, so a bare
    /// JSON scalar is encoded as a one-element array and unwrapped here — the
    /// same trick `EngineIdentity.string` uses, and for the same reason.
    var jsonArrayElement: String {
        guard hasPrefix("["), hasSuffix("]") else { return self }
        return String(dropFirst().dropLast())
    }
}
