import Foundation
import QuartzCore

/// The lobby's attract race: a field of CPU cars driving the picked track behind
/// the join ticket, so the board is never a still photograph of an empty circuit.
///
/// It is a SHELL concern and stayed one deliberately. `race_flow.cc`'s header
/// names LobbyDemo among the things that did not cross, alongside the shuffle bag
/// and the host's mode pick: what it needs is a session, a track and a timer, all
/// three of which are the shell's to own, and the field composition it does need
/// is already an ABI (`ttp_race_demo_live_json`, off the live room handle).
///
/// It is SILENT for free. The audio layer only ever hears the BOUND session
/// (`abi_check` asserts it), and this one is never bound — so nothing here has to
/// remember to mute anything, and nothing can forget to.
@MainActor
final class LobbyDemo {

    private var handle: Int32 = 0
    private var tick: Task<Void, Never>?
    /// What the running demo was built from, for the in-place swap check: the
    /// re-dress path only qualifies while the TRACK and the car-id SET both
    /// stand (a join/leave or a track switch reorders slots, which is a full
    /// build by the renderer's own contract).
    private var field: [[String: Any]] = []
    private var track: String = ""
    /// The cheap signature of what is currently on screen. `ttp_race_demo_sig`
    /// exists so a roster change that does not change the PICTURE (a rename, a
    /// ready toggle) does not tear the race down and rebuild it, which would
    /// read as a stutter every time someone pressed a button on their phone.
    private var signature: String?

    /// Where the field comes from and what track to drive. The grid is read off
    /// the LIVE ROOM (`ttp_race_demo_live_json` gathers each seated human's pick
    /// and tops up with CPUs), so there is no players copy to hand across;
    /// `refresh()` is what acts on it.
    var room: () -> Int32 = { 0 }
    var trackId: () -> String = { "" }
    /// Handed the session so the coordinator can put the scene on it. The demo
    /// never binds audio.
    var onSession: ((Int32) -> Void)?

    /// Handed the attract field so the coordinator can put those cars in the
    /// SCENE ROSTER, before the session is bound.
    ///
    /// **A BOUND SESSION IS NOT A DRAWN CAR**, and that is the whole reason this
    /// callback exists rather than the demo just binding and being done. The
    /// renderer's field is `ttp_display_build`'s roster: `buildFrame` walks the
    /// ROSTER and looks each slot's car up in the bound session, so a car the
    /// session has and the roster does not is simulated, stepped, and drawn by
    /// nothing. No error, no warning, no missing-asset log — an empty circuit.
    ///
    /// This shell bound the demo session and left the roster at whatever the last
    /// race had put there, which in a fresh lobby is EMPTY. So the attract race
    /// ran perfectly, invisibly, for the whole of every lobby. The web's twin
    /// does the same two steps in the same order (`scene.addCar` per field entry,
    /// then `scene.bindSession`) — it just does them in one method.
    var onField: (([Any]) -> Void)?

    /// Same track, same set of cars, only the PICKS changed (a player switched
    /// their car or livery): hand the new field over for an in-place re-dress
    /// (`ttp_display_reroster`) so the demo race keeps driving and the preview
    /// camera keeps its orbit phase — the web's `swapCar` road. The session is
    /// deliberately NOT restarted: the new handling stats only land on the next
    /// full rebuild, exactly as on the web (handling differences are invisible
    /// in eye-candy, and re-seating would pop the field back to the grid).
    var onRedress: (([Any]) -> Void)?

    /// Whether a `refresh()` right now would stand a new attract race up on
    /// `track` — and therefore rebuild the scene with its field in the roster.
    ///
    /// It exists so `setTrack` does not build the same scene first, with an
    /// EMPTY roster, only for this to build it again a moment later. Two full
    /// track meshes and two 2048x2048 shadow bakes, back to back, on the main
    /// thread: that pair is what made switching cups look like a hang.
    ///
    /// Asked rather than assumed, because the demo does not always take over:
    /// it is off with no track and its signature check skips a rebuild when the
    /// picture would not change.
    func willRebuild(for track: String) -> Bool {
        guard !track.isEmpty else { return false }
        let live = TTP.obj(ttp_race_demo_live_json(room(), track, "null"))
        return live["sig"] as? String != signature || handle == 0
    }

