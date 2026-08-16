import Foundation

/// Where the renderer's bytes come from on this platform.
///
/// The engine owns every decision about a scene; what it does not own is
/// FETCHING, which is the one part of a scene build that is genuinely a platform
/// job (`ttp_theme.h` says so at the top: "fetching bytes is a platform job").
/// This type is that job and nothing else — it holds no opinion about which
/// asset is wanted, only about where a named one lives.
///
/// TWO SOURCES, and the split is `shells/tvos/scripts/stage-assets.sh`'s:
///
/// - **Bundled** (~7 MB): the toy-car kit, the baked cues, the Metal
///   `.filamat` blobs and `design-tokens.json`, staged into
///   `Bundle.main.resourceURL/assets/`. That directory is a **folder
///   reference** in `project.yml`, not a group, precisely so subdirectories
///   survive the copy: gltfio resolves an external texture by the exact URI
///   authored inside the GLB, so `"Textures/colormap.png"` has to be a real path
///   in the bundle and not a flattened `colormap.png`.
/// - **Remote**: everything else, from the origin this app already depends on
///   (the join QR points phones at it and the controller page is served from
///   it). The 81 MB music catalogue is the reason this leg exists — it streams
///   one song at a time exactly as the web's `<audio>` element does, rather than
///   riding in the .ipa.
@MainActor
final class AssetStore {

    /// The origin the phones are sent to, and the fallback for anything not
    /// staged.
    private let baseURL: URL

    /// `Bundle.main.resourceURL/assets`, resolved once. Nil only if the resource
    /// URL itself is missing, which cannot happen in a loaded app.
    private let staged: URL?

    /// In-flight and completed remote reads, keyed by the path asked for. Holding
    /// the `Task` rather than the `Data` is what makes two callers asking for the
    /// same texture at the same time cost one request — the second joins the
    /// first instead of racing it.
    private var remoteReads: [String: Task<Data?, Never>] = [:]

    private let session: URLSession

    init(baseURL: URL) {
        self.baseURL = baseURL
        self.staged = Bundle.main.resourceURL?.appendingPathComponent("assets", isDirectory: true)

        let config = URLSessionConfiguration.default
        // Bounded on purpose. `SceneStaging` falls back to this store's remote
        // leg for a model the bundle does not have, and that fallback sits
        // between the player pressing START and a track appearing — an
        // unbounded wait there is a race that never starts rather than a race
        // with one prop missing.
        config.timeoutIntervalForRequest = 10
        // The protocol's own policy, deliberately: a preview deploy replaces
        // these bytes on every push, and a cache that answered without
        // revalidating would show yesterday's model until the app was
        // reinstalled. Repeat fetches within one run are already free — see
        // `remoteReads`.
        config.requestCachePolicy = .useProtocolCachePolicy
        self.session = URLSession(configuration: config)
    }

    // MARK: - Bundle

    /// Read a staged file. `relativePath` is relative to the staged `assets/`
    /// root, so it is spelled the way `stage-assets.sh` writes it:
    /// `"toycar/tree.glb"`, `"materials/vlit.filamat"`,
    /// `"toycar/Textures/colormap.png"`.
    ///
    /// There is deliberately **no fallback to a flattened basename**. If the
    /// `assets/` folder reference ever regresses into an Xcode group, every
    /// texture URI stops resolving inside the renderer and no shell-side
    /// leniency could paper over that — better it fail here, where the path is
    /// still legible, than as an untextured world three screens later.
    ///
    /// Mapped rather than copied: the bytes exist only to be handed to
    /// `ttp_display_asset`, which copies them before it returns, so nothing here
    /// needs 4 MB of models resident.
    func bundled(_ relativePath: String) -> Data? {
        guard let staged else { return nil }
        let url = staged.appendingPathComponent(relativePath)
        return try? Data(contentsOf: url, options: .mappedIfSafe)
    }

    /// A model from the toy-car kit by its base name — the spelling every layer
    /// above uses, because that is how the engine names them:
    /// `ttp_theme_scenery_models` answers `["tree", "tree-pine"]` and
    /// `protocol.js`'s `CAR_MODELS` names `vehicle-racer`.
    ///
    /// Not cached. The bundle read is a memory map serviced by the unified page
    /// cache, so a per-race rebuild costs a handful of `open`s; a dictionary here
    /// would be a second copy of the same pages held for the life of the app.
    func glb(_ name: String) -> Data? {
        bundled("toycar/\(name).glb")
    }

    /// The design-token bake — `public/shared/theme.css`'s `:root`, typed and
    /// with aliases resolved, staged verbatim.
    ///
    /// `Tokens.swift` reads the same file through its own bundle lookup because
    /// it is deliberately not `@MainActor` (a `ButtonStyle` body has to reach the
    /// palette). This accessor is for anything that already holds the store.
    func designTokens() -> Data? {
        bundled("design-tokens.json")
    }

    // MARK: - Origin

    /// Fetch `path` from the origin, once. `path` is what the web would request —
    /// `"/assets/toycar/Textures/colormap.png"` — so the same string works
    /// against a preview deploy, a local dev server and production.
    ///
    /// A SUCCESS IS CACHED, A FAILURE IS NOT, and that is a deliberate departure
    /// from the web's `assetCache()`, which caches the promise either way. A page
    /// lives for one race night's worth of minutes and reloads on a whim; a TV
    /// app is launched once and left running, so a single flaky moment on the
    /// living-room wifi must not blank a texture until the app is force-quit.
    func remote(_ path: String) async -> Data? {
        if let existing = remoteReads[path] { return await existing.value }

        let task = Task<Data?, Never> { [session, baseURL] in
            guard let url = URL(string: path, relativeTo: baseURL) else { return nil }
            guard let (data, response) = try? await session.data(from: url) else { return nil }
            // A 404 arrives as a perfectly good response with an HTML body. Left
            // unchecked it would reach `ttp_display_asset` as a "model" and the
            // renderer would reject a container it was told to trust.
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else { return nil }
            return data
        }
        remoteReads[path] = task

        let data = await task.value
        if data == nil { remoteReads[path] = nil }
        return data
    }
}
