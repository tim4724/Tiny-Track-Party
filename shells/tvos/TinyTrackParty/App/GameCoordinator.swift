import Foundation
import SwiftUI

/// The one object that owns the game on this platform: it boots the engine,
/// wires the four systems (display, net, audio, assets) to each other, and
/// performs what C++ decided.
///
/// It is the Swift counterpart of `public/display/main.js`, minus everything
/// that file no longer decides. The screen rules, the seat grid, the readiness
/// rule, the race orchestration, the pause arbitration and the results board are
/// all `libttp-runtime`; what is left here is boot order, timers, and turning an
/// answer into a `GameState` property or an ABI call.
///
/// If you find yourself writing an `if` about the game in this file, check
/// `ttp_ui.h` first. The rule is not stylistic: a rule written here is a rule
/// the Android shell has to find and reimplement, and one written in C++ is
/// covered by a corpus on four legs.
@MainActor
final class GameCoordinator: ObservableObject {

    // MARK: - The observable half

    let state = GameState()

    // MARK: - Systems

    let display: DisplayHost
    let net: PartyNet
    let audio: AudioDevice
    let assets: AssetStore
    let proto: GameProtocol
    let lobbyDemo: LobbyDemo
    let advertiser = RoomAdvertiser()

    lazy var performer = RaceFlowPerformer(game: self)

    // MARK: - Shell state the model threads but does not hold
    //
    // `ttp_race.h`'s shell-owned inputs, and only those. The series, the
    // launched field, the shuffle bag AND the race seed all ride the walks now
    // — nothing about a race roster or launch is mirrored here.

    /// What each phone was last told its item was — a String, or NSNull for an
    /// explicitly-cleared slot. The model gates the push
    /// (`ttp_ui_item_pushes_live_json`); this is the memory the gate reads, and
    /// null-vs-absent is a real distinction there, not a style choice.
    var lastItem: [EngineIdentity: Any] = [:]
    /// Which reconnect cards actually attached, so the diff has a previous.
    var shownReconnectIds: Set<EngineIdentity> = []
    var sceneCars: [SceneCar] = []
    /// The claim URL each reconnecting seat's card shows. Composed in C++
    /// (`ttp_net_claim_url`); only the QR bitmap is per-platform.
    var reconnectURLs: [EngineIdentity: String] = [:]

    var sessionHandle: Int32 = 0
    var autoPaused = false
    var raceEnded = false
    /// Is the scene build a launch just asked for still in flight? The countdown
    /// gate's one shell-side fact — see `rebuildScene`, which owns both edges.
    var sceneBuildPending = false
    /// The launch effects a scene build stands between (`ttp_race.h`'s countdown
    /// gate): the held-back `start-countdown` plus the moment the walk ran, which
    /// is what the rule's backstop is measured from. Nil when nothing waits.
    var pendingCountdown: (effects: [Any], at: Double)?

    /// True only inside the AI fast-forward burst. Read by the race-event
    /// dispatch, which must not spawn visuals for a race that is being SKIPPED
    /// rather than watched.
    var fastForwarding = false

    /// Whether the app is off screen with its party wound up. Guards `suspend`
    /// and `resume` against being run twice: tvOS delivers `.inactive` between
    /// `.active` and `.background` in both directions, so an unguarded pair
    /// would close a room it had just opened.
    var suspended = false

    /// The stored lobby pick, read where the walks keep it (`ttp_net_pick_json`
    /// behind the room handle). One crossing per ask, at button-press frequency;
    /// the mirror two shells used to carry is gone, so there is nothing to
    /// drift. The walks are its only writers — the host's SELECT_MODE, the
    /// harness's `applyPick`, and the race flow's `set-track` swaps. Boot
    /// writes nothing here: the lobby PREVIEWS a circuit without picking.
    var pick: ModePick { ModePick(TTP.obj(ttp_net_pick_json(net.roomHandle))) }

    /// The circuit the next race builds and the current scene shows. Held here
    /// rather than read back from the display, because the pick exists before a
    /// scene does (the lobby names a track, then stages it).
    var trackId: String = ""
    /// Laps per race — the manifest's `TOTAL_LAPS`, assigned at boot. The `3`
    /// is only the value before `boot()` runs, never what a race launches with.
    var laps: Int32 = 3

    var resultsFailsafe: Task<Void, Never>?
    var intermissionTask: Task<Void, Never>?
    var intermissionTicker: Task<Void, Never>?
    var intermissionDeadline: Double = 0

    // MARK: - Boot

