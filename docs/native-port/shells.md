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
  audio, display, theme, glb, and the frame-cost readout (`ttp_perf_*`). The cup series, the launched field and the
  random-track shuffle bag all live BEHIND THE ROOM HANDLE: the walks create,
  advance, bank, repair and draw internally, so a shell holds no series
  handle, curates no field rows and owns no draw protocol — a start, a cup
  advance and a lobby return are each ONE call. (`ttp_gp_*` remains exported
  as the series engine's own test/tool surface; a shell binds none of it.)
- **Port mirrors** — exports the WEB deliberately does not call because the
  authored JS source is already on its page, pinned by a Node test that sees
  both: `ttp_protocol_manifest_json` (protocol.js), `ttp_net_clean_name`
  (names.js), `ttp_ui_cup_tint_rgb` + `ttp_ui_cup_field_tint_pct`
  (trackPicker.js), `ttp_schematic_points_json` (the SVG-path reader),
  `ttp_race_personas_json` (aiPersonas.js — and NO shell calls this one: the CPU
  roster reaches every platform by `ttp_race_configure` being handed no
  `personas` key at all, which the ABI reads as libttp-sim's own table).
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

## Optional: caching expensive derived bytes between runs

Not owed. Skip it until you have measured that you need it, and **measure per
platform** — the `ttp shadow bake` line the renderer already logs tells you which
you are. The spread is wide enough that the same feature is obviously right on
one box and obviously wrong on another:

| | sun bake | of a build of |
|---|---|---|
| Android TV reference box (Google TV Streamer, Vulkan) | ~1250 ms | ~1870 ms |
| Web (Chromium, desktop GPU) | 85–213 ms | 101–271 ms |
| Apple TV 4K (A10X, Metal) | 64 ms | 199 ms |

…and the silhouettes beside them, which are the other half of what a launch pays:

| | five silhouette bakes | warm launch, both stores |
|---|---|---|
| Android TV reference box | ~330 ms | 1870 → **181 ms** |
| Apple TV 4K | (inside `cars`) | 197 → **49 ms** |

(The Android figure is a first build in a fresh process, which is what a launch
actually pays. An older 520 ms is quoted elsewhere in the tree from a different
box and backend — measure yours rather than inheriting either number.)

**tvOS refused this once, on those numbers, and the refusal did not survive a
second blob kind.** 64 ms alone did not pay for a storage layer. Adding the
SILHOUETTE layers — five GPU bakes, ~330 ms on the Android box and the bulk of a
cold `cars` phase everywhere — changed the sum, and the Apple TV's warm launch
went 197 ms to 49 ms. The lesson is about arithmetic rather than about tvOS: a
store is worth writing when the STORES TOGETHER pay for it, so judge the shell
half against every kind the engine lists, not against whichever one you are
adding today.

If your platform's number does justify it, **you write four primitives and no
policy** — list names with last-used times, read by name, write by name, delete
by name. Android's is `BlobStore.kt`. Everything else is a WALK in
`ttp_display.h` (`ttp_display_bake_plan` / `_offer` / `_keep` / `_export`) that
hands you names to act on:

```
after ttp_display_biome, before ttp_display_build:
    plan(trackId, generation, entries) -> {"drop":[…], "read": name|null}
    perform the drops; if `read`, read it and offer(bytes)
after ttp_display_build:
    keep() -> {"write": name|null}
    if `write`, export() and write those bytes
```

**Do not re-derive any of the decisions behind those names.** Whether the engine
already holds this bake, whether the build actually baked, whether the store
already has the blob, and the one window a bake key is even defined over are all
facts about the ENGINE — they were a `BakeCache.kt` in this shell once, and every
line of it was engine knowledge living in a shell, with a residency mirror the
shell had to invalidate whenever a destroyed surface took the renderer away.
Three shells re-deriving that is three chances to get it wrong, which is the same
argument `ttp_net.h`'s choreography walks make one layer down.

### The other thing a shell is tempted to cache: its own provisioning

Provided assets survive a `releaseScene`, so re-reading and re-handing the same
GLBs and textures on every build is pure re-work — and every shell does it. Log a
build split before deciding it is worth a memo, because **what that re-work costs
is entirely a fact about your storage**, and the two TV shells disagree by an
order of magnitude:

- **Android caches it.** An APK is compressed, so each build re-inflates every
  model and copies it across JNI into a map that already had it: measured on the
  box, 39 ms of provisioning on the first build and 8 ms once the memo holds.
- **tvOS does not.** An app bundle is not compressed and a re-read is barely a
  read: measured on the device, provisioning is ~5 ms of a ~215 ms build for the
  whole 15-asset set. A memo saving that is not worth mirroring engine state for.

The web is with tvOS here — its bytes are already in memory, and the copy into
the wasm heap does not show up in a profile.

**GENERATION IS THE INVALIDATION, and it is the one thing you supply.** Give it
something that changes whenever your binary could produce different bytes —
Android uses the APK's install time, deliberately NOT its versionName, because a
`-dirty` build keeps one version string across many edits. The engine folds it
into the name, so a new binary cannot name the old one's blob at all. Do not add
a second validity check beside it, and do not reuse a generation string across
builds.

Two traps that are Filament's, not any platform's, and will bite every shell
identically (both are commented where they bite, in `TtpRendererBakes.cpp`):

- A texture you `setImage` into must carry `Usage::UPLOADABLE`. Without it the
  driver can HANG with no panic and no log.
- `readPixels` and `setImage` disagree about Y on OpenGL — Filament's own header
  says so. A blob read one way and uploaded the other is upside down, which
  renders as a shadow that has moved to the wrong side of the circuit, not as
  anything that looks broken.

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
3. **The frame-cost readout, bound not written.** A shell hands
   `ttp_perf_sample` its own clocks, `ttp_display_profile`'s `total` and
   whatever GPU timer its backend has, declares what it is aiming at through
   `ttp_perf_pacing`, and draws `ttp_perf_readout_json`. It may not fold a
   percentile, count a drop or pick a colour: three shells that each did had
   already drifted apart while all three carried a comment saying they had not,
   and a bench comparing them is worth nothing if "60 fps" and "amber" are
   three different statements. `ttp_perf_reset` on a resize or a scene change —
   the readout carries the buffer size it was measured at.
   **FEED IT ON EVERY TICK, whether or not anything is drawing the readout.**
   The render scale folds off this same monitor, so a window kept only while a
   panel is up leaves the rule deciding a television's resolution off an empty
   ring the moment someone presses the toggle. Both TV shells had that bug, and
   it is what made them keep windows of their own. Gate the DRAWING and the
   per-phase profile read; never the sample.

   **THE PANEL ITSELF IS OFF UNTIL ASKED FOR, and the switch is a knob a
   developer can reach on the shipped build** — `?perf=1` or "P" on the web,
   `-ttpPerf 1` on tvOS, `setprop debug.ttp.perf 1` or `KEYCODE_INFO` on Android.
   Live in release, off by default: those are two decisions and only the first
   one is about being able to measure. A player gets no diagnostic block, and a
   shot rig has nothing to remember to hide.

   `intervalMs` is a TICK ("drawn or not"), so the readout's `frame` block is
   tick intervals and `present` is the gaps between the ticks that actually
   reached the panel. They are ONE series on a browser's rAF — a late present
   delays the next callback — and TWO on a display link or a Choreographer, which
   fire every vsync whatever the last frame did. That is why `hz` and `fps` are
   both on the line, and why the scale rule reads `present` while the panel
   period is learned off `frame`: on tvOS `frame.p95` is a flat vsync period
   however badly the box is skipping, and a shell steering off it never moves at
   all (measured: 4 players left at 40-55 fps, the rule never firing). Both
   series are folded in C++, so this is a property to understand rather than one
   to reimplement.

4. **Materials.** `native/scripts/build-materials.sh <matc> <outdir> [api] [platform]`,
   using the FORK'S matc. `opengl mobile` (the default) is what the web ships
   and what Android TV wants; tvOS needs `-a metal`. Every material the web
   shell lists (`render/Display.js`'s `MATERIALS`) is required for a correct
   picture, and only `vcolor` fails loudly — the rest degrade silently (no
   `vroad` quietly reverts every road decal to the lifted fallback meshes; no
   `voverlay` and the steer bar and dividers vanish). A shell loading from its
   own bundle should assert on every blob, not copy the web's `if (res.ok)`
   skip.
5. **The 2D UI**, in the platform's own toolkit, rendered from `ttp_ui.h`.
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
6. **Transport.** A WebSocket client, and optionally a WebRTC DataChannel. The
   fastlane is an enhancement by design (CONTROL falls back to the relay), so
   relay-only is a legitimate launch — though no shipped shell is one any more,
   and the transport half is small because the NETCODE is C++: `ttp_link_*` is
   the whole of it, and a shell that reads a `ps`/`pa`/`h` field has started a
   second one. Neither TV platform ships a system WebRTC, so both link a
   prebuilt libwebrtc (`LiveKitWebRTC` on tvOS, `io.github.webrtc-sdk:android`
   on Android — the same upstream build). `shells/tvos/.../Net/Fastlane.swift`
   and `shells/androidtv/.../Fastlane.kt` are the two ports to compare, pinned
   by `tests/tvos-fastlane.test.js` and `tests/androidtv-fastlane.test.js`.
   The framing and packet codecs are already C++, and so is the CHOREOGRAPHY:
   every inbound trigger (protocol frame, peer message, close, the liveness
   tick, a drained room event) is one call into
   `ttp_net.h`'s walk entry points, which mutate the room in C++ and answer an
   ordered effect list. What you write is the socket, three timers, a small
   storage read/write, and the effect switch that performs the ops — never the
   walk itself (`public/display/Net.js` `_performNetEffect` is the reference
   performer, and hand-writing the walk is where all six of the first shell's
   launch bugs lived). Drain the room's event queue before performing a walk's
   effects. When your shell gains a SEND path, add a case to
   `scripts/wire-mutations.mjs` — that was the suite's one historical blind
   spot.
7. **The audio device.** A player over the command stream. The cue palette is
   pre-baked (`public/assets/audio/cues/` — WAVs plus a manifest carrying each
   cue's detune spread; see `scripts/bake-cues.mjs` for why the jitter is the
   player's job), but the device is more than a sampler: the engine voice is a
   live passthrough (rate/gain steered per command) and the master-bus
   compressor is part of the mix contract. `public/display/Audio.js` and
   `shells/tvos/TinyTrackParty/Audio/AudioDevice.swift` are the two
   implementations to compare.
   **The MUTE is one state with two flippers**, and only one of them is yours.
   The host phone's Sound row sends SET_SOUND, which `ttp_net_controller_action`
   answers as `set-sound`: perform it by muting the device, persisting the flag
   and republishing — the snapshot's `soundOn` is what draws that switch, so a
   shell that omits the field leaves the phone showing a setting it cannot
   change, and one that ignores the verdict leaves the switch inert. Mute at the
   MASTER GAIN, ahead of the limiter, and silence the music player separately:
   it does not pass through the mix on any platform. The web's other flipper is
   a corner button, and that half stays web-only on purpose — a viewer cannot
   click a corner of a television (the same argument that puts the pause button
   on the remote), and a TV has its own mute.
8. **A QR encoder.** Settled in [shared-cpp-plan.md](shared-cpp-plan.md) (§QR):
   there is deliberately no C++ encoder, because the URL composition is shared
   and only the module bitmap is per-platform. `CIQRCodeGenerator` on tvOS,
   ZXing on Android, `public/shared/qr.js` in the browser — copy its policy (EC
   level L, a 1-module quiet zone), not its library. Every shell encodes
   locally: no display asks its own origin to draw its own join code.
9. **A base URL, and this shell's `cpp` value.** `session.h`'s `join_url` needs
   an origin serving the phone controller, and a native app has none of its own.
   The web deployment is therefore a runtime dependency of every TV app.
   `baseUrlOverride` is the existing seam. Pass your platform — `"tvos"` or
   `"androidtv"`, the fixed vocabulary `session.h` documents — to both `join_url`
   and `controller_url_template`: the join URL is the only place a display
   declares which box it is to the CouchPad launcher, and the two must agree
   because a player may arrive by either.
10. **A room advertisement, if you are native** (CouchPad CONTRACT §8). Publish
   `_couchpad._tcp` in `.local` at room create, withdraw it at close, with the
   TV's human label as the DNS-SD instance name and the room code as TXT `c` —
   nothing else, and never TXT `cpr`, which is a launcher-to-launcher marker. The
   launcher resolves the code through the relay, so this only accelerates a join
   it could already make: keep showing the QR and the code regardless. The web
   display cannot do this at all (browsers cannot advertise mDNS), which is why
   it has no counterpart here. `NWListener` on tvOS, `NsdManager` on Android,
   and the two things that make one silently useless are the same on both: the
   record must track JOINABILITY (down when the room is full, backgrounded or
   closed, not merely when the app dies), and the code must come from the net
   layer rather than the display field a screenshot harness writes fixtures
   into.
11. **Back navigation.** The TABLE crossed (`ttp_ui_back_effect`); the walk did
   not. popstate, the tvOS Menu button and Android's back stack are three
   different animals and the shell owns the traversal. The table reads the two
   race latches (`paused`, `raceEnded`) as well as the screen, and two of its
   answers do not navigate at all — a live race freezes, the pause overlay thaws
   — so a shell that only knows how to go UP a level is not done.
12. **Asset bytes for the renderer.** The renderer asks for names; the shell
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
13. **WHEN the scene is built.** A build blocks the thread long enough to be
    seen, and a cup's chained start (`advance`) performs `place-track` with the
    countdown already running — so a shell that meshes there shows the OUTGOING
    circuit under the count and then hitches. Mesh the next circuit when the
    intermission arms instead: the results board is opaque enough to hide the
    swap, and the field the launch will build is a pure function of the
    connected humans, so the prepared scene is the one it wants. The web
    reference is `prepareNextTrack()` in `public/display/main.js` plus
    `Stage.prepare`/`rebuild`, and `tests/e2e/cup-series.spec.js` pins it.
14. **Cell rects are FRACTIONS.** `ttp_display_cell_rects` answers 0..1 of the
    surface, and a shell multiplies by whatever it lays out in — CSS pixels,
    points, authored dp. Do NOT convert through the buffer size: it answered
    physical pixels once, and pairing a rect with a surface size the adaptive
    render scale moves underneath cost a bug on two of the three shells (tvOS
    placed its whole HUD off a stale `uiScale`; Android divided fresh rects by a
    width its UI framework could not see change). A fraction has no partner to
    disagree with.

15. **The operating point, measured.** Neither the buffer size nor the present
    rate is the panel's: a shell polls `ttp_display_scale_poll` every frame and
    takes back BOTH — a resolution and a present divisor, ordered around a
    desired 1080@60 (below it resolution gives way, above it the rate goes
    first). One call for the pair, because they are two ways of spending the
    same milliseconds and a shell honouring one and not the other would be
    arbitrating the trade itself.

    **THE STATE IS NOT YOURS EITHER.** The window, the percentiles, the running
    fastest present, the cost model's observation and the clocks the holds are
    judged against all live in `ttp/render_scale_controller.h`, folded off the
    same monitor item 3 describes. Three shells held that by hand once, in three
    languages, and two of them had drifted to a different percentile formula than
    the readout they were drawn beside. What a shell owes now is FOUR things:

    - `ttp_perf_sample` on every tick, per item 3 — which it already owed;
    - `ttp_display_scale_scene(tMs)` when a scene is built, plus `ttp_perf_reset`
      beside it;
    - `ttp_display_scale_poll(tMs, min, max, baseLines, panelMs)` every frame,
      and PERFORM what it answers. `min` is 0 — the LADDER owns the floor — `max`
      and `baseLines` are the surface's own, and `panelMs` is ONE VSYNC of the
      panel, or 0 where the platform has no honest answer (a browser) and it is
      learned off the tick series instead;
    - `ttp_perf_pacing(ttp_display_scale_panel_ms(), divisor)`, so the readout's
      budget is the operating point's.

    If you find yourself writing an `if` around a measurement before passing it,
    or holding a clock the rule could hold, it belongs in that header instead —
    which also carries the reasoning, including why a dropped-frame count is not
    a signal. Web reference: `Stage._adaptScale`, whose `_divisor` paces the
    PICTURE and never the sim.

    **OVERRIDING THE RATE? DECLARE A PERIOD, NOT A DIVISOR.** A sweep that pins a
    present rate (Android's `debug.ttp.hz`) is overriding half of a decision the
    rule made, so it must tell the rule what it actually presents at — `panelMs`
    times the pinned divisor — or the rule prices a 33 ms budget as 16.7 and
    shreds resolution to hold a rate nobody asked for. Android's
    `rulePanelMs` is the reference.

    **BOUND ON tvOS (`DisplayHost.adaptScale`).** Before it, an A10X ran 4
    players at 50-53 fps with no window of the run scoring anything but bad;
    after, the rule settles on the 1620 rung and holds 60/60 with no skips. What
    made the case was an A/B at fixed scales: the knee is ~0.85, and the ladder's
    existing rung below native (1620 = 3/4 on a 2160-line panel) sits inside it,
    so binding was the whole job and no constant moved.

    Two platform facts a reader needs, both measured on the box:

    - **NO GPU TERM BOUND, so the scale is a ONE-WAY RATCHET here — and that is
      FILAMENT'S limit, not Metal's.** `MetalTimerQueryFence` records
      `clock::now()` in a fence completion callback, so what it returns is host
      wall-clock between two callbacks; it tracks the present cadence (16.0 ms at
      one pass, 18.0 ms at four) and is passed as absent. The rule's fallback may
      then only step DOWN, so a scale lost to a bad stretch never comes back —
      measured at 1 player, which holds 60 at native but drops to 1620 off the
      scene-build frames and stays. Accepted for now: 60 fps at 3/4 beats a
      stutter at native.
      **The rule now refuses to spend that one mistake on a scene's ASSEMBLY**
      (`kScaleSceneGraceSec`): staging keeps costing after the build returns, and
      a solo race presented at 7-25 fps for ~2.6 s before settling. The guard is
      the FALLBACK's alone — an arm that can climb back out of a premature drop
      does not need it. Measured after: solo holds the panel's own resolution for
      a whole race and drops only on a genuine sustained slowdown, while 4
      players is still rescued to 60/60.
      **The hardware answers, probed on an A10X / tvOS 26.6:**
      `MTLCommandBuffer.gpuStartTime`/`gpuEndTime` gave 0.30 ms for a 4 MB blit
      over three stable runs, and `counterSets` carries "timestamp" with
      `supportsCounterSampling(.atStageBoundary)`. Filament already installs an
      `addCompletedHandler` in `getPendingCommandBuffer`, which is where the
      timestamps belong. A fork patch there unlocks the rule's climb branch on
      every Apple platform at once; nothing in the shell needs to change.
    - **Presents are their own series** — see the readout note in item 3 above.

16. **An attribution surface.** The build ships CC-BY music, OFL fonts and
    several notice-tier libraries, so a shell that shows nobody is in breach —
    this is an obligation, not an About page. What it owes is a reachable list
    of every credited work, and the license TEXT for the ones whose license
    demands the notice travel with the build. Do NOT type that list: bake it
    from `public/shared/credits.js` plus the live music catalogue (the same two
    modules /licenses.html renders), applying only the delta between what a
    browser ships and what your package does. **`scripts/shell-credits.mjs`
    already does all of that**: hand it your package's own third-party list and
    it answers the rows and the notice files to stage, so a third shell writes
    only its half of the delta and an output format. The two `gen-legal.mjs`
    beside it are the worked examples (a Swift bake for tvOS, a staged JSON asset
    for Android), and `tests/{tvos,androidtv}-legal.test.js` are the shape of gate
    that keeps a delta honest: the registry your platform declares dependencies
    in — `project.yml`'s packages block, `build.gradle.kts`'s dependencies block —
    is what a gate reads, so nothing can ship uncredited.
    **Every row on a TV must OPEN**, which is more than the web owes: there each
    licence chip is a link to the entry's terms, and a television can follow no
    link at all. Rows under a notice-tier licence open the notice; the rest open
    the licence's own text, one shared copy per id under `shells/licenses/`. The
    shared module resolves both and throws on a row with neither, so this costs a
    new shell nothing.
    Privacy and imprint are couchpad.games pages for every game on the launcher: link them, never restate them, and on a box with no
    browser show the URL as a QR for the phone already in the room. Read those
    two URLs out of the display's own footer rather than typing them.

## Still owed by the TV shells (audited 2026-08-18, re-checked 2026-08-22)

Each is a real item, not a simplification; the settled reasoning behind the two
look items is in `shells/androidtv/CLAUDE.md` (Look). The first is owed by BOTH
TV shells; the rest are Android's.

- **Meshing the next circuit at the intermission** (item 13) — NEITHER TV shell
  does it: a cup's chained start shows the outgoing circuit under the count and
  then hitches. The web reference is `prepareNextTrack()` plus `Stage.prepare`;
  there is no `prepare` call anywhere in either shell. On Android's GPU a build
  is seconds, which makes it the most visible item here.
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
nothing about a shell. Three gates exist for the boundary a shell actually sits
on, and a new platform should extend them rather than inventing a fourth:

- `native/runtimetest/abi_check.cc` — every ABI, every leg, including the
  handle-taking exports whose only statement of correctness is that they agree
  with the JSON path (`handlePathsMatchJsonPaths`). Add a case for every
  handle-taking export you add.
- `tests/wire-compat.test.js` + `tests/wire-fastlane.test.js` — the only place
  two LANGUAGES agree on bytes at runtime. Phones stay on the JS controller on
  all three TV platforms, so this suite is permanent and your sender belongs
  in it. Note what it does NOT see: it drives the WEB display, so the lobby
  frame's schema is pinned for one shell only.
- `tests/shell-parity.test.js` — the three agreements that fail silently and
  that no compiler checks: a declared performer table that has stopped matching
  its own switch, a controller verdict the web acts on and a TV shell drops into
  its default arm, and a fact the web puts on the lobby snapshot that a TV shell
  omits (absent is a legal value, so the phone just shows the setting off). A
  fourth shell adds its files to the tables at the top.

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
