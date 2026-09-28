import XCTest

/// Menu out of the lobby and back in, which is the road every viewer takes and
/// the one nothing automated had ever walked.
///
/// WHAT IT CAUGHT: the renderer refused EVERY frame for the rest of the process
/// after a Menu press — `0/60 fps, 60 skips`, the display link ticking normally
/// into a surface that never drew again, with no recovery from starting a race.
/// The frame loop had been running straight through the handover, so the frame
/// in flight when tvOS took the screen never completed and Filament's pacing
/// fence never signalled again (`DisplayHost.setPaused`).
///
/// THE ASSERTION IS A FRAME DIFF, not a screenshot to squint at. A still of the
/// frozen board is indistinguishable from a healthy one — same track, same
/// chrome, same everything — so this compares two frames seconds apart and
/// fails if the picture is byte-identical. The attract camera is always in
/// motion in the lobby, so two identical frames means nothing is being drawn.
///
/// IT MUST NOT LAUNCH THE APP. That is the whole reason this test exists in the
/// shape it does: a test-launched process did NOT reproduce the bug (tried
/// twice, both clean, through an app switch and through Menu), while the same
/// sequence on a `devicectl`-launched app froze every time. So the app has to be
/// running already, and `setUp` refuses rather than quietly passing against a
/// process it started itself.
///
///     xcrun devicectl device process launch --device <udid> games.couchpad.tinytrack
///     # wait for the lobby, then:
///     xcodebuild test -project shells/tvos/TinyTrackParty.xcodeproj -scheme TinyTrackParty \
///       -destination 'platform=tvOS,id=<xcodebuild-id>' \
///       -only-testing:TinyTrackPartyShots/LifecycleTests
///
/// NOT PART OF THE GALLERY RUN — `scripts/capture-shots-tvos.mjs` passes
/// `-only-testing:TinyTrackPartyShots/ShotTests`, so this file costs a capture
/// nothing. CI never runs it either: no runner has an Apple TV.
final class LifecycleTests: XCTestCase {

    /// Long enough for tvOS to settle either side of the transition. Clocks are
    /// wrong elsewhere in this target and right here: there is no "resumed"
    /// signal to wait on, and the question IS what the screen looks like some
    /// seconds later.
    private let settle: TimeInterval = 12
    private let dwell: TimeInterval = 6

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    func testMenuCycleKeepsTheSurfaceAlive() {
        let app = XCUIApplication()

        // PRECONDITION, not a formality: the ONE thing that must not be true is
        // that nothing is running, because then `activate()` below would LAUNCH
        // the app — and a test-launched process provably does not reproduce this
        // bug, so the run would pass without testing anything.
        //
        // Deliberately not pinned to a particular running state. The first
        // version of this demanded `.runningBackground` on the theory that the
        // runner's own launch had already put ours away, and it reported
        // `.runningForeground` instead — the transition had not landed by the
        // time the query ran. Which state a live app reports here is tvOS's
        // business; whether one exists at all is this test's.
        guard app.state != .notRunning, app.state != .unknown else {
            XCTFail("""
                the app must already be running before this test — start it with \
                `devicectl device process launch`, wait for the lobby, then run \
                this. Saw state \(app.state.rawValue); activating from here would \
                launch it, and a test-launched process does not reproduce the bug.
                """)
            return
        }

        app.activate()
        Thread.sleep(forTimeInterval: settle)
        attach(shot(), "ttp-life-1-settled")

        // EXACTLY WHAT A VIEWER DOES. Menu at the lobby root is not intercepted
        // (`RootView.backAction` leaves it to tvOS), so the app backgrounds and
        // `scenePhase` runs its course. Select re-enters from the app's own tile,
        // which Menu leaves focused.
        XCUIRemote.shared.press(.menu)
        Thread.sleep(forTimeInterval: dwell)

        // COMING BACK. Select is the viewer's own road — Menu leaves the app's
        // tile focused — and it is pressed first for that reason. But the focus
        // it depends on is the SYSTEM's, not ours: the Home screen does not
        // always leave that tile focused (a top-shelf row, a rearranged Home,
        // whatever tvOS did last), and when it does not, Select opens something
        // else or nothing and this test failed with "did not come back to the
        // foreground" while the surface it exists to guard was never examined.
        // Observed failing that way on tvOS 26.6 with the app healthy.
        //
        // `activate()` is the fallback and NOT a weakening: the guard above has
        // already established the app is running, and activate on a running app
        // RESUMES it — the same background-to-foreground handover the tile
        // performs, which is the transition the frozen surface came from. What
        // the precondition forbids is LAUNCHING one, and this cannot.
        XCUIRemote.shared.press(.select)
        Thread.sleep(forTimeInterval: dwell)
        if app.state != .runningForeground { app.activate() }
        Thread.sleep(forTimeInterval: settle)

        let first = shot()
        attach(first, "ttp-life-2-after")
        Thread.sleep(forTimeInterval: 4)
        let second = shot()
        attach(second, "ttp-life-3-after-plus-4s")

        XCTAssertEqual(app.state, .runningForeground, "did not come back to the foreground")
        XCTAssertNotEqual(
            first, second,
            """
            the picture did not change in 4 s — the surface is dead. Check the perf \
            readout in the attachments: `0/N fps, N skips` is the frame loop alive \
            and the renderer refusing everything, which is the regression this test \
            exists for.
            """)
    }

    private func shot() -> Data { XCUIScreen.main.screenshot().pngRepresentation }

    private func attach(_ png: Data, _ name: String) {
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