    init(baseURL: URL) {
        assets = AssetStore(baseURL: baseURL)
        proto = GameProtocol.load(baseURL: baseURL)
        display = DisplayHost()
        net = PartyNet(proto: proto, socket: RelaySocket())
        audio = AudioDevice(baseURL: baseURL) { [weak assets] path in assets?.bundled(path) }
        lobbyDemo = LobbyDemo()
    }

    /// A `ttp_*` call that reported failure, with the ENGINE's reason.
    ///
    /// `ttp_last_error()` carries why the last instrumented call refused (see
    /// ttp_error.h for the six that populate it, and why each clears on entry).
    /// Composing a message here instead would be guessing: "configure failed"
    /// cannot say whether the JSON was malformed or a field was missing, because
    /// this side was never told.
    ///
    /// A TV has no console, so this goes to `lastError`, which prints.
    @discardableResult
    func requireOK(_ ok: Bool, _ what: String) -> Bool {
        guard !ok else { return true }
        let why = TTP.strOrEmpty(ttp_last_error())
        state.lastError = why.isEmpty ? "\(what) (the engine gave no reason)" : "\(what): \(why)"
        return false
    }

    /// The boot order is `ttp_race.h` / `ttp_ui.h`'s, not a preference. Configure
    /// before you ask, and read the catalogue back rather than shipping a copy of
    /// it: `ttp_ui_configure` with no `cups`/`catalog` installs the world this
    /// BUILD ships, so the track names and the cup list come out of the wasm
    /// that already holds them.
    func boot() async {
        // Tokens.load() is NOT here: SwiftUI evaluates the first view body before
        // this task runs, so the palette has to be up before the App's body ever
        // does. TinyTrackPartyApp.init() owns it.

        _ = TTP.str(ttp_version())
        _ = TTP.str(ttp_party_version())

        // The manifest's, not a constant of ours: TOTAL_LAPS is a number two
        // layers share, and re-declaring it here is the drift the manifest rule
        // exists to stop.
        laps = Int32(proto.totalLaps)

        // The two field sizes, and nothing else: passing no catalogue is what
        // asks for the shipped one.
        //
        // CHECKED, not discarded. These three ran as `_ = …` and a boot with a
        // malformed payload carried on into a game with no catalogue, no field
        // rules and no chooser — every symptom of which appears somewhere else
        // entirely.
        requireOK(ttp_ui_configure(TTP.json([
            "maxPlayers": proto.maxPlayers,
            "carCount": proto.carModels.count
        ])) != 0, "configuring the UI model")
        // The couch's progression record, BEFORE the catalogue is read: stars,
        // the Playroom lock and the unlock counts come out stamped on it.
        // The shell persists the blob and decides nothing about it (the web's
        // rule, NativeUiModel.js) — nothing stored loads a fresh couch.
        _ = ttp_ui_progress_load(UserDefaults.standard.string(forKey: Self.progressKey), 0)
        let catalogue = TTP.obj(ttp_ui_catalogue_json())
        // The lobby's shelf, from the catalogue that was just stamped with the
        // record above. A fresh couch is five zero-star rows and a locked
        // Playroom, which is a shelf worth drawing — it states the goal.
        refreshCupShelf(catalogue)
        // The mini-map field tints, off the same rows. Still authored values, but
        // the catalogue is where they are authoritative — see `Schematic.cupColor`,
        // which used to keep a hand-copied second spelling of the five.
        Schematic.installCupColors(catalogue["cups"] as? [[String: Any]] ?? [])

        // No `personas` key: absent asks for libttp-sim's own table (the single
        // source), so boot hands over nothing it read back.
        requireOK(ttp_race_configure(TTP.json([
            "fieldSize": proto.fieldSize,
            "carCount": proto.carModels.count,
            "colorCount": proto.carColors.count,
            "aiPrefix": "ai-",
            "carStats": proto.carStats,
            "cups": catalogue["cups"] ?? []
        ])) != 0, "configuring the race layer")

        // The boot proof the web shell runs at load: every op the race walks can
        // emit has a performer arm (a race answer may also carry net-vocabulary
        // ops, which fall through to PartyNet's switch). A port that grew a new
        // op fails HERE instead of dropping a step mid-race.
        let unperformable = TTP.arr(ttp_race_effect_ops_json())
            .compactMap { $0 as? String }
            .filter { !RaceFlowPerformer.performable.contains($0) }
        if !unperformable.isEmpty {
            requireOK(false, "race effect ops with no performer: \(unperformable.joined(separator: ", "))")
        }

        // The chooser payload the phones pick from. Set ONCE, and rides the
        // LOBBY snapshot only.
        //
        // ITS SHAPE IS A WIRE CONTRACT WITH THE PHONE, AND NOTHING HERE CHECKS
        // IT. `ttp_net_configure` takes this blob OPAQUELY — the session model
        // knows exactly one thing about it, that `tracks` ride the lobby
        // snapshot — so a wrong key name travels the whole way to the handset
        // with no error at any layer. It is not in the protocol manifest, no
        // corpus covers it (the frozen session corpus carries a synthetic
        // world), and `abi_check` cannot see it either. The ONLY reader is
        // `public/controller/main.js`, and phones stay on that JS controller on
        // all three TV platforms, so its field names are the specification:
        //
        //   cars   [{id, name, stats:{accel,vmax,turn,mass}}]  (line 98)
        //   tracks [{id, name, svg, cup, cupName, cupDifficulty}]  (line 97)
        //
        // This shell shipped `cars` as bare model-id STRINGS and spelled the
        // packed map `p` and the difficulty `level`, which is why a scanned
        // phone drew a car picker with no images, a track list with no maps and
        // no cup selector at all — the controller read `t.svg` and `t.cup` off
        // records that had neither. `Start race` then did nothing because it
        // stays disabled until a pick resolves a trackId, and nothing was
        // pickable. Four symptoms, one shape.
        requireOK(ttp_net_configure(TTP.json([
            "cars": chooserCars(),
            "colors": proto.carColors,
            "tracks": chooserTracks(catalogue),
            // The couch's stars/lock for the phones' picker — composed AFTER
            // the progression load above, so a returning couch's first
            // snapshot already carries its record. The one chooser key that
            // changes at RUNTIME: persistProgression recomposes it.
            "progress": progressChooser()
        ])) != 0, "configuring the chooser payload")

        // THE CAMERA RIG FOR A SURFACE WITH NO CELLS, pushed once and never
        // again: with cells the renderer runs a chase cam per cell and this is
        // ignored, without them it is the whole picture.
        //
        // `TTP_CAM_BBOX` is the lobby's perimeter sweep — an ellipse hugging the
        // track's own bounding box, so a long circuit is toured lengthways
        // rather than circled at arm's length. It is what the web asks for at
        // boot (`scene.orbit = true; scene.bboxOrbit = true`, main.js), and the
        // ABI's default is `TTP_CAM_STILL`: a shell that never calls this gets
        // the fitted iso view HELD MOTIONLESS, which looks exactly like a
        // correct render of a track and is why nobody spotted the lobby preview
        // was a photograph for the whole of the port.
        display.camera(TTP_CAM_BBOX)

        // The frame-cost readout, ON — and the THREE SHELLS DO NOT AGREE about
        // that, which is worth knowing before copying any of them. The web's
        // PerfHud constructs HIDDEN and is shown by the "P" key; Android shows
        // it at boot in release too, and argues for that in the render-scale
        // commit (a bug invisible on the shipping build is a bug you cannot
        // find). This shell has always shown it, and every race shot in its
        // gallery column carries the panel because of it.
        //
        // It instruments nothing while hidden, so switching it off is this one
        // line — which is the decision to make before a build reaches a player,
        // on this shell and on Android both.
        display.perf.show()

        // LET THE BOARD PAINT BEFORE THE HEAVY WORK, which is the only thing in
        // this function that is not a call into the engine.
        //
        // This method is `async` and, until here, never suspended once: every
        // line above and below runs to completion on the MAIN ACTOR. SwiftUI
        // therefore cannot lay out or draw anything between `.task` starting and
        // `boot()` returning — so whatever the FIRST layout pass produced is what
        // stands on the television for the whole of staging, the track build and
        // the relay dial. `PaperStage` places its sky, hills and grass band as
        // fractions of `geo.size`, so an unsettled first box puts the horizon at
        // the wrong height and then holds it there, which is what "the initial
        // background is the wrong shape" is.
        //
        // A suspension point is all it takes: the main actor drains, layout and
        // the CoreAnimation commit run, and the board on screen is the settled
        // one. It does NOT make the work below cheaper or move it off the main
        // thread — the engine calls have to stay here — it only stops the first
        // frame being held hostage by them.
        await Task.yield()

        do {
            try SceneStaging.materials(into: display, from: assets)
        } catch {
            state.lastError = "materials: \(error)"
        }

        try? audio.start()
        wireNet()

        // The room warms eagerly, and on THIS platform there is no board in
        // front of it: the app opens on the lobby.
        //
        // The web's welcome screen is not a design element, it is a BROWSER
        // WORKAROUND — the NEW GAME press is the user gesture that unlocks an
        // AudioContext and enters fullscreen, neither of which a TV app needs.
        // Keeping it here would put one remote press between the viewer and the
        // room code, for nothing. So the lobby is this shell's root, which is
        // also why Menu on it belongs to tvOS (see RootView.backAction).
        //
        // The board stands up before the room answers and simply shows open
        // seats until it does — which is exactly the web's own `lobby-empty`
        // state, not a special case.
        // THE SCREEN FIRST, then the preview. `previewLastCircuit` ends by
        // asking the attract demo to stand up, and the demo only runs while the
        // lobby is the current screen — previewing before `show` left the
        // backdrop lifted and NO scene ever built behind it.
        show(.lobby)
        // The second paint barrier, for the reason the first one states: the
        // lobby has just become the current screen and `previewLastCircuit` runs
        // the whole track build behind it, so without a suspension here the board
        // a viewer waits on is the one drawn before `show`, not the one it names.
        await Task.yield()
        previewLastCircuit()
        // NO RELAY UNDER A SCENARIO — the web's gallery pages are no-relay
        // surfaces for the same reason. The screenshot scenarios fabricate
        // their inputs (a scripted roster, a fake join ticket), so a live room
        // under them is not harmless background: the 1 Hz liveness sweep sees
        // four "players" who never ping, drops them one by one, and every race
        // photograph is of an emptying field. That was found from the shots
        // themselves — the launch stood up 4 cells and the picture showed none.
        if Scenarios.requested == nil { net.start() }
    }

