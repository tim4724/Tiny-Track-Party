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

    /// A card's race moment, from an optional `-ttpHold <json>` — the table's
    /// `hold` (`galleryScenarios.js`), which `ttp_shot_hold` arms on the race.
    ///
    /// READ OFF THE RAW ARGUMENTS, not `UserDefaults` like its neighbours: the
    /// argument domain parses a value as a property list, so `{"simMs":5000}`
    /// arrives as a dictionary and `string(forKey:)` answers nil — every held
    /// card then shot on the old clock with nothing saying why.
    static var hold: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-ttpHold"), i + 1 < args.count,
              !args[i + 1].isEmpty else { return nil }
        return args[i + 1]
    }

    /// The circuit a card names (`params.track`), from an optional `-ttpTrack`.
    static var track: String? {
        UserDefaults.standard.string(forKey: "ttpTrack").flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The race seed a card pins (`params.seed`), from an optional `-ttpSeed N`;
    /// nil lets the launch draw its own, as live play does.
    static var seed: UInt32? {
        let n = UserDefaults.standard.integer(forKey: "ttpSeed")
        return n > 0 ? UInt32(n) : nil
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
            previewProgress(game)
            game.show(.lobby)
            game.trackId = ""
            game.display.release()
            game.refreshBackdrop()
            state.seats = []
            state.cupSlot = nil

        case "info", "licenses":
            // THE INFO BRANCH, which the web does not have as a screen (its
            // legal links are the welcome board's footer, its licenses a page):
            // the gallery reads these two TV against TV. They are pushed
            // destinations over the lobby and opaque paper, so nothing of the
            // lobby under them is dressed: no circuit (the surface is released,
            // as `lobby-loading` does), no room, no seats. The path is written
            // the way the ⓘ writes it, one page for the board and two for the
            // list behind it.
            game.show(.lobby)
            game.trackId = ""
            game.display.release()
            state.infoPath = id == "info" ? [.info] : [.info, .licenses]

        case "lobby-empty":
            previewProgress(game)
            game.show(.lobby)
            // `maxPlayers`, which is what the seat grid PADS TO, and not how
            // many this launch seats: a two-player couch still shows a full
            // dock, so `-ttpPlayers 2` here would photograph a two-placeholder
            // lobby the game never draws.
            if let track { game.net.setTrack(track) }
            state.seats = (0..<game.proto.maxPlayers).map(GameState.Seat.open(at:))
            state.cupSlot = nil
            fakeJoin(state, code: "TEST")

        case "reconnecting", "disconnected":
            // The display's OWN link over the empty lobby: the two states of
            // `LinkOverlay` (the `set-link` effect), fabricated as the view the
            // effect would have set. The spent budget shows the button, which
            // takes focus as it does live — the card that shows the focus ring.
            previewProgress(game)
            game.show(.lobby)
            if let track { game.net.setTrack(track) }
            state.seats = (0..<game.proto.maxPlayers).map(GameState.Seat.open(at:))
            state.cupSlot = nil
            fakeJoin(state, code: "TEST")
            let gaveUp = id == "disconnected"
            state.link = LinkView(["state": gaveUp ? "disconnected" : "reconnecting",
                                   "attempt": gaveUp ? 0 : 3, "max": 5, "button": gaveUp])

        case "lobby-tour", "lobby-track", "lobby-random":
            previewProgress(game)
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
                    ? ["mode": "track", "trackId": track ?? "driftwood"]
                    : ["mode": "random", "randomRaces": 4])
            // The RANDOM FAMILY's draw is the ROOM BAG's now (entropy-seeded),
            // and the World Tour is in it — so the harness pins the photographed
            // circuit AFTER the pick, through the same set-track walk a cup
            // advance takes. The mode stays what was picked; only the preview is
            // made deterministic, which is what stops the gallery churning a
            // different card every capture.
            if id != "lobby-track" { game.net.setTrack(track ?? "powder") }
            // The scripted seats go on LAST: the pick's track-change refreshes
            // the lobby off the (empty, relay-less) room, and a refresh after
            // this write would photograph four Open placeholders instead of the
            // party the scenario names.
            state.seats = padded(players(playerCount, track: game.trackId))

        case "countdown", "racing", "racing-sidewinder",
             "race-beach", "race-snow", "race-backyard", "race-canyon", "race-playroom",
             "rocket", "monster", "paused", "reconnect", "reconnect-solo", "finished":
            // `racing-sidewinder` (the deck-decal card) and the store's cup
            // races are all this race on another circuit. The gallery table pins
            // it with a `track` param, which the runner passes as `-ttpTrack`.
            //
            // UNLOCKED FIRST: the launch goes through the pick walk, which
            // silently refuses a track in a locked cup, and a fresh install has
            // the Playroom locked — so its card photographed the attract race
            // instead. `unlockAll` is the engine's own dev override (the web's
            // `?unlockAll=1`), not a rule of the harness's.
            _ = ttp_ui_progress_load(nil, 1)
            pinTrack(game)
            game.show(.race)
            game.startDemoRace(forceItem: forceItem(for: id), humans: playerCount, seed: seed)
            // The engine gives and fires the item (the showcase rule, shared with the
            // web preview), so an item card is the same event on every platform.
            _ = ttp_item_showcase(game.sessionHandle, forceItem(for: id))
            if let hold, ttp_shot_hold(game.sessionHandle, hold) == 0 {
                state.lastError = "the engine refused hold \(hold)"
            }
            state.paused = false
            state.pauseButtonShown = true

        case "results", "intermission", "podium":
            pinTrack(game)
            game.show(.race)
            game.startDemoRace(forceItem: nil, humans: playerCount, seed: seed)
            // The board is the engine's fabrication over the same bench race
            // (`ttp_ui_preview_board_json`), run through the real results view. Only
            // the intermission dressing carries a deadline.
            let board = previewBoard(id, game: game)
            let intermissionMs: Double = id == "intermission" ? ttp_race_intermission_ms() : 0
            state.results = GameState.ResultsView(
                TTP.obj(ttp_ui_results_view_json(TTP.json(board), intermissionMs)))
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
            // (race_flow.cc, `orderGrid`), which is exactly what
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
    ///
    /// THE THREE BOARDS NEED IT FOR THE OPPOSITE REASON. A cup board is TWO
    /// PHASES and the CARD IS THE SECOND ONE — the re-sort, the points counting
    /// up, the champion crowned. Shot on arrival they photograph phase 1, which
    /// is a "Cup podium" card that has not yet crowned anybody (the note on
    /// `settleMs` in `galleryScenarios.js` says the same thing for the web).
    /// The tally is bounded at the winner's gain times a tick that is itself a
    /// fraction of phase 1, so twice the phase plus a second clears it however
    /// slow the board; the Android twin waits exactly this.
    static func settle(_ id: String, to game: GameCoordinator) async {
        switch id {
        case "countdown":
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            game.state.countdown = "3"
        case "paused":
            // The overlay goes up AFTER the hold: raised at stand-up it stopped the
            // race before the card's moment, so the hold was never reached.
            game.state.paused = true
        case "finished":
            // One PLAYER home while the field races on: the best-placed car that
            // owns a cell, with the boards' winning time — the web preview's and
            // `Scenarios.kt`'s twin. This column had no finish at all, so the
            // card was a plain race. After the hold, so the field is spread out.
            let hud = game.display.hud()
            let celled = game.sceneCars.enumerated().filter { $0.element.cell }
            guard let lead = celled.min(by: {
                (hud[safe: $0.offset]?.place ?? .max) < (hud[safe: $1.offset]?.place ?? .max)
            }) else { return }
            let order = previewBoard("results", game: game)["order"] as? [[String: Any]]
            let time = (order?.first?["time"] as? NSNumber)?.doubleValue ?? 0
            ttp_force_finish(game.sessionHandle, lead.element.id.json, time)
        case "reconnect", "reconnect-solo":
            // Float a reconnect QR over one racer's cell — the last one, so the
            // leader's card is not the one obscured. AFTER the field has spread
            // out, so it reads mid-race. THROUGH THE PERFORMER, not around it:
            // `show-reconnect` is the net-vocabulary effect the walk emits when
            // a seat drops, and what is fabricated is only the INPUT (which
            // seat); the claim URL, the card payload and the diff over the
            // shown set all stay C++'s. The Android twin does exactly this.
            // (This column photographed a plain race under this name before.)
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let dropped = game.sceneCars.filter(\.cell).last else { return }
            game.net.performNetEffect([
                "op": "show-reconnect",
                "seat": ["peerIndex": dropped.id.numericOrString,
                         "name": dropped.name, "colorIndex": dropped.colorIndex] as [String: Any]
            ])
            // One HUD poll, so the card is painted before the shutter.
            try? await Task.sleep(nanoseconds: 400_000_000)
        case "results", "intermission", "podium":
            // `twoPhase` is the model's own word for it; `racePhaseMs > 0` is
            // this shell re-deriving the same answer from a number that only
            // happens to agree (ResultsView and the Android twin both read the
            // flag).
            guard let board = game.state.results, board.twoPhase else { return }
            try? await Task.sleep(
                nanoseconds: UInt64((board.racePhaseMs * 2 + 1_000) * 1_000_000))
        default:
            return
        }
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
        guard let track else { return }
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

    /// The couch the lobby cards dress: `ttp_ui_preview_progress_json`, loaded like
    /// a saved record, then through the live road that re-reads the catalogue
    /// (`persistProgression(nil)` writes no preference).
    private static func previewProgress(_ game: GameCoordinator) {
        _ = ttp_ui_progress_load(ttp_ui_preview_progress_json(), 0)
        game.persistProgression(nil)
    }

    /// A finished board over the bench race this card launched — the engine's
    /// fabrication, shared with the web and Android harnesses.
    private static func previewBoard(_ kind: String, game: GameCoordinator) -> [String: Any] {
        TTP.obj(ttp_ui_preview_board_json(kind, game.trackId, Int32(playerCount), Double(seed ?? 1), -1))
    }
}
