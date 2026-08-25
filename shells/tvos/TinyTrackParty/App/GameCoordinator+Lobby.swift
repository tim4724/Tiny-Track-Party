import Foundation

/// The coordinator's lobby half: the seat grid, the host's pick, the reconnect
/// cards, and the controller messages that drive them.
@MainActor
extension GameCoordinator {

    // MARK: - The seat grid

    /// Re-read the lobby from the ROOM HANDLE. There is no roster copy in this
    /// shell to keep in step: `ttp_ui_roster_seats_room_json` reads the room's
    /// own records across the `ttp_room.h` seam, and `ttp_ui_seat_grid_json` pads
    /// the result to `maxPlayers` with open placeholders.
    ///
    /// The padding is the MODEL'S so that three shells cannot pad differently,
    /// which is also why this hands seats back rather than appending its own.
    func refreshLobby() {
        let seats = TTP.strOrEmpty(ttp_ui_roster_seats_room_json(net.roomHandle, net.hostIdJSON))
        let grid = TTP.arr(ttp_ui_seat_grid_json(seats))
        state.seats = grid.enumerated().compactMap { GameState.Seat($0.element, index: $0.offset) }

        // The join plink, and the attract demo's debounce. Both ride the roster
        // render on the web for the same reason they do here: this is the one
        // place that knows the roster moved.
        audio.roster(count: state.seats.filter { !$0.open }.count,
                     inLobby: state.screen == .lobby)
        if state.screen == .lobby { lobbyDemo.refresh() }

        // The LAN record tracks OCCUPANCY too (CONTRACT.md §8): a room that just
        // filled goes off the air, and one a leaver reopened comes back. This is
        // the one place that knows the roster moved, which is why it rides here
        // rather than owning a subscription of its own.
        syncAdvertisement()

        // The right rail's race card. It rides the ROSTER render for the same
        // reason the web's does (`renderRoster` calls `renderLobbyPick`): the
        // pre-pick slot names the host, so a join or a rename changes it.
        //
        // Nothing outside the screenshot harness called this, so on the live
        // board the rail stayed empty through every pick — a host chose a cup on
        // their phone and the TV showed no cup, no circuits, no difficulty.
        refreshCupSlot()

        // No publish here, deliberately: every road into this render is a walk
        // that already published (announce, the pick's own push, the created
        // frame) — the web's renderRoster doesn't republish either, and a
        // second retained-snapshot write per roster event is pure wire noise.

        // THE SILENT AUTO-PAUSE RIDES THE ROSTER, exactly as it does on the web
        // (`net.flow.on('rosterchange', refreshAutoPause)`). Every roster
        // movement is a candidate: a disconnect, a reconnect, a rekey, a leave,
        // a seat expiry. Without this the freeze only ever ran from the deferred
        // post-GO re-check, so a party that walked away MID-RACE left the cars
        // driving themselves on a television nobody was holding a phone at.
        //
        // Cheap by construction: the model's own `ttp_ui_auto_pause_asks` gate
        // is the first thing `refreshAutoPause` consults, and in the lobby it
        // says no before anything is gathered.
        refreshAutoPause()
    }

    // MARK: - What the phones say

    /// The "game" bucket: everything the peer-message walk did not handle as a
    /// seat rule (the routing — and the host's SELECT_MODE — already happened
    /// inside `PartyNet`'s walks); these are the messages that need a RACE.
    ///
    /// Every button press routes through `ttp_net_controller_action`, gates
    /// included: START_GAME needs the host AND every other racer ready,
    /// SERIES_NEXT is host-only, pause/resume are any player's, and re-deriving
    /// any of that here is exactly the if-chain the verdict replaced — it
    /// existed in two shells with the gates spelled twice.
    func handleControllerMessage(from: EngineIdentity, _ msg: [String: Any]) {
        guard let type = msg["type"] as? String else { return }
        if type == proto.msgControl {
            // CONTROL stays on its own short-circuit: it is the relay-fallback
            // INPUT path (sensor-rate when the fastlane is down), and adding a
            // crossing there was measured and refuted.
            guard sessionHandle != 0 else { return }
            // THE MASK IS DERIVED HERE, NEVER SENT. It is a PRESENCE bitmask over
            // the three fields (1 = s, 2 = b, 4 = u) and the ABI leaves an absent
            // field UNTOUCHED on the car — which is what makes a partial CONTROL
            // legal, and what makes a wrong mask silent.
            //
            // This used to read `msg["mask"]`. There is no such key on the wire
            // (`controller/Net.js` sends `{s, b, u, type}`), so the mask was 0 on
            // every sample: "nothing present", every field skipped, every car
            // left un-steered for the whole race. Nothing errored, the packets
            // all arrived, and the cars simply never answered the phones.
            var mask: Int32 = 0
            var s = 0.0, b = 0.0, u = 0.0
            if let v = msg["s"] as? Double { mask |= 1; s = v }
            // `b` is a number OR a bool, matching the reader this was ported
            // from — a phone that sends `true` must brake, not be ignored.
            if let v = msg["b"] as? Double { mask |= 2; b = v }
            else if let v = msg["b"] as? Bool { mask |= 2; b = v ? 1 : 0 }
            if let v = msg["u"] as? Double { mask |= 4; u = v }
            // Applied on ARRIVAL rather than queued for the next tick: the input
            // path is 4.6 us, and buffering it would add a frame of latency to
            // the one thing players feel.
            ttp_process_input(sessionHandle, from.json, mask, s, b, u)
            return
        }
        switch TTP.strOrEmpty(ttp_net_controller_action(net.roomHandle, sessionHandle,
                                                        from.json, type)) {
        case "start-race": startRace()
        case "series-next": advanceSeriesRace()
        case "pause": pauseRace()
        case "resume": resumeRace()
        case "return-to-lobby": returnToLobby()
        // The host's Sound switch (the verdict re-checks host). The republish
        // inside setSoundOn echoes the new state back to every phone.
        case "set-sound": setSoundOn((msg["on"] as? Bool) ?? true)
        default: break   // "none" — refused, or not a word this layer knows
        }
    }

