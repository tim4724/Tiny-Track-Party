# shells/androidtv/ — the Android TV app

The third shell. `docs/native-port/shells.md` is the audited ledger of what any
shell owes; this file holds only what is **decided here and true nowhere else**,
plus the traps this platform has already sprung.

The tvOS app in `shells/tvos/` is the reference implementation for every screen
and every performer. Read it before writing the Kotlin twin of anything — it has
solved each problem once, with the reason written next to the solution. Where the
two shells differ, that difference is in this file.

## The three rules that outrank local detail

**1. One thread.** Every `ttp_*` call happens on the main thread. The display ABI
is a documented singleton whose returns point into per-call scratch, so a second
thread reading the HUD while the first draws is a data race with no diagnostic
and no crash. tvOS gets this free by being `@MainActor` throughout; here it is a
rule, and the way it is kept is that nothing outside `DisplayHost` calls a
`ttp_display_*` or `ttp_update`. A render thread is a later MEASURED decision,
not a starting assumption.

It is also why `Fastlane.kt` is not a transcription of HexStacker's Android
fastlane: that one runs its whole peer/netcode state on a serial executor, which
it can because its netcode is Kotlin. Ours is `ttp::fastlane::Link`, so every
`ttp_link_*` call, every peer and every watchdog is on MAIN and libwebrtc's
observers hop before they touch anything. The ONE thing that must not be on main
is `PeerConnectionFactory` creation (it loads a ~100-300 ms native library during
boot), so it runs on a one-shot thread and a signal that lands meanwhile is
QUEUED — not dropped, because the phone re-offers only when a channel it already
had closes, so an unanswered offer strands that seat on the relay for the whole
session.

**2. The bridge is generated. Do not hand-edit either half.**
`scripts/gen-jni.mjs` reads the `TTP_ABI` declarations out of the ABI headers and
emits `native/runtime/ttp_jni.cc` and `Ttp.kt` from one parse, so the two cannot
disagree about a signature. `tests/jni-generated.test.js` holds the committed
files to it. Adding an export means regenerating, never typing. The
non-mechanical exports are named in the generator's `OVERRIDES` with the reason
each is there; a new one belongs beside them.

**3. Strings cross as `ByteArray`.** Never `jstring`. `NewStringUTF` and
`GetStringUTFChars` speak *modified* UTF-8, in which a non-BMP character is a
surrogate pair of three-byte sequences and U+0000 is two bytes. The controller's
name field is free text off a phone and reaches every JSON-taking export in the
ABI.

## The device this was built against

A **Google TV Streamer**, Android 14 / API 34, and two of its properties are not
incidental:

- **32-bit userspace.** `ro.product.cpu.abilist` is `armeabi-v7a,armeabi` and
  there is no `/system/bin/linker64`. armeabi-v7a is therefore not a legacy
  fallback on this platform, it is the primary ABI, and an arm64-only APK does
  not run at all — a valid ELF whose interpreter does not exist, which `execve`
  reports as "No such file or directory". Build both.
- **PowerVR Rogue GE9215**, a low-end part driving a 4K-capable output. The
  adaptive render scale (`ttp_display_scale_poll`) is not a nicety here; it is
  why the thing holds 60 fps.

`native/scripts/android-device-spawn.sh` runs the whole ctest suite on a box over
adb, which is how the NDK leg stopped being compile-only.

A driver fact that makes a tree-wide assumption false HERE, read off the
device's own extension string (`dumpsys SurfaceFlinger | grep GLES`):

- **`GL_EXT_texture_filter_anisotropic` is ABSENT.** Filament clamps
  `gets.max_anisotropy` to 1 when it is, so every `setAnisotropy(...)` in the
  tree — the rubber layer's and the ground textures' — is a NO-OP on this box.
  The comments defending those settings were measured on an M1 under
  ANGLE-Metal; they do not describe this device, and reasoning about aniso cost
  or aniso quality here is reasoning about nothing.

## Traps already sprung

**ANDROID TV CREATES NO STARTING WINDOW, so there is no system splash to hold.**
On a phone, API 31+ shows one for every cold start whether the app asks or not,
and `installSplashScreen().setKeepOnScreenCondition` keeps it until the app says
it is ready. On a TV build `dumpsys window` lists no splash window for this app —
and none for Settings either, which is how you tell it is the platform and not
us. The hold therefore held nothing, and it was not harmless: it blocks the
Activity's first draw, so the launcher stayed up until the app's own first frame
and then the black SurfaceView hole stood in for the splash. The boot cover is a
board this app DRAWS ([RootScreen]), from the same `ttp_ui_cover` answer the web
and tvOS perform, over the same `launch-tv.png` bake tvOS uses. `installSplashScreen()`
stays for one job only: swapping the launch theme for `postSplashScreenTheme`.

**A FLAT PNG IN `android:icon` IS A *LEGACY* ICON, AND THE PLATFORM DRAWS IT ON
A WHITE PLATE.** From API 26 the launcher masks icons to a shape of its own, and
it cannot tell subject from background in a bitmap — so rather than cut into one
it shrinks the WHOLE FILE and centres it on a system-drawn plate. This shell
shipped the square brand bake that way for months and the result was two nested
backgrounds, the theme's warm paper inside a white squircle, with the car at
about half the icon's width. Nothing reports it: the build is clean, the resource
resolves, and the TV HOME ROW shows the banner rather than the icon, so it is
only wrong in Settings, the Apps row, notifications and the share sheet. The fix
is `res/mipmap-anydpi-v26/ic_launcher.xml` — an `<adaptive-icon>` naming two
staged layers — and it is not only plumbing: the platform draws only part of the
canvas and guarantees less, so the layers are their own composition and not the
square icon cut in two (`scripts/bake-wordmark.mjs` owns that geometry).
`mipmap-nodpi/ic_launcher.png` is the pre-26 fallback, which minSdk keeps live.

**The surface joins the view tree ONE FRAME LATE, and the cover is why.** Attach
it in the first traversal and the whole boot happens inside that traversal —
`surfaceChanged` creates the engine and runs `displayReady` inline, one ~10 s
frame on a cold box (HWUI: "Skipped 572 frames", `Davey! duration=9721ms`) before
Compose has drawn a pixel. The Filament surface exists from the middle of it, and
the window manager shows the app as soon as that layer has a buffer: an
unrendered buffer is BLACK. `root.post { root.addView(surfaceView, 0) }` gives
Compose a traversal of its own first, so the cover is on the glass in
milliseconds and stays there — opaque, in the window layer, over the surface —
for the whole boot. Index 0 keeps it under the ComposeView.

**A visible window that blocks its main thread for 5 s is a killed activity.**
The boot is one unbroken main-thread stretch by design (rule 1), and it used to
get away with it by being invisible for the whole of it. Once the cover is up
early the window is real, and the system dispatches it a FocusEvent that must be
consumed within 5 s — otherwise `ANR in games.couchpad.tinytrack ... Waited
5003ms for FocusEvent(hasFocus=true)` and `Force finishing activity`. So the
window carries `FLAG_NOT_FOCUSABLE` while the cover is up and drops it the moment
the cover lifts: while the cover is up there is nothing to respond to, and every
button in this game is on a phone anyway.

**`matc`'s default optimizer emits GLSL this GPU rejects.** It round-trips
through SPIR-V and produces loops carrying a temporary through the increment
expression (`for (int i=0; i<n; t0=t1,i++)`) where the temporary is assigned only
inside the body. Desktop GL and Metal accept it; the PowerVR driver reports "used
without being initialised" and then fails the compile, so `TtpVroad` — the one
material with dynamic loops, over its 32 deck decals — never links and Filament's
GL thread throws `PostconditionPanic` and aborts the process. `build-materials.sh`
passes `-Os`, globally and for every platform, because a browser on this same box
drives the same driver.

**THE WEBRTC AAR SHIPS NO CONSUMER R8 RULES**, and `libjingle_peerconnection_so`
`FindClass()`es `org.webrtc` and `org.jni_zero` from its own `JNI_OnLoad` —
references the shrinker cannot see. Without the keeps in `proguard-rules.pro` the
release APK aborts at library load, which is the same failure shape as the
generated bridge's keep and equally invisible until a release build runs on a
box. The dependency also carries four ABIs of `.so`; `abiFilters` keeps the two
this platform needs, and `armeabi-v7a` is not the droppable one here.

**Filament installs every Android ABI under one root**, so `lib/*/*.a` would put
two architectures on one link line. `FilamentSdk.cmake` prefers `lib/${ANDROID_ABI}`
and fails on a repeated archive basename, which catches the tvOS xcframework-root
version of the same mistake too.

