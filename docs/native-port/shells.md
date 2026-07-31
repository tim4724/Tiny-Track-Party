# Writing a shell

What a second or third platform actually owes, audited against the tree on
2026-07-29 rather than planned in advance. [architecture.md](architecture.md)
says what a shell IS ("a shell may only contain code that names a platform
API"); this says what that leaves you holding, and which parts are a decision
rather than a task.

Nothing here is Android- or tvOS-specific work. It is the state of the base.

## What you get for free

Every one of these is C++ behind a C ABI, conformance-gated on four legs
(linux, macOS, wasm, tvOS-sim), and needs no port:

| You do NOT write | It is | Reached through |
|---|---|---|
| Physics, AI, items, ranking, race lifecycle | `libttp-sim` | `ttp_runtime.h` |
| Track geometry, sampling, schematic projection | `libttp-track` | `ttp_runtime.h` (`ttp_track_*`) |
| Room state, relay framing, fastlane codec, session policy AND its choreography (the net effect lists) | `libttp-party` + the ABI shim | `ttp_party.h`, `ttp_net.h` |
| Cameras, cell layout, fog, the per-frame builder | `libttp-runtime` | `ttp_display.h` |
| Race orchestration (the effect lists) | `libttp-runtime` | `ttp_race.h` |
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
   file deletes its copies. The platform-free half below both is in
   `libttp-runtime` and must stay there. If a line names no platform API, it
   is in the wrong file.
2. **A module target.** Add it beside `ttp_runtime_web` in
   `native/CMakeLists.txt` and compile `${TTP_APP_SOURCES}` plus
   `runtime/ttp_display_core.cc` plus your surface file. Do not retype the
   list; it is a variable precisely because a second copy drifts on the first
   ABI added and fails as a link error on one platform only.
3. **Materials.** `native/scripts/build-materials.sh <matc> <outdir> [api] [platform]`,
   using the FORK'S matc. `opengl mobile` (the default) is what the web ships
   and what Android TV wants; tvOS needs `-a metal`.
4. **The 2D UI**, in the platform's own toolkit, rendered from `ttp_ui.h`.
   Sizing: `public/display/main.js` (1755 lines) + `lobbySeats.js` + roughly
   1165 lines of CSS, of which the decisions are already gone. Consume
   `public/shared/design-tokens.json` rather than re-authoring the sticker
   palette.
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
6. **The audio device.** A sample player over the command stream. There is no
   DSP to port: `public/assets/audio/cues/` holds 28 pre-baked WAVs plus a
   manifest carrying each cue's detune spread (see `scripts/bake-cues.mjs` for
   why the jitter is the player's job).
7. **A QR encoder.** Settled in [shared-cpp-plan.md](shared-cpp-plan.md) (§QR):
   there is deliberately no C++ encoder, because the URL composition is shared
   and only the module bitmap is per-platform. `CIQRCodeGenerator` on tvOS,
   ZXing on Android. The web shell gets its matrix from the server's `/api/qr`;
   a TV app should encode locally.
8. **A base URL.** `session.h`'s `join_url` needs an origin serving the phone
   controller, and a native app has none of its own. The web deployment is
   therefore a runtime dependency of every TV app. `baseUrlOverride` is the
   existing seam.
9. **Back navigation.** The TABLE crossed (`ttp_ui_back_effect`); the walk did
   not. popstate, the tvOS Menu button and Android's back stack are three
   different animals and the shell owns the traversal.

## The asymmetries worth knowing before you start

- **C interop is not equal across platforms.** Swift consumes a C header
  directly; JS gets `cwrap`. Kotlin gets neither, and the web shell touches
  **182 distinct `ttp_*` symbols**, so a JVM shell needs either a generated JNI
  bridge or a C++ "performer" that keeps the JNI surface small. That is a
  design decision, not an implementation detail, and it should be made before
  any Kotlin is written. `architecture.md`'s "three thin wrappers" is true of
  Swift and JS and understates the JVM case.
- **Constants: read them, do not copy them.** `ttp_protocol_manifest_json()`
  hands over the car tables, the wire vocabulary, the STEER contract and the
  LIVENESS windows as one JSON object. A C++ layer can include
  `ttp/protocol.h` instead. Nothing else is a legitimate source, and
  `tests/config-drift.test.js` pins the export to `public/shared/protocol.js`.
- **Asset delivery is unsolved.** `public/assets/` is ~170 MB, 164 MB of it
  race music. The web streams it off an origin; a store build needs an asset
  pack, a download-on-first-run, or a smaller shipped pool. Nobody has decided
  which, and `ttp_audio_song_json`'s index has to resolve to whatever you pick.
- **Only three legs execute the fixtures.** The Android NDK leg in
  `.github/workflows/native.yml` compiles and does not run. `fp-profile.md`
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
the other. The six, as a checklist for the next shell:

1. **Read the documented key, not the one that reads well.**
   `ttp_race_start_json` answers `{"action":"launch"}` — a `launch` key does not
   exist, and `verdict["launch"] as? Bool` is nil on every answer there has
   ever been, so the guard rejected every start.
2. **Some answers are a VERDICT, not a plan.** A start carries no `effects`;
   the shell must then stand up the series and call `ttp_race_launch_json`
   itself. `ttp_race_advance_json`'s header says "the shell runs
   ttp_race_launch_json next" and means it literally.
3. **Index-returning exports must be resolved against your own array.**
   `ttp_ui_connected_players_json` and `ttp_ui_reconnect_diff_json` answer with
   INDICES. Passing them on as `players` launches a race for a field of bare
   numbers.
4. **Three sim events are LIFECYCLE and have their own entry points.**
   `_countdown` → `ttp_race_countdown_tick_json`, `_raceStart` →
   `ttp_race_start_beat_json`, `_raceEnd` → your end-of-race path. Feed them to
   `ttp_race_event_json` (which filters ORDINARY events) and they vanish: the
   countdown never beats and the room sits in COUNTDOWN forever.
5. **Bitmask parameters are PRESENCE, not value.** `ttp_process_input`'s mask is
   derived by you from which fields arrived; the wire carries none.
6. **Go through the seam, not around it.** `PartyNet.allParticipantsDisconnected`
   exists because it syncs the active order BEFORE asking. Calling
   `ttp_room_all_participants_disconnected` directly answers off a stale set.

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
and no corpus, screenshot or unit test found any of them. That harness lands
with the first TV shell (`scripts/lib/phone.mjs` is the platform-free half); a
new shell should point it at itself before it trusts anything else.

**And a screenshot harness must not bypass the real entry points.** The first
shell's shots reached `ttp_race_launch_json` directly, so fifteen race screens
photographed perfectly for a build whose Start button had never worked once. A
harness may fabricate its INPUTS; it must not own a second copy of the road.
