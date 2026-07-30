# public/display/ — the browser shell

Its job is to **perform and render**; the *game* decisions are C++ (see
`native/libttp-runtime/CLAUDE.md`). What deliberately stays here is the shuffle
bag, the host's mode pick and the lobby demo. tvOS and Android TV get siblings of this
directory reading the same ABIs, so a rule that lives only here is a rule every
other shell must re-derive from prose. If you find yourself writing one, it
belongs in the wasm.

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
correctness constraints live in that order alone.

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

`raceFlow.js` is the oracle its corpus was recorded from, and `aiPersonas.js`
survives only for test surfaces needing the persona table synchronously. **Do not
import either from the display page.**
