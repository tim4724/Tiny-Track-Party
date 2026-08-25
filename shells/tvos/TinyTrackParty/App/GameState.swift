import Foundation
import SwiftUI

/// Everything the SwiftUI screens render from, and nothing else.
///
/// The shape of this type is the shell's half of the project's central rule:
/// **C++ decides, the shell renders.** Every property below was produced by a
/// named `ttp_*` call and is stored here verbatim — no view derives a rule, and
/// nothing in this file computes a game answer. When a value looks like it wants
/// a computed property, that is the signal the rule belongs in
/// `libttp-runtime/ttp/ui_model.cc` where the other shells can reach it too.
///
/// Strings arriving from the model are KEYS plus data (`titleKey`, `racesKey`,
/// `newGameKey`), never composed English — see `Copy.swift` for the tables that
/// turn them into words. That is why this holds `titleKey` and `cupName` as two
/// fields rather than one sentence.
@MainActor
final class GameState: ObservableObject {

    // MARK: - Screen

    /// `ttp_ui.h`'s screen enum. The ORDER is the model's (`ui_model.cc`), and
    /// `ttp_ui_back_effect` maps each to what the Menu button does.
    enum Screen: String {
        case welcome, lobby, race
    }

    @Published var screen: Screen = .welcome

    /// `ttp_ui_cover`'s answer — "none" | "boot". A full-bleed board over
    /// whichever screen is up, and deliberately NOT a screen of its own: it is
    /// not navigable, pushes nothing and has no Menu behaviour. See
    /// `ttp/ui_model.h`, and `CoverView` for why it never animates.
    ///
    /// The literal here is never the one a viewer sees: `GameCoordinator.init`
    /// asks the model for the real answer before the first body is drawn, which
    /// it has to because SwiftUI draws that body before `boot()` runs.
    @Published var cover: String = "none"

    /// What the 3D surface is doing behind the chrome. The welcome board is
    /// always over the paper diorama; the lobby crossfades to the live track
    /// preview once a scene is built.
    @Published var sceneVisible = false

    // MARK: - Room (the join ticket)

    @Published var roomCode: String = ""
    @Published var joinURL: String = ""
    /// Rendered by `CIQRCodeGenerator`. The URL composition is shared C++
    /// (`session.h`'s `join_url`); only the bitmap is per-platform, which is
    /// decision D3 in `docs/native-port/shared-cpp-plan.md`.
    @Published var joinQR: CGImage?

    // MARK: - Lobby

    /// One entry per grid cell, already padded to `maxPlayers` with open seats by
    /// `ttp_ui_seat_grid_json`. The padding is the model's job precisely so three
    /// shells cannot pad differently.
    @Published var seats: [Seat] = []

    struct Seat: Identifiable {
        let index: Int
        let open: Bool
        let name: String
        let colorIndex: Int
        let carIndex: Int
        let modelIndex: Int
        /// A held seat whose phone dropped. Dimmed, deliberately NOT removed —
        /// the seat is still theirs to come back to.
        let off: Bool
        let host: Bool
        let ready: Bool

        var id: Int { index }

        static func open(at index: Int) -> Seat {
            Seat(index: index, open: true, name: "", colorIndex: 0, carIndex: 0,
                 modelIndex: 0, off: false, host: false, ready: false)
        }
    }

    /// `ttp_ui_cup_slot_json`. Nil before the host has picked anything, and the
    /// whole card is hidden then.
    @Published var cupSlot: CupSlot?

    struct CupSlot {
        let nameKey: String     // "random" | "cup" | "track" | "tour"
        let name: String?
        let racesKey: String    // "one" | "endless" | "count"  -> Copy.races
        let raceCount: Int
        /// 0...4 pips, nil hides the meter entirely.
        let difficulty: Int?
        let maps: [Map]
        let cupId: String?

