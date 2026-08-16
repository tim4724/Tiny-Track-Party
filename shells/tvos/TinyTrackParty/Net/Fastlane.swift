import Foundation
import LiveKitWebRTC

/// The input fastlane's tvOS transport: one `RTCPeerConnection` per controller,
/// with the NETCODE untouched in C++ — `ttp::fastlane::Link` behind the four
/// receive-side `ttp_link_*` calls, exactly as the web display drives it
/// (`NativePartyFastlane.js`). Nothing here classifies a packet, dedups a
/// sequence or composes an ack; this file owns sockets-and-timers only:
///
///   TRANSPORT   RTCPeerConnection + the unreliable/unordered DataChannel the
///               PHONE opens. tvOS ships no system WebRTC, so this links
///               LiveKit's tvOS-capable distribution (module `LiveKitWebRTC`,
///               symbols prefixed `LK` — the same build HexStacker's TV shell
///               device-proved; stasel/WebRTC ships no tvOS slices).
///   SIGNALLING  the `__rtc` envelopes riding the relay (`PartyNet` intercepts
///               them and calls `handleSignal`). The display is relay slot 0
///               and ANSWER-ONLY: the phone opens the connection, so glare
///               cannot arise on this side.
///   TIMERS      the WATCHDOG only. The kit's send/idle timers are the
///               SENDER's; a receiver emits nothing but the acks the Link
///               hands back.
///
/// LIVENESS IS NOT STAMPED HERE, deliberately: the phone pings at its manifest
/// cadence over the relay socket whenever that socket is alive, and a relay
/// socket that died is a `peer_left` — which outranks liveness on every
/// platform. (The web's `_seen` on fastlane input is an extra stamp over the
/// same two facts.)
@MainActor
final class Fastlane {

    /// A fastlane event to surface — the same funnel a relay `game-message`
    /// takes, so dedup, the CONTROL short-circuit and the button-press verdict
    /// stay single-sourced downstream.
    var onInput: ((Int, [String: Any]) -> Void)?

    /// Ship an `__rtc` envelope to a controller over the relay.
    private let sendSignal: (Int, [String: Any]) -> Void

    /// `fastlane.h`'s WATCHDOG_MS (an inline constexpr, so there is no export
    /// to read; `tests/tvos-fastlane.test.js` holds the two spellings
    /// together). Inbound silence past this on an OPEN channel tears the peer
    /// down; the phone's own watchdog then re-offers.
    private static let watchdogMs: Double = 3000

    /// Per-controller state: the connection, the adopted channel, the C++ Link
    /// handle, and the pending-ICE queue (candidates can arrive before the
    /// remote description; capped so a peer spamming ICE without ever
    /// completing an offer cannot grow it unbounded).
    private final class Peer {
        let pc: LKRTCPeerConnection
        let observer: PeerObserver
        var channel: LKRTCDataChannel?
        var link: Int32 = 0
        var watchdog: Timer?
        var pendingCandidates: [LKRTCIceCandidate] = []
        init(pc: LKRTCPeerConnection, observer: PeerObserver) {
            self.pc = pc
            self.observer = observer
        }
    }

    private var peers: [Int: Peer] = [:]
    private let factory: LKRTCPeerConnectionFactory
    private let config: LKRTCConfiguration

    /// libwebrtc must initialize SSL exactly once per process.
    private static let sslOnce: Void = { LKRTCInitializeSSL() }()

    init(iceServers: [String], sendSignal: @escaping (Int, [String: Any]) -> Void) {
        _ = Fastlane.sslOnce
        self.sendSignal = sendSignal
        self.factory = LKRTCPeerConnectionFactory()
        let cfg = LKRTCConfiguration()
        // STUN then the public fallback, exactly the pair the web injects
        // (`GameNet._initFastlane`). No TURN anywhere — a symmetric NAT falls
        // back to the relay, which is the design.
        cfg.iceServers = [LKRTCIceServer(urlStrings: iceServers)]
        cfg.sdpSemantics = .unifiedPlan
        self.config = cfg
    }

    // MARK: - Signalling (all on main; PartyNet's callbacks are)

    /// Consume an `__rtc` envelope. Returns whether it WAS one — presence of
    /// the key alone, as the kit tests it, so a malformed envelope cannot leak
    /// into app dispatch.
    @discardableResult
    func handleSignal(from: Int, data: [String: Any]) -> Bool {
        guard data["__rtc"] != nil else { return false }
        guard let kind = data["__rtc"] as? String else { return true }
        switch kind {
        case "offer":
            if let sdp = data["sdp"] as? [String: Any] { handleOffer(from: from, sdp: sdp) }
        case "ice":
            if let cand = data["candidate"] as? [String: Any] { handleIce(from: from, candidate: cand) }
        default:
            // The display never offers, so it can never receive an answer that
            // means anything; unknown kinds are consumed for the same reason
            // malformed ones are.
            break
        }
        return true
    }

