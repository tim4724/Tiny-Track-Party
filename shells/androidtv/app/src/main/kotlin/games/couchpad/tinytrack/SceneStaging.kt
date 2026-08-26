package games.couchpad.tinytrack

import android.os.Trace
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * One slot of the field, as the RENDERER needs it — the shape
 * `ttp_display_build` takes, plus the one field that never crosses.
 *
 * `id`, `name`, `carIndex` and `color` go across whole and C++ decides
 * everything about them: the livery's ABGR word, how the marker is dressed. All
 * of it is `libttp-runtime/ttp/roster.h`'s, its only reader.
 *
 * [model] is the exception and the reason this type exists rather than a bare
 * map: it names GLB BYTES to fetch, and fetching is the platform's job. It is
 * the one roster field the ABI never sees.
 */
data class RosterSlot(
    val id: EngineId,
    val name: String,
    val carIndex: Int,
    val color: String,
    /** A toy-car kit base name from `protocol.js`'s `CAR_MODELS`. */
    val model: String,
)

/**
 * Getting bytes to the renderer, in the right order.
 *
 * The Android half of what `public/display/render/Display.js`'s `setTrack()`
 * does, and a direct port of `shells/tvos/.../SceneStaging.swift`. **The ORDER
 * is a contract rather than a preference** — `ttp_display.h` states it beside
 * the calls themselves. One step (the biome latch) changes what a LATER call
 * resolves, and getting it late produces a scene that renders perfectly and is
 * simply the wrong world.
 *
 * What this file deliberately does NOT do:
 *
 * - **Parse a GLB container.** The 50%-alpha ghost clone and the texture-URI
 *   scan are `ttp_glb.h`'s. They name no platform API, so by the placement rule
 *   they live where all three shells reach them — and the ghost's chunk padding
 *   (measured in BYTES) is a trap that stays invisible until cgltf rejects a
 *   whole model. Call the exports; do not re-derive either.
 * - **Decide which scenery a biome stamps, or which biome a track wears.** Both
 *   are `ttp_theme.h`'s.
 * - **Compute anything about the scene.** Nothing about a track's geometry or
 *   its palette crosses this boundary in either direction.
 */
object SceneStaging {

    private const val TAG = "SceneStaging"

    /**
     * The materials, exactly as `render/Display.js`'s MATERIALS lists them — and
     * EXACTLY is the contract: this is a hand-kept mirror of that list, and each
     * divergence so far has been a silent visual bug.
     *
     * ALL OF THEM ARE REQUIRED even though only one says so. `vcolor` fails
     * loudly (`buildScene` returns false); the rest degrade SILENTLY — no
     * `vpresent` and the cells fall back to Filament's own post chain, no
     * `voverlay` and the steer bar and cell dividers simply vanish, and no
     * `vglb`/`vglbfade` and gltfio keeps its PBR ubershader, so every kit GLB
     * (all the cars) is lit by a different model than the scene around it. That
     * last one is exactly how the tvOS shell shipped "the cars are very dark"
     * while the track looked right. So the web's `if (res.ok)` skip is the wrong
     * pattern to copy and this throws on every one.
     */
    val MATERIAL_NAMES = listOf(
        "vcolor", "vblend", "vlit", "vlitns", "vroad", "vglb", "vglbfade", "vpoint",
        "vcloud", "vground", "vvis", "vpresent", "vesm", "vblur", "vburst", "voverlay",
    )

    /**
     * The GLBs every scene needs whatever the track and biome are: the track's
     * own furniture, and the truck a monster item turns a car into. Scenery is
     * NOT here — that is the biome's, and C++ names it.
     */
    private val PROP_MODELS =
        listOf("item-box", "item-banana", "item-cone", "vehicle-monster-truck")

    /**
     * The two props that also need a translucent twin, and what the renderer
     * looks each one up as. The item box's clone is not an optimisation: the kit
     * material is OPAQUE, so the solid instance cannot be faded at all.
     */
    private val PROP_GHOSTS = mapOf(
        "item-box" to "item-box-fade.glb",
        "vehicle-monster-truck" to "monster-ghost.glb",
    )

