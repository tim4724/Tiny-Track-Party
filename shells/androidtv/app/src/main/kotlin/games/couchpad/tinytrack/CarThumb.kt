package games.couchpad.tinytrack

import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale

/**
 * `.carthumb` — the baked front-3/4 still of a car model, which is what makes a
 * lobby seat show the car its player actually picked.
 *
 * The renders are PRE-BAKED and already in the APK: `stage-assets.sh` copies
 * `toycar/thumbs/<model>.png` in with the model kit, precisely so a lobby seat
 * costs no 3D. Until this file landed, nothing read them and the seat drew a flat
 * livery disc instead — a shape standing in for a car, on the one board whose job
 * is to tell four people which car is theirs.
 *
 * **THE STILL ONLY.** The web spins a 24-frame turntable strip; those strips are
 * deliberately left out of the bundle (`stage-assets.sh`: ~800 KB each, "to make
 * seats rotate behind a board nobody is looking at yet"). A still is what the web
 * shows at any given instant anyway, and it is what the gallery photographs — so
 * the difference is a motion one, and it is a decision rather than a gap.
 *
 * Frames are 5:4 (256x205), which is what `.carthumb`'s aspect-ratio is set to;
 * a seat reserving a different box would letterbox its own car.
 */
object CarThumb {

    /** The web's `.carthumb` box, and the baked frames' own ratio. */
    const val ASPECT = 5f / 4f

    private var assets: AssetManager? = null
    private val cache = HashMap<String, Bitmap?>()

    /** Called once from the coordinator's init, beside `ItemIcon.attach`. */
    fun attach(am: AssetManager) {
        assets = am
    }

    /**
     * The still for a car MODEL name (`vehicle-racer`, …), or null when the model
     * has no baked render.
     *
     * A miss is a STAGING mistake rather than a design — same rule as
     * [AssetStore] — so nothing here substitutes artwork for it; the caller draws
     * the empty box, which is a visible gap rather than a plausible wrong car.
     */
    fun bitmap(model: String): Bitmap? = cache.getOrPut(model) {
        val am = assets ?: return@getOrPut null
        try {
            am.open("toycar/thumbs/$model.png").use { BitmapFactory.decodeStream(it) }
        } catch (_: Throwable) {
            null
        }
    }
}

/** The still for the car in seat slot [modelIndex], or nothing if it is unbaked. */
@Composable
fun CarThumbImage(model: String, modifier: Modifier = Modifier) {
    val bmp = CarThumb.bitmap(model) ?: return
    Image(
        bitmap = bmp.asImageBitmap(),
        contentDescription = null,
        modifier = modifier,
        // A DOWNSCALE, so filtered: the baked frame is 256 wide and the seat box is
        // smaller, and point-sampling a downscale throws away most of the source.
        // Same reasoning as the join ticket's QR.
        filterQuality = FilterQuality.High,
        contentScale = ContentScale.Fit,
    )
}