**A destroyed surface takes the asset map with it.** `ttp_display_destroy` deletes
the `TtpRenderer`, which owns every provided asset, so a box that went to the home
screen and came back has no materials and no scene — and nothing on the roster path
rebuilds one, because the attract demo's signature check sees an unchanged picture
and returns early. The lobby looks perfect (its paper is Compose) over a dead
surface, and then START refuses with `scene`. `onSurfaceReady` fires on EVERY
create for exactly this.

The map also OUTLIVES a `releaseScene`, which is why a build re-provisions only
what changed. **Which assets those are is the ENGINE's answer**
(`ttp_display_asset_plan`), not this shell's: `SceneStaging` states what it would
hand over, tagged by the kit model each one's bytes come from, and gets back the
subset still missing. It kept a `provided` memo of its own for a while — a mirror
of the asset map, with an invalidation hook on `SceneStaging.materials` because
that is the beat a destroyed surface takes the map away on. The mirror is gone
and so is the hook; nothing here mirrors the asset map any more, and nothing
should.

**`optString` READS AN EXPLICIT JSON NULL AS THE STRING `"null"`.** Android's
`org.json` is not json.org's: `optString` delegates to `JSON.toString`, which
reaches `String.valueOf(JSONObject.NULL)` with no NULL guard, and the fallback
argument only covers an ABSENT key. `.ifEmpty { null }` never fires, because
`"null"` is not empty. Swift's `as? String` gives nil and JS gives null, so
**neither reference shell can show you this** — a transcription that is faithful
line for line is still wrong, and wrong silently. It shipped three times here:
every item box in every race rolled an item named `"null"`, the join QR carried
`#null` as a shard pin, and the tour's undrawn chips asked for a track named
`"null"`. Read every nullable key with `TtpJson.optStr`;
`tests/androidtv-nullable-json.test.js` derives the nullable keys from the C++
writers and fails on any other spelling.

**`kotlin.assert` IS A NO-OP ON ANDROID.** It compiles to
`if (kotlin._Assertions.ENABLED)`, which is `desiredAssertionStatus()`, which ART
answers `false` for in every build — debug included, because Android has no
`-ea`. Every check in `Tokens.kt` was dead code, including the one that exists to
catch the liveries drifting from the engine's `CAR_COLORS`. Use `tokenRequire`:
it logs always and throws in debug.

**AGP 8 GENERATES NO `BuildConfig` UNLESS ASKED**, and that was the second way
this shell's assertions lost their teeth. `BuildConfigIsDebug` reflects onto the
class; with `buildFeatures { buildConfig = true }` missing it answered false in a
debug build, so `tokenRequire` — written specifically to fix the `kotlin.assert`
trap above — threw nowhere either. Two mechanisms, one symptom, and neither has
any output to notice it by.

**A CHOREOGRAPHER CALLBACK IS NOT A PRESENT, and counting them reads 60 fps on
a box showing 15.** Filament's `beginFrame` declines when the buffer queue is
still full — the GPU is behind — and `ttp_display_frame` answers 0 for exactly
that skip; the callback still arrives on the NEXT VSYNC either way, because
Choreographer ticks on the display and not on our swap. Neither sibling shell is
exposed to this (rAF is throttled by presentation, and so is a display link), so
this is Android's alone, and it is not a small inaccuracy: the adaptive render
scale's fallback signal is LATE PRESENTS, and fed vsync ticks it saw a perfect
cadence and **never rescued anything** — the box sat at 11 fps with the
mechanism reporting it was fine. So the SCALE's window samples only frames
`ttp_display_frame` says were drawn. The readout is the other way round and must
stay that way: it takes EVERY tick's cadence plus the `presented` flag
(`ttp_perf.h`) and separates `hz` from `fps` itself. Filtering its input instead
is the same mistake wearing the other hat — fed presents, its `frame` series and
its drop count described the presents (60 samples at a p50 of 33 ms where the web
logged 120 at 16.7), so the two shells' columns of the bench table stopped being
the same measurement.

**`SoundPool.play` IS A DEVICE CALL, AND A COLD ONE BLOCKS FOR 34-52 ms.** It is
not a queue write: when the channel a play lands on does not already hold an
AudioTrack for that sample at that rate, it builds one, and here that is a round
trip through AudioFlinger and the HDMI output. A repeat of the same sample moments
later costs 1-3 ms, which is what makes it so easy to miss — it is fast in every
situation you would think to test. The audio drain runs inside the render
callback, so this was a **dropped frame every time a car took an item box**, which
is exactly how it was reported ("a small stutter, something is not hot"). One-shot
cues now play through `AudioMixer`'s always-warm stream, and the palette decode
runs on a short-lived named thread in `AudioDevice.start()`. Note what did NOT fix
it: pinning the playback rate to 1.0 warms most plays (37 ms median to 6) and
still leaves a 38 ms tail, and it costs the detune the bake deliberately left to
the player.

**COMPOSE IS ON THE FRAME'S THREAD, AND ON THIS CPU IT IS NOT CHEAP.** A HUD
recomposition that reaches measure/layout costs 10-30 ms here — a whole frame or
two — so the Compose rules that are merely tidy on a phone are load-bearing on
this box. Three that each cost real frames:

- **`rememberInfiniteTransition` never stops.** It runs from first composition
  until the composable leaves, whether or not anything reads it, and Compose
  broadcasts a frame to every awaiter on every vsync. One idle wobble on the item
  slot was ~1.1 ms of main thread on 100 % of frames.
- **An animated value read in the composition body recomposes the whole
  composable.** Read it inside `graphicsLayer { }` (or any deferred lambda)
  instead and only the layer re-runs. The item slot's roll animation recomposed
  the slot on every vsync of every pickup.
- **`clear()` + `addAll()` on a `mutableStateListOf` is a structural change**, so
  it invalidates every reader even when nothing differs. `paintHUD` did that at
  6 Hz and recomposed the entire race chrome six times a second for nothing; it
  now writes only the entries that moved.

**A `DrawScope` is in PHYSICAL pixels.** The density override buys the Compose
LAYOUT tree its `1.dp == 1 authored px` and buys a Canvas body nothing, so an
absolute length inside `Canvas { }` needs `* 1.dp.toPx()`. It is exact on a
1080p panel, where density is 1.0 — which is why bare literals survive review and
then draw at half size on the 4K output this box actually drives.

**Read the header (`ttp_ui.h`, `ttp_abi.h`), not a sibling shell's transcription
of it.** The results view answers `raceRows`, and a shell that decoded
`podiumRows` instead got an EMPTY LIST rather than an error — its board was a
whole phase short and nothing anywhere said so (the tvOS Swift shipped exactly
that). `TTP.swift`'s polarity comment was stale the same way, and cost a device
run — int returns are ONE polarity, truth is non-zero (`ttp_abi.h`). Two shells
agreeing is not evidence — the header is.

## Units: the density override

tvOS is always 1920x1080 **points**, so a design token's px value transfers with
no conversion and Swift writes `152` literally. Android is not: a 1080p TV is
1920x1080 px at density 2.0, so Compose sees **960x540 dp** and `152.dp` would
draw at double size.

So the root overrides `LocalDensity` with `density = windowWidthPx / 1920f` and
`fontScale = 1f`. Below that provider **one `dp` is one authored pixel**, every
number in `theme.css` and in the tvOS Swift transfers unchanged, and there is no
per-call-site conversion to forget. `fontScale` is pinned because a HUD anchored
to engine-supplied rects must not reflow under a system font-size setting.

Two consequences:

- **Nothing inside the override may read `LocalConfiguration.screenWidthDp`.** It
  still returns the real 960, not the virtual 1920, and mixing the two is the one
  way this arrangement goes quietly wrong.
- **Engine rects scale by the AUTHORED canvas, and by nothing else.**
  `ttp_display_cell_rects` answers FRACTIONS of the surface, so `toAuthored()`
  multiplies by 1920x1080 and takes no argument. It used to answer physical
  pixels and need the buffer width alongside — and that width reached Compose as
  a plain field through a `staticCompositionLocalOf`, which Compose cannot see
  change, so a scale move left fresh rects divided by a stale width and parked
  the whole layout at a fraction of its size in a corner. **Never reintroduce a
  second value here**: if a rect needs the surface size to mean something, the
  bug is one recomposition away.

## The HUD

Everything `ttp_display.h` and `RaceHUDView.swift` say, and they say the same
thing:

- Every element is placed from `ttp_display_cell_rects` and nothing else. A grid
  computed here is a second opinion and it will disagree — two players on a 16:9
  screen are STACKED, and their cells are letterboxed to 1260x540 with 330 px
  bars, not 1920x540.
