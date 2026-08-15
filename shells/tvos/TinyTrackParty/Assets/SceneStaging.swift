import Foundation

/// One slot of the field, as the RENDERER needs it — the shape
/// `ttp_display_build` takes, plus the one field that never crosses.
///
/// `id`, `name`, `carIndex` and `color` go across whole and the C++ side decides
/// everything about them: the livery's ABGR word, the name plate's characters,
/// how high that plate sits on this model's back panel. All of it is
/// `libttp-runtime/ttp/roster.h`'s, which is its only reader. It used to be a
/// version-stamped "track.bin" byte buffer packed by hand in each shell, agreeing
/// with the renderer by comment.
///
/// `model` is the exception and the reason this type exists rather than a bare
/// dictionary: it names GLB BYTES to fetch, and fetching is the platform's job.
/// It is the one roster field the ABI never sees.
struct RosterSlot {
    let id: EngineIdentity
    let name: String
    let carIndex: Int
    let color: String
    /// A toy-car kit base name from `protocol.js`'s `CAR_MODELS`
    /// (`vehicle-racer-low`, `vehicle-speedster`, `vehicle-racer`,
    /// `vehicle-vintage-racer`).
    let model: String
}

/// Getting bytes to the renderer, in the right order.
///
/// This is the tvOS half of what `public/display/render/Display.js`'s
/// `setTrack()` does, and its ORDER is a contract rather than a preference —
/// `ttp_display.h` states it beside the calls themselves. Each step
/// below carries the reason it sits where it does. Two of them (the biome latch
/// and the showcase latch) change what a LATER call resolves, and getting either
/// one late produces a scene that renders perfectly and is simply the wrong
/// world.
///
/// What this file deliberately does NOT do:
///
/// - **Parse a GLB container.** The 50%-alpha ghost clone and the texture-URI
///   scan were ~45 lines of byte surgery in `render/Display.js` until
///   `native/runtime/ttp_glb.h` gave them an ABI. They name no platform API, so
///   by the placement rule they belong where all three shells reach them — and
///   the ghost's chunk padding in particular (measured in BYTES, not UTF-16
///   units) is a trap that stays invisible until cgltf rejects a whole model.
///   Call `ttp_glb_ghost` / `ttp_glb_image_uris`; do not re-derive either.
/// - **Decide which scenery a biome stamps, or which biome a track wears.**
///   Both are `ttp_theme.h`'s.
/// - **Compute anything about the scene.** Nothing about a track's geometry or
///   its palette crosses this boundary in either direction; `ttp_display_build`
///   takes a track ID and a roster and resolves the rest in C++.
///
/// ## The `DisplayHost` surface this uses
///
/// Four members, and nothing else: `provide(_:_:)` (one asset's bytes, throwing
/// when `ttp_display_asset` refuses them), `hasScene`, `release()`, and
/// `sceneBuilt(rosterIds:biome:)` — the host owns "is a scene up", the
/// slot-ordered id list its HUD readback maps by, and the biome name the GO
/// beat keys its music pool off, and this is where all three become true.
@MainActor
enum SceneStaging {

    enum Failure: Error, CustomStringConvertible {
        case missingMaterial(String)
        case buildRejected(String)

        var description: String {
            switch self {
            case .missingMaterial(let name):
                return "scene: \(name) is not in the bundle — run shells/tvos/scripts/stage-assets.sh"
            case .buildRejected(let trackId):
                return "scene: ttp_display_build(\(trackId)) rejected the track"
            }
        }
    }

    // MARK: - Tables

    /// The materials, exactly as `render/Display.js`'s MATERIALS lists them —
    /// and EXACTLY is the contract: this list is a hand-kept mirror of that
    /// one, and each divergence so far has been a silent visual bug.
    ///
    /// ALL OF THEM ARE REQUIRED even though only one says so. `vcolor` fails
    /// loudly (`buildScene` returns false); the rest degrade SILENTLY — no
    /// `vpresent` and the cells fall back to Filament's own post chain, no
    /// `voverlay` and the steer bar and cell dividers simply vanish, and no
    /// `vglb`/`vglbfade` and `ensureAssetLoader` quietly keeps gltfio's PBR
    /// ubershader, so every kit GLB (all the cars) is lit by a different model
    /// than the scene around it — which is exactly how this shell shipped
    /// "the cars are very dark" while the track looked right. So the web's
    /// `if (res.ok)` skip is the wrong pattern to copy here and `materials()`
    /// throws on every one.
    ///
    /// `vdecal` is GONE, not forgotten: the road shader is the only decal path
    /// now, and demanding the retired blob aborted this loader halfway. `vskid`
    /// went the same way — the rubber layer rasterizes on the CPU and uploads,
    /// so there is no stamp material left to stage.
    static let materialNames = ["vcolor", "vblend", "vlit", "vroad", "vglb",
                                "vglbfade", "vpoint", "vcloud", "vground",
                                "vpresent", "vesm", "vblur", "vburst",
                                "voverlay"]

