import XCTest

/// Menu out of the lobby, then back in — the one road every viewer takes and
/// the only one no automated surface covered.
///
/// It is worth its own file because this shell has now produced two bugs on it,
/// and neither was visible from a screenshot of a board: the relay socket whose
/// deferred close landed after the wake and detached the fresh connection, and a
/// reported freeze on reopening. `suspend()`/`resume()` are tvOS's
/// `pagehide`/`pageshow` and they run on every Menu press at the lobby root,
/// because `RootView.backAction` deliberately does not intercept it there
/// (nothing is behind the lobby, so Menu belongs to tvOS).
///
/// WHAT IT CAUGHT, and the shape of it, because the next one will look the same:
/// after a Menu press the renderer refused EVERY frame for the rest of the
/// process — `0/60 fps, 60 skips`, a link ticking normally into a dead surface,
/// with no recovery from starting a race. The cause was the frame loop running
/// straight through the handover (`DisplayHost.setPaused`). A still picture of
/// that board looks exactly like a healthy one; only the readout and a
/// frame-to-frame diff tell them apart, which is why this file photographs a
/// BURST rather than a frame.
///
/// THE PERF READOUT IS THE INSTRUMENT, and it separates failures a still picture
/// otherwise cannot:
///   * `0/60 fps, 60 skips` — the frame loop lives and the renderer is refusing
///     every frame, so the surface is stale (swap chain / Metal device).
///   * numbers frozen at their pre-Menu values — the loop stopped, or the main
///     thread is wedged.
///   * healthy `60/60` over a stale picture — drawing fine, composited wrong.
///
/// A BARE LAUNCH, NOT A SCENARIO: the boot path is what a viewer takes, and it
/// is also why there is no `ttp-ready` to wait on — that identifier is set by
/// the scenario harness, so on this road it never appears and waiting for it
/// only buys its own timeout. The settles below are therefore clocks, which is
/// wrong everywhere else in this target and right here: the question being asked
/// IS "what does it look like N seconds later".
final class LifecycleTests: XCTestCase {

    /// Long enough for a cold boot to reach the attract scene on an A10X.
    private let bootSettle: TimeInterval = 25
    /// The REPORTED dwell: "a few seconds". Two longer runs (4 s and 40 s) both
    /// came back clean, so this matches the report rather than hunting.
    private let backgroundDwell: TimeInterval = 6
    private let resumeSettle: TimeInterval = 10

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    func testMenuOutAndBack() {
        let app = XCUIApplication()
        app.launch()
        Thread.sleep(forTimeInterval: bootSettle)
        shoot("ttp-life-1-before")

        // EXACTLY WHAT A VIEWER DOES. Menu at the lobby root is not intercepted,
        // so tvOS backgrounds the app and `scenePhase` delivers `.background`.
        XCUIRemote.shared.press(.menu)
        Thread.sleep(forTimeInterval: backgroundDwell)
        shoot("ttp-life-2-home")

        // SELECT ON THE ICON, not `app.activate()`. Menu leaves the app's own
        // tile focused, so this is the viewer's road back in; `activate()` is a
        // programmatic foreground and need not take the same one.
        XCUIRemote.shared.press(.select)

        // A BURST, not one shot at the end. "Frozen" was reported by someone who
        // did not wait, and a single late frame cannot tell a hang from a slow
        // wake — tvOS shows the app's LAST FRAME while it comes back
        // (`GameCoordinator.clearJoinTicket` names this), so a stale picture is
        // the expected face of a resume that is merely taking its time. These
        // are cumulative offsets from the press; comparing them says how many
        // seconds a viewer stares at a still.
        var elapsed: TimeInterval = 0
        for at in [1.0, 2.0, 3.0, 5.0, 8.0, 12.0] {
            Thread.sleep(forTimeInterval: at - elapsed)
            elapsed = at
            shoot("ttp-life-3-after-t\(Int(at))")
        }

        XCTAssertEqual(app.state, .runningForeground, "the app did not come back to the foreground")
    }

    /// Resume an app THIS TEST DID NOT LAUNCH, and photograph what comes back.
    ///
    /// The distinction is the whole point. `testMenuOutAndBack` above launches
    /// through `XCUIApplication`, and twice came back perfectly clean — while
    /// the same sequence performed by hand froze every time. A test-launched
    /// process is not the process a viewer has: it is started by the runner with
    /// instrumentation attached, and that is a difference the app can feel.
    ///
    /// So this one launches NOTHING. The app is expected to be running already
    /// (`devicectl device process launch`, as the host script does), the runner
    /// coming up backgrounds it, and `activate()` brings that SAME pid back —
    /// which is precisely Menu-and-return. Verify the pid did not change on the
    /// host side; if it did, this test proved nothing.
    func testResumeAlreadyRunning() {
        let app = XCUIApplication()
        // Backgrounded by the runner's own launch. Give tvOS a moment to have
        // actually delivered `.background` before asking for it back.
        Thread.sleep(forTimeInterval: 5)
        shoot("ttp-res-1-before-activate")

        app.activate()

        // The burst again: "frozen" from someone who did not wait cannot be told
        // from a slow wake by one late frame.
        var elapsed: TimeInterval = 0
        for at in [1.0, 2.0, 4.0, 8.0, 14.0] {
            Thread.sleep(forTimeInterval: at - elapsed)
            elapsed = at
            shoot("ttp-res-2-t\(Int(at))")
        }

        XCTAssertEqual(app.state, .runningForeground, "did not come back to the foreground")
    }