    /// `localStorage`'s key on the web (`main.js`'s LAST_TRACK_KEY);
    /// UserDefaults carries it here.
    static let lastTrackKey = "tinytrack_last_track"

    /// What the lobby shows before anybody has picked anything: the last
    /// party's circuit, previewed under the attract race from the first frame.
    ///
    /// A PREVIEW, NEVER A PICK — the web's boot-time attract exactly
    /// (`main.js`, LAST_TRACK_KEY): the room pick stays null, so Start stays
    /// gated until the host's phone picks and the phones' picker opens on its
    /// own default (the 🎲 tile's World Tour). This replaces the seeded random
    /// pick this shell used to make; that seed existed because the web's lobby
    /// had no idle state to copy, and the web growing one took the rationale
    /// with it. The fallback is the catalogue's first track — the easy cup's
    /// race 1.
    private func previewLastCircuit() {
        let tracks = TTP.obj(ttp_ui_catalogue_json())["catalog"] as? [[String: Any]] ?? []
        let ids = tracks.compactMap { $0["id"] as? String }
        guard !ids.isEmpty else { return }
        let last = UserDefaults.standard.string(forKey: Self.lastTrackKey)
        // `setTrack` stages the scene; the lobby render below stands the
        // attract demo up on it, the way a join would.
        setTrack(last.flatMap { ids.contains($0) ? $0 : nil } ?? ids[0])
        refreshLobby()
    }