    /**
     * The toy-car kit's shared palette. Authored into some models and not
     * others, so it is asked for by name rather than discovered by the scan.
     */
    private const val PALETTE_URI = "Textures/colormap.png"

    class Failure(message: String) : Exception(message)

    /** What [build] handed the renderer this time round — see its step timing. */
    private var providedBytes = 0L
    private var providedCount = 0

    // -- materials ----------------------------------------------------------

    /**
     * Hand the renderer its `.filamat` blobs. Once, at boot, **before any
     * build** — `buildScene` reads them out of the asset map as it goes, and a
     * material that arrives afterwards is a material for the next scene.
     *
     * THESE ARE THE WEB'S OWN BYTES, and that is correct rather than a shortcut:
     * `build-materials.sh` defaults to `opengl mobile`, which is what the
     * browser ships and what this wants. tvOS is the leg that needs its own set.
     */
    fun materials(display: DisplayHost, store: AssetStore) {
        // NOTHING TO INVALIDATE HERE ANY MORE. This used to be the beat that
        // cleared a shell-side mirror of the engine's asset map, because a
        // destroyed surface takes that map away and it runs on every surface
        // create. The mirror is gone — `ttp_display_asset_plan` answers off the
        // map itself, which cannot outlive it.
        //
        // A Vulkan engine reads the SPIR-V twins: a GL blob does not parse on
        // a Vulkan engine. The choice is the surface's, made at create
        // (VulkanPolicy) — never re-derived here, where a disagreement would
        // fail as a parse abort mid-boot.
        val dir = if (display.usingVulkan) "materials-vk" else "materials"
        for (name in MATERIAL_NAMES) {
            val file = "$name.filamat"
            val bytes = store.bundled("$dir/$file")
                ?: throw Failure(
                    "$dir/$file is not in the APK — run shells/androidtv/scripts/stage-assets.sh" +
                        if (dir == "materials-vk")
                            " after native/scripts/build-runtime-android.sh (the Vulkan set is build output)"
                        else "")
            provide(display, file, bytes)
        }
    }

    // -- the scene ----------------------------------------------------------