- The steer bar and the cell dividers are the RENDERER's (`voverlay.mat`).
  Drawing them here doubles them. The line: **cell-anchored and textless goes to
  the renderer; anything carrying type or sticker chrome stays here.**
- The HUD layer takes **no window insets**, and does not need any: each cell
  answers with TWO rects, and the second is already the first inset by the TV
  overscan margin (`ttp_display_safe_insets`, pushed once at surface create).
  Chrome anchored to a CORNER is laid out in the safe rect; a card CENTRED on
  the cell keeps the picture rect. A `WindowInsets` padding on the layer would
  shift every chip off the picture it labels, and it knows nothing about cells.
- Full-screen boards DO take the margin themselves, from `Tokens.safeMarginX/Y`
  — they are laid out by Compose against the whole window, so nothing has inset
  them. Never re-spell it as `96.dp` / `54.dp`; `tests/safe-zone.test.js` fails
  if you do.
- Nothing in the HUD is focusable. The focus engine drives the pause overlay and
  the results button, and a focusable HUD element steals from them.
- Poll `ttp_display_hud()` at ~6 Hz. Nothing in it moves faster than a place.

## The frame budget on this GPU

**The STEADY frame is GPU-bound, and it is not close.** Measured with the
backend's own timer (`ttp_display_gpu_ms`, real here — it is the GL timer query,
unlike the two sibling shells): the renderer's CPU half is under 2 ms whatever is
on screen, while the GPU is tens of milliseconds. `PerfMonitor` shows both — it
GATHERS, and every judgement in it (the ring, the percentiles, the two rates, the
drop count, the verdict) is `ttp_perf.h`'s, so a run this box calls amber is one
the browser and the Apple TV call amber too. It logs that readout as one JSON
object a second under `TtpPerf`, which is the bench's whole wire on all three
platforms. `PerfDebug`
pins the render scale and drives `ttp_display_debug_features` from `adb setprop`,
which is the only way to get two comparable ablation arms (an unpinned sweep
resizes the buffer underneath itself, and it will happily hand you a 3x swing
between arms that differ in nothing).

**THE TAIL IS NOT GPU-BOUND, AND `ttp_display_profile` ALONE CANNOT SEE IT.**
That profile is the RENDERER's own, and the main thread also carries the sim
tick, the per-frame race-event drain, the ~6 Hz HUD poll and every line of Compose
that runs after the Choreographer callback returns — so a frame lost up there once
read as a healthy GPU and a mystery. A MEDIAN taken here said nothing on the
Kotlin side was worth optimising, and it was wrong about the tail: two Kotlin-side
defects were each costing whole frames (a cold `SoundPool.play`, and an
always-running Compose animation), and the readout showed neither.

**Three of those four are now IN the readout.** `DisplayHost` times its own
callback and hands `PerfMonitor` the spans beside the renderer's zones — `sim`,
`slow` (the HUD and knob polls) and `other` (the remainder), summing to
`callback` — and `PerfMonitor` logs a per-phase `phase50` / `phase95` line beside
its worst-frame `spike` pair, so what a TYPICAL frame spends per step is on the
wire and foldable. **What is still invisible is COMPOSE**, which runs after the
callback returns and is nobody's span.

**The instrument for that, and for anything sub-frame, is still `atrace`**, and
`DisplayHost` emits the three markers that make it work — `ttp:sim`,
`ttp:render`, `ttp:slowTick` split the callback, and Compose emits
`Recomposer:recompose` and `traversal` itself:

```
adb shell atrace -b 16384 -a games.couchpad.tinytrack -t 30 \
    -o /data/local/tmp/tr.txt gfx view sched am wm
```

Read the frame CADENCE out of the gaps between `Choreographer#doFrame` slices,
not out of the slice durations — that is the same present-versus-callback
distinction the trap below is about. **Leave the perf readout DOWN** — it is off
unless a previous session asked for it (`setprop debug.ttp.perf 1` or keyevent
165), and it is four lines of Compose `BasicText` re-measured at 4 Hz, which is
main-thread work of the same order as anything being hunted: up, it hands you its
own cost as the finding. Clear the property between runs the way every other knob
is cleared.

`docs/perf/androidtv-frame-map.md` is the last full reading — dated, stamped with
its build and its panel, and kept out of this file because a number here rots
into a phantom regression. What is durable about how it was taken is below.
`docs/perf/androidtv-4p-plan.md` is the standing plan for four-player 60 fps,
and it is where a lever gets priced, ordered and struck off; it is kept out of
this file for the same reason.

`scripts/perf-frame.mjs` is the FRAME MAP: one table per player count with every
step of a frame in it, fusing the three instruments that no single one of them
can replace — the main thread's split above, Filament's backend thread sampled
from `/proc/<pid>/task/*/stat` (GL command EXECUTION, the largest consumer in
this process and invisible to everything in-process), and the GPU timer with a
per-group ablation sweep. Run it twice and keep the second; see below for why.

`scripts/perf-race.mjs` is the one in-race harness, and
`scripts/perf-race.android.mjs` is this box's half of it: it launches the `bench`
scenario — a REAL race whose player seats the engine drives — with the scaler
free or pinned, a `TTP_FEAT_*` ablation mask, and the cell count set by how many
players it seats. It reads back the readout the app logs, plus the renderer-CPU
spike attribution per phase, which is Android's alone. One run answers "where
does it settle"; interleaved runs at a pinned scale answer "what does this
feature cost". It joins no phones and touches no relay: the bench seats its own
players, so a measurement no longer depends on a service on the internet.

**THE CAR SHADOW IS TUNED FROM HERE TOO** — `debug.ttp.shadow` takes the tuning
as PARTIAL JSON (`ttp_display_shadow_tuning`), because that channel's cost is
CPU and only this box has any. It is ~2 ms of frame thread here and free on a
desktop GPU, so `/shadow-lab.html` cannot answer a single question about it; the
table in `native/renderer/CLAUDE.md` was taken with this knob. Clearing the
property restores the shipped tuning, for the same reason the feature mask
treats 0 as "not set".

**MEASURE AT A PINNED SCALE, AND SET THE MASK EVERY TIME.** Two traps have cost
an experiment each. `debug.ttp.features` is a SYSTEM PROPERTY that survives a
force-stop, so an arm that does not set it silently inherits the last one. And
the cost windows are DEEP — the readout's percentiles fold 120 frames with no age
bound (`ttp/perf_stats.h`), which at 12 fps is ten seconds of history — so an arm
whose mask lands mid-run reads as a blend of itself and the arm before it.
`PerfDebug` drops both windows when the mask moves, which retires that one. Each
arm is still ITS OWN RACE, and the first seconds of each (the grid, the first
corner, the scaler settling) are thrown away rather than folded.

**INTERLEAVING SHORT ARMS INSIDE ONE RACE WAS TRIED HERE AND IT DOES NOT WORK.**
The reasoning is sound everywhere else — hold the process, the driver state and
the shader cache still, and round-robin the arms — and it is what the web sweep
does. On a LIVE race none of those is the confound: WHERE ON THE LAP the sample
lands is, and a lap's own cost varies by about 4 ms here. Short arms taken seconds
apart are priced at different corners, and the readings say so out loud — the
unablated arm alone came back with a 7.4 ms spread across rounds, and one ablated
arm read HIGHER than the full picture. Only a fold over a large slice of circuit
averages it out. A whole-race arm either side of a sweep repeats to ~0.2 ms, which
is the resolution to expect and the one to check before believing a row.

**AN ARM THAT FITS THE BUDGET CANNOT BE PRICED AT ALL.** A frame that presents on
every vsync leaves the GPU idle, the box downclocks into the gap, and this
backend's timer reads the PACED span instead of the work — so every arm comes
back at the same number whatever it dropped, and the differences between them are
noise wearing the shape of a result. It is loud once you know to look (at one
player and 540 lines, hiding the ROAD read 2.9 ms slower than drawing it) and
invisible in a table of marginals. Pin the column up until it saturates and
measure there; `perf-frame.mjs` names the columns this applies to rather than
leaving it to be noticed.

**THE BENCH RACE ENDS, AND A SWEEP OUTLIVES ONE.** It is a real race over a real
number of laps; a multi-round sweep runs longer than that, and the rounds past the
finish measure the RESULTS board — which is one cell whatever the race was, so a
4-player split reads as costing what one player does. Nothing in the numbers looks
wrong. Every readout carries its own `cells`, so fold only the lines the race you
meant logged; `perf-frame.mjs` does that, and gives every arm its own launch so
no arm can straddle a finish line in the first place.

