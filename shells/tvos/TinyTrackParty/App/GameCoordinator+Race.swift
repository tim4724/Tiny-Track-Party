import Foundation

/// The coordinator's race half: the inputs the orchestration layer takes, the
/// session's lifecycle, and the two loops (the frame, and the ~6 Hz poll).
///
/// Split from `GameCoordinator.swift` only for length. The rule is the same:
/// every shape below is `ttp_race.h`'s or `ttp_ui.h`'s, and building one wrong is
/// the likeliest way to get a plausible-looking race that is subtly not the
/// game.
@MainActor
extension GameCoordinator {

    // MARK: - The clock the walks take

    // The hand-built walk inputs are GONE: the executor walks gather the room
    // phase, the connected players, the stored pick, the bag and the series
    // off the room handle in C++ (`ttp_race.h`). What a walk still takes from
    // this shell is its clock, its latches and the launch knobs.
    func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    // MARK: - The session

    /// `create-session`. The FIELD rides the op (the executor composed it; the
    /// room retains its own copy for the boards), and the bots' personas arrive
    /// on it rather than being looked up: `race_flow.cc` is catalogue-agnostic,
    /// so it hands back the rows it was configured with.
    ///
    /// `ttp_session_begin_field` is begin plus the WHOLE field in one pass — the
    /// construction loop every shell used to hand-write (a spec'd entry becomes
    /// a bot, everything else a human, field order kept, and THE STATS ARE THE
    /// FIELD'S: this shell read them off the bot spec for a while, which has no
    /// stats, silently handing every bot the benchmark defaults). The field
    /// crosses verbatim — extra keys are ignored by contract. The race's
    /// item/wander SEED rides this op too (the set-track-seed effect is
    /// retired), so nothing about a launch is held between effects.
    func createSession(field: [Any], seed: UInt32, forceItem: String?, bots: [Any]) {
        disposeSession()
        sessionHandle = ttp_session_begin_field(trackId, seed, laps, forceItem,
                                                TTP.json(field), TTP.json(bots))
        guard sessionHandle != 0 else {
            // The REASON is the engine's — unknown track, refused lap count —
            // rather than this line guessing from the one bit it was handed.
            requireOK(false, "starting a race on '\(trackId)'")
            return
        }
    }

    func disposeSession() {
        // …and with it any countdown still waiting on that race's scene: an
        // abort mid-gate would otherwise start one over the lobby a beat later.
        pendingCountdown = nil
        guard sessionHandle != 0 else { return }
        // Unbind BOTH consumers before disposing: a disposed handle takes its
        // queued audio beats with it, and the display would otherwise read a
        // dead Game for one frame.
        display.bind(session: 0)
        audio.bind(session: 0)
        ttp_dispose(sessionHandle)
        sessionHandle = 0
    }

    func paintInitialHUD() {
        // The renderer reads the grid poses straight off the engine; there is
        // nothing to copy across. The web's version of this op exists because
        // its Stage cached a per-car HUD row, and the packed HUD poll replaced
        // that. Kept as a named no-op rather than dropped, so the op stays
        // performable and a future HUD that DOES need priming has a home.
    }

    /// The manual overlay pause/resume, as walks. The verdicts
    /// (`ttp_ui_can_pause` / `can_resume`) are asked INSIDE, and the op order is
    /// the contract — every pause road (the remote's Play/Pause, Menu on a live
    /// race, and a phone's PAUSE_GAME) ends here and none of them decides. These replaced three hand-kept
    /// writes that existed twice, once per road, with a note naming the
    /// duplication as the failure to watch for.
    func pauseRace() {
        run(TTP.obj(ttp_race_pause_live_json(sessionHandle, net.roomHandle,
                                             state.paused ? 1 : 0, autoPaused ? 1 : 0,
                                             raceEnded ? 1 : 0)))
    }

    func resumeRace() {
        run(TTP.obj(ttp_race_resume_live_json(sessionHandle, net.roomHandle,
                                              state.paused ? 1 : 0, autoPaused ? 1 : 0,
                                              raceEnded ? 1 : 0)))
    }

    /// The ONE writer of the sim's clock. Every pause road — the remote's
    /// Play/Pause, Menu on a live race, a phone's PAUSE_GAME — ends here, and
    /// none of them decides:
    /// `ttp_ui_freeze_plan_json` arbitrates, so a manual resume while every
    /// racer is still gone keeps the field frozen, and a reconnect during a
    /// manual pause keeps the overlay's authority.
    ///
    /// The answer is the transition AND its member ops in order — thaw is NOT
    /// freeze reversed (voices never restart on thaw; cars release before the
    /// music returns), and re-spelling the composition at the call site is how
    /// one shell already shipped frozen cars that kept squealing. Same
    /// walk-and-perform contract as the race flow: an op this build cannot
    /// perform is a missing capability, said loudly.
    func syncSessionFrozen() {
        let plan = TTP.obj(ttp_ui_freeze_plan_json(
            state.paused ? 1 : 0,
            autoPaused ? 1 : 0,
            sessionHandle != 0 && ttp_paused(sessionHandle) != 0 ? 1 : 0))
        for op in (plan["ops"] as? [Any] ?? []).compactMap({ $0 as? String }) {
            switch op {
            case "pause-session": if sessionHandle != 0 { ttp_pause(sessionHandle) }
            case "resume-session": if sessionHandle != 0 { ttp_resume(sessionHandle) }
            case "stop-voices": audio.stopVoices()
            case "pause-music": audio.setMusicPaused(true)
            case "resume-music": audio.setMusicPaused(false)
            case "hold-cars": display.hold(true)
            case "release-cars": display.hold(false)
            default:
                let why = "freeze op this build cannot perform: \(op)"
                state.lastError = why
                assertionFailure(why)
            }
        }
    }

