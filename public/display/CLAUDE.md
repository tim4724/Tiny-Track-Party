# public/display/ — the browser shell

Its job is to **perform and render**; the *game* decisions are C++ (see
`native/libttp-runtime/CLAUDE.md`). What deliberately stays here is the shuffle
bag and the lobby demo. tvOS and Android TV get siblings of this directory
reading the same ABIs, so a rule that lives only here is a rule every other
shell must re-derive from prose. If you find yourself writing one, it belongs
in the wasm.

`nativeRuntime.js` loads the wasm and the `Native*.js` files are thin adapters
over one ABI each. `main.js` awaits the wasm at boot and a load failure is
**fatal** — there is no JS fallback.

## Rendering from the model, not deciding

`main.js` and `lobbySeats.js` render from the ui model and decide nothing. The
shell keeps only the state the model threads back to it — the current screen, which
reconnect cards attached, what each phone was last told its item was — and nothing
else. The model emits KEYS plus data, so copy tables live next to the elements
they fill.

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
AudioContext, limiter, variant picks, the `<audio>` element. The DSP palette stays
BAKED rather than ported, because emscripten's AudioWorklet path needs the
COOP/COEP isolation this build refuses.

The music catalogue is pure data in `audio/musicCatalogue.js`; `Audio.js` holds no
table at all, and even the monster engine's timbre arrives as numbers on a voice
command. For the decisions see `native/libttp-runtime/CLAUDE.md`; for the files
themselves, `public/assets/audio/CLAUDE.md`.

## Surviving JS that ships to nobody

`aiPersonas.js` survives only for test surfaces needing the persona table
synchronously. **Do not import it from the display page.** (`raceFlow.js`, the
last JS oracle, is retired — its corpus is frozen; git history has it.)
