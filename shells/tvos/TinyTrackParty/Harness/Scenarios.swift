import Foundation

/// Stands each screen up from fake data, so it can be photographed without a
/// relay, a phone, or a party.
///
/// The tvOS twin of `public/display/TestHarness.js`, and the scenario NAMES are
/// shared: `public/shared/galleryScenarios.js` is the one list, read by the live
/// web gallery, by both capture scripts and by the coverage test. A scenario that
/// exists here and not there is a screenshot nothing asks for; one that exists
/// there and not here shows up as a missing card, which is the failure mode you
/// want (visible) rather than the other one (silently stale).
///
/// DEV-ONLY, reached by nothing on the shipping path: `GameCoordinator.boot()`
/// never calls this, and it runs only when the launch arguments carry
/// `-ttpScenario`. It is compiled into the app rather than kept behind a flag
/// because the screenshot test has to launch the SHIPPING binary for the picture
/// to mean anything.
///
/// WHAT IT MAY NOT DO is invent a rule. Every value below is either obviously
/// fake data (names, times) or comes from the same `ttp_*` call the live screen
/// uses. A harness that composed its own results board would photograph a screen
/// the game cannot produce.
@MainActor
enum Scenarios {

    /// The launch argument the screenshot runner passes. `nil` in normal use.
    static var requested: String? {
        UserDefaults.standard.string(forKey: "ttpScenario")
    }

    /// Set once the screen has been standing for a few frames, and read by the
    /// UI test as an accessibility identifier.
    ///
    /// THIS IS THE PART THAT DECIDES WHETHER THE SHOTS ARE USABLE. A bare
    /// `sleep(2)` in the test would photograph a cold Metal shader compile about
    /// one run in five, and the gallery would fill with half-loaded scenes that
    /// nobody looks at closely enough to catch. The web capture waits on
    /// `__scene && __engine` then `document.fonts.ready` for exactly this reason.
    ///
    /// A plain static rather than @Published: an enum cannot hold one, and the
    /// only reader is an accessibility identifier the UI test polls.
    static var ready = false

    static let readyIdentifier = "ttp-ready"

    /// What the root reports when `apply` refuses a scenario. A screen this
    /// platform does not have is not a failure; it is a gap the gallery shows.
    static let unsupportedIdentifier = "ttp-unsupported"

    // Four fake players, one per car model, so a photographed field shows four
    // different cars rather than four of the same.
    private static func players(_ n: Int) -> [GameState.Seat] {
        let names = ["Ann", "Bo", "Cy", "Di"]
        return (0..<n).map { i in
            GameState.Seat(index: i, open: false, name: names[i % names.count],
                           colorIndex: i, carIndex: i, modelIndex: i,
                           off: false, host: i == 0, ready: i != 1)
        }
    }

    /// Stand up `id`. Returns false for an unknown scenario, which the runner
    /// reports rather than photographing whatever was on screen.
    @discardableResult
    static func apply(_ id: String, to game: GameCoordinator) -> Bool {
        let state = game.state
        ready = false

        switch id {
        case "welcome":
            // NOT A SCREEN ON THIS PLATFORM. The web's title board exists to
            // collect the user gesture that unlocks audio and fullscreen; tvOS
            // needs neither, so the app boots straight into the lobby and there
            // is nothing here to photograph. Returning false makes the capture
            // skip it and the gallery show the web shot with no tvOS counterpart
            // — which is the honest record of a deliberate difference, and
            // better than a lobby filed under the wrong name.
            return false

        case "lobby-empty":
            game.show(.lobby)
            state.seats = (0..<4).map(GameState.Seat.open(at:))
            state.cupSlot = nil
            fakeJoin(state, code: "TEST")

        case "lobby":
            game.show(.lobby)
            state.seats = padded(players(4))
            state.cupSlot = nil
            fakeJoin(state, code: "TEST")

        case "lobby-cup", "lobby-track", "lobby-random":
            game.show(.lobby)
            fakeJoin(state, code: "TEST")
            // THROUGH THE PICK WALK, not around it. A harness may fabricate its
            // INPUTS — a scripted roster, a named cup, WHICH random draw (its
            // privilege: a real one would make this a different circuit every
            // capture) — but everything downstream has to be the road the live
            // lobby drives: the same select-mode walk a host's pick takes, whose
            // track-change effect stages the preview and refreshes the card.
            //
            // It used to assign `state.cupSlot` directly and never touch the
            // track, so every picked-lobby photograph was a cup card floating on
            // PAPER — and the live board's actual defect (no 3D preview, because
            // nothing ever called the cup slot either) was invisible to the one
            // surface that exists to catch it.
            game.net.applyPick(
                id == "lobby-cup"
                    ? ["mode": "cup", "cupId": firstCupId() as Any? ?? NSNull()]
                    : id == "lobby-track"
                    ? ["mode": "track", "trackId": "driftwood"]
                    : ["mode": "random", "randomRaces": 4])
            // The random pick's draw is the ROOM BAG's now (entropy-seeded), so
            // the harness pins the photographed circuit AFTER the pick, through
            // the same set-track walk a cup advance takes — mode stays random,
            // only the preview is made deterministic.
            if id == "lobby-random" { game.net.setTrack("powder") }
            // The scripted seats go on LAST: the pick's track-change refreshes
            // the lobby off the (empty, relay-less) room, and a refresh after
            // this write would photograph four Open placeholders instead of the
            // party the scenario names.
            state.seats = padded(players(4))

        case "countdown", "racing", "rocket", "monster", "paused", "reconnect", "finished":
            // An optional `-ttpTrack <id>` pins the circuit — the tvOS twin of
            // the web scenarios' `track` param (e.g. racing-sidewinder). An id
            // the catalogue does not contain fails inside ttp_session_begin,
            // same as every other wrong pick.
            if let track = UserDefaults.standard.string(forKey: "ttpTrack"),
               !track.isEmpty {
                game.trackId = track
            }
            game.show(.race)
            game.startDemoRace(forceItem: forceItem(for: id))
            state.paused = id == "paused"
            state.pauseButtonShown = true

        case "results", "intermission", "podium":
            game.show(.race)
            game.startDemoRace(forceItem: nil)
            state.results = fakeResults(kind: id)
            if id == "intermission" { state.intermissionSecs = 5 }

        default:
            return false
        }
        return true
    }

