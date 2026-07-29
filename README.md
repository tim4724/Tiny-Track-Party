# Tiny Track Party

Multiplayer toy-car racing where phones become tilt controllers and a shared screen is the track.

![4-player split-screen](artwork/splitscreen-4p.png)

**▶ [Play it live](https://tinytrack.couchpad.games/)** · **[UI gallery](https://tinytrack.couchpad.games/gallery.html)**

## Overview

A couch party game for 1–4 players on one shared screen — a TV, monitor, or laptop. Players join by scanning a QR code and tilt their phones to steer; empty seats fill with CPU racers, so every race runs a full grid. The display browser runs the authoritative 3D simulation; the Node.js server only serves static files and a QR-code endpoint.

## Architecture

The display browser is authoritative: it runs the race sim (Three.js) and broadcasts game state to every phone through a [Party-Sockets](https://github.com/tim4724/Party-Sockets) WebSocket relay. Steering input rides a lower-latency WebRTC DataChannel (`partyplug/PartyFastlane.js`) when one is open, and falls back to the relay otherwise.

## Quick Start

```bash
npm run setup      # deps + a configured native/build; safe to re-run
npm start          # serves on http://localhost:4000
```

1. Open `http://localhost:4000` on a big screen.
2. Players scan the QR code with their phones to join.
3. The first player to join is the host and starts the race.
4. Tilt to steer, hold BRAKE to slow down. First across the line wins.

> Phones need HTTPS for the tilt sensors — front the server with a tunnel or TLS cert when testing on real devices.

## Controls

| Input | Action |
|---|---|
| Tilt phone left/right | Steer |
| Hold BRAKE | Slow down |
| Tap USE (when lit) | Fire your power-up |

Cars auto-accelerate — tilt, brake, and USE are the only inputs. Drive over an item box to roll a power-up (a **boost** burst or a **banana** to drop behind you), which arms USE. Boost pads and rubber-banded item odds give trailing cars a catch-up edge.

## Project Structure

```
public/
  display/     # Authoritative sim (engine/Game.js) + Three.js renderer
  controller/  # Phone tilt controller
  shared/      # protocol.js — wire contract + relay/STUN config
server/        # Static-file + QR-code host (no game logic)
partyplug/     # Reusable party-game transport kit
```

## Configuration

Set the relay URL in `public/shared/protocol.js` (and the CSP `connect-src` in `server/index.js` if you self-host one). Server env vars:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP server port |
| `BASE_URL` | Auto-detected LAN IP | Base URL for join links / QR codes |
| `APP_ENV` | `development` | Set to `production` for production mode |

## Testing

```bash
npm test           # unit tests (node:test) — engine, tilt input, track, partyplug
npm run test:e2e   # Playwright E2E against a hermetic relay stub
```

Unit tests use Node's built-in `node:test` runner. The E2E suite (`tests/e2e/`) drives the real display and controller pages against a local relay stub, so no production relay is needed (run `npx playwright install chromium` once). `/gallery.html` is a manual no-relay preview surface for UI checks.

## Tech Stack

Vanilla JavaScript + ES modules, no build step. Three.js (vendored) renders the Kenney Toy Car Kit. Transport is the [Party-Sockets](https://github.com/tim4724/Party-Sockets) WebSocket relay plus WebRTC DataChannels for low-latency input. One production dependency (`qrcode`).
