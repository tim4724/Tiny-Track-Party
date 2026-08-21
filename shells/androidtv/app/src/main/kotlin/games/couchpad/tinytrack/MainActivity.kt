package games.couchpad.tinytrack

import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.activity.OnBackPressedCallback
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.ComposeView

/**
 * The app. One Activity, one surface, one engine.
 *
 * `singleTask` and a wide `configChanges` set in the manifest are both deliberate:
 * an Android TV box changes HDMI mode, UI mode and density under a running app,
 * and letting the framework recreate the Activity for any of those would tear down
 * the Filament engine and rebuild every scene mid-race. What genuinely changes is
 * the surface, and [DisplayHost] already handles that through `surfaceChanged`.
 *
 * ComponentActivity, not Activity. Two things need it and neither is optional: a
 * ComposeView resolves its recomposer through ViewTreeLifecycleOwner, which a
 * plain Activity does not install (the failure is an IllegalStateException at the
 * first setContent), and back navigation goes through OnBackPressedDispatcher,
 * which is where `ttp_ui_back_effect`'s answer gets performed.
 */
class MainActivity : ComponentActivity() {

    private companion object {
        const val TAG = "TinyTrackParty"
    }

    private lateinit var game: GameCoordinator

    override fun onCreate(savedInstanceState: Bundle?) {
        // BEFORE super.onCreate, which is the library's one hard requirement: it
        // swaps the launch theme (Theme.TinyTrackParty.Splash) for
        // `postSplashScreenTheme`, and after super the window has already been
        // created with the wrong one. THAT HANDOVER IS ALL THIS CALL IS FOR here.
        //
        // NO setKeepOnScreenCondition, and that is a measured platform fact
        // rather than a preference: ANDROID TV CREATES NO STARTING WINDOW. API
        // 31+ gives a phone a system splash for every cold start whether the app
        // asks or not, and holding it until the game was ready is what this shell
        // used to do — but on a TV build `dumpsys window` lists no splash window
        // for this app, and none for Settings either. So the hold held nothing.
        // What it DID do was block this Activity's first draw, which is how a
        // viewer got the launcher until the app's first frame and then a black
        // SurfaceView hole (the surface punches through windowBackground) until
        // the lobby painted. The cover is a board this app draws — RootScreen's,
        // from `ttp_ui_cover`, the same answer the other two shells perform.
        installSplashScreen()
        super.onCreate(savedInstanceState)

        // BEFORE anything reads it, and it only ever STORES the request: the screens
        // a scenario stands up need the catalogue, the materials and a surface, none
        // of which exist until the SurfaceView's first `surfaceChanged`. The applying
        // half hangs off the end of `GameCoordinator.boot()`.
        //
        // An intent extra rather than tvOS's launch argument because that is this
        // platform's spelling of the same thing, and it needs no test runner:
        //   adb shell am start -n <activity> --es ttpScenario racing
        Scenarios.read(intent)

        // Registers every native through JNI_OnLoad. A signature that does not
        // match the generated Kotlin fails HERE, named, rather than as an
        // UnsatisfiedLinkError at whatever moment of a party first reaches it.
        Ttp.load()
        Log.i(TAG, "engine ${TtpJson.strOrEmpty(Ttp.ttp_version())}")

        // BEFORE the first composition, and that ordering is the whole reason this
        // is here rather than in boot(): a board that asks for `--ink-2` while the
        // table is still empty trips the missing-token assertion and takes the app
        // down on launch.
        Tokens.load(assets)
        Fonts.load(assets)

        // A race is minutes of no input at all from the TV's point of view — every
        // button is on a phone — so without this the box dims and then sleeps
        // mid-race.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // NO INPUT WHILE THE COVER IS UP, cleared the moment it lifts (the
        // LaunchedEffect below). This is not about the remote, it is about the
        // ANR: the boot is one unbroken main-thread stretch by design (rule 1,
        // one thread) and on a cold box it is SECONDS, and a window that is
        // focusable gets a FocusEvent it must consume within 5 s or the system
        // kills the activity. It used to get away with it by being invisible for
        // the whole boot — which is exactly the black this cover exists to
        // replace. While the cover is up there is nothing to respond to, so the
        // honest thing is to not accept input rather than to accept it and hang.
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)

