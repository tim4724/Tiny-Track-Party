import QuartzCore
import UIKit

/// Who a name tag names: what the sticker shows, and nothing about where.
struct NameTagLabel: Hashable {
    let name: String
    let colorIndex: Int
}

/// The name tags over every other car, the tvOS half of `Stage._paintNameTags`.
///
/// **THE ONE PER-FRAME CHROME, and it is not SwiftUI.** A tag rides a moving car,
/// so its position changes every frame; re-laying a SwiftUI tree at 60 Hz is the
/// churn `DisplayHost` exists to avoid. This is a plain view of pooled layers
/// whose images are drawn ONCE per name and colour, so a frame only moves
/// layers: position, transform, opacity — Core Animation properties, no layout
/// and no text shaping.
///
/// A SUBVIEW OF THE METAL SURFACE, which is what puts it under the SwiftUI cell
/// chips for free: they are the surface's siblings, above it in the ZStack.
///
/// Where each tag goes is C++'s (`ttp/name_tags.h`). Nothing here syncs with the
/// Metal present: the update lands in the same main-thread tick as the frame it
/// was read off, and that is the whole of it (user decision — simple, and never
/// blocking the loop).
final class NameTagView: UIView {

    /// `.name-tag`'s `clamp(1rem, 1.3vw, 1.5rem)` against a 1920-wide display:
    /// 1.3vw is 25, so the clamp lands on its 1.5rem ceiling — the same reading
    /// `NameChip` takes of its own clamp (2.2rem there, 35 pt).
    private static let fontSize: CGFloat = 24

    /// The tag's tilt, `rotate(-2deg)`.
    private static let tilt: CGFloat = -2 * .pi / 180

    private struct TagImage {
        let image: CGImage
        let size: CGSize
        /// The projected point, in the layer's unit coordinates: below the tail's
        /// tip, which is why it is past 1.
        let anchor: CGPoint
    }

    private var stickers: [NameTagLabel: TagImage] = [:]
    private var pool: [CALayer] = []
    private var shown: [NameTagLabel?] = []
    private var visible = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("NameTagView is created in code, by DisplayHost") }

    /// Drop sticker images for labels no longer in the field, so a long party of
    /// renames does not keep every old name's bitmap.
    func keepImages(for labels: [NameTagLabel]) {
        stickers = stickers.filter { labels.contains($0.key) }
    }

    /// Place this frame's tags. `packed` is `ttp_display_name_tags`' answer,
    /// `count` tags of 6 floats; `labels` is indexed by roster slot.
    func place(_ packed: UnsafeBufferPointer<Float>, count: Int, labels: [NameTagLabel?]) {
        let w = bounds.width, h = bounds.height
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        var n = 0
        for i in 0..<count where w > 0 && h > 0 {
            let o = i * 6
            let slot = Int(packed[o + 1])
            guard slot >= 0, slot < labels.count, let label = labels[slot] else { continue }
            let layer = n < pool.count ? pool[n] : grow()
            if n >= shown.count || shown[n] != label {
                let s = sticker(for: label)
                layer.contents = s.image
                layer.bounds = CGRect(origin: .zero, size: s.size)
                layer.anchorPoint = s.anchor
                if n < shown.count { shown[n] = label } else { shown.append(label) }
            }
            layer.position = CGPoint(x: CGFloat(packed[o + 2]) * w, y: CGFloat(packed[o + 3]) * h)
            let k = CGFloat(packed[o + 4])
            layer.setAffineTransform(CGAffineTransform(scaleX: k, y: k).rotated(by: Self.tilt))
            layer.opacity = packed[o + 5]
            if n >= visible { layer.isHidden = false }
            n += 1
        }
        for j in n..<max(n, visible) { pool[j].isHidden = true }
        visible = n
        CATransaction.commit()
    }

    /// Hide every tag: no scene, or no race cells.
    func clear() {
        guard visible > 0 else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for j in 0..<visible { pool[j].isHidden = true }
        visible = 0
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
        return l
    }

    private func sticker(for label: NameTagLabel) -> TagImage {
        if let s = stickers[label] { return s }
        let s = Self.draw(label)
        stickers[label] = s
        return s
    }

    /// `.name-tag` and its tail, drawn once. The box is the CSS box: `padding:
    /// 0.25em 0.5em` around a line-height-1 line, inside the sticker outline,
    /// with `--r-sm` corners and NO shadow. The tail is the web's two triangles:
    /// an ink one hung from the inner edge of the bottom outline, then the livery
    /// one lifted by the outline times sqrt(2), which on 45-degree sides is one
    /// outline width, so the ink runs unbroken round the tip.
    private static func draw(_ label: NameTagLabel) -> TagImage {
        let em = fontSize
        let border = Sticker.border
        let radius = Sticker.radiusSmall
        let font = Fonts.uiDisplay(em, weight: .bold)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white]
        let text = label.name as NSString
        let textW = ceil(text.size(withAttributes: attrs).width)

        let boxW = textW + em + 2 * border
        let boxH = em * 1.5 + 2 * border
        let tailH = 0.45 * em + border
        let tailW = 2 * tailH
        let canvas = CGSize(width: boxW, height: boxH - border + tailH)

        let ink = Tokens.uiColor("ink")
        let livery = Tokens.uiCar(label.colorIndex)
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
            let lineTop = border + 0.25 * em
            let glyphH = font.ascender - font.descender
            text.draw(at: CGPoint(x: border + 0.5 * em, y: lineTop + (em - glyphH) / 2), withAttributes: attrs)
        }
        // Stage._paintNameTags: the box's bottom sits 0.55em above the projected
        // point, which leaves the tail's tip just clear of the car.
        let anchorY = (boxH + 0.55 * em) / canvas.height
        return TagImage(image: image.cgImage!, size: canvas, anchor: CGPoint(x: 0.5, y: anchorY))
    }
}
