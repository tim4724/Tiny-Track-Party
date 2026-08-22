import Foundation
import TVServices

// The Apple TV home row's feature banner, as a CAROUSEL rather than the one flat
// picture the asset catalogue can hold.
//
// WHY AN EXTENSION AT ALL. `Brand Assets.brandassets` carries exactly one
// `Top Shelf Image` (1920x720, plus the 2320x720 wide variant). One picture, no
// rotation, no per-cup. tvOS 13 added `TVTopShelfCarouselContent` for the rest:
// a FULL-SCREEN 16:9 carousel the system pages through while the app is focused,
// which is the only shape in which "one frame per cup" exists on this platform.
// The catalogue's static image stays and stays current — it is what the shelf
// draws if this extension is ever absent or slow.
//
// .actions, NOT .details. The details style wants cast, duration, genre and a
// summary; it is built for a video catalogue. The actions style is the image with
// a title and two buttons over it, which is what a game has to say.
//
// EVERY ITEM OPENS THE APP AND NOTHING ELSE. The frames are cups and situations,
// not deep links — there is no per-cup entry point in the app to link to, and a
// carousel item whose Play button lands somewhere unexpected is worse than one
// that just opens the game. Both actions carry the same bare app URL; give them
// distinct routes on the day the app grows them.
//
// THE ORDER AND THE TITLES COME FROM carousel.json, staged beside the frames by
// stage-assets.sh out of the same bake that captured them
// (scripts/bake-shelf.mjs). Nothing is retyped here: a set whose running order
// lived in Swift and whose pictures lived in a capture script would drift the
// first time a frame was renamed.
final class ContentProvider: TVTopShelfContentProvider {

    private struct Manifest: Decodable {
        struct Item: Decodable {
            let id: String
            let context: String
            let title: String
        }
        let items: [Item]
    }

    override func loadTopShelfContent(completionHandler: @escaping (TVTopShelfContent?) -> Void) {
        completionHandler(carousel())
    }

    private func carousel() -> TVTopShelfContent? {
        let bundle = Bundle(for: type(of: self))
        guard let manifestURL = bundle.url(forResource: "carousel", withExtension: "json",
                                           subdirectory: "shelf"),
              let data = try? Data(contentsOf: manifestURL),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data)
        else { return nil }

        // A missing frame drops that ITEM, never the whole carousel: a shelf short
        // one cup still sells the game, an empty one draws the platform placeholder.
        let items: [TVTopShelfCarouselItem] = manifest.items.compactMap { entry in
            guard let at1x = bundle.url(forResource: entry.id, withExtension: "jpg",
                                        subdirectory: "shelf")
            else { return nil }

            let item = TVTopShelfCarouselItem(identifier: entry.id)
            item.title = entry.title
            item.contextTitle = entry.context
            // BOTH TRAITS, and the 2x one is what an Apple TV 4K actually draws:
            // the shelf lays out in 1920x1080 POINTS and the 4K box renders it at
            // 2x, so a 1x-only set is upscaled on every frame — which is what
            // "the images are very blurry" looked like on the television.
            item.setImageURL(at1x, for: .screenScale1x)
            if let at2x = bundle.url(forResource: "\(entry.id)@2x", withExtension: "jpg",
                                     subdirectory: "shelf") {
                item.setImageURL(at2x, for: .screenScale2x)
            }
            item.displayAction = TVTopShelfAction(url: Self.appURL)
            item.playAction = TVTopShelfAction(url: Self.appURL)
            return item
        }
        guard !items.isEmpty else { return nil }
        return TVTopShelfCarouselContent(style: .actions, items: items)
    }

    // The app's own scheme, declared by the app's CFBundleURLTypes. Opening it
    // with no path is "just launch", which is every item's action today.
    private static let appURL = URL(string: "tinytrack://")!
}