**MEASURE THE BUILD THAT SHIPS.** `PerfDebug`'s knobs — and the perf readout
itself, which is LIVE in release, though off until asked for — are deliberately
NOT debug-gated. Gated (as they once were), they are inert AND SILENT in release: a
sweep runs, logs nothing about it, and reports the free-running scaler's numbers
as pinned arms — and the shipping configuration cannot be ablated at all.
Checked once on release at a pinned scale: the GPU-bound half of this section
does transfer between the variants, which was previously an assumption.
`perf-race.android.mjs` restores ALL FOUR knobs on every exit path, because a
property outlives a force-stop and a reinstall, and a leftover one reaches a
RELEASE build too. It used to skip `debug.ttp.hz` — the one knob nothing else
ever cleared — while this file claimed every knob was restored.

**THE FIRST RUN AFTER AN INSTALL MEASURES THE INSTALL.** Same build, same track,
scaler free: straight off a `androidtv-cycle.sh` it settles at 720x405 with 5.6
drops/s, and the very next run settles at 960x540 with 0.3. That is a whole rung
and a visible drop rate, out of dex/JIT and shader warmup rather than out of
anything in the frame, and `sleep 22` does not clear it — it clears the boot. So
throw the first run away. It is also the reason a debug/release comparison is
easy to get backwards: run them in that order and the variant gets the credit for
the warmup.

**The lobby's attract demo is deterministic but it does NOT pick a fixed track**
— it previews whatever the tour last resolved to, so two runs either side of a
race are two different scenes. Pin the track: the bench takes one.

**THE COST IS `fixed + per-megapixel`**, and the fixed half is what the render
scale cannot spend against — no buffer size reaches under it — so it is what
decides how much resolution a budget buys. Price a feature by interleaved A/B
medians of live runs at a pinned scale, at TWO pinned scales when the
fixed-versus-per-MP split matters — and only against fits taken with the same
instrument, because a live lap averages camera angles no frozen scene can. (The
historical fits behind this section were taken with a frozen-bench script since
deleted; git history has it.) The MECHANISMS — why the fixed half is the scene
being submitted, why the fill half is the deck's fragment shader, and the levers
that paid (the per-vertex light move, the declared-size law, the ground's `vvis`
bake) — are `native/renderer/CLAUDE.md`'s, each with its measured worth.

- The lobby OVERVIEW and a RACE are different scenes and rank differently.
  Over the lobby the ground dominates (it is most of the picture); in a chase
  camera the deck fills the screen, which is the ranking `native/renderer/`
  documents from the web. **Benchmark the case you mean to improve.**
- **A FROZEN VIEW IS OPTIMISTIC.** Pausing to make two arms comparable parks
  the camera on one spot, and cost varies well over 1.5x around a lap. The live
  run over the whole circuit is the number to quote for "does this hold 60".
- **A GPU MEDIAN UNDER BUDGET IS NOT 60 fps. THE p95 HAS TO BE.** A present lands
  on a vsync or it does not, so a frame at 17 ms does not show at 57 fps, it
  shows at 30 — and a lap whose median is under budget but whose worst sections
  are not comes out at the average of 60 and 30, not at 57. Measured at a pinned
  1280x720: a GPU median of 18.0 ms with a p95 of 22.3 reads as a rock-steady 46
  fps across four identical runs. **So the number to close is the p95, and the
  gap to 60 fps is (p95 - 16.7), not (median - 16.7).** Getting that wrong makes
  a 25 % problem look like a 5 % one, which is the difference between "one more
  optimisation" and "cut something".
- The readings repeat to about 0.6 ms of GPU median and to a whole fps in
  the cadence, so anything under half a millisecond is not a result.
- **THE LAP IS NOT ONE NUMBER, and the spread is the whole problem.** Around one
  circuit the same pinned frame varies by about 4 ms: a third of it presents at
  a clean 60 while the open vistas — the far side of the loop in shot across the
  ground, so the deck appears twice and the terrain fills the rest — do not.
  That is why the p95 and not the median is the number, and why the adaptive
  scale exists: it trades the resolution the open sections cannot afford rather
  than letting them drop frames.
- **A FROZEN VIEW CANNOT SEE A TAIL AT ALL**, because nothing moves in it.
  The rubber layer is the worked example: ablated whole (raster, uploads and mip
  refresh, not just the tap — `--features 0x1DFC` on the LIVE script; the gate
  at the top of `renderSkids` is what makes that bit cover the upload half) it
  leaves the GPU median unchanged and moves the TAIL. Re-measured live at 4
  players / pinned 720 / Vulkan (2026-08-26, three whole-race reps an arm):
  ablating the layer whole is 43 -> 48 fps, 20.08 -> 19.33 ms of GPU median and
  17 -> 13 skips/s, with no overlap between the two sets of runs.
  **The EVENT RATE is not what that costs.** Throttling the level-0 uploads to
  ~30 Hz — which this file used to name as "the half that pays" — measures a
  clean null on the same sweep: 43 fps both arms, 20.08 vs 19.87 ms, 17 skips/s
  both, a gap inside the ~0.2 ms repeat resolution and smaller than either arm's
  own spread; and at the shipping 4-player point (432), where a throttle bites
  hardest at 60 events/s against its 35, both arms lock 60 with zero drops. The
  throttle is GONE from `renderSkids` and the trail's head now sits at the tyre.
  What remains of the layer is the TAP and the CPU raster. Rect COUNT was
  already measured as noise (the coalescing arm), and the mip blits moved
  nothing on their own either (replacing the ~7 Hz full-chain `generateMipmaps`
  with CPU box-filtered per-level sub-rect uploads is kept anyway — it completes
  the layer's no-passes design). The earlier attribution was taken before
  `kMaskedBlobCells` zeroed the masked shadow budget at four cells, which was
  ~7 ms of the frame it was measured in; **re-price a lever whose frame has
  changed under it rather than inheriting its verdict.** A cost that is
  invisible in the median and decides the p95 is what sets the frame rate on a
  vsync-locked display, so measure both.

**Measured and NOT worth taking** — each cost a build and a sweep, so do not
re-derive them:

| arm | result |
|---|---|
| coalescing the frame's ~16 skid dirty rects into 4 by area | within noise; the tail is not the number of `setImage` calls |
| `doubleSided : false` on vroad | within noise; Filament already drops the normal varying once the fragment stage stops reading it |
| `culling : back` on vroad | 0.2 ms, and the deck's underside is deliberately visible on loops |
| road ring step 0.48 -> 0.72 u | 0.3 ms for real chord sag on every track |
| `kRoadChunkTris` 2500 -> 6000 (13 chunks -> 6) | 0.1 ms of fixed cost and **+2.7 ms of fill** — the per-chunk cull and decal window both widen |
| skipping the ~7 Hz skid mip regeneration | ~0.6 ms, and the far field scintillates without it |
| skipping the cell overlay pass | free |
| an sRGB SWAP CHAIN (`CONFIG_SRGB_COLORSPACE`) so the ROP does the encode | **a 3.5 ms LOSS** — see below |
| sharing one `MaterialInstance` across every copy of an instanced scenery model, so automatic instancing can merge their draws | 0.2 ms — and it is the change the Engine::init comment about "111 draws where three issues 42" points at, so **it is the draw COUNT that does not matter here**, not the merging. Settled properly by the merged draw groups (`native/renderer/CLAUDE.md`): −104 draws/frame at 4P moves the GPU MEDIAN zero, and buys the tail (−2..−3.5 ms worst), +1–2 fps and ~0.25 ms of CPU |
| rebooting the box and measuring cold | 3% against warm, so this device is NOT thermally throttled and a long session's readings are trustworthy |

**THE sRGB SWAP CHAIN IS A LOSS ON THIS DRIVER, and it is the most surprising
number here.** `ttpGrade`'s three `pow`s per fragment are the biggest single
item left in a race frame — deleting the encode outright takes a live 1280x720
frame from ~18 ms of GPU to ~15.7 — so moving it into the ROP looks like free
money. `EGL_KHR_gl_colorspace` is present, Filament honours the flag, and the
picture comes out CORRECT. It also comes out at **~21.5 ms**: the driver's sRGB
surface path costs more than the shader maths it replaces, by more than the
maths costs. Whatever EGL config it selects is not the fast one.

So the encode has to stay in the shader here, and the ~2 ms it costs is a real
item with no cheap collection: an approximation is not cheaper either (a
2-sqrt fit is the same count of SFU ops as the `pow` it replaces).

The full-screen antialias pass is OFF here (`ttp_display_antialias`) and that is a
MEASURED trade, not a dislike of the filter: turning it off buys back about one
step of render scale, which on flat high-contrast art is worth more than the
filter is. The measured cost lives beside the switch in `DisplayHost.kt`.

## Can it do 1280x720 at 60 fps? And the 30 fps mode

**MEASURE ON THE VIEW A PLAYER SEES, and no earlier number applies.** The old
harness's phone could not steer — its car scraped a wall while the AI pack drove
away, so for two days every "live" figure priced an EMPTYING ROAD. A real player
starts LAST with seven cars, their contact shadows, items and auras in frame, and
that view runs several milliseconds of GPU heavier than the wall-grinder at the
same pinned scale — the difference between "nearly 60" and "not close". A fit or
a verdict taken on any other view is about a different game.

The bench IS that view now: its player seats are autopiloted, so they drive the
racing line in the pack they started behind, in their own split-screen cells.
(The camera knob that used to stand in for this — follow the car that started in
place 7 — is deleted along with the reason for it. It also collapsed the cells to
one, so it could never price a real 2- or 4-player split.)

At 60 Hz on that view the adaptive scale settles at the FLOOR with its p95
already brushing the budget — the rule being right, not stuck. 720p60 was
never near on the picture that matters. NOTE THE FLOOR MOVED: it was 360 lines
when the rungs were fractions of the ceiling, and is 540 now that they are line
counts, so a re-measurement on this view is owed and 60 Hz will look worse for
it. That is the trade the ladder was chosen for — 540 lines is the softest
picture the game is willing to show, and a box that cannot hold 60 Hz there is
asking a frame-rate question, which is what the 30 Hz mode above answers.

**THE PRESENT RATE IS THE RULE'S NOW, and `debug.ttp.hz` is a PIN over it**
(`pinVsyncInterval`, not a setter — a setter would be overwritten a second
later and the knob would look broken). `ttp_display_scale_poll` answers a
resolution AND a divisor as one operating point, ordered around a desired
1080@60: below it resolution gives way and the rate does not, above it the rate
goes first, so a 120 Hz panel with the headroom to drive it will. This box has no
such headroom and sits below the anchor, so on it the rate is still effectively
fixed at the panel's own — which is what the paragraph below measured.

**A PIN IS DECLARED AS A PERIOD, NOT AS A DIVISOR** (`rulePanelMs`). The rule
owns the divisor half of the point and multiplies the period it is given by the
divisor IT chose, so what crosses is ONE VSYNC — times the PIN, and nothing else.
Fold `vsyncInterval` in and the two multiplications double-count the moment the
rule picks a divisor of its own; leave the pin out and a pinned 30 Hz box is
priced against a 16.7 ms budget and shredded down the ladder to hold a rate
nobody asked for.

**THE SPLIT GOES BELOW THE FLOOR IN RESOLUTION NOW, NOT RATE (2026-08-24).**
`ttp/render_scale.h`'s sub-floor rungs (360/432/480 at the panel's own rate,
split-gated like the escape) plus the four-cell masked-shadow trade
(`kMaskedBlobCells` — every car on the die-cut blob) land an adaptive 4P race
at **768x432@60 LOCKED** on this box, climbing from 360 by model, with the
half-rate backstop kept underneath for boxes that cannot hold 60 anywhere.
The escape's EXIT is a probe by right (the backstop's own reading is a
downclocked paced span and can never pass a share gate — the second one-way
door, cured like the rate step's). The paragraphs below describe the
half-rate backstop, which still exists and still gates on cells.

