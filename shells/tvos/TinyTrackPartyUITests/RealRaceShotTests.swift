import XCTest

/// Photographs a REAL race — normal boot, prod relay, a scripted phone on the
/// other end — which is the half the staged demo cannot vouch for. The rubber
/// layer's 2026-08-13 regression was exactly this shape: clean in the staged
/// race, artifacted (stray patches, a faint full-track line) only in real
/// races, so a device verification of that layer is not done until a real
/// race has been photographed over time.
///
/// This test drives nothing and reads nothing: it launches the app bare and
/// photographs the screen every ~15 s for ~5 minutes. The host-side driver
/// reads the room code out of the `_couchpad._tcp` Bonjour TXT record the
/// lobby advertises (`dns-sd -L Spielzimmer _couchpad._tcp local.`), joins
/// through the real controller page against the real relay, and starts the
/// race — see the scratchpad phone-drive script from the 2026-08-14 session.
final class RealRaceShotTests: XCTestCase {

    func testRealRaceOverTime() throws {
        let app = XCUIApplication()
        app.launch()

        for i in 0..<20 {
            Thread.sleep(forTimeInterval: 15)
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = String(format: "ttp-real-t%03d", i * 15)
            shot.lifetime = .keepAlways
            add(shot)
        }
        app.terminate()
    }
}
