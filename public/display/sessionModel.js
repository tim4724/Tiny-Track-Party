// THE SESSION MODEL — the display's ROOM decisions, as pure functions.
//
// public/display/Net.js used to hold two different things braided together: the
// transport (a WebSocket, sessionStorage, two timers, a QR canvas) and the
// POLICY that transport carries out — who gets a seat, what a LEAVE means in
// each room state, which car picks are refused, when a silent phone is dropped,
// what the retained room snapshot contains, and what a claim URL looks like.
// Only the first half names a platform. This file is the second half, lifted out
// as decisions over PLAIN DATA, so the same rules can serve a browser, a tvOS
// shell and an Android TV shell instead of each re-authoring them.
//
// It is the same move public/display/audio/decide.js and public/display/
// uiModel.js already made, and it is made for the same reason: a pure layer can
// be RECORDED. scripts/gen-session-corpus.mjs drives every function here over
// scripted room arcs and writes tests/fixtures/session-corpus.jsonl, which is
// JS-recorded cross-implementation evidence — the only class of fixture that can
// settle whether the C++ port (native/libttp-party/ttp/session.h) matches the JS
// it replaced. Recording had to happen BEFORE the port, because the ratchet is
// one-way: once this file goes the oracle can never be re-derived.
//
// IT IMPORTS NOTHING and reads no global. No DOM, no clock, no RNG, no storage,
// no socket: the caller passes `now` in, passes the roster in, and PERFORMS the
// commands that come back. tests/session-corpus.test.js enforces that.
//
// WHAT IS DELIBERATELY NOT HERE:
//   * The transport itself — sockets, RTCPeerConnection, sessionStorage,
//     setInterval/setTimeout, the QR bitmap, the reconnect card's DOM. C++
//     decides; each shell performs.
//   * Identity generation (the slot-0 bearer secret). No rules, just entropy —
//     the same call NativePartyConnection._genClientId already made.
//   * The host's MODE PICK (_applyMode / setTrack / clearPick). It needs a track
//     catalogue AND a game-owned shuffle bag, which makes it a cup-series
//     concern wearing a session hat; see Net.js for why it stays.
//
// STRINGS ARE KEYS, NOT COPY (decision D4). The default seat name comes out as
// {nameKey:'player_n', nameArg:N} and the shell composes it, exactly as the UI
// model hands back 'cup_champs' rather than a sentence.

// Room-state spellings. Mirrored rather than imported so this module stays
// dependency-free (protocol.js is a classic script that assigns globals); the
// corpus and native/libttp-party/ttp/session.cc both pin the copy.
const LOBBY = 'lobby';
const COUNTDOWN = 'countdown';
const PLAYING = 'playing';

// The display's self-heartbeat type, and the one window this file spends
// directly. Both are manifest values (protocol.js MSG.HEARTBEAT and
// LIVENESS.HEARTBEAT_DEAD_MS); they are restated here only because this module
// may import nothing, and tests/config-drift.test.js holds them to the manifest.
const HEARTBEAT_TYPE = '_heartbeat';
const HEARTBEAT_DEAD_MS = 6000;

// ---------------------------------------------------------------------------
// The retained room snapshot (LOBBY_UPDATE over the relay's set_state)
// ---------------------------------------------------------------------------

// The `players` projection every phone matches itself against: the room's
// roster composed with the GAME's answer to "does this seat hold a car in the
// live race", which is what lets a (re)joining phone route itself (true = drop
// back into the race, false mid-race = wait for the next one).
//
// `inRace` is a parallel array of booleans rather than a callback, because a
// callback is a platform affordance and this layer takes values. KEY ORDER IS
// THE WIRE'S — the phone reads these by name, and the order is the one it has
// been receiving since this projection was written.
export function rosterRows(roster, inRace) {
  return roster.map((p, i) => ({
    peerIndex: p.peerIndex,
    name: p.name,
    colorIndex: p.colorIndex,
    carIndex: p.carIndex,
    connected: p.connected,
    ready: !!p.ready,
    inRace: !!(inRace && inRace[i])
  }));
}

