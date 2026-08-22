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
        // The multiview resolve — this shell is the one leg that draws it, and
        // only when the staged set is the multiview one (stage-assets.sh). It
        // is in the throw-on-missing list like the rest: the APK either ships
        // a whole set or it does not.
        "vpresentmv",
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

    class Failure(message: String) : Exception(message)

    /**
     * What the renderer already HOLDS: asset name → the source those bytes came
     * from (a kit base name, or a texture's authored URI).
     *
     * Provisioning is re-read-and-re-hand-over work, and almost all of it is
     * re-work. `mAssets` survives `releaseScene` (`TtpRenderer.cpp` says so at
     * the top of it), so across two builds the props are always the same bytes,
     * the textures always are, the scenery is whenever the biome held, and the
     * cars are unless somebody actually picked a different one. Without this
     * every build re-inflated each of those out of the APK, re-derived every
     * ghost, and copied the lot across JNI into a map that already had them.
     * [redress] is worse: the roster moves for a ready toggle, a rename, a
     * welcome or a seat expiry, none of which change a single byte.
     *
     * THE TAG IS WHAT THE BYTES ARE A FUNCTION OF, which is why it is the source
     * rather than the name: `car3.glb` is different bytes when slot 3 picks a
     * different model, while `Textures/colormap.png` never is. A slot with no
     * model tags as `""` so that a later pick reads as a change.
     *
     * IT MIRRORS THE RENDERER'S ASSET MAP, so it is only ever valid while that map
     * is. [materials] clears it, which is exactly the right hook: it runs on every
     * surface create, before any build, and a destroyed surface is precisely what
     * takes the asset map with it (shells/androidtv/CLAUDE.md).
     */
    private val provided = HashMap<String, String>()

    /**
     * The image URIs a scenery model references, scanned once per model.
     *
     * The texture step needs this list and used to get it by scanning the GLB it
     * had just read — which is the read this memo exists to skip. Cleared with
     * [provided] rather than kept for the run: the two are read together, and one
     * lifetime is one thing to be wrong about.
     */
    private val sceneryUris = HashMap<String, List<String>>()

    /** What [build] handed the renderer this time round — see its step timing. */
    private var providedBytes = 0L
    private var providedCount = 0

    /** …and what it did not, because [provided] said the renderer had it. */
    private var reusedCount = 0

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
        // The asset map is fresh (see [provided]): nothing the renderer holds
        // survived, so nothing this remembers may either.
        provided.clear()
        sceneryUris.clear()
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
        // THE SIX STEPS ARE TIMED SEPARATELY. A build measures 737-1323 ms on the
        // reference box and blocks the main thread for all of it, inbound relay
        // frames included — so which STEP that is decides the whole cure, and one
        // total cannot say. Provisioning is re-read-and-re-hand-over work, and
        // [provided] is what removes it; `ttp_display_build` is geometry that only
        // an unchanged track could reuse. `provide` also counts the bytes, and the
        // log carries the REUSED count beside them, because "how much did we hand
        // over again" is the other half of that question.
        val split = LongArray(6)
        var mark = System.nanoTime()
        fun step(i: Int) { val now = System.nanoTime(); split[i] = now - mark; mark = now }
        providedBytes = 0
        providedCount = 0
        reusedCount = 0

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

        // 3. Scenery, in the SLOT ORDER C++ named. The index IS the contract:
        //    the renderer binds its instanced props by it, and
        //    `ttp_display_build` reads these same bytes back on the C++ side to
        //    resolve the biome's recolour. Iterating the NAME list means a model
        //    that fails to load leaves a hole rather than shifting every slot
        //    after it by one.
        Trace.beginSection("ttp:build.scenery")
        val sceneryModels = TtpJson.strings(Ttp.ttp_theme_scenery_models(TtpJson.arg(resolved)))
        // The URI scan rides this step rather than the texture one because it
        // needs the container's bytes, and this is the only place that has them.
        // On a repeat biome nothing here is read at all and the scan answers from
        // [sceneryUris], which is the whole point.
        val uris = sortedSetOf<String>()
        sceneryModels.forEachIndexed { slot, model ->
            val name = "scenery$slot.glb"
            if (provided[name] == model) {
                reusedCount += 1
                uris.addAll(sceneryUris[model].orEmpty())
                return@forEachIndexed
            }
            val bytes = store.glb(model) ?: return@forEachIndexed
            provide(display, name, bytes)
            provided[name] = model
            uris.addAll(sceneryUris.getOrPut(model) { imageUris(bytes) })
        }
        Trace.endSection()
        step(2)

        // 4. Textures, under their EXACT authored URI. There is no path
        //    resolution on the C side. Only the SCENERY is scanned, plus the
        //    kit's shared palette unconditionally — the cars and props all
        //    reference that one file. Sorted only so the order is stable in a log.
        Trace.beginSection("ttp:build.textures")
        uris.add("Textures/colormap.png")
        for (uri in uris) {
            // A texture's bytes are a function of its name alone, so the tag IS
            // the name: past the first build that provisions it, every scene in
            // the run reuses it whatever the biome does.
            if (provided[uri] == uri) { reusedCount += 1; continue }
            val bytes = store.texture(uri) ?: continue
            provide(display, uri, bytes)
            provided[uri] = uri
        }
        Trace.endSection()
        step(3)

        // 5. Cars by slot, then the props. The ghost is copied out of the ABI's
        //    scratch as it is derived — the generated bridge already returns a
        //    fresh ByteArray, which is why there is no copy step here and why
        //    the tvOS file needed one.
        Trace.beginSection("ttp:build.cars")
        roster.forEachIndexed { slot, car ->
            val name = "car$slot.glb"
            // "" for a slot with no model, so a later pick reads as a change
            // rather than as "unchanged". Note the engine may still hold the
            // model this slot had two builds ago under the same name; that has
            // always been true and nothing references it.
            if (car.model.isEmpty()) { provided[name] = ""; return@forEachIndexed }
            if (provided[name] == car.model) { reusedCount += 1; return@forEachIndexed }
            val bytes = store.glb(car.model) ?: return@forEachIndexed
            provide(display, name, bytes)
            provided[name] = car.model
            // The ghost is DERIVED from those bytes, so it is skipped with them —
            // `ttp_glb_ghost` is byte surgery over a whole container.
            Ttp.ttp_glb_ghost(bytes)?.let {
                provide(display, "car$slot-ghost.glb", it)
                provided["car$slot-ghost.glb"] = car.model
            }
        }
        for (model in PROP_MODELS) {
            val name = "$model.glb"
            if (provided[name] == model) { reusedCount += 1; continue }
            val bytes = store.glb(model) ?: continue
            provide(display, name, bytes)
            provided[name] = model
            PROP_GHOSTS[model]?.let { ghostName ->
                Ttp.ttp_glb_ghost(bytes)?.let {
                    provide(display, ghostName, it)
                    provided[ghostName] = model
                }
            }
        }
        Trace.endSection()
        step(4)

        // 5b. THE BLOB WALKS, first half — AFTER provisioning and before the
        //     build, which is the one window that suits every store: the bake's
        //     key needs the biome (latched at step 2), the masks' is derived
        //     from the car GLBs handed over at step 5. NOTHING HERE NAMES A BLOB
        //     KIND; the engine lists its stores and this performs the answers.
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
            // optStr, not optString: `read` is a key the ABI spells JSON null,
            // and org.json's optString would hand back the STRING "null" — a
            // read of a file called "null" (tests/androidtv-nullable-json.test.js
            // keeps everyone honest about it).
            TtpJson.optStr(plan, "read")?.let { blobName ->
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
        step(5)
        if (built == 0) {
            throw Failure("ttp_display_build($trackId) rejected the track: " +
                TtpJson.strOrEmpty(Ttp.ttp_last_error()))
        }
        // THE WALKS' second half. Whether this build made anything worth keeping
        // — and whether the store already has it — is the engine's to know; an
        // export costs a readback per texture, so it is asked for only when a
        // name comes back.
        blobs?.forEach { store, name ->
            TtpJson.optStr(TtpJson.obj(Ttp.ttp_display_blob_keep(TtpJson.arg(name))),
                    "write")?.let { blobName ->
                Ttp.ttp_display_blob_export(TtpJson.arg(name))?.let { blob ->
                    store.write(blobName, blob)
                    Log.i(TAG, "$name stored as $blobName (${blob.size / 1024} KiB)")
                }
            }
        }
        Log.i(TAG, String.format(java.util.Locale.ROOT,
            "build split %s: release %.0f biome %.0f scenery %.0f textures %.0f cars+props %.0f native %.0f ms" +
                " (%d assets, %d KiB handed over, %d already held)",
            trackId, split[0] / 1e6, split[1] / 1e6, split[2] / 1e6, split[3] / 1e6,
            split[4] / 1e6, split[5] / 1e6, providedCount, providedBytes / 1024, reusedCount))
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
        // ONLY THE SLOTS WHOSE MODEL MOVED — see [provided] for why that is most
        // of the calls. The livery, the name and the id ride the reroster below
        // and need no bytes at all; only a different MODEL does.
        Trace.beginSection("ttp:redress")
        roster.forEachIndexed { slot, car ->
            val name = "car$slot.glb"
            if (car.model.isEmpty()) return@forEachIndexed
            if (provided[name] == car.model) return@forEachIndexed
            val bytes = store.glb(car.model) ?: return@forEachIndexed
            provide(display, name, bytes)
            provided[name] = car.model
            Ttp.ttp_glb_ghost(bytes)?.let {
                provide(display, "car$slot-ghost.glb", it)
                provided["car$slot-ghost.glb"] = car.model
            }
        }
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

    /**
     * Every `images[].uri` a container references, in file order and
     * deduplicated. These must be provided BEFORE the renderer parses the model,
     * which is why they are read from the bytes here rather than asked of the
     * loaded asset — `getResourceUris()` knows the answer, but only once it is
     * too late to act on it.
     */
    private fun imageUris(bytes: ByteArray): List<String> =
        TtpJson.strings(Ttp.ttp_glb_image_uris(bytes))
}
