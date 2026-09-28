package games.couchpad.tinytrack

import android.content.res.AssetManager
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import org.json.JSONObject
import java.nio.ByteOrder

/**
 * The baked cue palette, decoded to float PCM once at boot.
 *
 * `public/display/audio/cues.js` synthesises these in WebAudio at runtime;
 * `scripts/bake-cues.mjs` renders that graph offline into WAVs plus a manifest,
 * and THIS shell plays the bake. It ports none of `cues.js` — a native shell has
 * no business re-implementing an oscillator graph. The Swift twin is
 * `shells/tvos/TinyTrackParty/Audio/CueBank.swift` and this is its port; read
 * that file's header for the reasoning, which is not repeated here.
 *
 * **The manifest is the contract, not documentation.** It carries each one-shot's
 * detune spread and each sustained voice's gain formula, level stops and glide
 * tau, and every one of those numbers is quoted out of `cues.js` by the baker
 * rather than transcribed. Reading them here instead of typing them into Kotlin
 * is the same rule `Tokens.kt` follows for colour.
 *
 * **`optDouble` DOES NOT COERCE, and that is why this file exists rather than a
 * few lines in [AudioDevice].** The previous reader took the detune as
 * `playback.optDouble("jitter")`, but `jitter` is an OBJECT — so `org.json`
 * returned the fallback for all sixteen cues and this shell never detuned
 * anything. It is the `optString`-reads-null trap's cousin: a shape mismatch that
 * neither reference shell can show you, because both read the object. Every read
 * below names the shape it expects.
 */
class CueBank(private val assets: AssetManager) {

    companion object {
        private const val TAG = "CueBank"

        /** Where `stage-assets.sh` puts the bake, verbatim from `public/assets/`. */
        private const val DIR = "audio/cues/"

        const val KIND_ONE_SHOT = 1
        const val KIND_STOPS = 2
        const val KIND_ENGINE = 3

        /**
         * The engine loop's LIVE DSP, the one cue whose numbers are not in the
         * manifest's machine-readable half.
         *
         * They are in its `playback.liveDsp` PROSE, because the filter cannot be
         * baked: `playbackRate` is the RPM here and shifts the filtered spectrum
         * with it, so a stop baked at one cutoff would be wrong at every rate but
         * one. Transcribed from that string, and [build] holds this copy to it: if
         * the baker retunes the engine, loading LOGS rather than this shell playing
         * last year's voicing silently.
         */
        const val ENG_RATE0 = 0.9; const val ENG_RATE_SPAN = 0.75; const val ENG_RATE_TAU = 0.12
        const val ENG_LP0 = 900.0; const val ENG_LP_SPAN = 5200.0
        const val ENG_LP_Q = 0.6; const val ENG_LP_TAU = 0.10
        const val ENG_GAIN0 = 0.007; const val ENG_GAIN_SPAN = 0.06; const val ENG_GAIN_TAU = 0.08

        /** What `liveDsp` must still say for the constants above to be true. */
        private val ENGINE_PROSE = listOf(
            "Q 0.6", "(900 + 5200*l)", "tau 0.10 s",
            "(0.9 + 0.75*l)", "tau 0.12 s",
            "(0.007 + 0.06*l)", "tau 0.08 s",
        )

        /**
         * `gain = a + b*l`, parsed from the manifest's formula STRING.
         *
         * A string because the baker quotes it out of `cues.js`, which keeps that
         * single source; parsing it here is what stops the four gains from being
         * retyped. Returns null for anything not linear in `l`, which the caller
         * reports rather than approximating.
         */
        fun linearFormula(text: String): DoubleArray? {
            var a = 0.0
            var b = 0.0
            for (term in text.split("+")) {
                val f = term.split("*").map { it.trim() }.filter { it.isNotEmpty() }
                when {
                    f.size == 1 && f[0] == "l" -> b += 1.0
                    f.size == 1 -> a += f[0].toDoubleOrNull() ?: return null
                    f.size == 2 && f[0] == "l" -> b += f[1].toDoubleOrNull() ?: return null
                    f.size == 2 && f[1] == "l" -> b += f[0].toDoubleOrNull() ?: return null
                    else -> return null
                }
            }
            return doubleArrayOf(a, b)
        }
    }