    /// The lobby's right rail: which name, how many races, the difficulty pips
    /// and which circuits to draw as minis.
    ///
    /// EVERY FIELD IS `ttp_ui_cup_slot_json`'s, keys plus data and never composed
    /// copy — the two English strings live in `Copy`. Nil before the host has
    /// picked, which the view renders as no card at all rather than an empty one.
    func refreshCupSlot() {
        // The model answers a bare `null` before a pick, which `TTP.obj` reads
        // back as an empty dictionary and `CupSlot.init?` refuses. So an absent
        // card is a real absence rather than a card with nothing in it. The
        // STORED pick crosses verbatim — it is already the model's own shape.
        // `veiled()` is the shell's random-family secrecy (see its note).
        state.cupSlot = GameState.CupSlot(TTP.obj(ttp_ui_cup_slot_json(TTP.json(pick))))?.veiled()
    }

    /// The attract grid, as the scene's roster. `cell: false` throughout: the
    /// lobby draws one overview camera over the whole track, not a split screen.
    ///
    /// The ids here are the demo layer's own (`demo-<peer>`, `demo-cpu-<n>`),
    /// namespaced by `ttp_race_demo_live_json` precisely so they cannot
    /// collide with the integer phone slots the real race rebuilds its field from.
    func setDemoSceneCars(_ field: [Any]) {
        sceneCars = demoSceneCars(field)
        rebuildScene()
    }

    /// The demo's in-place pick swap: same slots, new liveries/models/names.
    /// `ttp_display_reroster` keeps the meshes, the baked shadows and the
    /// preview camera's orbit phase — the full rebuild this used to pay is why
    /// choosing a car on a phone visibly snapped the lobby camera back to its
    /// start bearing. A refusal (C++'s call) falls back to the full build.
    func redressDemoSceneCars(_ field: [Any]) {
        sceneCars = demoSceneCars(field)
        let roster = sceneRoster()
        Task { @MainActor in
            if await !SceneStaging.redress(roster: roster, display: display, store: assets) {
                rebuildScene()
            }
        }
    }

    private func demoSceneCars(_ field: [Any]) -> [SceneCar] {
        field.compactMap { entry in
            guard let p = entry as? [String: Any],
                  let id = EngineIdentity.from(p["id"]) else { return nil }
            return SceneCar(id: id,
                            colorIndex: Int(p["colorIndex"] as? Double ?? 0),
                            name: p["name"] as? String ?? "",
                            cell: false,
                            carIndex: (p["carIndex"] as? Double).map(Int.init))
        }
    }

    // MARK: - Reconnect cards

