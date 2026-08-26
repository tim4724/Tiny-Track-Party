# public/display/ — the browser shell

Its job is to **perform and render**; the *game* decisions are C++ (see
`native/libttp-runtime/CLAUDE.md`). What deliberately stays here is the shuffle
bag and the lobby demo. tvOS and Android TV get siblings of this directory
reading the same ABIs, so a rule that lives only here is a rule every other
shell must re-derive from prose. If you find yourself writing one, it belongs
in the wasm.

`nativeRuntime.js` loads the wasm and the `Native*.js` files are thin adapters
over one ABI each. `boot.js` stands the whole native stack up in a fixed order
(configure before read, world before any render) and a load failure is **fatal**
— there is no JS fallback.

`main.js` is the RACE CORE and the wiring between layers: the session, the pause
latches, the effect walk, the net callbacks. Anything with its own state and no
stake in a race lives beside it instead — the backdrop crossfade, the overlays,
the TV furniture. When something in `main.js` grows a timer or a generation
counter of its own, that is the signal it has become one of those.

## Rendering from the model, not deciding

`main.js` and the render modules beside it (`lobbySeats.js`, `raceOverlays.js`)
render from the ui model and decide nothing. The shell keeps only the state the
model threads back to it — the current screen, which reconnect cards attached —
and nothing else. The per-phone ITEM outbox used to be here too and is now the
session's (`ttp_ui.h`); the answer arrives already stamped, so a failed send is
not retried by asking again. The model emits KEYS plus data, so copy tables live
next to the elements they fill.

**A preview renders through the live renderer, never a copy of it.** Every
gallery scenario that shows a real screen (the seat grid, the cup slot, the
results board in all three dressings, the countdown banner) calls the SAME
function live play calls, with a synthesized model input. A second
implementation in `TestHarness.js` is how the lobby cards once drifted to a
screen that no longer existed while every test stayed green, and how the
intermission preview spent months naming an auto-advance time the engine had
stopped using. Where the harness has to synthesize a model INPUT (a standings
board, a pick), an E2E case pins a dressing only the correct shape can produce —
a renamed field degrades quietly instead of throwing.

**Only a SIM-animated card declares motion; a DOM-animated one is a still.**
`animated` (shared/galleryScenarios.js) means the sim animates it, and the
preview becomes a play/pause surface over `window.__preview`. Everything else is
a still of the frame its entrance settles into — the welcome slap-in, the
countdown banner, the results board's race→standings turn all play once on
arrival and are then over, which is what the reference shots hold and what a
reduced-motion visitor already sees. There is no replay hook: a ▶ whose only job
was to show an entrance again is a button that had to be kept alive per card,
and the phone's Countdown card carried a dead one for months.

The boards are still PAINTED on arrival rather than painted settled: only phase 1
carries the lap time, the `+N` gain and the points a row came in with, and
`tests/e2e/gallery-boards.spec.js` pins that turn.

`perform()` walks the race flow's ordered effect list and **may not reorder, batch
or skip** — an op it cannot perform throws rather than being dropped. Several
correctness constraints live in that order alone. Both performer tables
(main.js's race ops, Net.js's net ops) are asserted at boot against the wasm's
own vocabulary exports (`ttp_race_effect_ops_json` / `ttp_net_effect_ops_json`),
so a build whose walks grew an op this shell cannot perform fails on load.

**An effect carries everything it needs, and there is no perform context.**
`perform()` once took a second argument holding endRace's ranked results, read
by two ops and paired with them by nothing at all — the kind of unenforced
pairing that breaks the first time one of those ops is emitted from a new entry
point. The rows never leave C++ now: the walk banks the cup points against them
and composes the standings board from them, so the drain answers effects and
nothing else. Do not reintroduce a carrier; if an op needs a fact, it names it.

`Net.js` is the same shape one layer down: every inbound trigger (relay frame,
peer message, socket close, liveness tick, drained room event) is ONE walk into
`ttp_net.h`, which mutates the room inside the wasm and answers an ordered
effect list; `_performNetEffect` holds the same no-reorder/no-skip contract.
What stays in the file is the socket, the three timers and sessionStorage.
The pick, the random-track shuffle bag (seeded once with page entropy), the
cup series, the launched race field and the standings board all live BEHIND THE
ROOM HANDLE — the walks write them, no shell mirrors any of it; the game layer
asks `net.pick` or `flow.seriesState` when it needs one. Walks go through
`flow.runWalk`, which keeps NativeRoomFlow's event-drain discipline around a
mutation the class's own methods didn't make.

