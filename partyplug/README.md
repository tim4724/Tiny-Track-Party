> **Note (native port):** `RoomFlow.js` was REMOVED from this fork — Tiny Track
> Party runs the room state machine as C++/WASM (`native/libttp-party`, adapter
> `public/display/NativeRoomFlow.js`), with the 36-scenario behavioural corpus in
> `tests/fixtures/roomflow-corpus.jsonl` as its frozen oracle. `PartyConnection.js`
> and `PartyFastlane.js` REMAIN: they own the WebSocket and the WebRTC handshake,
> which wasm cannot, and the native fastlane subclasses `PartyFastlane` to inherit
> that handshake. Upstream (HexStacker-Party) still has the JS RoomFlow.

# PartyPlug

Reusable framework for "shared screen + phones as controllers" party games: one
big display plus any number of phone controllers that join by QR code. A game
*plugs into* the comms layer (the **Party Sockets** relay), hence the name.
PartyPlug gives a game its transport and its room/lobby/host lifecycle; the game
brings its own screens, input, and rules.

Vanilla JS, no build step. Every module is UMD — it works under Node (for tests)
and in the browser via a global. Serve this directory to the browser under
`/partyplug/` (add a static route in your server).

It ships as a versioned package (`partyplug/package.json`, currently `0.1.0`)
with hand-written `.d.ts` types per module and its own co-located test suite
(`partyplug/tests/`). The runtime is CommonJS/UMD; a native-ESM build is a
deliberate future step (see below). There is **no default export** — import each
module by subpath (`require('partyplug/RoomFlow')`, or `/partyplug/RoomFlow.js`
in the browser), as the `exports` map declares; a bare `require('partyplug')`
intentionally resolves nothing.

## Mental model

- **Slot 0 is the display; slots 1..N are controllers.**
- **Transport is pluggable.** Talk to the Party Sockets relay
  (`PartyConnection`) — or any adapter that speaks the same interface — with an
  optional P2P low-latency input path (`PartyFastlane`).
- **`RoomFlow` is the brain** — who is in the room, who is host, what state we
  are in. It is headless: it emits events, your view renders.
- **The kit knows nothing about your game.** No DOM, no rendering, no colors,
  names, scores, or rounds. Those are yours.

## Modules

| Module | Role |
| --- | --- |
| `PartyConnection.js` | WebSocket client for the Party Sockets relay. Stable `clientId` bearer token for reconnect. |
| `PartyFastlane.js` | Optional P2P WebRTC DataChannel layer (low-latency input). Piggybacks on the connection for signaling, falls back to it. |
| `RoomFlow.js` | Headless room/lobby/host state machine: room state, roster, sticky-host election, presence. |

The transport modules read **no** game globals: deployment config (relay URL,
STUN server) is injected at construction, so the kit never depends on the game.

## Quick start

Connect a transport, feed it into `RoomFlow`, render from events, and drive
state transitions yourself. Your game owns the URLs and the countdown.