        struct Map: Identifiable {
            let index: Int
            /// Nil is an UNDRAWN race — the "?" chip. The tour's chips all say
            /// so (the drawn first race included, so the card spoils nothing),
            /// and the shell's own random veil manufactures the rest.
            let trackId: String?
            /// A cup's running order (1...4); 0 stands in for absent — an exact
            /// track has nothing to number, and neither does a "?" chip.
            let n: Int
            /// The undrawn chip's own cup wash (the tour's ladder). Nil on a
            /// "?" chip means the picker's neutral grey — an unknown must not
            /// borrow the drawn race's colour.
            let cup: String?
            /// What a "?" chip shows: "?" unless the chip says otherwise (the
            /// endless card carries ∞).
            let glyph: String
            var id: Int { index }
        }
    }

    /// `ttp_ui_catalogue_json`'s cup rows: the couch's long game, for the
    /// lobby's "Cups" shelf.
    ///
    /// The progression on each row is DERIVED IN THE ENGINE off the blob
    /// `ttp_ui_progress_load` was handed at boot. Nothing here re-derives a star
    /// threshold or the unlock rule — that is the whole reason the catalogue
    /// carries these fields rather than the raw record.
    ///
    /// Refreshed only where the record can have MOVED (boot and the
    /// `persist-progression` performer), which is the web's rule for the same
    /// shelf (`main.js refreshCupShelf`): the catalogue is otherwise a constant,
    /// and re-reading it per lobby redraw would be a JSON parse per frame for an
    /// answer that cannot have changed.
    @Published var cups: [CupProgress] = []

    struct CupProgress: Identifiable {
        let id: String
        /// The catalogue's full name ("Beach Cup"). The shelf shortens it — see
        /// `CupShelf`, which owns that because it is a presentation choice about
        /// a narrow rail, not a fact about the cup.
        let name: String
        /// Packed 0xRRGGBB, the catalogue's own. Read from the ABI rather than
        /// from `Schematic.cupColor` so the shelf cannot drift from the shipped
        /// table (that copy predates the field and is the same five values).
        let color: UInt32
        /// 0...3.
        let stars: Int
        let locked: Bool
        /// Only meaningful while `locked` — how many cups of the bar are done.
        let unlockDone: Int
        let unlockNeed: Int
    }

    // MARK: - The info board

    /// The lobby's navigation path: the info board and the license pages the
    /// remote can push on top of it.
    ///
    /// **THIS IS THE ONE PIECE OF SCREEN STATE THE MODEL DOES NOT OWN, and it is
    /// allowed to be.** Everything else on this type is a `ttp_*` answer,
    /// because everything else is a decision three shells have to make the same
    /// way. This is not a decision at all: the info board shows the legal pages
    /// and the credits the .ipa's own contents oblige, no phone can reach it,
    /// nothing in the game reacts to it, and the web display has no twin for it
    /// (its footer is a pair of links on a board this platform does not even
    /// have). A rule in `ui_model.cc` for it would have exactly one caller.
    ///
    /// It lives here rather than in the view so that leaving the lobby can clear
    /// it — see `GameCoordinator.show`.
    @Published var infoPath: [InfoRoute] = []

    /// A page pushed on the lobby's stack: the info board, its license list,
    /// then one license's text (by index into `Legal.entries`).
    enum InfoRoute: Hashable {
        case info, licenses
        case license(Int)
    }

    // NO `canStart` HERE, and its absence is the design. The readiness gate is
    // `ttp_ui_all_racers_ready`, and the thing it gates is the HOST'S PHONE —
    // this display re-checks it when a START_GAME arrives (`ttp_race_start_json`
    // asks again) and has nothing of its own to enable. It existed to dim a
    // Start button on the TV, and that button is gone: see `LobbyView`, which
    // spells out why a second road into `startRace` was a duplicate authority
    // rather than a missing affordance.

    // MARK: - Race

    /// One per split-screen cell, in the order `ttp_display_cells` named them,
    /// with the rect the RENDERER letterboxed for that cell.
    @Published var cells: [CellHUD] = []

