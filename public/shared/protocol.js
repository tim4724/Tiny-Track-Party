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
// on both ends still has no path and falls back to the relay).
var STUN_URL = 'stun:stun.couchpad.games:3478';
// The public fallback GameNet lists AFTER ours, so a stun.couchpad.games
// outage costs cross-network play nothing. Part of the manifest so a TV shell
// offers the same candidate set, in the same order.
var STUN_FALLBACK_URL = 'stun:stun.l.google.com:19302';

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
  CONTROL: 'control',           // {s: steer[-1,1], b: brake[0,1], u: ACTION use-counter[0-255, wrapping]} — hot path, sensor-rate gated, fastlane.
                                // The display derives ttp_process_input's presence MASK from which fields arrived (bit1 s:number,
                                // bit2 b:number-or-boolean, bit4 u:number); the wire carries no mask. Derive from THIS line, not
                                // from another shell's code. (A C++ seam for this path was measured and refuted — stays JS.)
                                // Absent fields are left UNTOUCHED on the car, which is what makes a partial message safe —
                                // a `u` defaulted to 0 would read as a fresh use-counter and fire the car's held item.
                                // ttp_process_input answers the mask it consumed (-1 = no such car), so a shell bringing this
                                // path up can assert once rather than steer nothing in silence; tests/control-mask.test.js pins both.
  START_GAME: 'start_game',     // host only — starts the race; the display ignores it until every other player is ready (SET_READY)
  RETURN_TO_LOBBY: 'return_to_lobby', // "New game" — abort the race back to the lobby (any player)
  PAUSE_GAME: 'pause_game',     // request a pause (any player, mid-countdown/race)
  RESUME_GAME: 'resume_game',   // request resume from the pause overlay
  SET_CAR: 'set_car',           // {carIndex} — chosen car model in lobby (livery is auto-assigned)
  SET_READY: 'set_ready',       // {ready} — non-host readiness toggle; gates the host's "Start race" button (START_GAME)
  SELECT_MODE: 'select_mode',   // {mode:'track'|'cup'|'random'|'tour', trackId?, cupId?, randomRaces?} — host's lobby pick: exact track (single race), a cup (4-race Grand Prix), random (a run of drawn tracks: randomRaces=0 endless, else that many races then a podium, default 4), or tour (the World Tour: one drawn track per cup, raced in cup order). EVERY accepted random/tour message deals a fresh draw, identical to the current pick or not — re-tapping a sub-option re-rolls.
  SERIES_NEXT: 'series_next',   // host only, during a series intermission — start the next race now (the display also auto-advances)
  SET_SOUND: 'set_sound',       // {on} — host only: mute/unmute the display's audio (the TV's own mute button flips the same state); echoed to everyone as the snapshot's soundOn
  LEAVE: 'leave',               // intentional exit (back-out) — frees the seat at once in lobby/results; mid-race it's a soft drop (reconnect QR + grace), so an accidental back-swipe can't forfeit a car
  PING: 'ping',

  // Display -> all controllers: the retained room snapshot (relay set_state)
  LOBBY_UPDATE: 'lobby_update', // THE room snapshot. { roomState, hostPeerIndex, paused, soundOn, mode, cupId, trackId, randomRaces,
                                //   players:[{peerIndex,name,colorIndex,carIndex,connected,ready,inRace}],
                                //   standings:{over,total,hostPeerIndex,order:[…],series?,settled?}|null (playing/results;
                                //   composed and RETAINED in C++ behind the room handle, so every shell puts the same board out).
                                //   `settled` appears ONLY as true, and only on a cup's FINAL board, once the TV's podium reveal
                                //   has landed — the phone's cue to stop reporting the race and report the cup. It is the ONLY
                                //   difference between the two pushes of that board; ahead of it the phones would crown the champion
                                //   while the TV was still counting points towards it.
                                //   cars:[{id,name,stats}], colors:['#…'], tracks:[{id,name,cup,cupName,cupDifficulty,svg}]|null (lobby only),
                                //   progress:{cups:[{id,stars,locked,unlockDone?,unlockNeed?}]} (lobby only; absent, not null, elsewhere —
                                //   the couch's DERIVED star record, composed display-side off the wasm catalogue; phones draw it, never re-derive it) }.
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
// ("CPU") racers on the display side, so this is the cap on PHONES, not on cars
// in a race — FIELD_SIZE below is that.
var MAX_PLAYERS = 4;
// Cars in every race: the connected humans plus AI filling the grid up to this.
// The display feeds it to the engine's race orchestration at boot; humans start
// from the back of it. Never larger than CAR_COLORS — every seat needs its own
// livery.
var FIELD_SIZE = 8;
var TOTAL_LAPS = 3;
var COUNTDOWN_SECONDS = 3;
// The schematic codec's max deviation (shared/schematicCodec.js SCHEMATIC_EPS,
// native schematic.h EPS — both pinned to this line by tests). It lives here
// because the display PACKS with it and the phone's mini-map DECODES what it
// packed; see the codec for why 0.35 is a fidelity bound, not a size knob.
var SCHEMATIC_EPS = 0.35;