**The RESULTS BOARD is the newest of those, and it went last because it looked
like a message rather than like state.** It is composed and retained by the race
walk, injected under `standings` by `ttp_net_lobby_frame`, patched in place by
the rename walk and by the settle stamp, and dropped by the statechange walk —
so `broadcast-standings` is now a bare "republish" and `show-results` paints off
`ttp_ui_results_view_live_json`. Three things left this file with it, and each
was a rule spelled three times across three shells: the mirror itself, the
never-raise-a-first-board gate (a non-null `standings` is what raises a phone's
results overlay, so a board pushed before anyone has crossed the line pops an
empty one over every wheel), and the no-session refusal. All three are C++'s.

**`settled` is the one thing about a board this side still decides the TIMING
of**, and only the timing. It is a wire cue, never part of the board rule, and
it appears only as `true` and only on a cup's LAST board — the phones' signal to
stop reporting the race and report the cup, which they must not do while the TV
is still counting points towards it. The reveal's own completion callback is a
fact no handle knows, so the shell fires `ui.settleStandings()` on every board
that finishes settling and the answer decides whether anything moved and needs
republishing. A board torn down mid-reveal never settled.

## Boot and the back stack

Boot lands on the welcome board with the room warming eagerly behind it; NEW GAME
reveals the lobby while carrying the user-gesture unlocks (fullscreen +
AudioContext). Back walks `SCREEN_ORDER` (race → lobby → welcome), except where
the table says it does not navigate at all: a LIVE race freezes behind the pause
overlay instead (whose "New game" is the way out) and the overlay thaws again, so
no single gesture throws a race away; only a FINISHED race retreats. Back from
the lobby ends the party and warms a fresh room. Test, gallery and solo surfaces
bypass the welcome and push no history.

The back-stack **table** is C++; the **traversal** is not — the History API is
deliberately shell-side. Which is why the two non-navigating answers push an
entry back on: the browser has already popped by the time the table is asked, and
a stack sitting one level under the board would leave the party on the next
press.

A launch's countdown is HELD until the scene it will be driven on has settled
(`ttp_race.h`'s countdown gate): `startRace`/`advanceSeriesRace` walk `effects`
and then arm `countdownEffects`, which `onFrame` releases once the rule agrees.
The two facts this side owes are `Stage.sceneBuilt()` and `perf.measuring` —
under automation and a pinned `?dpr=` nothing feeds the window, and an empty
window must not be read as a scene that has not drawn yet.

## Rendering surface

`render/Display.js` is the browser's whole edge of the renderer; `Stage.js` owns
the canvas, the DOM HUD and the rAF loop.

**Three.js is gone.** It survives only as a test-only devDependency for the offline
capture scripts. Do not reintroduce it to the display page.

**The TV overscan safe zone is C++'s answer, not this file's arithmetic.** A
television may crop the edges of the picture and no browser API reports it —
`env(safe-area-inset-*)` is a notch, and it is zero on every TV — so `Stage.boot`
pushes the authored `--safe-frac-x/y` through `ttp_display_safe_insets` once, and
`cellRects` then answers EIGHT floats a cell: the picture rect, and the same cell
inset by that margin on all four edges. Place corner chrome from the safe rect
and centred cards from the picture. Do not re-derive the margin here — it is
uniform per cell rather than an intersection with the screen's own safe area, and
that is a LOOK decision with a rejected alternative behind it (argued in
`ttp_display_core.cc`), not arithmetic worth repeating.
Page chrome that is NOT cell-anchored takes `--safe-x` / `--safe-y` from
`display.css` instead. The renderer's steer bar is deliberately exempt from all
of it; `TtpRendererFrame.cpp` argues why where it draws the bar.

**The buffer's size AND the present rate are MEASURED, not chosen, and they are
ONE decision.** `Stage._adaptScale` polls `ttp_display_scale_poll` every frame
and gets `[scale, divisor]` back when the point moves, because frame rate and
resolution are two ways of spending the same GPU milliseconds and a shell taking
one answer and ignoring the other would be arbitrating between them itself. The
desired spot is **1080 lines at 60 Hz**: below it resolution gives way and the
rate does not, above it the rate goes first. The rule is
`native/libttp-runtime/ttp/render_scale.h` and the state around it —
the window, the percentiles, the fastest present, the cost model, the clocks —
is `render_scale_controller.h`; this side names the band, resizes, and paces.

**`_divisor` PACES THE PICTURE, NEVER THE SIM.** `_loop` runs `onFrame` on every
rAF callback and gates only the draw, accumulating the skipped callbacks' dt into
the frame that does draw — the renderer's clock (box bob, cloud drift, skid
decay, camera damping) is cosmetic and would otherwise run at a fraction speed.
So on a 120 Hz display holding 1080@60, steering keeps its full 120 Hz cadence
and what doubles is picture latency, not input latency.