        // Deliberately NOT setZOrderMediaOverlay/OnTop: that would put the surface
        // ABOVE the window and the UI would vanish behind the race. Why a
        // SurfaceView and never a TextureView is DisplayHost's class header.
        val root = FrameLayout(this)
        val surfaceView = SurfaceView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }

        game = GameCoordinator(this, surfaceView)
        // NOTHING SWITCHES THE PERF READOUT ON HERE, on purpose: it is off until a
        // developer asks for it, by property or by key. `PerfOverlay.kt` carries
        // the argument, and this line used to be `if (!Scenarios.active)
        // PerfMonitor.show()` — a panel every screenshot run had to suppress and
        // every player got anyway.
        Tokens.assertLiveriesMatchEngine()
        // BOOT WHEN THERE IS A DISPLAY TO BOOT AGAINST, and re-provision on every
        // later surface: destroying one takes the renderer and its asset map with
        // it. See DisplayHost.onSurfaceReady.
        game.display.onSurfaceReady = { game.displayReady() }

        val compose = ComposeView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setContent {
                // Keyed on the CONFIGURATION so an HDMI mode change re-reads it.
                // The manifest declares screenSize|density|uiMode in configChanges
                // (so the engine survives one), which means no Activity recreation
                // and nothing else to invalidate a plain field read. Nothing
                // below reads the surface any more — the cell rects cross the
                // ABI as fractions and are scaled by the AUTHORED canvas, so the
                // buffer size never enters this tree.
                //
                // ABOVE the density provider on purpose: LocalConfiguration is the
                // real 960 dp, and reading it BELOW is the one way this arrangement
                // goes quietly wrong.
                val cfg = LocalConfiguration.current
                val widthPx = remember(cfg) { resources.displayMetrics.widthPixels }
                TtpTheme(windowWidthPx = widthPx) {
                    // NO SURFACE WIDTH PROVIDED. It used to be, off a plain field
                    // through a staticCompositionLocalOf — which Compose cannot
                    // see change, so a scale move left the HUD dividing fresh
                    // rects by a stale width. The rects are authored units now,
                    // converted where they are read.
                    RootScreen(game)
                }
                // The other half of the not-focusable flag above: the app takes
                // input again the moment the cover is gone, which is also the
                // moment its main thread is free to answer.
                LaunchedEffect(game.state.cover) {
                    if (game.state.cover != "boot") {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
                    }
                }
            }
        }
        root.addView(compose)
        setContentView(root)

        // THE SURFACE JOINS ONE FRAME LATER, AND THAT IS THE WHOLE COVER.
        //
        // Attaching it here would put the entire boot inside the FIRST traversal:
        // `surfaceChanged` creates the engine and runs `displayReady` inline, and
        // on a cold TV that is one ~10 s frame (HWUI says so — "Skipped 572
        // frames", one `Davey! duration=9721ms`) BEFORE Compose has drawn a single
        // pixel. Meanwhile the Filament surface exists from halfway through it, so
        // the window manager shows the app the moment that layer has a buffer —
        // and an unrendered buffer is BLACK. The boot cover was composed and
        // never got a frame to be drawn in; it appeared for the last half second,
        // after the thing it exists to hide.
        //
        // Added at index 0, so it stays UNDER the ComposeView (`addView(compose)`
        // above put that on top and the race depends on it). One posted turn is
        // all it takes: the traversal that runs first has only Compose in it, so
        // the cover reaches the glass in milliseconds and is still the window's
        // content — opaque, over the surface's layer — for the whole of the boot
        // that follows.
        root.post { root.addView(surfaceView, 0) }

        // BACK. The TABLE crossed the ABI (`ttp_ui_back_effect`), the WALK did not
        // — popstate, the tvOS Menu button and Android's back stack are three
        // different animals, and the traversal is the shell's.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when (TtpJson.strOrEmpty(Ttp.ttp_ui_back_effect(
                    TtpJson.arg(game.state.screen.name.lowercase())))) {
                    // The lobby is this shell's root: the model declines, and the
                    // press belongs to the system (leave the app).
                    "swallow", "end-party" -> {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                    else -> game.returnToLobby()   // "return-to-lobby"
                }
            }
        })
    }

    /**
     * The remote's play/pause is this platform's pause button (`#pause-btn` on the
     * web, which has no TV analogue — there is no corner of the screen a viewer can
     * click). Both directions are gated by the model.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY,
            KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                if (game.state.paused) game.resumeRace() else game.pauseRace()
                true
            }
            // The perf readout's "P" key, and the other half of `setprop
            // debug.ttp.perf 1`. This box's remote has no INFO button, so in
            // practice the toggle is `adb shell input keyevent 165` — which is what
            // a developer measuring a build has to hand anyway, and it keeps the
            // panel off every button a player can actually press.
            KeyEvent.KEYCODE_INFO -> { PerfMonitor.toggle(); true }
            else -> super.onKeyDown(keyCode, event)
        }
    }

    /**
     * The app left the screen, and on this platform that IS the party ending.
     *
     * ONSTOP, NOT ONDESTROY. Android may kill a stopped process without ever
     * calling onDestroy, so a destroy hook alone would miss the ordinary case (the
     * viewer presses Home). See [PartyNet.shutdown] for why this must be wired.
     */
    override fun onStop() {
        super.onStop()
        game.suspend()
    }

    override fun onStart() {
        super.onStart()
        game.resume()
    }

    override fun onDestroy() {
        super.onDestroy()
        game.release()
    }
}