    /// Where the couch's progression blob persists (localStorage's peer).
    static let progressKey = "ttpProgress"

    /// The chooser's `progress` key, `boot.js progressChooser`'s shape: the
    /// per-cup stars and locks the phones' picker draws. Composition only —
    /// every number was derived inside the engine, off the stamped catalogue.
    func progressChooser() -> [String: Any] {
        let cups = TTP.obj(ttp_ui_catalogue_json())["cups"] as? [[String: Any]] ?? []
        return ["cups": cups.map { c -> [String: Any] in
            var e: [String: Any] = ["id": c["id"] ?? "",
                                    "stars": c["stars"] ?? 0,
                                    "locked": c["locked"] ?? false]
            if (c["locked"] as? Bool) == true {
                e["unlockDone"] = c["unlockDone"] ?? 0
                e["unlockNeed"] = c["unlockNeed"] ?? 0
            }
            return e
        }]
    }

    /// The lobby's "Cups" shelf, off the SAME stamped catalogue the chooser is
    /// composed from — so the television and the phones cannot disagree about
    /// how many stars the couch has.
    ///
    /// Takes the parsed catalogue rather than re-reading it: both callers have
    /// already paid for that parse, and this is the web's `refreshCupShelf`
    /// called at exactly its two points — boot, and the persist performer.
    func refreshCupShelf(_ catalogue: [String: Any]) {
        state.cups = (catalogue["cups"] as? [[String: Any]] ?? []).map(GameState.CupProgress.init)
    }

