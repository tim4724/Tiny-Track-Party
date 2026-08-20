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

**2. The bridge is generated. Do not hand-edit either half.**
`scripts/gen-jni.mjs` reads the `TTP_ABI` declarations out of the ABI headers and
emits `native/runtime/ttp_jni.cc` and `Ttp.kt` from one parse, so the two cannot
disagree about a signature. `tests/jni-generated.test.js` holds the committed
files to it. Adding an export means regenerating, never typing. The ten
non-mechanical exports are named in the generator's `OVERRIDES` with the reason
each is there; an eleventh belongs beside them.

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

Two driver facts that make tree-wide assumptions false HERE, both read off the
device's own extension string (`dumpsys SurfaceFlinger | grep GLES`):

- **`GL_EXT_texture_filter_anisotropic` is ABSENT.** Filament clamps
  `gets.max_anisotropy` to 1 when it is, so every `setAnisotropy(...)` in the
  tree — the rubber layer's and the ground textures' — is a NO-OP on this box.
  The comments defending those settings were measured on an M1 under
  ANGLE-Metal; they do not describe this device, and reasoning about aniso cost
  or aniso quality here is reasoning about nothing.
- **The rubber layer is 8192 wide, not 16384.** `setMaxTextureDim` is called
  only from the WEB surface (it is the one that makes its own GL context before
  handing Filament a null window), so this shell keeps the conservative default
  and every shipped track clamps to it. The grid is therefore 3–4x anisotropic
  along arclength rather than isotropic, and the stamp's angle-aware feather is
  what carries diagonals.

## Traps already sprung

**`matc`'s default optimizer emits GLSL this GPU rejects.** It round-trips
through SPIR-V and produces loops carrying a temporary through the increment
expression (`for (int i=0; i<n; t0=t1,i++)`) where the temporary is assigned only
inside the body. Desktop GL and Metal accept it; the PowerVR driver reports "used
without being initialised" and then fails the compile, so `TtpVroad` — the one
material with dynamic loops, over its 32 deck decals — never links and Filament's
GL thread throws `PostconditionPanic` and aborts the process. `build-materials.sh`
passes `-Os`, globally and for every platform, because a browser on this same box
drives the same driver.

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
of it.** The results view answers `raceRows`; the tvOS Swift decodes
`podiumRows`, which exists nowhere in the C++, so its phase-1 list has always
been empty. `TTP.swift`'s polarity comment was stale the same way, and cost a
device run — int returns are ONE polarity, truth is non-zero (`ttp_abi.h`). Two
shells agreeing is not evidence — the header is.

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
- The HUD layer takes **no window insets**. The rects describe the surface, so an
  overscan padding shifts every chip off the picture it labels. Full-screen
  boards get a margin; the HUD does not.
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

**THE TAIL IS NOT GPU-BOUND, AND NO NUMBER IN THAT READOUT CAN SEE IT.**
`ttp_display_profile`'s `cpu` is the RENDERER's own profile. The main thread also
carries the sim tick, the per-frame race-event drain, the ~6 Hz HUD poll and every
line of Compose that runs after the Choreographer callback returns — and all of
that is outside every number `PerfMonitor` prints, so a frame lost up there reads
as a healthy GPU and a mystery. A MEDIAN taken here once said nothing on the
Kotlin side was worth optimising, and it was wrong about the tail: two
Kotlin-side defects were each costing whole frames (a cold `SoundPool.play`, and
an always-running Compose animation), and the readout showed neither.

**The instrument for that half is `atrace`**, and `DisplayHost` emits the three
markers that make it work — `ttp:sim`, `ttp:render`, `ttp:slowTick` split the
callback, and Compose emits `Recomposer:recompose` and `traversal` itself:

```
adb shell atrace -b 16384 -a games.couchpad.tinytrack -t 30 \
    -o /data/local/tmp/tr.txt gfx view sched am wm
```

Read the frame CADENCE out of the gaps between `Choreographer#doFrame` slices,
not out of the slice durations — that is the same present-versus-callback
distinction the trap below is about. **Hide the perf readout first** (`adb shell
input keyevent 165`): it is four lines of Compose `BasicText` re-measured at 4 Hz,
which is main-thread work of the same order as anything being hunted, and leaving
it up will hand you its cost as the finding. It is on by DEFAULT (every build
except a `Scenarios` run), so hiding it is a step you take, not one you forget.