    struct CellHUD: Identifiable {
        let index: Int
        /// Whose cell this is. Carried so the item slot can find this car's
        /// pickup counter — the slot re-spins on a fresh PICKUP, not on the item
        /// changing, and those differ when a box re-rolls the same id.
        let car: EngineIdentity
        /// Top-left origin, in POINTS. The ABI answers a fraction of the
        /// surface; `DisplayHost.cellRects` multiplies it into the view's own
        /// point bounds.
        ///
        /// The PICTURE: where the renderer drew this cell, and so what anything
        /// CENTRED on the cell centres on.
        let rect: CGRect
        /// The same cell inset by the TV overscan margin on all four edges
        /// (`ttp_display_safe_insets`). Everything anchored to an EDGE is placed
        /// in here instead — a name chip in a corner the set is cropping is a
        /// name chip nobody reads.
        let safeRect: CGRect
        let name: String
        let colorIndex: Int
        /// The car MODEL index — what `--icon-car` paints the monster chip's
        /// cab with (`ItemIcon.carBodyColors`). The MODEL's body tone, not the
        /// livery: the livery (`colorIndex`) only ever paints the name chip.
        let carIndex: Int
        let place: Int
        let lap: Int
        let totalLaps: Int
        /// `TTP_ITEM_*` as a key, or nil for an empty slot. Never shown while
        /// finished.
        let item: String?
        let finished: Bool
        /// nil unless the row is TIMED. A forfeit resolved at the flag is
        /// `finished` with no time, and printing "0.0s" for it would be a lie
        /// the packed block deliberately makes distinguishable.
        let finishTime: Double?
        let reconnecting: Bool
        /// The claim URL this seat's phone should scan to come back. Only set
        /// while `reconnecting`.
        let reconnectURL: String?

        var id: Int { index }
    }

    /// "3" / "2" / "1" / "GO!" / nil.
    @Published var countdown: String?
    @Published var paused = false
    @Published var pauseButtonShown = false

    /// The CC-BY attribution for the playing song. This is a LICENSING
    /// obligation, not chrome: the catalogue is Kevin MacLeod's under CC-BY and
    /// a shell that plays it owes a visible credit.
    @Published var musicCredit: MusicCredit?

    /// The BOOST item icon's chevron accent, for the biome the current scene
    /// resolved to. `ttp_theme_boost_icon(biome)` answers it, and it is one of
    /// exactly two colours `biomes.js` says a shell may ask the theme for — the
    /// other being the music gallery's swatch. Wanting a third means the look is
    /// being rebuilt in the UI layer instead of by the renderer.
    ///
    /// Kept as the ABI's own 0xRRGGBB rather than a `Color`: what consumes it
    /// is `ItemIcon`'s `--icon-accent` SUBSTITUTION into the shared SVG, which
    /// needs the hex back out. Defaulted to the SVG's own fallback so a slot
    /// drawn before any scene exists is the pre-theme teal rather than clear.
    @Published var boostAccent: UInt32 = ItemIcon.defaultAccent

    struct MusicCredit {
        let title: String
        let artist: String
        let license: String
        let source: String
    }

    // MARK: - Results

    /// `ttp_ui_results_view_json`. The same board goes on the wire to the phones
    /// (`ttp_ui_standings_json`), so the TV and the phones can never tell
    /// different stories.
    @Published var results: ResultsView?

    struct ResultsView: Equatable {
        let podium: Bool
        let intermission: Bool
        let titleKey: String        // -> Copy.title (phase 2, or the only phase)
        /// Phase 1's title. A cup board opens on the race it just ran, so it
        /// wears the plain "Results" head until the standings arrive.
        let raceTitleKey: String
        let cupName: String?
        let sub: Sub?
        /// **A CUP BOARD IS TWO PHASES** (`ttp_ui.h`). [raceRows] is who won the
        /// RACE, in finishing order with lap times, and it holds for
        /// [racePhaseMs]; then it becomes [listRows], the cup table it rewrote,
        /// in standings order with points. A shell that paints only listRows
        /// states the delta and never shows the change.
        let twoPhase: Bool
        let racePhaseMs: Double
        let raceRows: [Row]
        let listRows: [Row]
        let next: Next?
        let newGameKey: String      // -> Copy.newGame