**The panel's period is read off the device, not asked for.** There is no
reliable web API for refresh rate, but `_presentFloor` already is the fastest
present this device has produced. It is sticky, so the first unpaced frames learn
8.3 ms on a 120 Hz display before pacing could hide it; and a machine that has
never presented faster than 16.7 there reports 16.7 and gets treated as 60 Hz,
which is what it was going to run at anyway.

**A SCALE HERE IS A MULTIPLIER ON CSS PIXELS, NOT A FRACTION OF THE PANEL**, and
the rule is shared with a shell for which it is the opposite. `_scaleBand`'s
ceiling is `devicePixelRatio`, so on a Retina Mac native IS 2 and a scale of 1 is
half the panel's linear resolution — while a TV surface is the panel and its
ceiling is 1. That is what `baseLines` reconciles: the rule's rungs are LINE
COUNTS, and the band hands over how many lines a scale of 1.0 buys here, so
"720p" means the same picture on both. The rungs were fractions once and the
trap is worth remembering in both directions — read as absolute they quartered
every Retina display, read as fractions of the ceiling they made a floor mean
360 lines on one surface and 720 on another.

**THERE IS NO FLOOR ON THIS SIDE.** `_scaleBand` passes `min: 0` and the ladder's
bottom rung is the floor, in one place, for every shell. `MAX_BUFFER_H` stays
because a ceiling really is per-surface. Nothing is persisted across sessions
either: the signal a timer-less browser uses may only step DOWN, so one bad
window would pin a device lower forever. Re-learning costs a few seconds per
session and self-corrects.

**THE BUFFER AND THE VIEWPORT MOVE TOGETHER, AND BOOT IS THE HOLE.** `_onResize`
is the only place the buffer changes size and it can only tell the renderer once
`display` exists, which it is not for the whole of `Display.create`'s fetches —
so `boot()` re-pushes the size that is actually on the canvas once it has one.
Skipping that does not degrade, it sticks: the viewport stays where
`ttp_display_create` left it and the picture draws at the BOTTOM of the buffer
under a black bar, because the only thing that would resize again is an adaptive
step this machine may never take. NEW GAME's click carries the fullscreen unlock,
which is what makes a mid-boot window change ordinary rather than exotic;
`tests/e2e/boot-resize.spec.js` holds that window open on purpose.

**A SCENE BUILD IS TWO MEASUREMENTS THIS SIDE OWES.** `_rebuild` stamps
`_sceneBuiltAt` after a full `setTrack` (never after a reroster — that is the
same scene re-dressed), clears the perf window, and drops `_prevScale` /
`_prevCostMs`. The first shortens the rule's up-hold while a scale is still
finding a new scene's level. The last two are the rule's COST MODEL: it fits
`fixed + fill * s²` from two observations at two scales and solves for the rung
that fits the budget, and a fit whose two points straddle a scene change
measures a slope belonging to neither, so it must not survive one. Both reached
the tree as Kotlin-side latches that fixed one platform and left this one
exposed.

**There is no device probe, and there must not be one.** A UA string lies and
`WEBGL_debug_renderer_info` is going away; what is measured is this device
drawing this game's frames, so a weak GPU, a hot laptop and four cells instead of
one all arrive as the same fact. It therefore adapts in the lobby too, where the
load is a quarter of a race's — handled by the asymmetric holds, not by a special
case.

**This side no longer holds any of it.** The window is the READOUT's — `PerfHud`
feeds `ttp_perf_sample` every callback and the rule folds off that same monitor,
so a resolution can never be steered off numbers the overlay disagrees with. All
this file still owns is the two things only a browser knows: the band
(`_scaleBand`), and that a hidden tab is not a device. There is no panel period
to declare either — no web API answers it — so 0 goes over and the rule learns
one off the tick series; `scalePanelMs()` reads it back for `perf.pacing`.