    /**
     * Build (or REBUILD) the scene for a track.
     *
     * **Every race start comes through here, including a restart.** A Grand Prix
     * chains four tracks, and even re-racing the same one wants the skid
     * ribbons, kicked cones and collected boxes back at their opening state.
     *
     * A missing MODEL is not an error, unlike a missing material: the renderer
     * draws a roster-coloured box marker for an absent car, deliberately.
     * Failing the whole build over one would turn a cosmetic gap into a race
     * that cannot start.
     */
    fun build(
        trackId: String,
        roster: List<RosterSlot>,
        display: DisplayHost,
        store: AssetStore,
        blobs: BlobStores? = null,
    ): String {
        // THE STEPS ARE TIMED SEPARATELY. A build measures 737-1323 ms on the
        // reference box and blocks the main thread for all of it, inbound relay
        // frames included — so which STEP that is decides the whole cure, and one
        // total cannot say. Provisioning is re-read-and-re-hand-over work, and
        // the engine's own asset plan is what removes it; `ttp_display_build` is
        // geometry that only an unchanged track could reuse. `provide` counts the
        // bytes, so "how much did we hand over again" reads off the same line.
        val split = LongArray(5)
        var mark = System.nanoTime()
        fun step(i: Int) { val now = System.nanoTime(); split[i] = now - mark; mark = now }
        providedBytes = 0
        providedCount = 0

        // 1. Release the previous scene. `ttp_display_build` would do this
        //    itself, but not until the very end — so without this the frame loop
        //    keeps drawing the OLD field, with the old roster baked into its
        //    slots, for the whole rebuild. The engine, views, materials and
        //    provided assets survive a release, so the next build stays cheap.
        Trace.beginSection("ttp:build.release")
        Ttp.ttp_display_release()
        Trace.endSection()
        step(0)

        // 2. THE BIOME, BEFORE ANY FETCHING. The scenery list is a function of
        //    it, so a fetch that runs first is a fetch of the wrong models.
        val resolved = TtpJson.strOrEmpty(Ttp.ttp_theme_biome_for_track(TtpJson.arg(trackId)))
        Ttp.ttp_display_biome(TtpJson.arg(resolved))
        step(1)

        // 3. WHAT THIS SCENE IS MADE OF, as names paired with the kit model
        //    each one's bytes come from. Nothing is read yet: which of these the
        //    engine is already holding is its own knowledge
        //    (`ttp_display_asset_plan`), and asking is what turns a rebuild of a
        //    standing track from a full re-inflate into almost nothing.
        //
        //    THIS FILE USED TO ANSWER IT ITSELF, with a `provided` map beside
        //    the fetch loop and a `sceneryUris` memo beside that — a mirror of
        //    the engine's asset map that had to be cleared by hand on the beat a
        //    destroyed surface took that map away. Both are gone. The other two
        //    shells never had them and simply re-fetched everything on every
        //    build, which is the same bug pointing the other way.
        //
        //    Scenery goes in the SLOT ORDER C++ named. The index IS the
        //    contract: the renderer binds its instanced props by it, and
        //    `ttp_display_build` reads these same bytes back on the C++ side to
        //    resolve the biome's recolour. Iterating the NAME list means a model
        //    that fails to load leaves a hole rather than shifting every slot
        //    after it by one.
        Trace.beginSection("ttp:build.models")
        val sceneryModels = TtpJson.strings(Ttp.ttp_theme_scenery_models(TtpJson.arg(resolved)))
        val want = JSONArray()
        sceneryModels.forEachIndexed { slot, model ->
            want.put(JSONObject().put("name", "scenery$slot.glb").put("tag", model))
        }
        carWants(roster, want)
        for (model in PROP_MODELS) {
            want.put(JSONObject().put("name", "$model.glb").put("tag", model))
            PROP_GHOSTS[model]?.let { ghostName ->
                want.put(JSONObject().put("name", ghostName).put("tag", model)
                    .put("from", "$model.glb"))
            }
        }
        fetchPlanned(want, display, store)
        Trace.endSection()
        step(2)

        // 4. Textures, under their EXACT authored URI. There is no path
        //    resolution on the C side.
        //
        //    THE URI LIST IS THE ENGINE'S, off the bytes it is holding, so a
        //    model the plan above skipped still contributes its textures and
        //    nothing here re-reads a container it just handed over — which is
        //    what the `sceneryUris` memo used to buy, one shell out of three.
        //    The kit's shared palette is asked for by name because it is
        //    authored into some models and not others. Both go through the plan
        //    so their tags are stamped and the next build knows they are held.
        Trace.beginSection("ttp:build.textures")
        val texWant = JSONArray()
        texWant.put(JSONObject().put("name", PALETTE_URI).put("tag", PALETTE_URI))
        for (uri in TtpJson.strings(Ttp.ttp_display_asset_textures())) {
            texWant.put(JSONObject().put("name", uri).put("tag", uri))
        }
        for (uri in TtpJson.strings(Ttp.ttp_display_asset_plan(TtpJson.arg(texWant.toString())))) {
            val bytes = store.texture(uri) ?: continue
            provide(display, uri, bytes)
        }
        Trace.endSection()
        step(3)

        // 5. THE BLOB WALK, first half — AFTER provisioning and before the
        //    build, which is the one window that suits every store: the bake's
        //    key needs the biome (latched at step 2), the masks' are derived
        //    from the car GLBs handed over at step 3. NOTHING HERE NAMES A BLOB
        //    KIND; the engine lists its stores and this performs the answers.
        //    The walk's SECOND half is not here at all — it is a frame beat
        //    (`DisplayHost.writeReadyBlobs`), for the reason `ttp_display.h`
        //    gives: a readback does not finish inside the build that issues it
        //    on every backend, so a build's tail is the wrong place to ask.
        blobs?.forEach { store, name ->
            val plan = TtpJson.obj(Ttp.ttp_display_blob_plan(
                TtpJson.arg(name), TtpJson.arg(trackId), TtpJson.arg(store.generation),
                TtpJson.arg(store.entriesJson())))
            val drop = plan.optJSONArray("drop") ?: JSONArray()
            // Plain strings, never JSON null — unlike `read`, which is why only
            // that one needs the optStr guard.
            for (i in 0 until drop.length()) {
                drop.optString(i).takeIf { it.isNotEmpty() }?.let { store.delete(it) }
            }
            // Plain strings too, now that `read` is a LIST: an empty array is
            // the miss, so there is no JSON null left on this walk for
            // org.json's optString to turn into the string "null"
            // (tests/androidtv-nullable-json.test.js still guards the ones there
            // are).
            val read = plan.optJSONArray("read") ?: JSONArray()
            for (i in 0 until read.length()) {
                val blobName = read.optString(i).takeIf { it.isNotEmpty() } ?: continue
                store.read(blobName)?.let { Ttp.ttp_display_blob_offer(TtpJson.arg(name), it) }
            }
        }

        // 6. Build. A track ID and a roster, and nothing else: the geometry is
        //    the native TrackBuilder's (the same ttp::RaceTrack a session on
        //    this track races on, so the road drawn and the road driven are one
        //    object) and the palette comes from the biome latched at step 2.
        //
        //    PREDICATE polarity: 1 is built.
        val slots = JSONArray()
        for (car in roster) {
            slots.put(
                JSONObject()
                    // boxed(), never the id's text: a seat that joined as the
                    // JSON number 3 must not be re-encoded as the string "3".
                    // They are two different players to ttp::parse_scalar_id.
                    .put("id", car.id.boxed())
                    .put("name", car.name)
                    .put("carIndex", car.carIndex)
                    .put("color", car.color)
            )
        }
        Trace.beginSection("ttp:build.native")
        val built = Ttp.ttp_display_build(TtpJson.arg(trackId), TtpJson.arg(slots.toString()))
        Trace.endSection()
        step(4)
        if (built == 0) {
            throw Failure("ttp_display_build($trackId) rejected the track: " +
                TtpJson.strOrEmpty(Ttp.ttp_last_error()))
        }
        Log.i(TAG, String.format(java.util.Locale.ROOT,
            "build split %s: release %.0f biome %.0f models %.0f textures %.0f native %.0f ms" +
                " (%d assets, %d KiB handed over)",
            trackId, split[0] / 1e6, split[1] / 1e6, split[2] / 1e6, split[3] / 1e6,
            split[4] / 1e6, providedCount, providedBytes / 1024))
        return resolved
    }

