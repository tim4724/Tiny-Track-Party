# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                          # Unit tests (node:test) — engine, track, partyplug
node --test tests/engine.test.js  # A single unit test
npm start                         # Run the server (node server/index.js)
npm run dev                       # Run with --watch (auto-restart)
```

There is no browser/E2E suite yet. `/gallery.html` is a manual no-relay preview
surface (driven by the per-page TestHarness via `?test=1&scenario=…`).

## Key Rules

- The sim is display-authoritative: the car simulation (`public/display/engine/Game.js`) runs in the browser, not the server. `server/index.js` serves static files + JSON endpoints only — no game logic, no WebSocket.
- Browser code is ES modules. The engine (`engine/Game.js`, `TrackBuilder.js`) is imported directly by Node tests via dynamic `import()` — keep it dependency-free so it loads in both browser and Node.
- Three.js is vendored under `vendor/three/` and served via the `/vendor/` route; the display imports it through an inline importmap (the one script that needs a CSP nonce).
- CSP headers in `server/index.js` — update when adding external resources.
- Relay/STUN URLs and the message vocabulary live in `public/shared/protocol.js` (game-side config, injected into the partyplug kit at construction — the kit reads no game globals).
- Controller input currently flows over the WebSocket relay (controller → relay → display), same as game events (display → relay → controllers). The low-latency WebRTC fastlane (`partyplug/PartyFastlane.js`, signalled over the relay) is built in the kit but **not yet wired into the game** — `protocol.js` reserves `STUN_URL`/`FASTLANE_TYPES` for it.
- PartyPlug (`partyplug/`) is the reusable party-game framework (transport layer) shared across games, served under `/partyplug/`.
- 3D assets are the Kenney Toy Car Kit under `public/assets/toycar/` — the `toycar` path names the asset pack, not the game.
- Preview deploys: every push builds and deploys to `https://tinytrack-<branch>.couch-games.com` (see `.github/workflows/preview.yml`).
