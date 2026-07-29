# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run setup                     # Make a FRESH WORKTREE ready: deps + native/build.
                                  # Idempotent, ~1 s, and it reports what is missing
                                  # (ninja, ccache, the Playwright browser).
npm test                          # Unit tests (node:test) — track, ABI, partyplug
node --test tests/track.test.js   # A single unit test
npm run test:native               # Native conformance: builds, then runs ctest -j
                                  # (plain `ctest --test-dir native/build` also works,
                                  # but is serial and will run stale binaries)
npm run test:e2e                  # Playwright E2E (real pages + hermetic relay stub)
npx playwright test tests/e2e/flow.spec.js  # A single E2E spec
node --test tests/wire-*.test.js  # Wire-compat only (C++ host vs the JS phone)
npm run test:native -- -R raceflow    # Race-orchestration conformance
npm run test:native -- -R "^record_"  # Re-record roundtrips (byte identity)
node scripts/wire-mutate.mjs      # Prove the wire gate bites: break the C++ 14 ways,
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
`/gallery-assets.html` is the odd one out: not a grid of frozen thumbnails but
ONE live scene you fly — every model, landmark, clutter kind and flier the
renderer draws, staged at once. See the SHOWCASE rule below.

## Key Rules

- The sim is display-authoritative: the car simulation runs in the browser (as wasm — see the NATIVE rule below), not the server. `server/index.js` serves static files + JSON endpoints only — no game logic, no WebSocket.
- Browser code is ES modules. Modules Node imports directly via dynamic `import()` (`shared/tracks.js`, `shared/devTracks.js`, `shared/protocol.js`, `engine/contract.js`) must stay dependency-free so they load in both browser and Node.
- CSP headers in `server/index.js` — update when adding external resources. There is no nonce and no inline script: every script is a same-origin file, so `script-src` is `'self' 'wasm-unsafe-eval'`.
- Relay/STUN URLs and the message vocabulary live in `public/shared/protocol.js` (game-side config, injected into the partyplug kit at construction — the kit reads no game globals). It is also the MANIFEST for numbers two layers share: `CAR_STATS`, `STEER` (the tilt→steer contract: `EXPO` in the C++ sim, `ROLL_LOCK_DEG`/`DEADZONE`/`SMOOTH` on the phone, `GATE_THRESHOLD` on the wire) and `LIVENESS` (the presence contract: `PING_INTERVAL_MS` on the phone, `TIMEOUT_MS`/`TICK_MS`/`HEARTBEAT_DEAD_MS`/`ABANDONED_RACE_GRACE_MS`/`CREATE_TIMEOUT_MS` on the display — "a seat silent past 3 s is dropped" is only true against a 1 Hz ping, and those two numbers lived in two files with a prose comment between them). `MSG.HEARTBEAT` (`_heartbeat`, display → its own slot) is in the vocabulary for the same reason: it was a bare literal inside `display/Net.js`, so a TV shell reimplementing the display's own liveness had nothing to copy. Nothing may re-declare a manifest number silently — `tests/config-drift.test.js` pins `TiltInput`/`InputGate`/`controller/Net.js`/`display/Net.js` to it (it used to pin `sessionModel.js` too; that file was the session oracle and went with the port, and the C++ it became reads the windows out of `protocol.h`), re-runs InputGate's dead-band derivation, checks the presence windows still describe one design, and reads `EXPO` back out of the shipped wasm; the protocol corpus + `protocol` ctest carry the whole block to `native/libttp-party/ttp/protocol.h`, and that check also asserts `getSteerExpo()` equals it, which is what binds `game.cc`.
  A SHELL THAT CANNOT READ EITHER FILE reads `ttp_protocol_manifest_json()` (`ttp_party.h`) — the whole manifest as one JSON object, `ttp::protocol::manifest()` verbatim. That is the ONLY third source: a Kotlin/JNI shell can include no C++ header and import no ES module, so without it every TV shell would hand-copy the car tables and the tilt numbers, which is the exact drift this rule exists to stop. The web deliberately does not call it (protocol.js is the authored source and is already on the page), so its consumers are ports; `abi_check` pins the export to the library on every leg, and `config-drift` deep-equals it against the WHOLE of protocol.js — the one assertion in the tree that catches a constant added to protocol.js and forgotten everywhere else, since `gen-protocol-corpus.mjs` names the keys it records one by one.
