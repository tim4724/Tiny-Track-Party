import XCTest

/// Photographs the staged race SEVERAL TIMES OVER ITS RUN, for the rubber
/// layer's accumulation evidence — the thing a single gallery shot cannot show.
///
/// One stamp proves nothing (the uvviz lesson: probes saturate at one stamp);
/// the only accumulation evidence is lap-over-lap ink in the SAME spot growing
/// darker and denser. The web reference is scripted the same way
/// (web-skid-verify: shots at ~8/30/60/90 s of `?scenario=racing`), so a
/// device shot and a web shot at the same beat are directly comparable.
///
/// Not part of the gallery run: `scripts/capture-shots-tvos.mjs` passes
/// `-only-testing:TinyTrackPartyShots/ShotTests`, so this is reached only by an
/// explicit `-only-testing:TinyTrackPartyShots/SkidShotTests`.
///
/// That flag is what makes the sentence true, and it was missing until
/// 2026-08-15 — `xcodebuild test` ran the whole target, so every gallery capture
/// paid this file's 90 s of sleeps and `RealRaceShotTests`' five minutes. The
/// TARGET is `TinyTrackPartyShots` (project.yml); `TinyTrackPartyUITests` is the
/// source directory, and a selector spelled that way silently matches nothing.
final class SkidShotTests: XCTestCase {

    func testSkidAccumulation() throws {
        let app = XCUIApplication()
        // Sidewinder: hairpins force scrub skids on every bot, every lap — the
        // same circuit the web gallery's deck-decal card pins.
        app.launchArguments = ["-ttpScenario", "racing", "-ttpTrack", "sidewinder"]
        app.launch()

        let ready = app.otherElements["ttp-ready"]
        XCTAssertTrue(ready.waitForExistence(timeout: 60), "the app never signalled ready")

        var last = 0
        for t in [8, 30, 60, 90] {
            Thread.sleep(forTimeInterval: TimeInterval(t - last))
            last = t
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "ttp-skid-t\(t)"
            shot.lifetime = .keepAlways
            add(shot)
        }
        app.terminate()
    }
}
