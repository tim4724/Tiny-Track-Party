'use strict';

// ============================================================================
// Tiny Track Party — wire contract shared by display and controllers.
// This file is GAME-SIDE config (not part of the partyplug kit): the relay/STUN
// deployment URLs and this game's message vocabulary live here and are injected
// into the kit at construction. The kit reads none of these globals.
// ============================================================================

// Party-Server relay URL (signaling + game-event fallback).
var RELAY_URL = 'wss://ws.couchpad.games';
// Dev/test override: the server injects its RELAY_URL env into each page's
// <meta name="relay-url"> (see server/index.js), which also widens the CSP to
// exactly that origin — the E2E suite points pages at its hermetic stub
// (tests/e2e/relay-server.js) this way. Operator-set env only, no client-side
// override. Browser-only; Node imports keep the default.
if (typeof document !== 'undefined') {
  var _relayMeta = document.querySelector('meta[name="relay-url"]');
  if (_relayMeta && _relayMeta.content) RELAY_URL = _relayMeta.content;
}

// STUN server for the WebRTC fastlane to gather server-reflexive candidates so
// cross-network peers connect when host candidates aren't reachable. STUN is
// UDP and not subject to CSP connect-src (browsers ignore the `stun:` scheme
// there). On the same LAN, host candidates work even without STUN.
// VERIFIED 2026-07-29: an eturnal server answers Binding Requests here on both
// A and AAAA (it is STUN ONLY — no TURN relay is configured, so a symmetric NAT
// on both ends still has no path and falls back to the relay). GameNet.js also
// lists a public STUN fallback after this one, so a stun.* outage costs
// cross-network play nothing.
var STUN_URL = 'stun:stun.couchpad.games:3478';

// Message types carried inside the Party-Server `data` field. Every message is
// a plain object with a `.type` drawn from here.
//
// The controller is a dumb renderer: it holds NO game state or content of its own.
// Almost everything display→controller is the retained room SNAPSHOT (LOBBY_UPDATE
// over set_state) — replayed on every (re)join and pushed on every change, so a
// reconnecting phone recovers its whole state (screen, roster, selection, results,
// AND the chooser content: cars/tracks/colors) from the replay alone, with no
// per-phone WELCOME to miss. Only two things stay transient messages: COUNTDOWN
// (a momentary haptic cue) and ITEM (per-owner, changes too often for the blob).
var MSG = {
  // Controller -> Display (intents)
  HELLO: 'hello',               // {name?, rejoinToken?} sent right after join — rejoinToken claims a dropped seat (cross-device reconnect, from the QR's ?claim=)
  CONTROL: 'control',           // {s: steer[-1,1], b: brake[0,1], u: ACTION use-counter[0-255, wrapping]} — hot path, ~25Hz, fastlane
  START_GAME: 'start_game',     // host only — starts the race; the display ignores it until every other player is ready (SET_READY)
  RETURN_TO_LOBBY: 'return_to_lobby', // "New game" — abort the race back to the lobby (any player)
  PAUSE_GAME: 'pause_game',     // request a pause (any player, mid-countdown/race)
  RESUME_GAME: 'resume_game',   // request resume from the pause overlay
  SET_CAR: 'set_car',           // {carIndex} — chosen car model in lobby (livery is auto-assigned)
  SET_READY: 'set_ready',       // {ready} — non-host readiness toggle; gates the host's "Start race" button (START_GAME)
  SELECT_MODE: 'select_mode',   // {mode:'track'|'cup'|'random', trackId?, cupId?, randomRaces?} — host's lobby pick: exact track (single race), a cup (4-race Grand Prix), or random (a run of drawn tracks: randomRaces=0 endless, else that many races then a podium, default 4; a random tap that doesn't change the length re-rolls the preview)
  SERIES_NEXT: 'series_next',   // host only, during a series intermission — start the next race now (the display also auto-advances)
  LEAVE: 'leave',               // intentional exit (back-out) — frees the seat at once in lobby/results; mid-race it's a soft drop (reconnect QR + grace), so an accidental back-swipe can't forfeit a car
  PING: 'ping',

  // Display -> all controllers: the retained room snapshot (relay set_state)
  LOBBY_UPDATE: 'lobby_update', // THE room snapshot. { roomState, hostPeerIndex, paused, mode, cupId, trackId, randomRaces,
                                //   players:[{peerIndex,name,colorIndex,carIndex,connected,ready,inRace}],
                                //   standings:{over,order:[…],series?}|null (playing/results),
                                //   cars:[{id,name,stats}], colors:['#…'], tracks:[{id,name,cup,cupName,cupDifficulty,svg}]|null (lobby only) }.
                                //   trackId is always the RESOLVED track (exact pick / cup's current race / random draw). Pushed live
                                //   on change, replayed to each (re)joiner right after `joined`. Car images load by id from the web host.

  // Display -> specific controller (transient — not room state)
  ITEM: 'item',                 // {item} — lights the controller's ITEM button; sent on change + once on (re)connect (held-item is per-owner, so it stays OFF the shared room snapshot)
  PONG: 'pong',

  // Display -> all controllers (transient broadcast)
  COUNTDOWN: 'countdown',       // {n} 3..2..1..GO — the haptic tick (the snapshot's roomState owns the actual screen)

  // Display -> ITS OWN SLOT (never reaches a controller). The self-heartbeat:
  // the display relays this to slot 0 once a second and expects the relay to
  // echo it back, which is the only way it can tell a half-dead socket from a
  // quiet room (see LIVENESS.HEARTBEAT_DEAD_MS). It lived as a bare string
  // literal inside display/Net.js until this entry existed, which meant a TV
  // shell reimplementing the display's own liveness had nothing to copy it
  // from — the type is as much a wire contract as any of the above.
  HEARTBEAT: '_heartbeat'
};

