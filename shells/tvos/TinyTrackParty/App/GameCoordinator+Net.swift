import Foundation

/// The coordinator's net edge: what a relay event makes the game do.
///
/// `PartyNet` owns the socket, its own three timers and the room state machine, and
/// decides nothing — every answer it acts on is a `ttp_room_*` / `ttp_net_*`
/// call. This file is the other side of that split: it takes the events PartyNet
/// raises and turns them into race-flow entry points and `GameState` writes.
///
/// The rule that keeps the two apart: PartyNet may not know what a race is, and
/// this file may not know what a socket is.
@MainActor
extension GameCoordinator {

    func wireNet() {
        // The room is warm; the join ticket can be drawn.
        net.onRoomReady = { [weak self] code, url in
            guard let self else { return }
            self.state.roomCode = code
            self.state.joinURL = url
            self.state.joinQR = QRCode.image(for: url)
            // And on the LAN, for a launcher's one-tap join (CONTRACT.md §8).
            // Same moment as the QR by design: the two are one answer, "this
            // room is joinable", published two ways.
            self.syncAdvertisement()
        }

        // The advertised room is gone (fresh-room fallback): the ticket comes
        // down before the replacement dials, so nobody scans a dead code.
        net.onRoomGone = { [weak self] in self?.clearJoinTicket() }

        // Any roster movement: a join, a rename, a car pick, a ready toggle, a
        // drop. The seat grid is re-read off the ROOM HANDLE rather than from a
        // roster we carry, so there is no copy here to keep in step.
        net.onRosterChanged = { [weak self] in self?.refreshLobby() }

        // Every participant gone while someone waits, past the grace window.
        // The policy is RoomFlow's; performing it is returning to the lobby.
        net.onRaceAbandoned = { [weak self] in self?.returnToLobby() }

        // The room itself died (the relay's hostless grace, or a dead socket).
        // Terminal for the ROOM, not for us: PartyNet self-heals into a fresh
        // one, so the display's job is a fresh party's lobby. A race the dead
        // room stranded is wound down first, same as `resume()` does — the
        // session is disposed and the flow flipped before the lobby comes up.
        net.onClose = { [weak self] roomClosed in
            guard let self, roomClosed else { return }
            if self.sessionHandle != 0 { self.returnToLobby() }
            self.clearJoinTicket()
            self.landOnFreshLobby()
        }

        // A phone said something. The ROUTING already happened (PartyNet asked
        // `ttp_net_message_action`); what arrives here is the "game" bucket.
        net.onControllerMessage = { [weak self] from, msg in
            self?.handleControllerMessage(from: from, msg)
        }

        // A seat finished its HELLO handshake and has been told its item.
        net.onPlayerWelcomed = { [weak self] id in
            self?.relightItem(for: id)
            self?.refreshLobby()
        }

        // An intentional LEAVE. Mid-race that is a forfeit; in the lobby the
        // seat is simply gone and the roster refresh covers it.
        net.onPlayerLeave = { [weak self] id in
            guard let self else { return }
            if self.sessionHandle != 0 { self.forfeit(id) }
            self.refreshLobby()
        }

        // A dropped player came back on a DIFFERENT device: their car and their
        // banked cup points move to the new seat.
        net.onPlayerRekey = { [weak self] old, new in self?.rekey(old, new) }

        // A seated player renamed themselves mid-party.
        net.onPlayerRenamed = { [weak self] id, name in self?.renamePlayer(id, name) }

        // The dropped seats currently awaiting a rejoin, as reconnect cards. The
        // DIFF is the model's (`ttp_ui_reconnect_diff_json`); what the shell
        // holds is which cards actually attached.
        net.onReconnectSeats = { [weak self] seats in self?.applyReconnectCards(seats) }

        // The stored pick resolved a (possibly new) preview circuit — a host's
        // SELECT_MODE, the boot seed, or a cup advancing. The pick rules
        // themselves are the walk's (`ttp_net.h`'s selectModeWalk); what is
        // performed here is the scene swap and the lobby re-render, exactly the
        // web's `onTrackChange: (id) => { selectTrack(id); renderRoster(); }`.
        // The full lobby refresh, not just the race card: `lobbyDemo.refresh()`
        // rides it, and without that the attract race keeps driving the OLD
        // circuit — the board's preview never moves when the host picks.
        net.onTrackChange = { [weak self] id in
            // Remember every confirmed pick's resolved circuit: it is what the
            // NEXT party's lobby attracts on before anyone joins (the web's
            // LAST_TRACK_KEY rule; localStorage there, UserDefaults here). The
            // walk only ever resolves catalogue tracks, so no membership check.
            if !id.isEmpty {
                UserDefaults.standard.set(id, forKey: GameCoordinator.lastTrackKey)
            }
            self?.setTrack(id)
            self?.refreshLobby()
        }

        // What PartyNet needs FROM the game, as closures rather than a back
        // reference, so the transport half stays unable to reach the race half.
        net.sessionHandle = { [weak self] in self?.sessionHandle ?? 0 }
        // Manual pause only: the silent auto-pause lifts on the reconnect itself
        // (refreshAutoPause fires on the roster change), before the WELCOME goes
        // out.
        net.isPaused = { [weak self] in self?.state.paused ?? false }
        // The display's mute, for the snapshot's `soundOn` — so the host phone's
        // Sound row shows the live state rather than guessing at it.
        net.isSoundOn = { [weak self] in !(self?.audio.muted ?? false) }
        net.onRelayError = { [weak self] why in self?.state.lastError = "relay: \(why)" }

        // The CC-BY credit. A shell that streams this catalogue owes a visible
        // attribution: it is a licensing obligation, not chrome.
        audio.onSongChanged = { [weak self] title, artist, license, source in
            self?.state.musicCredit = GameState.MusicCredit(
                title: title, artist: artist, license: license, source: source)
        }

        // The lobby's attract race drives the picked track behind the boards.
        lobbyDemo.room = { [weak self] in self?.net.roomHandle ?? 0 }
        lobbyDemo.trackId = { [weak self] in self?.trackId ?? "" }
        // THE ROSTER, THEN THE BIND. `onField` puts the attract grid into the
        // scene the renderer draws from; without it the demo raced invisibly.
        // `cell: false` throughout — the lobby keeps its single overview camera.
        lobbyDemo.onField = { [weak self] field in self?.setDemoSceneCars(field) }
        // Only the picks changed: re-dress the slots in place so the attract
        // race keeps driving and the preview camera keeps its orbit phase.
        lobbyDemo.onRedress = { [weak self] field in self?.redressDemoSceneCars(field) }
        lobbyDemo.onSession = { [weak self] handle in self?.display.bind(session: handle) }

        // The two loops. `onFrame` is the race tick; `onSlowTick` is the ~6 Hz
        // poll that paints the HUD and pushes items — nothing in either changes
        // faster than it has to.
        display.onFrame = { [weak self] dt in self?.frame(dt) }
        display.onSlowTick = { [weak self] in self?.slowTick() }
        // Fires once, when a built scene first reaches the panel. At boot the
        // preview pick lands long before the pixels do, so without this nothing
        // ever asks the backdrop question again and the paper would stay up for
        // the whole lobby (the mirror of the flash it exists to stop).
        display.onFirstPaint = { [weak self] in
            // THE ORDER AND THE DELAY ARE BOTH THE POINT. The backdrop reveal is
            // a 0.45 s fade of the lobby's paper off the live scene, so doing
            // both at once uncovers that fade half-run: the opening then reads
            // as THREE steps — title, wallpaper, track — where it should be two.
            //
            // So the paper starts getting out of the way immediately, UNDER the
            // splash, and the splash is held until it has gone. The wait is free:
            // it is spent on an animation nobody can see, and what the viewer
            // gets is the title handing straight over to the circuit.
            self?.refreshBackdrop()
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(LobbyView.backdropFade))
                self?.refreshCover()
            }
        }
    }

    // MARK: - The two loops

    /// One race frame. THREE crossings and no more: the sim tick, the event
    /// drain, and the audio frame. Nothing about a car is serialized out.
    func frame(_ dt: Double) {
        if sessionHandle != 0 {
            // THE COUNTDOWN GATE. The grid is dressed, framed and painted by
            // now; "3, 2, 1" waits here until the scene has stopped assembling
            // itself. Skipping the update while it waits costs nothing — the
            // countdown holds the cars anyway, so this only extends the pose
            // they were already in.
            guard releaseCountdown() else { audio.frame(nowMs: nowMs()); return }
            ttp_update(sessionHandle, dt * 1000)
            // Drained IMMEDIATELY after the update: the event queue is
            // per-handle and a second update would overwrite it.
            drainRaceEvents()
        }
        audio.frame(nowMs: nowMs())
    }

    /// The frame's one drain. WHICH events do what — the countdown routing, the
    /// GO beat, the rocket-strike burst, the intermediate board skipped when
    /// the last human is home, the whole end-of-race order (points banked
    /// against the room's series BEFORE the board effects) — is decided inside
    /// the wasm off the queued events and the two live handles
    /// (`ttp_race_events_live_json`). The lifecycle routing table this shell
    /// once owned — and once fed to the ordinary-event filter, where the beats
    /// vanished and the room sat in COUNTDOWN forever — is not a shell concern
    /// any more.
    ///
    /// `results` rides the ANSWER because no effect can carry it: it is
    /// non-null exactly when the drain crossed the race's end, and the
    /// show-results / final broadcast-standings effects read it as context.
    func drainRaceEvents() {
        guard sessionHandle != 0 else { return }
        let d = TTP.obj(ttp_race_events_live_json(
            sessionHandle, net.roomHandle, display.biomeName,
            audio.ready ? 1 : 0, fastForwarding ? 1 : 0,
            ttp_race_intermission_ms(), nowMs(), ttp_race_results_failsafe_ms()))
        run(d, results: d["results"] as? [String: Any])
    }

    /// The ~6 Hz poll. Everything the DOM used to be written for per frame lives
    /// here instead, and the finish check rides it rather than asking sixty times
    /// a second whether anyone has crossed the line.
    func slowTick() {
        guard sessionHandle != 0, state.screen == .race else { return }
        paintHUD(display.hud())
        pushItems()

        // The finish. `ttp_ui_race_flow_live_json` answers {allDone, forfeit[]}
        // and is ~11 us, which is why it is here and not on the frame.
        //
        // THE FORFEITS BELONG INSIDE THE allDone ARM, as on the web (`main.js`
        // guards the loop under `if (flow && flow.allDone)`). `forfeit[]` names
        // every disconnected human EVERY poll — outside the arm it forfeits a
        // dropped-but-reconnectable racer six times a second, and with one phone
        // down the auto-pause freeze turns into a return to the lobby.
        let flow = raceFlow()
        if flow["allDone"] as? Bool == true, !raceEnded {
            for id in (flow["forfeit"] as? [Any] ?? []).compactMap(EngineIdentity.from) {
                forfeit(id)
            }
            // A forfeit can end the race under us; fastForwardToEnd's
            // `ttp_racing` guard is the web's `if (!session.racing) return`.
            fastForwardToEnd()
        }
    }

    /// Every human is home: resolve the rest of the race at once.
    ///
    /// NOT COSMETIC, which is what made this worth porting rather than shrugging
    /// at. Calling `endRace()` straight from here — which is what this shell did
    /// — ends the race with the BOTS STILL MID-LAP, so they reach the results
    /// board unfinished and the standings a TV shows differ from the ones a
    /// browser shows for the same race. The burst runs the deterministic sim on
    /// to its own end with no rendering, so every car finishes (or DNFs) the way
    /// it would have, and `endRace` then fires from the sim's own `_raceEnd`.
    ///
    /// THE HOLD COMES FIRST. `ttp_fast_forward` advances the world with no
    /// frames, and a just-finished human keeps driving a victory lap — so
    /// without freezing the field at the finish moment the chase camera is seen
    /// whipping across the track to a far-away pose, through the translucent
    /// results glass. `raceEnded` holds that frame until the next race.
    ///
    /// `fastForwarding` is read by `dispatch`: the burst is SKIPPING, not
    /// racing, so its events must not spawn visuals. The muting is already the
    /// wasm's (ttp_fast_forward runs silent).
    func fastForwardToEnd() {
        guard sessionHandle != 0, ttp_racing(sessionHandle) != 0 else { return }
        display.hold(true)
        fastForwarding = true
        ttp_fast_forward(sessionHandle)
        // Drained here rather than left for the next frame: the burst queues
        // every remaining finish AND the race's end, and the next `ttp_update`
        // would overwrite the queue. Decided muted — the burst is skipping,
        // not racing.
        drainRaceEvents()
        fastForwarding = false
    }

    /// `{allDone, forfeit[]}` — both halves in ONE crossing, deliberately: the
    /// boundary is what costs here, not the rule. The role sets are GATHERED in
    /// C++ off the two handles (carIds and finishedIds off the engine, aiIds
    /// off the bot registry, disconnectedIds off the room) — this shell used to
    /// assemble them, misspelled the keys, and the absent sets read as legal.
    /// A relay-less demo race reads an EMPTY room: no seat is disconnected, so
    /// nothing forfeits, which is what the fabricated-players branch existed
    /// to fake. Humans-all-done on a FINISH event is read inside the drain now;
    /// what is left here is the slow tick's safety net for the paths that carry
    /// no finish event (a drop, a forfeit, a rekey).
    func raceFlow() -> [String: Any] {
        guard sessionHandle != 0 else { return [:] }
        return TTP.obj(ttp_ui_race_flow_live_json(sessionHandle, net.roomHandle))
    }

    // MARK: - What the loops paint

    private func paintHUD(_ slots: [DisplayHost.HudSlot]) {
        // The cell rects are re-read here rather than per frame: they change only
        // on a resize or a cell-count change, and re-laying SwiftUI chrome at
        // 60 Hz would be view-tree churn the web's `style.left` write is not.
        // The cars that own a view, in the order they were named to
        // `ttp_display_cells` — so index i here is cell i there, and there is no
        // per-car cell NUMBER to look up because the model never sends one.
        let viewed = sceneCars.filter(\.cell)
        let rects = display.cellRects(count: viewed.count)
        var cells: [GameState.CellHUD] = []
        var cardMask: UInt32 = 0

        for (i, pair) in rects.enumerated() {
            guard i < viewed.count else { break }
            let car = viewed[i]
            let slot = slots.first { display.roster.indices.contains($0.slot)
                                      && display.roster[$0.slot] == car.id }
            let reconnecting = shownReconnectIds.contains(car.id)
            let finished = slot?.finished ?? false
            // FINISHED wins if both, and the mask is what tells the RENDERER to
            // drop that cell's steer bar — pushed before the frame draws, or the
            // bar shows for one frame under the card.
            if finished || reconnecting { cardMask |= (1 << UInt32(i)) }

            cells.append(GameState.CellHUD(
                index: i,
                car: car.id,
                rect: pair.picture,
                safeRect: pair.safe,
                name: car.name,
                colorIndex: car.colorIndex,
                carIndex: car.carIndex ?? 0,
                place: Int(slot?.place ?? 0),
                lap: Int(slot?.lap ?? 0),
                totalLaps: Int(slot?.totalLaps ?? 0),
                item: slot.flatMap { itemKey($0.item) },
                finished: finished,
                // Kept optional: a forfeit resolved at the flag is finished with
                // no time, and the packed block distinguishes the two.
                finishTime: slot?.finishTime,
                reconnecting: reconnecting && !finished,
                reconnectURL: reconnectURLs[car.id]))
        }
        display.cellCards(mask: cardMask)
        state.cells = cells
    }

    /// Relight a (re)joining phone's held item, once.
    ///
    /// A phone recovers all its room and results state from the retained
    /// snapshot replay, but the held ITEM is per-owner and rides its own message
    /// SENT ONLY ON CHANGE — so without this a driver who reconnects mid-race
    /// sits there with a dark USE button until their next pickup, holding an
    /// item they cannot see.
    ///
    /// The seat's held item comes off the live race in C++
    /// (`ttp_ui_welcome_item_live_json`) — one crossing, answering a bare JSON
    /// value (a quoted string, or null for no live car / an empty slot), so it
    /// is unwrapped through a one-element array rather than hand-parsed. It
    /// stamps the session's own outbox, so the next push tick does not repeat
    /// what this just said.
    private func relightItem(for id: EngineIdentity) {
        guard sessionHandle != 0 else { return }
        let answer = TTP.strOrEmpty(ttp_ui_welcome_item_live_json(sessionHandle, id.json))
        let value = TTP.arr("[\(answer)]").first ?? NSNull()
        net.sendTo(id, TTP.json(["type": proto.msgItem, "item": value]))
    }

    /// A held item crosses as a CODE, never a string. The table is DERIVED from
    /// `ttp_audio_cue_id`'s sibling `ttp_item_id` rather than mirrored, so a new
    /// item cannot be half-added.
    private func itemKey(_ code: Int32) -> String? {
        guard code >= 1 else { return nil }
        return TTP.str(ttp_item_id(code))
    }

    /// The per-phone ITEM push. All of it is the model's — it reads the live
    /// session itself (who holds a car, what each slot carries, which cars are
    /// bots) AND the outbox of what each phone was last told, which it stamps
    /// as it answers. This shell keeps no memory of any of it and only sends.
    ///
    /// The stamp therefore lands BEFORE the send, where this shell used to send
    /// first: a `sendTo` that fails now leaves the phone unaware until that
    /// seat's item changes again, instead of retrying on the next tick. See
    /// `ttp_ui.h` — the trade is deliberate, so do not "fix" it by re-adding a
    /// map here.
    func pushItems() {
        guard sessionHandle != 0 else { return }
        for push in TTP.arr(ttp_ui_item_pushes_live_json(sessionHandle)) {
            guard let p = push as? [String: Any], let id = EngineIdentity.from(p["id"]) else { continue }
            net.sendTo(id, TTP.json(["type": proto.msgItem, "item": p["item"] ?? NSNull()]))
        }
    }
}
