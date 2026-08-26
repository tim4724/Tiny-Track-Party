import Foundation

/// Walks the ordered effect list `ttp_race.h` answers with, and performs each op.
///
/// **The order is the contract.** Nothing in `libttp-runtime/ttp/race_flow.cc`
/// returns a verdict for a shell to sequence, because the sequencing is the part
/// that is both load-bearing and silent when wrong. Four constraints live in the
/// order alone, and none of them type-checks:
///
/// 1. COUNTDOWN is published only **after** the session exists. The state change
///    republishes the room snapshot and every player's `inRace` is read from the
///    live session, so flipping first makes every racer's phone flash "you're in
///    the next race".
/// 2. The post-GO auto-pause re-check is **deferred off the launch stack**. It
///    runs inside `session.update()`, whose no-seats-left branch tears the
///    session down underneath the caller. `deferred` is a flag on the op, and
///    performing it synchronously is the bug that flag exists for.
/// 3. Cup points are banked **before** the final board goes out, because the
///    board carries this race's gains.
/// 4. The session is disposed **before** the flow flips to LOBBY, because that
///    transition sweeps held disconnected seats and would otherwise race an
///    `endRace` on the way out.
///
/// So this walker **may not reorder, batch, coalesce or skip.** An op it cannot
/// perform throws rather than being dropped: an unperformable effect is a
/// missing capability, and dropping one leaves a half-built race that looks like
/// a rendering bug three screens later.
///
/// The web twin is `perform()` / `applyEffect()` in `public/display/main.js`, and
/// the two switches are deliberately line-for-line comparable.
@MainActor
struct RaceFlowPerformer {

    /// What an op needs that is not in its own payload. Only `results` is read,
    /// by exactly three ops, and all three are emitted only by `endRace`.
    struct Context {
        var results: [String: Any]?
    }

    enum Failure: Error, CustomStringConvertible {
        case unperformable(String)
        var description: String {
            switch self {
            case .unperformable(let op): return "raceFlow: unperformable effect \(op)"
            }
        }
    }

    unowned let game: GameCoordinator

