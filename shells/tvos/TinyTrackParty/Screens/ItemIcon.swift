import SwiftUI
import SwiftDraw

/// The four held-item icons: the SHARED SVGs every shell rasterizes —
/// `public/assets/items/<key>.svg`, staged verbatim into this bundle under
/// `assets/items/`. One file per item id is the whole design (the ledger's
/// item 10): the web inlines the same bytes into the DOM, this shell hands
/// them to an SVG rasterizer, and there is no per-shell artwork to drift.
///
/// **THE TWO RECOLOUR SEAMS ARE CSS CUSTOM PROPERTIES**, which no SVG
/// rasterizer evaluates — so this shell does what the ledger says a shell
/// without CSS does: SUBSTITUTE the token, then rasterize.
///
///   --icon-accent   the boost chevrons' stroke: the BIOME's boost accent
///                   (`ttp_theme_boost_icon`), picked for contrast with this
///                   track's deck. The fallback baked into the file is the
///                   pre-theme teal.
///   --icon-car      the monster cab's fill: the body tone of the car MODEL
///                   the player drives (`carBodyColors`) — the 2D echo of the
///                   in-race graft, which stands the player's own body on the
///                   kit chassis. NOT the livery, which only ever paints the
///                   name plate.
struct ItemIcon: View {

    /// `ttp_item_id`'s key: `boost` | `banana` | `rocket` | `monster`.
    let key: String
    /// `--icon-accent`, as `ttp_theme_boost_icon` answers it (0xRRGGBB).
    var accent: UInt32 = ItemIcon.defaultAccent
    /// The cell's car MODEL index, into `carBodyColors` for `--icon-car`.
    var carIndex: Int = 0

    /// `boostShades()`' own pre-theme teal, for a slot drawn before any scene
    /// has resolved a biome. The same literal the SVG carries as its fallback.
    static let defaultAccent: UInt32 = 0x12A99A

    /// `CAR_BODY_COLORS` (`public/shared/itemIcons.js`): one body tone per car
    /// MODEL, in `CAR_MODELS` order, sampled from the baked thumbs so the chip
    /// matches the car it stands for. A SECOND SPELLING of that table, pinned
    /// against the JS by `tests/item-icons.test.js` — the same sanctioned
    /// arrangement as `Schematic.cupColor`.
    static let carBodyColors: [UInt32] = [
        0x5CBB80,   // vehicle-racer-low · Dash
        0xDD5533,   // vehicle-speedster · Bolt
        0x6688CC,   // vehicle-racer · Carve
        0xAA77DD    // vehicle-vintage-racer · Rumble
    ]

    var body: some View {
        Group {
            if let image = Self.rasterized(key: key, accent: accent,
                                           car: Self.carBodyColors[carIndex % Self.carBodyColors.count]) {
                Image(uiImage: image).resizable().scaledToFit()
            }
            // No placeholder. An unstaged icon leaves the slot's card empty,
            // which is honest — the slot itself still says an item is held, and
            // a question mark would read as a fifth item.
        }
        .accessibilityHidden(true)
    }

    // MARK: - Warming

    /// Rasterize every icon this race can show, while there is nothing at stake.
    ///
    /// Parsing and rasterizing one icon costs a few milliseconds — small, but
    /// paid the first time a bitmap is asked for, which is the frame an item
    /// LANDS in a slot. That is a gameplay frame and the worst one available.
    /// This runs where the scene is staged instead (`rebuildScene`), which is
    /// already a mesh build and a shadow bake, so nothing here is noticeable.
    ///
    /// The loop is deliberately dumb — every key against every car tone — and
    /// the variant key does the thinning: an icon that reads neither token has
    /// one variant however many times it is asked for, so this makes far fewer
    /// bitmaps than it makes calls, and the repeats are dictionary hits.
    @MainActor
    static func prewarm(accent: UInt32) {
        for key in ItemVocabulary.keys {
            for car in carBodyColors { _ = rasterized(key: key, accent: accent, car: car) }
        }
    }