// Message types that ride the low-latency WebRTC fastlane (unreliable, unordered,
// latest-wins). Only idempotent, latest-state-wins inputs belong here. All other
// traffic and WS fallback still flow through the relay.
var FASTLANE_TYPES = { control: true };

// Room states (must match partyplug RoomFlow.STATES; asserted at display boot).
var ROOM_STATE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  RESULTS: 'results'
};

// ---- Game constants (shared so display + controller agree) ----
// Human seats per room. A short-handed lobby is topped up to a full grid with AI
// ("CPU") racers on the display side (see display/main.js FIELD_SIZE), so this is
// the cap on PHONES, not on cars in a race.
var MAX_PLAYERS = 4;
var TOTAL_LAPS = 3;
var COUNTDOWN_SECONDS = 3;

// ---- The presence contract (phone pings -> display drops) ----
// Six numbers that, like STEER above, only mean anything TOGETHER and are read
// by two files in two roles: the phone's ping cadence (controller/Net.js) and
// the display's drop/grace/canary windows (display/Net.js, fed straight into
// the native RoomFlow's liveness config). "A seat silent past 3 s is dropped"
// is only true because the phone pings at 1 Hz — until this block existed that
// was a two-file chain held together by prose comments, and a tvOS shell would
// have picked its own 3 s with nothing to say so.
//
// These are the WINDOWS, not the timers: setInterval/setTimeout stay with each
// platform's shell, and so does the E2E `window.__abandonGraceMs` override.
// tests/config-drift.test.js pins both files to this block, and
// scripts/gen-protocol-corpus.mjs carries it into the protocol corpus, which
// the `protocol` ctest replays against native/libttp-party/ttp/protocol.h.
var LIVENESS = {
  // PHONE. How often a controller pings the display (MSG.PING). Everything
  // below is budgeted against this cadence.
  PING_INTERVAL_MS: 1000,
  // DISPLAY. Silence longer than this drops a seat mid-game, through the same
  // path as a real peer_left. Three missed pings, so a single dropped packet
  // or a scheduling hiccup can never kick a live phone.
  TIMEOUT_MS: 3000,
  // DISPLAY. The cadence the display re-checks presence on (its own tick).
  TICK_MS: 1000,
  // DISPLAY. The self-heartbeat's deadline: no echo of MSG.HEARTBEAT back from
  // our own slot inside this window means OUR socket is half-dead, so force a
  // reconnect rather than wait for TCP. Wider than TIMEOUT_MS because with the
  // fastlane carrying inputs the display's socket sees only ~1 Hz of traffic,
  // so this lone canary needs the margin.
  HEARTBEAT_DEAD_MS: 6000,
  // DISPLAY. Every racer gone while late joiners wait: hold the room this long
  // for the dropped party to scan back in, then return to the lobby.
  ABANDONED_RACE_GRACE_MS: 15000,
  // DISPLAY. How long an open socket may sit without a created/joined answer
  // before the attempt is written off (the relay accepted the socket and never
  // replied — no error, no close).
  CREATE_TIMEOUT_MS: 8000
};

