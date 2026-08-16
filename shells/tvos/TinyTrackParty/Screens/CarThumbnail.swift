import SwiftUI

/// The picture of a player's car on their lobby seat: the SAME pre-baked render
/// of the actual GLB the web shows, `<model>.png` out of the staged thumbs.
///
/// **THIS USED TO BE A DRAWING, AND THE DRAWING WAS THE BUG.** The first version
/// of this file hand-authored four side-profile silhouettes in `Path`s and
/// tinted them by livery, on two arguments: that the baked stills are 3.5 MB and
/// that the honest alternative (a second Filament surface per seat) is worse.
/// The second is still true. The first was measuring the wrong thing — 3.4 MB of
/// that is the TURNTABLE STRIPS, and the hero stills the seat actually needs are
/// 43 KB each. `stage-assets.sh` now ships the five stills and leaves the strips
/// behind, which is 215 KB to show the car somebody chose.
///
/// The drawing also could not do the job it was there for. Its own header
/// admitted "THE SHAPE IS DRESSING, not data … no claim is made that profile 2
/// is what `vehicle-racer.glb` looks like" — so four players picking four
/// different cars got four near-identical pickup outlines in four colours, and
/// the picker on their phones (which shows the real renders, from this same
/// file) disagreed with the TV they were looking at. A car picker whose two ends
/// draw different cars is worse than one that draws none.
///
/// **THE LIVERY IS NOT APPLIED HERE, and that is the web's rule too.** These
/// stills are baked per MODEL and carry the model's own colour; a player's
/// livery is on their NAME (`SeatCard.name` uses `Tokens.car(colorIndex)`),
/// which is why the card has no colour dot. Tinting the render would fight the
/// baked shading and produce a flat wash.
///
/// What is still dropped versus the web: the 24-frame turntable, which spins
/// every joined seat off one shared clock. See `stage-assets.sh` for the trade.
struct CarThumbnail: View {

    /// `modelIndex` off the seat grid: the car pick wrapped into the model
    /// roster by `ttp_ui_seat_grid_json`.
    ///
    /// It arrives already wrapped BUT POSSIBLY NEGATIVE — that ABI states it
    /// outright ("`modelIndex` wraps the car pick into the model roster and is
    /// JS `%`, so a negative pick stays negative: the shell's problem, not this
    /// layer's to launder"). `CarThumbnail.model` is where this shell launders
    /// it, with the same negative-safe modulo `Tokens.car` uses for the livery.
    let modelIndex: Int
    /// The player's livery. Kept in the signature because the placeholder below
    /// uses it — a seat whose still is missing should still read as theirs.
    let livery: Color

    /// `CAR_MODELS`, out of the protocol manifest rather than typed here: the
    /// still's filename IS the model id, so a car added to the manifest gets its
    /// picture with no edit to this file.
    private static let models: [String] = {
        let manifest = TTP.obj(ttp_protocol_manifest_json())
        return manifest["CAR_MODELS"] as? [String] ?? []
    }()

    private var model: String? {
        let n = Self.models.count
        guard n > 0 else { return nil }
        return Self.models[((modelIndex % n) + n) % n]
    }

    var body: some View {
        Group {
            if let image = model.flatMap({ StagedImage.image("toycar/thumbs/\($0).png") }) {
                image.resizable().scaledToFit()
            } else {
                // Not a broken-image box: a quiet livery-tinted card, so a seat
                // with an unstaged model still says whose it is.
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(livery.opacity(0.35))
                    .padding(6)
            }
        }
        // 5:4, matching `.carthumb`'s box in `theme.css` — and matching the open
        // seat's placeholder square, so a seat is the same size taken or not.
        // The stills are baked at 256x205, which is that ratio exactly.
        .aspectRatio(5.0 / 4.0, contentMode: .fit)
        .accessibilityHidden(true)   // the seat card carries the player's name
    }
}
