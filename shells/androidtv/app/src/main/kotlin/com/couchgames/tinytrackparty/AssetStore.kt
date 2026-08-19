package com.couchgames.tinytrackparty

import android.content.res.AssetManager
import java.io.IOException

/**
 * Bytes, out of the APK.
 *
 * `shells/androidtv/scripts/stage-assets.sh` assembles `assets/` from the one
 * place each thing is authored, so every path here is a path in that script.
 * A miss is therefore a STAGING mistake, not a design — which is why nothing
 * below falls back to inventing content.
 *
 * NOT A CACHE. `AssetManager.open` reads from the APK's own mapped zip, so
 * holding decompressed copies of 3.8 MB of GLBs would trade the one thing this
 * device has least of (a 32-bit address space) for a read that is already
 * cheap. The renderer copies what it is given (`ttp_display_asset` copies before
 * returning), so nothing here needs to outlive its call.
 */
class AssetStore(private val assets: AssetManager) {

    /** Read a staged asset by its path under `assets/`. Null when absent. */
    fun bundled(path: String): ByteArray? = try {
        assets.open(path).use { it.readBytes() }
    } catch (_: IOException) {
        null
    }

    /** A kit model by its base name, e.g. `vehicle-racer`. */
    fun glb(name: String): ByteArray? = bundled("toycar/$name.glb")

    /**
     * A texture by the URI its GLB authored. Relative, and resolved against the
     * kit directory on both legs — the name is literally
     * `Textures/colormap.png`, because there is no path resolution on the C
     * side: `registerAssetUris` looks each URI up verbatim.
     */
    fun texture(uri: String): ByteArray? = bundled("toycar/$uri")

    /**
     * There is deliberately no remote leg yet, unlike the tvOS store's. That
     * one exists as a safety net for a bundle miss and is reached by nothing on
     * the shipping path. What genuinely needs the origin is the race MUSIC,
     * which streams one song at a time and never comes through this object.
     */
}
