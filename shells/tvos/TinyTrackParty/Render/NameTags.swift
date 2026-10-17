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
    /// The most tags a frame can hold: one cell per player, each naming every
    /// other player. From the protocol manifest's MAX_PLAYERS.
    let maxTags: Int

    /// `.name-tag`'s `clamp(1.2rem, 1.56vw, 1.8rem)` against a 1920-wide
    /// display: 1.56vw is 30, so the clamp lands on its 1.8rem ceiling — the
    /// same reading `NameChip` takes of its own clamp (2.2rem there, 35 pt).
    /// Like the CSS, the CLOSEST size (C++'s scale 1), 4/3 of the usual tag, so
    /// the image is only ever scaled down.
    private static let fontSize: CGFloat = 28.8

    private struct TagImage {
        let name: String
        let colorIndex: Int
        let image: CGImage
        let size: CGSize
        /// The projected point, in the layer's unit coordinates: below the tail's
        /// tip, which is why it is past 1.
        let anchor: CGPoint
        /// The sticker's box (the tail aside), and how far its bottom edge stands
        /// above the projected point: what C++ measures a tag's cover against.
        let box: CGSize
        let lift: CGFloat
    }

    /// C++ writes into this directly (`DisplayHost`); `show` says how much of it is live.
    var tags: [Float]

    /// Slot i's car id, latched per scene build by `DisplayHost`.
    private var slots: [EngineIdentity] = []
    private var stickers: [EngineIdentity: TagImage] = [:]
    private var pool: [CALayer] = []
    /// Which car each pooled layer's image is, so a frame swaps images only on a change.
    private var shown: [EngineIdentity?] = []
    private var visible = 0
    /// The slots' sticker sizes have moved since C++ was last told (`reportSizes`).
    private var sizesDirty = true

    override var bounds: CGRect {
        didSet { if bounds.size != oldValue.size { sizesDirty = true } }
    }

    init(frame: CGRect, maxPlayers: Int) {
        maxTags = maxPlayers * (maxPlayers - 1)
        tags = [Float](repeating: 0, count: maxTags * Self.stride)
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
        sizesDirty = true
    }

    /// The scene's slot order, off the built roster (`ttp_display_slot_ids_json`).
    func setSlots(_ ids: [EngineIdentity]) { slots = ids; sizesDirty = true }

    /// Hands each slot's sticker box to `report` as fractions of this view — the
    /// size C++ measures a tag's cover against (`ttp_display_name_tag_size`) —
    /// but only when a sticker, the slot order or the view moved. `DisplayHost`
    /// makes the call, as it makes every other.
    func reportSizes(_ report: (_ slot: Int, _ w: Float, _ h: Float, _ lift: Float) -> Void) {
        let w = bounds.width, h = bounds.height
        guard sizesDirty, w > 0, h > 0 else { return }
        sizesDirty = false
        for (slot, id) in slots.enumerated() {
            guard let s = stickers[id] else { continue }
            report(slot, Float(s.box.width / w), Float(s.box.height / h), Float(s.lift / h))
        }
    }

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
            layer.setAffineTransform(CGAffineTransform(scaleX: k, y: k))
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

    /// `.name-tag` and its tail, drawn once: a livery PILL with white semibold
    /// type, no outline, no shadow, no tilt — the Toy Box keeps the tags solid on
    /// purpose (whose car is whose) and flat like everything else. The box is the
    /// CSS box, `padding: 0.14em 0.55em 0.18em` round a line-height-1 line. The
    /// tail is one livery triangle, `0.6em + 2b` wide and `0.3em + b` tall
    /// (`b` the old outline, 2px at the closest size), tucked a point under the
    /// pill so no seam shows, its tip flattened like every corner here.
    private static func draw(name: String, colorIndex: Int) -> TagImage {
        let em = fontSize
        let b: CGFloat = 2 * 4 / 3
        let font = Fonts.uiDisplay(em, weight: .semibold)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white]
        let text = name as NSString
        let textW = ceil(text.size(withAttributes: attrs).width)

        let boxW = textW + 1.1 * em
        let boxH = em * 1.32
        let tailTop = boxH - 1
        let tailH = 0.3 * em + b
        let tailW = 0.6 * em + 2 * b
        let canvas = CGSize(width: boxW, height: tailTop + tailH)

        let livery = Tokens.uiCar(colorIndex)
        let format = UIGraphicsImageRendererFormat()
        format.scale = UIScreen.main.scale
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: canvas, format: format).image { _ in
            livery.setFill()
            UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: boxW, height: boxH),
                         cornerRadius: boxH / 2).fill()

            // `clip-path: polygon(0 0, 100% 0, 54% 92%, 46% 92%)`.
            let x0 = (boxW - tailW) / 2
            let p = UIBezierPath()
            p.move(to: CGPoint(x: x0, y: tailTop))
            p.addLine(to: CGPoint(x: x0 + tailW, y: tailTop))
            p.addLine(to: CGPoint(x: x0 + 0.54 * tailW, y: tailTop + 0.92 * tailH))
            p.addLine(to: CGPoint(x: x0 + 0.46 * tailW, y: tailTop + 0.92 * tailH))
            p.close()
            p.fill()

            // Centred on the line box the CSS lays out: one em tall, the glyphs'
            // ascender-to-descender span centred inside it.
            let lineTop = 0.14 * em
            let glyphH = font.ascender - font.descender
            text.draw(at: CGPoint(x: 0.55 * em, y: lineTop + (em - glyphH) / 2), withAttributes: attrs)
        }
        // Stage._paintNameTags: the box's bottom sits 0.4em above the projected
        // point, which leaves the tail's tip just clear of the car.
        let anchorY = (boxH + 0.4 * em) / canvas.height
        return TagImage(name: name, colorIndex: colorIndex, image: image.cgImage!, size: canvas,
                        anchor: CGPoint(x: 0.5, y: anchorY), box: CGSize(width: boxW, height: boxH),
                        lift: 0.4 * em)
    }
}