    // MARK: - The scene

    func rebuildScene() {
        let roster = sceneCars.map {
            RosterSlot(id: $0.id,
                       name: $0.name,
                       carIndex: $0.carIndex ?? 0,
                       color: proto.carColors[safe: $0.colorIndex] ?? "",
                       model: proto.carModels[safe: $0.carIndex ?? 0] ?? proto.carModels[0])
        }
        // The cells are the cars that own a split-screen view, in roster order —
        // which IS cell order, and is the only place that mapping exists.
        display.setCells(sceneCars.filter(\.cell).map(\.id))
        // THE COUNTDOWN GATE'S HALF OF THE QUESTION. `display.hasScene` cannot
        // answer it: it goes true on the first build of the process and stays
        // true through every one after, so during a launch's rebuild it is still
        // describing the LOBBY's scene. What the gate needs is whether the build
        // just asked for has returned.
        sceneBuildPending = true
        Task { @MainActor in
            defer { sceneBuildPending = false }
            do {
                try await SceneStaging.build(trackId: trackId,
                                             biome: nil,
                                             roster: roster,
                                             showcase: false,
                                             display: display,
                                             store: assets,
                                             blobs: blobs)
                // The boost icon's chevrons are the BIOME's accent, chosen for
                // contrast with this track's deck rather than to match the
                // scenery, so it can only be read once the build has resolved
                // which biome won. One of the two colours `biomes.js` allows a
                // shell to ask the theme for.
                state.boostAccent = ttp_theme_boost_icon(display.biomeName)
                // And warm the item icons for it, here rather than mid-race:
                // the first bitmap for a variant costs a parse and a 512px
                // raster, and without this the bill lands on the frame an item
                // drops into a slot. This is the moment the accent becomes
                // known, and the lobby's attract build reaches it long before
                // any race does.
                ItemIcon.prewarm(accent: state.boostAccent)
            } catch {
                state.lastError = "scene: \(error)"
            }
        }
    }

    func placeTrack() { rebuildScene() }

    /// Swap the circuit the lobby previews and the next race builds.
    ///
    /// **A NO-OP WHEN THE TRACK DID NOT MOVE**, which is not an optimisation:
    /// a rebuild is a track mesh plus a 2048x2048 shadow bake, run on the main
    /// thread, and the whole UI is frozen for it. Two cups whose race 1 is the
    /// same circuit, or a re-tap of the pick already showing, would each pay for
    /// it and show nothing new. `display/Net.js`'s `setTrack` has had the same
    /// early return all along.
    ///
    /// AND IT DOES NOT BUILD IN THE LOBBY, because the attract demo is about to.
    /// `refreshLobby` -> `lobbyDemo.refresh()` re-grids onto the new track and
    /// hands its field to `setDemoSceneCars`, which rebuilds with a roster the
    /// cars are actually in. Building here first meant every pick paid for TWO
    /// full scene builds back to back, the first of them for an empty roster —
    /// which is what "switching cups hangs the lobby" was.
    func setTrack(_ id: String) {
        guard id != trackId else { return }
        trackId = id
        // No publish: every caller is the track-change effect, and the walk
        // that emitted it published the stored pick one op earlier.
        // The pick is what lifts the paper off the lobby (see refreshBackdrop):
        // before it there is no scene to show, after it there is.
        refreshBackdrop()
        // The lobby's build belongs to the demo; a race's belongs to the flow's
        // own `place-track`. What is left here is the boot seed and the
        // screenshot harness, neither of which has a demo running.
        if state.screen != .race && !lobbyDemo.willRebuild(for: id) { rebuildScene() }
    }

    func fadeToLobby(placeTrack shouldPlace: Bool) {
        sceneCars = []
        if shouldPlace { rebuildScene() } else { display.release() }
        lobbyDemo.refresh()
    }

    func removeSceneCar(_ id: EngineIdentity) {
        sceneCars.removeAll { $0.id == id }
        rebuildScene()
    }

    func rekeySceneCar(_ old: EngineIdentity, _ new: EngineIdentity) {
        sceneCars = sceneCars.map {
            guard $0.id == old else { return $0 }
            return SceneCar(id: new, colorIndex: $0.colorIndex, name: $0.name,
                            cell: $0.cell, carIndex: $0.carIndex)
        }
        display.setCells(sceneCars.filter(\.cell).map(\.id))
    }