// ---- The steering contract (phone tilt -> display sim) ----
// Five numbers that only mean anything TOGETHER, read by three files in two
// languages: the sim's steering curve (native/libttp-sim/ttp/game.cc), the
// phone's tilt mapping (controller/TiltInput.js), and the CONTROL send gate
// (controller/InputGate.js) whose dead-band is DERIVED from the other two — it
// is sized against the sensor wobble ROLL_LOCK_DEG turns into, and budgeted
// against the gain EXPO peaks at. Until this block existed, that three-file
// chain was held together by prose comments alone: nothing failed if one moved.
//
// Nothing here is enforced by a comment now:
//   * tests/config-drift.test.js pins TiltInput/InputGate to this block, re-runs
//     InputGate's derivation, and reads EXPO back out of the SHIPPED wasm;
//   * scripts/gen-protocol-corpus.mjs bakes it into the protocol corpus, which
//     the `protocol` ctest replays against native/libttp-party/ttp/protocol.h on
//     every leg — and that check also asserts the sim's own default equals it,
//     which is what closes the loop back to game.cc.
var STEER = {
  // DISPLAY. tilt->steer exponent: steerIn = sign(s) * |s|^EXPO. Above 1 it
  // softens near centre (gain ~0.70 at |s| = 0.5) and peaks at EXPO itself as
  // |s| -> 1. This is the engine's live default; the debug panel may move it for
  // a session (ttp_set_steer_expo), nothing else may.
  EXPO: 1.25,
  // PHONE. Degrees of left/right roll that reach full lock.
  ROLL_LOCK_DEG: 30,
  // PHONE. Normalized steer discarded around centre, then re-expanded so full
  // lock still reaches +/-1.
  DEADZONE: 0.06,
  // PHONE. One-pole low-pass on the steer output (1 = fully raw). Roughly halves
  // single-sample sensor noise, which is why the gate's dead-band can sit at
  // half the raw wobble figure.
  SMOOTH: 0.5,
  // WIRE. Steering deltas below this are "the display already holds this", so
  // the sample never goes out. Bounded on both sides by InputGate's derivation.
  GATE_THRESHOLD: 0.03
};

// Car livery palette, indexed by the dense color slot RoomFlow.lowestFreeSlot
// hands out. Both sides resolve a player's colorIndex to the same hex.
var CAR_COLORS = [
  '#e6492d', // red
  '#f2b134', // amber
  '#2bb673', // green
  '#2d9cdb', // blue
  '#9b51e0', // purple
  '#eb5e9c', // pink
  '#f2784b', // orange
  '#56ccf2'  // cyan
];

// Car models (Kenney Toy Car Kit), indexed by carIndex. The player picks one in
// the lobby (SET_CAR); the display renders that model and tints it with the
// player's CAR_COLORS livery. Car choice and colour are independent — two
// players may drive the same model in different colours. CAR_MODELS / CAR_NAMES
// are parallel arrays (one source of truth shared by renderer + picker).
var CAR_MODELS = [
  'vehicle-racer-low', 'vehicle-speedster', 'vehicle-racer', 'vehicle-vintage-racer'
];
var CAR_NAMES = [
  'Dash', 'Bolt', 'Carve', 'Rumble'
];
// Extra Y-rotation (radians) per model, for any model whose mesh faces the wrong
// way after the renderer's base half-turn (most Kenney vehicles face -Z, so the
// renderer turns them to +Z). Every model currently faces correctly, so this is
// all zeros — kept as a per-model hook. Applied in-race (the renderer) and when
// baking the car thumbnails, so the picker preview matches the racing car.
var CAR_MODEL_YAW = [0, 0, 0, 0];

