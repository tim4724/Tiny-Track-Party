package games.couchpad.tinytrack

import android.content.res.AssetFileDescriptor
import android.content.res.AssetManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Log
import org.json.JSONObject
import java.nio.ByteOrder

/**
 * The DEVICE half of the audio, and only that half.
 *
 * **Nothing here decides which cue, what gain or which song.** All of that is
 * `libttp-runtime/ttp/audio.cc`, replayed by a frozen corpus on every leg, and it
 * reaches this file as an ordered command stream: `ttp_audio_frame(now)` runs the
 * decisions and `ttp_audio_drain()` hands back the block. What is left is a
 * sample player.
 *
 * The cue table is **derived from the engine**, not mirrored: `ttp_audio_cue_id`
 * names the file behind each code, exactly as `ttp_item_id` names an item. A
 * shell that listed the 28 names would have a table nothing watches.
 *
 * ## The two halves
 *
 * [AudioMixer] carries every cue — the one-shots, the four sustained beds and the
 * engine loop — summed into one always-open stream through the web's own master
 * gain and limiter. [CueBank] decodes the bake it plays. This file is what is
 * left: the drain, the music bed, and turning a command into a mixer call.
 *
 * It used to be a `SoundPool`, which could only play the one-shots — see
 * [AudioMixer] for why everything moved into the mix.
 */
