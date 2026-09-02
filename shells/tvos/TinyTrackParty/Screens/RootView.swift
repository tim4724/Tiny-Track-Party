import SwiftUI

// The app, and the screen switcher.
//
// Two jobs and no third: stand the coordinator up, and put whichever board
// `GameState.screen` names over the Metal surface. **It owns no game logic.**
// Every action below is a call into `GameCoordinator`, and every decision behind
// those calls is already `ttp_ui.h`'s or `ttp_race.h`'s — including what the
// Menu button means, which is `ttp_ui_back_effect`'s answer and not a switch in
// this file.
//
// WHAT DELIBERATELY DID NOT PORT: the web's `suppressPopstate` and
// `popstateNavigating` flags (`main.js`). They exist only to tame the History
// API — "the `history.back()` about to fire is ours" and "this `show()` IS a
// back-retreat" — and there is no History API here. The back-stack TRAVERSAL
// never crossed the ABI either; only the TABLE did. A tvOS shell has one button,
// one call, and nothing to coordinate.

// MARK: - The app

@main
struct TinyTrackPartyApp: App {

    /// The one object that owns the game. `@StateObject` so it survives every
    /// view-tree rebuild: it holds the Filament display, the relay socket and
    /// the live session, none of which may be recreated because SwiftUI felt
    /// like re-evaluating a body.
    ///
    /// The origin is `GameProtocol.defaultBaseURL` — the `TTPBaseURL` Info.plist
    /// key if a build sets one, else the branch preview deploy. A TV app has no
    /// origin of its own, and the phones have to load the controller from
    /// somewhere.
    @StateObject private var game = GameCoordinator(baseURL: GameProtocol.defaultBaseURL)

    init() {
        // BEFORE the first view body, and that ordering is the whole reason this
        // init exists. SwiftUI evaluates a body before the `.task` that runs
        // `boot()`, so loading the palette there means the first board asks for
        // `--ink-2` while the table is still empty — which trips the missing-token
        // assertion and takes the app down on launch. Loading it here costs one
        // bundle read on a path that has nothing else to do.
        Tokens.load()
    }

    /// The app's own visibility, and the closest thing this platform has to
    /// `pagehide` — see `GameCoordinator.suspend()` for why the party ends here
    /// rather than on termination.
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup { RootView(game: game) }
            .onChange(of: scenePhase) { _, phase in
                // TWO LIFETIMES, and they end on different phases.
                //
                // THE PARTY ends on `.background` only. `.inactive` is the
                // transient state tvOS passes through in BOTH directions (and
                // while a system overlay is up), so tearing the room down there
                // would end a party every time a dialog appeared.
                //
                // THE FRAME LOOP idles on `.inactive`, which is EARLIER on
                // purpose: a backgrounded app may not drive Metal, and by the
                // time `.background` arrives the screen is already gone. Running
                // through the handover is what killed the surface permanently —
                // see `DisplayHost.setPaused`. Waking it is the mirror, after
                // `resume()` has restaged the lobby so the first frame drawn is
                // of the fresh room rather than the dead one.
                switch phase {
                case .background:
                    game.display.setPaused(true)
                    game.suspend()
                case .inactive:
                    game.display.setPaused(true)
                case .active:
                    game.resume()
                    game.display.setPaused(false)
                @unknown default:
                    break
                }
            }
    }
}

// MARK: - The switcher

@MainActor
struct RootView: View {

    let game: GameCoordinator
    @ObservedObject private var state: GameState

    /// The screenshot harness's signal, held as view state rather than read off
    /// `Scenarios.ready` directly: a static is not observable, so a board that
    /// is otherwise idle (the welcome title, which publishes nothing) would
    /// never re-render to attach the identifier and every shot of it would time
    /// out.
    @State private var shotReady = false

    /// Set when the requested scenario is not a screen on this platform. The
    /// runner reads it as a distinct identifier and skips, rather than timing out
    /// on a readiness flag that is never coming.
    @State private var unsupportedScenario = false

    init(game: GameCoordinator) {
        self.game = game
        _state = ObservedObject(wrappedValue: game.state)
    }