// ---- The RANDOM run length (host picks it, the display clamps it) ----
// Two numbers the phone's picker and the display's pick resolver must agree on.
// The picker offers exactly three run lengths — DEFAULT races, MAX races (the
// long card), or 0 for endless — and the display normalises whatever arrives on
// the wire against MAX, because SELECT_MODE is a message from a device we do
// not control.
//
// They lived as two private copies, one in `shared/trackPicker.js` and one in
// `display/Net.js`, with nothing between them; the first TV shell then invented
// a third and defaulted it to 1, so a fresh lobby advertised "Random, 1 race" —
// a run length the picker cannot produce and the host cannot get back to.
var RANDOM_RACES = {
  // What a bare `random` tap means, and the shorter of the two finite lengths
  // the picker offers. A card ends by itself, on a podium.
  DEFAULT: 4,
  // The widest run the display will accept from the wire. 0 is legal and means
  // ENDLESS, so this is a ceiling and not a range check: see normRandomRaces.
  // The picker also wears it as its LONG-CARD option, so the ceiling and the
  // longest run on offer are one number by construction.
  MAX: 8
};

// ---- The presence contract (the relay decides who is connected) ----
// Six numbers that, like STEER above, only mean anything TOGETHER and are read
// by two files in two roles: the phone's ping cadence and chip threshold
// (controller/Net.js), and the display's grace/canary windows (display/Net.js,
// fed straight into the native RoomFlow's liveness config).
//
// PRESENCE IS THE RELAY'S ANSWER, and only the relay's: a seat is connected
// from peer_joined until peer_left, and the display runs no silence detector of
// its own. It used to run one, a 3 s drop window budgeted against the ping
// cadence below, which is why these numbers still read as a set. What that
// second opinion cost was that the display and Party-Sockets could disagree,
// and the relay is the half that owns the room: its cap counts LIVE SOCKETS, so
// a seat the display had dropped on silence still filled a slot, and the
// reconnect QR offered for that seat was answered "Room is full".
//
// It is not free: a locked phone whose socket outlives it reads as PRESENT.
// native/libttp-party/CLAUDE.md carries that cost in full, measured against the
// real relay and pinned by tests/wire-compat.test.js.
//
// These are the WINDOWS, not the timers: setInterval/setTimeout stay with each
// platform's shell, and so does the E2E `window.__abandonGraceMs` override.
// tests/config-drift.test.js pins both files to this block, and
// scripts/gen-protocol-corpus.mjs carries it into the protocol corpus, which
// the `protocol` ctest replays against native/libttp-party/ttp/protocol.h.
var LIVENESS = {
  // PHONE. How often a controller pings the display (MSG.PING). NOT a presence
  // signal: it keeps the relay's own idle timeout from closing an
  // application-quiet socket, and it is the WS-path latency sample.
  PING_INTERVAL_MS: 1000,
  // PHONE. No PONG back inside this window and the latency chip reads "no
  // signal". A phone-side display threshold only — nothing is dropped by it,
  // here or on the big screen. Three missed pings, so one lost packet cannot
  // blink the chip.
  PONG_TIMEOUT_MS: 3000,
  // DISPLAY. The cadence of the display's own tick: the self-heartbeat below,
  // and the abandoned-race deadline. It sweeps no seats.
  TICK_MS: 1000,
  // DISPLAY. The self-heartbeat's deadline: no echo of MSG.HEARTBEAT back from
  // our own slot inside this window means OUR socket is half-dead, so force a
  // reconnect rather than wait for TCP. Wide because with the fastlane carrying
  // inputs the display's socket sees only ~1 Hz of traffic, so this lone canary
  // needs the margin. It is the one liveness detector left, and it watches
  // exactly one socket: our own.
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
  GATE_THRESHOLD: 0.03,
  // WIRE. A steer delta at or past this is a deliberate action rather than
  // drift (5x the noise gate, past the DEADZONE scale): it may interrupt the
  // baseline cadence and go as soon as SEND_MIN_INTERVAL_MS allows. Brake and
  // the use-counter always count as strong — a press must not feel deferred.
  STRONG_THRESHOLD: 0.15,
  // WIRE. Baseline cadence for sub-strong news: an unconfirmed steering change
  // never waits longer than this to reach the wire.
  SEND_INTERVAL_MS: 100,
  // WIRE. Hard floor between ANY two CONTROL sends. Every InputGate tier waits
  // at least this long, so the wire rate is provably bounded at 1000/this
  // msgs/s — sized to the strictest platform message budget in sight
  // (AirConsole allows 25 messages/s).
  SEND_MIN_INTERVAL_MS: 40
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
// Per-model handling stats, parallel to CAR_MODELS. The native engine reads a
// resolved stats object per car; these are the source of truth the display feeds
// in. accel/vmax/turn are MULTIPLIERS on the engine's benchmark; `mass` is
// relative (only the ratio matters when two cars collide); halfLen/halfWid are
// the collision footprint half-extents in WORLD units, measured from the Kenney
// meshes (length×width: racer 0.88×0.53, speedster 0.88×0.56).
//
// The roster is ONE BALANCED CAR plus three specialists, each bad at exactly ONE
// stat. Weight is not a fourth lever: it is DERIVED from accel (carMass below) —
// the weakest launch is the heaviest car — so Rumble's contact strength is the
// flip side of its launch hole, never a separate number to tune.
//
// Hole depth is priced by how often the stat bills, measured flat-out
// (probe_cli --nobrake) because humans drive flat-out:
//   - vmax bills on every meter: its hole is the SHALLOWEST, and ±0.01 here
//     moves packed-race points by whole placings. Touch it last.
//   - turn ("Handling" in the picker) SATURATES flat-out: past holding the line
//     without scrub, extra turn converts poorly — Carve's big number is worth
//     less than linear, Bolt's deep hole is livable. The engine does NOT
//     auto-slow: a low-turn car carrying too much speed washes WIDE into the
//     curb (brake yourself); a grippy one rails the same bend and scrubs less
//     speed steering.
//   - accel bills per RECOVERY (launch, wall hit, knock, spin): nearly free
//     alone, constant in traffic — where the derived mass pays it back, which is
//     what makes Rumble's pairing self-balancing.
//   - the balanced car sits slightly ABOVE baseline: the specialists' packages
//     all net positive, so an exactly-1.0 car finishes last.
// After ANY edit here — or to the engine's base TURN_RATE / STEER_SCRUB, which
// set how much of a lap turn bills — re-run `npm run probe:cars` and judge the
// --nobrake variant of both modes: Bolt should win the flowing tracks solo,
// Carve the twisty ones, Dash the technical middle and never be worst; Rumble
// reads slow ALONE — its value is the scrum, visible only to the packed probe.
function carMass(accel) { return Math.round((1 + 3.3 * (1 - accel)) * 100) / 100; }
var CAR_STATS = [
  { accel: 1.01, vmax: 1.01, turn: 1.01, halfLen: 0.44, halfWid: 0.26 }, // Dash (Low Racer) — the balanced pick: no hole, never punished, never the best
  { accel: 1.02, vmax: 1.06, turn: 0.88, halfLen: 0.44, halfWid: 0.28 }, // Bolt (Speedster) — the fastest: top-speed king, BAD TURN (washes wide in tight corners) and light enough to shove
  { accel: 1.03, vmax: 0.97, turn: 1.24, halfLen: 0.44, halfWid: 0.26 }, // Carve (Racer) — corner king: rails bends, never washes out, BAD VMAX — tops out early on every straight
  { accel: 0.93, vmax: 1.00, turn: 1.05, halfLen: 0.44, halfWid: 0.28 }  // Rumble (Vintage) — the heavy roller: BAD ACCEL (slow launch, slow recovery), heaviest by far — wins every shove, priced for the scrum
].map(function (c) { c.mass = carMass(c.accel); return c; });

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
    RELAY_URL, STUN_URL, STUN_FALLBACK_URL,
    MAX_PLAYERS, FIELD_SIZE, TOTAL_LAPS, COUNTDOWN_SECONDS, SCHEMATIC_EPS, STEER, LIVENESS, RANDOM_RACES,
    CAR_COLORS, CAR_MODELS, CAR_NAMES,
    CAR_STATS, carStats
  };
}
