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

    private func shoot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