    var body: some View {
        ZStack {
            // The 3D, always at the bottom and never torn down. **The shell
            // never hides this surface**: `sceneVisible` is not a switch on the
            // renderer, it is what each BOARD reads to decide whether its own
            // opaque paper is in front (the welcome board's always is; the
            // lobby fades its own). A shell that stopped the frame loop to
            // "hide" the scene would also stop the attract race the lobby is
            // showing.
            MetalHostView(host: game.display)
                .ignoresSafeArea()

            // The crossfade is a conditional INSERTION, not an opacity ramp over
            // views that stay in the tree. On a TV that distinction is the whole
            // ball game: a view at `.opacity(0)` is still focusable, so an
            // invisible START button would keep eating remote presses from
            // behind the board that replaced it.
            switch state.screen {
            case .welcome:
                // UNREACHABLE ON THIS PLATFORM, and kept only because the screen
                // enum mirrors the model's (`ui_model.cc`) rather than this
                // shell's. The welcome board exists on the web to collect a user
                // GESTURE — the one that unlocks an AudioContext and enters
                // fullscreen — and a TV has neither restriction, so a title card
                // with a single NEW GAME button would be a press between the
                // viewer and the room code for nothing. `boot()` goes straight to
                // the lobby. Rendering the lobby here too keeps the switch total
                // without inventing a board.
                lobby
            case .lobby:
                lobby
            case .race:
                raceChrome
                    .transition(.opacity)
            }

            // OVER THE SCREEN SWITCH AND NOT INSIDE A BOARD, which is the whole
            // reason it is here rather than in `raceChrome` where it began. The
            // boot cover's job is the LOBBY — that is the board this shell
            // starts on, and `ttp_ui_cover` names both — so a cover nested in
            // the race chrome is a cover that is never in the tree when it is
            // wanted. It cost five seconds of bare paper diorama on every cold
            // launch.
            CoverView(cover: state.cover)

            // Inert while hidden — it instruments nothing and draws nothing
            // until `game.display.perf.show()` is called. ABOVE the cover on
            // purpose: it is an instrument, and a boot it cannot see is the boot
            // most worth measuring.
            PerfOverlay(monitor: game.display.perf)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        }
        .animation(.easeInOut(duration: 0.35), value: state.screen)
        .task {
            await game.boot()
            // The frame loop, started once the engine is configured.
            // `CADisplayLink` from here on; the surface may or may not have
            // attached yet (that happens in UIKit layout), and a frame with no
            // display is a safe no-op by ABI contract.
            game.display.start()
            await standUpScenario()
        }
        // The Menu button. The TABLE crossed the ABI, the WALK did not, so this
        // is one call and the coordinator dispatches it. It rides the FOCUS
        // CHAIN like every remote command, which is one more reason every board
        // owes the engine something focusable.
        .onExitCommand(perform: backAction)
        // The remote's Play/Pause is this platform's pause button (`#pause-btn`
        // on the web, which has no tvOS analogue — there is no corner of the
        // screen a viewer can click). Both directions are gated by the model.
        .onPlayPauseCommand { togglePause() }
        // What the screenshot harness waits on. Attached to the root so it is a
        // container element the test can find by identifier, and empty until the
        // screen has actually stood up.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(
            unsupportedScenario ? Scenarios.unsupportedIdentifier
                : shotReady ? Scenarios.readyIdentifier : "")
    }

    /// The screenshot harness's entry point, and the only thing in the shipping
    /// binary that reads a launch argument.
    ///
    /// It is compiled in rather than kept behind a build flag because the shots
    /// have to be of the SHIPPING binary to mean anything (`ShotTests.swift`);
    /// `Scenarios.requested` is nil in every normal launch, so this returns
    /// immediately and nothing below ever runs in a party.
    private func standUpScenario() async {
        guard let id = Scenarios.requested else { return }
        // THE SURFACE FIRST. A scenario stands its screen up through the same
        // calls the live game makes, and the live game makes them long after
        // UIKit layout has attached the display — a scenario at boot beats the
        // layout pass, and every latched push it makes lands on a display that
        // does not exist yet. (DisplayHost re-pushes latched state on attach
        // now, but a harness should not lean on the recovery path.)
        for _ in 0..<200 where !game.display.isAttached {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        guard Scenarios.apply(id, to: game) else {
            // A scenario this PLATFORM does not have (the welcome board, which
            // exists on the web only to collect a browser gesture) or one it does
            // not know. Either way the runner must SKIP it rather than wait 30 s
            // and fail: a gallery card with no tvOS shot is the honest record of
            // a deliberate difference, and a red test would train everyone to
            // ignore the suite.
            state.lastError = "no such screen here: \(id)"
            unsupportedScenario = true
            return
        }
        // WAIT ON SOMETHING, NOT ON NOTHING. The UI test waits for this flag
        // rather than sleeping, precisely so a shot is never taken through a
        // cold Metal shader compile. What is waited on is the surface and the
        // scenario's own scene plus a settle, which is a FLOOR and not a proof.
        // If shots ever come back half-drawn, the honest fix is a "frames
        // presented" counter on `DisplayHost` and a wait on that — do not
        // lengthen the sleep, which only makes the suite slower at the same
        // odds. (No second `isAttached` loop here: the wait above already
        // cleared it and nothing ever detaches a display.)
        //
        // THE SCENARIO'S OWN SCENE, not whichever scene was up before it.
        // A race scenario's launch rebuilds asynchronously (SceneStaging
        // releases the old scene, fetches, then builds with the race's
        // roster), so `hasScene` is briefly the PREVIOUS build's answer. The
        // first sleep is one beat for that release to run; the loop then waits
        // for the new build to land. Photographing between the two is how
        // every race shot came out an empty overview: the cells named the
        // race's cars while the surface still held a scene without them.
        try? await Task.sleep(nanoseconds: 300_000_000)
        for _ in 0..<200 where !game.display.hasScene {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        // Last, on a settled screen: see `Scenarios.settle` for the one thing
        // that cannot be written any earlier.
        await Scenarios.settle(id, to: game)
        Scenarios.ready = true
        shotReady = true
    }

    // MARK: - The lobby, and the only thing the remote can push

    /// The lobby owns a `NavigationStack` so the ⓘ's info board and the license
    /// pages behind it are PUSHED destinations: tvOS seats focus on each page as
    /// it arrives, restores it on the way back, and pops on Menu — all of which
    /// this shell would otherwise have to write, badly.
    ///
    /// Menu is deliberately not intercepted for these pages. `backAction` reads
    /// `ttp_ui_back_effect`, which answers for the SCREEN (the lobby is this
    /// shell's root, so it declines and tvOS gets the press); the pushed pages
    /// are not screens the model knows about, and the stack pops them itself.
    /// Popping here as well is the trap the sibling shell hit: the root's
    /// handler fires on press-BEGAN and the stack's on press-ENDED, so a single
    /// press fell through two levels.
    ///
    /// The path is `GameState`'s, not this view's, so a race starting under the
    /// info board takes it down (`GameCoordinator.show`).
    private var lobby: some View {
        NavigationStack(path: $state.infoPath) {
            LobbyView(state: state)
                .navigationDestination(for: GameState.InfoRoute.self) { route in
                    switch route {
                    case .info: InfoView()
                    case .licenses: LicensesView()
                    case .license(let index): LicenseTextView(index: index)
                    }
                }
        }
        .transition(.opacity)
    }

    // MARK: - The race screen

    /// Everything over a live race, in the web's z-order: the per-cell chrome
    /// under the banners, the results board over those, and the pause overlay
    /// over everything (it is a modal, and the only one).
    private var raceChrome: some View {
        ZStack {
            RaceHUDView(cells: state.cells, boostAccent: state.boostAccent,
                        itemPickupTick: state.itemPickupTick)

            CountdownView(text: state.countdown)

            if let results = state.results {
                RaceResultsView(view: results,
                                intermissionSecs: state.intermissionSecs,
                                onNextRace: { game.advanceSeriesRace() },
                                onNewGame: { game.returnToLobby() },
                                onSettled: { game.settleStandings() })
                    .transition(.opacity)
            }

            if state.paused {
                PauseOverlay(onContinue: { setPaused(false) },
                             onNewGame: { game.returnToLobby() })
                    .transition(.opacity)
            }
        }
        // Each overlay fades on its OWN value. The results trigger is whether
        // there is a board at all — which is exactly when the transition runs,
        // rather than on every row or phase change of a standing board.
        .animation(.easeOut(duration: 0.25), value: state.results == nil)
        .animation(.easeOut(duration: 0.2), value: state.paused)
    }

    // MARK: - The two remote buttons

    /// What Menu does here, or nil to let tvOS have it.
    ///
    /// `ttp_ui_back_effect` answers `swallow` | `end-party` | `pause-race` |
    /// `resume-race` | `return-to-lobby`, and the coordinator performs it. Two
    /// things are decided HERE, and the ledger explicitly leaves both to the
    /// product:
    ///
    /// A swallowed Menu is handed back to the system rather than eaten, because
    /// a TV viewer pressing Menu at a root expects the Home screen.
    ///
    /// And on this platform the LOBBY is that root. The web has the welcome
    /// board behind it, so its Menu means "end the party and go back one"; this
    /// shell dropped that board (see the switch above), so there is nothing
    /// behind the lobby to go back to and Menu belongs to tvOS. The party still
    /// ends the moment the app leaves the screen — `scenePhase == .background`
    /// above calls `GameCoordinator.suspend()`, which is this platform's
    /// pagehide. NOT on termination: tvOS suspends a backgrounded app and may
    /// kill it later without ever delivering one.
    private var backAction: (() -> Void)? {
        switch TTP.strOrEmpty(ttp_ui_back_effect(state.screen.rawValue,
                                                 state.paused ? 1 : 0,
                                                 game.raceEnded ? 1 : 0)) {
        // A live race freezes rather than navigating: the overlay's own New
        // game is the way out, so no single press throws a race away. Through
        // setPaused, so Menu takes the same road as the Play/Pause button.
        case "pause-race": return { setPaused(true) }
        case "resume-race": return { setPaused(false) }
        case "return-to-lobby": return { game.returnToLobby() }
        default: return nil   // "swallow", and "end-party" at this shell's root
        }
    }

    /// Freeze or thaw from the remote.
    private func togglePause() { setPaused(!state.paused) }

    /// One entry point, so the overlay's Continue button and BOTH remote
    /// buttons (Play/Pause, and Menu on a live race) take the same road as a
    /// phone's PAUSE_GAME: the pause/resume WALKS, whose verdicts
    /// (`ttp_ui_can_pause` / `can_resume`) are asked inside and whose op order
    /// is the contract.
    private func setPaused(_ on: Bool) {
        if on { game.pauseRace() } else { game.resumeRace() }
    }
}
