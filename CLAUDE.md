# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                          # Unit tests (node:test) — track, ABI, partyplug
node --test tests/track.test.js   # A single unit test
ctest --test-dir native/build     # Native conformance (configure/build native/ first)
npm run test:e2e                  # Playwright E2E (real pages + hermetic relay stub)
npx playwright test tests/e2e/flow.spec.js  # A single E2E spec
npm start                         # Run the server (node server/index.js)
npm run dev                       # Run with --watch (auto-restart)
native/scripts/build-runtime-web.sh  # The whole engine (sim + party + Filament
                                  # renderer) → public/display/engine/native/. Needs the
                                  # Filament fork at ~/Projects/filament + emsdk; both are
                                  # auto-built/installed on first run.
```

E2E (`tests/e2e/`) drives real display + controller pages against a local
Party-Server stub (`tests/e2e/relay-server.js`) via the server's `RELAY_URL`
env, injected into each page as the `relay-url` `<meta>` (read by
`shared/protocol.js`) — no dependency on the production relay. Import `test`/
`expect` from `tests/e2e/helpers.js` (it reaps leaked phone contexts). The
suite needs `npx playwright install chromium` once. `/gallery.html` is a manual
no-relay preview surface (driven by the per-page TestHarness via `?scenario=…`).

## Key Rules

- The sim is display-authoritative: the car simulation runs in the browser (as wasm — see the NATIVE rule below), not the server. `server/index.js` serves static files + JSON endpoints only — no game logic, no WebSocket.
- Browser code is ES modules. The survivors Node tests import directly via dynamic `import()` (`TrackBuilder.js`, `Centerline.js`, `engine/Vec3.js`, `engine/math.js`) must stay dependency-free so they load in both browser and Node.
- CSP headers in `server/index.js` — update when adding external resources. There is no nonce and no inline script: every script is a same-origin file, so `script-src` is `'self' 'wasm-unsafe-eval'`.
- Relay/STUN URLs and the message vocabulary live in `public/shared/protocol.js` (game-side config, injected into the partyplug kit at construction — the kit reads no game globals).
- Game events (display → relay → controllers) flow over the WebSocket relay. Controller input (`CONTROL`) rides the low-latency WebRTC fastlane (`partyplug/PartyFastlane.js`, signalled over the relay) when its DataChannel is open, and falls back to the relay otherwise. The wiring lives in `public/shared/GameNet.js` (`_initFastlane`/`_isSignal`) with `display/Net.js` opening it as the input sink and `controller/Net.js` enqueuing over it; `protocol.js` provides `STUN_URL` and `FASTLANE_TYPES = { control: true }`. The lobby roster (`LOBBY_UPDATE`) is not a fanout: the display publishes it as the relay's retained host snapshot (`PartyConnection.setState`), pushed live to controllers (`onState`) and replayed to each (re)joiner right after `joined`.
- Disconnects: the relay fires `peer_left` only on a real socket close. The display additionally runs 1 Hz liveness (phones ping at 1 Hz; a seat silent past 3 s is dropped mid-game, same path as `peer_left`, any traffic restores it) — detection is RoomFlow's nowMs-injected `liveness` engine (`onSeen`/`expiredPeers`), while `display/Net.js` owns the tick and the relay self-heartbeat that forces a reconnect when the display's own socket is half-dead.
- Room teardown: when the room itself dies (host `close_room`, or the relay's ~2 min hostless grace after the display vanishes) the relay closes every member socket with 4001 → `onClose {roomClosed}`, which is TERMINAL (no auto-reconnect). Controllers bail to a party-over overlay (`room_closed` status). The display tab exiting IS the party ending: pagehide fires `DisplayNet.shutdown()` (close_room + close, self-heal suppressed) — including on a reload, which therefore boots into a fresh room. The sessionStorage room rejoin remains as CRASH recovery only (no pagehide → room survives → the reloaded display regathers the party). `DisplayNet.closeRoom()` (with fresh-room self-heal + roster clear) is the "End party" API — fired by the display's back-stack (`endParty` in `display/main.js`).
- Display boot lands on the welcome board (`#welcome`): the room warms eagerly behind it (net.start() at boot, gated only on the device chooser), and NEW GAME reveals the lobby while carrying the user-gesture unlocks (fullscreen + AudioContext). Browser back walks `SCREEN_ORDER` (race → lobby → welcome): back from a race is the usual full reset, back from the lobby ends the party and warms a fresh room behind the title board. Test/gallery/solo surfaces bypass the welcome and push no history.
- PartyPlug (`partyplug/`) is the reusable party-game framework (transport layer) shared across games, served under `/partyplug/`.
- 3D assets are the Kenney Toy Car Kit under `public/assets/toycar/` — the `toycar` path names the asset pack, not the game.
- UI is the "Sticker Bash" theme: die-cut stickers on the TV glass — flat colour on warm paper, thick warm-ink (`#2A2735`, never `#000`) outlines, hard zero-blur offset shadows, slight rotations. Chrome colours are red/green/blue/purple ONLY (yellow/amber + pink are vetoed in chrome — liveries only; celebration is RED). Design tokens + reusable bits (`.card .btn .chip .pill .field`, the `.wordmark` badge, the `.scene` paper stage) live in `public/shared/theme.css`, `<link>`ed by both display and controller before their page CSS. Build new UI from those tokens/classes — page CSS owns layout, the theme owns colour/type/surface. Never outline/toon-shade anything inside the 3D scene; paper backgrounds only on full-screen boards (chrome floats bare over the live 3D view). Fonts (Fredoka, Nunito) are self-hosted variable woff2 under `public/assets/fonts/` (SIL OFL) so the CSP keeps `font-src 'self'`.
- The engine is NATIVE. The sim, the cup-series layer, and the party layer's
  decisions (room state, relay framing, fastlane netcode) all run as C++ compiled
  to WASM (`native/`, loaded via `public/display/engine/native/ttp_runtime.mjs`
  through the adapters `Native{RaceSession,CupSeries,RoomFlow,PartyConnection,
  PartyFastlane}.js`). There is NO JS engine and NO fallback: `main.js` awaits the
  wasm at boot and a load failure is fatal. The JS twins were deleted once every
  layer was conformance-proven; git history has them.