- Design tokens are DATA as well as CSS. `public/shared/theme.css`'s `:root` stays the authored source (comments and all); `scripts/gen-design-tokens.mjs` bakes it to `public/shared/design-tokens.json` — typed, aliases resolved — for the TV shells architecture.md accepts a second/third implementation of the sticker look for. `tests/codegen-freshness.test.js` keeps the bake current, `tests/design-tokens.test.js` proves it faithful (independent scrape) and enforces two rules the CSS can only state in prose: `--btn-sink < --btn-drop`, and chrome roles resolving to chrome colours only.
- Game events (display → relay → controllers) flow over the WebSocket relay. Controller input (`CONTROL`) rides the low-latency WebRTC fastlane (`partyplug/PartyFastlane.js`, signalled over the relay) when its DataChannel is open, and falls back to the relay otherwise. The wiring lives in `public/shared/GameNet.js` (`_initFastlane`/`_isSignal`) with `display/Net.js` opening it as the input sink and `controller/Net.js` enqueuing over it; `protocol.js` provides `STUN_URL` and `FASTLANE_TYPES = { control: true }`. The lobby roster (`LOBBY_UPDATE`) is not a fanout: the display publishes it as the relay's retained host snapshot, pushed live to controllers (`onState`) and replayed to each (re)joiner right after `joined`.
- CROSS-LAYER READS GO THROUGH A SEAM, NEVER THROUGH THE SHELL. `native/runtime/ttp_session.h` (a session handle → its live `Game`) and `native/runtime/ttp_room.h` (a room handle → its roster, host and phase) are INTERNAL headers, not ABIs: an ABI shim in `native/runtime/` links libttp-sim, libttp-party AND libttp-runtime, so when one layer's answer needs another layer's state the read happens in C++. The LIBRARY rule is untouched by this — `ui_model.h` still MIRRORS `ROOM_STATE` rather than import it, and libttp-runtime still has no edge on libttp-party; only the shims, which already link both, read across.
  Three exports ride these seams and they are the pattern to copy: `ttp_room_sync_active_order(room, session)`, `ttp_net_lobby_frame(room, session, fields)` (the whole retained snapshot, composed AND framed, returned as the exact socket text) and `ttp_ui_roster_seats_room_json(room, host)` (the lobby's seat grid — no session handle, because a `Seat` never carries `inRace`). What they replaced was the shell as COURIER: `ttp_net_lobby_snapshot_json` and `ttp_framing_encode_set_state` are two C++ functions that used to reach each other THROUGH JS, so the whole snapshot was serialized, parsed, re-serialized and parsed again per publish. Measured IN THE BROWSER at the 4-player cap: publish 169.6 us → 44.4 us, the seat grid 16.2 us → 7.1 us, and `_announce` (both, plus its DOM work) ~324 us → ~189 us.
  THE COST WAS NEVER THE ROSTER, which is the part worth remembering. The retained snapshot is ~7 KB and ~5.9 KB of it is the `tracks` chooser payload — the reduced track schematics, set ONCE at boot, opaque to every layer that touches it, and never changing for the life of the room. The roster is ~431 bytes. So what the round trip actually re-parsed on every join, rename, car pick, ready toggle and standings push was an immutable 6 KB blob. Node microbenchmarks under-read this by 3x because a hand-built snapshot has no chooser in it; measure a publish path in the page, with the real payload, or do not quote a number. What is left in `_announce` is now DOM-bound (~137 us of writes, the join cue, the lobby pick, the demo debounce) against ~52 us of marshalling — the halves have swapped, so the next win there is not at this boundary.
  If you are about to pull state out of one wasm layer only to hand it to another, add a seam accessor instead.
  THE JSON-TAKING SPELLINGS STAY, and not as legacy: `ttp_net_lobby_snapshot_json` / `ttp_ui_roster_seats_json` are what the FROZEN corpora replay, and a corpus carries a synthetic world with no room machine behind it. Handle-taking twins could never be driven by one. So the two live side by side on purpose — the JSON form is the conformance surface, the handle form is what ships.
  A HANDLE FORM IS GATED DIFFERENTLY, because no corpus can cover it: it adds no rule, it only GATHERS what a shell used to gather, so the only statement of correctness is that it agrees byte-for-byte with the two-call path. `abi_check`'s `handlePathsMatchJsonPaths` asserts exactly that, computing the expected value the old way in the same run (never a second copy of the wire format), across phases, a live race, no race, a disposed session and a roster that moves. Add a case there for every new handle-taking export.
- Disconnects: the relay fires `peer_left` only on a real socket close. The display additionally runs 1 Hz liveness (phones ping at 1 Hz; a seat silent past 3 s is dropped mid-game, same path as `peer_left`, any traffic restores it — every window is `protocol.js`'s `LIVENESS` block) — detection is RoomFlow's nowMs-injected `liveness` engine (`onSeen`/`expiredPeers`), the self-heartbeat's state machine is `ttp::session::heartbeat_tick` (an IN-FLIGHT FLAG, never an echo age, so a throttled background tab cannot misread its own starvation as a dead link), and `display/Net.js` owns only the `setInterval` and the two calls the tick asks for. The ABANDONED-RACE policy rides that same tick and is also RoomFlow's (`graceTick` — every participant gone while someone waits, arm `graceMs`, fire once; `display/Net.js` polls it and reports `onRaceAbandoned`). Its participant set is C++ too and is derived from the LIVE RACE: `ttp_room_sync_active_order(roomHandle, sessionHandle)` (`RoomFlow::syncActiveOrder`) reads the session's cars through the `ttp_session.h` seam and keeps "every seat holding a car, plus every dropped seat" — a shell passes a session handle and nothing else, and no car id is ever serialized out and handed back. What falls outside that set — `hasLateJoiners`/`lateJoiners` — is exactly a connected, car-less seat: one definition behind the policy, the standings' `joining` rows AND the display's silent auto-pause (`net.allParticipantsDisconnected()`, never re-counted in JS). Syncing it is load-bearing: the kit's own COUNTDOWN snapshot would count a DROPPED late joiner as someone waiting and yank a blipped party's race back to the lobby. That unfiltered kit semantics is pinned by the frozen corpus (adding a connected filter to `hasLateJoiners` turns `roomflow` red) — fix the SET, never the C++.
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
  line names no platform API it belongs in libttp-runtime. Everything a sibling
  shell compiles ALONGSIDE its own file is `TTP_APP_SOURCES` in
  `native/CMakeLists.txt` — one variable, because a second target that retyped
  the list would drift on the first ABI added and fail as a link error on one
  platform only. `docs/native-port/shells.md` is the audited ledger of what a
  new platform still owes and which pieces are a decision rather than a task.
  TWO HUD elements are drawn here rather than by a shell, and the line that
  admits them is exact: CELL-ANCHORED AND TEXTLESS goes to the renderer,
  anything carrying type or sticker chrome stays in the shell. That is the steer
  bar and the cell dividers (`materials/voverlay.mat`, `TtpRenderer::drawOverlay`,
  `TtpCellHudInput`) — a rounded rect with a translating fill needs none of the
  UI toolkit the HUD exists for, and both are pinned to a cell whose geometry is
  already C++. It keeps OUT the place/lap ordinal, the name chip, the item slot,
  the FINISHED card and the reconnect QR.
  THERE ARE TWO GRIDS AND ONLY ONE OF THEM IS WHERE THE PICTURE IS, which is the
  trap to know about here. `ttp_grid_cell` (ttp_render.h) tiles the RAW surface;
  `TtpRenderer::cellRect` letterboxes the grid to `CELL_MAX_ASPECT` as one piece
  and CENTRES it, and that is what the cameras actually render into. Anything
  placing chrome wants `cellRectTopLeft` — the one `ttp_display_cell_rects`
  returns, so the shell's chips and the renderer's steer bar cannot land on
  different grids. drawOverlay used the raw grid until 2026-07-29: measured at
  2560x720 with four cells, every steer bar sat a fifth of a cell off, under a
  car that was not there. It bites in ordinary play, not just on an ultrawide —
  the 2-PLAYER layout is STACKED, so its cells are 3.56:1 and past the cap. The
  DIVIDER span is the deliberate exception: it stays the whole canvas (E2E's
  `flow.spec.js` samples that seam row), because a rule between two views that
  stopped at the picture's edge would read as a gap.
  BOOST SHADES ARE `ttp::rt::boost_shades`, inline in libttp-runtime's theme.h
  precisely so the renderer can call it without linking that library (neither
  may link the other). The renderer kept its own float copy of `mixHex` plus four
  retyped coefficients until 2026-07-29, and the one shade with no pad beside it
  to keep it honest — the wind streak — had drifted to a hardcoded `0xdffcf8`
  that matches no biome's accent at all. Do not re-derive a shade; the frozen
  theme corpus pins all seven. Moving them also made the whole
  remaining HUD a ~6 Hz poll: nothing in the DOM is written per frame. THAT SAME
  TICK is now the only thing on the race loop besides the frame itself — the
  phones' ITEM push reads the HUD block the poll already fetched (it used to call
  `ttp_snapshot_json`, ~59 us of key-sorted race state per call against a ~15 us
  sim tick, to keep three fields per car), and the finish check
  (`ttp_ui_race_flow_json`, ~11 us) rides it too rather than asking 60 times a
  second whether anyone has crossed the line. A steady-state race frame is one
  `ttp_display_frame(dt)`, one `ttp_audio_frame(now)` and a packed
  `cellRects` read. Anything tempted onto the per-frame path needs to be
  something that actually CHANGES per frame. They are
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
  no samples, no furniture. NOTHING ABOUT A SCENE IS SERIALIZED any more, and
  `public/shared/trackBin.js` is GONE with the last of it: the "track.bin" byte
  payload shrank from the whole built track (v15) to the biome (v16) to the
  roster's liveries (v17), and then stopped being bytes. The roster crosses as
  `ttp_display_build`'s second argument — `[{id, name, carIndex, color}]`, in
  slot order — and `native/libttp-runtime/ttp/roster.{h,cc}` is its only reader,
  so the livery's ABGR word and the per-model name-plate table are written ONCE
  for three shells instead of once per shell in a hand-rolled encoder that no
  fixture in the tree could ever have caught drifting (`parseRoster` is gated by
  `frame_check` on all four legs). The lobby's
  mini-maps come from the prebaked `shared/trackSchematics.js` (`npm run
  gen:schematics`). The MAP CODEC behind that bake is native too
  (`native/libttp-track/ttp/schematic.{h,cc}`, gated by the `schematic` ctest
  against the committed bake): `ttp_track_schematic_json` projects a built track
  to the 256-unit square, and `ttp_schematic_pack` is the RDP + uint8 + base64
  reduction the room snapshot's chooser payload rides
  (`public/display/NativeSchematic.js`). The JS is SPLIT along the line of who
  runs it: `public/shared/schematicCodec.js` is `pack`/`unpackSchematic`, and it
  is SHARED because the PHONE unpacks — phones stay on the JS controller on all
  three TV platforms, so that half is permanent browser code with no native twin.
  The PROJECTION half is RETIRED: `public/display/trackSchematic.js` was the
  oracle the corpus was recorded from and shipped to nobody, and it went once
  `schematic-corpus.jsonl` had frozen its output for all 20 tracks. The bake is
  native now — `scripts/gen-track-schematics.js` reads
  `ttp_track_schematic_json` through `scripts/native-track.mjs` and reproduces
  the committed `shared/trackSchematics.js` BYTE-IDENTICALLY (the historical
  `proj` key order is respelled in `native-track.mjs` for exactly that reason,
  since the ABI emits canonical JSON). (The two halves were one file under
  `display/`, which made `controller/main.js` import from the directory three
  native shells replace.) Note the projection rounds
  through `Number.prototype.toFixed`, which printf cannot reproduce; the port
  routes it through double-conversion's `ToFixed` (V8's own).
  Node reads geometry through `scripts/native-track.mjs` over the
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
- The ASSET GALLERY (`/gallery-assets.html`) is the one scene that holds the
  WHOLE kit, and it is built from data rather than from a list. Three pieces,
  none of them a second copy of anything:
  the SHOWCASE THEME (`native/libttp-runtime/ttp/showcase.{h,cc}`, reached by
  `ttp_display_showcase` / `ttp_theme_showcase_models`) takes the picked biome's
  PALETTE unchanged and merges in every OTHER biome's VOCABULARY — all nine
  scenery models, all seventeen landmark kinds, all ten clutter kinds and every
  flier rig — first-appearance-wins over the `?biome=` order, so a biome added to
  `theme.cc` joins the gallery on the same commit and the `showcase` ctest says
  so (it also pins that the palette survives untouched, and that the scenery SLOT
  order does not depend on the biome — the shell fetches those bytes before the
  build picks a look). The SHOWROOM track (`shared/devTracks.js`) is shaped by
  the landmark placer: `buildLandmarks` walks the centreline from a per-kind
  arclength of 30–130, so the exhibition straight is 160 world units and every
  hero lands along it instead of scattered round a circuit. And the field is a
  bare session left UNRUN — the cars park on the grid, which is the opening shot
  — until the gallery's Drive toggle lets the AI out (`window.__showroom`, the
  frame's control surface: biome, forced item, drive, camera home).
  THREE THINGS EXIST ONLY WHILE CARS ARE RACING, and the parked showroom stands
  them anyway. The bananas need nothing (the showroom track authors three, and
  an authored banana respawns, so it is live from frame zero); a ROCKET is a
  homing projectile and the MONSTER TRUCK is a transform of a car, so neither
  can be authored into a descriptor at all. Those two are `showcase_rockets()` /
  `showcase_monster_slot()`, staged by `buildFrame` while `showcase && hold` —
  the exhibits are the PARKED state's, so Drive hands the scene back to the sim
  rather than leaving a truck welded to the last car. The rig is written to the
  outgoing frame and never into `held`, and the exhibit rockets take the FRONT of
  the array (the renderer's pool is four). `frame_check` holds the mode rule,
  `showcase_check` holds the placement.
  It is DEV-ONLY and reached by nothing on the shipping path: `ttp_display_showcase`
  is latched off, and `showcase.cc` sits beside `theme.cc` rather than inside it
  precisely so a gallery can never move a number the shipping game draws with
  (theme.cc is held to a frozen JS-recorded corpus; this has no JS twin and never
  had one, so its gate is behavioural).
  `tests/display-abi.test.js` diffs what is staged against the GLBs actually in
  `public/assets/toycar` — a kit model nothing plants is either dead weight or an
  unfinished wiring job, and the gallery's legend says so in the browser.
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
  `public/display/audio/decide.js` is RETIRED — it was the oracle the corpus was
  recorded from, and it went with `gen-audio-corpus.mjs` once the port was
  conformance-proven. The MUSIC CATALOGUE it also held moved to
  `public/display/audio/musicCatalogue.js`, which is pure data: the galleries,
  `tests/credits.test.js` and `tests/display-abi.test.js` import it from there
  (they used to import it from the oracle DIRECTLY — `Audio.js` used to re-export those four constants, which put the
  whole oracle on the shipped display page's import graph for tables the race
  path never reads; the device half holds no table at all now, and even the
  monster engine's timbre arrives as numbers on a voice command).
  `audio-corpus.jsonl` is now FROZEN, held by the `audio` ctest (replay) and
  `record_audio` (a byte-identical re-emission). What went with the oracle is
  named in `tests/audio-abi.test.js`: it used to race the shipped wasm and the
  JS side by side for 3600 frames, and that was the only check anywhere running
  the SHIPPED artifact against a second implementation at runtime. The decisions,
  the world they read and the ABI wiring are each still gated; their ASSEMBLY
  inside `ttp_runtime.wasm` is not.
  Two things that check pins are worth knowing before touching either side: the
  distance metric must be `sqrt(dx*dx+dy*dy+dz*dz)` and never `hypot` (one ULP
  flips a knee of the curve and changes the command outright), and the music
  trims are AUTHORED LITERALS — deriving them with the vendored `pow` turns the
  corpus red on the very first pick.
- THE AUDIO FILES ARE ARTIFACTS, and the two kinds have different sources. The
  CUES are GENERATED: `scripts/bake-cues.mjs` is the source, the WAVs are baked
  from it. The MUSIC is ACQUIRED, so its source is a URL — the shipped mp3s are
  incompetech downloads re-encoded to ~130 kbps VBR, and the 256-320 kbps
  masters are deliberately NOT in the tree. What stands in for them is
  `public/assets/audio/music/SOURCES.json` (per song: download URL, master
  sha256, byte count) plus the recorded encode; `npm run fetch:music` rebuilds
  every shipped file from scratch and `--verify` just re-checks the hashes.
  A checked-in master would be a backup, not a generator, and git already has
  one. This is what took `public/assets` from 170 MB to 87 MB, nearly all of it
  the preview deploy image (the songs STREAM one at a time through an `<audio>`
  element, so it was never a per-player download cost).
  MP3 IS NOT A QUALITY CHOICE HERE, which is the trap. Opus/AAC at 96k are
  smaller and better per bit (~55 MB for the catalogue), but `audio.cc`'s SONG
  table bakes the path INCLUDING the extension and `audio-corpus.jsonl` froze
  those strings — and that corpus can never be re-recorded, its JS oracle is
  deleted. Changing the extension turns `audio_check` and `record_audio` red on
  all four legs. Moving off MP3 means making `Song::file` a stem and letting
  each shell append its own extension: an ABI and corpus change, not an encode.
  RE-ENCODE WITH NO FILTERS. The per-song gains are frozen literals derived from
  each file's integrated loudness, so an `-af loudnorm` would silently
  invalidate the whole trim table — the corpus would still pass, because it only
  knows the literal. `npm run check:music-loudness` is the only thing in the
  tree that would notice (measured LUFS vs the catalogue's, plus the baked
  duration and a cover-art check). It shells out to ffmpeg, so it is a script
  rather than a `npm test` entry; run it after anything that touches the files.
- THE UI MODEL IS A LAYER, not a pile of render functions. The DECISIONS behind
  the 2D screens — the seat grid (padding, the car-pick fallback), the lobby
  readiness rule, the lobby race card, the per-player race HUD values, the
  ITEM-on-change gate, the reconnect-card diff, the standings board + the cup
  chip + the results overlay, the fast-forward/forfeit predicates, the
  pause/auto-pause arbitration, and the screen enum + per-screen back EFFECT —
  are `native/libttp-runtime/ttp/ui_model.{h,cc}`, pure functions of plain data,
  reached from the browser through `native/runtime/ttp_ui.h` and the adapter
  `public/display/NativeUiModel.js`. The JS twin they were ported from
  (`public/display/uiModel.js`) is RETIRED — see the port note below.
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
  fixture. The JS twin is GONE: `uiModel.js` and `gen-ui-corpus.mjs` went once
  the port was conformance-proven, so `ui-corpus.jsonl` is FROZEN — held by
  `ui_check` (replay) and `record_ui` (a byte-identical re-emission). The WEB
  shell renders from the port, and tvOS/Android TV will read the same ABI
  through shells of their own, which is exactly the two-implementation shape the
  corpus exists to hold together. What a frozen corpus costs is that it can
  never GROW: a new UI scenario can only be authored from C++, which proves
  nothing about the JS it replaced.
  THE ABI IS JSON, and deliberately: this layer answers ONCE PER EVENT (a join,
  a pick, a car crossing the line) and half of what it answers is unbounded TEXT
  — player, cup and track names — so there is nothing to pack the way
  `ttp_hud.h`/`ttp_audio.h` pack their per-frame numbers; the precedent that fits
  is `ttp_room_events_json`'s. And the standings board's answer IS a JSON
  message, handed straight to the relay. `ttp_ui.h` is the ONE ABI whose returns
  are not canonical: keys come out in the model's own order.
  `libttp-json`'s `ordered_stringify` is that emitter (one walk shared with
  `canonical_stringify`, differing only in the sort); `canonical_stringify` keeps
  its sort and its evidence-only job.
  WHAT THAT ORDER IS NOT is a wire guarantee, and the older wording here claimed
  it was ("the order the phones have always received it in"). It is not:
  `ttp_party.cc`'s `put` runs `canonical_stringify` over EVERY outbound frame —
  `encode_set_state`, `encode_broadcast`, `encode_send_to` alike — so the
  retained snapshot and the standings board inside it reach phones SORTED, and
  always have. What `ordered_stringify` actually earns is fidelity at the ABI
  boundary: `abi_check` asserts those exact bytes, and the frozen corpora
  recorded them off a JS oracle that emitted insertion order, so a re-emission
  has to reproduce them. Keep it for that. Do not spend anything defending a
  key order the wire discards. The catalogue
  is the one piece of ABI state (`ttp_ui_configure`, set once at boot) —
  `ui_model.cc` itself stays catalogue-agnostic, which is what lets the corpus
  carry a synthetic world. `abi_check` replays the whole ui corpus through the C
  boundary, wire bytes included, so the marshalling is covered on every leg and
  not only in the browser. What did NOT cross: the back-stack
  TRAVERSAL (the table did, the walk did not) and `ROOM_STATE`, which
  `ui_model.h` MIRRORS rather than import, so libttp-runtime never gains an edge
  on the party layer — `ui_check` pins the copy to `protocol.h`.
  THE CATALOGUE IS NO LONGER AN ARGUMENT. `ttp_ui_configure` takes the two field
  sizes and, with no `cups`/`catalog`, installs the world this build SHIPS:
  `gen-track-defs-header.mjs` carries each track's display NAME and difficulty
  LEVEL and the whole `CUPS` table into `track_defs.h` (it already carried
  `cup`), and `ui_model.cc`'s `shippedCups`/`shippedCatalog`/`cupTendency` build
  the lists from there. The tendency — a rounded mean of the tracks' levels, or
  the cup's own override — was a RULE every shell had to re-implement, and the
  ~2 KB of names was data the wasm already held. Passing the two lists still
  OVERRIDES, which is what the corpus's synthetic world rides, and is why the
  layer stays catalogue-agnostic. `ttp_ui_catalogue_json` reads the shipped
  tables back for the things a shell DRAWS (the cup picker, the chooser
  payload's track names) and deliberately ignores any override. `main.js` no
  longer imports `shared/tracks.js` at all; `tests/ui-model.test.js` is the
  drift gate, being the only place that sees both the authored JS and the wasm.

  A held item crosses as a CODE, not a string — `TTP_ITEM_*`, pinned to the
  browser's `ITEM_IDS` mirror through `ttp_item_id` by
  `tests/display-abi.test.js`, because nothing else can see those two lists at
  once.
- THE SESSION POLICY IS A LAYER TOO — the ROOM half of what `display/Net.js`
  used to do inline, and the split is the same one as everywhere else: C++
  decides, the shell performs. `native/libttp-party/ttp/session.{h,cc}` owns the
  retained room snapshot (LOBBY_UPDATE) and its `players` projection, the four
  URLs a room's identity is spelled into (join / claim / dial / the relay's
  controller-URL template), what a new seat starts as and the room-full cap, what
  a socket close and an intentional LEAVE mean in each phase, the SET_CAR and
  SET_READY guards, the phase-flip effects and the host-promotion ready-clear,
  the self-heartbeat state machine, the cross-device seat claim, and the
  post-reload reconciliation against the relay's peer list. Reached through
  `native/runtime/ttp_net.h` and `public/display/NativeSessionModel.js`. The JS
  twin `public/display/sessionModel.js` is RETIRED along with
  `gen-session-corpus.mjs`; `tests/fixtures/session-corpus.jsonl` is FROZEN, and
  the `session` ctest replays every step on all four legs while `record_session`
  holds a byte-identical re-emission.
  It holds NO RoomFlow handle and mutates nothing — every function is pure over
  plain data — which is what lets the corpus replay with no room machine at all.
  Same two ABI conventions as `ttp_ui.h`: JSON returns in the MODEL'S key order
  (the snapshot IS the wire), and one piece of configured state (the chooser
  payload — cars/colours/tracks — set once, opaque to the model bar the rule that
  `tracks` ride the LOBBY snapshot only).
  WHAT DELIBERATELY DID NOT CROSS: the transport (socket, RTCPeerConnection,
  sessionStorage, the two timers), the QR module bitmap (decision D3 — the URL
  composition is shared, the bitmap is three platform one-liners), the reconnect
  card's DOM, identity generation (no rules, just entropy), and the host's MODE
  PICK (`_applyMode`/`setTrack`/`clearPick`) — that needs a track catalogue AND a
  game-owned shuffle bag, which makes it a cup-series concern wearing a session
  hat, and its natural oracle (`gen-grandprix-corpus.mjs`) is already frozen.
  `session.h`'s `norm_index` carries a FROZEN security-adjacent quirk: it is JS
  `Number(value)`, so a HELLO with an explicit null `rejoinToken` claims seat 0
  while one with NO token claims nothing. It is harmless only because seat 0 is
  the display's own slot and never appears on the roster. Do not tidy it; the
  corpus pins both answers, and the ABI takes the whole HELLO (not the token) so
  absent and null stay distinguishable.
- THE RACE ORCHESTRATION IS A LAYER TOO, and it was the last thing in the
  display a second shell had to re-derive from prose. The state machine `main.js`
  used to run inline — `startRace`/`launchRace`, the countdown beats, `endRace`,
  `advanceSeriesRace`, `returnToLobby`, the AI field composition (`buildField`/
  `cpuSeats`, persona assignment, per-bot seeding), `forfeitCar`,
  `rekeyCarPlayer`, the auto-pause effects and `broadcastStandings` — is
  `native/libttp-runtime/ttp/race_flow.{h,cc}`, reached through
  `native/runtime/ttp_race.h` and the adapter `public/display/NativeRaceFlow.js`.
  `ttp_ui.h` took the PREDICATES (`allRacersReady`, `canPause`, `raceFlow`,
  `autoPause`); this is the machine that calls them IN ORDER.
  EVERY ANSWER IS AN ORDERED EFFECT LIST, and that is the whole design — nothing
  returns a verdict for a shell to sequence, because the sequencing is the part
  that is load-bearing AND silent when wrong. Four constraints live in the order
  alone: COUNTDOWN is published only after the session exists (else every racer's
  `inRace` reads false and phones flash "you're in the next race"); the post-GO
  auto-pause re-check is DEFERRED off the launch stack (it runs inside
  `session.update()`, whose no-seats-left branch tears the session down under the
  caller); cup points are banked BEFORE the final board goes out; the session is
  disposed BEFORE the flow flips to LOBBY. `main.js`'s `perform()` walks the array
  and may not reorder, batch or skip — an op it cannot perform throws rather than
  being dropped.
  `tests/fixtures/raceflow-corpus.jsonl` was recorded off the live
  `public/display/raceFlow.js` before the port existed; `raceflow_check.cc`
  replays every step on all four legs and checks BOTH the answer and the shell
  state its driver threads, because `out` alone would pass a port that emits
  exactly the right effects in the wrong order. `abi_check` replays the same
  corpus through the C boundary. raceFlow.js survives as the oracle's source and
  ships to nobody.
  A DRAW CANNOT BE PUT BACK, which is why `startRace` and `returnToLobby` are each
  asked TWICE: once with no draws, read for the verdict only, and again with
  exactly `ttp_race_draws_needed` draws once the answer is "launch". Pre-drawing
  for a start that is then rejected advances the shuffle bag for a race that never
  happened, so "random" repeats sooner and silently skips a track nobody saw.
  The PERSONA TABLE is single-sourced now: `ttp_race_personas_json` hands out
  libttp-sim's own `ttp::AI_PERSONALITIES` and the shell configures it straight
  back. `public/display/aiPersonas.js` used to be a hand-synced copy held together
  by a prose "keep in sync" comment — the exact drift the manifest rule exists to
  stop — and survives only for the test surfaces that need it synchronously.
  What deliberately did NOT cross: the shuffle BAG (page RNG, not sim state), the
  host's mode pick, `LobbyDemo`, and the performing itself (sockets, timers, the
  History API, the AudioContext, scene objects).

