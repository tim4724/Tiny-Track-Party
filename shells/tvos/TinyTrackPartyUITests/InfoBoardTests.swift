import XCTest

/// Drives the remote through the lobby's ⓘ and the boards behind it.
///
/// The gallery runner photographs screens that STAND THEMSELVES UP and touches
/// no remote (see ShotTests). This one has to press buttons, because what it is
/// checking only exists as a sequence of presses: that the lobby does NOT open
/// with the ⓘ focused, that one move of the d-pad reaches it, and that Menu
/// walks back out of the boards it pushes rather than quitting the app or
/// falling through two pages at once.
///
/// Those are exactly the things a screenshot cannot show and a unit test cannot
/// reach — focus is the platform's, not this shell's, and both of the failure
/// modes above shipped in the sibling TV shell before they were pinned here.
///
/// Not part of the gallery run: reached by an explicit
/// `-only-testing:TinyTrackPartyShots/InfoBoardTests`, like SkidShotTests.
final class InfoBoardTests: XCTestCase {

    /// Comfortably more presses than the list has rows (it grows with the music
    /// catalogue), so Down ends on the last one wherever it is. Extra presses at
    /// the end of a list are no-ops.
    private static let pressesPastTheEnd = 80

    func testInfoBoardIsRemoteOnlyAndUnfocusedAtRest() throws {
        let app = XCUIApplication()
        // A gallery id, not a web harness KEY: `lobby` was neither, and had
        // silently become "no such screen here" the day the harness's cases were
        // retargeted at the real table.
        app.launchArguments = ["-ttpScenario", "lobby-empty"]
        app.launch()

        XCTAssertTrue(app.otherElements["ttp-ready"].waitForExistence(timeout: 90),
                      "the app never signalled ready")

        let info = app.buttons["info-button"]
        XCTAssertTrue(info.waitForExistence(timeout: 10), "no ⓘ on the lobby")

        // THE POINT OF THE BOARD: a room reading the join code off the TV must
        // not be looking at a focus ring in the corner.
        XCTAssertFalse(info.hasFocus, "the lobby opened with the ⓘ focused")
        shoot("ttp-info-lobby-at-rest")

        // One move of the d-pad from the parked stop reaches the corner. This is
        // what the top band's .focusSection() buys: without it the move projects
        // a vertical beam that misses a far-corner target.
        XCUIRemote.shared.press(.up)
        XCTAssertTrue(info.hasFocus, "d-pad Up did not reach the ⓘ")
        shoot("ttp-info-lobby-focused")

        XCUIRemote.shared.press(.select)
        let licenses = app.buttons["licenses-link"]
        XCTAssertTrue(licenses.waitForExistence(timeout: 10), "the ⓘ did not open the info board")
        XCTAssertTrue(licenses.hasFocus, "the info board's only control is not focused")
        shoot("ttp-info-board")

        XCUIRemote.shared.press(.select)
        XCTAssertTrue(app.staticTexts["Licenses"].waitForExistence(timeout: 10),
                      "the licenses board did not open")
        shoot("ttp-info-licenses")

        // Down past the end of the list lands on the LAST row, which is the last
        // Software credit — a notice-bearing one, because the tvOS-only packages
        // are appended there (gen-legal.mjs). Walking to it rather than indexing
        // a row keeps this from rotting every time a song joins a biome pool.
        for _ in 0..<(Self.pressesPastTheEnd) { XCUIRemote.shared.press(.down) }
        XCTAssertTrue(app.staticTexts["Licenses"].exists, "a d-pad move pushed a page")
        // A focused NOTICE row, which is a different view from a focused music
        // row (a link, not a plain focusable) and therefore a second focus
        // dressing to look at. The first cut of this screen shipped the system's
        // own focus background here, under the sticker.
        shoot("ttp-info-licenses-notice-row")

        XCUIRemote.shared.press(.select)
        // The zlib text is SwiftDraw's, and this line is in it. Matching the
        // text rather than the title proves the staged notice was found and read
        // out of the bundle, which is the whole obligation.
        let text = app.staticTexts.containing(NSPredicate(
            format: "label CONTAINS 'This software is provided'")).firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 10),
                      "the license text page did not show its notice")
        shoot("ttp-info-license-text")

        // Menu walks back one board per press, and the stack is what does it —
        // a shell that also popped would fall through two levels on one press.
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(app.staticTexts["Licenses"].waitForExistence(timeout: 10),
                      "Menu did not come back to the licenses board")

        // EVERY ROW OPENS, and a MUSIC row is what proves it: those owe no
        // notice, so what they open is the licence's own text rather than a
        // notice of their own (`shells/licenses/`, resolved by
        // scripts/shell-credits.mjs). This board used to leave them inert, which
        // meant the majority of the list named a licence the room could not
        // read — a browser gets a link on every chip and a television gets
        // nothing. Walking back up rather than indexing a row, for the same
        // reason the walk down does.
        for _ in 0..<(Self.pressesPastTheEnd) { XCUIRemote.shared.press(.up) }
        XCUIRemote.shared.press(.select)
        // The first line of the CC-BY 4.0 legal code. Matching the TEXT rather
        // than the row's title is what proves the staged file was found and read
        // out of the bundle.
        let ccby = app.staticTexts.containing(NSPredicate(
            format: "label CONTAINS 'Attribution 4.0 International'")).firstMatch
        XCTAssertTrue(ccby.waitForExistence(timeout: 10),
                      "a CC-BY row did not open the licence text")
        shoot("ttp-info-license-text-cc-by")

        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(app.staticTexts["Licenses"].waitForExistence(timeout: 10),
                      "Menu did not come back from the licence text")
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(licenses.waitForExistence(timeout: 10),
                      "Menu did not come back to the info board")
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(info.waitForExistence(timeout: 10), "Menu did not come back to the lobby")
        XCTAssertEqual(app.state, .runningForeground, "Menu quit the app instead of popping")
    }

    private func shoot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
