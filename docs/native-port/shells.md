# Writing a shell

What a second or third platform actually owes, audited against the tree on
2026-07-31 rather than planned in advance. [architecture.md](architecture.md)
says what a shell IS ("a shell may only contain code that names a platform
API"); this says what that leaves you holding, and which parts are a decision
rather than a task.

Nothing here is Android- or tvOS-specific work. It is the state of the base.
The tvOS shell is the shipped worked example: `shells/tvos/` (built by
`shells/tvos/scripts/build.sh`), driven end to end by
`scripts/tvos-party-check.mjs`, photographed by `npm run shots:tvos`.

## The shell set

The ABI a shell binds is deliberately small and has ONE generation: the
handle-taking walks. Since the 2026-07-31 surface cut there is no superseded
spelling to pick by mistake — the fine-grained one-rule exports, the
JSON-input race entry points and the GP scalar getters are gone outright
(their corpora replay at the C++ level in ctest). The surface splits by
audience:

- **Shell surface** — what a platform binds: the sim session
  (`ttp_session_begin_field` → `ttp_update` → `ttp_process_input`, packed HUD),
  the room machine's slim core (create/dispose/add_player/set_field/
  transition_to/state/list/host/events + the two provider setters), the
  relay framing + fastlane kits, the net walks (`ttp_net_on_*`, liveness,
  stored pick), the race EXECUTOR walks (`ttp_race_*_live_json` +
  `configure` + `series_state`), the ui reads (`ttp_ui_*` — all of them),
  audio, display, theme, glb. The cup series, the launched field and the
  random-track shuffle bag all live BEHIND THE ROOM HANDLE: the walks create,
  advance, bank, repair and draw internally, so a shell holds no series
  handle, curates no field rows and owns no draw protocol — a start, a cup
  advance and a lobby return are each ONE call. (`ttp_gp_*` remains exported
  as the series engine's own test/tool surface; a shell binds none of it.)
- **Port mirrors** — exports the WEB deliberately does not call because the
  authored JS source is already on its page, pinned by a Node test that sees
  both: `ttp_protocol_manifest_json` (protocol.js), `ttp_net_clean_name`
  (names.js), `ttp_ui_cup_tint_rgb` + `ttp_ui_cup_field_tint_pct`
  (trackPicker.js), `ttp_schematic_points_json` (the SVG-path reader).
- **Authoring tools** — the `ttp_track_*` reads and the schematic decode half,
  banner-marked in `ttp_runtime.h`. Node scripts only; a shell binds none.
- **Dev/gallery** — the display's showcase/bench/debug latches, documented in
  place as off the shipping path.

Two boot-time proofs replace a whole bug class: `ttp_race_effect_ops_json`
and `ttp_net_effect_ops_json` hand over each walk's op vocabulary, and a
shell asserts its performer tables against them at startup (see
`public/display/main.js` and `Net.js`) — an unhandled effect fails the first
launch instead of silently dropping a step at a party. A race answer may
carry net-vocabulary ops in place (the executor merges the set-track tail),
so the race performer falls through to the net performer for those.

## What you get for free

Every one of these is C++ behind a C ABI, conformance-gated on four legs
(linux, macOS, wasm, tvOS-sim), and needs no port:

| You do NOT write | It is | Reached through |
|---|---|---|
| Physics, AI, items, ranking, race lifecycle | `libttp-sim` | `ttp_runtime.h` |
| Track geometry, sampling, schematic projection | `libttp-track` | `ttp_runtime.h` (`ttp_track_*`) |
| Room state, relay framing, fastlane codec, session policy AND its choreography (the net effect lists) | `libttp-party` + the ABI shim | `ttp_party.h`, `ttp_net.h` |
| Cameras, cell layout, fog, the per-frame builder | `libttp-runtime` | `ttp_display.h` |
| Race orchestration, WHOLE: the start gate + launch, the frame's event drain (lifecycle routing included), the cup chain, pause/auto-pause, the roster repairs — each one walk off the live handles | `libttp-runtime` | `ttp_race.h` |
| Every 2D screen's DECISIONS, as keys + data | `libttp-runtime` | `ttp_ui.h` |
| Which cue, what gain, which song | `libttp-runtime` | `ttp_audio.h` |
| The scene itself (Filament) | `libttp-renderer` | `ttp_display.h` |
| The shared constant manifest | `libttp-party` | `ttp_protocol_manifest_json` |

Three properties of that surface matter more than the list:

- **No frame state crosses.** A race frame is `ttp_display_frame(dt)` and
  `ttp_audio_frame(now)`. No car pose, camera matrix or item state is ever
  serialized out and handed back.
- **The HUD is a POLL, not a stream.** `ttp_display_hud()` is a packed struct
  read at whatever cadence your UI framework likes (the web shell uses 160 ms).
  Nothing in it changes faster than a place does.
- **Strings come out as KEYS.** `ttp_ui.h` answers `{titleKey:'cup_champs',
  cupName}`, never composed English, so your platform's own string resources
  are the copy table. Do not compose copy in C++ to save a shell some work.

## What every shell owes

1. **The surface file.** A sibling of `native/runtime/ttp_display_web.cc`:
   ONLY creating and destroying the platform's GL/Metal/Vulkan surface, the
   `TtpRenderer` construction over it, and parking the object in
   `ttp::rt::displayCore()` (`ttp_display_core.h`). Every other display ABI
   body is shared in `runtime/ttp_display_core.cc`, which your module compiles
   as-is — a shell porting from a revision where those bodies lived in the web
   file deletes its copies, and `tests/display-surface-split.test.js` is what
   now fails if one comes back. `ttp_display_tvos.mm` is the Metal one — ObjC++,
   because the `CAMetalLayer` must be produced ObjC-side. The platform-free
   half below both is in `libttp-runtime` and must stay there. If a line names
   no platform API, it is in the wrong file.
   `ttp_display_create`'s surface is a `const void*` and means whatever your
   platform's window is (an `ANativeWindow*` for Android TV); the cast back
   belongs in your file, which is the one that knows. You owe NO entry point of
   your own — tvOS carried one for a while, purely because the parameter used
   to be typed as the web's CSS selector.
2. **A module target.** Add it beside `ttp_runtime_web` in
   `native/CMakeLists.txt` and compile `${TTP_APP_SOURCES}` plus
   `runtime/ttp_display_core.cc` plus your surface file. Do not retype the
   list; it is a variable precisely because a second copy drifts on the first
   ABI added and fails as a link error on one platform only.
3. **Materials.** `native/scripts/build-materials.sh <matc> <outdir> [api] [platform]`,
   using the FORK'S matc. `opengl mobile` (the default) is what the web ships
   and what Android TV wants; tvOS needs `-a metal`. Every material the web
   shell lists (`render/Display.js`'s `MATERIALS`) is required for a correct
   picture, and only `vcolor` fails loudly — the rest degrade silently (no
   `vroad` quietly reverts every road decal to the lifted fallback meshes; no
   `voverlay` and the steer bar and dividers vanish). A shell loading from its
   own bundle should assert on every blob, not copy the web's `if (res.ok)`
   skip.
4. **The 2D UI**, in the platform's own toolkit, rendered from `ttp_ui.h`.
   Bind the effect-op vocabularies at boot and assert your performer tables
   against them (see The shell set above) before anything else.
   The web's rendering half is `public/display/main.js` + `lobbySeats.js` +
   the display CSS (the decisions are already gone from all three); the
   SwiftUI screens under `shells/tvos/TinyTrackParty/Screens/` are the second
   implementation to crib from. Consume
   `public/shared/design-tokens.json` rather than re-authoring the sticker
   palette.
   The couch's PROGRESSION is part of this surface: read the persisted blob at
   boot and hand it to `ttp_ui_progress_load` (NSUserDefaults on tvOS — the web
   reference is main.js's `PROGRESS_KEY`), perform the race walks'
   `persist-progression` effect by writing `progress` back verbatim, and
   compose the snapshot's `progress` chooser key off the stamped catalogue
   (the web reference is `boot.js` `progressChooser()`). Stars, the Playroom
   lock and the unlock progress are all DERIVED in the wasm/lib — a shell that
   re-implements a threshold has copied a rule that will drift.
   A FOURTH obligation, and the one those three do not imply: the lobby SHOWS
   the record, as a cups shelf off `ttp_ui_catalogue_json`'s rows (web:
   `refreshCupShelf`; tvOS: `CupShelf` in `LobbyView.swift`). A shell can bank,
   persist and publish stars correctly and still never show the couch a single
   one — the reward arc then exists only on the phones, which is where nobody
   is looking. Refresh it where the record can MOVE and nowhere else: boot, and
   the `persist-progression` performer.

   **The frame loop is a LIFETIME, and it is not the party's.** A shell must stop
   driving its GPU the moment the app leaves the screen and start again when it
   returns. tvOS learned this the expensive way: the display link ran for the
   life of the process, so the frame in flight when the system took the screen
   never completed, Filament's pacing fence never signalled again, and the
   surface was dead for good — `0/60 fps, 60 skips`, a race startable and
   nothing ever drawn. Idle on the EARLIER phase (tvOS: `.inactive`, not
   `.background`); by the time a platform says "backgrounded" the screen is
   already gone. The party's own lifetime stays separate, because the transient
   phase is also what a system dialog produces.

   **Boot must not hold the first frame hostage.** Whatever the shell's boot does
   — configure, stage assets, build the preview track, dial the relay — it runs
   somewhere, and if that somewhere is the UI thread then the first layout pass
   is what the room stares at for the whole of it. Put suspension points in.

   `npm run check:tvos-lifecycle` is the gate for the first of those, on a real
   Apple TV: it launches, waits for the lobby, presses Menu, comes back, and
   fails if the picture has not changed. It cannot use a test-launched app — that
   provably does not reproduce the fault — so it starts the app itself. No CI
   runner has a television, so this one is run by hand.
   **The results board on a cup is TWO PHASES**, and a shell that paints only
   one of them has dropped the cup's whole story. `ttp_ui_results_view_json`
   answers `raceRows` (the race that just ended, finishing order, lap time +
   what the place scored) AND `listRows` (the cup table it rewrote, standings
   order, the same cells plus the running total), plus the `racePhaseMs` the
   first holds for. Show phase 1, then turn it into phase 2 — the rows
   re-ordering under the points that moved them is the only place a player can
   see what the race DID. `pointsBefore` is on every points row so the total can
   climb rather than jump, and no shell subtracts `gained` for itself.
   **Lay the two phases out identically.** The kinds are `time_gain` and
   `points`, differing by the total alone, precisely so phase 2 fills a cell
   rather than replacing one: give the cells fixed widths and reserve any footer
   that arrives with phase 2. Otherwise every row changes size at the moment the
   shell starts animating its POSITION, and the board re-flows under the
   re-sort — which reads as a glitch, not as a ranking. The web reference is
   `raceOverlays.js`, and `tests/e2e/gallery-boards.spec.js` pins both phases
   plus the board's geometry across the transition.
5. **Transport.** A WebSocket client, and optionally a WebRTC DataChannel. The
   fastlane is an enhancement by design (CONTROL falls back to the relay), so
   relay-only is a legitimate launch. The framing and packet codecs are already
   C++, and so is the CHOREOGRAPHY: every inbound trigger (protocol frame, peer
   message, close, the liveness tick, a drained room event) is one call into
   `ttp_net.h`'s walk entry points, which mutate the room in C++ and answer an
   ordered effect list. What you write is the socket, three timers, a small
   storage read/write, and the effect switch that performs the ops — never the
   walk itself (`public/display/Net.js` `_performNetEffect` is the reference
   performer, and hand-writing the walk is where all six of the first shell's
   launch bugs lived). Drain the room's event queue before performing a walk's
   effects. When your shell gains a SEND path, add a case to
   `scripts/wire-mutations.mjs` — that was the suite's one historical blind
   spot.
6. **The audio device.** A player over the command stream. The cue palette is
   pre-baked (`public/assets/audio/cues/` — WAVs plus a manifest carrying each
   cue's detune spread; see `scripts/bake-cues.mjs` for why the jitter is the
   player's job), but the device is more than a sampler: the engine voice is a
   live passthrough (rate/gain steered per command) and the master-bus
   compressor is part of the mix contract. `public/display/Audio.js` and
   `shells/tvos/TinyTrackParty/Audio/AudioDevice.swift` are the two
   implementations to compare.
7. **A QR encoder.** Settled in [shared-cpp-plan.md](shared-cpp-plan.md) (§QR):
   there is deliberately no C++ encoder, because the URL composition is shared
   and only the module bitmap is per-platform. `CIQRCodeGenerator` on tvOS,
   ZXing on Android, `public/shared/qr.js` in the browser — copy its policy (EC
   level L, a 1-module quiet zone), not its library. Every shell encodes
   locally: no display asks its own origin to draw its own join code.
8. **A base URL, and this shell's `cpp` value.** `session.h`'s `join_url` needs
   an origin serving the phone controller, and a native app has none of its own.
   The web deployment is therefore a runtime dependency of every TV app.
   `baseUrlOverride` is the existing seam. Pass your platform — `"tvos"` or
   `"androidtv"`, the fixed vocabulary `session.h` documents — to both `join_url`
   and `controller_url_template`: the join URL is the only place a display
   declares which box it is to the CouchPad launcher, and the two must agree
   because a player may arrive by either.
9. **A room advertisement, if you are native** (CouchPad CONTRACT §8). Publish
   `_couchpad._tcp` in `.local` at room create, withdraw it at close, with the
   TV's human label as the DNS-SD instance name and the room code as TXT `c` —
   nothing else, and never TXT `cpr`, which is a launcher-to-launcher marker. The
   launcher resolves the code through the relay, so this only accelerates a join
   it could already make: keep showing the QR and the code regardless. The web
   display cannot do this at all (browsers cannot advertise mDNS), which is why
   it has no counterpart here.
10. **Back navigation.** The TABLE crossed (`ttp_ui_back_effect`); the walk did
   not. popstate, the tvOS Menu button and Android's back stack are three
   different animals and the shell owns the traversal.
11. **Asset bytes for the renderer.** The renderer asks for names; the shell
    fetches bytes and hands them over before the build (the web reference is
    `render/Display.js`). Cars and item props go over by their own file names;
    the biome's scenery goes over as `scenery<i>.glb` in the slot order
    `ttp_theme_scenery_models` answers, and the trackside props as
    `prop<i>.glb` per `ttp_theme_prop_models` — the index IS the contract, and
    a missing GLB is skipped, not fatal. Textures ride the URIs inside the
    GLBs plus the kit's shared `Textures/colormap.png`. The HUD's 2D item
    icons are shared assets too: one SVG per item id under
    `public/assets/items/`, recolourable through two CSS custom properties —
    `--icon-accent` (the boost chevrons, `ttp_theme_boost_icon`) and
    `--icon-car` (the monster cab: the body tone of the car MODEL the player
    drives, per `CAR_BODY_COLORS` in `public/shared/itemIcons.js` — not the
    livery, which never repaints a car body). A shell that cannot
    evaluate CSS vars substitutes those two tokens and rasterizes; the baked
    fallback colours are the pre-theme look.
12. **WHEN the scene is built.** A build blocks the thread long enough to be
    seen, and a cup's chained start (`advance`) performs `place-track` with the
    countdown already running — so a shell that meshes there shows the OUTGOING
    circuit under the count and then hitches. Mesh the next circuit when the
    intermission arms instead: the results board is opaque enough to hide the
    swap, and the field the launch will build is a pure function of the
    connected humans, so the prepared scene is the one it wants. The web
    reference is `prepareNextTrack()` in `public/display/main.js` plus
    `Stage.prepare`/`rebuild`, and `tests/e2e/cup-series.spec.js` pins it.
13. **The operating point, measured.** Neither the buffer size nor the present
    rate is the panel's: a shell polls `ttp_display_step` with what its last
    window of frames cost and takes back BOTH — a resolution and a present
    divisor, ordered around a desired 1080@60 (below it resolution gives way,
    above it the rate goes first). One call for the pair, because they are two
    ways of spending the same milliseconds and a shell honouring one and not the
    other would be arbitrating the trade itself.

    What a shell owes is MEASUREMENTS and the surface's own facts, nothing else:
    p95 GPU time in RAW MILLISECONDS (never a share — the rule picks the budget
    when it picks a rate) and its sample count, the same for the frame interval,
    the running `ttp_display_present_floor`, how long the current point and the
    current SCENE have each been in force, the last observation at a different
    scale for the cost model, the band, how many buffer lines a scale of 1.0
    buys, and the panel's own vsync period. Every judgement about those is the
    rule's: which signal decides, which way each may move, how many samples
    count, the holds, and the order of the operating points. If you find
    yourself writing an `if` around a measurement before passing it, it belongs
    in `ttp/render_scale.h` instead — that header also carries the reasoning,
    including why a dropped-frame count is not a signal. Web reference:
    `Stage._adaptScale`, whose `_divisor` paces the PICTURE and never the sim.

    **STILL OWED BY tvOS, deliberately (2026-08-16).** `Stage.js` is the rule's
    only caller in the tree, so the Apple TV renders at the panel's full buffer
    with no relief — which on an A10X at 3840×2160 is four times the fragments
    of 1080p and nothing to give. Deferred with eyes open rather than missed:
    the readout can now tell a held 60 from a skipping one (`fps` counts
    presents, `hz` counts ticks), so the measurement this owes is cheap to take
    whenever the appetite arrives.

14. **An attribution surface.** The build ships CC-BY music, OFL fonts and
    several notice-tier libraries, so a shell that shows nobody is in breach —
    this is an obligation, not an About page. What it owes is a reachable list
    of every credited work, and the license TEXT for the ones whose license
    demands the notice travel with the build. Do NOT type that list: bake it
    from `public/shared/credits.js` plus the live music catalogue (the same two
    modules /licenses.html renders), applying only the delta between what a
    browser ships and what your package does — `shells/tvos/scripts/gen-legal.mjs`
    is the reference, and `tests/tvos-legal.test.js` is the shape of gate that
    keeps a delta honest. Privacy and imprint are couchpad.games pages for every
    game on the launcher: link them, never restate them, and on a box with no
    browser show the URL as a QR for the phone already in the room. Read those
    two URLs out of the display's own footer rather than typing them.

## Still owed by the Android TV shell (audited 2026-08-18)

Each is a real item, not a simplification; the settled reasoning behind the two
look items is in `shells/androidtv/CLAUDE.md` (Look).

- **A demo race that DRIVES.** `Scenarios`' race screens seat four fake players
  and launch them through the real start walk, and nothing drives them. Throttle
  is automatic here — a car's input is steer/brake/use — so an undriven seat does
  not sit on the grid: it accelerates away, never turns, and piles into the first
  corner while the CPU field leaves. Every screenshot and every perf reading off
  that race is of a picture the game cannot produce.
  **THE WEB IS NOT THE ANSWER TO COPY.** Its harness passes bot specs over EVERY
  id, which works only because it runs in BARE mode — `buildSession` returns
  early on `bare`, so there is no `RaceSession` and nothing counts participants.
  Do the same through the walk and `ttp_session_begin_field` files every spec'd
  entry under `bots` and none under `humans`, the session has no players left,
  and the race is torn down on the spot (measured: the box returns to the lobby
  a second after `TtpShot: ready racing`). The real fix is in that constructor —
  an entry that is a PLAYER and also carries a controller, one `seats` slot, in
  `humans` for the queries and in `bots` for `driveBots` — behind an explicit
  marker so no existing launch changes. It is a core-path change and wants its
  own commit, with a gate that asserts the OUTCOME (the session still reports
  human participants, the cars are still moving N seconds in) rather than the
  shape of the create-session payload, which is what a first attempt asserted
  while the feature was broken.

- **A decision about the perf readout before a player sees one.** Both TV shells
  boot with the frame-cost panel VISIBLE in release, and the web does not: its
  `PerfHud` constructs hidden and the "P" key shows it. The argument for release
  is real and is the render-scale commit's — two of that work's bugs were
  invisible on a debug build, and a shell whose instrument is absent from the
  build that ships cannot be measured. But "live in release" and "on by default"
  are two choices, and only the first one needs making: `PerfDebug`'s knobs are
  live in release and INERT until an `adb setprop` asks for them, which is the
  shape this wants. As it stands a player who launches the app gets a black
  diagnostic block over the corner of the television and no reason to guess that
  `KEYCODE_INFO` removes it. Default it off and leave the key; the gallery's
  Scenarios suppression then has nothing left to special-case, and the tvOS
  column stops carrying four lines of green over every race shot it takes.

- **The mute toggle** — the web's corner button and the host phone's Sound row
  have no counterpart, and the mix has no muted state to honour; a TV's own mute
  is the workaround.
- **The room advertisement** (item 9, `_couchpad._tcp` over `NsdManager`) — the
  launcher resolves the code through the relay anyway.
- **Meshing the next circuit at the intermission** (item 12) — a cup's chained
  start shows the outgoing circuit under the count and then hitches; on this GPU
  a build is seconds, so it is the most visible item here.
- **The info / licenses board** (item 14) — the .ipa's obligations are the .apk's.
- **An app baseline profile** — the release APK carries only library-supplied
  profiles, so this shell's own composables and boot path are not AOT-compiled;
  the tail it would move is the half the GPU readout cannot see, and it costs a
  macrobenchmark module plus a device run, which is why it is an investment and
  not a build-file flag.
- **Frosting behind the full-screen boards** — unreachable from Compose; the two
  live routes are recorded in the shell's file.
- **The scene's edge vignette** — belongs under the chrome, so it is a renderer
  pass.

## The asymmetries worth knowing before you start

- **C interop is not equal across platforms.** Swift consumes a C header
  directly; JS gets `cwrap`. Kotlin gets neither, and even after the surface
  cut the web shell binds well over a hundred distinct `ttp_*` symbols, so a
  JVM shell needs either a generated JNI bridge or a C++ "performer" that
  keeps the JNI surface small. That is a design decision, not an
  implementation detail, and it should be made before any Kotlin is written.
  `architecture.md`'s "three thin wrappers" is true of Swift and JS and
  understates the JVM case.
- **Constants: read them, do not copy them.** `ttp_protocol_manifest_json()`
  hands over the car tables, the wire vocabulary, the STEER contract and the
  LIVENESS windows as one JSON object. A C++ layer can include
  `ttp/protocol.h` instead. Nothing else is a legitimate source, and
  `tests/config-drift.test.js` pins the export to `public/shared/protocol.js`.
- **Asset delivery: the music is the whole problem, and it is corpus-locked.**
  `public/assets/` is ~87 MB, ~81 MB of it race music (the high-bitrate
  masters left the tree; `SOURCES.json` holds their URLs and `npm run
  fetch:music` rebuilds the shipped files). Everything else bundles trivially,
  which is what tvOS does: `shells/tvos/scripts/stage-assets.sh` bundles the
  GLBs, cues and materials and streams the music off the web origin one song
  at a time — an origin every TV app already depends on for the join URL. Before
  planning anything smaller: `audio.cc`'s SONG table bakes each path
  INCLUDING the `.mp3` extension and `audio-corpus.jsonl` froze those strings
  (its JS oracle is deleted), so re-encoding the catalogue to another
  container — or trimming the pool, which shifts every index — is an ABI +
  corpus change (`Song::file` would have to become a stem), not an encode. And
  `ttp_audio_song_json`'s index has to resolve to whatever you pick.
- **The Android NDK leg is the one leg that compiles but does not run the
  fixtures** (`.github/workflows/native.yml` — every other leg runs the full
  ctest suite). `fp-profile.md`
  §NDK flags the contraction risk specifically, so the first Android work
  should be an emulator ctest leg modelled on
  `native/scripts/tvos-sim-spawn.sh` (a `CMAKE_CROSSCOMPILING_EMULATOR` shim),
  not a feature.

## What conformance does and does not cover you for

The corpora prove that a LAYER agrees with the JS that recorded it. They say
nothing about a shell. Two gates exist for the boundary a shell actually sits
on, and a new platform should extend both rather than inventing a third:

- `native/runtimetest/abi_check.cc` — every ABI, every leg, including the
  handle-taking exports whose only statement of correctness is that they agree
  with the JSON path (`handlePathsMatchJsonPaths`). Add a case for every
  handle-taking export you add.
- `tests/wire-compat.test.js` + `tests/wire-fastlane.test.js` — the only place
  two LANGUAGES agree on bytes at runtime. Phones stay on the JS controller on
  all three TV platforms, so this suite is permanent and your sender belongs
  in it.

## The ABI is a PROTOCOL, and that is where a shell actually breaks

Everything above is about ARTIFACTS — what to write, what to link, what to
bundle. The first TV shell got all of that right and still shipped six bugs,
every one of them in the same place: the ~245 hand-written call sites that
invoke rules the C++ had already got right. Not one was a game rule. The sim,
the room machine and the UI model were correct on the first run and stayed
correct.

**This boundary fails silently by construction.** A 0 presence-mask is a legal
"nothing to apply". A misspelled key reads as absent, and absent is legal
almost everywhere. An unhandled event is dropped. None of it throws, none of it
logs, and no type system helps: the returns are JSON on one side and prose on
the other. The first shell shipped six bugs of this class; four of the six are
now UNREPRESENTABLE, because the entry point that permitted each is gone:

1. ~~Verdict keys misread~~ / 2. ~~a verdict mistaken for a plan~~ — the start
   walk (`ttp_race_start_live_json`) answers the verdict AND the launch
   effects in one call; there is no second call to forget and no bare verdict
   to misread. The one protocol left is the DRAWS phase, and it is one
   export's documented contract.
3. **Index-returning exports must be resolved against your own array.** The
   one left is `ttp_ui_reconnect_diff_json` (`add` is indices into the seat
   list you passed). `ttp_ui_connected_players_json` is gone — the walks
   gather the players off the room handle themselves.
4. ~~Lifecycle events misrouted~~ — `ttp_race_events_live_json` drains the
   session queue and routes `_countdown`/`_raceStart`/`_raceEnd` internally.
   A shell never sees a lifecycle event again.
5. **Bitmask parameters are PRESENCE, not value.** `ttp_process_input`'s mask is
   derived by you from which fields arrived; the wire carries none.
6. **Go through the seam, not around it** — now the strongest form: the bare
   unsynced room reads are no longer exported at all. Every answer that
   depends on the active order (`auto-pause`, the standings board's late
   joiners) does the synced read inside the walk.

There is no hand-assembled input left at all: the launch's field copy is
retained behind the room and repaired by the rename/rekey walks, so the
standings board is a pure read (`ttp_ui_standings_live_json(session, room,
over, resultsOrNull, autoAdvanceMs)`).

And one that is not an ABI call at all: **a method nothing invokes reads as
implemented.** A room teardown shipped complete, documented as running "on
termination", and called by nobody, so every exit leaked a room. Swift warns
about an unused `private` func and says nothing about an `internal` one; the
equivalent hole exists in Kotlin. A shell should gate its own transport and
coordinator against having orphaned methods — the one written for tvOS found a
second instance on its first run.

**The only detector for this class is an end-to-end test with a real peer.** A
headless phone driven through a real party — join, HELLO, pick, ready, start,
race, leave — against the real app over the real relay found four of the six,
and no corpus, screenshot or unit test found any of them. That harness is
`scripts/tvos-party-check.mjs` (`scripts/lib/phone.mjs` is the platform-free
half); a new shell should point it at itself before it trusts anything else.

**And a screenshot harness must not bypass the real entry points.** The first
shell's shots reached `ttp_race_launch_json` directly, so fifteen race screens
photographed perfectly for a build whose Start button had never worked once. A
harness may fabricate its INPUTS; it must not own a second copy of the road
(`scripts/capture-shots-tvos.mjs`, `npm run shots:tvos`, is the corrected
one).

**How MUCH harness a shell owes depends on what its platform can photograph.**
tvOS needs a UI test on the device, because `devicectl` has no screenshot verb and
`XCUIScreen.main.screenshot()` is the only thing that captures the CAMetalLayer
composited with the chrome over it. Android has `adb exec-out screencap -p`, which
photographs the SurfaceView under the Compose chrome from outside the process — so
that shell owes a scenario applier and a readiness SIGNAL and nothing else: an
intent extra in, a log line out, `scripts/capture-shots-androidtv.mjs` driving both
from the far side. Read the two before writing a third; the second one is a third
the size.

**The columns are only comparable if the fixtures agree.** `/gallery-shots.html`
puts any two platforms' shots of one screen side by side, and every difference in
the FAKE DATA reads as a difference in the UI: player names, how many rows a board
has, which circuit a race scenario races. Take the web harness's numbers
(`public/display/TestHarness.js` — the names, the times, the banked points) rather
than inventing a set, pin the raced circuit to something that does not depend on
what a previous scenario left in preferences, and put a screen's own `settleMs` in
`galleryScenarios.js` where a card is about a MOMENT rather than a state.