        struct Sub: Equatable { let key: String; let cupName: String; let race: Int; let of: Int? }
        /// `secs` is what the model emits, and it is a SNAPSHOT taken when the
        /// board was composed. The live number comes from
        /// `ttp_ui_intermission_secs` on the coordinator's 500 ms ticker, so a
        /// stalled frame or a suspended app cannot drift it away from the
        /// deadline the phones were told.
        struct Next: Equatable { let trackName: String; let secs: Int }

        /// One board row, exactly as `rowValue` emits it.
        ///
        /// Note what is NOT here: no `place` and no `dnf`. The model does not
        /// send either — rank is the row's POSITION (which is why the podium's
        /// offset matters), and "did not finish" is `finished == false`. A
        /// decoder that invented those two fields would be re-deriving the
        /// model's answer in Swift.
        struct Row: Identifiable, Equatable {
            /// `playerId`, kept as the identity's JSON so it is stable across
            /// re-decodes of the same board.
            let id: String
            let name: String
            let ai: Bool
            let colorIndex: Int
            let finished: Bool
            let time: Double?
            /// A seat that joined mid-race and races next. Such a row carries
            /// NOTHING ELSE — `rowValue` returns early — so every other field
            /// here is its neutral value, by the model's design.
            let joining: Bool
            let points: Int?
            let gained: Int?
            /// What this row's total stood at BEFORE the race scored it, so the
            /// number can climb to `points` rather than jump. The model sends it
            /// precisely so **no shell subtracts `gained` for itself**.
            let pointsBefore: Int?
            /// 1|2|3 on the cup podium's top three. Absent in phase 1 — the
            /// medals are the CUP's, and phase 1 has not told it yet.
            let medal: Int?
            /// `time` | `time_gain` | `points` | `joining` — which trailing
            /// cells this row wants (`ui_model.cc`).
            let kind: String?
        }
    }

    /// Seconds left on the intermission, re-read from `ttp_ui_intermission_secs`
    /// every 500 ms rather than counted down locally.
    @Published var intermissionSecs: Int?

    // MARK: - Diagnostics

    /// Bumped every time a car takes a FRESH pickup, keyed by identity.
    ///
    /// The item slot re-spins its slot machine even when the new item is the
    /// same id as the old one, so "did the item change" is not the trigger — a
    /// pickup is. The model decides when one happened (`item-pickup`); this is
    /// the counter the HUD animates off.
    @Published var itemPickupTick: [EngineIdentity: Int] = [:]

    /// The last thing that went wrong, and the ONLY channel this app has for
    /// saying so.
    ///
    /// It prints as well as publishing, and that is not debug scaffolding: a TV
    /// has no console, no devtools and no way for a viewer to report anything but
    /// "the screen is black". Every failure path in this shell is a silent one by
    /// construction — a missing material degrades quietly, a rejected scene build
    /// leaves the previous frame up — so the one place they converge has to be
    /// audible in `devicectl --console`.
    @Published var lastError: String? {
        didSet { if let lastError { print("[ttp] \(lastError)") } }
    }
}

// MARK: - Decoding the model's answers
//
// Every initializer below reads a JSON object a `ttp_ui_*` call produced. They
// are transcription only: no field is computed, defaulted to something the model
// did not say, or renamed. A missing key becomes the type's neutral value so a
// partial answer renders as an incomplete screen rather than a crash, which is
// the same tolerance the web's destructuring has.