    /// The GLBs every scene needs whatever the track and the biome are: the
    /// track's own furniture, and the truck a monster item turns a car into. The
    /// scenery models are NOT here — those are the biome's, and C++ names them.
    static let propModels = ["item-box", "item-banana", "item-cone", "vehicle-monster-truck"]

    /// The two props that also need a translucent twin, and what the renderer
    /// looks each one up as.
    ///
    /// The item box's clone is not an optimisation: the kit material is OPAQUE,
    /// so the solid instance cannot be faded at all. The renderer hands a
    /// collected box over to this one and ramps its alpha down. (The clone's
    /// baked 0.5 never actually shows — the renderer writes the alpha on every
    /// frame a box is dissolving, and parks these instances the rest of the time.)
    private static let propGhosts = ["item-box": "item-box-fade.glb",
                                     "vehicle-monster-truck": "monster-ghost.glb"]

    /// Bumped by every `build`, so a build that is overtaken while it is fetching
    /// abandons instead of landing its stale roster on top of the newer one.
    /// `rebuildScene()` fires a fresh `Task` on every seat change, so two
    /// overlapping builds is an ordinary lobby, not a pathological case.
    private static var generation = 0

    // MARK: - Materials

    /// Hand the renderer its `.filamat` blobs. Once, at boot, **before any
    /// build** — `buildScene` reads them out of the asset map as it goes, and a
    /// material that arrives afterwards is a material that arrives for the next
    /// scene.
    ///
    /// THESE MUST BE THE METAL BLOBS, and there is no remote fallback for that
    /// reason: `.filamat` is `MATERIAL_VERSION`-locked to the Filament tree that
    /// loads it and carries backend-specific shaders, so the OpenGL set the
    /// origin serves to browsers would fail at material-load time inside the app
    /// rather than at build time. `native/scripts/build-runtime-tvos.sh` compiles
    /// them with the fork's own `matc`; `stage-assets.sh` copies those.
    static func materials(into display: DisplayHost, from store: AssetStore) throws {
        for name in materialNames {
            let file = "\(name).filamat"
            guard let bytes = store.bundled("materials/\(file)") else {
                throw Failure.missingMaterial(file)
            }
            try display.provide(file, bytes)
        }
    }

    // MARK: - The scene