    /// What has to be written AFTER the screen has settled, immediately before
    /// the shot.
    ///
    /// The countdown banner is the whole of it, and it needs this because it is
    /// the one piece of chrome the RACE FLOW also writes. `startDemoRace`
    /// launches with no countdown, so the flow puts up GO the instant the race
    /// starts and clears the banner about a second later — over the top of
    /// anything the scenario wrote at stand-up. A real 3-second countdown does
    /// not survive either: the runner waits for the Metal surface plus a settle
    /// before it looks, by which time the beats are long spent.
    ///
    /// THE SLEEP IS THE POINT, and it took three captures to see why. Writing
    /// the banner at stand-up + 1 s lands on exactly the same beat as the flow's
    /// own GO clear, so the two race and the clear usually wins — which looks
    /// like the view not rendering rather than like a value being overwritten
    /// (the write and the re-render both demonstrably happened). Waiting past
    /// the clear makes it deterministic: after it, a running race emits no
    /// further countdown effects, so nothing can take the banner down again.
    ///
    /// Every countdown photograph this shell had taken until now was of no
    /// countdown at all.
    static func settle(_ id: String, to game: GameCoordinator) async {
        guard id == "countdown" else { return }
        try? await Task.sleep(nanoseconds: 1_200_000_000)
        game.state.countdown = "3"
    }

    private static func padded(_ seats: [GameState.Seat]) -> [GameState.Seat] {
        // The PADDING is the model's job (ttp_ui_seat_grid_json), so that three
        // shells cannot pad differently. Round-tripping through it here keeps the
        // photographed grid the same grid the live lobby draws.
        let grid = TTP.arr(ttp_ui_seat_grid_json(TTP.json(seats.map(\.wire))))
        return grid.enumerated().compactMap { GameState.Seat($0.element, index: $0.offset) }
    }

    private static func fakeJoin(_ state: GameState, code: String) {
        state.roomCode = code
        state.joinURL = "tinytrack.party/\(code)"
        state.joinQR = QRCode.image(for: "https://tinytrack.party/\(code)")
    }

    /// The shipped catalogue's first cup. A `String?` rather than the JSON
    /// `Any`/`NSNull` it used to be: `ModePick` takes an optional, and the two
    /// spellings of absence do not bridge.
    private static func firstCupId() -> String? {
        let cups = TTP.obj(ttp_ui_catalogue_json())["cups"] as? [[String: Any]] ?? []
        return cups.first?["id"] as? String
    }

    /// The item scenarios force a roulette so the thing they are named after is
    /// actually on screen, rather than showing up once a lap.
    private static func forceItem(for id: String) -> String? {
        switch id {
        case "rocket": return "rocket"
        case "monster": return "monster"
        default: return nil
        }
    }

    /// A finished BOARD, fabricated in the shape `ttp_ui_standings_live_json`
    /// answers (`{over, hostPeerIndex, total, order:[row…]}`), then run through
    /// the REAL results view so the podium slicing, the AI suffix and the time
    /// column are the model's answers rather than this file's guesses.
    ///
    /// The board is fabricated rather than gathered because its gatherer reads
    /// LIVE handles now (the session's ranked rows, the room-retained field)
    /// and a screenshot scenario has neither — the same privilege the web
    /// harness takes. What is NOT fabricated is the view: every key below is a
    /// board-row key `resultsView` reads, so a renamed field fails the shot.
    private static func fakeResults(kind: String) -> GameState.ResultsView? {
        let names = ["Ann", "Bo", "Cy", "Di"]
        var order: [[String: Any]] = []
        for i in 0..<4 {
            var row: [String: Any] = [:]
            row["playerId"] = i + 1
            row["name"] = names[i]
            row["colorIndex"] = i
            row["ai"] = i >= 2
            row["finished"] = true
            row["time"] = 62.4 + Double(i) * 1.7
            order.append(row)
        }
        var board: [String: Any] = [:]
        board["over"] = true
        board["hostPeerIndex"] = 1
        board["total"] = 4
        board["order"] = order
        // Only the intermission dressing carries a deadline; a plain results
        // board and a cup podium do not. The budget is the layer's number.
        let intermissionMs: Double = kind == "intermission" ? ttp_race_intermission_ms() : 0
        return GameState.ResultsView(TTP.obj(ttp_ui_results_view_json(TTP.json(board), intermissionMs)))
    }
}