```js
// 1. Connect. The game owns the relay / STUN URLs (the kit just receives them).
const party = new PartyConnection(RELAY_URL + '/' + roomCode, { clientId: 'display' });
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

## API reference

Conceptual model: slot 0 is always the display, slots 1..N are controllers. The
transport interface is adapter-friendly: anything exposing `PartyConnection`'s
methods and callbacks can stand in for it (a platform-SDK adapter once did).

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
| `failAttempt()` | Count the current socket as a failed attempt and run the normal backoff/give-up path — for failures only the caller can see (e.g. a socket that opened but the relay never answered create/join) |
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
- `onState(data)` for the host's retained snapshot: the relay keeps the latest
  `setState` blob on the room, pushes it live to current peers (sender
  excluded), and replays it right after `joined` on every (re)join — so a
  briefly-dropped client catches up without the host fanning out per-recipient
  messages. Routed to `onState`, never `onProtocol`, so a host that authors
  state but never consumes it (the usual display) just leaves `onState` unset.

Props: `relayUrl`, `clientId`, `reconnectAttempt`.

The relay requires a `clientId`; if you omit it, one is auto-generated. An
auto-generated id is stable for this instance (in-session reconnects keep the
same slot) but not across page reloads — to reconnect across a reload, persist a
`clientId` (e.g. `localStorage`) and pass it in.

### `PartyFastlane` — optional P2P DataChannel (low-latency input)

```js
new PartyFastlane({
  iceServers, selfIndex?, sendSignal,        // signaling piggybacks on the relay
  onInput, onPeerReady, onPeerClosed,
  onConnectionState, onRtt, emitIdleHeartbeat
})
```

Methods: `setSelfIndex(idx)`, `handleSignal(from, data)`, `open(peerIdx, opts)`
(async), `close(peerIdx)`, `closeAll()`, `enqueue(peerIdx, ev)` (send input),
`isOpen(peerIdx)`, `getStats(peerIdx)`, `getAllStats()`. Controllers initiate,
the display auto-accepts. 3s of silence fires `onPeerClosed`.

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

Liveness (half-open presence timeout — opt in via
`liveness: { timeoutMs?, graceMs?, enabledProvider? }`): a half-open dead
connection (sleeping phone, dropped Wi-Fi) never closes its socket, so the
relay's `peer_left` alone can't catch it. The host stamps every inbound message
with `onSeen(peerIndex, nowMs)` and polls the pure predicates: `isExpired(id,
nowMs)`, `expiredPeers(nowMs)` (silent-past-`timeoutMs` peers; always empty in
`LOBBY`), `allParticipantsDisconnected()`, `hasLateJoiners()` /
`lateJoiners()` (the predicate and the list of the same roster-minus-order set),
and `graceTick(nowMs)` (arms a `graceMs` return-to-lobby deadline while every
participant is gone but late joiners wait; fires `true` when it elapses, then
RE-ARMS — a caller still polling under the same condition gets another `true`
every `graceMs`, so acting once is the caller's job). The
detectors never mutate presence and never emit — the host applies an expiry
through the normal `markDisconnected` path, keeping the single-writer
invariant. All time is an injected `nowMs`; RoomFlow stays clock-free (the
reference game's `tests/portable-purity.test.js` gates this). Set
`enabledProvider: () => false` where the transport owns connection tracking
(e.g. a platform SDK). See `RoomFlow.d.ts` for the full signatures.

Static: `RoomFlow.lowestFreeSlot(used, max)` returns the lowest free dense slot
in `[0, max)` given the slot values in use. Pure and **sparse-safe** — pass slot
values, never `peerIndex`es, so a non-contiguous transport id (e.g. a platform
SDK's device id) is never mistaken for a dense seat/color index. Use it for any
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
`COUNTDOWN` snapshots the currently-connected roster automatically. The order is
also the definition of "late joiner": everyone NOT in it
(`hasLateJoiners()`/`lateJoiners()`), which is what the abandoned-round grace
waits for — so a game whose participants aren't simply "whoever was connected at
`COUNTDOWN`" must supply the order, or those predicates answer for the wrong set.

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

- **The state machine is single-session, single-phase.** It models one
  `lobby -> countdown -> playing -> results` cycle. There is no rounds/phases
  concept and no `PAUSED` state. Games that need rounds, phases, or an in-game
  timer model those above the kit; these are the first things to extend if a
  game needs them.
- **The countdown is game-owned.** The kit exposes the `COUNTDOWN` state but runs
  no timer: a game does `transitionTo('countdown')`, runs its own
  timer/visuals/controller messaging, then `transitionTo('playing')`.
- **Two integration shapes; prefer event-driven.** The recommended shape is to
  subscribe to events and read `flow.state` / `flow.host` directly, and query
  `flow.isDisconnected()` rather than keeping a parallel presence structure. A
  game retrofitting an existing codebase can instead wrap `transitionTo` and
  alias the roster Map, but new games should use the event-driven shape.
- **`flow.players` is a stable Map; `reset()` clears it in place.** If you alias
  it, that alias stays valid across `reset()`. Never reassign `flow.players`.
- **Runtime style is conservative.** Browser-facing modules stay plain
  CommonJS/UMD without a build step. Older extracted modules use ES5 constructor
  patterns; newer transport adapters use class syntax where browser targets
  already support it. Prefer matching the file you are editing over normalizing
  style across the whole kit.

## Not in the kit (yet)

The networking and flow layers are the parts genuinely shared by every game in
this style, so they came first. The following are reusable in principle but are
better extracted **against a second game** than guessed at from one. The first
is the next planned addition:

- **Cross-device claim (optional).** Same-device reconnect needs no kit help:
  the Party Sockets relay keys slots by `clientId` and restores the **same**
  `peerIndex` when a client rejoins with its stored `clientId` (see "Reconnect"
  under RoomFlow, above), so the roster slot survives untouched. `rekey(oldId,
  newId)` exists only
  for the *cross-device* case (a different phone, with a fresh `clientId`, taking
  over a dropped player). The game-side glue there is a claim token (e.g. a
  `claim=<index>` reconnect QR); a `flow.claim(token, newPeerIndex)` helper could
  fold the eligibility check + rekey into the kit if cross-device takeover is a
  feature you want.
- **Lobby + join flow** (QR rendering, roster cards, name/identity picker, the
  screen shell). The DOM stays game-side; the *logic* (seat allocation via
  `lowestFreeSlot`, host gating) is shareable.
- **Theming tokens + i18n engine.**
- **A view contract** (`createGameDisplay` / `createGameController` interfaces +
  a per-game manifest) that lets a game declare its inputs and rendering without
  touching the protocol.
- **A native-ESM build.** Today the modules are CommonJS/UMD; an ESM build (or a
  monorepo workspace package) would remove vendor-and-drift for bundler-based
  games. (Partially there: the reference game's `scripts/build.js` already
  esbuild-bundles `RoomFlow` together with its engine into an iife `HexCore`
  artifact, `dist/partycore.js`, that JavaScriptCore/QuickJS load on native. That
  consumes the UMD form; a true ESM build is still the cleaner end state.)

---

*Origin: extracted from a production HexStacker party game, which remains the
reference implementation.*