extension GameState.Seat {
    init?(_ json: Any, index: Int) {
        guard let d = json as? [String: Any] else { return nil }
        // `open` is the model's own word for a padded placeholder; everything
        // else on the record is absent when it is true.
        self.init(index: index,
                  open: d["open"] as? Bool ?? false,
                  name: d["name"] as? String ?? "",
                  colorIndex: Int(d["colorIndex"] as? Double ?? 0),
                  carIndex: Int(d["carIndex"] as? Double ?? 0),
                  modelIndex: Int(d["modelIndex"] as? Double ?? 0),
                  off: d["off"] as? Bool ?? false,
                  host: d["host"] as? Bool ?? false,
                  ready: d["ready"] as? Bool ?? false)
    }

    /// The seat as `ttp_ui_seat_grid_json` wants it back — the padding rule is
    /// the model's, so a shell that wants a padded grid hands its seats over
    /// rather than padding them itself.
    var wire: [String: Any] {
        open
            ? ["open": true]
            : ["open": false, "name": name, "colorIndex": colorIndex, "carIndex": carIndex,
               // `connected`, NOT `off`. The grid model TAKES a roster row and
               // DERIVES the dimming from it (ttp_ui.h: roster_seats answers
               // `connected`, seat_grid answers `off`) — so sending `off` sends a
               // key it does not read, leaves `connected` absent, and every seat
               // comes back dimmed.
               //
               // Nothing on the shipping path noticed because it does not use
               // this: the live lobby pipes roster_seats straight into seat_grid,
               // and only the screenshot harness re-encodes its own seats. So the
               // cost was that every lobby and results photograph this shell has
               // ever taken showed the whole dock at 50% — the gallery, which
               // exists to verify the look, quietly misrepresenting it.
               "connected": !off,
               "modelIndex": modelIndex, "host": host, "ready": ready]
    }
}

