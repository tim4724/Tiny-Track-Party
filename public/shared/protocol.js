'use strict';

// ============================================================================
// Tiny Track Party — wire contract shared by display and controllers.
// This file is GAME-SIDE config (not part of the partyplug kit): the relay/STUN
// deployment URLs and this game's message vocabulary live here and are injected
// into the kit at construction. The kit reads none of these globals.
// ============================================================================

// Party-Server relay URL (signaling + game-event fallback).
var RELAY_URL = 'wss://ws.couch-games.com';

// STUN server for the WebRTC fastlane to gather server-reflexive candidates so
// cross-network peers connect when host candidates aren't reachable. STUN is
// UDP and not subject to CSP connect-src (browsers ignore the `stun:` scheme
// there). On the same LAN, host candidates work even without STUN.
// TODO(confirm): verify stun.couch-games.com:3478 exists; the connection glue
// also lists a public STUN fallback so cross-network play degrades gracefully.
var STUN_URL = 'stun:stun.couch-games.com:3478';

// Message types carried inside the Party-Server `data` field. Every message is
// a plain object with a `.type` drawn from here.
var MSG = {
  // Controller -> Display
  HELLO: 'hello',               // {name?, rejoinToken?} sent right after join — rejoinToken claims a dropped seat (cross-device reconnect, from the QR's ?claim=)
  CONTROL: 'control',           // {s: steer[-1,1], b: brake[0,1], u: ACTION use-counter[0-255, wrapping]} — hot path, ~25Hz, fastlane
  START_GAME: 'start_game',     // host only
  RETURN_TO_LOBBY: 'return_to_lobby', // "New game" — abort the race back to the lobby (any player)
  PAUSE_GAME: 'pause_game',     // request a pause (any player, mid-countdown/race)
  RESUME_GAME: 'resume_game',   // request resume from the pause overlay
  SET_CAR: 'set_car',           // {carIndex} — chosen car model in lobby (livery is auto-assigned)
  SELECT_TRACK: 'select_track', // {trackId} — host picks the race track in the lobby
  LEAVE: 'leave',               // intentional exit (back-out) — display frees the seat at once (no reconnect QR)
  PING: 'ping',

  // Display -> specific controller
  WELCOME: 'welcome',           // {peerIndex, roomState, tracks, trackId, ...} on join
  LOBBY_UPDATE: 'lobby_update', // roster/host/color snapshot (+ trackId)
  PLAYER_STATE: 'player_state', // {lap, totalLaps, position, of, finished, item, boost} — item lights the controller's USE button
  PONG: 'pong',

  // Display -> all controllers (broadcast)
  COUNTDOWN: 'countdown',       // {n} 3..2..1..GO
  GAME_START: 'game_start',
  STANDINGS: 'standings',       // {over, hostPeerIndex, total, order:[{playerId,name,colorIndex,ai,finished,time}]}
                                // pushed as each car finishes (over=false) + at race end (over=true) — drives the phone results overlay
  GAME_END: 'game_end',         // {results} — sent on return-to-lobby; controllers go back to the lobby
  GAME_PAUSED: 'game_paused',   // race frozen — controllers show the pause overlay
  GAME_RESUMED: 'game_resumed'  // race resumed — controllers hide the pause overlay
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
  'vehicle-racer', 'vehicle-speedster', 'vehicle-drag-racer', 'vehicle-racer-low',
  'vehicle-vintage-racer', 'vehicle-suv', 'vehicle-truck', 'vehicle-monster-truck'
];
var CAR_NAMES = [
  'Racer', 'Speedster', 'Drag Racer', 'Low Racer',
  'Vintage', 'SUV', 'Truck', 'Monster'
];
// Extra Y-rotation (radians) per model, for any model whose mesh faces the wrong
// way after SceneRenderer's base half-turn (most Kenney vehicles face -Z, so the
// renderer turns them to +Z). Every model currently faces correctly, so this is
// all zeros — kept as a per-model hook. Applied in-race (SceneRenderer) and when
// baking the car thumbnails, so the picker preview matches the racing car.
var CAR_MODEL_YAW = [0, 0, 0, 0, 0, 0, 0, 0];

// Per-model handling stats, parallel to CAR_MODELS. The engine (Game.js) reads a
// resolved stats object per car; these are the source of truth the display feeds
// in. accel/vmax/turn are MULTIPLIERS on the engine's benchmark (1 = the "Racer"
// baseline); `mass` is relative (only the ratio matters when two cars collide);
// halfLen/halfWid are the collision footprint half-extents in WORLD units,
// measured from the Kenney meshes (length×width: racer 0.88×0.53, drag 1.34×0.59,
// monster 0.88×0.63). `turn` is the "Handling" stat shown in the picker — the car's
// turn rate, which sets its max corner speed: the engine does NOT auto-slow, so a
// low-handling car that carries too much speed simply can't yaw fast enough and
// washes WIDE (understeer) into the curb — you must brake yourself. A grippy car
// rails the same bend much faster. So the spread here is deliberately wide. Heavy
// cars win every bump but pay for it in accel + cornering — weight is a real trade.
// Tuned for the gentle OVAL; revisit when tighter tracks land.
var CAR_STATS = [
  // accel, vmax, turn(=handling), mass — max holdable corner speed ≈ turn·9 u/s on the oval's tightest bend.
  { accel: 1.00, vmax: 1.00, turn: 1.00, mass: 1.00, halfLen: 0.44, halfWid: 0.26 }, // Racer — the benchmark (~7.0 u/s in the tightest corner)
  { accel: 0.92, vmax: 1.12, turn: 1.10, mass: 0.85, halfLen: 0.44, halfWid: 0.28 }, // Speedster — fastest top end, nimble, light (shoved easily)
  { accel: 1.30, vmax: 1.10, turn: 0.74, mass: 1.05, halfLen: 0.67, halfWid: 0.29 }, // Drag Racer — rocket launch + top end, must brake hard for corners, long
  { accel: 1.06, vmax: 0.97, turn: 1.32, mass: 0.80, halfLen: 0.44, halfWid: 0.26 }, // Low Racer — corner carver, takes the tightest bend nearly flat-out
  { accel: 0.85, vmax: 0.90, turn: 1.00, mass: 0.90, halfLen: 0.44, halfWid: 0.28 }, // Vintage — gentle all-rounder, forgiving
  { accel: 0.95, vmax: 1.00, turn: 0.84, mass: 1.30, halfLen: 0.44, halfWid: 0.26 }, // SUV — heavy, average pace, must ease off in corners
  { accel: 0.88, vmax: 0.96, turn: 0.76, mass: 1.50, halfLen: 0.44, halfWid: 0.26 }, // Truck — heavy hauler, shoves hard, ponderous in corners
  { accel: 1.00, vmax: 0.95, turn: 0.70, mass: 1.75, halfLen: 0.44, halfWid: 0.32 }  // Monster — heaviest bully, widest, has to crawl through corners
];

// Resolve a carIndex to its stats (wraps the array; null/garbage → the Racer
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
    MAX_PLAYERS, TOTAL_LAPS, COUNTDOWN_SECONDS, CAR_COLORS, CAR_MODELS, CAR_NAMES, CAR_MODEL_YAW,
    CAR_STATS, carStats
  };
}