// The room's single outbound message. The relay retains it, pushes it live to
// every controller and replays it right after `joined`, so a (re)joining phone
// recovers its whole state — identity, roster, selection, results and the
// chooser content — from the replay alone. There is no per-phone WELCOME.
//
// `chooser` is the display-authoritative content the dumb controller renders
// from: cars (id/name/stats — tiny, and the late-joiner picker needs it
// mid-race), colors (the livery palette, so the phone's dots match the car the
// display paints) and tracks (the bulky reduced schematics, LOBBY ONLY, because
// that is the only time the picker is shown and the whole blob must fit the
// relay's 16 KiB set_state cap).
export function lobbySnapshot(input) {
  const lobby = input.roomState === LOBBY;
  const chooser = input.chooser || {};
  return {
    type: 'lobby_update',
    hostPeerIndex: input.hostPeerIndex,
    roomState: input.roomState,
    paused: !!input.paused,
    players: rosterRows(input.roster || [], input.inRace),
    mode: input.mode,
    cupId: input.cupId,
    trackId: input.trackId,          // always the RESOLVED concrete track
    standings: input.standings,      // results board (playing/results), else null
    cars: chooser.cars,
    colors: chooser.colors,
    tracks: lobby ? chooser.tracks : null
  };
}

// ---------------------------------------------------------------------------
// URLs — the four strings the room's identity is spelled into
// ---------------------------------------------------------------------------
const enc = encodeURIComponent;

// The join URL on the QR and the lobby ticket. The INSTANCE rides the FRAGMENT
// on purpose: it pins the relay shard without ever appearing in a request log.
// The room code is not encoded — the relay mints it from an alphabet that needs
// no escaping, and encoding it would change bytes the phones already parse.
export function joinUrl(baseUrl, roomCode, instance) {
  return baseUrl + '/' + roomCode + (instance ? '#' + enc(instance) : '');
}

// The per-seat reconnect QR: the join URL with ?claim=<peerIndex> spliced in
// BEFORE the fragment, so the shard pin survives. Get this order wrong and the
// claim lands on a relay shard that has never heard of the room.
export function claimUrl(url, peerIndex) {
  const h = url.indexOf('#');
  const base = h >= 0 ? url.slice(0, h) : url;
  const frag = h >= 0 ? url.slice(h) : '';
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  return base + sep + 'claim=' + enc(peerIndex) + frag;
}

// The controller-URL template registered with the relay on room create. The
// relay fills {room}/{instance} and hands the result to anyone holding only the
// room code — native TV shells via GET /room/:code, controllers in `joined` — so
// a code-only join can resolve which page to load. Mirrors joinUrl's shape. The
// relay accepts only absolute https templates and REJECTS THE WHOLE CREATE on an
// invalid one, so a plain-http origin (local dev, E2E) must register none:
// `null` here means "send no template", not "send an empty one".
export function controllerUrlTemplate(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  if (base.indexOf('https://') !== 0) return null;
  return base + '/{room}#{instance}';
}

