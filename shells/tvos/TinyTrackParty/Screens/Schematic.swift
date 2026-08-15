import SwiftUI

/// The lobby's track mini-map: the circuit's centreline, projected top-down and
/// stroked as the toy "track ribbon" (a wide white casing under a narrow ink
/// road), on a cup-tinted field.
///
/// **WHERE THE GEOMETRY COMES FROM, AND WHERE IT DOES NOT.** This shell asks
/// `ttp_track_schematic_json(trackId, laps, seed)`, which builds the track with
/// the real `ttp::build_race_track` and projects its centreline into a padded
/// 256-unit square as one closed SVG path. The web display does NOT do this — it
/// reads the prebaked `public/shared/trackSchematics.js`, because a browser
/// rebuilding 20 tracks at boot to redraw data that never changes would be work
/// for nothing. That bake is deliberately NOT staged into this bundle
/// (`stage-assets.sh` says so at the line that does not copy it): the projection
/// is native now, the wasm/static library already answers it, and shipping the
/// bake alongside would be a second source for one fact — the exact drift the
/// manifest rule exists to stop.
///
/// The COST of asking rather than reading a bake is a track build per map, which
/// is why `Geometry.load` caches: see its note.
///
/// The SVG rendering itself is shell-owned by decision (ledger 3.6, "the
/// schematic SVG rendering, car thumbnails, cup tint"), which is what this file
/// is. No rule is decided here — a projection came back, and it gets stroked.
struct Schematic: Shape {

    let geometry: Geometry

    /// A projected track: the closed polyline, the square it was projected into,
    /// and the start/finish point (absent for a track with no samples — the
    /// projection leaves `start` null rather than zeroing it).
    struct Geometry: Equatable {
        let viewBox: CGRect
        let points: [CGPoint]
        let start: CGPoint?

        /// The projection's own square, and the fallback for a malformed
        /// `viewBox` string. `schematic.cc` writes this literal.
        static let defaultViewBox = CGRect(x: 0, y: 0, width: 256, height: 256)
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard let first = geometry.points.first else { return path }
        path.move(to: geometry.place(first, in: rect))
        for p in geometry.points.dropFirst() { path.addLine(to: geometry.place(p, in: rect)) }
        // The projection always emits a closed loop (`path_of` appends " Z"), and
        // a circuit IS closed — so closing here rather than leaning on the
        // parser having seen the Z keeps the join round instead of leaving a
        // butt-capped nick at the start/finish line.
        path.closeSubpath()
        return path
    }
}

// MARK: - Loading

extension Schematic.Geometry {

    /// Where the C ABI's answers are kept, keyed by track id.
    ///
    /// A cache and not a convenience: `ttp_track_schematic_json` BUILDS THE
    /// TRACK, so an uncached call from a SwiftUI body — which may run many times
    /// per state change — would put a whole track build on the lobby's frame
    /// path, next to a live 3D preview. (The same mistake cost this tree 14
    /// seconds of test wall clock once, in an audit ABI that rebuilt its track
    /// per call.) A schematic is immutable for the life of the build, so one
    /// answer per track id is all there will ever be: 20 tracks, ~1 KB each.
    ///
    /// The value is a DOUBLE optional on purpose — a cached `nil` (unknown track
    /// id, or a projection this parser could not read) must not be retried on
    /// every redraw.
    @MainActor private static var cache: [String: Schematic.Geometry?] = [:]

    /// Project `trackId`, or nil if the track is unknown to this build.
    ///
    /// `laps: 1, seed: 0` — the same arguments `GameCoordinator.chooserTracks`
    /// passes when it packs the phones' copy of these maps. Neither affects the
    /// centreline; they are the track builder's, and passing anything else here
    /// would draw the lobby a different map from the one the phones hold.
    @MainActor
    static func load(trackId: String) -> Schematic.Geometry? {
        if let hit = cache[trackId] { return hit }
        let answer = build(trackId)
        cache[trackId] = answer
        return answer
    }

