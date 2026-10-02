import QuartzCore
import UIKit

/// The name tags over every other player's car in each cell: the tvOS half
/// of the web's `Stage._paintNameTags` and its `.name-tag` CSS, and the twin of
/// Android's `NameTags.kt`, method for method.
///
/// **THE ONE PER-FRAME CHROME, and it is not SwiftUI.** A tag rides a moving car,
/// so it moves on every presented frame; re-laying a SwiftUI tree at 60 Hz is the
/// churn `DisplayHost` exists to avoid. WHERE each tag goes is C++'s
/// (`ttp_display_name_tags`, read by `DisplayHost` right after the frame it
/// describes); this decides nothing.
///
/// **A STICKER IS DRAWN ONCE, NOT PER FRAME.** Each car's tag is rasterized into
/// an image when its name or livery changes, and a frame only moves, scales and
/// fades pooled layers: Core Animation properties, no layout, no text shaping.
///
/// A SUBVIEW OF THE METAL SURFACE, which puts it under the SwiftUI cell chips:
/// they are the surface's siblings, above it in the ZStack. Nothing here syncs
/// with the Metal present; the update lands in the same main-thread tick as the
/// frame it was read off (user decision: simple, and never blocking the loop).
final class NameTagView: UIView {

    /// Floats per tag in `ttp_display_name_tags`' answer (`ttp_display.h`).
    static let stride = 6
    /// The most cells a field can split into (eight), each tagging the other seven.
    static let maxTags = 8 * 7

    /// `.name-tag`'s `clamp(1.2rem, 1.56vw, 1.8rem)` against a 1920-wide
    /// display: 1.56vw is 30, so the clamp lands on its 1.8rem ceiling — the
    /// same reading `NameChip` takes of its own clamp (2.2rem there, 35 pt).
    /// Like the CSS, the CLOSEST size (C++'s scale 1), 4/3 of the usual tag, so
    /// the image is only ever scaled down.
    private static let fontSize: CGFloat = 28.8

    /// The slim sticker's outline and corner are 2/3 of the chips', at the usual
    /// size; drawn at the closest size, that is 2/3 * 4/3 of them.
    private static let slim: CGFloat = 8.0 / 9.0

    /// The tag's tilt, `rotate(-2deg)`.
    private static let tilt: CGFloat = -2 * .pi / 180

    private struct TagImage {
        let name: String
        let colorIndex: Int
        let image: CGImage
        let size: CGSize
        /// The projected point, in the layer's unit coordinates: below the tail's
        /// tip, which is why it is past 1.
        let anchor: CGPoint
    }

    /// C++ writes into this directly (`DisplayHost`); `show` says how much of it is live.
    var tags = [Float](repeating: 0, count: maxTags * stride)

