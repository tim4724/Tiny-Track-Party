import XCTest

/// Photographs every gallery scenario on whatever destination `xcodebuild` was
/// pointed at, and attaches each shot to the result bundle.
///
/// This is the only way to screenshot a real Apple TV. `xcrun devicectl device`
/// has no screenshot verb — `strings devicectl | grep -i screenshot` returns
/// nothing — and `simctl io screenshot` covers the simulator alone. The device
/// does advertise `com.apple.coredevice.feature.viewdevicescreen`, but that is
/// Xcode's interactive mirroring window with no command-line entry point.
///
/// The one assumption that could have killed the approach was checked on the
/// hardware first: **`XCUIScreen.main.screenshot()` captures CAMetalLayer
/// contents composited with the UIKit chrome over it.** A magenta-clearing Metal
/// view under a white label came back as a magenta PNG with the label on top,
/// from the physical A10X box. That is what makes this a picture of the SCREEN
/// rather than of the SwiftUI layer, and it is why the alternative (Filament
/// `readPixels` posted to a dev server) was rejected: that captures the 3D and
/// none of the HUD, which is the half this gallery exists to check.
///
/// IT DRIVES NOTHING THROUGH THE REMOTE. Each scenario is a launch argument the
/// app's own harness stands the screen up from, mirroring `?scenario=` on the
/// web. Walking the real lobby with `XCUIRemote` presses would be slow, flaky,
/// and would photograph a different thing on a slow build.
final class ShotTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    func testCaptureScreens() throws {
        // COMPILED IN, not passed. `shells/tvos/scripts/gen-scenarios.mjs` bakes
        // this list from `public/shared/galleryScenarios.js` — the same module
        // the live web gallery, the web capture and the coverage test read — so
        // it is still single-sourced.
        //
        // It is not an environment variable because one does not arrive: a
        // device run reaches `ProcessInfo.processInfo.environment` with no TTP
        // key under either the plain or the `TEST_RUNNER_` spelling. Filtering
        // (`--only`) happens on the HOST after export instead, which costs a few
        // seconds of extra launches and removes a failure mode that reads as
        // "nothing to capture" when it is really "the setting never came".
        let scenarios = ShotScenarios.all
        XCTAssertFalse(scenarios.isEmpty, "the generated scenario list is empty")

        for id in scenarios {
            let app = XCUIApplication()
            app.launchArguments = ["-ttpScenario", id]
            app.launch()

            // WAIT ON THE APP, NEVER ON A CLOCK. The harness sets this identifier
            // once the screen has actually been standing for a few frames; a bare
            // sleep photographs a cold Metal shader compile about one run in five
            // and fills the gallery with half-loaded scenes that look plausible
            // enough that nobody catches them.
            // A screen this platform does not have reports itself immediately
            // and is SKIPPED, not failed: the web's welcome board exists only to
            // collect a browser gesture, so there is nothing here to photograph
            // and the gallery showing one column for it is correct.
            if app.otherElements["ttp-unsupported"].waitForExistence(timeout: 3) {
                app.terminate()
                continue
            }
            let ready = app.otherElements["ttp-ready"]
            if !ready.waitForExistence(timeout: 30) {
                XCTFail("\(id): the app never signalled ready")
                app.terminate()
                continue
            }

            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            // The name survives into the exported manifest's
            // suggestedHumanReadableName, which is how the capture script renames
            // each file back onto its scenario without guessing at ordering.
            shot.name = "ttp-\(id)"
            // LOAD-BEARING: the default is .deleteOnSuccess, which throws away
            // every screenshot from a passing run — i.e. all of them.
            shot.lifetime = .keepAlways
            add(shot)

            app.terminate()
        }
    }
}