    /**
     * Re-dress the BUILT scene's car slots in place: same slots in the same
     * order, only models, liveries and names changed. The meshes, baked shadows
     * and the preview camera's orbit phase all stay put — which is the point: a
     * lobby car pick must not snap the orbit back to its start bearing or pay a
     * track re-mesh for a livery.
     *
     * `false` means it was NOT a re-dress — no scene, a join/leave/reorder — and
     * the caller performs the full [build].
     */
    fun redress(roster: List<RosterSlot>, display: DisplayHost, store: AssetStore): Boolean {
        // ONLY THE SLOTS WHOSE MODEL MOVED, and the engine is what says which:
        // the livery, the name and the id ride the reroster below and need no
        // bytes at all. That is most of the calls — the roster moves for a ready
        // toggle, a rename, a welcome or a seat expiry, none of which change one.
        Trace.beginSection("ttp:redress")
        fetchPlanned(carWants(roster, JSONArray()), display, store)
        Trace.endSection()
        val slots = JSONArray()
        for (car in roster) {
            slots.put(
                JSONObject().put("id", car.id.boxed()).put("name", car.name)
                    .put("carIndex", car.carIndex).put("color", car.color)
            )
        }
        return Ttp.ttp_display_reroster(TtpJson.arg(slots.toString())) != 0
    }