    /// Build (or REBUILD) the scene for a track.
    ///
    /// **Every race start comes through here, including a restart.** A Grand Prix
    /// chains four tracks, and even re-racing the same one wants the skid
    /// ribbons, the kicked cones and the collected item boxes back at their
    /// opening state.
    ///
    /// `biome` is the inspector override (`?biome=` on the web). Nil means "the
    /// track's cup decides", which is resolved here rather than left implicit —
    /// see `resolveBiome`.
    ///
    /// A missing MODEL is not an error, unlike a missing material: the renderer
    /// draws a roster-coloured box marker for an absent car and an untextured
    /// prop for an absent texture, both deliberately. Failing the whole build
    /// over one would turn a cosmetic gap into a race that cannot start.
    static func build(trackId: String, biome: String?, roster: [RosterSlot], showcase: Bool,
                      display: DisplayHost, store: AssetStore) async throws {
        generation += 1
        let mine = generation

        // 1. SHOWCASE, first, because it is LATCHED and changes what step 7
        //    resolves — the asset gallery's showroom is the picked biome's
        //    palette carrying every biome's vocabulary. Pushed on every build
        //    rather than only when on: it is a latch, so leaving the showroom
        //    means saying so.
        ttp_display_showcase(showcase ? 1 : 0)

        // 2. Release the previous scene. `ttp_display_build` would do this
        //    itself, but not until the very end — and steps 3 to 6 are async, so
        //    without this the frame loop would keep drawing the OLD field, with
        //    the old roster baked into its slots, for the whole rebuild. The
        //    engine, the views, the materials and every provided asset survive a
        //    release, so the next build stays cheap.
        if display.hasScene { display.release() }

        // 3. THE BIOME, BEFORE ANY FETCHING. The scenery list is a function of
        //    it, so a fetch that runs first is a fetch of the wrong models.
        let resolved = resolveBiome(override: biome, trackId: trackId)
        ttp_display_biome(resolved)

        // 4. Scenery, in the SLOT ORDER C++ named. The index is the contract, not
        //    a suggestion: the renderer binds its instanced props by it, and
        //    `ttp_display_build` reads these same bytes back out on the C++ side
        //    to resolve the biome's recolour (which keys on each model's own
        //    authored material colours). `enumerated()` over the NAME list, so a
        //    model that fails to load leaves a hole rather than shifting every
        //    slot after it by one.
        let sceneryModels = showcase
            ? TTP.arr(ttp_theme_showcase_models()).compactMap { $0 as? String }
            : TTP.arr(ttp_theme_scenery_models(resolved)).compactMap { $0 as? String }

        var sceneryBytes: [Data] = []
        for (slot, name) in sceneryModels.enumerated() {
            guard let bytes = await modelBytes(name, store) else { continue }
            sceneryBytes.append(bytes)
            try display.provide("scenery\(slot).glb", bytes)
        }
        guard generation == mine else { return }

        // 5. Textures, under their EXACT authored URI. There is no path
        //    resolution on the C side — `registerAssetUris` walks the parsed
        //    asset's own resource URIs and looks each one up verbatim — so the
        //    name is literally "Textures/colormap.png". The scan is
        //    `ttp_glb_image_uris`, not a container parse here.
        //
        //    Only the SCENERY is scanned, plus the kit's shared palette
        //    unconditionally; the cars and props all reference that one file, and
        //    this mirrors what the web provides. `sorted()` only so the
        //    provisioning order is stable in a log.
        var textureURIs = Set<String>()
        for bytes in sceneryBytes { textureURIs.formUnion(imageURIs(of: bytes)) }
        textureURIs.insert("Textures/colormap.png")
        for uri in textureURIs.sorted() {
            guard let bytes = await textureBytes(uri, store) else { continue }
            try display.provide(uri, bytes)
        }
        guard generation == mine else { return }

        // 6. Cars by slot, then the props. `ghost(of:)` copies each clone out of
        //    the ABI's scratch as it derives it, because that buffer is reused by
        //    the very next `ttp_glb_ghost` call — a version of this loop that
        //    collected ghosts and provided them afterwards would hand every car
        //    the last one's body.
        for (slot, car) in roster.enumerated() {
            guard !car.model.isEmpty, let bytes = await modelBytes(car.model, store) else { continue }
            try display.provide("car\(slot).glb", bytes)
            if let ghost = ghost(of: bytes) { try display.provide("car\(slot)-ghost.glb", ghost) }
        }
        for name in propModels {
            guard let bytes = await modelBytes(name, store) else { continue }
            try display.provide("\(name).glb", bytes)
            if let ghostName = propGhosts[name], let ghost = ghost(of: bytes) {
                try display.provide(ghostName, ghost)
            }
        }
        guard generation == mine else { return }

        // 7. Build. A track ID and a roster, and nothing else: the geometry is
        //    the native TrackBuilder's (the same `ttp::RaceTrack` a session on
        //    this track races on, so the road drawn and the road driven are one
        //    object) and the palette is resolved from the biome latched at step
        //    3.
        //
        //    PREDICATE polarity: 1 is built (the outcome-style returns were
        //    retired with the polarity zoo — `ttp_abi.h`).
        let slots: [[String: Any]] = roster.map {
            // `numericOrString` rather than the id's text: a seat that joined as
            // the JSON number 3 must not be re-encoded as the string "3". They
            // are two different players to `ttp::parse_scalar_id`.
            ["id": $0.id.numericOrString, "name": $0.name,
             "carIndex": $0.carIndex, "color": $0.color]
        }
        guard ttp_display_build(trackId, TTP.json(slots)) != 0 else {
            throw Failure.buildRejected(trackId)
        }
        display.sceneBuilt(rosterIds: roster.map(\.id), biome: resolved)
    }