- Still JS BY DESIGN: the HUD/screens RENDERING (`main.js`, `Stage.js` — the
  decisions behind them are `ttp_ui.h`, above), the track
  DESCRIPTORS (`shared/tracks.js`, `shared/devTracks.js` — authored data, codegen'd
  into the wasm by `gen-track-defs-header.mjs`), the audio DEVICE + DSP palette,
  the whole controller page, and the transport I/O — the WebSocket and `RTCPeerConnection`
  live in `partyplug/PartyConnection.js` and `PartyFastlane.js`, which SURVIVE: the
  native fastlane SUBCLASSES the kit class to inherit its WebRTC handshake, and the
  controller uses both directly.
- Conformance is the frozen corpora + golden traces under `tests/fixtures/`,
  replayed by `native/` ctest (48 tests, the SAME 48 on every leg —
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
  Four more were recorded AHEAD of their port. THREE ARE NOW FROZEN TOO:
  `gen-audio-corpus.mjs`, `gen-ui-corpus.mjs` and `gen-session-corpus.mjs` are
  deleted with the JS twins they read, so those corpora can never be re-derived
  and `tests/{audio,ui,session}-corpus.test.js` are gone with them. What replaced
  the freshness obligation is the `record_*` roundtrip (below). The schematic one
  went the same way: `gen-schematic-corpus.mjs` and `display/trackSchematic.js`
  are both deleted, its corpus is frozen, and the SHIPPING bake it fed moved onto
  the native projection (`gen-track-schematics.js` reads
  `ttp_track_schematic_json` and reproduces the committed bytes). So
  `gen-raceflow-corpus.mjs` is the LAST RENEWABLE oracle in the tree, and the
  only remaining entry in `tests/codegen-freshness.test.js` that is one — keep it
  there. That list is the only thing that runs these generators at all, so an
  entry missing from it is not a weaker gate, it is no gate; four live ones were
  dropped from it once already. The audio one reads
  the golden traces, the shipped wasm and `audio/decide.js`; it replays five of
  the eight traces — skysnake and tidepool-schedule need `stageRocket`/`giveItem`/
  `useItem`/`setCarStats`, which the C ABI does not export (only `replay_cli`,
  calling C++ directly, can drive them), and tidepool-ailive is the same race as
  tidepool-4bots. What those would have covered is covered by scripted cases
  instead, which carry their own inputs and need no wasm at all. The UI one READ
  `display/uiModel.js` and nothing else — its scenarios carry a SYNTHETIC
  catalogue on purpose, so a new track was never a corpus re-record; whether the
  SHIPPED cups/tracks still flow through the model is `tests/ui-model.test.js`,
  which drives the shipped wasm now and is free to change with the data. The
  SESSION one READ `display/sessionModel.js` and nothing else, on the same
  synthetic-world principle; it exists mostly FOR the branches nothing else in
  the tree covers —
  every SET_CAR/SET_READY REJECTION (wire-compat covers the accepted paths only),
  the claim URL, the rejoinToken normalizer and the cross-device seat claim, none
  of which had a single test anywhere before it. The SCHEMATIC one is the odd
  member: its per-track expectations are the committed
  `public/shared/trackSchematics.js` bake, so the C++ check rebuilds each track
  through the native TrackBuilder and has to reproduce bytes the JS wrote.
  ALL THREE OF THOSE GENERATORS ARE DELETED with the twins they read, along with
  `gen-audio-corpus.mjs`; the four corpora are frozen and the `record_*`
  roundtrips replaced their freshness checks.
  A SYNTHETIC WORLD RIDES IN THE CORPUS, never in the C++. A generator that
  invents cups, a catalogue, personas, stats or caps writes them into the
  FIXTURE and every replayer configures itself from what it reads: the ui and
  raceflow corpora carry theirs in the header's `world` (each check builds its
  layer's types from it, `abi_check.cc` hands the same object to
  `ttp_ui_configure` / `ttp_race_configure`, and `record_ui` re-emits from it),
  the session corpus resolves its world into every step. Transcribing it instead
  is a number that must be edited in N places and silently rots in N-1 of them:
  ONE corpus has several replayers (two in C++ today, a tvOS/Android shell
  tomorrow). If you are typing a constant that also exists in a `.mjs`, put it in
  the fixture instead.
