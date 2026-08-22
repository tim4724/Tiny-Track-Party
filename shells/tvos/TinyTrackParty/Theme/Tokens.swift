import SwiftUI
import UIKit

/// The "Sticker Bash" palette, read at boot from the SAME file the web's CSS is
/// baked to.
///
/// `public/shared/theme.css` is the authored source of the look;
/// `scripts/gen-design-tokens.mjs` bakes its `:root` block to
/// `public/shared/design-tokens.json` (typed, aliases resolved), and
/// `shells/tvos/scripts/stage-assets.sh` copies that file verbatim into this
/// bundle. Reading it here rather than transcribing hex is not tidiness: it is
/// the mitigation `docs/native-port/architecture.md` accepted when it allowed
/// three implementations of the sticker look. A hex literal in Swift is a
/// fourth source that nothing in the tree watches, and `--accent` has already
/// moved once (amber → red).
///
/// So: **no colour that exists in `design-tokens.json` may be spelled again in
/// Swift.** The few hexes that legitimately are hardcoded in this shell live in
/// `Sticker.swift`'s paper stage, and they are hardcoded because they are not
/// tokens at all — the bake only carries `:root`, and the stage's hills and
/// clouds are authored inline in `.scene__*` rules.
///
/// Not `@MainActor`: nothing here touches the C ABI or `GameState`, and the
/// palette has to be reachable from `ButtonStyle` bodies and `#Preview`s.
/// `load()` runs once on the main thread at boot, before any view exists, so
/// the static storage is written before it is ever read.
enum Tokens {

    // MARK: - Types

    /// A hard offset shadow. Every one in this design system has **zero blur** —
    /// that is what makes a sticker read as die-cut rather than as a floating
    /// card, and it is why `blur` is carried but has always been 0.
    struct Shadow {
        let offset: CGSize
        let blur: CGFloat
        let color: Color
        let uiColor: UIColor
    }

    // MARK: - Storage

    private static var colors: [String: UIColor] = [:]
    private static var lengths: [String: CGFloat] = [:]
    private static var shadows: [String: Shadow] = [:]
    /// Unitless tokens (`type: "raw"`) — a fraction or a viewBox unit, not a
    /// length, so there is nothing to convert to points.
    private static var numbers: [String: CGFloat] = [:]
    /// The `car-*` group **in file order**. That order is the `colorIndex` a
    /// seat carries, so it may not be sorted or reordered.
    private static var liveries: [UIColor] = []
    private static var loaded = false

    /// The colour a missing token resolves to. Screaming magenta on purpose: it
    /// is in neither the chrome palette nor the livery palette, so a token that
    /// failed to load is unmistakable in a screenshot instead of quietly
    /// blending into the paper. Same reasoning as `Copy`'s `[key?]`.
    private static let missing = UIColor(red: 1, green: 0, blue: 1, alpha: 1)

    // MARK: - Loading

    /// Read `assets/design-tokens.json` out of the bundle. Call once at boot,
    /// on the main thread, before the first view is built.
    ///
    /// Failure `assert`s rather than `precondition`s: a missing token file is a
    /// build/staging bug that must stop a developer, but crashing a shipping TV
    /// app over chrome colour is worse than painting it magenta. Debug catches
    /// it; release limps and shows you where.
    static func load() {
        guard !loaded else { return }
        loaded = true

        guard let data = bundledTokenData() else {
            assertionFailure("design-tokens.json is not in the bundle — run shells/tvos/scripts/stage-assets.sh")
            return
        }
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let entries = root["tokens"] as? [[String: Any]]
        else {
            assertionFailure("design-tokens.json did not parse as { tokens: [...] }")
            return
        }

        for entry in entries {
            guard let name = entry["name"] as? String,
                  let type = entry["type"] as? String else { continue }
            switch type {
            case "color":
                // The bake resolves aliases AND pre-splits every colour into
                // `rgba`, so there is no hex parser here and no `color-mix` to
                // evaluate. That pre-splitting is the whole point of the typed
                // bake — three shells parsing CSS colour syntax three ways is
                // exactly the drift it removes.
                if let c = uiColor(fromRGBA: entry["rgba"]) { colors[name] = c }
            case "length":
                if let px = entry["px"] as? Double { lengths[name] = CGFloat(px) }
            case "raw":
                // A bare number in the CSS: a fraction of the surface, or a
                // width in the schematic's own viewBox. `resolved` is the
                // authored text, so this is the one arm that parses.
                if let raw = entry["resolved"] as? String, let v = Double(raw) {
                    numbers[name] = CGFloat(v)
                }
            case "shadow":
                if let s = entry["shadow"] as? [String: Any],
                   let c = uiColor(fromRGBA: s["rgba"]) {
                    let x = (s["x"] as? Double) ?? 0
                    let y = (s["y"] as? Double) ?? 0
                    let blur = (s["blur"] as? Double) ?? 0
                    shadows[name] = Shadow(offset: CGSize(width: x, height: y),
                                           blur: CGFloat(blur),
                                           color: Color(uiColor: c), uiColor: c)
                }
            case "font-stack":
                // Deliberately ignored. The stack names the CSS families the
                // browser resolves through @font-face; the faces THIS app can
                // ask for are the static TTFs `scripts/gen-fonts.py` renamed
                // ("Fredoka-SemiBold"), which the stack does not spell. Type
                // lives in Fonts.swift for that reason.
                break
            default:
                break
            }
        }

        // Order-preserving, and taken by PREFIX rather than by the group's
        // label so a reworded CSS comment cannot silently reshuffle the
        // liveries. (`--car`, the semantic role, does not match "car-".)
        liveries = entries.compactMap { entry -> UIColor? in
            guard let name = entry["name"] as? String, name.hasPrefix("car-") else { return nil }
            return colors[name]
        }

        assertLoadedFileIsWhole(declaredCount: root["count"] as? Int, parsed: entries.count)
    }