    @MainActor
    private static func build(_ trackId: String) -> Schematic.Geometry? {
        guard !trackId.isEmpty else { return nil }
        let json = TTP.obj(ttp_track_schematic_json(trackId, 1, 0))
        guard let d = json["d"] as? String else { return nil }
        // The READER IS THE LIBRARY'S. `pack()` has always run one over a path;
        // it simply had no export, so this shell grew a second SVG parser for a
        // format the C++ both writes and reads. `ttp_schematic_points_json` is
        // that same reader — an empty answer still means "give up on the map"
        // rather than "draw a plausible wrong circuit".
        let points = TTP.arr(ttp_schematic_points_json(d)).compactMap { pair -> CGPoint? in
            guard let xy = pair as? [Any], xy.count == 2,
                  let x = xy[0] as? Double, let y = xy[1] as? Double else { return nil }
            return CGPoint(x: x, y: y)
        }
        guard !points.isEmpty else { return nil }
        var start: CGPoint?
        if let s = json["start"] as? [String: Any],
           let x = s["x"] as? Double, let y = s["y"] as? Double {
            start = CGPoint(x: x, y: y)
        }
        return Schematic.Geometry(viewBox: Schematic.parseViewBox(json["viewBox"] as? String),
                                  points: points, start: start)
    }

    /// viewBox coordinates to view coordinates: uniform scale, centred. Uniform
    /// because a schematic is a MAP — squashing one axis to fill a non-square
    /// box would draw a circuit that is not the shape of the circuit.
    func place(_ p: CGPoint, in rect: CGRect) -> CGPoint {
        guard viewBox.width > 0, viewBox.height > 0 else { return p }
        let k = min(rect.width / viewBox.width, rect.height / viewBox.height)
        let ox = rect.midX - viewBox.midX * k
        let oy = rect.midY - viewBox.midY * k
        return CGPoint(x: p.x * k + ox, y: p.y * k + oy)
    }

    /// The scale `place` applies, for anything sized in viewBox units — every
    /// stroke width and the start dot's radius are authored against the 256
    /// square, exactly as the CSS states ("stroke-widths are in viewBox units").
    func scale(in rect: CGRect) -> CGFloat {
        guard viewBox.width > 0, viewBox.height > 0 else { return 1 }
        return min(rect.width / viewBox.width, rect.height / viewBox.height)
    }
}

// MARK: - The path subset

extension Schematic {

    /// `"minX minY width height"`. Falls back to the projection's own square
    /// rather than to zero, since a zero box would divide the whole map away.
    static func parseViewBox(_ text: String?) -> CGRect {
        guard let text else { return Geometry.defaultViewBox }
        let parts = text.split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
        guard parts.count == 4, parts[2] > 0, parts[3] > 0 else { return Geometry.defaultViewBox }
        return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
    }
}

// MARK: - Cup tint

extension Schematic {

    /// The field colour behind a mini-map: the cup's own colour, mostly washed
    /// out to white.
    ///
    /// THIS TABLE IS A SECOND SPELLING, and it is worth being honest about it.
    /// The five colours live in `public/shared/trackPicker.js` (`CUP_COLOR`) and
    /// are not design tokens — they never entered `theme.css`'s `:root`, so
    /// `design-tokens.json` does not carry them and `Tokens` cannot answer for
    /// them. Ledger 3.6 lists "cup tint" among the things a shell owns and will
    /// not find in `ttp_ui.h`, so this is sanctioned rather than accidental; but
    /// nothing in the tree watches these two lists, and if a third shell wants
    /// them the right fix is a token group, not a third copy.
    ///
    /// They are AUTHORED, not derived, and `trackPicker.js` records why at
    /// length: they started as each biome's first horizon-hill colour on the
    /// theory that the 3D world and the paper UI then could not drift, and that
    /// broke on two of five (snow's is white in all but name; playroom's washes
    /// out to chrome pink, which the theme vetoes). Do not re-derive them from
    /// `ttp_theme.h`.
    private static let cupColor: [String: UInt32] = [
        "beach": 0xE0C070,      // wet sand
        "snow": 0x7FB2DC,       // ice blue
        "backyard": 0x7FBF63,   // lawn green
        "canyon": 0xC4713F,     // terracotta
        "rooftop": 0xF5842B     // orange plastic deck
    ]
    /// A cup-less catalogue keeps the old default green.
    private static let cupColorFallback: UInt32 = 0x7FBF63