    /// Slot i's car id, latched per scene build by `DisplayHost`.
    private var slots: [EngineIdentity] = []
    private var stickers: [EngineIdentity: TagImage] = [:]
    private var pool: [CALayer] = []
    /// Which car each pooled layer's image is, so a frame swaps images only on a change.
    private var shown: [EngineIdentity?] = []
    private var visible = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("NameTagView is created in code, by DisplayHost") }

    /// Who the field is: re-rasterizes only the stickers whose name or livery
    /// moved, and drops the ones whose car left. Called whenever the scene's cars
    /// change (a build, a rename), never per frame. Only a car with a cell can be
    /// named, so a CPU car gets no sticker.
    func setField(_ cars: [SceneCar]) {
        var next: [EngineIdentity: TagImage] = [:]
        for car in cars where car.cell {
            if let have = stickers[car.id], have.name == car.name, have.colorIndex == car.colorIndex {
                next[car.id] = have
            } else {
                next[car.id] = Self.draw(name: car.name, colorIndex: car.colorIndex)
            }
        }
        stickers = next
        shown = shown.map { _ in nil }  // a re-drawn sticker must reach its layer
    }

    /// The scene's slot order, off the built roster (`ttp_display_slot_ids_json`).
    func setSlots(_ ids: [EngineIdentity]) { slots = ids }

    /// Place the `n` tags C++ just wrote into `tags`; 0 hides them all.
    func show(_ n: Int) {
        if n == 0 && visible == 0 { return }
        let w = bounds.width, h = bounds.height
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        var placed = 0
        for i in 0..<n where w > 0 && h > 0 {
            let o = i * Self.stride
            let slot = Int(tags[o + 1])
            guard slot >= 0, slot < slots.count, let s = stickers[slots[slot]] else { continue }
            let layer = placed < pool.count ? pool[placed] : grow()
            if shown[placed] != slots[slot] {
                layer.contents = s.image
                layer.bounds = CGRect(origin: .zero, size: s.size)
                layer.anchorPoint = s.anchor
                shown[placed] = slots[slot]
            }
            layer.position = CGPoint(x: CGFloat(tags[o + 2]) * w, y: CGFloat(tags[o + 3]) * h)
            let k = CGFloat(tags[o + 4])
            layer.setAffineTransform(CGAffineTransform(scaleX: k, y: k).rotated(by: Self.tilt))
            layer.opacity = tags[o + 5]
            if placed >= visible { layer.isHidden = false }
            placed += 1
        }
        for j in placed..<max(placed, visible) { pool[j].isHidden = true }
        visible = placed
        CATransaction.commit()
    }

    private func grow() -> CALayer {
        let l = CALayer()
        l.contentsScale = window?.screen.scale ?? UIScreen.main.scale
        l.isHidden = true
        // In paint order: C++ lists a cell's tags far to near, so a later layer
        // is a nearer car and belongs on top.
        layer.addSublayer(l)
        pool.append(l)
        shown.append(nil)
        return l
    }

    /// `.name-tag` and its tail, drawn once: the SLIM sticker. The box is the CSS
    /// box: `padding: 0.1em 0.42em` around a line-height-1 line, inside an outline
    /// and corners `slim` of the chips', semibold, and NO shadow. The tail is the
    /// web's two triangles: an ink one hung from the inner edge of the bottom
    /// outline, then the livery one lifted by the outline times sqrt(2), which on
    /// 45-degree sides is one outline width, so the ink runs unbroken round the tip.
    private static func draw(name: String, colorIndex: Int) -> TagImage {
        let em = fontSize
        let border = Sticker.border * slim
        let radius = Sticker.radiusSmall * slim
        let font = Fonts.uiDisplay(em, weight: .semibold)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white]
        let text = name as NSString
        let textW = ceil(text.size(withAttributes: attrs).width)

        let boxW = textW + 0.84 * em + 2 * border
        let boxH = em * 1.2 + 2 * border
        let tailH = 0.3 * em + border
        let tailW = 2 * tailH
        let canvas = CGSize(width: boxW, height: boxH - border + tailH)

        let ink = Tokens.uiColor("ink")
        let livery = Tokens.uiCar(colorIndex)
        let format = UIGraphicsImageRendererFormat()
        format.scale = UIScreen.main.scale
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: canvas, format: format).image { _ in
            let box = CGRect(x: 0, y: 0, width: boxW, height: boxH)
            ink.setFill()
            UIBezierPath(roundedRect: box, cornerRadius: radius).fill()
            livery.setFill()
            UIBezierPath(roundedRect: box.insetBy(dx: border, dy: border),
                         cornerRadius: max(0, radius - border)).fill()

            func tail(top: CGFloat, color: UIColor) {
                let x0 = (boxW - tailW) / 2
                let p = UIBezierPath()
                p.move(to: CGPoint(x: x0, y: top))
                p.addLine(to: CGPoint(x: x0 + tailW, y: top))
                p.addLine(to: CGPoint(x: x0 + 0.54 * tailW, y: top + 0.92 * tailH))
                p.addLine(to: CGPoint(x: x0 + 0.46 * tailW, y: top + 0.92 * tailH))
                p.close()
                color.setFill()
                p.fill()
            }
            tail(top: boxH - border, color: ink)
            tail(top: boxH - border - border * 2.squareRoot(), color: livery)

            // Centred on the line box the CSS lays out: one em tall, the glyphs'
            // ascender-to-descender span centred inside it.
            let lineTop = border + 0.1 * em
            let glyphH = font.ascender - font.descender
            text.draw(at: CGPoint(x: border + 0.42 * em, y: lineTop + (em - glyphH) / 2), withAttributes: attrs)
        }
        // Stage._paintNameTags: the box's bottom sits 0.4em above the projected
        // point, which leaves the tail's tip just clear of the car.
        let anchorY = (boxH + 0.4 * em) / canvas.height
        return TagImage(name: name, colorIndex: colorIndex, image: image.cgImage!, size: canvas,
                        anchor: CGPoint(x: 0.5, y: anchorY))
    }
}
