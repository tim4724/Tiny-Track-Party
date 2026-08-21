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

`render_scale` is here for a different reason: it decides how big the drawing
buffer should be from what the last window of frames cost, and every platform
meets the same spread of devices. It is TWO files — `render_scale.h`, the pure
rule, and `render_scale_controller.{h,cc}`, the state around it: the window it
folds off the readout's monitor, the running fastest present, the cost model's
observation and the tenure clocks. A shell names its BAND and its panel period
and performs the answer; it holds nothing else, because three shells that held
that state by hand had already drifted to three different percentile formulas.

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

**The countdown is GATED on the scene, not on the build returning.** A launch
answers with two effect lists: the walk, and `start-countdown` alone, held until
`countdownReady` says the scene has stopped assembling. The wait is measured in
FRAMES because that is what pays a scene's staging cost — `render_scale.h`'s
scene grace records an A10X presenting at 7-25 fps for ~2.6 s *after* the build
call came back — and the test is SPREAD (p95 over p50 of the present series), not
speed, because a 4-cell race on the weakest box is steadily over budget and
should still start. `LaunchInput::deferCountdown` is default-OFF for the corpus's
sake, the same trick as `humansAtBack`.

**A draw cannot be put back**, which is why the start/return walks ask the
rules for the verdict BEFORE drawing: a refused start must not advance the
shuffle bag, or "random" repeats sooner and silently skips a track nobody saw.
The bag itself lives behind the room handle now (seeded once with the shell's
page entropy); the decision layer still takes draws as inputs, and the walk
supplies them.

The persona table is single-sourced from libttp-sim and configured straight back.
It used to be a hand-synced JS copy held together by a "keep in sync" comment —
the exact drift root rule 1 exists to stop.

Deliberately did NOT cross: the lobby demo and the performing itself. The
host's mode pick and the shuffle bag crossed into the net walks
(`runtime/ttp_net.cc`), not here — see `native/libttp-party/CLAUDE.md`. The
walks in `runtime/ttp_race.cc` are EXECUTORS over this layer: they perform the
series/field/pick ops themselves and answer only platform ops, while this
layer keeps emitting the full corpus-pinned lists.

## The bench: an autopiloted PLAYER seat

A seat that IS a participant and ALSO carries a controller (`BotSpec::player`).
It exists because a perf bench, a screenshot run and an attract race all need a
field that DRIVES with nobody holding a phone, and neither of the two buckets
could express it: throttle is automatic, so an unsteered seat does not sit on
the grid — it accelerates away, never turns, and piles into the first corner
(45.7 units of track in 900 frames against a driving car's 151).

**The tempting spelling does not survive the walk.** Specifying every seat as a
bot works only in BARE mode, where no session counts participants. Through the
real walk those entries file under `bots` and not `humans`, the session has no
players left, and the race is torn down a second after it starts. So the marker
files the seat under BOTH, and `ttp_session_ai_ids` and the audio's AI set ask
the FLAG rather than the bucket — a marked seat keeps its split-screen cell, is
heard, and is counted by `ui::autoPause`.

`LaunchInput::autopilotPlayers` is default-OFF for the corpus's sake, the same
trick as `humansAtBack`, and `ttp_race.cc` emits the marker key only when it is
set — so no recorded launch gains a byte. `benchPlayers` decides the bench
roster (names, liveries, cars) once, because three shells photographing the same
screen side by side must differ in the UI under inspection and in nothing else.

The gate is on the OUTCOME (`abi_check.cc`, `autopilotedPlayerSeats`): the cars
RACE, against an unmarked control arm that proves the assertion can fail. An
earlier attempt at this feature asserted the create-session PAYLOAD and passed
green while nothing on the grid moved.

## The frame-cost readout

`ttp/perf_stats.{h,cc}` behind `runtime/ttp_perf.h` owns the ring, its trim, the
warm-up filter, the percentile formula, the two rates (`hz` counts ticks, `fps`
counts presents), the drop and skip counts and the health verdict. A shell hands
over MEASUREMENTS — its own clocks, its profile buffer, whatever GPU timer its
backend has — and may not judge them. Same contract as `render_scale`, and the
same WINDOW: `perf::monitor()` is the process's one ring and the scale
controller folds off it, so a shell cannot steer its resolution off numbers its
overlay disagrees with. It carries two present series for that — `frame` is the
tick cadence and `present` the gaps between frames that reached the panel, which
are one measurement on rAF and two on a display link.

It is here because the three shells had already drifted while **all three
carried a comment saying they had not**: each said "the web's thresholds, kept so
the readouts mean the same thing", and by the time this was written tvOS folded
skipped presents into its verdict and the other two did not. A run a television
called amber a browser called green, on the same numbers.

`ttp_perf_readout_json` is ONE canonical line, and it is deliberately the same
bytes the overlay draws from, so a screenshot and a logged number cannot
disagree. **An absent series is `null`, never 0** — a platform with no GPU timer
has no signal, not a free frame.

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

`ttp/wear.{h,cc}` beside it plans the road's asphalt patches as plain
track-space data the renderer stamps. Render-only (the sim never reads it),
deterministic from the track, pinned by the `wear` ctest. **The deck decides
whether it has ever been repaired** (`RoadPalette::patched`): the playroom's
moulded plastic plans none, because a patch on it reads as a stain rather than
as a season of racing. Two siblings were built and removed by decision (git
history has both): a pre-rubbered racing groove, and left/right turn chevrons —
parked for a later revisit of how sharp turns announce themselves.

## The asset gallery and the model bench

`/gallery-assets.html` holds the whole kit in one scene, built from data rather
than a list. It is **dev-only** and reached by nothing on the shipping path, and
`showcase.cc` sits beside `theme.cc` rather than inside it precisely so a gallery
can never move a number the shipping game draws with.

**The kit field** is the other half of the same question. The showroom stages what
the game DRAWS; the field stands what it could have drawn — all ~585 models of the
three Kenney kits — on flat ground beyond the track, each at the size it would
ship and under the same light. It is a BROWSER, and it is 3D on purpose: a sheet
of Kenney's preview renders says what a model is, and only the field says whether
it belongs beside what already ships.

`ttp/kitfield.h` is the packing, and it is header-only because the renderer needs
it and may not link this library (`boost_shades` in `theme.h` is the same shape).
The renderer measures each model's footprint off its own glTF AABB, offsets the
field past the track and the terrain grid, and answers with the layout; the chrome
flies its camera by that rather than re-deriving where anything went. The
`kitfield` ctest holds the properties the field is useless without.

The kits are not in the tree (`npm run fetch:kits`, whose header has the why), and
which kit model each shipped `.glb` came from is authored in
`public/assets/toycar/SOURCES.json` because it cannot be derived — our copies have
been renamed and edited.

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