    /// A seated player changed their name.
    ///
    /// The LOBBY needs nothing: its seat grid is re-read off the room handle on
    /// the same announce that delivered this, and the room-retained field row
    /// every standings board reads was already repaired inside the rename walk.
    /// A RACE still froze one copy at its start — the cell chip (`sceneCars`,
    /// which the HUD poll reads) — so that is moved by hand, and the board
    /// already out is re-pushed.
    ///
    /// A no-op for a seat with no car, since a late joiner is in neither.
    ///
    /// The car's REAR NAME PLATE is untouched and stays stale until the next
    /// scene build: it is geometry baked from the build roster, so moving it
    /// needs a per-plate rebuild in the renderer and a new ABI. Same on the web.
    func renamePlayer(_ id: EngineIdentity, _ name: String) {
        sceneCars = sceneCars.map {
            guard $0.id == id else { return $0 }
            return SceneCar(id: $0.id, colorIndex: $0.colorIndex, name: name,
                            cell: $0.cell, carIndex: $0.carIndex)
        }
        // The board only reaches the phones on its NEXT push — mid-race that is
        // the next car to cross, and on the podium never. So re-push the board
        // already out, at the same `over` it went out with. Never a FIRST one:
        // a phone raises its results overlay on a non-null standings.
        if net.hasStandings() { broadcastStandings(over: raceEnded, results: nil) }
    }

    /// The effect's own `item` is deliberately not taken: the slot-machine spin
    /// is the HUD's and it reads the held item off the packed HUD poll, so all
    /// this owes is the fact that a FRESH pickup happened — the slot re-spins
    /// even on the same item id, which a value compare could not tell it.
    func itemPickup(_ id: EngineIdentity) {
        state.itemPickupTick[id] = (state.itemPickupTick[id] ?? 0) + 1
    }

    // MARK: - Results

    // The cup points are banked by the EXECUTOR, inside the event drain,
    // against the room's series and retained field — before the board effects,
    // the order the corpus pins. Nothing here applies points any more.

    /// Push the board to the phones.
    ///
    /// The FINAL board rides the drain's own results object, handed down
    /// through the effect context; with none in flight the twin re-reads the
    /// live session in C++, which is the same thing mid-race.
    func broadcastStandings(over: Bool, results: [String: Any]?) {
        guard sessionHandle != 0 else { return }
        net.setStandings(standingsBoard(over: over, results: results))
    }

    func showResults(_ results: [String: Any]?) {
        state.results = GameState.ResultsView(TTP.obj(ttp_ui_results_view_json(
            standingsBoard(over: true, results: results), ttp_race_intermission_ms())))
    }

    /// The board the TV and every phone render, off `ttp_ui_standings_live_json`:
    /// the results rows, the room-retained race FIELD (rename/rekey repairs
    /// applied by the walks — the last hand-assembled input, gone), the cup
    /// half off the room's stored series, and the late joiners + host through
    /// the synced seam — every input gathered off the two handles in C++.
    private func standingsBoard(over: Bool, results: [String: Any]?) -> String {
        TTP.strOrEmpty(ttp_ui_standings_live_json(
            sessionHandle, net.roomHandle, over ? 1 : 0,
            results.map { TTP.json($0) }, ttp_race_intermission_ms()))
    }

    // MARK: - Timers the effects arm

    func armResultsFailsafe(ms: Double) {
        clearResultsFailsafe()
        resultsFailsafe = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(ms * 1_000_000))
            guard !Task.isCancelled else { return }
            self.returnToLobby()
        }
    }

    func clearResultsFailsafe() {
        resultsFailsafe?.cancel()
        resultsFailsafe = nil
    }

    func armIntermission(ms: Double, deadline: Double) {
        clearIntermission()
        intermissionDeadline = deadline
        intermissionTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(ms * 1_000_000))
            guard !Task.isCancelled else { return }
            self.advanceSeriesRace()
        }
        // "starting in N" is re-READ from the model every 500 ms rather than
        // counted down locally, so a stalled frame or a suspended app cannot
        // drift the number away from the deadline the phones were told.
        intermissionTicker = Task { @MainActor in
            while !Task.isCancelled {
                self.state.intermissionSecs =
                    Int(ttp_ui_intermission_secs(self.intermissionDeadline, self.nowMs()))
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    func clearIntermission() {
        intermissionTask?.cancel()
        intermissionTicker?.cancel()
        intermissionTask = nil
        intermissionTicker = nil
        state.intermissionSecs = nil
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

extension EngineIdentity {
    /// The identity as a JSON-encodable Swift value, for building a payload that
    /// `TTP.json` will re-encode. Round-tripping through the JSON text is what
    /// keeps a numeric seat numeric.
    var numericOrString: Any {
        if let n = Int(json) { return n }
        return description
    }
}