- Rendering is NATIVE too, in the SAME wasm module as the sim. `native/renderer/`
  (libttp-renderer, Filament) links into `ttp_runtime_web` alongside libttp-sim and
  libttp-party, and `native/runtime/ttp_display.{h,cc}` drives it: per frame the
  shell calls `ttp_display_frame(dt)` and C++ reads the live `Game` to build the
  renderer's input in place. NOTHING about a car — pose, speed, steer, which cell
  it owns — is ever serialized to JS and handed back. Cameras (the spring chase
  per cell, the lobby/gallery overview rigs) and the fog profiles live there too.
  `public/display/render/Display.js` is the browser's whole edge of it, and
  `Stage.js` owns the canvas, the DOM HUD and the rAF loop. Three.js is GONE
  (git history has it); it survives only as a TEST-ONLY devDependency, as the
  bit-identity reference for `engine/Vec3.js` in `tests/vec3.test.js`.
- Still JS BY DESIGN: the HUD/screens (`main.js`, `Stage.js`), track geometry for
  the renderer's scene build (`TrackBuilder.js` + `Centerline.js` → `trackBin.js`,
  once per race, never per frame), the resolved biome theme
  (`shared/themes.js` → `render/trackPayload.js`), audio, the whole controller
  page, and the transport I/O — the WebSocket and `RTCPeerConnection` live in
  `partyplug/PartyConnection.js` and `PartyFastlane.js`, which SURVIVE: the native
  fastlane SUBCLASSES the kit class to inherit its WebRTC handshake, and the
  controller uses both directly.
- Conformance is the frozen corpora + golden traces under `tests/fixtures/`,
  replayed by `native/` ctest (33 tests, the SAME 33 on every leg —
  linux/macOS/wasm/tvOS-sim — because each leg just runs `ctest`; the tvOS leg
  drives the simulator through the `CMAKE_CROSSCOMPILING_EMULATOR` shim
  `native/scripts/tvos-sim-spawn.sh`, exactly as the wasm leg runs under node).
  They are permanent cross-implementation evidence recorded against the JS engine
  while it existed — never re-record them from C++, which would only prove C++
  matches itself. `scripts/gen-*-corpus.mjs` are the oracle generators;
  `gen-roomflow-corpus.mjs` (36 room scenarios) and `gen-grandprix-corpus.mjs`
  (12 cup scripts + 5 shuffle-bag cases) are FROZEN — their JS twins are gone, and
  each header names the `git show` that restores one if the oracle must be
  re-derived.
- TWO CLASSES OF FIXTURE, and only one settles parity questions. JS-recorded
  (the 8 traces + every `gen-*-corpus` file) is cross-implementation evidence.
  C++-AUTHORED (`replay_cli --record <header>`, `catalogue_sweep_check --record`)
  is regression evidence only: it proves the sim still does what it did, never that
  the port was right. Both re-record via a `record_*` ctest holding byte identity.
  See `tests/fixtures/traces/README.md`.