    /// The last untested combination, and the one a viewer actually performs: an
    /// app THIS TEST DID NOT LAUNCH, put away with MENU, brought back with
    /// SELECT.
    ///
    /// Three earlier reproductions each varied one leg and all came back clean —
    /// test-launched + app-switch, test-launched + Menu, devicectl-launched +
    /// app-switch. Menu to the Home screen is not the same transition as another
    /// app taking the foreground, and a test-launched process is not the one a
    /// viewer has; this is the pairing neither of those covered.
    func testMenuCycleOnRunningApp() {
        let app = XCUIApplication()
        Thread.sleep(forTimeInterval: 5)   // the runner's own launch put ours away
        app.activate()
        Thread.sleep(forTimeInterval: 12)  // fully settled, attract running
        shoot("ttp-mc-0-settled")

        XCUIRemote.shared.press(.menu)
        Thread.sleep(forTimeInterval: 6)
        XCUIRemote.shared.press(.select)

        var elapsed: TimeInterval = 0
        for at in [2.0, 6.0, 12.0, 18.0] {
            Thread.sleep(forTimeInterval: at - elapsed)
            elapsed = at
            shoot("ttp-mc-1-t\(Int(at))")
        }
    }

    /// The BOOT, frame by frame: what stands on screen from the first moment to
    /// the settled lobby, and what the paper-to-3D handover actually looks like.
    ///
    /// Two reports this is chasing, neither of which a settled screenshot can
    /// show. The initial background reads as the wrong shape ("21:9 or
    /// something") — `PaperStage` lays every element out as a fraction of
    /// `geo.size`, so a first pass with the wrong box puts the horizon at the
    /// wrong height and `RootView`'s boot task can hold that pass on screen for
    /// as long as it runs. And the handover itself reads as off, which it may
    /// well be: the reveal now waits for `hasPainted`, so the scene arrives
    /// finished and the paper dissolves OFF it rather than one crossfading into
    /// the other.
    ///
    /// Launched through XCUITest deliberately, unlike the resume tests: the boot
    /// path does not depend on who started the process, and only the RESUME did.
    func testBootBurst() {
        let app = XCUIApplication()
        app.launch()
        var elapsed: TimeInterval = 0
        for ms in [200, 600, 1200, 2000, 3500, 6000, 10000, 16000, 24000] {
            let at = TimeInterval(ms) / 1000
            Thread.sleep(forTimeInterval: max(0, at - elapsed))
            elapsed = at
            shoot(String(format: "ttp-boot-t%05d", ms))
        }
    }

    /// A REAL cold boot, photographed from the first moment.
    ///
    /// `XCUIApplication.launch()` cannot take this picture: it returns only once
    /// the app has gone idle, so a burst started after it is already looking at a
    /// settled lobby (measured — the frame 200 ms "after launch" had the attract
    /// scene up and a room code on it). The remote does not wait, so the launch
    /// goes through the Home screen's own tile instead and the burst starts
    /// while the app is genuinely coming up.
    func testColdBootFromHome() {
        let app = XCUIApplication()
        app.launch()          // ensure installed and settled...
        app.terminate()       // ...then gone, so the next launch is cold
        Thread.sleep(forTimeInterval: 2)

        XCUIRemote.shared.press(.menu)   // the runner steps aside to Home
        Thread.sleep(forTimeInterval: 3)

        // WALK TO OUR TILE. Menu lands on the top shelf's first tile, not on the
        // app that was last used — the first run of this test photographed ten
        // frames of the Home screen because Select was pressed on a placeholder.
        // The grid is stable on this box: our tile is the fourth of the third
        // row. Fragile by nature, which is why the frame below proves what was
        // focused before anything is concluded from the burst.
        for _ in 0..<2 { XCUIRemote.shared.press(.down); Thread.sleep(forTimeInterval: 0.6) }
        for _ in 0..<3 { XCUIRemote.shared.press(.right); Thread.sleep(forTimeInterval: 0.6) }
        Thread.sleep(forTimeInterval: 1)
        shoot("ttp-cold-t00000-home")

        XCUIRemote.shared.press(.select)
        var elapsed: TimeInterval = 0
        for ms in [300, 700, 1200, 2000, 3000, 4500, 6500, 9000, 13000, 20000] {
            let at = TimeInterval(ms) / 1000
            Thread.sleep(forTimeInterval: max(0, at - elapsed))
            elapsed = at
            shoot(String(format: "ttp-cold-t%05d", ms))
        }
    }

    private func shoot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