    func refresh() {
        let track = trackId()
        guard !track.isEmpty else { stop(); return }

        // The grid and its signature in ONE crossing, off the live room. The
        // last argument is a bot CAP as a JSON scalar, not a seed: the attract
        // grid is a deterministic fill (persona by final grid index), so there
        // is nothing random to seed. "null" means fill to the field size.
        let live = TTP.obj(ttp_race_demo_live_json(room(), track, "null"))
        let sig = live["sig"] as? String ?? ""
        // Same picture as the one already running: leave it alone.
        if sig == signature, handle != 0 { return }

        let fresh = (live["field"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
        // Same track + same set of cars → swap the picks in place (see
        // `onRedress`); anything else is a full teardown and rebuild.
        if handle != 0, track == self.track, sameCarSet(fresh, field) {
            field = fresh
            signature = sig
            onRedress?(fresh)
            return
        }

        stop()
        signature = sig
        field = fresh
        self.track = track
        start(field: fresh, track: track)
    }

    /// The two fields cover the exact same set of car ids, so only liveries,
    /// models or names could have changed — the cue to swap in place.
    private func sameCarSet(_ a: [[String: Any]], _ b: [[String: Any]]) -> Bool {
        guard a.count == b.count else { return false }
        let ids = Set(b.compactMap { $0["id"] as? String })
        return a.allSatisfy { ($0["id"] as? String).map(ids.contains) ?? false }
    }

    func stop() {
        tick?.cancel()
        tick = nil
        signature = nil
        field = []
        track = ""
        guard handle != 0 else { return }
        ttp_dispose(handle)
        handle = 0
        onSession?(0)
    }

    private func start(field: [Any], track: String) {
        // The ROSTER first, then the cars, then the bind. See `onField`: a slot
        // the roster does not name is a car nothing draws.
        onField?(field)
        // Laps are irrelevant to an attract race that nobody finishes; a seed of
        // 0 keeps it reproducible, which makes a lobby screenshot the same
        // picture twice. `begin_field` is the one construction road (the demo
        // grid is all bots, so every entry carries a spec). The persona rides
        // NESTED on the demo field entry (`ttp_race_demo_live_json`'s shape) —
        // reading caution/laneBias off the top level finds nothing and every
        // bot drives the default persona on the same wander seed. The web twin
        // (`LobbyDemo._buildEngine`) reads exactly these keys, and 0x5eed is
        // its DEMO_SEED: lobby determinism, distinct weave per grid slot.
        let rows = field.compactMap { entry -> [String: Any]? in
            guard let b = entry as? [String: Any] else { return nil }
            return ["peerIndex": b["id"] ?? NSNull(), "stats": b["stats"] ?? NSNull()]
        }
        let bots = field.enumerated().compactMap { i, entry -> [String: Any]? in
            guard let b = entry as? [String: Any] else { return nil }
            let persona = b["persona"] as? [String: Any] ?? [:]
            return ["peerIndex": b["id"] ?? NSNull(),
                    "caution": persona["caution"] ?? 1,
                    "laneBias": persona["laneBias"] ?? 0,
                    "seed": 0x5eed + i * 2 + 1]
        }
        handle = ttp_session_begin_field(track, 0, 3, nil, TTP.json(rows), TTP.json(bots))
        guard handle != 0 else { return }
        // BARE start (< 0): racing from frame 0, no countdown — the web's
        // `startBare()`. A countdown of ZERO is not the same thing: it still
        // runs the countdown state machine, whose GO rides the event drain,
        // and this demo deliberately never drains events (it is scenery) — so
        // the grid sat parked at the gantry forever, a track preview with no
        // ongoing race.
        ttp_session_start(handle, -1)
        onSession?(handle)

        // Its own clock rather than the display link's. The demo runs while the
        // welcome and lobby boards are up, which is exactly when the shell has no
        // reason to be doing anything at 60 Hz — 30 Hz is invisible on a slow
        // orbit and halves the work behind a static board.
        tick = Task { @MainActor [weak self] in
            var last = CACurrentMediaTime()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 33_000_000)
                guard let self, self.handle != 0, !Task.isCancelled else { return }
                let now = CACurrentMediaTime()
                // Clamped for the same reason the race loop clamps: a suspended
                // app must not resume by simulating the minutes it was away.
                ttp_update(self.handle, min(now - last, 0.05) * 1000)
                last = now
            }
        }
    }
}