    // MARK: - Substitute + rasterize

    /// One entry per ITEM KEY: the file's bytes, ready to substitute, plus which
    /// of the two tokens it actually carries. Both are facts about the file, so
    /// they are read from it rather than listed here — an icon that grows a
    /// token starts varying by it with nothing else edited.
    private struct Source {
        let text: String
        let usesAccent: Bool
        let usesCar: Bool
    }

    @MainActor private static var sources: [String: Source] = [:]

    /// One entry per VARIANT — and a variant is only ever the tokens the icon
    /// reads. Keying on both regardless made a bitmap per (icon x accent x car)
    /// where most icons read neither: a four-player race rasterized up to
    /// sixteen images of the six that exist, each one a 512px square.
    @MainActor private static var cache: [String: UIImage] = [:]

    /// The square every variant is rasterized to, and it is a SIZE rather than a
    /// resolution: tvOS lays out in 1920x1080 POINTS whatever the box outputs,
    /// so the panel does not change what the icon needs. The slot is 152 points
    /// with a 15% inset — about 106, or 212 pixels at `nativeScale` 2 on a 4K
    /// box — and the landing pop scales it 1.8x, so the largest the bitmap is
    /// ever asked to fill is ~380. 512 covers that with room to spare.
    ///
    /// It is also the ceiling worth paying: each of these is a megabyte of
    /// RGBA, and the warm below holds one per variant for the life of the
    /// process.
    private static let side: CGFloat = 512

    @MainActor
    private static func rasterized(key: String, accent: UInt32, car: UInt32) -> UIImage? {
        guard let source = source(for: key) else { return nil }
        let accentHex = hex(accent), carHex = hex(car)
        // The hex already carries its own '#', which is the separator.
        let cacheKey = key
            + (source.usesAccent ? accentHex : "")
            + (source.usesCar ? carHex : "")
        if let hit = cache[cacheKey] { return hit }

        // The whole var() expression goes, fallback included — the token's
        // value is resolved HERE, which is the substitution the ledger asks of
        // a shell that cannot evaluate CSS.
        var text = source.text
        if source.usesAccent {
            text = text.replacingOccurrences(of: "var\\(--icon-accent[^)]*\\)",
                                             with: accentHex, options: .regularExpression)
        }
        if source.usesCar {
            text = text.replacingOccurrences(of: "var\\(--icon-car[^)]*\\)",
                                             with: carHex, options: .regularExpression)
        }
        guard let svg = SVG(data: Data(text.utf8)) else { return nil }
        let image = svg.rasterize(size: CGSize(width: side, height: side))
        cache[cacheKey] = image
        return image
    }

    /// The file, read and made parseable once per key rather than once per
    /// variant.
    @MainActor
    private static func source(for key: String) -> Source? {
        if let hit = sources[key] { return hit }
        guard let url = Bundle.main.resourceURL?
                .appendingPathComponent("assets/items/\(key).svg"),
              var text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        // The authored comments name the CSS tokens ("--icon-accent"), and a
        // literal `--` inside an XML comment is ILLEGAL XML — the browser's
        // lenient HTML parser shrugs, SwiftDraw's NSXMLParser refuses the whole
        // file and every slot rendered an empty card. Comments carry no
        // geometry, so drop them before the parser sees them.
        //
        // It has to happen BEFORE the token check below, too: the comments are
        // where the tokens are described, so a file that merely TALKS about
        // `--icon-car` would otherwise claim to vary by it.
        text = text.replacingOccurrences(of: "(?s)<!--.*?-->",
                                         with: "", options: .regularExpression)
        let source = Source(text: text,
                            usesAccent: text.contains("var(--icon-accent"),
                            usesCar: text.contains("var(--icon-car"))
        sources[key] = source
        return source
    }

    private static func hex(_ rgb: UInt32) -> String {
        String(format: "#%06x", rgb & 0xFFFFFF)
    }
}
