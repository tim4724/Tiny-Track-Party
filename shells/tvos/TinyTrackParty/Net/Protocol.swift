import Foundation

/// The shared manifest, READ out of the engine rather than retyped into Swift.
///
/// Every value here comes from one call — `ttp_protocol_manifest_json()` — which
/// exists FOR shells like this one. `ttp_party.h` says so in as many words: a C++
/// layer honours the config rule by including `ttp/protocol.h` and the web shell
/// by reading `public/shared/protocol.js`, and a shell that can do neither had no
/// third option, so its lobby would hand-copy the car list and its transport the
/// liveness windows, with nothing anywhere watching the copy.
///
/// **A table retyped into Swift is pinned by nothing** and will drift the first
/// time a number moves. What pins the export instead:
/// `tests/config-drift.test.js` deep-equals it against the WHOLE of
/// `public/shared/protocol.js` (the one assertion in the tree that catches a
/// constant added there and forgotten everywhere else), and
/// `native/runtimetest/abi_check.cc` pins it to the library on every leg. So
/// reading it is the only legitimate source, and the parse below is deliberately
/// the only place in this shell that names any of these keys.
///
/// The web shell deliberately does NOT call this (protocol.js is the authored
/// source and is already on its page). Its consumers are ports.
struct GameProtocol {

    // MARK: - The origin the phones load from

    /// The web deployment serving the phone controller.
    ///
    /// `session.h`'s `join_url` needs an origin, and a TV app has none of its own
    /// — so the web deployment is a RUNTIME DEPENDENCY of every TV app
    /// (`docs/native-port/shells.md`, the base-URL item). This is the tvOS
    /// spelling of the web's `baseUrlOverride` seam, which is the existing hook
    /// for exactly this and the reason nothing below composes a URL by hand:
    /// every one of the four URLs a room's identity is spelled into is
    /// `ttp_net_*`'s answer over this string.
    let baseURL: URL

    // MARK: - Transport

    let relayURL: URL
    /// The fastlane's ICE pair: first-party STUN, then the public fallback so a
    /// stun.* outage costs nothing. STUN only — no TURN is configured anywhere,
    /// so a symmetric NAT falls back to the relay by design.
    let stunURL: String
    let stunFallbackURL: String

    // MARK: - The wire vocabulary (MSG)

    // Flat rather than nested, because a call site reads `proto.msgCountdown`
    // and there is then exactly one spelling of each type in the shell. Only
    // the types this shell SENDS or matches are read: inbound routing never
    // compares a type string in Swift (`ttp_net_message_action` /
    // `ttp_net_inbound_route` do it), so the inbound-side constants have no
    // caller to exist for.
    /// Four, and only four: CONTROL is matched on its input short-circuit,
    /// ITEM and COUNTDOWN are composed for sends, and SELECT_MODE is composed
    /// for the display's OWN boot-seed pick (the null-sender walk). The
    /// button-press vocabulary (START_GAME, the pauses, SERIES_NEXT) is
    /// consumed by `ttp_net_controller_action`'s verdict, and the PONG and the
    /// heartbeat frames arrive composed on the `send-to` effect — none of
    /// those words is ever spelled in Swift now.
    let msgControl: String
    let msgItem: String
    let msgCountdown: String
    let msgSelectMode: String

    // MARK: - The presence contract (LIVENESS)

    /// The presence WINDOWS this shell's own timers arm — never the timers
    /// themselves (`Timer` stays with each platform's shell). Only three of the
    /// manifest's are read: the phone's ping cadence is the PHONE's, the
    /// heartbeat-dead window lives inside `ttp_net_heartbeat_tick_json`, and
    /// the create watchdog's delay rides the `arm-create-watchdog` effect.
    struct Liveness {
        /// DISPLAY. Silence longer than this drops a seat mid-game, through the
        /// same path as a real `peer_left`.
        let timeoutMs: Double
        /// DISPLAY. The cadence the display re-checks presence on.
        let tickMs: Double
        /// DISPLAY. Every racer gone while late joiners wait: hold the room this
        /// long, then return to the lobby.
        let abandonedRaceGraceMs: Double
    }

    let liveness: Liveness

    // MARK: - Cars

    /// The livery palette, indexed by the dense colour slot
    /// `ttp_room_lowest_free_slot` hands out.
    let carColors: [String]
    /// Kenney model base names, indexed by `carIndex`. This is the one roster
    /// field that never crosses the display ABI — it names BYTES TO FETCH, which
    /// is a platform job.
    let carModels: [String]
    let carNames: [String]
    /// Per-model handling stats, parallel to `carModels`. Handed straight back to
    /// `ttp_race_configure`.
    let carStats: [[String: Double]]

    // MARK: - Field sizes

