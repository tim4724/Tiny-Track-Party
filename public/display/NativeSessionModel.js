// NativeSessionModel — the display's edge of the SESSION POLICY, which is C++.
//
// public/display/sessionModel.js's surface, backed by native/runtime/ttp_net.h
// over native/libttp-party/ttp/session.cc. Every room decision DisplayNet used
// to take inline — what the retained snapshot contains, what a new seat starts
// as, what a drop or a LEAVE means in each phase, which car picks and ready
// toggles are refused, when the self-heartbeat says the socket is dead, who may
// claim a dropped seat, what the claim QR's URL looks like — is taken in the
// wasm now. Net.js PERFORMS those answers against the socket, the timers, the
// storage and the RoomFlow, and decides nothing.
//
// WHAT THIS FILE IS ALLOWED TO DO, and it is a short list: name the shell's own
// objects (a roster record, a seat, a chooser payload), turn them into the plain
// JSON the ABI takes, and turn the answer back into what Net.js already expects.
// No rule may live here.
//
// TWO PLACES WHERE THAT SHOWS, and both are about JS values the wire cannot
// spell:
//   * normIndex/claimPlan distinguish an ABSENT rejoinToken from an explicit
//     null — `Number(undefined)` is NaN while `Number(null)` is 0, so an
//     ordinary HELLO claims nothing while one carrying an explicit null claims
//     seat 0. The ABI takes the whole HELLO for exactly that reason, and this
//     file must not "helpfully" default the key.
//   * seatDefaults answers {nameKey:'player_n', nameArg:N}, never the sentence.
//     The copy table is below, next to nothing else that composes English.
//
// public/display/sessionModel.js is GONE — it was the ORACLE, now retired:
// tests/fixtures/session-corpus.jsonl was recorded off it, native/partytest/
// session_check.cc replays every step through the C++ on all four legs, and
// runtimetest/abi_check.cc replays the same corpus through the C boundary this
// file calls. A disagreement between them is a bug in the port, never in the
// corpus. Nothing that ships imports it.

import { loadNativeRuntime } from './nativeRuntime.js';

let fn = null;

export async function init() {
  if (fn) return;
  const M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    configure: c('ttp_net_configure', 'number', ['string']),
    rosterRows: c('ttp_net_roster_rows_json', 'string', ['string', 'string']),
    lobbySnapshot: c('ttp_net_lobby_snapshot_json', 'string', ['string']),
    joinUrl: c('ttp_net_join_url', 'string', ['string', 'string', 'string']),
    claimUrl: c('ttp_net_claim_url', 'string', ['string', 'number']),
    controllerUrlTemplate: c('ttp_net_controller_url_template', 'string', ['string']),
    normIndex: c('ttp_net_norm_index_json', 'string', ['string']),
    seatDefaults: c('ttp_net_seat_defaults_json', 'string', ['number']),
    addPeerPlan: c('ttp_net_add_peer_plan_json', 'string', ['number', 'number', 'number', 'number']),
    presenceAction: c('ttp_net_presence_action', 'string', ['string']),
    leaveAction: c('ttp_net_leave_action', 'string', ['string']),
    reconnectCard: c('ttp_net_reconnect_card_json', 'string', ['string', 'string']),
    inboundRoute: c('ttp_net_inbound_route', 'string', ['number', 'string']),
    messageAction: c('ttp_net_message_action', 'string', ['string']),
    setCar: c('ttp_net_set_car', 'number', ['number', 'string', 'number', 'string', 'number']),
    setReady: c('ttp_net_set_ready', 'number', ['number', 'string', 'number', 'number']),
    stateChange: c('ttp_net_state_change_json', 'string', ['string']),
    hostChange: c('ttp_net_host_change_json', 'string', []),
    heartbeatTick: c('ttp_net_heartbeat_tick_json', 'string', ['number', 'number', 'number', 'number']),
    claimPlan: c('ttp_net_claim_plan_json', 'string', ['string', 'number', 'number', 'number']),
    resyncPlan: c('ttp_net_resync_plan_json', 'string', ['string', 'string'])
  };
}

const J = JSON.stringify;
const b = (x) => (x ? 1 : 0);

// The seat-name copy table. It is one line and it is HERE rather than in C++
// because a default name is user-facing copy: the model answers with a key and
// its number (decision D4), and every shell fills it from its own table.
const SEAT_NAME = { player_n: (n) => 'Player ' + n };
function seatName(d) { return (SEAT_NAME[d.nameKey] || ((n) => String(n)))(d.nameArg); }

// The chooser content every room snapshot carries — cars and colours always,
// the bulky reduced track schematics lobby-only. Opaque to the model, set ONCE
// because it is authored data that changes when the game ships, not while it
// runs.
export function configure({ cars, colors, tracks }) {
  const ok = fn.configure(J({ cars: cars || [], colors: colors || [], tracks: tracks || [] }));
  if (!ok) throw new Error('[net] the chooser payload was rejected by the native session model');
}