**2026-09-02: the lock was lost to two shadow commits, and won back twice
over.** The deck's far ribbon (`native/renderer/CLAUDE.md`, the per-cell LOD)
took the straight's heavy seconds from ~21 ms to ~14.6 at 432, and two
retreat rules in `render_scale.h` (the backstop is entered from the bottom
rung only; its exit probes on `kScaleEscapeProbeSec`) stopped the rule
charging 28 s at 30 fps for one late second. Read per second, an adaptive 4P
race on this box is now at 60 fps for 128 of 150 s (100 s at 640x360, 28 at
768x432) and at the backstop for 8. The per-second reading is
`perf-race --timeline`; a run median cannot see any of this, and the ledger
(`docs/perf/androidtv-frame-map.md`) carries why.

**THE FLOOR ESCAPE SHIPPED, 2026-08-21, and it is what makes a 4-way split
watchable.** Four cells cost more to SUBMIT than a whole 60 Hz budget however few
pixels each one gets, so at the bottom rung this box was not choosing between a
locked 60 and a locked 30 — it was choosing between a locked 30 and a 34 fps
missing a quarter of its slots. `ttp/render_scale.h`'s `kScaleEscapeCells` puts
ONE point below the bottom rung, at that rung's own pixels and half the rate, and
offers it only to a surface split three ways or more. Measured on the box,
adaptive, tidepool, every arm at 960x540:

| players | before | after |
|---|---|---|
| 1 | 60 fps, 0 skips/s | unchanged |
| 2 | 59 fps, 1 skips/s | unchanged |
| 3 | 44 fps, 14 skips/s | unchanged — see below |
| 4 | 34 fps, 25 skips/s | **30.0 fps, 0 skips/s** |

**Gated on CELLS and not on cost**, which is the whole design: solo at the floor
reads a gpu p95 of ~21 ms against a 16.7 budget while presenting a clean 60 with
zero skips, so the down-branch has always judged it "late" there and only the
absence of anywhere lower kept it. The cost-gated version was built first and
stole exactly that case.

**Three players is offered the escape and does not take it**, because
`presentsOnCadence` vetoes a retreat while the device is demonstrably
delivering. That is the two rules composing, not a gap: the entry exists
wherever the grid is 2x2, and the presents decide whether the box needs it.

**`debug.ttp.hz 30` presents every OTHER vsync instead** — a locked,
evenly-paced 30 with the sim still ticking at 60 (only picture latency
doubles; see DisplayHost.setVsyncInterval). On the realistic view it holds a
locked 30 two rungs sharper than what 60 Hz affords, and it is the playable
configuration on this box today. Whether the sharper-but-doubled-latency
trade should ever be AUTOMATIC is a product decision parked until a real
phone drives it over the prod relay — until then it is an adb knob, not a
shipped behaviour.

**THE READOUT FOLLOWS THAT PIN**, because the shell tells it to:
`DisplayHost.declarePacing` hands `ttp_perf_pacing` the panel's own present
period and the divisor in force, and the budget every share on that line is
measured against follows the divisor. So a pinned 30 on an idle box reads GOOD
against a doubled budget instead of scoring its own pacing as a dropped budget
per frame, which is what it did before the readout was told — and a readout that
stays red however healthy the run is stops being read. It is re-declared at the
HUD tick, because both halves move under a running app: the divisor from the rule
or the pin, the period from an HDMI mode change.

A scene change SHORTENS the up-hold, and that decision is the RULE's, not this
shell's. The lobby legitimately floors the scale (the attract behind the boards
is one of the heaviest pictures), and without it the race inherits that floor
and `kScaleUpHoldSec` thaws it one rung per 28 s — most of a race spent soft
when the race COULD afford more. What this file owes is one measurement:
`DisplayHost.build` stamps `sceneBuiltNanos` and `adaptScale` passes
`sinceSceneSec`; `kScaleUpRecoverHoldSec` in `ttp/render_scale.h` does the rest.

It lived here as a `recoveryClimb` latch first, and that is the cautionary half.
The browser reads the same rule off the same ladder with the same lap-sized
hold, so it had the identical failure and no mitigation at all — a shell that
solves a rule's problem in its own language solves it for one platform and hides
it on the others. Root `CLAUDE.md` rule 2, from the shell side.

## The picture at a reduced resolution

The box does not render at the panel's size and will not, so what it looks like
is decided by HOW it is reduced as much as by how far.

**The buffer is always a clean fraction of the panel** (`ttp/render_scale.h`'s
ladder). A scale that is not a simple ratio blurs UNEVENLY — at 2.02x some
output rows take almost one source row and their neighbours take a blend of two
— and the bands CRAWL as the camera moves, which on flat colour with thick ink
outlines is the most visible artefact there is. The rungs are LINE COUNTS (540,
720, 1080, 1620, 2160) rather than fractions, which is what makes them come out
whole on both TV panels at once — 1, 3/4, 1/2, 1/3, 1/4 against 2160 and 1, 2/3,
1/2 against 1080 — and makes the bottom rung one floor for every shell instead
of a fraction that meant a different picture on each.

**The chrome is already at native resolution** and must stay there. Only the
SurfaceView is scaled; Compose draws the HUD, the boards and the QR into the app
window at the panel's own size, which is why text stays razor sharp over a
half-resolution 3D picture. Anything that moved a label into the renderer would
lose that.

**The settled rung moves over a lap**, because a lap's own cost varies by about
4 ms and a rung is chosen from a fit taken over one stretch of circuit. The
lap-sized up-hold is what keeps that to a nudge rather than a rhythm; the rung
never climbs into a cost the model has not predicted it can hold, so what moves
is which rung fits, not whether the controller can make up its mind.