    func perform(_ effects: [Any], context: Context = Context()) throws {
        for effect in effects {
            guard let e = effect as? [String: Any], let op = e["op"] as? String else {
                throw Failure.unperformable("<malformed>")
            }
            try apply(op, e, context)
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private func apply(_ op: String, _ e: [String: Any], _ ctx: Context) throws {
        switch op {

        // ---- setup ------------------------------------------------------
        case "stop-lobby-demo":
            game.lobbyDemo.stop()

        // ---- screens ----------------------------------------------------
        case "show-screen":
            if let name = e["screen"] as? String, let s = GameState.Screen(rawValue: name) {
                game.show(s)
            }

        case "hide-results":
            game.state.results = nil

        case "set-race-flags":
            game.state.paused = e["paused"] as? Bool ?? false
            game.autoPaused = e["autoPaused"] as? Bool ?? false
            game.raceEnded = e["raceEnded"] as? Bool ?? false

        case "set-pause-overlay":
            game.state.paused = e["on"] as? Bool ?? false

        case "set-pause-button":
            game.state.pauseButtonShown = e["shown"] as? Bool ?? false

        // The web hides its chrome after a pointer goes idle and reveals it on
        // movement. A TV has no pointer: the focus engine decides what is
        // visible, so these two are genuine no-ops here rather than unhandled.
        case "reveal-chrome", "hold-chrome":
            break

        // ---- the scene --------------------------------------------------
        case "reset-scene-cars":
            game.sceneCars = (e["cars"] as? [Any] ?? []).compactMap(SceneCar.init(json:))
            game.rebuildScene()

        case "create-session":
            game.createSession(field: e["field"] as? [Any] ?? [],
                               seed: UInt32(truncatingIfNeeded: Int(e["seed"] as? Double ?? 1)),
                               forceItem: e["forceItem"] as? String,
                               bots: e["bots"] as? [Any] ?? [])

        case "transition":
            if let to = e["to"] as? String { game.net.transition(to: to) }
            // The backdrop rule reads the room state as well as the pick: a race
            // shows the 3D whether or not the lobby had one, and coming back to
            // LOBBY with no pick drops to paper again.
            game.refreshBackdrop()

        case "bind-session":
            // The renderer reads the grid poses (and then every frame) straight
            // off the engine; the audio hears only the BOUND session, which is
            // why the lobby's attract race is silent for free.
            game.display.bind(session: game.sessionHandle)
            game.audio.bind(session: game.sessionHandle)

        case "paint-initial-hud":
            game.paintInitialHUD()

        // ---- the countdown ----------------------------------------------
        case "start-countdown":
            ttp_session_start(game.sessionHandle, Int32(e["seconds"] as? Double ?? 3))

        case "show-countdown":
            // `Copy.countdown` spells the beat (digit / GO! / banner gone). The
            // beat's SOUND is the wasm's (it taps the same tick), so there is no
            // cue call here.
            game.state.countdown = Copy.countdown(Int(e["n"] as? Double ?? -1))

        case "broadcast-countdown":
            game.net.broadcast(TTP.json([
                "type": game.proto.msgCountdown,
                "n": e["n"] as? Double ?? 0
            ]))

        case "refresh-auto-pause":
            if e["deferred"] as? Bool ?? false {
                // Constraint 2. We are inside session.update(); its
                // no-seats-left branch disposes the session under this caller.
                Task { @MainActor in game.refreshAutoPause() }
            } else {
                game.refreshAutoPause()
            }

        // ---- audio ------------------------------------------------------
        case "start-music":
            game.audio.music(biome: e["biome"] as? String)

        case "stop-music":
            game.audio.music(biome: nil)

        case "show-music-credit":
            if !(e["on"] as? Bool ?? false) { game.state.musicCredit = nil }

        case "stop-voices":
            game.audio.stopVoices()

        case "stop-car-audio":
            if let id = EngineIdentity.from(e["id"]) { game.audio.stopCar(id) }

        // ---- in-race effects --------------------------------------------
        case "item-pickup":
            if let id = EngineIdentity.from(e["id"]) { game.itemPickup(id) }

        case "rocket-impact":
            if let id = EngineIdentity.from(e["id"]) {
                game.display.burst(id: id, s: 0, lat: 0)
            }

        case "rocket-expire":
            game.display.burst(id: nil,
                               s: e["s"] as? Double ?? 0,
                               lat: e["lat"] as? Double ?? 0)

        // ---- the finish --------------------------------------------------
        case "broadcast-standings":
            game.broadcastStandings(over: e["over"] as? Bool ?? false, results: ctx.results)

        // The points banking (constraint 3: BEFORE the final board goes out)
        // happens inside the event drain's executor now — no op crosses.
        case "show-results":
            game.showResults(ctx.results)

        case "arm-intermission":
            game.armIntermission(ms: e["ms"] as? Double ?? 0,
                                 deadline: e["deadline"] as? Double ?? 0)

        case "clear-intermission":
            game.clearIntermission()

        // ---- the cup chain ------------------------------------------------
        // The series ops (advance, clear, set-track-from-series, rekey, the
        // points banking) are EXECUTOR-OWNED now: the cup lives behind the
        // room handle and the walks perform them inside the wasm. Only the
        // platform ops below ever reach this switch.

        case "place-track":
            // Explicit because a chained start has NO lobby step: selecting a
            // track outside the lobby skips the scene swap, so the new circuit is
            // placed here and the results overlay covers the pop.
            game.placeTrack()

        // ---- teardown -----------------------------------------------------
        case "dispose-session":
            // Constraint 4: before the flow flips to LOBBY.
            game.disposeSession()

        case "fade-to-lobby":
            game.fadeToLobby(placeTrack: e["placeTrack"] as? Bool ?? false)

        case "remove-scene-car":
            if let id = EngineIdentity.from(e["id"]) { game.removeSceneCar(id) }

        case "sync-state":
            game.net.publishSnapshot()

        case "persist-progression":
            game.persistProgression(e["progress"])

        // ---- the roster-driven repairs -------------------------------------
        case "rekey-scene-car":
            if let old = EngineIdentity.from(e["oldId"]),
               let new = EngineIdentity.from(e["newId"]) {
                game.rekeySceneCar(old, new)
            }

        case "set-auto-paused":
            game.autoPaused = e["on"] as? Bool ?? false

        case "sync-frozen":
            game.syncSessionFrozen()

        case "return-to-lobby":
            game.returnToLobby()

        // ---- the party's way out --------------------------------------------
        // endParty's teardown — close-room bails every phone terminally while
        // the display's own 4001 self-heals into a FRESH room; a fresh party
        // then starts clean of the ended one's pick.
        case "close-room":
            game.net.closeRoom()

        case "clear-pick":
            // The PICK dies with the party; the PREVIEW deliberately survives
            // (`game.trackId` keeps the ended party's circuit), so the next
            // lobby keeps its 3D attract race instead of dipping back to the
            // paper diorama — the web's own clear-pick rule since the
            // boot-time attract.
            ttp_net_clear_pick(game.net.roomHandle)

        case "render-lobby-pick":
            game.refreshCupSlot()

        case "refresh-lobby-demo":
            game.lobbyDemo.refresh()

        case "update-backdrop":
            game.refreshBackdrop()

        default:
            // A race answer may carry NET-vocabulary ops in place: the executor
            // merges the set-track walk's tail (track-change, publish, …) into
            // it. Those belong to PartyNet's switch — whose own default is the
            // same loud missing-capability contract as the throw here.
            game.net.performNetEffect(e)
        }
    }

    /// The race-op arms of the switch above, as data, for the boot proof
    /// (`ttp_race_effect_ops_json` must be a subset). Net-vocabulary ops are
    /// deliberately absent — they fall through to PartyNet's switch.
    static let performable: Set<String> = [
        "stop-lobby-demo",
        "show-screen", "hide-results", "set-race-flags", "set-pause-overlay",
        "set-pause-button", "reveal-chrome", "hold-chrome",
        "reset-scene-cars", "create-session", "transition", "bind-session",
        "paint-initial-hud", "start-countdown", "show-countdown",
        "broadcast-countdown", "refresh-auto-pause", "persist-progression",
        "start-music", "stop-music", "show-music-credit", "stop-voices",
        "stop-car-audio", "item-pickup", "rocket-impact", "rocket-expire",
        "broadcast-standings", "show-results",
        "arm-intermission", "clear-intermission", "place-track",
        "dispose-session", "fade-to-lobby", "remove-scene-car",
        "sync-state", "rekey-scene-car", "set-auto-paused", "sync-frozen",
        "return-to-lobby", "close-room", "clear-pick", "render-lobby-pick",
        "refresh-lobby-demo", "update-backdrop"
    ]
}

/// One grid entry as `reset-scene-cars` describes it.
struct SceneCar {
    let id: EngineIdentity
    let colorIndex: Int
    let name: String
    /// Whether this car owns a split-screen view. A BOOLEAN, not an index: the
    /// model answers `cell: true` / `cell: false`, and a car's CELL NUMBER is its
    /// position among the cars that have one, in roster order.
    ///
    /// Decoding it as a number is the trap, and it does not look like one:
    /// `JSONSerialization` hands a JSON `true` back as an `NSNumber`, which
    /// bridges happily to `Double` as 1.0. Every car then claims cell 1 — the
    /// renderer still draws four views (it only counts them), so the picture is
    /// right and only the shell's chrome lands on one quadrant.
    let cell: Bool
    /// Kept nullable: a player who never picked drives car 0 but is not the same
    /// input as one who picked it.
    let carIndex: Int?

    init(id: EngineIdentity, colorIndex: Int, name: String, cell: Bool, carIndex: Int?) {
        self.id = id
        self.colorIndex = colorIndex
        self.name = name
        self.cell = cell
        self.carIndex = carIndex
    }

    init?(json: Any) {
        guard let d = json as? [String: Any], let id = EngineIdentity.from(d["id"]) else { return nil }
        self.id = id
        self.colorIndex = Int(d["colorIndex"] as? Double ?? 0)
        self.name = d["name"] as? String ?? ""
        self.cell = d["cell"] as? Bool ?? false
        self.carIndex = (d["carIndex"] as? Double).map(Int.init)
    }
}
