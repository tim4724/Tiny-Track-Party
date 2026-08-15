import CoreGraphics
import CoreImage

/// The join code's module bitmap, and nothing else.
///
/// **DECISION D3.** The URL this encodes is composed in shared C++ —
/// `libttp-party/ttp/session.h`'s `join_url`, reached through `ttp_net.h` — so
/// the four URLs a room's identity is spelled into (join / claim / dial / the
/// relay's controller template) are one implementation for three shells. Only
/// the BITMAP is per-platform, because it is three platform one-liners: the web
/// asks its own server (`GET /api/qr?text=`), tvOS asks Core Image, Android
/// would ask ZXing. Nothing about the room is decided here — this function takes
/// a string and returns pixels.
///
/// Not `@MainActor`: it touches neither `GameState` nor the C ABI, and both of
/// its callers (`GameCoordinator`'s room-ready hook and `Scenarios`) already
/// are. Callable off the main actor if a shell ever wants to.
enum QRCode {

    /// One `CIContext`, for the life of the process.
    ///
    /// This is the trap in the Core Image QR idiom: `CIContext()` builds and
    /// caches a whole Metal/GPU pipeline, so creating one per call turns a
    /// sub-millisecond render into tens of milliseconds and allocates a
    /// command queue each time. There are two QR renders in a party (the join
    /// ticket, and a reconnect card per dropped seat), so the cost would be
    /// invisible in a profile and paid on exactly the frames that matter.
    private static let context = CIContext()

    /// Roughly how many PIXELS wide the finished bitmap should be.
    ///
    /// A ballpark rather than a contract: the real scale is the largest INTEGER
    /// multiple of the module count that fits under it (see below), so the
    /// answer lands somewhere in `[target/2, target]`. 800 covers the lobby
    /// ticket at 4K — the ticket's QR is ~380 POINTS and `nativeScale` is 2 on a
    /// 4K box — without making a bitmap nothing can use.
    private static let targetPixels: CGFloat = 800

    /// The QR for `string`, or nil if Core Image would not make one (an empty
    /// message, or a string too long for the chosen correction level).
    static func image(for string: String) -> CGImage? {
        guard let data = string.data(using: .utf8), !data.isEmpty else { return nil }
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        // "L", matching the web server's `QRCode.create(text, {
        // errorCorrectionLevel: 'L' })` (`server/index.js`). Deliberately the
        // LOWEST level, and on a TV that is the right way round: correction
        // level buys resilience to damage and dirt at the cost of more modules,
        // and more modules on a fixed-size ticket means SMALLER ones. What this
        // code has to survive is being photographed across a room from a clean,
        // backlit, undamaged panel — so every module it does not have is width
        // the ones it does have get to keep.
        filter.setValue("L", forKey: "inputCorrectionLevel")
        guard let coded = filter.outputImage else { return nil }

        // ONE PIXEL PER MODULE is what the generator hands back, so this is the
        // whole of the scaling: an INTEGER multiple, so every module is an exact
        // block of pixels in the bitmap and no module edge lands mid-pixel here.
        //
        // What the VIEW then does with it is a separate question and has the
        // opposite answer: both panels are smaller than `targetPixels` and both
        // sit on a card the sticker kit rotates, so they ask for `.high` rather
        // than `.none`. See the note at `LobbyView.qrPanel` — point-sampling a
        // rotated downscale is what makes a QR ragged, not what keeps it crisp.
        let modules = max(coded.extent.width, 1)
        let scale = max(1, (Self.targetPixels / modules).rounded(.down))
        let scaled = coded.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        // NO QUIET ZONE IS ADDED HERE, on purpose and matching the web (whose
        // `renderQR` sizes the canvas to exactly `size * cell`). The margin a
        // scanner needs is supplied by what the code is MOUNTED on: the join
        // ticket is a white `--surface` sticker card with its own padding, and
        // the reconnect card the same. Baking a border in would double it there
        // and hide the fact that a caller who drops this on a dark background
        // has a real problem to fix.
        return context.createCGImage(scaled, from: scaled.extent)
    }
}