    /// `persist-progression`: the walk banked a finished cup's stars; the shell
    /// writes the blob it was handed and recomposes the snapshot's progress
    /// chooser, so the phones' pickers carry the new stars when the party is
    /// back in the lobby (the web's performer, main.js, does the same two).
    func persistProgression(_ progress: Any?) {
        if let p = progress {
            UserDefaults.standard.set(TTP.json(p), forKey: Self.progressKey)
        }
        // The web's setChooser: the same configure, recomposed, republished.
        // The catalogue is re-read because the BANK moved it — `ttp_ui_progress_load`
        // holds the record inside the engine and every star on these rows is
        // derived from it, so this is the one place the answer actually changes.
        let catalogue = TTP.obj(ttp_ui_catalogue_json())
        refreshCupShelf(catalogue)
        requireOK(ttp_net_configure(TTP.json([
            "cars": chooserCars(),
            "colors": proto.carColors,
            "tracks": chooserTracks(catalogue),
            "progress": progressChooser()
        ])) != 0, "recomposing the chooser after a banked cup")
        net.publishSnapshot()
    }

    /// The chooser's car list, as the phone's picker reads it: an id to load the
    /// image by, a name, and the four handling stats the picker bars show.
    ///
    /// The images are NOT bundled here and must not be — the controller loads
    /// them by id from the web host it was itself served from, so this list
    /// carries identifiers, never pixels.
    private func chooserCars() -> [[String: Any]] {
        proto.carModels.enumerated().map { i, id in
            let s = i < proto.carStats.count ? proto.carStats[i] : [:]
            return [
                "id": id,
                "name": i < proto.carNames.count ? proto.carNames[i] : id,
                // Exactly these four. The manifest's CAR_STATS also carries the
                // collision half-extents, which are the SIM's business and mean
                // nothing on a picker bar.
                "stats": [
                    "accel": s["accel"] ?? 0,
                    "vmax": s["vmax"] ?? 0,
                    "turn": s["turn"] ?? 0,
                    "mass": s["mass"] ?? 0
                ]
            ]
        }
    }

    /// The chooser's track list: what the phone draws a mini-map from, and what
    /// it groups into cups.
    ///
    /// The pack is native (`ttp_schematic_pack` over `ttp_track_schematic_json`),
    /// so this shell holds no projection — the web reads a prebaked table
    /// instead, but both run the same C++ over the same track, so the maps agree.
    ///
    /// `cup` and `cupName` are load-bearing rather than decoration: the phone's
    /// mode picker IS `trackCatalog.find((t) => t.cup)`, so a list without them
    /// offers single races only and the cup selector never appears.
    private func chooserTracks(_ catalogue: [String: Any]) -> [[String: Any]] {
        // `catalog`, not `tracks`. That is the key `ttp_ui_configure` takes and
        // therefore the key the catalogue answers with — reading the wrong one
        // yields an empty list, and an empty list is a lobby with no track to
        // race and no error anywhere.
        let cupNames = (catalogue["cups"] as? [[String: Any]] ?? []).reduce(into: [String: String]()) {
            if let id = $1["id"] as? String { $0[id] = $1["name"] as? String ?? id }
        }
        return (catalogue["catalog"] as? [[String: Any]] ?? []).compactMap { t in
            guard let id = t["id"] as? String else { return nil }
            // laps/seed only stamp the built track and no geometry depends on
            // them; 3/1 is the convention every other caller uses.
            let schematic = TTP.obj(ttp_track_schematic_json(id, 3, 1))
            // eps 0 asks for the TUNED default (0.35), chosen so straights
            // reproduce and corners do not clip. Passing a number here overrides
            // that tuning — this shell used to send 0.6 and drew coarser maps
            // than the web for no reason anyone had decided.
            let packed = TTP.str(ttp_schematic_pack(schematic["d"] as? String ?? "", 0))
            let cup = t["cup"] as? String
            return [
                "id": id,
                "name": t["name"] as? String ?? id,
                "svg": packed ?? "",
                "cup": cup.map { $0 as Any } ?? NSNull(),
                "cupName": cup.flatMap { cupNames[$0] }.map { $0 as Any } ?? NSNull(),
                "cupDifficulty": t["cupDifficulty"] as? Int ?? 0
            ]
        }
    }

    // MARK: - Screens

