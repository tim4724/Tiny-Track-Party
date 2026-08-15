import SwiftUI
import UIKit

/// A PNG out of the staged asset tree, by the same relative path the web serves
/// it from.
///
/// **WHY NOT `AssetStore`.** That one is the coordinator's and answers `Data`
/// asynchronously, with a remote fallback, because what it feeds is the
/// RENDERER — GLBs and textures handed across the C ABI. These are SwiftUI
/// images on a board that is already on screen, so what they need is a
/// synchronous answer and a process-lifetime cache, and going through an actor
/// to get one would put a blank frame in every seat card on every lobby render.
///
/// **AND NOT AN ASSET CATALOGUE.** `stage-assets.sh` is the one list of what
/// ships, deliberately (see its header) — the same list `display-abi.test.js`
/// pins for the web. Copying six PNGs into `Assets.xcassets` as well would make
/// two, and the second would be the one nothing checks.
enum StagedImage {

    /// Keyed by the relative path, held for the life of the process. Six PNGs
    /// decoded at most once each, downsampled to the fixed `maxPixels` cap; the
    /// alternative is decoding one on every render of every seat card.
    private static var cache: [String: UIImage] = [:]

    private static let root = Bundle.main.resourceURL?.appendingPathComponent("assets")

    /// The widest the caller draws, in PIXELS, and why it is a cap rather than
    /// the exact box.
    ///
    /// These bakes are sized for the WEB, where one file serves a phone picker
    /// and a 4K display and the browser scales on the GPU: the car thumbs are
    /// hero stills far larger than any box this shell puts them in.
    ///
    /// Handing UIKit a megapixel bitmap to put in a seat card costs a full-size
    /// decode and a texture many times larger than any pixel it will ever fill,
    /// four times over in a dock of four. 512 covers the largest draw with room
    /// to spare and is a fraction of the memory.
    ///
    /// (The item icons used to come through here as PNGs too. They are SVGs
    /// rasterized at runtime now — see `ItemIcon`, which sizes its own bitmap
    /// for the same reasons and lands on the same number.)
    ///
    /// It is a THUMBNAIL, not a resize: `preparingThumbnail` decodes straight
    /// to the target through ImageIO, so the full-size bitmap never exists.
    private static let maxPixels: CGFloat = 512

    /// `toycar/thumbs/vehicle-racer.png` and friends. Nil when the file is not
    /// in the bundle, which the callers draw as their own placeholder rather
    /// than as a broken-image box.
    static func uiImage(_ relativePath: String) -> UIImage? {
        if let hit = cache[relativePath] { return hit }
        guard let root else { return nil }
        guard let data = try? Data(contentsOf: root.appendingPathComponent(relativePath),
                                   options: .mappedIfSafe),
              let image = UIImage(data: data) else { return nil }
        let ready = downsampled(image) ?? image
        cache[relativePath] = ready
        return ready
    }

    /// Scale to fit `maxPixels` on the long edge, preserving aspect and alpha.
    /// Returns nil (and the caller keeps the original) for anything already
    /// small enough, and if the thumbnail pass declines.
    private static func downsampled(_ image: UIImage) -> UIImage? {
        let w = image.size.width * image.scale, h = image.size.height * image.scale
        let longest = max(w, h)
        guard longest > maxPixels else { return nil }
        let k = maxPixels / longest
        return image.preparingThumbnail(of: CGSize(width: w * k, height: h * k))
    }

    static func image(_ relativePath: String) -> Image? {
        uiImage(relativePath).map { Image(uiImage: $0) }
    }
}