    // -- bytes --------------------------------------------------------------

    /**
     * PREDICATE polarity: 1 is accepted, like every int on this ABI since the
     * polarity zoo was retired (`ttp_abi.h`: "ONE polarity: truth is non-zero.
     * The factories trio used to carry C exit-status polarity (0 = success) —
     * flipped").
     *
     * Worth the note because the stale rule is still written down: `TTP.swift`'s
     * header names `ttp_display_asset` and `ttp_display_build` as OUTCOME
     * returns where 0 means success. It is wrong, `DisplayHost.swift` next to it
     * is right, and reading the comment rather than the header cost this file a
     * round of "every material was refused" on the first device run.
     */
    private fun provide(display: DisplayHost, name: String, bytes: ByteArray) {
        providedBytes += bytes.size
        providedCount += 1
        if (!display.provideAsset(name, bytes)) Log.w(TAG, "ttp_display_asset($name) refused")
    }

    // -- what still has to be fetched ---------------------------------------

    /**
     * The per-slot car GLBs and their 50%-alpha ghost twins, appended to [want]
     * in the plan's vocabulary: `car<slot>.glb` tagged by the MODEL its bytes
     * come from, since that is the only thing about a slot that changes them. A
     * slot with no model tags as `""` so a later pick reads as a change rather
     * than as "unchanged".
     */
    private fun carWants(roster: List<RosterSlot>, want: JSONArray): JSONArray {
        roster.forEachIndexed { slot, car ->
            want.put(JSONObject().put("name", "car$slot.glb").put("tag", car.model))
            if (car.model.isNotEmpty()) {
                want.put(JSONObject().put("name", "car$slot-ghost.glb").put("tag", car.model)
                    .put("from", "car$slot.glb"))
            }
        }
        return want
    }

    /**
     * Read and hand over exactly what the engine says it still needs, then
     * derive the ghosts out of the models that came with them — a wanted
     * derivative always brings its source (`ttp_display.h`).
     *
     * The ghost is copied out of the ABI's scratch as it is derived: the
     * generated bridge already returns a fresh ByteArray, which is why there is
     * no copy step here and why the tvOS twin needs one.
     */
    private fun fetchPlanned(want: JSONArray, display: DisplayHost, store: AssetStore) {
        val need = TtpJson.strings(Ttp.ttp_display_asset_plan(TtpJson.arg(want.toString()))).toSet()
        val fetched = HashMap<String, ByteArray>()
        for (i in 0 until want.length()) {
            val w = want.optJSONObject(i) ?: continue
            // optStr throughout, even though this file BUILT these objects and
            // knows none of its values is JSON null: `name` is a nullable key
            // elsewhere on this ABI, and tests/androidtv-nullable-json.test.js
            // gates the spelling rather than the provenance — which is the right
            // way round, since provenance is exactly what a reader gets wrong.
            val name = TtpJson.optStr(w, "name") ?: continue
            if (name !in need) continue
            if (TtpJson.optStr(w, "from") != null) continue
            val tag = TtpJson.optStr(w, "tag") ?: continue
            if (tag.isEmpty()) continue
            val bytes = store.glb(tag) ?: continue
            fetched[name] = bytes
            provide(display, name, bytes)
        }
        for (i in 0 until want.length()) {
            val w = want.optJSONObject(i) ?: continue
            val name = TtpJson.optStr(w, "name") ?: continue
            if (name !in need) continue
            val from = TtpJson.optStr(w, "from") ?: continue
            val src = fetched[from] ?: continue
            Ttp.ttp_glb_ghost(src)?.let { provide(display, name, it) }
        }
    }
}