// The rejoinToken a HELLO carries, normalized to a seat index.
//
// FROZEN QUIRK, DO NOT TIDY. This is `Number(value)`, so normIndex(null) === 0
// and therefore EVERY ordinary HELLO — which carries no rejoinToken at all — is
// a claim on seat 0. It is harmless only because seat 0 is the DISPLAY'S OWN
// slot and never appears on the roster, so claimPlan's `has(oldId)` always
// misses. A port that "fixes" this to reject null, or that reproduces
// Number() loosely, changes who is able to claim what. The corpus records the
// behaviour for null, for every JSON type and for the string forms Number()
// accepts, so the rule is pinned rather than described.
export function normIndex(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

// What a brand-new seat starts as. The car model defaults to the LIVERY slot so
// everyone starts on a distinct car; the player can change it in the lobby
// (SET_CAR), while the colour stays fixed for the room's life.
//
// The name is a KEY plus its number, never the composed string: 'Player 3' is
// copy, and copy belongs in the shell next to the element it fills.
export function seatDefaults(colorIndex) {
  return { nameKey: 'player_n', nameArg: colorIndex + 1, colorIndex, carIndex: colorIndex, ready: false };
}

// peer_joined, or a HELLO from someone we never seated. `usedColors` is the set
// of livery slots already handed out; `lowestFreeSlot` is the party layer's and
// is passed in resolved, so this stays a composition rather than a second
// implementation of the slot rule.
//
// A full room REFUSES the seat and does not stamp it — the relay let them onto
// the socket, but there is no chair. An EXISTING seat is a same-device
// reconnect: the relay keys slots by clientId, so a returning phone lands back
// on its old index and only needs its liveness clock restarted.
export function addPeerPlan({ has, size, maxPlayers, colorIndex }) {
  if (has) return { seat: null, stamp: true };
  if (size >= maxPlayers) return { seat: null, stamp: false };
  return { seat: seatDefaults(colorIndex), stamp: true };
}

// A socket close (peer_left). In the LOBBY a drop is forgiving — free the seat
// outright, the lobby's own join QR covers coming back. Mid-game keep the seat
// AND the player's car running, so the camera stays on it and a quick reconnect
// resumes driving, and offer a reconnect QR for that exact seat.
export function presenceAction(roomState) {
  return roomState === LOBBY ? 'free' : 'drop';
}

// An intentional LEAVE (back-out). Mid-race this is a DROP, not a free: one
// accidental back-swipe must not forfeit a car, so the seat holds its reconnect
// QR through the usual grace window. Anywhere else the seat goes at once.
export function leaveAction(roomState) {
  return (roomState === COUNTDOWN || roomState === PLAYING) ? 'drop' : 'expire';
}

// The dropped-seat card payload. Held for the WHOLE race — no give-up timer —
// until the player returns or the room comes back to the lobby. The DIFF over
// this set is the UI model's (reconnectDiff); the SET is this layer's.
export function reconnectCard(seat, url) {
  return { peerIndex: seat.peerIndex, name: seat.name, colorIndex: seat.colorIndex, url };
}

// ---------------------------------------------------------------------------
// Controller messages
// ---------------------------------------------------------------------------

// Where an inbound relay message goes. Slot 0 is US: the only thing that can
// arrive from it is our own relayed echo, which is how the self-heartbeat
// closes its loop, and anything else from that slot is not a peer talking.
export function inboundRoute(from, type) {
  if (from !== 0) return 'peer';
  return type === HEARTBEAT_TYPE ? 'self-heartbeat' : 'self-ignore';
}

// The routing table for a peer's message. Everything this layer does not name
// is the game layer's ('game' — START_GAME, RETURN_TO_LOBBY, controls…).
export function messageAction(type) {
  switch (type) {
    case 'hello': return 'hello';
    case 'leave': return 'leave';
    case 'set_car': return 'set_car';
    case 'set_ready': return 'set_ready';
    case 'select_mode': return 'select_mode';
    case 'ping': return 'ping';
    default: return 'game';
  }
}

// SET_CAR — the lobby car-model pick. Car and colour are independent and
// duplicates are allowed, so there is no uniqueness check; four conjoined rules
// instead, and each one earns its place:
//   * a READY seat is locked, because ready survives race -> lobby and the pick
//     behind a standing ready flag must not shift (un-ready first);
//   * a RACER is locked to their car until the room is back in the lobby, while
//     a late joiner with no car may pick freely mid-race — their choice has to
//     stick for the next race;
//   * the index must be an INTEGER and IN RANGE, because this is untrusted
//     input from a phone.
export function setCarDecision({ ready, roomState, inRace, carIndex, carCount }) {
  if (ready) return false;
  if (!(roomState === LOBBY || !inRace)) return false;
  return Number.isInteger(carIndex) && carIndex >= 0 && carIndex < carCount;
}

// SET_READY — the non-host readiness toggle. The host starts the race instead of
// readying up, so their own toggle is refused; readiness is a lobby concept; and
// a redundant toggle is suppressed, because every accepted one republishes the
// snapshot to the whole room.
export function setReadyDecision({ isHost, roomState, ready, current }) {
  return !isHost && roomState === LOBBY && !!ready !== !!current;
}

// ---------------------------------------------------------------------------
// Room-state transitions
// ---------------------------------------------------------------------------

// What a phase flip means, beyond the flip itself.
//
// restampConnected: race start re-stamps every CONNECTED seat's liveness, so
//   silence accumulated in the lobby (where expiries are gated off) is not
//   charged against the first countdown tick — a phone whose ping was throttled
//   for >3 s before the host hit Start would otherwise be dropped one tick in.
//   The window must run from race start. Deliberately NOT a blanket
//   clear-disconnected: flipping a grace-pending seat back to connected here
//   would orphan its reconnect QR.
// freeDisconnected: back in the lobby, the race that reserved dropped seats is
//   over, so reclaim any that never came back.
// clearStandings: a fresh race and the lobby both start with no results board.
// publish: ALWAYS. The retained snapshot carries roomState, and a replay to a
//   (re)joining phone must never hand it a stale phase.
//
// Ready flags deliberately SURVIVE the race -> lobby round trip: the same crew
// usually races again, so returning racers land back in the lobby still ready.
export function stateChangePlan(to) {
  return {
    restampConnected: to === COUNTDOWN,
    freeDisconnected: to === LOBBY,
    clearStandings: to === COUNTDOWN || to === LOBBY,
    publish: true
  };
}

// Host promotion. A promoted host has no ready toggle (their footer button is
// "Start race"), so a ready flag left over from before the promotion could never
// be cleared — and it would keep their car pick locked forever, since SET_CAR
// refuses ready seats. Drop it on promotion.
export function hostChangePlan() {
  return { clearReady: true, publish: true };
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

// The display's own-socket canary, once per tick.
//
// Overdue is measured with an IN-FLIGHT FLAG rather than an echo AGE, and that
// is the whole point: a throttled background tab's ticks may run minutes apart,
// and an age test would read its own starvation as a dead link and reconnect a
// perfectly healthy socket. With a flag, the only way to be overdue is to have
// sent one and not had it back.
//
// Returns the commands for this tick:
//   act 'idle'       not in a room — do nothing at all
//   act 'reconnect'  no echo inside the window: the relay cannot reach us, so
//                    force a reconnect now instead of waiting for TCP. The tick
//                    STOPS here (sweep false) — a link being torn down has no
//                    business expiring seats.
//   act 'send'       nothing in flight: relay a heartbeat to our own slot.
//   act 'wait'       one is in flight and still inside the window.
// `sweep` is the rest of the tick: apply RoomFlow's expiries as drops, re-sync
// the active order, then poll the abandoned-race deadline — in that order, on
// this one clock reading.
export function heartbeatTick({ inRoom, hbPending, hbSentAt, now }) {
  if (!inRoom) return { act: 'idle', hbPending: !!hbPending, hbSentAt: hbSentAt || 0, sweep: false };
  if (hbPending && now - hbSentAt > HEARTBEAT_DEAD_MS) {
    return { act: 'reconnect', hbPending: false, hbSentAt: hbSentAt || 0, sweep: false };
  }
  if (!hbPending) return { act: 'send', hbPending: true, hbSentAt: now, sweep: true };
  return { act: 'wait', hbPending: true, hbSentAt: hbSentAt || 0, sweep: true };
}

// ---------------------------------------------------------------------------
// Reconnect claims and post-reload reconciliation
// ---------------------------------------------------------------------------

// A different DEVICE claims a dropped seat by carrying its old peerIndex as the
// HELLO rejoinToken (from the claim QR's ?claim=). The seat record is re-keyed
// from the old index onto this fresh connection, so the returning player resumes
// their livery, car, name and host slot. A same-device reconnect keeps its index
// and never reaches here.
//
// `restamp` is not decoration: the seat's carried last-seen stamp is from BEFORE
// the drop and is therefore already older than the timeout, so a reclaimed seat
// would expire again on the very next tick without it. It is exactly the sort of
// detail a reimplementation loses, which is why it is an explicit command.
export function claimPlan({ fromId, rejoinToken, hasOld, oldDisconnected }) {
  const oldId = normIndex(rejoinToken);
  if (oldId === null || oldId === fromId) return { claim: false };
  if (!hasOld || !oldDisconnected) return { claim: false };
  return { claim: true, oldId, restamp: true };
}

// Post-reload reconciliation, against the peer list the relay hands back in
// `joined`. Seats the relay no longer knows are expired; peers it knows that we
// do not are seated with placeholder identities (each phone re-HELLOs when it
// sees the display return, restoring its name). Slot 0 is us and is never a
// seat. Duplicates in the relay's list collapse — the second sighting would
// find the seat already taken.
//
// The caller then publishes: this fresh flow is now the authority, so the live
// push clears every phone's reconnect overlay and the next joiner is not
// replayed the roster from before the reload.
export function resyncPlan(rosterIds, relayPeers) {
  const present = new Set(relayPeers);
  const expire = rosterIds.filter((id) => !present.has(id));
  const known = new Set(rosterIds.filter((id) => present.has(id)));
  const add = [];
  for (const idx of relayPeers) {
    if (idx === 0 || known.has(idx)) continue;
    known.add(idx);
    add.push(idx);
  }
  return { expire, add, publish: true };
}