    /// EVERY OFFER STARTS FRESH. A phone re-opens its fastlane by building a
    /// new RTCPeerConnection (its kit's `closeAll()` + `open(0)` on every
    /// `joined`), so an offer landing on a peer we already hold means the old
    /// connection is stale on the far side — and the old LINK is stale with
    /// it: the fresh sender's sequences restart, and a surviving
    /// `lastAppliedEs` would dedup every subsequent input away. Teardown of
    /// both is the one move that keeps transport and netcode lifetimes glued.
    private func handleOffer(from: Int, sdp: [String: Any]) {
        guard let sdpText = sdp["sdp"] as? String else { return }
        close(from)
        let observer = PeerObserver(owner: self, peerIdx: from)
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints,
                                              delegate: observer) else { return }
        let peer = Peer(pc: pc, observer: observer)
        peer.link = ttp_link_create()
        peers[from] = peer

        pc.setRemoteDescription(LKRTCSessionDescription(type: .offer, sdp: sdpText)) { err in
            Task { @MainActor [weak self] in
                guard let self, err == nil, let peer = self.peers[from], peer.pc === pc else { return }
                self.drainPendingCandidates(peer)
                peer.pc.answer(for: constraints) { answer, _ in
                    Task { @MainActor in
                        guard let answer, let peer = self.peers[from], peer.pc === pc else { return }
                        peer.pc.setLocalDescription(answer) { _ in
                            Task { @MainActor in
                                self.sendSignal(from, ["__rtc": "answer",
                                                       "sdp": ["type": "answer", "sdp": answer.sdp]])
                            }
                        }
                    }
                }
            }
        }
    }

    private func handleIce(from: Int, candidate: [String: Any]) {
        guard let peer = peers[from], let sdp = candidate["candidate"] as? String else { return }
        let ice = LKRTCIceCandidate(sdp: sdp,
                                    sdpMLineIndex: (candidate["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0,
                                    sdpMid: candidate["sdpMid"] as? String)
        if peer.pc.remoteDescription == nil {
            if peer.pendingCandidates.count < 32 { peer.pendingCandidates.append(ice) }
        } else {
            peer.pc.add(ice) { _ in }
        }
    }

    private func drainPendingCandidates(_ peer: Peer) {
        for ice in peer.pendingCandidates { peer.pc.add(ice) { _ in } }
        peer.pendingCandidates.removeAll()
    }

    // MARK: - Teardown

    /// The `close-fastlane` performer, and this side of the watchdog. Closes
    /// transport AND link: the netcode-only close the recipe warns about would
    /// strand a connection still in offer/ICE (leaking the RTCPeerConnection
    /// until ICE gives up ~30 s later, and handing the next offer a stale pc).
    func close(_ peerIdx: Int) {
        guard let peer = peers.removeValue(forKey: peerIdx) else { return }
        peer.watchdog?.invalidate()
        peer.channel?.delegate = nil
        peer.channel?.close()
        peer.pc.close()
        if peer.link != 0 { ttp_link_dispose(peer.link) }
    }

    func closeAll() {
        for idx in Array(peers.keys) { close(idx) }
    }

    // MARK: - The channel (forwarded from PeerObserver, already hopped to main)

    fileprivate func onIceCandidate(_ peerIdx: Int, _ candidate: LKRTCIceCandidate) {
        sendSignal(peerIdx, ["__rtc": "ice", "candidate": [
            "candidate": candidate.sdp,
            "sdpMid": candidate.sdpMid as Any,
            "sdpMLineIndex": Int(candidate.sdpMLineIndex)
        ]])
    }

    fileprivate func onDataChannel(_ peerIdx: Int, _ channel: LKRTCDataChannel) {
        guard let peer = peers[peerIdx] else { return }
        // Detach a replaced channel rather than closing it: an orphan from a
        // rolled-back offer shares the SCTP stream id, and close() would tear
        // down the adopted channel remotely (the kit's _wireChannel only nulls
        // the handlers for the same reason).
        if let previous = peer.channel, previous !== channel { previous.delegate = nil }
        peer.channel = channel
        channel.delegate = peer.observer
        // The channel can already be open by the time we adopt it (the state
        // callback may have fired against the un-adopted channel and been
        // dropped by the identity guard below).
        if channel.readyState == .open { channelOpened(peerIdx, peer) }
    }

    /// `channel` identifies WHICH channel transitioned: a detached orphan can
    /// still deliver a queued callback, and acting on it would tear down the
    /// adopted channel or reset the Link mid-session.
    fileprivate func onChannelState(_ peerIdx: Int, _ channel: LKRTCDataChannel,
                                    _ state: LKRTCDataChannelState) {
        guard let peer = peers[peerIdx], peer.channel === channel else { return }
        switch state {
        case .open: channelOpened(peerIdx, peer)
        case .closed: close(peerIdx)
        default: break
        }
    }

    fileprivate func onChannelMessage(_ peerIdx: Int, _ buffer: LKRTCDataBuffer) {
        guard let peer = peers[peerIdx], peer.link != 0,
              let text = String(data: buffer.data, encoding: .utf8) else { return }
        resetWatchdog(peerIdx, peer)
        // The REAL readyState is pushed before every op: the Link's belief
        // about the channel is what decides whether its ack write counts.
        syncOpen(peer)
        let outcome = TTP.obj(ttp_link_inbound(peer.link, text, nowMs()))
        apply(outcome, to: peerIdx, peer: peer)
    }

    fileprivate func onConnectionState(_ peerIdx: Int, _ state: LKRTCPeerConnectionState) {
        if state == .failed || state == .closed { close(peerIdx) }
    }

    // MARK: - Driving the Link

    private func syncOpen(_ peer: Peer) {
        let open = peer.channel?.readyState == .open
        ttp_link_set_channel_open(peer.link, open ? 1 : 0)
    }

    /// Apply an outcome: write the packet the Link produced (the ack — this
    /// side enqueues nothing), then surface the applied events in order.
    private func apply(_ outcome: [String: Any], to peerIdx: Int, peer: Peer) {
        if outcome["sent"] as? Bool == true, let packet = outcome["packet"],
           !(packet is NSNull), let channel = peer.channel {
            channel.sendData(LKRTCDataBuffer(data: Data(TTP.json(packet).utf8), isBinary: false))
        }
        for case let ev as [String: Any] in (outcome["applied"] as? [Any] ?? []) {
            onInput?(peerIdx, ev)
        }
    }

    private func channelOpened(_ peerIdx: Int, _ peer: Peer) {
        syncOpen(peer)
        resetWatchdog(peerIdx, peer)
    }

    private func resetWatchdog(_ peerIdx: Int, _ peer: Peer) {
        peer.watchdog?.invalidate()
        let t = Timer(timeInterval: Self.watchdogMs / 1000, repeats: false) { _ in
            Task { @MainActor [weak self] in self?.close(peerIdx) }
        }
        RunLoop.main.add(t, forMode: .common)
        peer.watchdog = t
    }

    private func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
}

// MARK: - Per-peer delegate

/// One observer per RTCPeerConnection so the peer index travels with the
/// callbacks (the delegate API only hands back the connection). Every callback
/// arrives on libwebrtc's signalling thread and hops to the main actor before
/// touching the owner; state is read BEFORE the hop, because by the time the
/// hop runs the channel may have moved on or been replaced.
private final class PeerObserver: NSObject, LKRTCPeerConnectionDelegate, LKRTCDataChannelDelegate {
    weak var owner: Fastlane?
    let peerIdx: Int
    init(owner: Fastlane, peerIdx: Int) {
        self.owner = owner
        self.peerIdx = peerIdx
    }

    func peerConnection(_ pc: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        let idx = peerIdx
        Task { @MainActor [weak self] in self?.owner?.onIceCandidate(idx, candidate) }
    }

    func peerConnection(_ pc: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {
        let idx = peerIdx
        Task { @MainActor [weak self] in self?.owner?.onDataChannel(idx, dataChannel) }
    }

    func peerConnection(_ pc: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        let idx = peerIdx
        Task { @MainActor [weak self] in self?.owner?.onConnectionState(idx, newState) }
    }

    func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {
        let idx = peerIdx
        let state = dataChannel.readyState
        Task { @MainActor [weak self] in self?.owner?.onChannelState(idx, dataChannel, state) }
    }

    func dataChannel(_ dataChannel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
        let idx = peerIdx
        Task { @MainActor [weak self] in self?.owner?.onChannelMessage(idx, buffer) }
    }

    // Unused delegate requirements (data-channel-only peer; no media).
    func peerConnection(_ pc: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    func peerConnection(_ pc: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    func peerConnection(_ pc: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ pc: LKRTCPeerConnection) {}
    func peerConnection(_ pc: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {}
    func peerConnection(_ pc: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {}
    func peerConnection(_ pc: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
}