An explicit `?dpr=` — or `setRenderScale` — is a caller naming a buffer scale and
switches the whole mechanism off; that is how the trailer renders a 4K master and
how a fixed resolution is pinned for an A/B. Under automation the band collapses
onto the E2E cap, so the suite never adapts. Nothing else needs to know a scale
is in play: the cell grid and every HUD element are placed from the renderer's
device-pixel rects divided back out by the same number.

**Nothing in the DOM is written per frame** — the HUD is a low-rate poll, and
anything tempted onto the per-frame path must actually CHANGE per frame. See
`native/renderer/CLAUDE.md` for what the frame itself costs.

**Fetching assets is the shell's whole half of a scene build.** C++ names what it
needs (scenery, props, cars, the kit field's models) and this side answers with
bytes; nothing about which file that was crosses back. The asset gallery's KIT
FIELD is the extreme case — several hundred models the game does not ship,
fetched by `kit:<kit>/<model>` out of the local kit cache
(`scripts/fetch-kits.mjs`) and provided as `kit<i>.glb`, all of it concurrent
because one await each would turn a field into a minute of round trips. Which
models, and in what order, is entirely this side's; where they stand is entirely
the renderer's, and the layout comes back so the chrome's camera and the scene
cannot disagree about where one is.

**Which of them still NEED fetching is the engine's answer, not a memo here.**
`ttp_display_asset_plan` takes the want list — each name paired with the kit model
its bytes come from — and hands back the subset the engine is not already holding
under that tag; `ttp_display_asset_textures` then names the image URIs those
models reference, read off the bytes the engine has rather than out of a container
this side just handed over. The asset map survives a scene release, so on a
rebuild of a standing track that plan is nearly empty.

**Derived bytes are kept across RELOADS too, and the write half is a frame beat.**
`render/BlobStore.js` is IndexedDB and four primitives; everything else is the
walk in `ttp_display.h`. The plan/offer half runs in `setTrack`; the write half is
`Display.writeReadyBlobs`, called from `_loop`, because a WebGL readback cannot
complete inside the build that issues it — the build stages, a frame lands it.
Under automation there is no store at all (a suite that asserts what a build
produces must not be served what a previous run left behind).

**The frame clock can be handed out.** `Stage.setFixedStep(sec)` makes dt the
named step rather than the rAF delta, so the sim advances once per frame DRAWN
however long the frame took; `?gate=1` (`frameGate.js`) then queues
`requestAnimationFrame` from before boot and lets an outside driver pump it. Both
halves are needed and neither is enough alone: the step alone gives a smooth
capture whose start point still drifts, because the scene free-runs between page
load and the first call. Together they are what `scripts/trailer/` renders video
with, and what lets its browser editor show the frame the renderer will produce.
The gate drives CSS animations from the same clock too — otherwise a one-second
fade finishes inside three captured frames. Nothing in normal play sets either.

The capture scripts must run HEADED: headless Chromium is SwiftShader, headed gets
ANGLE-on-Metal, and that gap is the whole reason `capture-artwork.js` races at a
cheap resolution.

## Measuring frame cost

`render/PerfHud.js` is **off until asked for** — `?perf=1` at boot, the "P" key
at any point, or `window.__perf.show()` — and reports real GPU ms from a timer
query wrapped around the frame call. `window.__perf` is the live and
scripted-sweep surface. Both TV shells default the same way and each has its own
switch (`-ttpPerf 1`, `setprop debug.ttp.perf 1`).

**It measures and draws; it judges nothing.** The ring, the warm-up filter, the
percentiles, the two rates, the drop and skip counts and the health verdict are
`ttp_perf.h`, shared with both TV shells, so a number the three disagree about is
a real disagreement rather than three hand-written folds drifting. `sample()` is
that readout parsed, plus the facts only this side has — the buffer's pixels, the
SCALE they were rendered at (`Stage._dpr`, never `devicePixelRatio`: they differ
under `?dpr=` and under every adaptive step, and a readout that misstates its own
operating point is not comparable to anything), and whether this backend HAS a
timer extension at all.

**The operating point is DECLARED, not inferred.** `Stage` hands the panel's own
present period and the render scale's divisor to `perf.pacing` at boot and on
every re-decide. A divisor above 1 is a chosen cadence, not damage — half the
ticks deliberately do not draw — and a fold that has not been told reads a paced
box as red forever.

**The GPU timer resolves one or two frames late, so a frame is HELD** until its
result lands (or the pool moves past it) and is handed over only then: the
monitor takes a sample once and accepts no amendment afterwards. A script that
pumps a burst of frames in one task holds the whole burst, so the hold is as deep
as the query pool.

**Showing and measuring are separate** (`instrument()`), because the adaptive
render scale reads `sample()` wherever the panel is off — which is the ordinary
state. What the sample costs is a push into a ring and one timer query, and both
stay unconditional: a window kept only while a panel is up leaves the scale rule
deciding a screen's resolution off nothing. What a hidden panel does stop paying
for is everything only a READER wants — the CPU profile read, the scope's ring,
the DOM writes and the readout fold. The CPU term follows `watching`, not
visibility, so `bench()` keeps it with the panel down (`?scenario=bench` below).
A caller that has changed what a frame costs should `reset()` rather than reason
about the window.

**`?scenario=bench` is the bench** (`scripts/perf-race.mjs --platform web`): a
live race on the launch's own field with 1, 2 or 4 autopiloted player seats,
printing `TtpPerf <json>` once a second. The line is the readout's own bytes and
the two TV shells log the same one, so a single parser folds all three.

**Where the frame's cost actually is** — `scripts/perf-features.mjs`. It ablates
one group of renderables at a time (`ttp_display_debug_features`) inside ONE page
load and reads the timer per arm. Its header lists the traps it is shaped around,
and they are the whole reason it is a script rather than something to redo by
hand: a frozen scenario (a live race moves the camera, and framing swamps the
effect), a pinned `?dpr=` (the adaptive scale would resize mid-sweep), frames
pumped in bursts through `?gate=1` (uncapped, an ablated arm runs so fast the
timer's own pool cannot keep up), and every arm preceded by the same conditioning
load (a cheap arm lets the machine cool, and the next reading comes back faster
for a reason that has nothing to do with what it is measuring). It prints each
arm's median beside a paired reading; **the two disagreeing means the machine was
busy**, not that a feature is free.

It also **counts what each arm issues** — draws, the geometry they carry, program
switches, texture binds, buffer uploads — off a patched
`WebGL2RenderingContext.prototype`, and that count is not a browser fact. The command stream is decided in shared C++ (the scene,
the per-cell cull, Filament's sort and its automatic instancing) before any
backend sees it, so the backends differ in what a command COSTS and never in how
many there are: **the count transfers to the TV shells, the milliseconds do
not.** It is there because a split-screen frame on a weak box is bound by
submission rather than by pixels, and a millisecond column alone cannot tell a
few expensive objects from very many cheap ones.

**Three ways of getting this number that do not work:** Filament's
`getFrameInfoHistory()` (on emscripten the timer-query path is compiled out, so it
reports CPU submit time wearing a GPU label); a `fenceSync`/`clientWaitSync` poll
(times `setTimeout` clamping instead of the GPU); and the rAF cadence alone (a
vsync plateau, so it can only ever show DROPS).

## The audio device half

`Audio.js` performs the commands the wasm hands back and **decides nothing**:
AudioContext, variant picks, the `<audio>` element. The DSP palette stays
BAKED rather than ported, because emscripten's AudioWorklet path needs the
COOP/COEP isolation this build refuses.

**`apply()` is the only way a sound starts, previews included.** `Audio.js` once
carried named cue methods for the gallery, on the premise that a preview had no
players and so no distance model to decide against; the previews race the bench
field now, whose player seats are autopiloted PARTICIPANTS, so the decision layer
has its listeners and voices and the harness binds and frames it like any race
(see `TestHarness.js`). Do not re-add a bespoke surface: it was a second set of
levels for the same sounds, pinned at full where the world mix decides one by
distance, so a preview auditioned a mix no player would ever hear.

The master bus — gain → soft limiter → destination — is `audio/bus.js`, with the
one volume preference behind it. It is its own file because the sound gallery
builds the same bus: the limiter acts on the SUM of everything, so an audition
through a different bus is an audition of a different mix. It was three
hand-copies of the same three numbers; `tests/audio-bus-single-source.test.js`
keeps it one.

The music catalogue is pure data in `audio/musicCatalogue.js`; `Audio.js` holds no
table at all, and even the monster engine's timbre arrives as numbers on a voice
command. For the decisions see `native/libttp-runtime/CLAUDE.md`; for the files
themselves, `public/assets/audio/CLAUDE.md`.

## Surviving JS that ships to nobody

`aiPersonas.js` survives only for test surfaces needing the persona table
synchronously. **Do not import it from the display page.** (`raceFlow.js`, the
last JS oracle, is retired — its corpus is frozen; git history has it.)
