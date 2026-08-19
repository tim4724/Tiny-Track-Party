import Foundation

/// Stands each screen up from fake data, so it can be photographed without a
/// relay, a phone, or a party.
///
/// The tvOS twin of `public/display/TestHarness.js`, and the scenario ids are
/// shared: `public/shared/galleryScenarios.js` is the one list, read by the live
/// web gallery, by both capture scripts and by the coverage test. A scenario that
/// exists here and not there is a screenshot nothing asks for; one that exists
/// there and not here shows up as a missing card, which is the failure mode you
/// want (visible) rather than the other one (silently stale).
///
/// MATCH THE TABLE'S `id`, NOT THE WEB'S `key`. Several cards share one web
/// harness key with different query params (the lobby, three ways), and this
/// switch reads the id — so `lobby-tour` is a case and `lobby` is not. Cases
/// named after keys drifted here unnoticed for four scenarios, because a case
/// nothing dispatches to just falls to `default` and reports the screen as one
/// this platform does not have.
///
/// `bench` is the one id that is deliberately NOT in that table: it photographs
/// nothing, it is a live race with the frame-cost readout logging.
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

    /// How many PLAYER seats a scenario stands up, from an optional
    /// `-ttpPlayers N` (read the same way `-ttpScenario` and `-ttpTrack` are).
    ///
    /// Four is the 2x2 grid the web's `racing` card photographs, and is what the
    /// gallery wants everywhere. The BENCH is what varies it: a split-screen
    /// cell is most of the frame's cost, so a frame number for one player and a
    /// frame number for four are not the same measurement, and comparing the
    /// three platforms means driving each of them across the same set.
    static var playerCount: Int {
        let n = UserDefaults.standard.integer(forKey: "ttpPlayers")
        return n > 0 ? n : 4
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

    /// The BENCH ROSTER: `n` player seats for a field nobody joined, decided by
    /// the engine rather than invented here (`race_flow.h benchPlayers`, behind
    /// `ttp_race_bench_field_json`). Names, liveries and cars all come from it.
    ///
    /// This file used to spell its own — Ann/Bo/Cy/Di — and the screens gallery
    /// exists to put three platforms' columns side by side, where a renamed seat
    /// is a difference about nothing under inspection. It is the reason
    /// `benchPlayers` exists at all; its header names this harness.
    ///
    /// The answer is a whole launch (players plus the CPU fill that tops the
    /// grid up); the PLAYER rows are the ones it did not mark `ai`. The circuit
    /// does not reach the roster — the field is built from the configured world
    /// — but the call takes one because it IS the launch, so it is handed
    /// whatever is about to be raced.
    static func benchRoster(_ n: Int, track: String) -> [[String: Any]] {
        let bench = TTP.obj(TTP.strOrEmpty(ttp_race_bench_field_json(track, Int32(n), 0)))
        return (bench["field"] as? [[String: Any]] ?? []).filter { $0["ai"] as? Bool != true }
    }

    /// The same roster as lobby SEATS. One car model each, so a photographed
    /// dock shows different cars rather than four of the same.
    private static func players(_ n: Int, track: String) -> [GameState.Seat] {
        benchRoster(n, track: track).enumerated().map { i, row in
            GameState.Seat(index: i, open: false, name: row["name"] as? String ?? "",
                           colorIndex: int(row["colorIndex"]) ?? i,
                           carIndex: int(row["carIndex"]) ?? i,
                           modelIndex: i,
                           off: false, host: i == 0, ready: i != 1)
        }
    }

    /// A count out of a `ttp_*` JSON answer. `JSONSerialization` hands numbers
    /// back as `NSNumber`, and a null carIndex (a seat that never picked) has to
    /// stay absent rather than collapsing to 0.
    private static func int(_ v: Any?) -> Int? { (v as? NSNumber)?.intValue }

    /// Stand up `id`. Returns false for an unknown scenario, which the runner
    /// reports rather than photographing whatever was on screen.
    @discardableResult
    static func apply(_ id: String, to game: GameCoordinator) -> Bool {
        let state = game.state
        ready = false
        // THE FAKE PLAYERS DRIVE. Latched for the whole run rather than passed
        // per launch, because it is a property of the RUN and not of one race
        // (`ttp_race.h`), and this function is the only road into a harness
        // race. Without it an unsteered seat does not sit on the grid: throttle
        // is automatic, so it accelerates away, never turns, and piles into the
        // first corner — measured at 45.7 units of track in 900 frames against a
        // driving car's 151. Every race photograph in this column was of that.
        ttp_race_autopilot_players(1)

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

        case "lobby-loading":
            // THE FIRST THING A VIEWER EVER SEES, and until now the one board
            // this shell could not photograph. Every other lobby scenario
            // previews a circuit, so the 3D surface covers the backdrop — which
            // means the PAPER DIORAMA has never appeared in a tvOS shot, on a
            // platform whose whole point is that the paper is what stands there
            // while the engine warms up. A defect in it is invisible to the one
            // surface that exists to catch defects.
            //
            // The state is boot's, before anything has arrived: no circuit
            // previewed (which is what `refreshBackdrop` reads to keep the paper
            // up), no room, no seats, no pick. `release()` drops any scene a
            // previous boot left in the renderer, so the backdrop is deciding
            // this picture rather than an empty 3D view happening to be black.
            game.show(.lobby)
            game.trackId = ""
            game.display.release()
            game.refreshBackdrop()
            state.seats = []
            state.cupSlot = nil

        case "lobby-empty":
            game.show(.lobby)
            // `maxPlayers`, which is what the seat grid PADS TO, and not how
            // many this launch seats: a two-player couch still shows a full
            // dock, so `-ttpPlayers 2` here would photograph a two-placeholder
            // lobby the game never draws.
            state.seats = (0..<game.proto.maxPlayers).map(GameState.Seat.open(at:))
            state.cupSlot = nil
            fakeJoin(state, code: "TEST")

        case "lobby-tour", "lobby-track", "lobby-random":
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
                id == "lobby-tour"
                    ? ["mode": "tour"]
                    : id == "lobby-track"
                    ? ["mode": "track", "trackId": "driftwood"]
                    : ["mode": "random", "randomRaces": 4])
            // The RANDOM FAMILY's draw is the ROOM BAG's now (entropy-seeded),
            // and the World Tour is in it — so the harness pins the photographed
            // circuit AFTER the pick, through the same set-track walk a cup
            // advance takes. The mode stays what was picked; only the preview is
            // made deterministic, which is what stops the gallery churning a
            // different card every capture.
            if id != "lobby-track" { game.net.setTrack("powder") }
            // The scripted seats go on LAST: the pick's track-change refreshes
            // the lobby off the (empty, relay-less) room, and a refresh after
            // this write would photograph four Open placeholders instead of the
            // party the scenario names.
            state.seats = padded(players(playerCount, track: game.trackId))

        case "countdown", "racing", "racing-sidewinder",
             "rocket", "monster", "paused", "reconnect", "finished":
            // `racing-sidewinder` is the deck-decal card: the same race on a
            // circuit whose hairpins force scrub skids onto the racing line, and
            // the gallery entry pins it with a `track` param the web reads off
            // the query string. This column had no case for it at all.
            if id == "racing-sidewinder" { game.trackId = "sidewinder" }
            pinTrack(game)
            game.show(.race)
            game.startDemoRace(forceItem: forceItem(for: id), humans: playerCount)
            state.paused = id == "paused"
            state.pauseButtonShown = true

        case "results", "intermission", "podium":
            game.show(.race)
            game.startDemoRace(forceItem: nil, humans: playerCount)
            state.results = fakeResults(kind: id, game: game)
            if id == "intermission" { state.intermissionSecs = 5 }

        case "bench":
            // NOT A GALLERY CARD, and deliberately not in `galleryScenarios.js`:
            // nothing here is photographed. It is a live race that keeps racing
            // with the frame-cost readout logging at 1 Hz, so a script can read
            // a number off an Apple TV — which nothing could do before.
            //
            // The SAME race the gallery's `racing` card runs, on the same road,
            // for the same reason a bench exists at all: a frame cost measured
            // on an arrangement the game cannot produce is worth nothing. The
            // player seats drive because `apply` latched autopilot above, and
            // the live launch grids humans at the back of an eight-car field
            // (ttp_race.cc, `humansAtBack`), which is exactly what
            // `ttp_race_bench_field_json` composes for a shell with no room.
            //
            // `-ttpPlayers N` picks how many cells are in the picture and
            // `-ttpTrack <id>` picks the circuit; both are the sweep's axes,
            // because a frame's cost scales with cells and pixels together and
            // a lap's own cost varies by circuit.
            pinTrack(game)
            game.show(.race)
            game.startDemoRace(forceItem: nil, humans: playerCount)
            // AFTER the launch: `startDemoRace` resolves an empty trackId to the
            // catalogue's first, and the readout names what is being driven.
            game.display.perf.bench(track: game.trackId)

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

    /// An optional `-ttpTrack <id>`, the tvOS twin of the web scenarios' `track`
    /// param: it pins the circuit for a hand-driven run (SkidShotTests uses it)
    /// and is the bench's circuit axis. An id the catalogue does not contain
    /// fails inside ttp_session_begin, same as every other wrong pick.
    private static func pinTrack(_ game: GameCoordinator) {
        guard let track = UserDefaults.standard.string(forKey: "ttpTrack"),
              !track.isEmpty else { return }
        game.trackId = track
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

    /// Lap times and banked cup points for the fabricated boards.
    /// `public/display/TestHarness.js`'s FAKE_TIMES and FAKE_POINTS, and
    /// `Scenarios.kt`'s TIMES and BANKED — the same numbers on purpose, so three
    /// columns of the same board differ only where the UI differs. The banked
    /// points carry a LEADER SWAP (row 2 leads the cup despite row 1 winning
    /// this race), which is the only thing on a cup board that shows what the
    /// race did.
    private static let times = [28.4, 30.7, 33.1, 35.8, 38.2, 41.0, 44.3, 47.6]
    private static let banked = [10, 15, 6, 3, 2, 1, 0, 0]
    /// `native/libttp-sim/ttp/grand_prix.cc`'s ladder, for the fabricated cup
    /// boards. Not on any ABI, and hand-copied in all three harnesses.
    private static let pointsByRank = [9, 6, 3, 1]

    /// A finished BOARD, fabricated in the shape `ttp_ui_standings_live_json`
    /// answers (`{over, hostPeerIndex, [series], order:[row…]}`), then run
    /// through the REAL results view so the podium slicing, the AI suffix, the
    /// two phases and the time column are the model's answers rather than this
    /// file's guesses.
    ///
    /// The board is fabricated rather than gathered because its gatherer reads
    /// LIVE handles (the session's ranked rows, the room-retained field) and a
    /// screenshot scenario has neither — the same privilege the web and Android
    /// harnesses take. What is NOT fabricated is the view: every key below is a
    /// board-row key `resultsView` reads, so a renamed field fails the shot.
    ///
    /// THE WHOLE FIELD, off the race standing behind the board — not four
    /// invented rows. The demo launch tops the grid up to the field size with
    /// CPUs, so `sceneCars` already holds the cars the HUD behind this glass is
    /// drawing, with the engine's own names and liveries.
    private static func fakeResults(kind: String, game: GameCoordinator) -> GameState.ResultsView? {
        // `results` is a plain single race; `intermission` and `podium` are the
        // two CUP dressings of the same overlay, and until now this shell sent
        // no series at all — so all three photographed the same plain board and
        // two thirds of that gallery row said nothing.
        let cup = kind != "results"
        var rows: [[String: Any]] = game.sceneCars.enumerated().map { i, car in
            var row: [String: Any] = [
                "playerId": car.id.numericOrString,
                "name": car.name,
                "colorIndex": car.colorIndex,
                // The CPU fill, so the board draws the model's AI suffix. A
                // bot's id is a STRING in this ABI (`ai-0`) and a seat's is a
                // number (ttp_race.h), which is the whole test — and it beats
                // the row index, since the scene roster is captured before the
                // grid is ordered and nothing here should depend on that.
                "ai": !(car.id.numericOrString is Int),
                "finished": true,
                "time": times[i % times.count],
                // LOAD-BEARING ON THE ROUND TRIP, not just here: racePlace is
                // what carries the FINISHING order through the cup re-sort
                // below, and a board that drops it collapses phase 1 into a
                // table where everyone came first. This shell dropped it.
                "racePlace": i + 1
            ]
            if cup {
                let gained = i < pointsByRank.count ? pointsByRank[i] : 0
                row["gained"] = gained
                row["points"] = banked[i % banked.count] + gained
            }
            return row
        }
        // Built in FINISHING order, then sorted into CUP order — the two orders
        // `standingsPayload` produces.
        if cup {
            rows.sort { (($0["points"] as? Int) ?? 0) > (($1["points"] as? Int) ?? 0) }
        } else if let joiner = benchRoster(playerCount + 1, track: game.trackId).last {
            // The LATE JOINER riding along under the field, which is a row shape
            // nothing else on the board has: `rowValue` returns early for it, so
            // every other cell is absent and the card says "Next race" instead
            // of a time. Only the single-race card carries one, matching the
            // web's — and their seat is simply the next one the bench roster
            // would have handed out.
            rows.append(["playerId": rows.count + 1,
                         "name": joiner["name"] as? String ?? "",
                         "colorIndex": int(joiner["colorIndex"]) ?? playerCount,
                         "joining": true])
        }
        var board: [String: Any] = [
            "over": true,
            "hostPeerIndex": rows.first?["playerId"] ?? NSNull(),
            "order": rows
        ]
        if cup { board["series"] = fakeSeries(final: kind == "podium") }
        // Only the intermission dressing carries a deadline; a plain results
        // board and a cup podium do not. The budget is the layer's number.
        let intermissionMs: Double = kind == "intermission" ? ttp_race_intermission_ms() : 0
        return GameState.ResultsView(TTP.obj(ttp_ui_results_view_json(TTP.json(board), intermissionMs)))
    }

    /// The cup half of a fabricated board: the shipped catalogue's first cup,
    /// mid-run for the intermission and on its last race for the podium.
    ///
    /// `nextTrackName` is resolved HERE rather than by the model: the live
    /// gatherer builds this block off the room's series and hands the resolved
    /// name over, so `boardOf` takes it as given.
    private static func fakeSeries(final: Bool) -> [String: Any] {
        let catalogue = TTP.obj(ttp_ui_catalogue_json())
        let cupRow = (catalogue["cups"] as? [[String: Any]] ?? []).first ?? [:]
        let tracks = (cupRow["tracks"] as? [String]) ?? []
        let raceIndex = final ? max(tracks.count - 1, 0) : 1
        let next = final ? nil : tracks[safe: raceIndex + 1]
        let catalog = catalogue["catalog"] as? [[String: Any]] ?? []
        let nextName = next.flatMap { id in
            catalog.first { $0["id"] as? String == id }?["name"] as? String
        }
        return [
            "cupId": cupRow["id"] ?? NSNull(),
            "cupName": cupRow["name"] ?? NSNull(),
            "endless": false,
            "raceIndex": raceIndex,
            "raceCount": max(tracks.count, 1),
            "nextTrackId": next ?? NSNull(),
            "nextTrackName": nextName ?? NSNull(),
            // `final` on the wire, `isFinal` in C++, and it is what BOTH the
            // podium and the intermission dressings are derived from.
            "final": final,
            "autoAdvanceMs": ttp_race_intermission_ms()
        ]
    }
}