class AudioDevice(
    private val assets: AssetManager,
    /**
     * The origin, and the music's FALLBACK source rather than its usual one:
     * the catalogue ships in the APK now. See [openBundledSong].
     */
    private val baseUrl: String,
) {
    private companion object {
        const val TAG = "AudioDevice"

        // ttp_audio.h. The kinds this device acts on; the rest are consumed.
        const val AUD_CUE = 1
        const val AUD_COUNTDOWN = 2
        const val AUD_VOICE = 3
        const val AUD_VOICE_STOP = 4
        const val AUD_STOP_ALL = 5
        const val AUD_STOP_CAR = 6
        const val AUD_MUSIC = 7

        const val MUSIC_START = 1
        const val MUSIC_STOP = 2
        const val MUSIC_PAUSE = 3
        const val MUSIC_RESUME = 4

        const val F_GO = 1
        const val F_MOD = 2


        const val BLOCK_VERSION = 1
        const val HEADER_BYTES = 16
        const val CMD_BYTES = 48
    }

    /**
     * True once the palette is decoded and the mix stream is open.
     * `ttp_race_events_live_json` takes it, and the GO beat gates the music pick on
     * it — a device that cannot play yet picks no song rather than burning one from
     * the no-repeat shuffle unheard.
     */
    val ready: Boolean get() = bank.ready && mixer.ready

    /** The CC-BY credit for the playing song. A licensing obligation, not chrome. */
    var onSongChanged: ((String, String, String, String) -> Unit)? = null

    /**
     * The display's mute, which is ONE state whatever flipped it — the host
     * phone's Sound row here, plus the corner button on the web.
     *
     * TWO SILENCERS, the same pair `Audio.js` uses and for the same reason: the
     * mixer's master gain covers every cue, voice and bed it renders, and the
     * music is a separate [MediaPlayer] that never passes through it.
     */
    var muted: Boolean = false
        set(on) {
            field = on
            mixer.muted = on
            applyMusicVolume()
        }

    private val bank = CueBank(assets)
    private val mixer = AudioMixer(bank)


    private var music: MediaPlayer? = null
    /**
     * Whether [music] has reached Prepared. `pause()` and `start()` are documented
     * INVALID before it and throw IllegalStateException — which, from inside the
     * drain, would propagate out through frame() and take the render callback with
     * it. A pause in the first seconds of a race (or the auto-pause that freezes
     * the field at GO) is exactly when the stream is still preparing.
     */
    private var musicPrepared = false
    /** A pause that arrived before Prepared, applied when it lands. */
    private var musicWantsPause = false
    private var musicGain = 1f
    /** The song's own level, before the mute and the master gain. */
    private var musicBed = 1f
    /** What [music] is streaming, so a repeat rewinds instead of re-fetching. */
    private var musicUrl: String? = null

    /**
     * The music bed's level, which is the song's own times the master gain and
     * zero while muted. The bed does NOT pass through [AudioMixer] on this
     * platform (a [MediaPlayer] renders straight to the device), so its mute and
     * its gain are applied here rather than in the mix — same split as the tvOS
     * twin's `applyMusicVolume`.
     */
    private fun applyMusicVolume() {
        musicGain = if (muted) 0f else musicBed * AudioMixer.MASTER
        try {
            music?.setVolume(musicGain, musicGain)
        } catch (_: IllegalStateException) {
            // A player torn down or not yet prepared; the next start applies it.
        }
    }

    fun start() {
        mixer.start()
        // The palette is DECODED off the frame's thread, and that is not tidiness:
        // every sustained stop is a 1 s 48 kHz WAV and the engine loop needs a
        // MediaCodec, so [CueBank.load] is hundreds of milliseconds of work, and
        // the shell renders on the main-thread Choreographer ([DisplayHost] says
        // why). The thread retires after this one job. `bank.ready` flips inside
        // `load`, which is the only write, and the mixer reads it per block — a
        // benign race whose worst case is one silent block on the frame the
        // palette lands. The cold-play trap this design retires is in
        // shells/androidtv/CLAUDE.md.
        Thread({ bank.load() }, "ttp-cues").start()
    }

    /** The session whose events are heard. The lobby's attract race is never bound, so it is silent for free. */
    fun bind(session: Int) = Ttp.ttp_audio_bind(session)

    fun roster(count: Int, inLobby: Boolean) =
        Ttp.ttp_audio_roster(count, if (inLobby) 1 else 0)

    fun stopVoices() = Ttp.ttp_audio_stop_voices()

    /**
     * Kill the mix because the app is going away.
     *
     * `stopVoices` only QUEUES a STOP_ALL; the drain is what performs it, and the
     * drain rides the Choreographer callback that `surfaceDestroyed` has just
     * removed. So a backgrounded race left every engine, bed and squeal sounding at
     * whatever level it last held, forever — nothing was updating them any more,
     * which is the exact situation `ttp_audio.h` says `ttp_audio_stop_voices` exists
     * for. Draining here is what makes the call arrive.
     */
    fun silence() {
        stopVoices()
        drain()
    }

    fun stopCar(id: EngineId) = Ttp.ttp_audio_stop_car(TtpJson.arg(id.json))

    /** `start-music` / `stop-music`. Null biome stops. */
    fun music(biome: String?) {
        if (biome == null) Ttp.ttp_audio_music(MUSIC_STOP, null)
        else Ttp.ttp_audio_music(MUSIC_START, TtpJson.arg(biome))
    }

    fun setMusicPaused(paused: Boolean) =
        Ttp.ttp_audio_music(if (paused) MUSIC_PAUSE else MUSIC_RESUME, null)

    /**
     * One frame: run the decisions, then perform what they produced.
     *
     * The two halves are deliberately one call from the shell's point of view.
     * `ttp_audio_frame` reads the bound session and queues; `ttp_audio_drain`
     * hands the queue over. Draining without framing plays nothing; framing
     * without draining silently fills a queue.
     */
    fun frame(nowMs: Double) {
        Ttp.ttp_audio_frame(nowMs)
        drain()
    }

    private fun drain() {
        val buf = Ttp.ttp_audio_drain() ?: return
        buf.order(ByteOrder.nativeOrder())
        if (buf.capacity() < HEADER_BYTES) return
        val version = buf.getInt(0)
        val count = buf.getInt(4)
        val stride = buf.getInt(8)
        // `stride < CMD_BYTES`, not `!=`: the field exists so a reader can walk the
        // array without having compiled the struct, so a LARGER record is
        // forward-compatible and this reader simply skips the tail. A SHORTER one is
        // not — the offsets below run to o+40 — and would throw out of the drain and
        // take the render callback with it. Neither twin checks stride at all.
        if (version != BLOCK_VERSION || stride < CMD_BYTES) {
            if (!loggedBlock) {
                loggedBlock = true
                Log.w(TAG, "audio block v$version stride $stride — nothing will sound")
            }
            return
        }

        for (i in 0 until count) {
            val o = HEADER_BYTES + i * stride
            if (o + stride > buf.capacity()) break
            val kind = buf.getInt(o)
            val code = buf.getInt(o + 4)
            val subject = buf.getInt(o + 8)
            val flags = buf.getInt(o + 12)
            val level = buf.getDouble(o + 16)
            val rateMul = buf.getDouble(o + 24)
            val gainMul = buf.getDouble(o + 32)
            val lpMul = buf.getDouble(o + 40)

            when (kind) {
                AUD_CUE -> mixer.post(AudioMixer.CMD_ONE_SHOT, code, 0, 0, level, 1.0, 1.0, 1.0)

                // The countdown's two beats. The GO flag picks which, and the
                // DECISION that it is a beat at all was made in C++ — this only
                // chooses between two samples of the one cue family.
                //
                // AT FULL, never at `level`: the packer never sets it on this arm,
                // so it arrives 0 and multiplying by it would silence the count.
                // `code`, NOT a mirrored TTP_CUE_COUNTDOWN: the arm carries its own
                // cue code like every other, and one fewer constant spelled twice.
                AUD_COUNTDOWN -> mixer.post(AudioMixer.CMD_ONE_SHOT, code, 0,
                    if (flags and F_GO != 0) 1 else 0, 1.0, 1.0, 1.0, 1.0)

                // THE TIMBRE MULTIPLIERS ARE 1 UNLESS TTP_AUD_F_MOD SAYS OTHERWISE.
                // `ttp_audio.h` promises "a field an arm does not use is zero, never
                // stale", so an un-modded voice arrives with 0.0 in all three — and
                // passing those through would mute the engine and park its filter at
                // DC. The flag is what makes them meaningful.
                AUD_VOICE -> {
                    val mod = flags and F_MOD != 0
                    mixer.post(AudioMixer.CMD_VOICE, code, subject, 0, level,
                        if (mod) rateMul else 1.0,
                        if (mod) gainMul else 1.0,
                        if (mod) lpMul else 1.0)
                }

                AUD_VOICE_STOP ->
                    mixer.post(AudioMixer.CMD_VOICE_STOP, code, subject, 0, 0.0, 1.0, 1.0, 1.0)

                // STOP_ALL is scoped to VOICES (`ttp_audio.h`); the music bed has its
                // own MUSIC_STOP and is deliberately NOT silenced here.
                AUD_STOP_ALL ->
                    mixer.post(AudioMixer.CMD_STOP_ALL, 0, 0, 0, 0.0, 1.0, 1.0, 1.0)

                AUD_STOP_CAR ->
                    mixer.post(AudioMixer.CMD_STOP_CAR, 0, subject, 0, 0.0, 1.0, 1.0, 1.0)

                AUD_MUSIC -> when (code) {
                    // DEFERRED past the walk: startMusic reads ttp_audio_song_json,
                    // and no ABI call may happen while the drained block is still
                    // being read. Only the index and the bed are kept.
                    MUSIC_START -> { pendingSong = subject; pendingBed = level }
                    MUSIC_STOP -> { pendingSong = null; stopMusic() }
                    MUSIC_PAUSE ->
                        if (musicPrepared) music?.pause() else musicWantsPause = true
                    MUSIC_RESUME -> {
                        musicWantsPause = false
                        if (musicPrepared && music?.isPlaying == false) music?.start()
                    }
                }
            }
        }
        // The block is finished with; ABI calls are safe again.
        pendingSong?.let { pendingSong = null; startMusic(it, pendingBed) }
    }

    private var loggedBlock = false
    private var pendingSong: Int? = null
    private var pendingBed = 1.0

    private fun startMusic(index: Int, bed: Double) {
        val song = TtpJson.obj(Ttp.ttp_audio_song_json(index))
        val file = song.optString("file")
        if (file.isEmpty()) return

        // `* MASTER`: `Audio.js:249` sets the element's volume to
        // `level * this._volume()`, the same 0.6 the mix bus carries.
        musicBed = bed.toFloat().coerceIn(0f, 1f)
        applyMusicVolume()

        // THE SAME SONG REWINDS; it does not re-stream. The no-repeat shuffle only
        // avoids the LAST song (`audio.cc`), so a four-race cup on a four-song pool
        // repeats routinely — and tearing the player down for that pays a fresh
        // `prepareAsync` over the network and a silent gap in front of the grid.
        // Both twins keep theirs: the web swaps `src` only on a real change and
        // seeks to zero, tvOS seeks the same way.
        val live = music
        if (live != null && musicPrepared && musicUrl == file) {
            try {
                live.setVolume(musicGain, musicGain)
                live.seekTo(0)
                musicWantsPause = false
                if (!live.isPlaying) live.start()
                announce(song)
                return
            } catch (t: Throwable) {
                Log.w(TAG, "music could not rewind; restarting it", t)
            }
        }
        stopMusic()
        musicUrl = file
        try {
            // PLAYED FROM THE APK, and streamed from the origin only if it is not
            // there. stage-assets.sh bundles the catalogue; the fallback is what
            // makes a build that staged none of it still play, and what covers an
            // aapt2 that decided to deflate the file after all.
            val mp = MediaPlayer()
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            // `baseUrl + file`, NOT an `/assets/` of our own: `audio.cc`'s SONG macro
            // bakes the path in ORIGIN-ABSOLUTE ("/assets/audio/music/" + name), so
            // adding a second one asks for `/assets//assets/audio/music/...`, which
            // `server/index.js` normalises to a directory that does not exist and
            // answers 404. Every song on this shell had 404'd since the port: the
            // error listener swallows it and `onSongChanged` still fires, so the
            // CC-BY credit advertised a track that was never playing. Both twins
            // RESOLVE rather than concatenate — `assetUrl(song.file)` on the web,
            // `URL(string:relativeTo:)` on tvOS.
            //
            // The SAME leading "/assets/" is why the local lookup strips it: the
            // AssetManager's root already IS that directory, so it wants the
            // remainder ("audio/music/x.mp3") and nothing else.
            val local = openBundledSong(file)
            if (local != null) {
                local.use { mp.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
            } else {
                mp.setDataSource(baseUrl + file)
            }
            // WHICH SOURCE WON, once per song. The fallback above degrades in
            // silence by design — that is what makes it safe — so without this
            // line an APK that bundles 62 MB of music and streams anyway looks
            // exactly like one that works.
            Log.i(TAG, "music $file from ${if (local != null) "the APK" else "the origin"}")
            mp.isLooping = true
            mp.setVolume(musicGain, musicGain)
            mp.setOnPreparedListener {
                musicPrepared = true
                if (musicWantsPause) musicWantsPause = false else it.start()
            }
            mp.setOnErrorListener { _, what, extra ->
                Log.w(TAG, "music $file failed ($what/$extra)"); true
            }
            mp.prepareAsync()
            music = mp
        } catch (t: Throwable) {
            Log.w(TAG, "music $file could not start", t)
        }
        announce(song)
    }

    /**
     * The bundled copy of a song, or null when this build did not stage one.
     *
     * `file` arrives ORIGIN-ABSOLUTE from `audio.cc` ("/assets/audio/music/x.mp3")
     * and the AssetManager is rooted at that same `assets/`, so the prefix comes
     * off. An `openFd` rather than an `open`: `MediaPlayer` wants to seek, and a
     * deflated asset has no offset to give it — which is the one way this returns
     * null for a file that is genuinely present, and why the caller falls back to
     * the origin instead of treating null as "no music".
     */
    private fun openBundledSong(file: String): AssetFileDescriptor? {
        val path = file.removePrefix("/assets/")
        if (path == file) return null
        return try {
            assets.openFd(path)
        } catch (t: Throwable) {
            Log.w(TAG, "music $file is not readable from the APK; streaming it", t)
            null
        }
    }

    /** The CC-BY credit. A licensing obligation, so it rides every start path. */
    private fun announce(song: org.json.JSONObject) {
        onSongChanged?.invoke(
            song.optString("title"), song.optString("artist"),
            song.optString("license"), song.optString("source"),
        )
    }

    private fun stopMusic() {
        musicPrepared = false
        musicUrl = null
        musicWantsPause = false
        music?.let { try { it.stop() } catch (_: Throwable) { }; it.release() }
        music = null
    }

    fun release() {
        stopMusic()
        // The mixer owns its own thread and stream; joining it is [AudioMixer.release].
        mixer.release()
    }
}