    /** One decoded sample: INTERLEAVED float PCM, with its own rate and width. */
    class Sample(val data: FloatArray, val frames: Int, val channels: Int, val rate: Double)

    /**
     * Everything the mixer needs to render one cue family, resolved once.
     *
     * Indexed by `TTP_CUE_*`, so the render loop does no lookup and no string
     * work — the same trick the renderer's own tables use.
     */
    class Cue(
        val kind: Int,
        val samples: Array<Sample>,
        /** Stops only, ASCENDING — the crossfade walks adjacent pairs. */
        val levels: DoubleArray,
        val gainA: Double,
        val gainB: Double,
        val tau: Double,
        val levelFloor: Double,
        /** One-shot only: the detune spread in SEMITONES. 0 = no detune. */
        val spread: Double,
    )

    /** `TTP_CUE_*` -> the cue, or null where nothing is staged. */
    @Volatile private var table: Array<Cue?> = arrayOfNulls(0)

    /** True once every staged cue is decoded and the mixer may read [cue]. */
    @Volatile var ready = false
        private set

    fun cue(code: Int): Cue? = table.getOrNull(code)

    /**
     * Decode the whole palette. SLOW — every stop is a 1 s 48 kHz WAV and the
     * engine loop needs a MediaCodec — so this runs on the caller's thread and the
     * caller is expected not to be the frame's. [AudioDevice.start] does it on the
     * cue thread.
     */
    fun load() {
        val root = try {
            JSONObject(assets.open(DIR + "manifest.json").use { it.readBytes() }
                .toString(Charsets.UTF_8))
        } catch (t: Throwable) {
            Log.w(TAG, "no cue manifest — nothing will sound", t)
            return
        }
        // Schema v2 is what this reader knows. A bump means the playback block
        // moved, and a reader that guessed would mis-tune every voice silently.
        val version = root.optInt("version", 2)
        if (version != 2) Log.e(TAG, "cue manifest is schema v$version, this shell reads v2")
        val cues = root.optJSONObject("cues") ?: run {
            Log.w(TAG, "manifest has no `cues` object")
            return
        }

        // DERIVED from the engine, walking the code space until it stops naming
        // families — the same move the item vocabulary makes. The bound guards a
        // corrupt artifact answering forever, not a claim about how many there are.
        var max = 0
        val ids = HashMap<Int, String>()
        var code = 1
        while (code < 64) {
            val id = TtpJson.str(Ttp.ttp_audio_cue_id(code)) ?: break
            ids[code] = id
            max = code
            code += 1
        }
        val built = arrayOfNulls<Cue>(max + 1)
        for ((c, id) in ids) {
            val entry = cues.optJSONObject(id)
            if (entry == null) { Log.w(TAG, "cue '$id' is not in the manifest"); continue }
            built[c] = try {
                build(id, entry)
            } catch (t: Throwable) {
                Log.w(TAG, "cue '$id' did not load", t); null
            }
        }
        table = built
        ready = true
    }