- TWO CLASSES OF FIXTURE, and only one settles parity questions. JS-recorded
  (the 8 traces + every `gen-*-corpus` file) is cross-implementation evidence.
  C++-AUTHORED (`replay_cli --record <header>`, `catalogue_sweep_check --record`,
  `runtime_check --record`) is regression evidence only: it proves the sim/cameras
  still do what they did, never that the port was right. All three re-record via a
  `record_*` ctest holding byte identity.
  `--record` NOW EXISTS ON BOTH CLASSES AND MEANS DIFFERENT THINGS, which is the
  one thing to get right here. On a class-2 fixture it AUTHORS: hand it a header
  and it produces a new fixture. On a class-1 fixture (`ui_check`,
  `audio_check`, `session_check`, `schematic_check` — gated by `record_ui`,
  `record_audio`, `record_session`, `record_schematic`) it only RE-EMITS: each
  line's own recorded INPUT is fed back through the port and the answers are
  written out again, so the scenarios are read off the committed file and can
  never be invented. Byte identity there proves the port reproduces every
  recorded answer and its exact JSON spelling — strictly more than the structural
  replays assert, and still NOT parity evidence. If one of those four ever
  differs, THE COMMITTED FILE IS RIGHT. See `tests/fixtures/traces/README.md`.
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
  breaks the engine 36 ways and requires the matching ctest to go red for each (two
  gates were found blind this way), and `npm run revive:js-oracle` restores the
  retired JS sim AND its track builder from git — each file from its own retirement
  commit — and re-records all 8 golden traces byte-identically. The twin now pulls
  its whole dependency set out of history rather than leaning on surviving modules,
  so it cannot rot from under itself. While it passes, parity evidence is renewable;
  when it starts failing, decide consciously whether to repair the twin or accept
  that the traces are frozen.
