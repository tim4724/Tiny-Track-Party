# native/libttp-runtime/ — the decision layers

Platform-free C++: no DOM, no sockets, no timers, no graphics API. Everything here
is executed on every leg by ctest, which is why rules that must not drift silently
live here rather than in a shell.

Every layer has the same shape: **pure functions of plain data returning plain
data or an ordered effect list.** The shell performs and decides nothing.

Beyond the layers below, this directory also holds the camera rigs, the frame
builder and the framing/grid maths (`camera`, `frame_builder`, `framing`) plus the
roster reader. **The rules governing those live in `native/renderer/CLAUDE.md`** —
the overview flag, the aspect band, and the lens invariance rule that no split may
change the authored fov. Read it before touching the frame builder; they are the
rules most easily broken from here, and the ones a fixture is least likely to
catch.

## The UI model

`ttp/ui_model.{h,cc}` behind `runtime/ttp_ui.h` owns the decisions behind the 2D
screens — the seat grid, readiness, the race HUD values, the standings and results
boards, the pause and forfeit predicates, and the screen enum with its per-screen
back EFFECT. `ttp/hud.{h,cc}` is separate and packed, so HUD values never come out
of a snapshot.

**Strings come out as KEYS plus data**, never composed English, so each shell
keeps its own copy tables.

Deliberately NOT in it: DOM/CSS, fades, canvas sizing, rAF, fullscreen, QR
painting, and the back-stack TRAVERSAL — the table crossed, the walk did not.

**The catalogue is not an argument.** With no explicit lists, `ttp_ui_configure`
installs the world this build ships, read from the codegen'd track header; the
difficulty tendency was a rule every shell had to re-implement. Passing lists
still OVERRIDES, which is what the corpus's synthetic world rides and why the
layer stays catalogue-agnostic. `tests/ui-model.test.js` is the drift gate, being
the only place that sees both the authored JS and the wasm.

A held item crosses as a **CODE**, pinned to the browser's mirror by
`tests/display-abi.test.js` — nothing else can see both lists at once.

## Race orchestration

`ttp/race_flow.{h,cc}` behind `runtime/ttp_race.h` is the state machine the
display used to run inline. `ttp_ui.h` holds the predicates; this calls them IN
ORDER.

**Every answer is an ordered effect list, and that is the whole design.** Nothing
returns a verdict for a shell to sequence, because sequencing is the part that is
load-bearing AND silent when wrong. Four constraints live in the order alone:

1. The countdown is published only after the session exists, else every racer's
   `inRace` reads false and phones flash "you're in the next race".
2. The post-GO auto-pause re-check is DEFERRED off the launch stack — it runs
   inside the session update, whose no-seats-left branch tears the session down
   under the caller.
3. Cup points are banked BEFORE the final board goes out.
4. The session is disposed BEFORE the flow flips to LOBBY.

**A draw cannot be put back**, which is why starting a race and returning to the
lobby are each asked TWICE: once with no draws, read for the verdict only, then
again with the draws needed once the answer is "launch". Pre-drawing for a start
that is then rejected advances the shuffle bag for a race that never happened, so
"random" repeats sooner and silently skips a track nobody saw.

The persona table is single-sourced from libttp-sim and configured straight back.
It used to be a hand-synced JS copy held together by a "keep in sync" comment —
the exact drift root rule 1 exists to stop.

Deliberately did NOT cross: the shuffle bag (page RNG, not sim state), the host's
mode pick, the lobby demo, and the performing itself.

## Audio decisions

`ttp/audio.{h,cc}` behind `runtime/ttp_audio.h` decides which cue at what gain,
which sustained voice at what level, the audibility curve, the scrub throttle, the
rocket jet lifecycle and the music shuffle. The device half is browser code — see
`public/display/CLAUDE.md`.

**Nothing about a car crosses to decide a sound.** `ttp_audio_frame(nowMs)` reads
the bound session's Game itself, so the shell hands over a clock and takes back
commands. A cue crosses as a CODE and a voice's identity is an opaque interned
SUBJECT, so no car id is handed back and a rocket cannot collide with a peer index.

Three rules live only on the C side and are invisible above the ABI, which is why
the `abi` ctest asserts each: only the BOUND session is heard (so the lobby's attract
race is silent for free), the end-of-race fast-forward is MUTED, and a disposed
handle takes its queued beats with it.

**Two things the checks pin:** the distance metric must be
`sqrt(dx*dx+dy*dy+dz*dz)` and never `hypot` — one ULP flips a knee of the curve
and changes the command outright — and the music trims are AUTHORED LITERALS;
deriving them with the vendored `pow` turns the corpus red on the first pick.

## The biome palette

`ttp/theme.{h,cc}`, resolved inside `ttp_display_build` from the track's cup, with
an ABI for the `?biome=` override. `boost_shades` is `inline` in `theme.h` for the
linkage reason in `native/CLAUDE.md`.

**No colour of it crosses back.** `public/shared/biomes.js` hands out the biome
name, the scenery list to fetch, and colours for the few 2D widgets the renderer
does not draw. **Wanting another colour getter means the look is being rebuilt in
the DOM; put it in the renderer instead.**

## The asset gallery and the model bench

`/gallery-assets.html` holds the whole kit in one scene, built from data rather
than a list. It is **dev-only** and reached by nothing on the shipping path, and
`showcase.cc` sits beside `theme.cc` rather than inside it precisely so a gallery
can never move a number the shipping game draws with.

**The showcase theme** takes the picked biome's palette unchanged and merges in
every other biome's vocabulary, first-appearance-wins. A biome added to `theme.cc`
therefore joins the gallery on the same commit, and the `showcase` ctest says so —
it also pins that the palette survives untouched and that scenery slot order does
not depend on the biome, since the shell fetches those bytes before the build
picks a look.

The field is a bare session left UNRUN — the cars park on the grid, which is the
opening shot — until the gallery's Drive toggle lets the AI out. A rocket and the
monster truck cannot be authored into a track descriptor at all, so they are
staged only while the scene is held and written to the outgoing frame rather than
into held state; Drive therefore hands the scene back to the sim rather than
leaving trucks welded to the field.

The gallery's control surface is `window.__showroom` (biome, forced item, drive,
camera home) over `ttp_display_showcase` / `ttp_theme_showcase_models`.

**The model bench** (`ttp_display_bench`, with `ttp_display_model_variant`
choosing what later scenes mesh with) exists because some of what the renderer
draws is procedural geometry authored in C++: there is no file to open and no modelling tool in the
loop, so the only way to argue about a shape is to build two and look at them.
Variant 0 is the pre-bench geometry and is kept — a bench with no "what we have
today" is not a comparison — but the defaults are the picks.

**Two standing constraints on rocket-like shapes**, both rediscovered the
expensive way:

- **NO BANDS.** The hue changes where the OBJECT changes, never across one part. A
  banded rocket reads as a traffic cone whatever silhouette it is given — that was
  a palette problem being solved as a shape problem for several rounds.
- Rendering whizz-rolls a rocket about its travel axis, so anything not
  three-fold, four-fold or on the axis WHIRLS: wings, a winding key or a stripe
  down one side read as a propeller.

`tests/display-abi.test.js` diffs what is staged against the GLBs actually
present — a kit model nothing plants is either dead weight or an unfinished
wiring job.