    private fun build(id: String, entry: JSONObject): Cue? {
        val playback = entry.optJSONObject("playback") ?: JSONObject()
        return when (entry.optString("kind")) {
            "one-shot" -> {
                // The countdown is the one cue with two files and the ORDER is load
                // bearing: TTP_AUD_F_GO picks index 1. Sorted by NAME rather than by
                // the manifest's array order, because which one is the GO beat is a
                // fact about the file.
                val files = ArrayList<String>()
                val arr = entry.optJSONArray("files")
                for (i in 0 until (arr?.length() ?: 0)) {
                    arr!!.optJSONObject(i)?.optString("file")?.takeIf { it.isNotEmpty() }
                        ?.let { files.add(it) }
                }
                val ordered = files.filter { !it.contains("_go") } + files.filter { it.contains("_go") }
                val samples = loadAll(ordered, id) ?: return null
                // `jitter: null` (rocket_hit) means no detune at all — it is the one
                // baked one-shot with a recorded source rather than a synth graph.
                // AN OBJECT, and reading it as a number is the bug this file's header
                // is about. `spread` is in SEMITONES.
                val spread = playback.optJSONObject("jitter")?.optDouble("spread", 0.0) ?: 0.0
                Cue(KIND_ONE_SHOT, samples, DoubleArray(0), 0.0, 0.0, 0.0, 0.0, spread)
            }

            "sustained" -> {
                val stops = sortedStops(entry)
                val samples = loadAll(stops.map { it.optString("file") }, id) ?: return null
                // All or nothing: a cue that loaded three of its five stops has a
                // crossfade that walks the wrong pair.
                if (samples.size != stops.size) {
                    Log.e(TAG, "cue '$id': ${samples.size} stops loaded of ${stops.size}")
                    return null
                }
                // The stops carry only the FILTER — `bakeHeadroom: 1` divided the
                // gain out of the PCM — so the device applies the formula.
                val formula = playback.optString("gainFormula")
                val linear = linearFormula(formula) ?: run {
                    Log.e(TAG, "cue '$id': gainFormula '$formula' is not linear in l")
                    return null
                }
                Cue(KIND_STOPS, samples,
                    DoubleArray(stops.size) { stops[it].optDouble("level", 0.0) },
                    linear[0], linear[1],
                    playback.optDouble("smoothTauSec", 0.05),
                    playback.optDouble("levelFloor", 0.02),
                    0.0)
            }

            "passthrough" -> {
                val prose = playback.optString("liveDsp")
                for (p in ENGINE_PROSE) {
                    if (!prose.contains(p)) {
                        Log.e(TAG, "cue '$id': liveDsp no longer says '$p' — the engine's "
                            + "constants in CueBank have gone stale against the bake")
                    }
                }
                val src = entry.optString("source")           // public/assets/audio/engine_loop.ogg
                val name = src.substringAfterLast('/').ifEmpty { "engine_loop.ogg" }
                val sample = decodeOgg("audio/$name") ?: return null
                // The engine is the one cue with no levelFloor of its own; it shares
                // the sustained voices' floor, which the decision layer already
                // applies before it sends a level.
                Cue(KIND_ENGINE, arrayOf(sample), DoubleArray(0),
                    ENG_GAIN0, ENG_GAIN_SPAN, ENG_GAIN_TAU, 0.02, 0.0)
            }

            else -> { Log.w(TAG, "cue '$id': unknown kind"); null }
        }
    }

    /** ASCENDING by level, because the crossfade walks adjacent pairs. */
    private fun sortedStops(entry: JSONObject): List<JSONObject> {
        val arr = entry.optJSONArray("stops") ?: return emptyList()
        val out = ArrayList<JSONObject>(arr.length())
        for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { out.add(it) }
        return out.sortedBy { it.optDouble("level", 0.0) }
    }

    private fun loadAll(files: List<String>, id: String): Array<Sample>? {
        val out = ArrayList<Sample>(files.size)
        for (f in files) {
            if (f.isEmpty()) continue
            val s = decodeWav(DIR + f)
            if (s == null) { Log.w(TAG, "cue '$id': $f is not staged or is not PCM"); return null }
            out.add(s)
        }
        return if (out.isEmpty()) null else out.toTypedArray()
    }

    // -- decoding ---------------------------------------------------------------

