import Foundation
import Network
import os

/// CouchPad room advertisement (launcher CONTRACT.md §8): publishes the open
/// room over DNS-SD so a launcher on a phone in the same house offers a one-tap
/// join with no QR scan and no typed code.
///
/// THE ROOM CODE IS THE ENTIRE PAYLOAD. The launcher resolves it against the
/// relay — the same `GET {relayBase}/room/{code}` probe a typed code takes — and
/// that answer, never the LAN, supplies the join URL, the display's platform tag
/// and whether the room is still open. So an advertisement can NAME a room but
/// cannot propose an origin: there is no host to re-validate and no way to point
/// a launcher at an arbitrary page. That is why the record carries no URL, and
/// why this display still declares itself in exactly one place — the
/// controller-URL template `create-room` registers.
///
/// No version key either: `_couchpad._tcp` plus a code some relay knows IS the
/// gate, and a record without a usable `c` is ignored. A later revision adds
/// keys that old launchers skip; a shape they must not read at all takes a new
/// service type.
///
/// The launcher never dials the SRV port. The TCP listener exists only because
/// DNS-SD registration needs a port to publish, so anything that does connect is
/// dropped on arrival.
///
/// The service instance name is deliberately left nil, which makes Bonjour use
/// the device's own name ("Spielzimmer"). The launcher shows that verbatim, so a
/// player with two Apple TVs can tell the rooms apart. `UIDevice.name` cannot
/// serve here: since tvOS 16 it is a synonym for the model and reads "Apple TV"
/// on every box.
///
/// ALL OF IT IS AN ACCELERATOR, NEVER THE ONLY ROUTE IN. mDNS is blocked on
/// AP-isolated and guest networks, and the local-network permission (already
/// requested for the fastlane's ICE checks) can be declined — so every failure
/// here is logged and swallowed, and the on-screen QR and room code remain the
/// universal way in.
final class RoomAdvertiser {

    /// The contract's service type. Not in `protocol.js`: that manifest is for
    /// numbers TWO layers of THIS game must agree on, and this one is owned by
    /// the launcher contract and read by no other layer here — the web display
    /// cannot advertise at all, which is why §6's typed code stays universal.
    static let serviceType = "_couchpad._tcp"

    /// TXT key for the room code (§8). The whole record.
    private static let codeKey = "c"

    private let log = Logger(subsystem: "com.couchgames.tinytrackparty", category: "advertise")

    private var listener: NWListener?
    private var advertisedRoom: String?

    /// Publish `room`, replacing any live record. IDEMPOTENT: the sync that
    /// drives this rides every roster movement, and re-registering the same code
    /// on each one would churn the network for nothing.
    func advertise(room: String) {
        if room == advertisedRoom, listener != nil { return }
        guard !room.isEmpty else {
            withdraw()
            return
        }
        withdraw()
        do {
            let listener = try NWListener(using: .tcp)
            listener.service = NWListener.Service(
                type: Self.serviceType,
                txtRecord: NWTXTRecord([Self.codeKey: room])
            )
            listener.newConnectionHandler = { $0.cancel() }
            listener.stateUpdateHandler = { [log] state in
                // .failed is where a DECLINED local-network permission surfaces;
                // there is no separate authorization callback to consult.
                if case .failed(let error) = state {
                    log.error("advertise failed: \(error.localizedDescription, privacy: .public)")
                }
            }
            listener.serviceRegistrationUpdateHandler = { [log] change in
                if case .add(let endpoint) = change {
                    log.notice("advertising as \(String(describing: endpoint), privacy: .public)")
                }
            }
            listener.start(queue: .main)
            self.listener = listener
            advertisedRoom = room
        } catch {
            log.error("advertise listener refused to start: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Withdraw the record (an mDNS goodbye — records at TTL 0). Cancelling the
    /// listener is what sends it. A record that outlives its room is harmless on
    /// its face — the code resolves to nothing and no card appears — but it costs
    /// a player a wasted tap, so there is no reason to leave one up.
    func withdraw() {
        listener?.cancel()
        listener = nil
        advertisedRoom = nil
    }
}