`scripts/perf-race.mjs` is the one in-race harness, and
`scripts/perf-race.android.mjs` is this box's half of it: it launches the `bench`
scenario — a REAL race whose player seats the engine drives — with the scaler
free or pinned, a `TTP_FEAT_*` ablation mask, and the cell count set by how many
players it seats. It reads back the readout the app logs, plus the renderer-CPU
spike attribution per phase, which is Android's alone. One run answers "where
does it settle"; interleaved runs at a pinned scale answer "what does this
feature cost". It joins no phones and touches no relay: the bench seats its own
players, so a measurement no longer depends on a service on the internet.

**MEASURE AT A PINNED SCALE, AND SET THE MASK EVERY TIME.** Two traps have cost
an experiment each. `debug.ttp.features` is a SYSTEM PROPERTY that survives a
force-stop, so an arm that does not set it silently inherits the last one. And
the readout's percentiles fold a window of 120 FRAMES with no age bound
(`ttp/perf_stats.h`), which at 12 fps is ten seconds of history — so an arm
whose mask lands mid-run reads as a blend of itself and the arm before it. Each
arm is therefore its own launch, and the first seconds of the race (the grid, the
first corner, the scaler settling) are thrown away rather than folded.

**MEASURE THE BUILD THAT SHIPS.** `PerfDebug`'s knobs — and the perf readout
itself, which now shows in RELEASE too — are deliberately NOT debug-gated. Gated (as they once were), they are inert AND SILENT in release: a
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
  leaves the GPU median unchanged and takes the dropped-frame rate from ~16/s
  to ~6 at a pinned 720p. The attribution, taken live one half at a time: the
  TAP is ~0.6 ms of GPU fill, and the rest is the UPLOAD path — and within
  that, the stall is the per-frame `setImage` EVENTS on an in-flight texture,
  not the mip blits: replacing the ~7 Hz full-chain `generateMipmaps` with CPU
  box-filtered per-level sub-rect uploads moved nothing on its own (kept
  anyway — it completes the layer's no-passes design), while throttling the
  level-0 uploads to ~30 Hz is the half that pays. Rect COUNT was already
  measured as noise (the coalescing arm), so it is the events' frequency, not
  their size. A cost that is invisible in the median and decides the p95 is
  what sets the frame rate on a vsync-locked display, so measure both.

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
| sharing one `MaterialInstance` across every copy of an instanced scenery model, so automatic instancing can merge their draws | 0.2 ms — and it is the change the Engine::init comment about "111 draws where three issues 42" points at, so **it is the draw COUNT that does not matter here**, not the merging |
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

Two web looks this shell still owes (`docs/native-port/shells.md` holds the
ledger) whose HOW is already settled:

- **The boards' frosted blur is unreachable from COMPOSE, which is not the same
  as impossible.** The web's `#pause-overlay` and `#results` blur the frozen race
  behind them; here that picture is the SurfaceView, composited by SurfaceFlinger
  in a layer BELOW the app window, so no `RenderEffect` or modifier in the view
  hierarchy can ever see it. Both boards already carry the right paper wash
  (`--paper` at 0.72 and 0.92). The two live routes are
  `Window.setBackgroundBlurRadius` (API 31+ — SurfaceFlinger blurs everything
  behind the WINDOW, so it toggles as a board shows and hides; disabled outright
  on low-end boxes, which falls back to today's look, not a failure) and a
  renderer pass, which is where the web's own blur effectively lives.
- **The scene's edge vignette (`#scene::after`) belongs UNDER the chrome**, so a
  Compose overlay is the wrong place for it; it is a renderer pass.

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

**`installRelease` works, and did not before.** The release variant had no
`signingConfig`, so it built `app-release-unsigned.apk` and no device would take
it — while this file and `build-runtime-android.sh` both told you to run
`installRelease`. It signs with `signingConfigs.debug`, which AGP generates on
demand, so release and debug share one key and upgrade over each other.

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