    /// Staged by `stage-assets.sh` into `Generated/assets/`, which `project.yml`
    /// bundles as a FOLDER REFERENCE (the renderer needs `toycar/Textures/…` to
    /// survive as a path), so it lands under `assets/` rather than at the
    /// bundle root. The flat lookup is the fallback for the day someone turns
    /// that folder reference back into a group and Xcode flattens it.
    private static func bundledTokenData() -> Data? {
        let url = Bundle.main.url(forResource: "design-tokens", withExtension: "json", subdirectory: "assets")
            ?? Bundle.main.url(forResource: "design-tokens", withExtension: "json")
        guard let url else { return nil }
        return try? Data(contentsOf: url)
    }

    /// A file that parses but is SHORT is the dangerous case: every token it
    /// dropped resolves to magenta, and a half-magenta screen looks like a
    /// theming mistake rather than a staging one. Two checks, because they
    /// catch different failures — the bake's own `count` catches a truncated
    /// copy, the required-name sweep catches a bake that renamed something.
    private static func assertLoadedFileIsWhole(declaredCount: Int?, parsed: Int) {
        assert(declaredCount == nil || declaredCount == parsed,
               "design-tokens.json declares \(declaredCount ?? -1) tokens but \(parsed) parsed — stale copy?")
        let required = ["paper", "ink", "ink-2", "ink-3", "red", "green", "blue", "purple",
                        "brand", "accent", "danger", "item", "surface", "surface-2",
                        "hairline", "grass", "shadow-ink", "btn-ledge"]
        for name in required where colors[name] == nil {
            assertionFailure("design-tokens.json is missing --\(name)")
        }
        assert(liveries.count == 8, "expected 8 car liveries, got \(liveries.count)")
        for name in ["r-sm", "r", "r-lg", "r-pill", "btn-drop", "btn-sink"] where lengths[name] == nil {
            assertionFailure("design-tokens.json is missing the length --\(name)")
        }
        for name in ["shadow-pop", "shadow-card", "shadow-float"] where shadows[name] == nil {
            assertionFailure("design-tokens.json is missing the shadow --\(name)")
        }
        for name in ["track-map-casing", "track-map-road",
                     "track-map-start-r", "track-map-start-ring"] where numbers[name] == nil {
            assertionFailure("design-tokens.json is missing the number --\(name)")
        }
        // The one rule the CSS can only state in prose, and the reason
        // `tests/design-tokens.test.js` exists on the web side: press travel
        // equal to the ledge depth would punch the button through its own ledge
        // and flatten it. Sticker.swift's button geometry is built on the
        // difference, so it has to hold here too.
        assert(length("btn-sink") < length("btn-drop"), "--btn-sink must stay under --btn-drop")
    }

    private static func uiColor(fromRGBA any: Any?) -> UIColor? {
        guard let parts = any as? [Double], parts.count == 4 else { return nil }
        // The bake writes r/g/b in 0...255 and alpha in 0...1, and UIColor's
        // component initialiser is sRGB — the same space a CSS hex is in.
        return UIColor(red: CGFloat(parts[0]) / 255, green: CGFloat(parts[1]) / 255,
                       blue: CGFloat(parts[2]) / 255, alpha: CGFloat(parts[3]))
    }

    // MARK: - Lookup

    /// By raw token name, kebab-case exactly as the CSS spells it minus the
    /// `--`: `"ink-2"`, `"car-red"`, `"surface-2"`.
    static func color(_ name: String) -> Color { Color(uiColor: uiColor(name)) }

    static func uiColor(_ name: String) -> UIColor {
        if let c = colors[name] { return c }
        assertionFailure("no design token --\(name)")
        return missing
    }

