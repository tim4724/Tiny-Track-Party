'use strict';

// ============================================================================
// ToyCar — wire contract shared by display and controllers.
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
  HELLO: 'hello',               // {name?} sent right after join
  CONTROL: 'control',           // {s: steer[-1,1], b: brake(bool)} — hot path, ~25Hz, fastlane
  START_GAME: 'start_game',     // host only
  PLAY_AGAIN: 'play_again',     // host only
  RETURN_TO_LOBBY: 'return_to_lobby',
  SET_COLOR: 'set_color',       // {colorIndex} — car livery in lobby
  SET_NAME: 'set_name',         // {name}
  SET_DISPLAY_MUTE: 'set_display_mute',
  LEAVE: 'leave',
  PING: 'ping',

  // Display -> specific controller
  WELCOME: 'welcome',           // {peerIndex, roomState, ...} on join
  LOBBY_UPDATE: 'lobby_update', // roster/host/color snapshot
  PLAYER_STATE: 'player_state', // {lap, totalLaps, position, of, speed, finished}
  PONG: 'pong',

  // Display -> all controllers (broadcast)
  COUNTDOWN: 'countdown',       // {n} 3..2..1..GO
  GAME_START: 'game_start',
  GAME_END: 'game_end',         // {results}
  DISPLAY_MUTED: 'display_muted',
  DISPLAY_CLOSED: 'display_closed',
  ERROR: 'error'
};

// Message types that ride the low-latency WebRTC fastlane (unreliable, unordered,
// latest-wins). Only idempotent, latest-state-wins inputs belong here.
var FASTLANE_TYPES = { control: true };

// Discrete input actions (reserved; v1 steering/braking is analog via CONTROL).
var INPUT = {};

// Room states (must match partyplug RoomFlow.STATES; asserted at display boot).
var ROOM_STATE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  RESULTS: 'results'
};

// ---- Game constants (shared so display + controller agree) ----
var MAX_PLAYERS = 8;
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

// Export for both Node.js and browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MSG, INPUT, FASTLANE_TYPES, ROOM_STATE,
    RELAY_URL, STUN_URL,
    MAX_PLAYERS, TOTAL_LAPS, COUNTDOWN_SECONDS, CAR_COLORS
  };
}