- Traces are ONE RACE PER PROCESS, so they cannot see state that leaks from one
  race into the next (a racing-line cache keyed by a recycled `Centerline*` made
  bots drive the previous track's line — invisible to all 8 fixtures). Three gates
  cover that blind spot: `race_isolation` forces the address collision with
  placement new, `catalogue_sweep` races all 20 tracks and then re-races them in
  REVERSE order demanding identical digests, and `replay_sequence` replays every
  trace in one process. When adding cross-race state, own it per `Game`.
- Traces also only ever race CATALOGUE tracks, so anything no shipped layout
  contains is unreachable by any fixture: no track builds with a pole (the JS
  TrackBuilder agrees), which is why `Game::collidePole` is covered by
  `hazard_check` constructing the situation directly rather than by a trace.
- The C ABI (`runtime/`) is NOT on the replay path — `replay_cli` calls C++ objects
  directly. `abi_check` covers the marshalling layer the browser actually talks to,
  BOTH ABIs: two traces through `ttp_process_input`/`ttp_update`, the cup corpus
  through `ttp_gp_*`, the room and framing corpora through `ttp_room_*`/
  `ttp_framing_*`, a fastlane plumbing pass, and every boundary/mutation export
  against its header contract. It recompiles `runtime/*.cc` rather than linking a
  lib, so the shipped wasm's `EMSCRIPTEN_KEEPALIVE` export list is untouched.
  `tests/party-abi.test.js` still covers the same ground in Node against the SHIPPED
  wasm, which is the only place that artifact is exercised.
- Two checks audit the SUITE, not the code, and run weekly + on demand
  (`.github/workflows/test-the-tests.yml`), never on PRs: `npm run mutation-check`
  breaks the engine 21 ways and requires the matching ctest to go red for each (two
  gates were found blind this way), and `npm run revive:js-oracle` restores the
  retired JS sim from git and re-records all 8 golden traces byte-identically. While
  the latter passes, parity evidence is renewable; when it starts failing, decide
  consciously whether to repair the twin or accept that the traces are frozen.
- Our own C/C++ carries `-Wall -Wextra` via the `ttp_warnings` interface;
  the vendored fdlibm/double-conversion deliberately do NOT (they are taken whole
  from upstream). Not `-Werror` — a newer compiler's new diagnostic must not block a
  build.
- `public/display/engine/native/ttp_runtime.{mjs,wasm}` plus the `*.filamat`
  blobs beside them are CHECKED IN and are what the browser actually runs. After
  touching `native/`, run `native/scripts/build-runtime-web.sh` and commit the
  artifacts — `tests/native-artifact.test.js` compares BUILD_STAMP.json's source
  hash and fails when they drift (comment-only edits under `native/` count). The
  wasm exports come from `TTP_ABI` (EMSCRIPTEN_KEEPALIVE) on each declaration in
  `ttp_runtime.h`/`ttp_party.h`/`ttp_display.h`; there is no export list to
  maintain. Building needs the Filament fork, which CI does not have: CMake only
  adds the renderer when `-DFILAMENT_SDK` is passed, so CI's wasm leg still
  link-checks the browser ABI against a sim-only build of the same target.
- Balance/tuning: `npm run probe:cars` / `probe:laptime` / `probe:difficulty` build
  and run `native/build/probe_cli` (modes laptime|matrix|packed;
  `laptime --json` feeds `scripts/probe-difficulty.mjs`, the per-track report card). The old JS probes drove
  the AI with no game context and unseeded items, so their numbers were wrong —
  do not compare against pre-2026-07-25 readings. The probe is a tuning instrument,
  not a gate, but the `probe_smoke` ctest keeps it from rotting (a row per catalogue
  track, every lap time plausible) — it is what surfaced the racing-line bug, as lap
  times that moved between identical sweeps.
- Frame cost: `render/PerfHud.js` is ON by default during development (the "P"
  key hides it) — REAL GPU ms per frame from a `EXT_disjoint_timer_query_webgl2`
  query wrapped around `ttp_display_frame`, next to the CPU total from
  `ttp_display_profile` and the dropped-vsync count. It instruments nothing while
  hidden, so switching it off for release is one line (the `show()` in its
  constructor); `window.__perf` (`show()`/`hide()`/`sample()`) is the live and
  scripted-sweep surface. Do NOT reach for
  Filament's `Renderer::getFrameInfoHistory()` for the GPU number: on emscripten
  the backend's timer-query path is compiled out and `canCreateFence()` is false,
  so `gpuFrameDuration` is CPU submit time wearing a GPU label. A
  `fenceSync`/`clientWaitSync` poll is worse (9.6 ms measured against a real
  3.4 ms frame — it times `setTimeout` clamping). The rAF cadence alone measures
  neither: it is a vsync plateau, so it can only ever show DROPS.
- Preview deploys: every push builds and deploys to `https://tinytrack-<branch>.couch-games.com` (see `.github/workflows/preview.yml`).
