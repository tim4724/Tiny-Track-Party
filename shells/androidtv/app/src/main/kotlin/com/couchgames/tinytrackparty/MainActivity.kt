package com.couchgames.tinytrackparty

import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.compose.runtime.CompositionLocalProvider
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

        // Deliberately NOT setZOrderMediaOverlay/OnTop: that would put the surface
        // ABOVE the window and the UI would vanish behind the race. Why a
        // SurfaceView and never a TextureView is DisplayHost's class header.
        val root = FrameLayout(this)
        val surfaceView = SurfaceView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        root.addView(surfaceView)

        game = GameCoordinator(this, surfaceView)
        // ON DURING DEVELOPMENT, exactly as the web's is: the frame budget is
        // something to keep under your eye, not something to remember to switch on.
        //
        // OFF UNDER A SCENARIO, because a screenshot gallery is a picture of the UI
        // and the readout is not part of it. The tvOS column shows what the other
        // choice costs: four lines of green diagnostic sit in the corner of every
        // race shot it has ever taken, and the one board where a viewer would most
        // want to compare the HUD is the one with a debug panel over it.
        if (BuildConfigIsDebug && !Scenarios.active) PerfMonitor.show()
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
                // and nothing else to invalidate a plain field read — and the
                // surfaceWidth read below cannot stand in, because the scaler's
                // setFixedSize pins the buffer, so a view resize need not change it.
                // Density and buffer would go stale together.
                //
                // ABOVE the density provider on purpose: LocalConfiguration is the
                // real 960 dp, and reading it BELOW is the one way this arrangement
                // goes quietly wrong.
                val cfg = LocalConfiguration.current
                val widthPx = remember(cfg) { resources.displayMetrics.widthPixels }
                TtpTheme(windowWidthPx = widthPx) {
                    CompositionLocalProvider(
                        LocalSurfaceWidth provides game.display.surfaceWidth
                    ) {
                        RootScreen(game)
                    }
                }
            }
        }
        root.addView(compose)
        setContentView(root)

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
            // The perf readout's "P" key. This box's remote has no INFO button, so
            // in practice the toggle is `adb shell input keyevent 165` — which is
            // what a developer measuring a build has to hand anyway, and it keeps
            // the panel off every button a player can actually press.
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
        game.audio.release()
    }
}
