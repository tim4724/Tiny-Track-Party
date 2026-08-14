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
model threads back to it — the current screen, which reconnect cards attached,
what each phone was last told its item was — and nothing else. The model emits
KEYS plus data, so copy tables live next to the elements they fill.

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

**A card declares its motion, and the declaration is gated.** `animated` means
the SIM animates it, and the preview becomes a play/pause surface over
`window.__preview`. `replayable` means the DOM animates it — an entrance, or the
results board's race→standings turn — which plays once and is then over, so the
card gets a ▶ that runs `window.__TEST__.replay`. Restarting a CSS animation
needs the element to go `display:none` and back **with a style recalc between**;
a hide/show in one task is a silent no-op. A card may declare a ▶ with no hook
behind it and look fine, which is how the phone's Countdown card carried a dead
button — `tests/e2e/gallery-replay.spec.js` walks the real gallery pages and
follows every ▶ to the scenario it points at, so a flag without a hook fails on
the commit that adds it.

`perform()` walks the race flow's ordered effect list and **may not reorder, batch
or skip** — an op it cannot perform throws rather than being dropped. Several
correctness constraints live in that order alone. Both performer tables
(main.js's race ops, Net.js's net ops) are asserted at boot against the wasm's
own vocabulary exports (`ttp_race_effect_ops_json` / `ttp_net_effect_ops_json`),
so a build whose walks grew an op this shell cannot perform fails on load.

`Net.js` is the same shape one layer down: every inbound trigger (relay frame,
peer message, socket close, liveness tick, drained room event) is ONE walk into
`ttp_net.h`, which mutates the room inside the wasm and answers an ordered
effect list; `_performNetEffect` holds the same no-reorder/no-skip contract.
What stays in the file is the socket, the three timers and sessionStorage.
The pick, the random-track shuffle bag (seeded once with page entropy), the
cup series and the launched race field all live BEHIND THE ROOM HANDLE — the
walks write them, no shell mirrors any of it; the game layer asks `net.pick`
or `flow.seriesState` when it needs one. Walks go through `flow.runWalk`,
which keeps NativeRoomFlow's provider-sync and event-drain discipline around a
mutation the class's own methods didn't make.

## Boot and the back stack

Boot lands on the welcome board with the room warming eagerly behind it; NEW GAME
reveals the lobby while carrying the user-gesture unlocks (fullscreen +
AudioContext). Back walks `SCREEN_ORDER` (race → lobby → welcome): back from a race
is the usual full reset, back from the lobby ends the party and warms a fresh room.
Test, gallery and solo surfaces bypass the welcome and push no history.

The back-stack **table** is C++; the **traversal** is not — the History API is
deliberately shell-side.

## Rendering surface

`render/Display.js` is the browser's whole edge of the renderer; `Stage.js` owns
the canvas, the DOM HUD and the rAF loop.

**Three.js is gone.** It survives only as a test-only devDependency for the offline
capture scripts. Do not reintroduce it to the display page.

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

## Measuring frame cost

`render/PerfHud.js` is on by default in development ("P" toggles it) and reports
real GPU ms from a timer query wrapped around the frame call. It instruments
nothing while hidden, so **switching it off for release is gating the `show()` in
its constructor** — one line. `window.__perf` is the live and scripted-sweep surface.

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
