package games.couchpad.tinytrack

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform

/**
 * `.track-map` — a circuit's centreline as a mini schematic, the mark the lobby's
 * race card and the phone's picker both wear.
 *
 * **The projection is C++'s.** `ttp_track_schematic_json` builds the track and
 * projects its centreline into a padded 256-unit square as ONE closed SVG path,
 * plus the start line's point on it. Nothing here samples geometry, chooses a
 * scale, or decides where the start dot goes — this file is the two strokes and
 * the dot, in the widths `theme.css` states.
 *
 * ## Why this exists at all
 *
 * The lobby's race card carried a TODO and a running number in place of the map.
 * A number where a picture belongs is not a smaller version of the card: the map
 * IS what tells a room which circuit is coming, and a "1" in a box tells them
 * nothing at all. The two exports needed have been there the whole time — the ABI
 * header even records that the first TV shell hand-copied a table "against a
 * comment claiming no export existed".
 *
 * ## The strokes are viewBox units
 *
 * `theme.css` gives the casing 23 and the road 14 against the schematic's own
 * `0 0 256 256` box, and the start dot r=13 with a 4-wide white ring. Those are
 * carried here as fractions of the box so a tile of any size draws the same
 * picture — a dp width would be a second, contradictory scale.
 */
/** `0 0 256 256` — the box `ttp_track_schematic_json` projects into. */
private const val VIEW = 256f

// `theme.css`'s `.track-map__casing` / `__road` / `__start`, in that box's units.
private const val CASING_W = 23f
private const val ROAD_W = 14f
private const val START_R = 13f
private const val START_RING_W = 4f

object TrackMap {

    /**
     * `laps`/`seed` only stamp the built track and no geometry depends on them;
     * 3/1 is the convention every other caller in this shell uses
     * (`GameCoordinator.chooserTracks`), and a schematic that disagreed with the
     * phone's would be two maps of one circuit.
     */
    private const val LAPS = 3
    private const val SEED = 1

    /** One parsed path per track id. The projection is deterministic, so this is
     *  a pure cache of work, not of state. */
    private val cache = HashMap<String, Shape?>()

    class Shape(val path: Path, val start: Offset?)

    fun shape(trackId: String): Shape? = cache.getOrPut(trackId) {
        val d = TtpJson.obj(Ttp.ttp_track_schematic_json(TtpJson.arg(trackId), LAPS, SEED))
        val pathD = d.optString("d").ifEmpty { return@getOrPut null }
        // androidx.core.graphics.PathParser, the same reader ItemIcon uses for the
        // shared item SVGs — the schematic's grammar is M/L/Z, which is a strict
        // subset of what it already handles, so a second parser would be a second
        // thing to get wrong.
        val parsed = try {
            androidx.core.graphics.PathParser.createPathFromPathData(pathD)
        } catch (_: Throwable) {
            null
        } ?: return@getOrPut null
        val startObj = d.optJSONObject("start")
        Shape(
            parsed.asComposePath(),
            // `start` is explicitly null for a track with no samples, and null is
            // NOT the origin: a dot at 0,0 would sit in the tile's corner looking
            // like a decoration nobody placed.
            startObj?.let { Offset(it.optDouble("x").toFloat(), it.optDouble("y").toFloat()) },
        )
    }
}

/** Draw one circuit into a square. The tile's wash behind it is [MapTile]'s. */
@Composable
fun TrackMapCanvas(trackId: String, modifier: Modifier = Modifier) {
    val shape = remember(trackId) { TrackMap.shape(trackId) } ?: return
    val casing = Color.White
    val road = Tokens.ink2
    val start = Tokens.danger
    Canvas(modifier) {
        val s = size.minDimension
        withTransform({ scale(s / VIEW, s / VIEW, pivot = Offset.Zero) }) {
            // CASING THEN ROAD, in that order and both from the same path: the white
            // under-stroke is what lifts the ribbon off a tinted field, and it is
            // drawn wider rather than as an outline because a stroked outline would
            // double back on itself at every self-crossing an overpass makes.
            drawPath(shape.path, casing,
                style = Stroke(CASING_W, cap = StrokeCap.Round, join = StrokeJoin.Round))
            drawPath(shape.path, road,
                style = Stroke(ROAD_W, cap = StrokeCap.Round, join = StrokeJoin.Round))
            shape.start?.let {
                drawCircle(casing, START_R + START_RING_W, it)
                drawCircle(start, START_R, it)
            }
        }
    }
}
