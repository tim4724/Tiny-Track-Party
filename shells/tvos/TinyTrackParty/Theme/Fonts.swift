import SwiftUI
import UIKit

/// The web's two families, as the static faces tvOS can actually register.
///
/// `theme.css` ships ONE variable woff2 per family and lets the browser
/// interpolate the weight axis. Neither half of that survives the port:
/// CoreText cannot read woff2 at all, and reaching a weight on a variable font
/// from SwiftUI means building a `UIFontDescriptor` with an axis dictionary at
/// every call site. `shells/tvos/scripts/gen-fonts.py` bakes the weights the
/// design system actually names (200/300/600/700/800, scraped from the CSS
/// rather than guessed) into named faces, `project.yml` registers them through
/// `UIAppFonts`, and this file is the only thing that spells a face name.
///
/// `--font-display` is Fredoka (headings, numerals, buttons, chips, the
/// wordmark, the countdown — "everything display-ish"); `--font-body` is
/// Nunito, which the display uses for its rare running text.
///
/// TV VIEWING DISTANCE: there is no scale factor in here. The web's sizes are
/// authored for a monitor at arm's length and would be timid across a room, but
/// baking a global multiplier would make every call site lie about what it
/// asked for, and the two boards that need the most correction (the wordmark,
/// the countdown) already carry their own poster scale. Callers pass a
/// TV-appropriate size; `Sticker.swift`'s component defaults document where
/// each of theirs came from.
enum Fonts {

    /// Fredoka. Headings, numerals, buttons, chips, pills, the wordmark.
    static func display(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        face(fredoka.face(for: cssWeight(weight)), size)
    }

    /// One line of `display(size, weight)`, as the FONT measures it.
    ///
    /// It exists because a hand-picked leading is a guess, and the guess was
    /// wrong: a `size * 1.15` box clipped every label on the lobby's seat dock,
    /// because Fredoka's line height at 26 is taller than 29.9. A reserved box
    /// has to come from the same metrics the text will be laid out with.
    ///
    /// UIFont rather than SwiftUI's Font: only the UIKit side exposes
    /// `lineHeight`, and this shell already loads the faces through it.
    static func lineHeight(_ size: CGFloat, weight: Font.Weight = .bold) -> CGFloat {
        let name = fredoka.face(for: cssWeight(weight))
        let font = UIFont(name: name, size: size) ?? UIFont.systemFont(ofSize: size)
        return font.lineHeight
    }

    /// Nunito. Running text — the welcome tagline, the info board's prose.
    static func body(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        face(nunito.face(for: cssWeight(weight)), size)
    }

    // MARK: - Families

    private struct Family {
        let name: String
        /// (usWeightClass, style name) for each BAKED face, ascending. Pinned to
        /// `gen-fonts.py`'s FAMILIES table and to `project.yml`'s `UIAppFonts`.
        /// Adding a weight to the CSS means adding it in all three.
        let faces: [(weight: Int, style: String)]

        /// Nearest baked weight. Ties go to the HEAVIER face, because at TV
        /// distance the heavier of two equally-wrong choices reads better.
        func face(for wanted: Int) -> String {
            var best = faces[0]
            for f in faces.dropFirst() {
                let d = abs(f.weight - wanted), bd = abs(best.weight - wanted)
                if d < bd || (d == bd && f.weight > best.weight) { best = f }
            }
            // The PostScript name gen-fonts.py writes into nameID 6.
            return "\(name)-\(best.style)"
        }
    }

    /// Fredoka's variable axis stops at 700, so `gen-fonts.py` has nothing
    /// heavier to bake and `.heavy`/`.black` CLAMP to Bold here — exactly as the
    /// browser clamps a `font-weight: 800` past a declared `300 700` range.
    /// Do not "fix" this by faking a heavier face with a stroke; the wordmark's
    /// weight comes from its poster SIZE, not from a fatter axis.
    private static let fredoka = Family(name: "Fredoka", faces: [
        (300, "Light"), (600, "SemiBold"), (700, "Bold"),
    ])

    /// Nunito's axis runs to 1000 and covers every weight the CSS names.
    private static let nunito = Family(name: "Nunito", faces: [
        (200, "ExtraLight"), (300, "Light"), (600, "SemiBold"), (700, "Bold"), (800, "ExtraBold"),
    ])

    // MARK: - Weight mapping

    /// `Font.Weight` → the CSS numeric weight it stands for, so "nearest face"
    /// is a comparison on the same scale the design system is authored in.
    ///
    /// Note what falls out for `.regular` (400): the CSS never asks for 400, so
    /// no 400 face is baked, and the nearest is Light (300) in both families. If
    /// you wanted "normal body text", the design system's answer is `.light` for
    /// Nunito and `.semibold` for Fredoka — 400 is simply not a weight this look
    /// contains.
    private static func cssWeight(_ w: Font.Weight) -> Int {
        switch w {
        case .ultraLight: return 100
        case .thin: return 200
        case .light: return 300
        case .regular: return 400
        case .medium: return 500
        case .semibold: return 600
        case .bold: return 700
        case .heavy: return 800
        case .black: return 900
        default: return 400
        }
    }

    // MARK: - Resolution

    /// `fixedSize:`, not `size:`. `Font.custom(_:size:)` rescales with Dynamic
    /// Type, and the race HUD's chips are anchored to cell rects the RENDERER
    /// computed in C++ (`ttp_display_cell_rects`) — type that grew under an
    /// accessibility setting would drift off geometry the shell does not own.
    private static func face(_ name: String, _ size: CGFloat) -> Font {
        #if DEBUG
        verifyRegistered(name)
        #endif
        return Font.custom(name, fixedSize: size)
    }

    #if DEBUG
    private static var verified = Set<String>()

    /// A face missing from `UIAppFonts` does not fail — `Font.custom` silently
    /// falls back to the system font, and the whole app just quietly stops
    /// looking like itself. This is the only thing that would notice, so it runs
    /// once per face name in debug builds.
    private static func verifyRegistered(_ name: String) {
        guard !verified.contains(name) else { return }
        verified.insert(name)
        assert(UIFont(name: name, size: 12) != nil,
               "\(name).ttf is not registered — check UIAppFonts in shells/tvos/project.yml")
    }
    #endif
}