    /// `FIELD_TINT` — how much of the colour survives a mix with white. The
    /// phone's picker paints its schematics with the same 26%, so the lobby and
    /// the phone show the same map on the same field.
    private static let fieldShare: Double = 0.26

    /// `color-mix(in srgb, CUP_COLOR[cupId] 26%, #fff)`. sRGB mixing is a
    /// straight component lerp on the ENCODED values, which is what
    /// `color-mix(in srgb, …)` does and what makes this reproduce the browser's
    /// answer — mixing the same pair in linear light comes out visibly darker.
    static func fieldTint(cupId: String?) -> Color {
        wash(cupId.flatMap { cupColor[$0] } ?? cupColorFallback)
    }

    /// `trackPicker.js`'s NEUTRAL_COLOR as the same 26% wash — the unknown-cup
    /// "?" chips wear it (`neutralTint(FIELD_TINT)`), so "belongs to no cup" is
    /// one colour on the TV, the web card and the phone's 🎲 tile. NOT the
    /// `fieldTint(nil)` fallback, which is the cup-less catalogue's old green.
    static var neutralTint: Color { wash(0x8C8398) }

    private static func wash(_ rgb: UInt32) -> Color {
        let mix = { (channel: UInt32) -> Double in
            let c = Double((rgb >> channel) & 0xFF) / 255
            return c * fieldShare + (1 - fieldShare)   // the other side of the mix is #fff
        }
        return Color(red: mix(16), green: mix(8), blue: mix(0))
    }
}

// MARK: - The tile

/// One mini-map as the lobby draws it: cup-tinted field, white casing, ink road,
/// a dot on the start/finish line, inside a hairline sticker frame.
///
/// The two strokes are the whole "track ribbon" look and they are ONE path drawn
/// twice — a wide white one under a narrow dark one. Drawing an outline instead
/// would need the road's offset curves, which is a different and much harder
/// picture to get right at 100 points wide.
struct SchematicMap: View {

    let trackId: String
    /// Tints the field. Nil for a track that belongs to no cup.
    let cupId: String?

    /// Resolved off the C ABI in `.task`, never in `body`. A body must be cheap
    /// and may run at any time; `ttp_track_schematic_json` is neither.
    @State private var geometry: Schematic.Geometry?

    // viewBox units — the numbers in `theme.css`'s `.track-map__*` rules,
    // authored against the 256 square (~2.56x their old 0-100 values).
    private static let casingWidth: CGFloat = 23
    private static let roadWidth: CGFloat = 14
    private static let startRadius: CGFloat = 13
    private static let startStroke: CGFloat = 4

    var body: some View {
        GeometryReader { geo in
            let rect = CGRect(origin: .zero, size: geo.size)
            ZStack {
                Schematic.fieldTint(cupId: cupId)
                if let geometry {
                    let k = geometry.scale(in: rect)
                    let ribbon = Schematic(geometry: geometry)
                    ribbon.stroke(Color.white, style: Self.stroke(Self.casingWidth * k))
                    ribbon.stroke(Tokens.ink2, style: Self.stroke(Self.roadWidth * k))
                    if let start = geometry.start {
                        Circle()
                            .fill(Tokens.danger)
                            .overlay(Circle().strokeBorder(Color.white, lineWidth: Self.startStroke * k))
                            .frame(width: Self.startRadius * 2 * k, height: Self.startRadius * 2 * k)
                            .position(geometry.place(start, in: rect))
                    }
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: Sticker.radiusSmall, style: .continuous))
        .stickerOutline(Sticker.hairlineBorder, radius: Sticker.radiusSmall)
        // `.task(id:)` and not `.onAppear`: the cup slot re-uses these tiles as
        // the host changes their pick, so the load has to re-run when the id
        // moves under a view that never left the screen.
        .task(id: trackId) { geometry = Schematic.Geometry.load(trackId: trackId) }
        .accessibilityHidden(true)   // the cup card names the pick in words
    }

    private static func stroke(_ width: CGFloat) -> StrokeStyle {
        // Round joins and caps: a schematic is a closed loop of short segments,
        // and mitred joins spike outward on the tight ones.
        StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
    }
}