    func show(_ screen: GameState.Screen) {
        guard state.screen != screen else { return }
        state.screen = screen
        // The info board is pushed on the LOBBY's stack, so leaving the lobby
        // takes it down with the board it stands on. Without this the path
        // outlives the stack that owned it, and the next return to the lobby
        // re-inserts a stack that already has pages on it — which either
        // photographs as a legal page over a fresh party or gets silently reset
        // by SwiftUI as it attaches. A race starting under the info board is the
        // live case: any phone can start one while the remote is reading.
        if screen != .lobby { state.infoPath = [] }
        refreshBackdrop()
    }

    /// Paper, or the live 3D behind it.
    ///
    /// The rule is the web's `backdropShow3D()` and it has THREE clauses, in
    /// this order: never before the surface has painted, never over the welcome
    /// board, and in the LOBBY only once a track is actually picked.
    ///
    /// Both of the last two were learned the same way. This shell had
    /// `screen != .welcome` alone, so a fresh lobby — the FIRST thing a viewer
    /// sees — showed the 3D surface with no scene built on it: a black screen
    /// where the web shows the warm paper diorama. Adding the pick clause fixed
    /// the empty lobby and left the BOOT, because a picked track is not a drawn
    /// one. `previewLastCircuit` sets the id, the build runs, and for the frames
    /// between them the paper was fading off an undrawn Metal layer — the flash
    /// on every launch. `hasPainted` is the web's `sceneReady`, which exists for
    /// precisely this and is why its reveal waits two frames into the loop.
    ///
    /// It has to be re-evaluated on a PICK as well as on a screen change, which
    /// is why this is a function and not a line inside `show`: the track can
    /// arrive from a phone long after the lobby is already up. And on the first
    /// PAINT, which is `DisplayHost.onFirstPaint` — at boot the pick lands long
    /// before the pixels do, so nothing else would ever re-ask.
    func refreshBackdrop() {
        let racing = net.roomState != "lobby"
        state.sceneVisible = display.hasPainted
            && state.screen != .welcome && (!trackId.isEmpty || racing)
    }

    /// The landing after the room itself died under us — host `close_room`
    /// never fires here (this shell has no UI road to it: Menu at the lobby
    /// root belongs to tvOS), so the callers are the relay's hostless grace and
    /// a dead-socket fallback. `PartyNet` has already self-healed into a fresh
    /// room by the time this runs; the display's job is the boot landing again:
    /// the lobby previewing the remembered circuit, so the attract demo stands
    /// up exactly as a launch would stand it up (the race card stays down until
    /// the fresh party's host picks). Landing on `.welcome` instead is how this
    /// shell once wedged — that screen pins the backdrop down and nothing after
    /// `boot()` ever showed the lobby again.
    func landOnFreshLobby() {
        show(.lobby)
        previewLastCircuit()
    }

    // MARK: - App lifecycle

    /// The app left the screen, and on this platform that IS the party ending.
    ///
    /// It is the web's `pagehide` rule, and it has to be wired to SOMETHING here
    /// or it is not a rule at all: `PartyNet.shutdown()` shipped fully written,
    /// documented as running "on termination", and called by nothing. The room
    /// therefore outlived the app every time, and the consequences are not
    /// subtle — a phone still holding the old code sits on a dead party until
    /// the relay's ~2 min hostless grace closes it with a 4001, which is exactly
    /// the "that race has ended" board a viewer sees after scanning what they
    /// believe is a fresh QR.
    ///
    /// BACKGROUND, NOT TERMINATE, is the hook. tvOS suspends a backgrounded app
    /// and may kill it later without ever delivering `willTerminate`, so a
    /// termination hook alone would miss the ordinary case (the viewer presses
    /// Home). The socket dies on suspension either way — the only choice is
    /// whether the relay is TOLD, and telling it is what turns a two-minute
    /// zombie into an immediate, honest "party over" on every phone.
    func suspend() {
        guard !suspended else { return }
        suspended = true
        lobbyDemo.stop()
        net.shutdown()
        clearJoinTicket()
    }

    /// The ticket comes down the moment its room is dead, not when the next one
    /// warms. `onRoomReady` only ever OVERWRITES the three fields, and tvOS
    /// wakes an app by showing its last frame first — so without this, every
    /// wake (and every relay teardown) advertises the closed room's QR for as
    /// long as the fresh create takes, and a phone that scans it lands on a
    /// terminal "Room not found". The blank ticket is the same "warming up"
    /// face boot shows.
    func clearJoinTicket() {
        state.roomCode = ""
        state.joinURL = ""
        state.joinQR = nil
        syncAdvertisement()
    }