**THE RULE SOLVES, IT DOES NOT COMPARE** (`ttp/render_scale.h`, RenderScaleFit).
This box is the reason: nearly half its budget is resolution-INDEPENDENT, so its
total GPU share never drops below ~0.48 however many pixels it gives back, and
any "is there headroom?" threshold low enough to stop a fill-bound GPU
oscillating on these rungs sits below that and would pin this box to the floor
for good. What this shell owes is the pair of numbers the model is fitted from —
`prevScale`/`prevCostMs`, the last observation at a different scale, dropped on a
scene build because a slope measured across two scenes belongs to neither.

## Multiview: tried, measured, REMOVED

Every split renders the classic one-`render()`-per-cell frame here, on both
backends. A 2-eye `OVR_multiview2` arrangement shipped for a while — four cells
as two stereo passes into an array target, resolved by a `vpresentmv` pass — and
was deleted. Do not rebuild it:

- **It cannot collect the per-cell cost.** Multiview shares the SUBMISSION, and
  the per-cell term on this GPU is the scene being vertex-processed, binned and
  rasterised PER EYE, which `OVR_multiview2` re-runs per view by design.
  Decomposed on an empty scene the classic 4-pass frame floored LOWER than the
  stereo one: the array target's load/stores plus the full-canvas resolve cost
  more than the ~1 ms/cell pass floor they collected. What was left was a few
  fps of tail at four cells, and measured REGRESSIONS at two and three.
- **It was GL-only** (`glFramebufferTextureMultiviewOVR` is compiled out under
  `__EMSCRIPTEN__` and `FILAMENT_IOS`; Metal implements INSTANCED stereo, not
  MULTIVIEW), so once Vulkan became the default it was reachable on the
  FALLBACK backend at exactly four players.
- **The classic frame is slightly more correct.** A two-eye pass renders ONE
  scene state, so the per-cell mutations had to become per-PAIR approximations:
  a midpoint camera for the billboards, a cell-mask UNION for the monster ghost
  swap. Both are exact per cell again.

The measurements, the union-frustum cull, the per-eye camera setup and the
injected `stereoscopicType` material set are in git history.

## Vulkan

**VULKAN IS THE DEFAULT BACKEND on this shell, decided once per launch in
`VulkanPolicy`** (property override `debug.ttp.vk`: 1 forces Vulkan, -1 forces
GL; then the device must advertise Vulkan 1.1 via
`FEATURE_VULKAN_HARDWARE_VERSION` — Filament's floor, and Vulkan is optional
on Android, so no-ICD and 1.0-only boxes go GL from launch one instead of
after two dead boots; then the SPIR-V blob set must be in the APK; then the
boot canary — two Vulkan boots that never presented a frame and every later
launch runs GL until a reinstall). The decision is made at surface create and carried into
`nativeCreate` as a parameter — the shared `ttp_display_create` ABI cannot grow
a platform-private argument — and `DisplayHost` retries the create on GL in the
same call when the Vulkan engine refuses, so a refusing driver still shows a
picture. A Vulkan engine reads the SPIR-V twins from `assets/materials-vk/`
(compiled by `build-runtime-android.sh`; a GL blob does not parse on a Vulkan
engine, so `SceneStaging` follows `DisplayHost.usingVulkan`, never the
property). `perf-race` arms take `--vk 1`, PIN GL when unflagged (the
GL-era ledgers stay comparable), and restore the property to unset on every
exit path.

**Why it exists: the GL driver was nearly half the 4-player frame.** On this
box's PowerVR GL driver the 4P/540 GPU median reads ~27 ms; the same race on
the same box's Vulkan driver reads ~17, and the delivered rate follows (32 →
48 fps; 2P and 3P land on ~60 typical; solo's median drops too). The per-cell
"fixed term" every GL-era note calls uncollectable is therefore a large part
GL DRIVER OVERHEAD, not per-eye geometry — the `gpu ms` timer reads a
first-to-last-command span, and the GL backend thread was stretching it. The
GL-era cost model and its refuted-lever list DO NOT TRANSFER to this backend;
re-price before citing either.

**Two traps already sprung, one fix shipped:**

- **The Vulkan driver caps 2D images at 4096 where GL reports 8192**, on the
  same GPU. The skid layer asked for 8192 and `Texture::Builder::build`'s
  precondition panicked. `TtpRenderer::init` now clamps `mMaxTextureDim` to
  `Texture::getMaxTextureSize` on every backend — the rubber grid just clamps
  one step earlier here, the quality trade the skid comment already documents.
- **A Filament panic on this shell is a silent 100% CPU hang, not a crash.**
  The ARM EHABI unwinder livelocks walking our apk-mapped `.so` (main thread
  pegged, PC bouncing between the lib and the linker's `dl_unwind_find_exidx`,
  nothing in logcat — the panic text never prints). When boot sticks under the
  cover with one thread at 100%, suspect a thrown `TPanic` BEFORE suspecting a
  loop; the debugging route that cracked it (lldb-server in the app sandbox via
  `run-as`, a raw gdb-remote PC sampler, offline symbolization against the
  unstripped `.so`) is in the session notes, since `debuggerd` wants root.

The readout, the scale rule and hz30 all behave identically on it;
`OpenGLTimerQuer`'s thread simply does not exist under Vulkan. The wider-box
driver story is what the canary + GL retry exist for: PowerVR Vulkan drivers
vary, and the observed failure shape (the silent unwinder hang above) is
invisible to a crash-loop detector.

**The Vulkan frame has the web's shape, and its refuted-lever list is its
own.** Re-swept at a pinned 4P/720 (arms must SATURATE — the DVFS trap):
the road's fill is most of the frame, dressing and terrain are small, cars
are near-zero NET (their GL-era cost was submission, and Vulkan ate it), and
**the merged draw groups move this backend's median nothing** — the merge
stays for tvOS, where it is load-bearing. Refuted here, so nobody re-derives
them: a fork patch confining each pass's Vulkan `renderArea` to its viewport
(built, verified ACTIVE in-log, measured ZERO at 720 — the driver already
handles untouched tiles cheaply); the sRGB-swapchain ROP encode (the grade is
a LUT, the prize is ~1 ms of fill, and it flips translucent blending
gamma→linear — a look change); the engine's feature flags (nothing
Vulkan-tunable exists). What remains above the road's own shader is
RESOLUTION — the ladder — and nothing else on this GPU.

**`readPixels` on this driver has no `HOST_CACHED` staging memory**, so
Filament's per-texel reshape used to walk an UNCACHED mapping — every 2-4 byte
load its own memory transaction, which is what made the Vulkan scene build's
readbacks (the road-light ESM above all) several times their GL cost. The
fork carries the fix (`vulkan: bounce readPixels staging through a cached copy
before reshape`, in the pin): one bulk memcpy into cached heap before the
reshape, which halved the bake's `roadLight` phase on this box. The residual
gap to GL is the bounce copy itself plus GPU waits — not worth chasing.

## Audio

**Every cue is mixed here, in Kotlin, into one always-open `AudioTrack`.**
`AudioMixer` is the port of the render half of tvOS's `AudioDevice.swift` and
`CueBank` is the port of its `CueBank.swift`; read those two Swift files for the
reasoning behind the DSP, which is not repeated in the Kotlin.

It used to be a `SoundPool`, and that could only ever play eleven of the sixteen
cue families. The other five are not one-shots: four are SUSTAINED — a loop
crossfaded between baked level stops, in ONE loop phase, which is what the
manifest means by "sample-aligned" — and one is the recorded engine loop with a
LIVE lowpass whose cutoff tracks the throttle. SoundPool can loop, set a rate and
set a volume; it cannot filter and it cannot phase-align two streams. So the
engine note and the boost, squeal and brake beds were silent on this shell while
the web and tvOS played them, which is most of what a race sounds like.

Three things follow that are worth knowing before touching it:

- **The one-shots moved into the mixer too.** The web sums everything into one
  master gain and limiter, so a one-shot on a separate output sits at the wrong
  level against the rest; the detune is a resample here, so it is free and is not
  clamped to SoundPool's 0.5-2.0; and the stream never goes cold, which retires
  the cold-play trap above rather than moving it.
- **The MUSIC is deliberately NOT in the mix**, exactly as on the web and tvOS: it
  is a `MediaPlayer` streaming from the origin, outside the limiter. It still
  carries the master 0.6 (`Audio.js` sets the element's volume to
  `level * this._volume()`), and without that it sits 1.67x loud against its cues.