// Per-model handling stats, parallel to CAR_MODELS. The engine (Game.js) reads a
// resolved stats object per car; these are the source of truth the display feeds
// in. accel/vmax/turn are MULTIPLIERS on the engine's benchmark (1 = the Dash
// baseline); `mass` is relative (only the ratio matters when two cars collide);
// halfLen/halfWid are the collision footprint half-extents in WORLD units,
// measured from the Kenney meshes (length×width: racer 0.88×0.53, speedster
// 0.88×0.56). `turn` is the "Handling" stat shown in the picker — the car's
// turn rate, which sets its max corner speed: the engine does NOT auto-slow, so a
// low-handling car that carries too much speed simply can't yaw fast enough and
// washes WIDE (understeer) into the curb — you must brake yourself. A grippy car
// rails the same bend much faster. So the spread here is deliberately wide. The
// two fast cars split "fast" by axis: BOLT owns outright TOP SPEED (highest vmax —
// the name promises lightning, so it's the fastest thing on a straight), while
// RUMBLE is the heavy bruiser that wins by WEIGHT — it shoves everyone off-line
// (an edge the solo lap-time probe can't see). Each car owns a track family:
// Bolt the flowing straights, Carve the tight corners, Dash the medium mix,
// Rumble the scrum.
// Spread tuned against the cup tracks with scripts/probe-car-matrix.js so Bolt
// wins fast tracks but has real bad tracks, Carve keeps tight tracks, and Dash
// can take medium/technical layouts. Re-run it after edits; use the packed-race
// probe for Rumble's collision value.
var CAR_STATS = [
  // accel, vmax, turn(=handling), mass. Turn caps corner speed two ways: holdable line
  // ≈ turn/κ (understeer past it), and the engine's steer scrub — cornering costs speed
  // in proportion to steering input, and a grippy car needs less input for the same bend.
  // The vmax spread is deliberately TIGHT (0.98–1.06): vmax bills on every meter of every
  // lap while turn only bills in corners, so a wide vmax gap (the old 0.97–1.11) made the
  // fastest car unbeatable everywhere. Sim-tuned (2026-07-17 at base TURN_RATE 0.90,
  // solo laps × all 20 tracks, both driving styles): disciplined/AI-style cup winners
  // rotate (Bolt beach, Dash snow, Carve backyard+canyon+playroom, thin stable margins);
  // flat-out/casual style leaves Bolt a ~0.3–0.6s identity edge except backyard (Dash),
  // paid for by heavy washouts (curb-capped) and the lightest mass (loses every shove).
  // Flat-out washout risk is the felt ladder: Bolt worst, then Rumble, then Dash
  // occasionally; Carve never curbs. Re-price the spread whenever the engine's base
  // TURN_RATE or STEER_SCRUB moves — they set how much of a lap the turn stat bills.
  { accel: 1.04, vmax: 1.02, turn: 1.10, mass: 1.00, halfLen: 0.44, halfWid: 0.26 }, // Dash (Low Racer) — balanced all-rounder with the best launch; occasionally washes out flat-out (learn to brake), owns snow (and backyard when driven flat-out)
  { accel: 1.05, vmax: 1.06, turn: 0.95, mass: 0.78, halfLen: 0.44, halfWid: 0.28 }, // Bolt (Speedster) — the rocket: FASTEST top speed, lightest (shoved easily), weakest handling. Owns flowing tracks; washes out flat-out in tight corners — brake or eat curb
  { accel: 1.02, vmax: 0.98, turn: 1.27, mass: 0.86, halfLen: 0.44, halfWid: 0.26 }, // Carve (Racer) — corner king: rails the tightest bend, scrubs the least speed steering, NEVER washes out; pays with the lowest top end. Owns the technical cups when driven well
  { accel: 0.96, vmax: 1.04, turn: 0.98, mass: 1.35, halfLen: 0.44, halfWid: 0.28 }  // Rumble (Vintage) — heavy bruiser: 2nd-fastest flat-out, ponderous in corners (washes out like Bolt), heaviest by far (wins every shove)
];

// Resolve a carIndex to its stats (wraps the array; null/garbage → the Dash
// benchmark). Both the display engine wiring and the controller picker call this.
function carStats(carIndex) {
  var i = (carIndex == null || isNaN(carIndex)) ? 0 : ((carIndex % CAR_STATS.length) + CAR_STATS.length) % CAR_STATS.length;
  return CAR_STATS[i];
}

// Export for both Node.js and browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MSG, FASTLANE_TYPES, ROOM_STATE,
    RELAY_URL, STUN_URL,
    MAX_PLAYERS, TOTAL_LAPS, COUNTDOWN_SECONDS, STEER, LIVENESS,
    CAR_COLORS, CAR_MODELS, CAR_NAMES, CAR_MODEL_YAW,
    CAR_STATS, carStats
  };
}