    /// Any length token, in points. tvOS is always 1920x1080 POINTS whatever
    /// the box's output mode (ledger 2.6), and the web display's chrome is
    /// authored against a ~1920 CSS px viewport — so a token's px value is a
    /// point value here with no conversion.
    static func length(_ name: String) -> CGFloat {
        if let v = lengths[name] { return v }
        assertionFailure("no length token --\(name)")
        return 0
    }

    /// The four `--r-*` corner radii. Spelled `radius` because that is what
    /// every caller wants them for; `length` is the general form.
    static func radius(_ name: String) -> CGFloat { length(name) }

    /// A unitless token. Whatever unit the CSS authored it in is the caller's
    /// to know — the safe-zone tokens are fractions of the surface, the
    /// `--track-map-*` ones are the schematic's own viewBox units.
    static func number(_ name: String) -> CGFloat {
        if let v = numbers[name] { return v }
        assertionFailure("no number token --\(name)")
        return 0
    }

    static func shadow(_ name: String) -> Shadow {
        if let s = shadows[name] { return s }
        assertionFailure("no shadow token --\(name)")
        return Shadow(offset: .zero, blur: 0, color: .clear, uiColor: .clear)
    }

    /// A player's livery, by the `colorIndex` a seat carries. Wrapping, with the
    /// same negative-safe modulo `protocol.h`'s `car_stats` uses, so an index
    /// from anywhere can be handed straight in.
    ///
    /// **These are LIVERIES, not chrome.** Chrome in this design system is
    /// red / green / blue / purple ONLY — amber, pink, orange and cyan exist in
    /// this palette and nowhere else in the UI. Do not reach for `car(1)`
    /// because a button wants to be yellow; that veto is the whole reason the
    /// two palettes are separate groups in `theme.css`.
    static func car(_ index: Int) -> Color {
        guard !liveries.isEmpty else { return Color(uiColor: missing) }
        let n = liveries.count
        return Color(uiColor: liveries[((index % n) + n) % n])
    }

    // There is deliberately no hex parser for authored strings in this file —
    // `design-tokens.json` is the palette, and a hex typed in Swift is a fourth
    // copy of a colour. (The one engine-answered colour a screen consumes,
    // `ttp_theme_boost_icon`, stays packed: `ItemIcon` substitutes its hex into
    // the shared SVG rather than ever becoming a `Color`.)

    // MARK: - Named accessors

    static var paper: Color { color("paper") }
    static var ink: Color { color("ink") }
    static var ink2: Color { color("ink-2") }
    static var ink3: Color { color("ink-3") }
    static var red: Color { color("red") }
    static var green: Color { color("green") }
    static var blue: Color { color("blue") }
    static var purple: Color { color("purple") }
    static var brand: Color { color("brand") }
    static var accent: Color { color("accent") }
    static var danger: Color { color("danger") }
    static var item: Color { color("item") }
    static var surface: Color { color("surface") }
    static var surface2: Color { color("surface-2") }

    // Beyond the four the sticker kit needs by name. `hairline` is an alias of
    // `ink` today; it is exposed separately because the CSS distinguishes
    // "this is a border" from "this is text", and one of them could move.
    static var hairline: Color { color("hairline") }
    static var grass: Color { color("grass") }
    static var shadowInk: Color { color("shadow-ink") }
    static var btnLedge: Color { color("btn-ledge") }

    // MARK: - Drift gate

    /// Assert the livery palette still matches the engine's `CAR_COLORS`.
    ///
    /// There are two ABI-visible spellings of these eight colours in this app:
    /// this file's (via `theme.css`, whose own comment says it mirrors
    /// `CAR_COLORS`) and `ttp_protocol_manifest_json()`'s, which is the
    /// sanctioned port source named in CLAUDE.md. Two spellings of one fact is
    /// exactly what the manifest rule forbids, and the web resolves it with
    /// `tests/config-drift.test.js`. This is that check, in the only place a
    /// tvOS build can see both lists at once.
    ///
    /// Not called from `load()`: the engine is not up yet at that point. The
    /// boot sequence should call it once, after `ttp_version()` answers.
    @MainActor
    static func assertLiveriesMatchEngine() {
        #if DEBUG
        let manifest = TTP.obj(ttp_protocol_manifest_json())
        guard let engine = manifest["CAR_COLORS"] as? [String] else {
            assertionFailure("ttp_protocol_manifest_json() carries no CAR_COLORS")
            return
        }
        assert(engine.count == liveries.count,
               "CAR_COLORS has \(engine.count) entries, design-tokens.json has \(liveries.count)")
        for (i, hex) in engine.enumerated() where i < liveries.count {
            assert(liveries[i].hexRGB == hex.lowercased(),
                   "livery \(i): engine says \(hex), design-tokens.json says \(liveries[i].hexRGB)")
        }
        #endif
    }
}

private extension UIColor {
    /// `#rrggbb`, lowercase — the spelling `protocol.h` uses.
    var hexRGB: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "#%02x%02x%02x",
                      Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
    }
}