    /**
     * Canonical RIFF/WAVE, 16-bit PCM. The bake writes nothing else (every stop's
     * manifest record says `channels: 1, sampleRate: 48000`), so this walks the
     * chunk list rather than assuming offsets and refuses anything it does not
     * recognise instead of reading noise as audio.
     */
    private fun decodeWav(path: String): Sample? {
        val bytes = try {
            assets.open(path).use { it.readBytes() }
        } catch (_: Throwable) { return null }
        if (bytes.size < 44) return null
        val buf = java.nio.ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        if (buf.getInt(0) != 0x46464952 /* RIFF */ || buf.getInt(8) != 0x45564157 /* WAVE */) return null

        var channels = 0
        var rate = 0.0
        var bits = 0
        var pos = 12
        while (pos + 8 <= bytes.size) {
            val tag = buf.getInt(pos)
            val size = buf.getInt(pos + 4)
            val body = pos + 8
            if (size < 0 || body + size > bytes.size) break
            when (tag) {
                0x20746d66 /* "fmt " */ -> {
                    if (buf.getShort(body).toInt() != 1) return null   // PCM only
                    channels = buf.getShort(body + 2).toInt()
                    rate = buf.getInt(body + 4).toDouble()
                    bits = buf.getShort(body + 14).toInt()
                }
                0x61746164 /* "data" */ -> {
                    if (channels <= 0 || bits != 16) return null
                    val n = size / 2
                    val data = FloatArray(n)
                    var o = body
                    for (i in 0 until n) {
                        data[i] = buf.getShort(o) / 32768.0f
                        o += 2
                    }
                    return Sample(data, n / channels, channels, rate)
                }
            }
            pos = body + size + (size and 1)   // chunks are word-aligned
        }
        return null
    }

    /**
     * The engine loop, which ships as `.ogg` — the manifest says to ship it as-is,
     * so it is the one asset this shell cannot read with a header parse.
     *
     * `MediaCodec` synchronously, which is verbose and is still the least this
     * needs: `SoundPool` will play an ogg but never hands back PCM, and the mixer
     * has to own the samples to run a filter over them.
     */
    private fun decodeOgg(path: String): Sample? {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        try {
            assets.openFd(path).use { fd ->
                extractor.setDataSource(fd.fileDescriptor, fd.startOffset, fd.length)
            }
            var track = -1
            var format: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val f = extractor.getTrackFormat(i)
                if (f.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
                    track = i; format = f; break
                }
            }
            val fmt = format ?: return null
            extractor.selectTrack(track)
            val channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            val rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE).toDouble()

            codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
            codec.configure(fmt, null, null, 0)
            codec.start()

            val info = MediaCodec.BufferInfo()
            var out = FloatArray(1 shl 16)
            var n = 0
            var sawInputEnd = false
            var sawOutputEnd = false
            while (!sawOutputEnd) {
                if (!sawInputEnd) {
                    val inIndex = codec.dequeueInputBuffer(10_000)
                    if (inIndex >= 0) {
                        val inBuf = codec.getInputBuffer(inIndex)!!
                        val read = extractor.readSampleData(inBuf, 0)
                        if (read < 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0,
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            sawInputEnd = true
                        } else {
                            codec.queueInputBuffer(inIndex, 0, read, extractor.sampleTime, 0)
                            extractor.advance()
                        }
                    }
                }
                val outIndex = codec.dequeueOutputBuffer(info, 10_000)
                if (outIndex >= 0) {
                    val b = codec.getOutputBuffer(outIndex)!!.order(ByteOrder.LITTLE_ENDIAN)
                    b.position(info.offset)
                    val count = info.size / 2
                    if (n + count > out.size) out = out.copyOf(maxOf(out.size * 2, n + count))
                    for (i in 0 until count) out[n + i] = b.short / 32768.0f
                    n += count
                    codec.releaseOutputBuffer(outIndex, false)
                }
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEnd = true
            }
            if (n == 0) return null
            return Sample(out.copyOf(n), n / channels, channels, rate)
        } catch (t: Throwable) {
            Log.w(TAG, "$path did not decode", t)
            return null
        } finally {
            try { codec?.stop(); codec?.release() } catch (_: Throwable) { }
            extractor.release()
        }
    }
}