    /// The dropped seats awaiting a rejoin. The DIFF is the model's: it answers
    /// which cards to attach and which to drop, against the set this shell says
    /// is currently shown — which is one of the three pieces of state the model
    /// threads but does not hold.
    func applyReconnectCards(_ seats: [[String: Any]]) {
        let seatIds = seats.compactMap { EngineIdentity.from($0["id"]) }
        let diff = TTP.obj(ttp_ui_reconnect_diff_json(
            TTP.json(shownReconnectIds.map { $0.numericOrString }),
            TTP.json(seatIds.map { $0.numericOrString })))

        for id in (diff["remove"] as? [Any] ?? []).compactMap(EngineIdentity.from) {
            shownReconnectIds.remove(id)
            reconnectURLs[id] = nil
        }
        // `add` carries POSITIONS into seatIds while `remove` carries IDS — the
        // mixed convention ttp_ui.h documents on the diff. This loop read the
        // positions as ids for a while, so the lookup below matched no seat and
        // no reconnect QR ever attached; the dropped racer's cell showed an
        // empty card frame with nothing to scan.
        for i in (diff["add"] as? [Any] ?? []).compactMap({ ($0 as? NSNumber)?.intValue }) {
            guard seats.indices.contains(i),
                  let id = EngineIdentity.from(seats[i]["id"]) else { continue }
            // The per-seat claim URL carries ?claim=<peerIndex>, which is what
            // lets a DIFFERENT device take the seat over. Composed in C++; only
            // the bitmap is ours.
            let card = TTP.obj(ttp_net_reconnect_card_json(TTP.json(seats[i]), state.joinURL))
            shownReconnectIds.insert(id)
            reconnectURLs[id] = card["url"] as? String
        }
    }

    // MARK: - The harness's demo race

    /// Stand a race up with no lobby, no countdown and no party, for the
    /// screenshot scenarios. It is the same session the real race uses — a
    /// harness that faked the field would photograph a screen the game cannot
    /// produce.
    func startDemoRace(forceItem: String?, humans: Int) {
        let catalogue = TTP.obj(ttp_ui_catalogue_json())
        if trackId.isEmpty {
            // No literal fallback: a hardcoded track id that the catalogue does
            // not contain fails INSIDE ttp_session_begin, which is a long way
            // from the line that guessed it.
            guard let first = (catalogue["catalog"] as? [[String: Any]] ?? [])
                    .first?["id"] as? String else {
                state.lastError = "the shipped catalogue is empty — was ttp_ui_configure called?"
                return
            }
            trackId = first
        }
        // FAKE HUMANS, not an empty roster. `buildField` gives a split-screen
        // CELL to human seats and none to the CPUs that top the grid up, so
        // launching with `players: []` produces a legal race that renders under
        // ONE overview camera — a pretty picture of the track, and not the
        // screen the gallery is supposed to be showing.
        //
        // WHO they are is the engine's BENCH ROSTER (race_flow.h benchPlayers),
        // not this file's: three shells photograph these screens side by side,
        // and the Ann/Bo/Cy/Di this used to spell made every comparison carry a
        // rename about nothing under inspection. Only the seat NUMBERS stay
        // here, because a screenshot party is seated in this room.
        let players: [[String: Any]] = Scenarios.benchRoster(humans, track: trackId)
            .enumerated().map { i, row in
                ["peerIndex": i + 1,
                 "name": row["name"] ?? "",
                 "colorIndex": row["colorIndex"] ?? i,
                 "carIndex": row["carIndex"] ?? i]
            }
        // THE PICK GOES ON FIRST, seats after — the same order the lobby
        // scenarios document. `applyPick` rides the null-sender road, which
        // the walk only admits while the room has NO HOST; the first seated
        // player becomes host, so a pick applied after the seats is refused
        // and the launch below dies with `no-track` — which is exactly how
        // every "racing" photograph silently became a picture of the attract.
        net.applyPick(["mode": "track", "trackId": trackId])
        // PRESENCE IS FABRICATED WHERE IT LIVES: the live twins read the ROOM
        // (who is seated, who is disconnected), so the scripted party is
        // SEATED rather than special-cased at every read — the demoRace branch
        // in `connectedPlayers()` was that special case, and the twins walked
        // straight past it: the post-GO auto-pause re-check read an empty room
        // as a race with nobody in it and returned every shot to the lobby.
        // Relay-less is what makes seating safe: the liveness timer only ever
        // starts on a created/joined walk, so nothing sweeps seats that never
        // ping.
        for p in players {
            guard let id = EngineIdentity.from(p["peerIndex"]) else { continue }
            _ = ttp_room_add_player(net.roomHandle, id.json, TTP.json(
                ["name": p["name"] ?? "", "colorIndex": p["colorIndex"] ?? 0,
                 "carIndex": p["carIndex"] ?? 0, "ready": false]))
        }
        // THROUGH THE SAME WALK THE GAME CALLS. This used to build its own
        // launch payload inline, and that one shortcut is why fifteen race
        // screenshots looked perfect for a build whose Start button had never
        // once worked: the harness reached the launch directly, so it
        // photographed a countdown the only real road could not produce.
        //
        // A harness may fabricate its INPUTS — the seated party above, the pick
        // stored here, a zero-length countdown, a forced item, and a sceneReady
        // it vouches for (the launch's own reset-scene-cars builds the scene) —
        // but it must not own a second copy of the road: the start below is
        // `ttp_race_start_live_json`, the one the live game runs, so a break in
        // the launch breaks the shots too.
        startRace(countdownSeconds: 0, forceItem: forceItem, sceneReady: true)
    }
}
