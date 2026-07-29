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
| Room state, relay framing, fastlane codec, session policy | `libttp-party` | `ttp_party.h`, `ttp_net.h` |
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

1. **The surface + shell file.** A sibling of
   `native/runtime/ttp_display_web.cc` (374 lines): the platform's
   GL/Metal/Vulkan surface, the `TtpRenderer` singleton, and the same
   `extern "C"` bodies. The
   platform-free half is already in `libttp-runtime` and must stay there. If a
   line names no platform API, it is in the wrong file.
2. **A module target.** Add it beside `ttp_runtime_web` in
   `native/CMakeLists.txt` and compile `${TTP_APP_SOURCES}` plus your shell
   file. Do not retype that list; it is a variable precisely because a second
   copy drifts on the first ABI added and fails as a link error on one platform
   only.
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
   C++; what you write is the socket. When your shell gains a SEND path, add a
   case to `scripts/wire-mutations.mjs` — that was the suite's one historical
   blind spot.
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
