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

    /// Photograph one scenario. The TESTS are generated —
    /// `shells/tvos/scripts/gen-scenarios.mjs` writes one `testShot_<id>` per
    /// entry in `public/shared/galleryScenarios.js`, each calling this.
    ///
    /// ONE TEST EACH rather than one test looping the table, because
    /// `-only-testing:` selects a method and is the only filter that survives
    /// the trip to a device (an environment variable does not arrive — see the
    /// generator's header). While this was a loop, the device shot all eighteen
    /// boards however few the caller asked for and `--only` could only discard
    /// the extras after export, so looking at one changed screen cost a
    /// full-table capture.
    ///
    /// Not named `test…`, or XCTest would run it with no scenario at all.
    func capture(_ id: String) {
        let app = XCUIApplication()
        app.launchArguments = ["-ttpScenario", id]
        // PHOTOGRAPH A NON-NATIVE BUFFER, when asked. The adaptive render scale
        // moves the drawable under a chrome layer that is laid out in POINTS, and
        // every shot in this gallery is taken at 1.0 — which is why a `uiScale`
        // that had gone stale put the whole HUD at 3/4 of its right place with
        // the suite entirely green. `TEST_RUNNER_TTP_RENDER_SCALE=0.5` on the
        // xcodebuild environment reaches the runner as this variable.
        if let k = ProcessInfo.processInfo.environment["TTP_RENDER_SCALE"], !k.isEmpty {
            app.launchArguments += ["-ttpRenderScale", k]
        }
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
        //
        // ONE WAIT FOR EITHER VERDICT, because asking the two questions in
        // sequence made the cheap answer expensive: `waitForExistence` only
        // answers false when its clock runs out, so polling "unsupported"
        // first charged every SUPPORTED board the full timeout to be told
        // nothing. Seventeen of the eighteen paid it, which was most of a
        // minute per capture spent waiting on an element that was never
        // going to appear. Matching both identifiers in one query returns
        // the moment either lands — still waiting on the APP, never on a
        // clock, which is the rule above and the reason this is not a sleep.
        let verdict = app.otherElements.matching(
            NSPredicate(format: "identifier IN %@", ["ttp-ready", "ttp-unsupported"])
        ).firstMatch
        if !verdict.waitForExistence(timeout: 30) {
            XCTFail("\(id): the app never signalled ready")
            app.terminate()
            return
        }
        if verdict.identifier == "ttp-unsupported" {
            app.terminate()
            return
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