    /// Publish or withdraw the LAN record so it tracks "this room is joinable"
    /// (CONTRACT.md §8). Every road that changes that answer calls this: the room
    /// warming, a roster movement, the ticket coming down.
    ///
    /// THE ROOM CODE COMES FROM `net`, NOT FROM `state`. `state.roomCode` is a
    /// display field, and the screenshot harness writes "TEST" straight into it
    /// to photograph a lobby — reading it here would put a fixture room on the
    /// air during every gallery capture. `net.roomCode` is only ever set by the
    /// walk that owns a real relay room, so the harness cannot reach it.
    ///
    /// A FULL ROOM IS WITHDRAWN, and republished when a slot frees. The launcher
    /// does hide a full room when it resolves the code (it compares `clients`
    /// against `maxClients`), but it only re-resolves when a record APPEARS — so
    /// going quiet is what takes the stale card down promptly.
    ///
    /// `suspended` covers the background: the room may survive the wake, but
    /// nothing is watching it until the rejoin, and a discovered join would land
    /// a player in front of a dead display.
    func syncAdvertisement() {
        let seated = state.seats.filter { !$0.open }.count
        guard !suspended, let room = net.roomCode, !room.isEmpty,
              seated < proto.maxPlayers else {
            advertiser.withdraw()
            return
        }
        advertiser.advertise(room: room)
    }

    /// Back on screen, with a fresh room.
    ///
    /// Any race that was running belongs to a party that no longer exists — its
    /// phones were told the room closed — so the session goes before the lobby
    /// comes back. Leaving it up would put a HUD over cars nobody can steer.
    func resume() {
        guard suspended else { return }
        suspended = false
        if sessionHandle != 0 { returnToLobby() }
        net.resumeWithFreshRoom()
        refreshLobby()
    }

    // MARK: - The race-flow entry points

    /// The launch knobs the walks cannot know (the web's `launchArgs`): a fresh
    /// seed per race from the shell's own RNG — the engine stays deterministic
    /// from the seed while rolls vary game to game — and the countdown budget.
    /// The overrides exist for the screenshot harness, which fabricates its
    /// INPUTS (a zero-length countdown, a forced item, a sceneReady it vouches
    /// for) but shares every step below the walk with the live game.
    ///
    /// The host pressed START. ONE walk: the go/no-go (room phase, scene, pick,
    /// connected players — all read off the room handle in C++), the bag draws a
    /// random pick needs, the cup series stood up behind the room, and the
    /// launch effects.
    func startRace(countdownSeconds: Int? = nil,
                   forceItem: String? = nil,
                   sceneReady: Bool? = nil) {
        let d = TTP.obj(ttp_race_start_live_json(
            net.roomHandle,
            (sceneReady ?? display.hasScene) ? 1 : 0,
            Double(UInt32.random(in: .min ... .max)),
            Double(countdownSeconds ?? proto.countdownSeconds),
            forceItem, nil))
        guard d["action"] as? String == "launch" else {
            // Same reason `announceRoomReady` prints: a TV has no console, and a
            // silently refused Start is indistinguishable from a dead button.
            print("[ttp] start refused: \(d["reason"] ?? "?")")
            return
        }
        run(d)
        armCountdown(d)
    }

    /// The cup chain: RESULTS straight into the next COUNTDOWN, with no lobby
    /// step in between. ONE walk: verdict, the series advanced, the pick
    /// re-aimed at the cup's next circuit (the net set-track tail merges into
    /// the answer) and the launch — nothing sequenced here.
    func advanceSeriesRace() {
        let d = TTP.obj(ttp_race_advance_live_json(
            net.roomHandle, display.hasScene ? 1 : 0,
            Double(UInt32.random(in: .min ... .max)),
            Double(proto.countdownSeconds), nil, nil))
        switch d["action"] as? String {
        case "return-to-lobby": returnToLobby()   // everyone left mid-intermission
        case "advance": run(d); armCountdown(d)
        default: break                            // "none"
        }
    }

    /// Hold a launch's countdown until the scene it will be driven on has
    /// settled. Both launch paths arm through here, so a chained cup race waits
    /// exactly as a lobby start does.
    func armCountdown(_ answer: [String: Any]) {
        let effects = answer["countdownEffects"] as? [Any] ?? []
        pendingCountdown = effects.isEmpty ? nil : (effects, nowMs())
    }

