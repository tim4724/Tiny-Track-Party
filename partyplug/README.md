# PartyPlug

Reusable framework for "shared screen + phones as controllers" party games: one
big display plus any number of phone controllers that join by QR code. A game
*plugs into* the comms layer (the **Party Sockets** relay), hence the name.
PartyPlug gives a game its transport and its room/lobby/host lifecycle; the game
brings its own screens, input, and rules.

Vanilla JS, no build step. Every module is UMD — it works under Node (for tests)
and in the browser via a global. Serve this directory under `/partyplug/`.
Hand-written `.d.ts` types and a co-located test suite (`partyplug/tests/`) ship
with it.

There is **no default export**: import each module by subpath
(`require('partyplug/RoomFlow')`, or `/partyplug/RoomFlow.js` in the browser), as
the `exports` map declares. A bare `require('partyplug')` intentionally resolves
nothing.

## Mental model

- **Slot 0 is the display; slots 1..N are controllers.**
- **Transport is pluggable.** Talk to the Party Sockets relay
  (`PartyConnection`) or run on AirConsole (`AirConsoleAdapter`) behind one
  interface, with an optional P2P low-latency input path (`PartyFastlane`).
- **`RoomFlow` is the room core** — who is in the room, who is host, what state we
  are in. It is headless: it emits events, your view renders.
- **The kit knows nothing about your game.** No DOM, no rendering, no colors,
  names, scores, or rounds. Those are yours.

## Modules

| Module | Role |
| --- | --- |
| `PartyConnection.js` | WebSocket client for the Party Sockets relay. Stable `clientId` bearer token for reconnect. |
| `AirConsoleAdapter.js` | Drop-in `PartyConnection` replacement that speaks the AirConsole SDK. |
| `AirConsoleStorage.js` | AirConsole persistent-data backed `localStorage` shim. |
| `PartyFastlane.js` | Optional P2P WebRTC DataChannel layer (low-latency input). Piggybacks on the connection for signaling, falls back to it. |
| `RoomFlow.js` | Headless room/lobby/host state machine: room state, roster, sticky-host election, presence. |

The transport modules read **no** game globals: deployment config (relay URL,
STUN server) is injected at construction, so the kit never depends on the game.

## Quick start

Connect a transport, feed it into `RoomFlow`, render from events, and drive
state transitions yourself. Your game owns the URLs and the countdown.

```js
// 1. Connect. The game owns the relay / STUN URLs (the kit just receives them).
const party = new PartyConnection(RELAY_URL + '/' + roomCode);
const fastlane = new PartyFastlane({ iceServers: [{ urls: STUN_URL }], /* ... */ });

// 2. The room/lobby/host brain.
const flow = new RoomFlow({ masterProvider: () => party.getMasterPeerIndex?.() });

// 3. Render off events.
flow.on('statechange', e => showScreen(SCREEN_FOR[e.to]));
flow.on('hostchange',  renderHostUI);
flow.on('rosterchange', renderRoster);

// 4. Feed the transport into the roster.
party.onProtocol = (type, msg) => {
  if (type === 'peer_joined') flow.addPlayer(msg.peerIndex, { name: msg.name });
  if (type === 'peer_left')   flow.removePlayer(msg.peerIndex);
};

// 5. Drive transitions. The countdown timer + visuals are yours.
function startGame() {
  flow.transitionTo('countdown');
  runYourCountdown(3, () => flow.transitionTo('playing'));
}
```

One Party Sockets relay can serve many games (rooms are namespaced by code), so
relay config is deployment-level, not framework-level.

## The retained-snapshot pattern

The single highest-value thing to build on top of the kit, and the reason
`setState` / `onState` exist.

Publish **one** object describing the whole room, and let controllers derive
their entire UI from it, screen routing included. Send them nothing else about
the room. The relay keeps the latest blob, pushes it live to everyone connected,
and replays it to any peer right after `joined`. So the live-update path and the
resync-after-a-reconnect path become the *same code* and cannot disagree.