    /// The cap on PHONES, not on cars in a race: a short-handed lobby is topped
    /// up with AI.
    let maxPlayers: Int
    /// Cars in every race — humans plus the AI top-up. NOT `maxPlayers`: this
    /// shell once handed `ttp_race_configure` the phone cap and raced half a
    /// field while the web raced eight.
    let fieldSize: Int
    let totalLaps: Int
    let countdownSeconds: Int

    // RANDOM_RACES is deliberately NOT here: what a bare `random` pick means
    // and the ceiling a SELECT_MODE is clamped against are the pick walk's
    // (`ttp_net.cc` normRandomRaces over protocol.h) — this shell shipped its
    // own default of 1 once, and the walk is what made that unrepeatable.

    // MARK: - Loading

    /// Parse the manifest once at boot.
    ///
    /// `@MainActor` because it touches the ABI's per-call scratch, which is the
    /// shell-wide rule for every `ttp_*` call.
    @MainActor
    static func load(baseURL: URL = GameProtocol.defaultBaseURL) -> GameProtocol {
        let m = TTP.obj(ttp_protocol_manifest_json())
        let msg = m["MSG"] as? [String: Any] ?? [:]
        let live = m["LIVENESS"] as? [String: Any] ?? [:]

        // A missing key here is not a runtime condition. The manifest is compiled
        // into the same binary as this file, so it can only be absent if the
        // static library and the Swift are from different builds — in which case
        // every wire type and window is suspect and a black screen with a wrong
        // room code is a worse outcome than stopping here. Same argument as R16
        // makes for the .filamat blobs: assert, do not degrade.
        func str(_ dict: [String: Any], _ key: String, _ block: String) -> String {
            guard let v = dict[key] as? String else {
                fatalError("ttp_protocol_manifest_json(): \(block).\(key) is missing or not a string")
            }
            return v
        }
        func num(_ dict: [String: Any], _ key: String, _ block: String) -> Double {
            guard let v = dict[key] as? Double else {
                fatalError("ttp_protocol_manifest_json(): \(block).\(key) is missing or not a number")
            }
            return v
        }
        // Same argument as `str`, and it bites harder here: an empty CAR_MODELS
        // would reach `ttp_ui_configure` as carCount 0 and produce a lobby whose
        // every car pick is refused, with nothing logged anywhere.
        func table<T>(_ key: String, _ type: T.Type) -> T {
            guard let v = m[key] as? T else {
                fatalError("ttp_protocol_manifest_json(): \(key) is missing or the wrong shape")
            }
            return v
        }

        let relayText = str(m, "RELAY_URL", "manifest")
        guard let relay = URL(string: relayText) else {
            fatalError("ttp_protocol_manifest_json(): RELAY_URL '\(relayText)' is not a URL")
        }

        return GameProtocol(
            baseURL: baseURL,
            relayURL: relay,
            stunURL: str(m, "STUN_URL", "manifest"),
            stunFallbackURL: str(m, "STUN_FALLBACK_URL", "manifest"),

            msgControl: str(msg, "CONTROL", "MSG"),
            msgItem: str(msg, "ITEM", "MSG"),
            msgCountdown: str(msg, "COUNTDOWN", "MSG"),
            msgSelectMode: str(msg, "SELECT_MODE", "MSG"),

            liveness: Liveness(
                timeoutMs: num(live, "TIMEOUT_MS", "LIVENESS"),
                tickMs: num(live, "TICK_MS", "LIVENESS"),
                abandonedRaceGraceMs: num(live, "ABANDONED_RACE_GRACE_MS", "LIVENESS")),

            carColors: table("CAR_COLORS", [String].self),
            carModels: table("CAR_MODELS", [String].self),
            carNames: table("CAR_NAMES", [String].self),
            carStats: table("CAR_STATS", [[String: Double]].self),

            maxPlayers: Int(num(m, "MAX_PLAYERS", "manifest")),
            fieldSize: Int(num(m, "FIELD_SIZE", "manifest")),
            totalLaps: Int(num(m, "TOTAL_LAPS", "manifest")),
            countdownSeconds: Int(num(m, "COUNTDOWN_SECONDS", "manifest")))
    }

    /// Where the phones load the controller from when nothing overrides it.
    ///
    /// The Info.plist key is the seam a build sets: TestFlight, a LAN dev server
    /// and the App Store build all point somewhere different, and none of them is
    /// a code change. The fallback is the deploy every push produces
    /// (`.github/workflows/preview.yml` builds
    /// `https://tinytrack-<branch>.couchpad.games` for every branch, `main`
    /// included) — a real, reachable origin rather than an invented hostname, so
    /// a shell run with no configuration still shows a QR that works.
    ///
    /// It is NOT the right value for a shipping build. Set `TTPBaseURL`.
    static var defaultBaseURL: URL {
        if let text = Bundle.main.object(forInfoDictionaryKey: "TTPBaseURL") as? String,
           let url = URL(string: text), url.scheme != nil {
            return url
        }
        return URL(string: "https://tinytrack-main.couchpad.games")!
    }
}
