# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                          # Unit tests (node:test) — engine, track, partyplug
node --test tests/engine.test.js  # A single unit test
npm run test:e2e                  # Playwright E2E (real pages + hermetic relay stub)
npx playwright test tests/e2e/flow.spec.js  # A single E2E spec
npm start                         # Run the server (node server/index.js)
npm run dev                       # Run with --watch (auto-restart)
```

E2E (`tests/e2e/`) drives real display + controller pages against a local
Party-Server stub (`tests/e2e/relay-server.js`) via the server's `RELAY_URL`
env, injected into each page as the `relay-url` `<meta>` (read by
`shared/protocol.js`) — no dependency on the production relay. Import `test`/
`expect` from `tests/e2e/helpers.js` (it reaps leaked phone contexts). The
suite needs `npx playwright install chromium` once. `/gallery.html` is a manual
no-relay preview surface (driven by the per-page TestHarness via `?scenario=…`).

## Key Rules

- The sim is display-authoritative: the car simulation (`public/display/engine/Game.js`) runs in the browser, not the server. `server/index.js` serves static files + JSON endpoints only — no game logic, no WebSocket.
- Browser code is ES modules. The engine (`engine/Game.js`, `TrackBuilder.js`) is imported directly by Node tests via dynamic `import()` — keep it dependency-free so it loads in both browser and Node.
- Three.js is vendored under `vendor/three/` and served via the `/vendor/` route; the display imports it through an inline importmap (the one script that needs a CSP nonce).
- CSP headers in `server/index.js` — update when adding external resources.
- Relay/STUN URLs and the message vocabulary live in `public/shared/protocol.js` (game-side config, injected into the partyplug kit at construction — the kit reads no game globals).
- Game events (display → relay → controllers) flow over the WebSocket relay. Controller input (`CONTROL`) rides the low-latency WebRTC fastlane (`partyplug/PartyFastlane.js`, signalled over the relay) when its DataChannel is open, and falls back to the relay otherwise. The wiring lives in `public/shared/GameNet.js` (`_initFastlane`/`_isSignal`) with `display/Net.js` opening it as the input sink and `controller/Net.js` enqueuing over it; `protocol.js` provides `STUN_URL` and `FASTLANE_TYPES = { control: true }`. The lobby roster (`LOBBY_UPDATE`) is not a fanout: the display publishes it as the relay's retained host snapshot (`PartyConnection.setState`), pushed live to controllers (`onState`) and replayed to each (re)joiner right after `joined`.
- Disconnects: the relay fires `peer_left` only on a real socket close. The display additionally runs 1 Hz liveness (phones ping at 1 Hz; a seat silent past 3 s is dropped mid-game, same path as `peer_left`, any traffic restores it) — detection is RoomFlow's nowMs-injected `liveness` engine (`onSeen`/`expiredPeers`), while `display/Net.js` owns the tick and the relay self-heartbeat that forces a reconnect when the display's own socket is half-dead.
- Room teardown: when the room itself dies (host `closeRoom()`, or the relay's ~2 min hostless grace after the display vanishes) the relay closes every member socket with 4001 → `onClose {roomClosed}`, which is TERMINAL (no auto-reconnect). Controllers bail to a party-over overlay (`room_closed` status); the display self-heals into a fresh room. `DisplayNet.closeRoom()` is deliberately NOT fired on pagehide (unlike the HexStacker reference): pagehide can't tell reload from exit, and a display reload must keep its room (sessionStorage rejoin, E2E-covered) — the relay covers closed tabs anyway (instant reap when no live sockets remain, else the hostless grace).
- PartyPlug (`partyplug/`) is the reusable party-game framework (transport layer) shared across games, served under `/partyplug/`.
- 3D assets are the Kenney Toy Car Kit under `public/assets/toycar/` — the `toycar` path names the asset pack, not the game.
- UI is the "Sunny Circuit" theme. Design tokens + reusable bits (`.card .btn .chip .pill .field`, the `.scene` diorama) live in `public/shared/theme.css`, `<link>`ed by both display and controller before their page CSS. Build new UI from those tokens/classes — page CSS owns layout, the theme owns colour/type/surface. Fonts (Fredoka, Nunito) are self-hosted variable woff2 under `public/assets/fonts/` (SIL OFL) so the CSP keeps `font-src 'self'`.
- Preview deploys: every push builds and deploys to `https://tinytrack-<branch>.couch-games.com` (see `.github/workflows/preview.yml`).