    /// Re-dress the BUILT scene's car slots in place (`ttp_display_reroster`):
    /// same slots in the same order, only models, liveries and names changed.
    /// The meshes, the baked shadows and the preview camera's orbit phase all
    /// stay put — which is the whole point: a lobby car pick must not snap the
    /// orbit back to its start bearing or pay a track re-mesh for a livery.
    ///
    /// Model swaps need their GLBs re-provided first (fetching is this side's
    /// job, exactly as at build); whether a change qualifies is C++'s call.
    /// `false` means it was NOT a re-dress — no scene, a join/leave/reorder —
    /// and the caller performs the full `build`.
    static func redress(roster: [RosterSlot], display: DisplayHost, store: AssetStore) async -> Bool {
        guard display.hasScene else { return false }
        for (slot, car) in roster.enumerated() {
            guard !car.model.isEmpty, let bytes = await modelBytes(car.model, store) else { continue }
            try? display.provide("car\(slot).glb", bytes)
            if let ghost = ghost(of: bytes) { try? display.provide("car\(slot)-ghost.glb", ghost) }
        }
        let slots: [[String: Any]] = roster.map {
            ["id": $0.id.numericOrString, "name": $0.name,
             "carIndex": $0.carIndex, "color": $0.color]
        }
        return ttp_display_reroster(TTP.json(slots)) != 0
    }

    // MARK: - The biome

    /// Which biome to latch, and it is resolved here rather than passed straight
    /// through because the two ends disagree about a bad name.
    ///
    /// `ttp_display_biome` IGNORES an unknown name (the `?biome=` contract is
    /// that a misspelling lets the cup decide rather than being an error), so the
    /// BUILD would fall back to the track's own cup. `ttp_theme_scenery_models`
    /// of that same unknown name falls back to GRASS. Hand the override through
    /// unchecked and a misspelling stages two pine trees for a beach. So: test it
    /// with `ttp_theme_has_biome`, which the header names as the validity test,
    /// and otherwise ask what this track wears.
    ///
    /// The web does the same thing one layer up (`Stage.js` resolves
    /// `biomeOverride || forTrack(id)` before it ever calls the renderer), which
    /// is why `Display.js` looks like it can pass the argument along untouched.
    private static func resolveBiome(override: String?, trackId: String) -> String {
        if let override, !override.isEmpty, ttp_theme_has_biome(override) != 0 {
            return override
        }
        return TTP.strOrEmpty(ttp_theme_biome_for_track(trackId))
    }

    // MARK: - Bytes

    /// A model by its kit base name. The bundle is the normal path and the origin
    /// is the safety net: `stage-assets.sh` copies the whole kit and
    /// `tests/display-abi.test.js` pins that directory to CARS ∪ PROPS ∪ scenery
    /// so it cannot silently grow, which means a bundle miss is a staging
    /// mistake rather than a design. Fetching it anyway costs one bounded request
    /// and turns "this prop is a coloured box" into "this prop loaded slowly".
    private static func modelBytes(_ name: String, _ store: AssetStore) async -> Data? {
        if let bytes = store.glb(name) { return bytes }
        return await store.remote("/assets/toycar/\(name).glb")
    }

    /// A texture by the URI its GLB authored. Same two sources, same reasoning;
    /// the URI is relative and both legs resolve it against the kit's directory.
    private static func textureBytes(_ uri: String, _ store: AssetStore) async -> Data? {
        if let bytes = store.bundled("toycar/\(uri)") { return bytes }
        return await store.remote("/assets/toycar/\(uri)")
    }

    /// A 50%-alpha, single-sided clone, for the renderer's fade instances.
    ///
    /// `ttp_glb_ghost` answers out of ABI scratch valid only until the NEXT call
    /// to it, so this copies into a `Data` before returning — the same reason the
    /// web takes a `slice()` and not a `subarray()`. Nil for a container that is
    /// not a GLB whose first chunk is JSON, which the caller treats as "provide
    /// nothing"; the renderer then falls back exactly as it does for a missing
    /// asset.
    private static func ghost(of bytes: Data) -> Data? {
        TTP.withBytes(bytes) { ptr, len -> Data? in
            var outLen: UInt32 = 0
            guard let out = ttp_glb_ghost(ptr, len, &outLen), outLen > 0 else { return nil }
            return Data(bytes: out, count: Int(outLen))
        }
    }

    /// Every `images[].uri` a container references, in file order and
    /// deduplicated. These have to be provided BEFORE the renderer parses the
    /// model, which is why they are read from the bytes here rather than asked of
    /// the loaded asset — `getResourceUris()` knows the answer, but only once it
    /// is too late to act on it.
    private static func imageURIs(of bytes: Data) -> [String] {
        TTP.withBytes(bytes) { ptr, len in
            TTP.arr(ttp_glb_image_uris(ptr, len)).compactMap { $0 as? String }
        }
    }
}