- Two shared C++ headers exist so that a per-feature copy never has to: a
  boundary reads JSON with `native/libttp-json/ttp/json_read.h` (`truthy` — JS
  truthiness, not a bool test — `num_field`/`str_field`/`arr_field`/`parse_or`,
  plus `opt_num`/`opt_str`/`id_of` templated on the caller's own option types),
  and a conformance check reads and compares a corpus with
  `native/testsupport/corpus_diff.h` (`read_line` + `diff_val`). Both are in the
  tree because the hand-copied versions had already drifted once. A new ABI or
  check writes neither: it includes them. The split is by who may link what —
  json_read ships inside the ABIs, testsupport is test-only.
- Our own C/C++ carries `-Wall -Wextra` via the `ttp_warnings` interface;
  the vendored fdlibm/double-conversion deliberately do NOT (they are taken whole
  from upstream). Not `-Werror` — a newer compiler's new diagnostic must not block a
  build.
- `public/display/engine/native/ttp_runtime.{mjs,wasm}` plus the `*.filamat`
  blobs beside them are CHECKED IN and are what the browser actually runs. After
  touching `native/`, run `native/scripts/build-runtime-web.sh` and commit the
  artifacts — `tests/native-artifact.test.js` compares BUILD_STAMP.json's source
  hash and fails when they drift (comment-only edits under `native/` count, since
  the hash is over bytes). Batch the whole `native/` edit before rebuilding, and
  re-check with `npm run check:artifact` (that one test, ~70 ms) rather than a
  full `npm test`; `node native/scripts/runtime-source-hash.mjs --files` lists
  what is hashed. The
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
- WORKTREE DEV LOOP. This tree is worked in many git worktrees at once, and
  `node_modules` + `native/build` are per-worktree and gitignored — so the cold
  cost is paid over and over. `npm run setup` is the one command a fresh
  worktree needs (deps + a configured `native/build`, ~1 s, idempotent), and it
  reports what is missing rather than letting you find out from a failure.
  Three things make the difference, each measured rather than assumed:
  CCACHE (wired into `native/CMakeLists.txt`, so CI and hand-typed cmake get it
  too) takes a from-scratch `native/build` from 14.0 s to 0.63 s. It needs
  `CCACHE_BASEDIR`/`CCACHE_NOHASHDIR`, which the CMake sets — WITHOUT them
  ccache hashes the absolute source path and two worktrees share nothing
  (measured 0/160 hits, i.e. the cache is pure overhead). A ccache-populated
  build reproduces the committed `ttp_runtime.wasm` byte for byte, which is the
  check that makes `basedir` acceptable in a tree this conformance-bound.
  NINJA is preferred by `scripts/lib/native-cmake.mjs` on a fresh build dir
  (9.8 s vs Make's 14.0 s) — the generator is fixed for the life of the
  directory, so it can only be chosen once. E2E runs `workers: 3` off CI
  (213 s → 79 s; see `playwright.config.js` for why not more).
  The steady state is `npm test` ~4.6 s, `npm run test:native` ~1.6 s (build
  included), E2E ~80 s, and a one-file engine change ~4.9 s through
  `build-runtime-web.sh` (nearly all of it the emcc link, which no cache can
  help). Anything much worse than that is a regression worth chasing — `npm
  test` was 18.5 s until one audit ABI stopped rebuilding its track per call.
  THE THREE THINGS THAT GOT IT THERE are each worth knowing, because each was
  one command doing avoidable work rather than anything structural:
  `codegen-freshness.test.js` re-derives the 16-track bake, which was 10.6 s of
  an 11 s suite — 93% of the wall clock in ONE assertion, single-threaded.
  `gen-tracks.mjs` now fans those 16 independent solves across worker processes
  (10.3 s → 2.5 s, byte-identical, ~4 tracks per worker so cold JIT is not paid
  16 times); THE GATE IS UNCHANGED, all 16 still run.
  `ctest` is serial by default (6.2 s against 2.4 s at `-j`), and it will also
  happily run stale binaries if you forget to build — `npm run test:native`
  does both and is what the docs now point at.
  `build-materials.sh` recompiled all 11 materials every time (~1 s) to
  reproduce bytes it already had; it is mtime-gated on the `.mat` AND on `matc`,
  inside the shared script so the tvOS/Android legs inherit it.
  The suite's wall clock is no longer any one test, so a jump is worth reading
  rather than assuming.
- Preview deploys: every push builds and deploys to `https://tinytrack-<branch>.couch-games.com` (see `.github/workflows/preview.yml`).