- **It costs about 5-6% of one core** on this box — measured off
  `/proc/<pid>/task/*/stat` for the `ttp-mix` thread over a live race — for up to
  32 voices with a per-sample biquad on each engine. It is on its own thread at
  `THREAD_PRIORITY_AUDIO` and reaches the frame's thread only through a
  single-producer ring of numbers, so it cannot stall a frame and does not show in
  `doFrame`.

**The manifest is the contract and `org.json` will not tell you when you misread
it** — see `tests/androidtv-cue-manifest.test.js`, which exists because the detune
was read as a number for the life of the port while `jitter` is an object.

**A SONG'S `file` IS ORIGIN-ABSOLUTE, and the music 404'd for the whole port
because this shell added a second `/assets/`.** `audio.cc`'s `SONG` macro bakes
the path in as `/assets/audio/music/<name>.mp3`, so the URL is `baseUrl + file`
and nothing else; `baseUrl + "/assets/" + file` normalises server-side to a
directory that does not exist. Nothing said so: `setOnErrorListener` returns true
and swallows it, and the CC-BY credit chip still announced the track. Both twins
RESOLVE the path rather than concatenating (`assetUrl` on the web,
`URL(string:relativeTo:)` on tvOS), which is why neither of them can show you
this one either.

## Look

Compose for layout, animation and focus; **no `androidx.tv:tv-material`**.
Sticker Bash is flat colour on warm paper with thick warm-ink outlines and hard
zero-blur offset shadows, so every visual is custom drawing and a Material
component library would be fought at every step. What a TV needs from Compose is
the focus system, and that is in `foundation`.

`Tokens.kt` reads the staged `design-tokens.json` — the same file the web's CSS is
baked to. **No colour or length that exists in that file may be spelled again in
Kotlin.** What the file does not carry, the ABI usually does: the cup palette is
`ttp_ui_cup_tint_rgb`, the cup-less wash is `ttp_ui_neutral_tint_rgb`, the
schematic is `ttp_track_schematic_json`. Look for the export before concluding
there is none — a TODO in this shell claimed one did not exist while `ttp_ui.h`
was recording that the FIRST TV shell had made the same claim and copied the
table anyway.

Three Compose behaviours that quietly break sticker chrome, all found by putting
a shot beside the browser's:

- **`Modifier.alpha` CLIPS.** It is `graphicsLayer(alpha, clip = true)`, and every
  sticker's hard drop is drawn OUTSIDE its own bounds by `drawBehind` — so an
  alpha wrapper cuts the shadow off entirely. Fold the opacity into the colours
  instead, or use `graphicsLayer { this.alpha = … }`, which does not clip.
- **`Box` does not pass its minimum constraints down** (`propagateMinConstraints`
  is false) and aligns `TopStart`. A `defaultMinSize` handed to a composable that
  wraps its content in a Box inflates the WRAPPER: the visible face stays at its
  natural width and the surplus becomes dead space beside it.
- **Draw modifiers run in CHAIN ORDER**, and `hardShadow` is a `drawBehind` —
  behind everything AFTER it in the chain, not behind the composable. Chained
  after `background`, it stamps the offset shape ON TOP of the face. Every sticker
  in the kit puts `hardShadow` first; the one place that did not rendered a whole
  results board as flat grey bars.
- **`focusable()` ON A SCROLL CONTAINER IS AN ANR.** A focusable asks its nearest
  scrollable ancestor to reveal its own bounds when it takes focus, so
  `verticalScroll(state).focusable()` on ONE modifier chain asks a container to
  scroll itself into view — content taller than the viewport and all — and it
  never settles. Nothing is logged about scrolling and nothing crashes: the
  process is killed with `ANR ... Force finishing activity` a beat after the
  press, having drawn nothing. Focus goes on the VIEWPORT and the scroll on the
  content inside it. This is the shape every d-pad-scrolled page wants (see
  `LicensesScreen.LicenseText`), so it will come up again.

**The full-screen boards are a FLAT paper wash, and that is the finished look.**
The web's `#pause-overlay` and `#results` also blur the frozen race behind them;
this shell does not, and will not. The mechanism is why, and it is permanent:
that picture is the SurfaceView, composited by SurfaceFlinger in a layer BELOW
the app window, so no `RenderEffect` or modifier anywhere in the view hierarchy
can ever see it — unreachable from Compose is not the same as impossible, but
every route out of Compose costs more than the difference is worth. Both boards
carry the right wash already (`--paper`, values in `public/display/display.css`);
the results board's paper is nearly opaque, so the race barely reaches the eye
and the board is near-indistinguishable from the web's — the more translucent
pause overlay is the only board where the delta reads at all.
The scene's edge vignette is decided the same way and is not Android's alone:
see `docs/native-port/shells.md` (Decided, not owed).

## The info board

The legal branch behind the lobby's ⓘ: privacy and imprint as QR cards, the
attribution list, and the license texts it drills into. `docs/native-port/shells.md`
item 16 is the obligation and `Screens/InfoView.swift` + `LicensesView.swift` are
the reference; what is decided HERE is below.

**The list is STAGED DATA, not generated Kotlin.** tvOS bakes a `Legal.swift`
because its bundle compiles out of the directory it stages into; here `assets/`
is already how this shell reads everything it did not type (the tokens, the cue
manifest, the fonts), so `scripts/gen-legal.mjs` writes `assets/legal/credits.json`
and `Legal.kt` reads it. A generated source set in Gradle would buy nothing. Both
generators share `scripts/shell-credits.mjs`, so only the DELTA — what an .apk
ships that a browser does not, and the reverse — is this shell's. **This is the
one reason `stage-assets.sh` needs node**, and it says so by name if there is
none.

**Every row opens, and that is more than the web page does.** On /licenses.html
each licence chip is a LINK to the entry's terms — the served notice, else the
canonical URL — and a television can follow neither, so a CC-BY or CC0 row named
its licence and gave the room no way to read it. Notice-tier rows open the notice
this build ships; the rest open the licence's own text, one shared copy per id in
`shells/licenses/` (both TV shells read it; the web still links out). The
distinction between the two is the GENERATOR's, never a board's: `notice` still
means the copy that discharges an obligation, and the gates still key on it.

**The branch is the SHELL's navigation, and the model knows nothing about it.**
`ttp_ui.h` owns the screens a party moves through; this stack is reachable only
by the remote, pushes nothing on the wire, and no phone can open or close it —
so `GameState.infoPath` is shell state and `MainActivity`'s back callback unwinds
it BEFORE asking `ttp_ui_back_effect`. Ask the model first and a viewer reading a
license text gets dropped into the lobby, because what it answers is the lobby's
answer.

**The ⓘ is TOP-LEFT here and top-right on tvOS**, because `RootScreen` draws the
perf readout over the top-right corner of every board, where tvOS keeps its own
out of the way at the bottom. The readout is off until asked for, so this is not
a collision a player would ever see — but the person who asks for it is reading
the lobby, and a badge under a black diagnostic block is not an affordance
exactly then.

**The lobby's focus park ports, and do not delete it as tvOS ceremony.**
Compose looks like it seats focus on nothing until a d-pad press arrives, and it
does not: it grants focus to the first focusable in traversal order the moment
the WINDOW takes focus, which here is the moment the cover lifts and
`FLAG_NOT_FOCUSABLE` drops. So a board with one control opens with that control
lit up — the first build of the ⓘ came up already blue, in the corner of a screen
the room is reading a join code off. The park is an empty focusable strip along
the bottom edge, and it REQUESTS focus when the cover lifts. Declaring it first
in the Box is NOT what makes the grant land on it — that was tried, measured, and
the badge still came up blue; tree order only decides where the strip sits.
tvOS needs the same park (`LobbyView.focusPark`) for the same reason.

**A COVERED BOARD MUST REFUSE FOCUS, and being covered is not refusing.** The
board under an info page keeps every focus target it had, park included — so the
symptom is focus on NOTHING, not focus somewhere wrong. `RootScreen` cancels the
ENTRY and the park reclaims focus when the page closes; both sites carry the why.
The trap is reaching for `canFocus = false`, which is what `focusGroup` already
sets: it deactivates the group and leaves its children reachable.

**The license text scrolls by handling the d-pad itself.** `verticalScroll` is
driven by drags and by the focus system bringing a child into view, and a page of
unbroken text on a box with no pointer has neither — so the container is
focusable and turns Up/Down into a half-page `animateScrollBy`. The tvOS twin
slices its text into invisible focus stops instead, because a tvOS ScrollView
moves ONLY to reveal a focused view; that mechanism is that platform's tax, not a
design to copy.

## The screenshot harness

`Scenarios.kt` stands each gallery screen up from fake data so it can be
photographed with no relay, no phone and no party — the Kotlin twin of
`shells/tvos/.../Harness/Scenarios.swift` and of `public/display/TestHarness.js`,
sharing their scenario NAMES through `public/shared/galleryScenarios.js`.