extension GameState.CupSlot {
    init?(_ d: [String: Any]) {
        guard !d.isEmpty else { return nil }
        let maps = (d["maps"] as? [[String: Any]] ?? []).enumerated().map { i, m in
            Map(index: i,
                // Null/absent is an UNDRAWN race, and it must stay nil: an
                // empty-string id would ask SchematicMap for a track that
                // does not exist instead of drawing the "?" chip.
                trackId: (m["trackId"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                // 0 stands in for absent (the web tests `m.n != null`): a cup
                // numbers its maps 1...4, nothing else numbers anything, and
                // the old i+1 default here badged "1" onto single-map cards
                // the web leaves bare.
                n: Int(m["n"] as? Double ?? 0),
                cup: m["cup"] as? String,
                glyph: "?")
        }
        self.init(nameKey: d["nameKey"] as? String ?? "",
                  name: d["name"] as? String,
                  racesKey: d["racesKey"] as? String ?? "",
                  raceCount: Int(d["raceCount"] as? Double ?? 0),
                  // nil and 0 are different: nil hides the whole meter, 0 would
                  // draw four unlit pips.
                  difficulty: (d["difficulty"] as? Double).map { Int($0) },
                  maps: maps,
                  cupId: d["cupId"] as? String)
    }

    /// The web's random veil (`renderLobbyPick`) and its "?" padding
    /// (`renderCupSlot`), folded — this shell has one consumer where the web
    /// splits the card renderer out for the gallery preview.
    ///
    /// RANDOM SPOILS NOTHING: a counted card is `raceCount` grey "?" boxes,
    /// endless one grey ∞ box — even the drawn race 1 is not the card's to
    /// sell. The veil lives HERE rather than in the model because the frozen
    /// ui corpus pins cupSlot's random answers to the drawn chip. RANDOM
    /// ONLY: a cup's racesKey is 'count' too, and a cup card must never pad —
    /// its chips are the model's, "?" placeholders (the tour) included.
    func veiled() -> GameState.CupSlot {
        guard nameKey == "random" else { return self }
        let veil: [Map] = racesKey == "endless"
            ? [Map(index: 0, trackId: nil, n: 0, cup: nil, glyph: "∞")]
            : (0..<max(raceCount, 0)).map { Map(index: $0, trackId: nil, n: 0, cup: nil, glyph: "?") }
        return GameState.CupSlot(nameKey: nameKey, name: name, racesKey: racesKey,
                                 raceCount: raceCount, difficulty: difficulty,
                                 maps: veil, cupId: cupId)
    }
}

extension GameState.CupProgress {
    /// One row of the catalogue's `cups` array.
    ///
    /// `unlockDone`/`unlockNeed` are only emitted on a LOCKED row, so both
    /// default to 0 — the shelf reads them only under `locked` anyway, and an
    /// optional pair would make every call site spell that rule again.
    init(_ d: [String: Any]) {
        self.init(id: d["id"] as? String ?? "",
                  name: d["name"] as? String ?? "",
                  color: UInt32(d["color"] as? Double ?? 0),
                  stars: Int(d["stars"] as? Double ?? 0),
                  locked: d["locked"] as? Bool ?? false,
                  unlockDone: Int(d["unlockDone"] as? Double ?? 0),
                  unlockNeed: Int(d["unlockNeed"] as? Double ?? 0))
    }
}

extension GameState.ResultsView {
    init?(_ d: [String: Any]) {
        guard !d.isEmpty else { return nil }
        let sub = (d["sub"] as? [String: Any]).map {
            Sub(key: $0["key"] as? String ?? "",
                cupName: $0["cupName"] as? String ?? "",
                race: Int($0["race"] as? Double ?? 0),
                of: ($0["of"] as? Double).map { Int($0) })
        }
        let next = (d["next"] as? [String: Any]).map {
            Next(trackName: $0["trackName"] as? String ?? "",
                 secs: Int($0["secs"] as? Double ?? 0))
        }
        self.init(podium: d["podium"] as? Bool ?? false,
                  intermission: d["intermission"] as? Bool ?? false,
                  titleKey: d["titleKey"] as? String ?? "",
                  raceTitleKey: d["raceTitleKey"] as? String ?? "",
                  cupName: d["cupName"] as? String,
                  sub: sub,
                  twoPhase: d["twoPhase"] as? Bool ?? false,
                  racePhaseMs: d["racePhaseMs"] as? Double ?? 0,
                  // `raceRows`, NOT `podiumRows` — read `ttp_ui.h`, never a
                  // sibling shell's transcription of it. A key this ABI does not
                  // answer decodes to an EMPTY LIST rather than to an error, so
                  // the board it feeds is simply a phase short and says nothing.
                  raceRows: (d["raceRows"] as? [Any] ?? []).compactMap(Row.init),
                  listRows: (d["listRows"] as? [Any] ?? []).compactMap(Row.init),
                  next: next,
                  newGameKey: d["newGameKey"] as? String ?? "")
    }
}

extension GameState.ResultsView.Row {
    init?(_ json: Any) {
        guard let d = json as? [String: Any] else { return nil }
        // `playerId`, not `id`. Falling back to the name keeps a row
        // identifiable for SwiftUI even if the model ever omitted it; a fresh
        // UUID would make every re-decode a new row and re-animate the board.
        let identity = EngineIdentity.from(d["playerId"])?.json
        self.init(id: identity ?? (d["name"] as? String ?? UUID().uuidString),
                  name: d["name"] as? String ?? "",
                  ai: d["ai"] as? Bool ?? false,
                  colorIndex: Int(d["colorIndex"] as? Double ?? 0),
                  finished: d["finished"] as? Bool ?? false,
                  // `time` is explicitly null for a car that did not finish, so
                  // nil here IS the DNF signal — there is no separate flag.
                  time: d["time"] as? Double,
                  joining: d["joining"] as? Bool ?? false,
                  points: (d["points"] as? Double).map { Int($0) },
                  gained: (d["gained"] as? Double).map { Int($0) },
                  pointsBefore: (d["pointsBefore"] as? Double).map { Int($0) },
                  medal: (d["medal"] as? Double).map { Int($0) },
                  kind: d["kind"] as? String)
    }
}
