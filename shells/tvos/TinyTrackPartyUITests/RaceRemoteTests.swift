import XCTest

/// The remote on a LIVE race: Menu and Play/Pause must pause it and resume it,
/// and neither may hand the press to tvOS.
///
/// WHY IT EXISTS. Every remote command rides the focus chain, and a live race
/// shows nothing focusable — the HUD is display-only on purpose. With no focused
/// view the press never reached `.onExitCommand`, so Menu went to tvOS: the app
/// backgrounded, `suspend()` closed the room, and one press ended the party for
/// every phone instead of pausing (`RootView`'s race focus park is the fix).
///
/// THE RACE MUST ALREADY BE RUNNING, started by phones over the real relay —
/// `npm run check:tvos-race-remote` does that and then runs this. A scenario
/// race is relay-less and its room never leaves the lobby, so the pause walk
/// refuses it and the test would prove nothing. So, like `LifecycleTests`, this
/// activates the running app and refuses to launch one.
final class RaceRemoteTests: XCTestCase {

    /// Long enough for the overlay's fade and for tvOS to background an app.
    private let settle: TimeInterval = 3

    func testMenuAndPlayPausePauseALiveRace() {
        let app = XCUIApplication()
        guard app.state != .notRunning, app.state != .unknown else {
            XCTFail("start a race first (npm run check:tvos-race-remote); saw state \(app.state.rawValue)")
            return
        }
        app.activate()
        Thread.sleep(forTimeInterval: settle)
        let paused = app.staticTexts["Paused"]
        XCTAssertFalse(paused.exists, "premise: the race is live, not paused")

        for (button, name) in [(XCUIRemote.Button.menu, "menu"),
                               (XCUIRemote.Button.playPause, "playpause")] {
            XCUIRemote.shared.press(button)
            Thread.sleep(forTimeInterval: settle)
            attach("ttp-remote-\(name)-1")
            XCTAssertEqual(app.state, .runningForeground,
                           "\(name) on a live race must not hand the press to tvOS")
            XCTAssertTrue(paused.exists, "\(name) on a live race pauses it")

            XCUIRemote.shared.press(button)
            Thread.sleep(forTimeInterval: settle)
            attach("ttp-remote-\(name)-2")
            XCTAssertEqual(app.state, .runningForeground, "\(name) on the pause overlay stays in the app")
            XCTAssertFalse(paused.exists, "\(name) on the pause overlay resumes the race")
        }
    }

    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