It is **cheaper here than anywhere else**, and the reason is worth knowing before
anyone ports the tvOS approach: Android has a screenshot verb. `adb exec-out
screencap -p` returns the panel with the Filament SurfaceView composited under the
Compose chrome, so there is no test target, no `androidTest` source set and no
result-bundle export — the whole runner is `scripts/capture-shots-androidtv.mjs`,
which is `am start`, `logcat`, `screencap`.

Three consequences of that:

- **The scenario arrives as an INTENT EXTRA** (`--es ttpScenario <id>`, plus an
  optional `--es ttpTrack <id>` and `--ei ttpPlayers <n>`), read once in `onCreate`
  and applied at the end of `boot()` — nothing game-side exists before the surface
  does. `--ei` for the count: `--es` hands `getIntExtra` a String and it answers
  the default without a word.
- **Readiness is a LOG LINE**, `TtpShot: ready|unsupported|failed <id>`, because a
  log line is what adb can observe. It is emitted once the scenario's own scene has
  landed AND the engine has PRESENTED a few more frames; never sleep instead, or
  one run in five photographs a cold shader compile.
- **A BUILT scene is not a scene on the glass**, and on this emulator the gap is
  seconds: the engine stops presenting for as long as eight of them a little after
  a scene lands (`ttp_display_frame` answers 0 throughout), so every card whose
  dressing ran a few seconds past the build came back as a perfect HUD over a BLACK
  surface. `DisplayHost.framesPresented` is what the harness waits on, and its
  timeout has to OUTLAST that stall rather than expire inside it. This is the
  "frames presented counter" the tvOS harness names in its own comment as the
  honest fix and does not have.
- **IT PHOTOGRAPHS WHATEVER IS INSTALLED**, because it never builds and never
  installs — and it stamps every row with the WORKING TREE's sha, so a box one
  build behind produced an Android column labelled with a commit it does not
  show, beside three columns that do. `versionName` carries the short sha for
  exactly this, and the script now refuses to shoot a box that disagrees with the
  tree. A dirty tree can only be checked as far as its commit; that is the honest
  limit, not a reason to skip.
- **`am start -S`** (force-stop first) is REQUIRED, not tidy: the activity is
  `singleTask`, so without it a second launch reaches `onNewIntent`, `onCreate`
  never re-runs, and every scenario after the first photographs the first one's
  screen. It is safe here despite the shell's usual never-force-stop rule, because
  a scenario never opens the relay and so creates no room to recover.

One scenario is not a screen: **`bench` is a live race for the frame-cost bench**,
with no picture anybody wants a photograph of, so it has no gallery card. It is
here because it needs exactly what the other scenarios need — a race with no
relay, no phone and no party — and because the seats a harness fills now DRIVE:
`Scenarios.standUp` latches `ttp_race_autopilot_players`, so every scenario races
a real field instead of a row of cars that accelerate away, never turn, and pile
into the first corner.

The rule it lives under is the ledger's: **a harness may fabricate its INPUTS, but
it must not own a second copy of the road.** Every screen goes through the walk the
live game takes — `applyPick` for a pick, `ttp_room_add_player` for a party,
`ttp_race_start_live_json` for a launch, `ttp_ui_results_view_json` for a board.
`PartyNet.applyPick` and `PartyNet.setTrack` came back with it, which is what
`tests/shell-deadcode.test.js` had been holding them out for.

## Build

```
npm run build:androidtv -- release install     # engine (both ABIs), assets, APK, onto the box
npm run build:androidtv -- debug              # the same, unsigned-by-any-real-key debug variant
scripts/androidtv-cycle.sh                    # the perf loop: materials + one ABI + install + launch
```

`shells/androidtv/scripts/build.sh` is the tvOS `build.sh`'s twin and the only
thing that needs to be remembered. What it wraps:

- **The engine** (`native/scripts/build-runtime-android.sh`) stays a separate
  cross-compile. Gradle is deliberately NOT wired to CMake through
  `externalNativeBuild` — that would put the Filament SDK path, the pinned NDK and
  the fork checkout behind an IDE's idea of when to build. Two build systems, one
  hand-off, and the hand-off is a directory of `.so` files.
- **The staging** (`scripts/stage-assets.sh`) is Gradle's, on `preBuild`. It is a
  file copy rather than a build, and the ordering rule it used to carry in prose —
  staging copies what the engine step produced, so running it first bundles the
  PREVIOUS build's materials — is now a property of the build instead of a rule
  someone has to remember.
- **A stale engine is an error**, not a silent success. `checkEngine` fails the
  build when `jniLibs/*/*.so` is older than the newest source under `native/`,
  because Gradle will otherwise package last week's engine into a perfectly good
  APK. This is the shell's answer to what `npm run check:artifact` is for the web
  (root rule 6). `-PttpNoEngine` is how the CI leg says it has no engine on
  purpose.

**NEVER `./gradlew install<Variant>`. Assemble, then `adb -s "$SERIAL" install`.**
Gradle's install task installs on EVERY attached device, and this tree is worked
in many worktrees at once — so one agent's install lands its APK on the box
another is measuring, and on any emulator either has open. It does not read as an
install: it reads as YOUR build crashing, because the process that starts is
someone else's. `shells/androidtv/scripts/android-device.sh` is the one device
rule (`ro.build.characteristics` says `tv`, `TTP_SERIAL` overrides, an AVD only
ever by name) and both shell entry points source it.

**The release variant is signed, and which key depends on the machine.** The
secrets are looked for in two places (`app/build.gradle.kts`): `keystore.properties`
beside the Gradle root, which is what the release workflow writes on a runner,
then `~/.android/tinytrack.keystore.properties`. THE HOME ONE IS THE NORMAL
ANSWER on a dev machine, because it is per-machine like the .jks it names and
this tree is worked in many worktrees at once — the in-repo file is gitignored,
so a per-worktree copy reaches exactly one checkout and the others quietly sign
with something else. With neither, `signingConfigs.debug`, which AGP generates on
demand — so a fresh clone and CI still build an installable APK with no secret,
and release and debug upgrade over each other there. Unsigned is the one thing it
is never: `app-release-unsigned.apk` is what no device takes. That debug-key
fallback is also why the release workflow verifies the shipped bundle's
certificate against the keystore instead of trusting the build to have failed.

**A box remembers which key it was installed with**, and Android refuses an
update across signers (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). The only way over
is `adb uninstall`, which takes the app's data with it: the cup progression, the
mute flag and the last track (`SharedPreferences`), plus the blob cache and the
saved room in `cacheDir` — of which only the progression does not rebuild itself.
That is the whole cost of letting one worktree fall back to the debug key.

**R8 is ON in release**, and `app/proguard-rules.pro` is worth reading before
touching either: the bridge is bound by NAME from `JNI_OnLoad`, so a rename is an
`UnsatisfiedLinkError` at the first frame, and the file's most important entry is
the keep it deliberately does NOT have (`BuildConfig`, and why). Off, the dex was
20.1 MB of a 22.8 MB APK; on, it is 2.0 and the APK is 16.8, of which 12.3 is the
two ABIs of the engine. R8 also needs more than Gradle's default daemon heap —
`gradle.properties` exists only for that, and the failure without it names neither
R8 nor memory ("Gradle build daemon has been stopped").

**CI compiles the Kotlin half** (`.github/workflows/androidtv.yml`), release
variant, without an engine. It is compile-only for the reason `native.yml`'s NDK
leg is: a runner has no TV. Nothing built the app at all before it.

**A release tag ships TWO store bundles** (`.github/workflows/release.yml`), both
signed, both from one native build: the `release` variant to Play's Android TV
closed track, and the `phoneTest` variant to the ordinary closed track. Two,
because Play's twelve-testers gate is per APP and most testers own no television
— and two TRACKS rather than one shared release, because a `tv:` track refuses
any bundle that does not REQUIRE leanback. It is a separate workflow rather than
`androidtv.yml` with a keystore because a store build needs the REAL engine, so
it carries the whole native chain a runner lacks — the pinned Filament fork built
for both ABIs, the NDK that fork pins, and the host `matc` for the SPIR-V
material set. That is cached on `filament.pin`, and a manual
dispatch (which builds but never publishes) is how the cache gets warmed after a
pin bump.

`versionCode` is pinned at 1 in the build file and overridden per upload with
`-PttpVersionCode`, because Play refuses a code it has already seen while a
sideload refuses one lower than what is installed. **The TV bundle always takes
the higher code of the pair** — codes are one space across all tracks, and
`phoneTest` makes leanback optional, so a television is compatible with both and
Play installs the highest code it can. The workflow's comment carries the full
reasoning; do not invert the pair.