That last property is the point. The alternative (per-recipient messages for
live updates, plus a separate "here is the current state" message on join) is
two code paths describing one truth, and they drift. The bug that motivated this
in HexStacker was a controller stranded on a pause overlay whose Continue button
could not work, because the rejoin payload said `paused: true` and the follow-up
that would have cleared it had already gone out.

The kit deliberately does **not** define the snapshot's shape, because the shape
is entirely game-specific. What it gives you is the transport guarantee and the
`RoomFlow` half of the content (room state, roster, host, presence).

The worked example is HexStacker's `server/RoomCore.js`: it *composes*
`RoomFlow`, adds the game-flavoured layer (naming, colour slots, per-player
game facts), and projects the whole thing into one snapshot. Notes worth
copying if you write your own:

- **Compose, do not fork.** `RoomFlow.addPlayer(peerIndex, fields)` takes opaque
  game data, so your fields ride along on the same record.
- **Keep it pure.** No clock, no timers, no IO. Take `nowMs` as a parameter and
  inject randomness. That is what lets the same module run in a browser, in
  Node tests, and inside JavaScriptCore / QuickJS on a TV, which is how three
  HexStacker displays came to share one implementation instead of three.
- **Return effects, do not fire callbacks.** Have each mutator return what
  happened (including whether the caller should publish now, publish throttled,
  or not at all) rather than emitting. Across a native JS bridge, callbacks are
  awkward and ordering-sensitive; a returned value is not.
- **Throttle publishes for finger-speed controls,** leading + trailing so the
  first change still feels instant, and keep the *timer* in the shell where a
  real clock lives.
- **Make application idempotent on the receiving end.** Diff against what is
  already rendered; a snapshot arrives for reasons unrelated to you.

## API reference

### `PartyConnection` — relay WebSocket client

```js
new PartyConnection(relayUrl, { clientId?, maxReconnectAttempts = 5 })
```

| Method | Purpose |
| --- | --- |
| `connect()` | Open the socket (auto-reconnects up to max) |
| `create(maxClients, url?)` | Create a room (display, slot 0). `url` is an optional controller-URL template (`{room}`/`{instance}` placeholders) the relay resolves for clients that hold only the room code (in `created`/`joined` and via `GET /room/:code`). Absolute https only, or the relay rejects the create; omit it on non-https origins |
| `join(room)` | Join a room by code (controller) |
| `pinInstance(baseUrl, room, instance)` | Pin auto-reconnect to a relay shard (rebuilds the sharded URL) |
| `sendTo(to, data)` | Send to one slot |
| `broadcast(data)` | Send to all peers |
| `setState(data)` | Publish the retained room snapshot (host/slot-0 only; ≤ 16 KiB serialized) |
| `closeRoom()` | Tear the room down for everyone (host/slot-0 only): the relay deletes it (`GET /room/:code` turns 404) and closes every member socket with 4001, surfaced to them as `onClose` `{ roomClosed }` |
| `reconnectNow()` / `resetReconnectCount()` | Manual reconnect control |
| `failAttempt()` | Count the current socket as a failed attempt and run the normal backoff/give-up path — for failures only the caller can see (e.g. a socket that opened but the relay never answered create/join); no-op after `close()`, and notifies `onClose` like an unexpected close |
| `close()` | Tear down, stop reconnecting |

Callbacks (assigned as properties):