    /// Asked once a frame while a launch waits. True on the frame the countdown
    /// actually starts, so the caller can skip the rest of that tick.
    ///
    /// The rule and everything it weighs are `ttp_race.h`'s: this side reports
    /// only the fact it owns (has my build returned) and its own clock. The
    /// frame evidence is read inside, off the window this shell is already
    /// feeding, so a countdown can never be gated on numbers the readout
    /// disagrees with.
    func releaseCountdown() -> Bool {
        guard let waiting = pendingCountdown else { return true }
        // `measuring` is 1 unconditionally here: this shell feeds
        // `ttp_perf_sample` on every tick of the display link, with no
        // automation or pinned-scale path that turns it off (the web has both).
        guard ttp_race_countdown_ready(sceneBuildPending ? 0 : 1, 1,
                                       nowMs() - waiting.at) != 0 else { return false }
        pendingCountdown = nil
        // WHAT THE GATE ACTUALLY DID, and in RELEASE — the same reason
        // `adaptScale` prints, and tvOS-only for the same reason too: a shipped
        // television has no console, the bench discards its own opening six
        // seconds, and this is the one path whose behaviour cannot be seen from
        // a screenshot or reproduced on a desk. The web has devtools and Android
        // has logcat; this box has neither unless something says so out loud. A
        // wait near the backstop means the rule never got a steady window; a
        // short one means it did.
        print(String(format: "[ttp] countdown held %.0f ms", nowMs() - waiting.at))
        run(["effects": waiting.effects])
        return true
    }

    /// Back to the lobby from anywhere. The executor cancels a running cup and
    /// re-rolls a random pick's next preview from the room's bag; a call that
    /// is already a no-op draws nothing.
    func returnToLobby() {
        let d = TTP.obj(ttp_race_return_live_json(net.roomHandle))
        guard d["action"] as? String == "return" else { return }
        run(d)
    }

    /// Pull a player's car out of the live race (a clean LEAVE, or a dropped seat
    /// the liveness sweep gave up on). The removal happens inside the walk,
    /// against the live session; a removal that ends the race queues its end
    /// events, which the next frame's drain decides. sessionHandle 0 is legal
    /// (the no-car effects).
    func forfeit(_ id: EngineIdentity) {
        run(TTP.obj(ttp_race_forfeit_live_json(sessionHandle, id.json)))
    }

    /// A dropped player came back on a different device. The session rekey, the
    /// banked cup points (they follow the PLAYER) and the room-retained field
    /// row all move inside the walk; what comes back is only the scene op.
    func rekey(_ old: EngineIdentity, _ new: EngineIdentity) {
        run(TTP.obj(ttp_race_rekey_live_json(sessionHandle, net.roomHandle, old.json, new.json)))
    }

    func refreshAutoPause() {
        // The input, the consult gate, the synced participants read AND the
        // effects are one walk — one crossing where this shell used to make
        // four over two ABIs. `raceEnded` is the one input that stays: the
        // results-overlay latch, which no handle knows. Cheap on the lobby's
        // roster renders: the gate inside says no before anything is gathered.
        run(TTP.obj(ttp_race_auto_pause_live_json(sessionHandle, net.roomHandle, raceEnded ? 1 : 0)))
    }

    /// Walk whatever the layer answered. Every entry point above funnels through
    /// here so there is exactly one place effects are performed, in order.
    func run(_ answer: [String: Any], results: [String: Any]? = nil) {
        let effects = answer["effects"] as? [Any] ?? []
        do {
            try performer.perform(effects, context: .init(results: results))
        } catch {
            // An unperformable effect is a missing capability. Surfacing it beats
            // continuing with a half-built race.
            state.lastError = String(describing: error)
            assertionFailure(String(describing: error))
        }
    }

}

/// The stored lobby pick, as `ttp_net_pick_json` answers it. A thin READER over
/// the model's own JSON — the rules that write it are the walks', and the raw
/// object (`wire`) crosses back verbatim where a model takes the whole pick
/// (`refreshCupSlot`), exactly as the web hands `ui.cupSlot(net.pick)`.
struct ModePick {
    let wire: [String: Any]
    init(_ json: [String: Any]) { wire = json }
    /// "random" | "cup" | "track", or nil before anything was picked.
    var mode: String? { wire["mode"] as? String }
    var cupId: String? { wire["cupId"] as? String }
    /// Always the RESOLVED concrete track.
    var trackId: String? { wire["trackId"] as? String }
    /// A 'random' run's length: 0 endless, else that many races.
    var randomRaces: Int { Int(wire["randomRaces"] as? Double ?? 0) }
}