// ---- the retained room snapshot --------------------------------------------
// `roster` is RoomFlow's own list and `inRace` a parallel array of the game
// layer's answers, so nothing crosses as a callback.
export function rosterRows(roster, inRace) {
  return JSON.parse(fn.rosterRows(J(roster), J(inRace)));
}

// The whole LOBBY_UPDATE object, chooser included. Its KEY ORDER is the wire's
// and survives JSON.parse here (JS objects keep insertion order for these keys),
// so the bytes the relay retains are the ones the C++ wrote.
export function lobbySnapshot(input) {
  return JSON.parse(fn.lobbySnapshot(J(input)));
}

// ---- URLs -------------------------------------------------------------------
export function joinUrl(base, room, instance) {
  return fn.joinUrl(base, room, instance == null ? '' : instance);
}
export function claimUrl(url, peerIndex) {
  return fn.claimUrl(url, peerIndex);
}
// null means REGISTER NONE — the relay rejects the whole create on an invalid
// template, so a plain-http origin must send no key at all.
export function controllerUrlTemplate(base) {
  const t = fn.controllerUrlTemplate(base);
  return t === '' ? null : t;
}

// ---- seats -------------------------------------------------------------------
// The plan for a peer_joined (or a HELLO from someone we never seated): the seat
// record to add, or null, plus whether to stamp its liveness. The name is
// composed HERE, from the key the model answered with.
export function addPeerPlan({ has, size, maxPlayers, colorIndex }) {
  const plan = JSON.parse(fn.addPeerPlan(b(has), size, maxPlayers, colorIndex));
  if (!plan.seat) return { seat: null, stamp: plan.stamp };
  const d = plan.seat;
  return {
    seat: { name: seatName(d), colorIndex: d.colorIndex, carIndex: d.carIndex, ready: d.ready },
    stamp: plan.stamp
  };
}
export function presenceAction(roomState) { return fn.presenceAction(roomState || ''); }
export function leaveAction(roomState) { return fn.leaveAction(roomState || ''); }
export function reconnectCard(seat, url) {
  return JSON.parse(fn.reconnectCard(
    J({ peerIndex: seat.peerIndex, name: seat.name, colorIndex: seat.colorIndex }), url));
}

// ---- controller messages ------------------------------------------------------
export function inboundRoute(from, type) { return fn.inboundRoute(from, type == null ? '' : String(type)); }
export function messageAction(type) { return fn.messageAction(type == null ? '' : String(type)); }

// carIndex crosses as its RAW JSON so the integer check can refuse a string or a
// boolean rather than coerce it — this is untrusted input from a phone.
export function setCarDecision({ ready, roomState, inRace, carIndex, carCount }) {
  return !!fn.setCar(b(ready), roomState || '', b(inRace),
    J(carIndex === undefined ? null : carIndex), carCount);
}
export function setReadyDecision({ isHost, roomState, ready, current }) {
  return !!fn.setReady(b(isHost), roomState || '', b(ready), b(current));
}

// ---- room-state transitions ----------------------------------------------------
export function stateChangePlan(to) { return JSON.parse(fn.stateChange(to || '')); }
export function hostChangePlan() { return JSON.parse(fn.hostChange()); }

// ---- liveness --------------------------------------------------------------------
export function heartbeatTick({ inRoom, hbPending, hbSentAt, now }) {
  return JSON.parse(fn.heartbeatTick(b(inRoom), b(hbPending), hbSentAt || 0, now));
}

// ---- claims + reconciliation --------------------------------------------------------
// The WHOLE HELLO crosses, not just the token: an absent rejoinToken and an
// explicit null answer differently, and only the message itself can tell them
// apart. JSON.stringify drops an undefined value, which is precisely the
// distinction being preserved.
export function claimPlan({ hello, fromId, hasOld, oldDisconnected }) {
  return JSON.parse(fn.claimPlan(J(hello || {}), fromId, b(hasOld), b(oldDisconnected)));
}

// The rejoinToken of a HELLO as a seat index, or null. Reads the KEY, not the
// value, for the reason above: an empty argument is JS `undefined` and the
// string "null" is an explicit null, and the two do not answer the same.
//
// It exists because claimPlan needs the caller to have already asked the roster
// about the seat the token names, which the caller cannot do without normalizing
// it first. Same rule, same C++, one extra crossing on a HELLO.
export function normIndexOf(hello) {
  const present = hello && typeof hello === 'object' && hello.rejoinToken !== undefined;
  return JSON.parse(fn.normIndex(present ? J(hello.rejoinToken) : ''));
}
export function resyncPlan(rosterIds, relayPeers) {
  return JSON.parse(fn.resyncPlan(J(rosterIds), J(relayPeers)));
}