- `onOpen()`
- `onClose(attempt, maxAttempts, meta?)` where `meta` may carry `{ replaced }`
  (evicted by a same-clientId join, close 4000) or `{ roomClosed }` (the room
  itself is gone: host `closeRoom()` or the relay's hostless grace, close 4001);
  both are terminal, no auto-reconnect follows
- `onError()`
- `onMessage(from, data)` for game messages
- `onProtocol(type, msg)` for relay events (`created`, `joined`, `peer_joined`, `peer_left`)
- `onState(data)` for the host's retained snapshot. The relay keeps the latest
  `setState` blob on the room, pushes it live to current peers (sender excluded),
  and replays it right after `joined` on every (re)join, so a briefly-dropped
  client catches up without per-recipient fan-out. A host that authors state but
  never consumes it (the usual display) just leaves `onState` unset.

Props: `relayUrl`, `clientId`, `reconnectAttempt`.

The relay requires a `clientId`; if you omit it, one is auto-generated. An
auto-generated id is stable for this instance (in-session reconnects keep the
same slot) but not across page reloads — to reconnect across a reload, persist a
`clientId` (e.g. `localStorage`) and pass it in.

The `clientId` is the slot's bearer secret: a socket that joins with it takes the
slot over and the incumbent is closed with 4000. The room code is public, so a
`clientId` must never be a constant or anything else guessable, least of all the
host's (slot 0), which would hand the whole room to anyone holding the code.

### `AirConsoleAdapter` — drop-in `PartyConnection` over the AirConsole SDK

```js
new AirConsoleAdapter(airconsole, {
  role: 'display' | 'controller',
  onReady?: (code, ac) => void,   // runs before 'created'/'joined' is synthesized
})
```

Same interface and callbacks as `PartyConnection` (`onError` is a no-op, the SDK
has no error event; `create` / `join` / `reconnectNow` are no-ops). Synthesizes
the relay protocol events from SDK device events.

The `onReady` hook is the kit's seam for anything a game must do before first
paint (e.g. applying the AirConsole-profile locale). The kit carries no i18n
knowledge itself.

`broadcast(data)` maps directly to AirConsole's broadcast primitive. Displays
use it to fan out game messages; controller code should generally use
`sendTo(0, data)` to talk only to the display.

`setState` / `onState` map to the SDK's custom device state on the screen
device (`setCustomDeviceState` / `onCustomDeviceStateChange`), which AirConsole
retains and replays to (re)joining controllers — the platform analogue of the
relay's retained snapshot, so game code is identical across both transports.
A controller calling `setState` is a silent no-op (it owns no screen state).

AirConsole-only extras:
- `getMasterPeerIndex()` — the master-controller rule; feed it to `RoomFlow.masterProvider`.
- `captureEarlyReady(airconsole)` — replay an SDK `onReady` that fired before
  the adapter was constructed.

### `AirConsoleStorage` — AC persistent-data storage shim

```js
const storage = AirConsoleStorage.install(airconsole, {
  allowlist: ['volume', 'difficulty']
});
```

Installs a `localStorage`-compatible shim backed by AirConsole persistent data.
Only allowlisted keys round-trip; keys not listed silently no-op. Use
`storage.requestLoad()` after AirConsole `onReady`, and `storage.onLoad(fn)` to
react once persisted values hydrate.

### `PartyFastlane` — optional P2P DataChannel (low-latency input)

```js
new PartyFastlane({
  iceServers, selfIndex?, sendSignal,        // signaling piggybacks on the relay
  onInput, onPeerReady, onPeerClosed,
  onConnectionState, onRtt, emitIdleHeartbeat,
  onAcked,       // the peer confirmed applying a payload
  maxRing        // cap on the resend ring (1 = latest-only)
})
```

Methods: `setSelfIndex(idx)`, `handleSignal(from, data)`, `open(peerIdx, opts)`
(async), `close(peerIdx)`, `closeAll()`, `enqueue(peerIdx, ev)` (send input;
returns `'p2p'` or `'dropped'` — fall back to the relay on `'dropped'`),
`isOpen(peerIdx)`, `getStats(peerIdx)`, `getAllStats()`. Controllers initiate,
the display auto-accepts. 3s of silence fires `onPeerClosed`.
`PartyFastlane.TICK_MS` is the resend cadence, for a caller or wrapper that
drives its own resend tick.

### `RoomFlow` — headless room/lobby/host state machine

```js
new RoomFlow({ masterProvider?, liveness? })
RoomFlow.STATES // { LOBBY, COUNTDOWN, PLAYING, RESULTS }
```

Roster (the `fields` object is opaque game data: color, name, score, etc.):

| Method | Purpose |
| --- | --- |
| `addPlayer(peerIndex, fields?)` | Add (or reconnect/refresh) a player; returns the live record |
| `removePlayer(peerIndex)` | Hard leave |
| `rekey(oldId, newId)` | Reconnect-claim: move a record to a new peerIndex, preserving it + host slot |
| `markDisconnected(peerIndex)` / `markReconnected(peerIndex)` | Soft blip window |
| `clearDisconnected(nowMs?)` | Mark everyone present (e.g. at game start); passing `nowMs` also re-stamps last-seen so a pre-start-quiet peer isn't instantly expired |

The game owns its per-player fields and mutates them on the live record directly
(e.g. `flow.get(id).score = 10`); RoomFlow never reads them. The only fields it
touches are `peerIndex`, `joinedAt` (host-election tiebreak), and `connected`.

Lifecycle: `transitionTo(state)` (the primary API), `endGame()` and
`returnToLobby()` (readable sugar for `-> RESULTS` / `-> LOBBY`),
`setActiveOrder(peerIndices)`, `reset()`. The countdown timer is the game's; the
kit just exposes the `COUNTDOWN` state. Entering `COUNTDOWN` snapshots the
participant order. Results data is the game's own — the kit does not store it.
`reset()` emits `rosterchange` (plus `statechange`/`hostchange` as applicable) so
event-driven consumers re-render on a room wipe.

Reads: `state`, `host` (effective), `hostPeerIndex` (sticky), `isHost(peerIndex)`,
`list()`, `get(peerIndex)`, `has(peerIndex)`, `size`, `connectedCount`,
`isDisconnected(peerIndex)`.

Liveness — opt in via `liveness: { timeoutMs?, graceMs?, enabledProvider? }`. A
half-open dead connection (sleeping phone, dropped Wi-Fi) never closes its
socket, so `peer_left` alone can't catch it. The host stamps every inbound
message with `onSeen(peerIndex, nowMs)` and polls the pure predicates
`isExpired`, `expiredPeers` (always empty in `LOBBY`),
`allParticipantsDisconnected`, `hasLateJoiners`, and `graceTick` (arms a
`graceMs` return-to-lobby deadline while every participant is gone but late
joiners wait; fires `true` when it elapses, then re-arms: a caller still polling
under the same condition gets another `true` every `graceMs`, so acting once is
the caller's job).

The detectors never mutate presence and never emit — the host applies an expiry
through the normal `markDisconnected` path, keeping the single-writer invariant.
All time is an injected `nowMs`, so RoomFlow stays clock-free. Set
`enabledProvider: () => false` where the transport owns connection tracking
(AirConsole). Full signatures in `RoomFlow.d.ts`.

Static: `RoomFlow.lowestFreeSlot(used, max)` returns the lowest free dense slot
in `[0, max)` given the slot values in use. Pure and **sparse-safe** — pass slot
values, never `peerIndex`es, so a non-contiguous transport id (an AirConsole
`device_id`) is never mistaken for a dense seat/color index. Use it for any
per-player dense allocation (seat, color slot) instead of indexing by peerIndex.

Events (`flow.on(type, fn)` returns an unsubscribe function; `'*'` receives all):

| Event | Detail |
| --- | --- |
| `statechange` | `{ from, to }` |
| `playerjoin` / `playerleave` | `{ player }` / `{ peerIndex }` |
| `playerupdate` | `{ player }` |
| `rosterchange` | `{ players }` |
| `hostchange` | `{ hostPeerIndex }` |

Player record: `{ peerIndex, joinedAt, connected, ...gameFields }`.

Event ordering / contract notes:
- For the **first** player, `addPlayer` emits `hostchange` (they become host)
  *before* `playerjoin`/`rosterchange`. A `playerjoin` handler that needs to
  know "am I host?" should read `flow.isHost(...)` rather than rely on a prior
  `hostchange`.
- `hostchange` fires whenever the **effective** host changes, including mid-game
  blips where the sticky slot stays put but the fallback shifts.
- `rekey` (cross-device claim) emits `rosterchange` for the consumed placeholder
  slot, **not** `playerleave` — so don't treat `playerleave` as a complete
  "who's gone" signal on that path.

#### How host election works

Effective host (`flow.host`) resolves as: the platform master (via
`masterProvider`, if eligible) → the sticky host slot (first joiner, if present
and connected) → the oldest-joined eligible present player. During
`COUNTDOWN`/`PLAYING`/`RESULTS` the candidate set is restricted to the
participant order (so a late joiner can't be handed host duty for actions they
can't reach). A mid-game host disconnect keeps the slot pinned (so a reconnect
reclaims it) while `flow.host` transparently falls back to a present player; the
handoff is committed when the room re-enters `LOBBY`/`RESULTS`.

To keep host eligibility in sync with a game-maintained participant list, call
`setActiveOrder(peerIndices)` whenever that list changes; otherwise entering
`COUNTDOWN` snapshots the currently-connected roster automatically.

#### Reconnect

Player identity is owned by the **transport**, not RoomFlow. The Party Sockets
relay keys each slot by the client's `clientId` (a stable bearer token the client
stores and re-presents): a slot is retained on disconnect, and a client rejoining
with the same `clientId` is restored to the **same** `peerIndex`. So the common
reconnect (a phone that dropped and came back) needs no roster surgery — the
display sees `peer_joined` for the existing index, the record is still there, and
liveness flips the slot back to present.

`rekey(oldId, newId)` is **only** for cross-device takeover: a *different* client
(fresh `clientId`) claims a dropped player's slot. The relay gives it a new
`peerIndex`, so the game moves the old record onto the new index. A returning
*same* client never goes through `rekey`.

## Design notes & intentional constraints

Read these before building a game on RoomFlow:

- **The state machine is single-session, single-phase.** One
  `lobby -> countdown -> playing -> results` cycle: no rounds, no phases, no
  `PAUSED`. Games needing those model them above the kit; they are the first
  things to extend.
- **The countdown is game-owned.** The kit exposes the `COUNTDOWN` state but runs
  no timer: `transitionTo('countdown')`, run your own timer/visuals/messaging,
  then `transitionTo('playing')`.
- **Prefer the event-driven shape.** Subscribe to events, read `flow.state` /
  `flow.host` directly, and query `flow.isDisconnected()` instead of keeping a
  parallel presence structure. (A retrofit can instead wrap `transitionTo` and
  alias the roster Map, but new games should not.)
- **`flow.players` is a stable Map; `reset()` clears it in place.** An alias
  stays valid across `reset()`. Never reassign `flow.players`.
- **Runtime style is conservative.** Plain CommonJS/UMD, no build step. Older
  modules use ES5 constructor patterns, newer adapters use class syntax — match
  the file you are editing rather than normalizing across the kit.

## Not in the kit (yet)

The networking and flow layers are the parts genuinely shared by every game in
this style, so they came first. The rest is reusable in principle but is better
extracted **against a second game** than guessed at from one:

- **Cross-device claim.** `rekey` handles the roster move; the missing piece is
  the claim token (e.g. a `claim=<index>` reconnect QR). A
  `flow.claim(token, newPeerIndex)` helper could fold the eligibility check +
  rekey into the kit. Next planned addition.
- **Lobby + join flow** (QR rendering, roster cards, name picker, screen shell).
  The DOM stays game-side; the *logic* (seat allocation, host gating) is
  shareable.
- **Theming tokens + i18n engine.**
- **A view contract** (`createGameDisplay` / `createGameController` + a per-game
  manifest) so a game declares its inputs and rendering without touching the
  protocol.
- **A native-ESM build**, to remove vendor-and-drift for bundler-based games.
  Partially there: the reference game's `scripts/build.js` already esbuild-bundles
  `RoomFlow` with its engine into an iife `HexCore` artifact that
  JavaScriptCore/QuickJS load on native, but it consumes the UMD form.

---

*Origin: extracted from a production HexStacker party game, which remains the
reference implementation.*
