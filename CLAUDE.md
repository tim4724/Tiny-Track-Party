# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                          # Unit tests (node:test) — track, ABI, partyplug
node --test tests/track.test.js   # A single unit test
ctest --test-dir native/build     # Native conformance (configure/build native/ first)
npm run test:e2e                  # Playwright E2E (real pages + hermetic relay stub)
npx playwright test tests/e2e/flow.spec.js  # A single E2E spec
node --test tests/wire-*.test.js  # Wire-compat only (C++ host vs the JS phone)
node scripts/wire-mutate.mjs      # Prove the wire gate bites: break the C++ 5 ways,
                                  # rebuild the wasm, require the named test to go red
node scripts/wire-relay-contract.mjs  # Re-freeze the relay model's contract from a
                                  # Party-Sockets checkout (--check to just verify)
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
- Browser code is ES modules. Modules Node imports directly via dynamic `import()` (`shared/tracks.js`, `shared/devTracks.js`, `shared/protocol.js`, `engine/contract.js`) must stay dependency-free so they load in both browser and Node.
- CSP headers in `server/index.js` — update when adding external resources. There is no nonce and no inline script: every script is a same-origin file, so `script-src` is `'self' 'wasm-unsafe-eval'`.
- Relay/STUN URLs and the message vocabulary live in `public/shared/protocol.js` (game-side config, injected into the partyplug kit at construction — the kit reads no game globals). It is also the MANIFEST for numbers two layers share: `CAR_STATS`, and `STEER` (the tilt→steer contract: `EXPO` in the C++ sim, `ROLL_LOCK_DEG`/`DEADZONE`/`SMOOTH` on the phone, `GATE_THRESHOLD` on the wire). Nothing may re-declare a manifest number silently — `tests/config-drift.test.js` pins `TiltInput`/`InputGate` to it, re-runs InputGate's dead-band derivation over it and reads `EXPO` back out of the shipped wasm; the protocol corpus + `protocol` ctest carry it to `native/libttp-party/ttp/protocol.h`, and that check also asserts `getSteerExpo()` equals it, which is what binds `game.cc`.
- Design tokens are DATA as well as CSS. `public/shared/theme.css`'s `:root` stays the authored source (comments and all); `scripts/gen-design-tokens.mjs` bakes it to `public/shared/design-tokens.json` — typed, aliases resolved — for the TV shells architecture.md accepts a second/third implementation of the sticker look for. `tests/codegen-freshness.test.js` keeps the bake current, `tests/design-tokens.test.js` proves it faithful (independent scrape) and enforces two rules the CSS can only state in prose: `--btn-sink < --btn-drop`, and chrome roles resolving to chrome colours only.
- Game events (display → relay → controllers) flow over the WebSocket relay. Controller input (`CONTROL`) rides the low-latency WebRTC fastlane (`partyplug/PartyFastlane.js`, signalled over the relay) when its DataChannel is open, and falls back to the relay otherwise. The wiring lives in `public/shared/GameNet.js` (`_initFastlane`/`_isSignal`) with `display/Net.js` opening it as the input sink and `controller/Net.js` enqueuing over it; `protocol.js` provides `STUN_URL` and `FASTLANE_TYPES = { control: true }`. The lobby roster (`LOBBY_UPDATE`) is not a fanout: the display publishes it as the relay's retained host snapshot (`PartyConnection.setState`), pushed live to controllers (`onState`) and replayed to each (re)joiner right after `joined`.
- Disconnects: the relay fires `peer_left` only on a real socket close. The display additionally runs 1 Hz liveness (phones ping at 1 Hz; a seat silent past 3 s is dropped mid-game, same path as `peer_left`, any traffic restores it) — detection is RoomFlow's nowMs-injected `liveness` engine (`onSeen`/`expiredPeers`), while `display/Net.js` owns the tick and the relay self-heartbeat that forces a reconnect when the display's own socket is half-dead. The ABANDONED-RACE policy rides that same tick and is also RoomFlow's (`graceTick` — every participant gone while someone waits, arm `graceMs`, fire once; `display/Net.js` polls it and reports `onRaceAbandoned`). Its participant set is C++ too and is derived from the LIVE RACE: `ttp_room_sync_active_order(roomHandle, sessionHandle)` (`RoomFlow::syncActiveOrder`) reads the session's cars through the `ttp_session.h` seam and keeps "every seat holding a car, plus every dropped seat" — a shell passes a session handle and nothing else, and no car id is ever serialized out and handed back. What falls outside that set — `hasLateJoiners`/`lateJoiners` — is exactly a connected, car-less seat: one definition behind the policy, the standings' `joining` rows AND the display's silent auto-pause (`net.allParticipantsDisconnected()`, never re-counted in JS). Syncing it is load-bearing: the kit's own COUNTDOWN snapshot would count a DROPPED late joiner as someone waiting and yank a blipped party's race back to the lobby. That unfiltered kit semantics is pinned by the frozen corpus (adding a connected filter to `hasLateJoiners` turns `roomflow` red) — fix the SET, never the C++.
- Room teardown: when the room itself dies (host `close_room`, or the relay's ~2 min hostless grace after the display vanishes) the relay closes every member socket with 4001 → `onClose {roomClosed}`, which is TERMINAL (no auto-reconnect). Controllers bail to a party-over overlay (`room_closed` status). The display tab exiting IS the party ending: pagehide fires `DisplayNet.shutdown()` (close_room + close, self-heal suppressed) — including on a reload, which therefore boots into a fresh room. The sessionStorage room rejoin remains as CRASH recovery only (no pagehide → room survives → the reloaded display regathers the party). `DisplayNet.closeRoom()` (with fresh-room self-heal + roster clear) is the "End party" API — fired by the display's back-stack (`endParty` in `display/main.js`).
- Display boot lands on the welcome board (`#welcome`): the room warms eagerly behind it (net.start() at boot, gated only on the device chooser), and NEW GAME reveals the lobby while carrying the user-gesture unlocks (fullscreen + AudioContext). Browser back walks `SCREEN_ORDER` (race → lobby → welcome): back from a race is the usual full reset, back from the lobby ends the party and warms a fresh room behind the title board. Test/gallery/solo surfaces bypass the welcome and push no history.
- PartyPlug (`partyplug/`) is the reusable party-game framework (transport layer) shared across games, served under `/partyplug/`.
- 3D assets are the Kenney Toy Car Kit under `public/assets/toycar/` — the `toycar` path names the asset pack, not the game.
- UI is the "Sticker Bash" theme (two cell-anchored, textless pieces of it — the
  steer bar and the split-screen dividers — are drawn by the RENDERER, not CSS;
  see the NATIVE rendering rule below): die-cut stickers on the TV glass — flat colour on warm paper, thick warm-ink (`#2A2735`, never `#000`) outlines, hard zero-blur offset shadows, slight rotations. Chrome colours are red/green/blue/purple ONLY (yellow/amber + pink are vetoed in chrome — liveries only; celebration is RED). Design tokens + reusable bits (`.card .btn .chip .pill .field`, the `.wordmark` badge, the `.scene` paper stage) live in `public/shared/theme.css`, `<link>`ed by both display and controller before their page CSS. Build new UI from those tokens/classes — page CSS owns layout, the theme owns colour/type/surface. Never outline/toon-shade anything inside the 3D scene; paper backgrounds only on full-screen boards (chrome floats bare over the live 3D view). Fonts (Fredoka, Nunito) are self-hosted variable woff2 under `public/assets/fonts/` (SIL OFL) so the CSP keeps `font-src 'self'`.
- The engine is NATIVE. The sim, the cup-series layer, and the party layer's
  decisions (room state, relay framing, fastlane netcode) all run as C++ compiled
  to WASM (`native/`, loaded via `public/display/engine/native/ttp_runtime.mjs`
  through the adapters `Native{RaceSession,CupSeries,RoomFlow,PartyConnection,
  PartyFastlane}.js`). There is NO JS engine and NO fallback: `main.js` awaits the
  wasm at boot and a load failure is fatal. The JS twins were deleted once every
  layer was conformance-proven; git history has them.
- Rendering is NATIVE too, in the SAME wasm module as the sim. `native/renderer/`
  (libttp-renderer, Filament) links into `ttp_runtime_web` alongside libttp-sim and
  libttp-party, and `native/runtime/ttp_display.h` is the ABI that drives it: per
  frame the shell calls `ttp_display_frame(dt)` and C++ reads the live `Game` to
  build the renderer's input in place. NOTHING about a car — pose, speed, steer,
  which cell it owns — is ever serialized to JS and handed back. That ABI has TWO
  implementations behind it, and the split is load-bearing: `native/libttp-runtime/`
  holds everything platform-free (the spring chase per cell, the lobby/gallery
  overview rigs, the fog profiles, the per-frame `TtpFrameInput` builder) and is
  compiled AND EXECUTED on every leg by two ctests — `runtime_check` replays the
  quantized camera/framing/grid corpus, `frame_check` drives the frame builder
  (roster-slot identity, cell cameras, the hold, the banana/rocket/burst arrays)
  and carries the one static_assert binding `TTP_CAM_*` to the library's enum.
  Anything that must not drift silently belongs in one of those two, NOT in the
  shim: `runtime/ttp_display_web.cc` is the WEB
  shell — the emscripten WebGL2 surface and the TtpRenderer calls, nothing else —
  and needs the Filament SDK, so it compiles on one machine configuration and no
  ctest sees it. tvOS/Android get siblings of that file, not of the library. If a
  line names no platform API it belongs in libttp-runtime.
  TWO HUD elements are drawn here rather than by a shell, and the line that
  admits them is exact: CELL-ANCHORED AND TEXTLESS goes to the renderer,
  anything carrying type or sticker chrome stays in the shell. That is the steer
  bar and the cell dividers (`materials/voverlay.mat`, `TtpRenderer::drawOverlay`,
  `TtpCellHudInput`) — a rounded rect with a translating fill needs none of the
  UI toolkit the HUD exists for, and both are pinned to a cell whose geometry is
  already C++. It keeps OUT the place/lap ordinal, the name chip, the item slot,
  the FINISHED card and the reconnect QR. Moving them also made the whole
  remaining HUD a ~6 Hz poll: nothing in the DOM is written per frame. They are
  the only thing the C side is ever told a UI SCALE for
  (`ttp_display_ui_scale`) — their sizes are authored in CSS pixels, everything
  else stays in the surface's physical ones — and the only place `--ink` /
  `--surface` are written down twice (`TTP_HUD_*` in `ttp_render.h`, held to the
  tokens by `tests/design-tokens.test.js`).
  `public/display/render/Display.js` is the browser's whole edge of it, and
  `Stage.js` owns the canvas, the DOM HUD and the rAF loop. Three.js is GONE
  (git history has it); it survives only as a TEST-ONLY devDependency, used by the
  offline capture scripts (`scripts/lib/three-routes.js` serves it to a Playwright
  page for the car thumbnails and item icons).
- The TRACK BUILDER is native too, and there is no JS twin. `ttp_display_build`
  takes a trackId and runs `ttp::build_race_track` itself, so the renderer meshes
  from the SAME `ttp::RaceTrack` the sim races on; the browser holds no centerline,
  no samples, no furniture. `public/shared/trackBin.js` is down to the roster's
  liveries (track.bin v17 — no geometry, no theme), and the lobby's
  mini-maps come from the prebaked `shared/trackSchematics.js` (`npm run
  gen:schematics`). Node reads geometry through `scripts/native-track.mjs` over the
  shipped wasm — `ttp_track_json` (by id), `ttp_track_build_json` (by descriptor,
  for unshipped candidates), `ttp_track_sweep_json`/`ttp_track_frames_json`
  (interpolated frames) and `ttp_track_supports_json` (the builder's own
  corridor gate, for the geometry audit).
- The BIOME PALETTE is native too. Six biomes of sky/fog/light rig/road/scenery/
  air/furniture live in `native/libttp-runtime/ttp/theme.{h,cc}`, resolved inside
  `ttp_display_build` from the track's own cup (`gen-track-defs-header.mjs` carries
  each track's `cup` into `track_defs.h`), with `ttp_display_biome` for the
  `?biome=` override. NO COLOUR OF IT crosses back: `public/shared/biomes.js` is
  the browser's whole edge (`native/runtime/ttp_theme.h`) and hands out only the
  biome NAME (the music pool key, the `?biome=` list), the scenery GLB list to
  fetch, and two colours for the two 2D widgets the renderer does not draw — the
  HUD boost chip's stroke and the music gallery's swatch. Wanting a third getter
  means the look is being rebuilt in the DOM; put it in the renderer instead.
- AUDIO IS TWO HALVES, and only one of them is going native. The DECISIONS —
  which cue, at what gain, which sustained voice at what level, the `audibility()`
  distance curve, the shared curb-scrub throttle, the rocket jet lifecycle, the
  music pool + no-repeat shuffle + per-song LUFS trim — are a pure layer over
  plain data returning a stream of COMMANDS, with the clock passed per call and
  the RNG injected. The DEVICE half (`Audio.js`) performs those commands and
  decides nothing: AudioContext, limiter, the gallery's variant picks, the
  `<audio>` element; `main.js` only ever calls `sfx(audioDecide.…)`. The DSP
  palette stays BAKED rather than ported, because emscripten's AudioWorklet path
  needs the COOP/COEP isolation this build refuses.
  That layer is PORTED AND LIVE — `native/libttp-runtime/ttp/audio.{h,cc}`,
  replayed on all four legs by `native/runtimetest/audio_check.cc` against
  `tests/fixtures/audio-corpus.jsonl` (5900 trace frames + 497 scripted steps,
  every command bit-exact), and reached by the browser through
  `native/runtime/ttp_audio.h` / `public/display/NativeAudio.js`. Nothing about
  a car crosses to decide a sound: `ttp_audio_frame(nowMs)` reads the bound
  session's live Game itself, and RACE EVENTS + COUNTDOWN BEATS are decided
  where they fire (the taps in `ttp_runtime.cc`), so the shell hands over a
  clock and takes back COMMANDS — a packed block of tagged records, not JSON,
  because it is drained per frame. Three rules live only on the C side and are
  invisible above the ABI, which is why `abi_check` asserts each: only the BOUND
  session is heard (so the lobby's attract race is silent for free), the
  end-of-race fast-forward is MUTED, and a disposed handle takes its queued
  beats with it. A cue crosses as a CODE and the browser derives its whole cue
  table from `ttp_audio_cue_id` rather than mirroring one; a voice's identity is
  an opaque interned SUBJECT, so no car id is handed back and a rocket's
  sequence number can no longer collide with a peer index; a picked song is an
  INDEX resolved once per race through `ttp_audio_song_json`.
  `public/display/audio/decide.js` STAYS, and its header says why: it is the
  ORACLE the corpus was recorded from (plus the music catalogue the galleries
  and `tests/credits.test.js` read). A disagreement between the two is a bug in
  the C++, never in the corpus, and the JS must keep answering exactly as
  recorded rather than tracking whatever the port does next — `tests/audio-abi.test.js`
  is what holds them to that at RUNTIME: it races the shipped wasm and the
  oracle side by side for 3600 frames and demands the same command stream.
  Two things that check pins are worth knowing before touching either side: the
  distance metric must be `sqrt(dx*dx+dy*dy+dz*dz)` and never `hypot` (one ULP
  flips a knee of the curve and changes the command outright), and the music
  trims are AUTHORED LITERALS — deriving them with the vendored `pow` turns the
  corpus red on the very first pick.
- THE UI MODEL IS A LAYER, not a pile of render functions. The DECISIONS behind
  the 2D screens — the seat grid (padding, the car-pick fallback), the lobby
  readiness rule, the lobby race card, the per-player race HUD values, the
  ITEM-on-change gate, the reconnect-card diff, the standings board + the cup
  chip + the results overlay, the fast-forward/forfeit predicates, the
  pause/auto-pause arbitration, and the screen enum + per-screen back EFFECT —
  are `native/libttp-runtime/ttp/ui_model.{h,cc}`, pure functions of plain data,
  reached from the browser through `native/runtime/ttp_ui.h` and the adapter
  `public/display/NativeUiModel.js`. The JS twin they were ported from
  (`public/display/uiModel.js`) imports nothing, touches no DOM/clock/RNG/history
  and is loadable in Node — see the port note below.
  `main.js` and `lobbySeats.js` RENDER from it and decide nothing; the shell keeps
  the three pieces of state the model threads (current screen, which reconnect
  cards actually attached, what each phone was last told its item was). Strings
  come out as KEYS plus data (`{titleKey:'cup_champs', cupName}`), never composed
  copy — the copy tables sit in `main.js` next to the elements they fill. What is
  deliberately NOT in it: DOM/CSS, fades, canvas sizing, rAF, fullscreen, QR
  painting, and the back-stack TRAVERSAL (the History API wearing a C hat — see
  the plan's non-goals). `tests/fixtures/ui-corpus.jsonl` recorded its answers
  while the JS alone produced them — same reason, and same rule, as the audio
  corpus above.
  IT IS NOW PORTED, all of it. `hudRows` went first
  (`native/libttp-runtime/ttp/hud.{h,cc}`, read back through the packed
  `ttp_display_hud` / `ttp_hud.h` by `render/Display.js`'s `hud()`), so the race
  HUD's values no longer come out of a snapshot at all; the other twenty-odd
  rules are `native/libttp-runtime/ttp/ui_model.{h,cc}`. Keys stay KEYS across
  the port — an `enum class` with a `key()` spelling, never composed English, so
  the copy tables can stay in each shell. `native/runtimetest/ui_check.cc`
  replays EVERY step of the corpus through it on all four legs, `out` and the
  threaded shell state alike; a disagreement is a bug in the C++, never in the
  fixture. The JS twin STAYS in `uiModel.js` — it is the ORACLE'S SOURCE, the
  standing `decide.js` has — but nothing that ships imports it: the WEB shell
  renders from the port too now, and tvOS/Android TV will read the same ABI
  through shells of their own, which is exactly the two-implementation shape the
  corpus exists to hold together.
  THE ABI IS JSON, and deliberately: this layer answers ONCE PER EVENT (a join,
  a pick, a car crossing the line) and half of what it answers is unbounded TEXT
  — player, cup and track names — so there is nothing to pack the way
  `ttp_hud.h`/`ttp_audio.h` pack their per-frame numbers; the precedent that fits
  is `ttp_room_events_json`'s. And the standings board's answer IS a JSON
  message, handed straight to the relay. That last point is why `ttp_ui.h` is the
  ONE ABI whose returns are not canonical: keys come out in the model's own
  order, because the board's key order is the order the phones have always
  received it in. `libttp-json`'s `ordered_stringify` is that emitter (one walk
  shared with `canonical_stringify`, differing only in the sort);
  `canonical_stringify` keeps its sort and its evidence-only job. The catalogue
  is the one piece of ABI state (`ttp_ui_configure`, set once at boot) —
  `ui_model.cc` itself stays catalogue-agnostic, which is what lets the corpus
  carry a synthetic world. `abi_check` replays the whole ui corpus through the C
  boundary, wire bytes included, so the marshalling is covered on every leg and
  not only in the browser. What did NOT cross: the back-stack
  TRAVERSAL (the table did, the walk did not) and `ROOM_STATE`, which
  `ui_model.h` MIRRORS rather than import, so libttp-runtime never gains an edge
  on the party layer — `ui_check` pins the copy to `protocol.h`.
  A held item crosses as a CODE, not a string — `TTP_ITEM_*`, pinned to the
  browser's `ITEM_IDS` mirror through `ttp_item_id` by
  `tests/display-abi.test.js`, because nothing else can see those two lists at
  once.
- Still JS BY DESIGN: the HUD/screens RENDERING (`main.js`, `Stage.js` — the
  decisions behind them are `ttp_ui.h`, above), the track
  DESCRIPTORS (`shared/tracks.js`, `shared/devTracks.js` — authored data, codegen'd
  into the wasm by `gen-track-defs-header.mjs`), the audio DEVICE + DSP palette,
  the whole controller page, and the transport I/O — the WebSocket and `RTCPeerConnection`
  live in `partyplug/PartyConnection.js` and `PartyFastlane.js`, which SURVIVE: the
  native fastlane SUBCLASSES the kit class to inherit its WebRTC handshake, and the
  controller uses both directly.
- Conformance is the frozen corpora + golden traces under `tests/fixtures/`,
  replayed by `native/` ctest (40 tests, the SAME 40 on every leg —
  linux/macOS/wasm/tvOS-sim — because each leg just runs `ctest`; the tvOS leg
  drives the simulator through the `CMAKE_CROSSCOMPILING_EMULATOR` shim
  `native/scripts/tvos-sim-spawn.sh`, exactly as the wasm leg runs under node).
  They are permanent cross-implementation evidence recorded against the JS engine
  while it existed — never re-record them from C++, which would only prove C++
  matches itself. `scripts/gen-*-corpus.mjs` are the oracle generators, and six are
  now FROZEN because their JS twins are gone: `gen-roomflow-corpus.mjs` (36 room
  scenarios), `gen-grandprix-corpus.mjs` (12 cup scripts + 5 shuffle-bag cases),
  `gen-trackbuilder-corpus.mjs` (all 20 tracks), `gen-track-sampler-corpus.mjs`,
  `gen-math-corpus.mjs` and `gen-theme-corpus.mjs` (6 biomes x 22 tracks, plus the
  cup/track resolution, the biome-name order and every boostShades shade). Each header names the `git show` that restores its twin if
  the oracle must be re-derived; `npm run revive:js-oracle` does the whole set.
  `gen-audio-corpus.mjs` and `gen-ui-corpus.mjs` are the two recorded AHEAD of
  their port and are therefore still RENEWABLE — every input they read is
  committed, and `tests/{audio,ui}-corpus.test.js` re-run each generator
  in-process and demand the committed bytes back. Keep those green: the day one
  goes red because an input rotted is the day that oracle stops being
  re-derivable, and P7/P8 delete the JS that can produce it. The audio one reads
  the golden traces, the shipped wasm and `audio/decide.js`; it replays five of
  the eight traces — skysnake and tidepool-schedule need `stageRocket`/`giveItem`/
  `useItem`/`setCarStats`, which the C ABI does not export (only `replay_cli`,
  calling C++ directly, can drive them), and tidepool-ailive is the same race as
  tidepool-4bots. What those would have covered is covered by scripted cases
  instead, which carry their own inputs and need no wasm at all. The UI one reads
  `display/uiModel.js` and NOTHING else — its scenarios carry a SYNTHETIC
  catalogue on purpose, so a new track is never a corpus re-record; whether the
  SHIPPED cups/tracks still flow through the model is `tests/ui-model.test.js`,
  which is free to change with the data.
- TWO CLASSES OF FIXTURE, and only one settles parity questions. JS-recorded
  (the 8 traces + every `gen-*-corpus` file) is cross-implementation evidence.
  C++-AUTHORED (`replay_cli --record <header>`, `catalogue_sweep_check --record`,
  `runtime_check --record`) is regression evidence only: it proves the sim/cameras
  still do what they did, never that the port was right. All three re-record via a
  `record_*` ctest holding byte identity. See `tests/fixtures/traces/README.md`.
  `runtime-camera-corpus.jsonl` is the one QUANTIZED fixture in the tree, and has
  to be: the camera math is cosmetic float calling the PLATFORM's
  expf/tanf/atan2f, not the vendored fdlibm, and the four legs' libms agree to a
  ulp rather than to the bit. It is rounded to 4 significant digits with a
  boundary guard in the recorder; do not read bit-exactness into it.
- Traces are ONE RACE PER PROCESS, so they cannot see state that leaks from one
  race into the next (a racing-line cache keyed by a recycled `Centerline*` made
  bots drive the previous track's line — invisible to all 8 fixtures). Three gates
  cover that blind spot: `race_isolation` forces the address collision with
  placement new, `catalogue_sweep` races all 20 tracks and then re-races them in
  REVERSE order demanding identical digests, and `replay_sequence` replays every
  trace in one process. When adding cross-race state, own it per `Game`.
- Traces also only ever race CATALOGUE tracks, so anything no shipped layout
  contains is unreachable by any fixture: no track builds with a pole, which is why
  `Game::collidePole` is covered by `hazard_check` constructing the situation
  directly rather than by a trace.
- The C ABI (`runtime/`) is NOT on the replay path — `replay_cli` calls C++ objects
  directly. `abi_check` covers the marshalling layer the browser actually talks to,
  EVERY ABI: two traces through `ttp_process_input`/`ttp_update`, the cup corpus
  through `ttp_gp_*`, the room and framing corpora through `ttp_room_*`/
  `ttp_framing_*`, the ui corpus through `ttp_ui_*` (wire bytes included — the one
  place the standings board's key order is asserted where it is made), a fastlane
  plumbing pass, and every boundary/mutation export
  against its header contract. It recompiles `runtime/*.cc` rather than linking a
  lib, so the shipped wasm's `EMSCRIPTEN_KEEPALIVE` export list is untouched.
  `tests/party-abi.test.js` still covers the same ground in Node against the SHIPPED
  wasm, which is the only place that artifact is exercised.
- WIRE-COMPAT (`tests/wire-compat.test.js` + `tests/wire-fastlane.test.js`, 34 tests
  in `npm test`) is the PERMANENT gate architecture.md asks for, and the only one
  where two LANGUAGES must agree on bytes at RUNTIME — phones stay on the JS
  controller forever on all three TV platforms. Both ends are real: the C++ is the
  SHIPPED wasm reached through the display's own adapters (`NativePartyConnection`/
  `NativePartyFastlane`/`NativeRaceSession`), the JS is `partyplug/` plus
  `public/controller/{Net,InputGate}.js` UNMODIFIED. Only TRANSPORT is fabricated —
  a socket, a lossy/reordering DataChannel pair (`tests/wire-compat/rtc.js`), a
  clock, four DOM leaves. It covers what neither the corpora nor E2E can: the corpora
  replay RECORDED JS (never a live peer), and E2E runs against a PERMISSIVE stub
  relay that cannot produce the frames that break a real party. So the relay here is
  `tests/wire-compat/relay.js` — a MODEL of Party-Sockets with every prod/stub
  divergence cited to a line of `server.ts` (a null `to` is an error not a broadcast;
  indices grow past maxClients; `peer_joined` is suppressed on a socket replace;
  10 s idleTimeout; the ~2 min hostless grace) — frozen in
  `relay-contract.json` by `scripts/wire-relay-contract.mjs`, which re-derives it from
  a checkout and fails loudly when a cited behaviour moves. GREEN IS NOT
  "prod-faithful": read that file's header for what the model still is not.
  `scripts/wire-mutate.mjs` is the gate's own gate — it patches `native/`, rebuilds
  `ttp_runtime_web` (sim+party, CI's wasm configuration), swaps the artifact in and
  requires the named test to go red. It immediately found the suite's one blind spot
  (the display is the RECEIVER, so nothing ran the C++ Link as a SENDER and reversing
  its newest-first ring was invisible); the fix is the "C++-SENT packet decodes in the
  real JS receiver" test. Add a case there whenever a shell gains a new send path.
- Two checks audit the SUITE, not the code, and run weekly + on demand
  (`.github/workflows/test-the-tests.yml`), never on PRs: `npm run mutation-check`
  breaks the engine 28 ways and requires the matching ctest to go red for each (two
  gates were found blind this way), and `npm run revive:js-oracle` restores the
  retired JS sim AND its track builder from git — each file from its own retirement
  commit — and re-records all 8 golden traces byte-identically. The twin now pulls
  its whole dependency set out of history rather than leaning on surviving modules,
  so it cannot rot from under itself. While it passes, parity evidence is renewable;
  when it starts failing, decide consciously whether to repair the twin or accept
  that the traces are frozen.
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
  scripted-sweep surface. Do NOT reach for Filament's
  `Renderer::getFrameInfoHistory()` for the GPU number: on emscripten the
  backend's timer-query path is compiled out and `canCreateFence()` is false, so
  `gpuFrameDuration` is CPU submit time wearing a GPU label. A `fenceSync` /
  `clientWaitSync` poll is worse (9.6 ms measured against a real 3.4 ms frame —
  it times `setTimeout` clamping). The rAF cadence alone measures neither: it is
  a vsync plateau, so it can only ever show DROPS.
- Preview deploys: every push builds and deploys to `https://tinytrack-<branch>.couch-games.com` (see `.github/workflows/preview.yml`).
