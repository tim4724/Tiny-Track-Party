// NativeSessionModel — the display's edge of the SESSION POLICY and its
// CHOREOGRAPHY, which are C++.
//
// Backed by native/runtime/ttp_net.h over native/libttp-party/ttp/session.cc.
// Since the walk entry points landed (ttp_net_on_*), DisplayNet no longer
// sequences the fine-grained rules itself: every inbound trigger crosses ONCE,
// the room mutations happen inside the wasm, and an ordered effect list comes
// back for Net.js to perform. This file names the shell's own objects (a peer
// message, the current pick, a seat), turns them into the plain JSON the ABI
// takes, and hands the answers back RAW — Net.js owns the one parse, because
// its hot path (_seen) wants to compare bytes before paying for it.
//
// No rule may live here. The fine-grained one-rule exports this file once
// wrapped are gone from the ABI: the walks are the only spelling, the frozen
// session corpus replays the rules at the C++ level (session_check), and
// abi_check holds each walk to the same rules composed in-test.
//
// public/display/sessionModel.js is GONE — it was the ORACLE, now retired:
// tests/fixtures/session-corpus.jsonl was recorded off it, native/partytest/
// session_check.cc replays every step through the C++ on all four legs, and
// runtimetest/abi_check.cc replays the same corpus through the C boundary.
// A disagreement between them is a bug in the port, never in the corpus.

import { loadNativeRuntime, nativeError } from './nativeRuntime.js';

let fn = null;

export async function init() {
  if (fn) return;
  const M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    configure: c('ttp_net_configure', 'number', ['string']),
    effectOps: c('ttp_net_effect_ops_json', 'string', []),
    lobbyFrame: c('ttp_net_lobby_frame', 'string', ['number', 'number', 'string']),
    joinUrl: c('ttp_net_join_url', 'string', ['string', 'string', 'string', 'string']),
    claimUrl: c('ttp_net_claim_url', 'string', ['string', 'number']),
    controllerUrlTemplate: c('ttp_net_controller_url_template', 'string', ['string', 'string']),
    reconnectCard: c('ttp_net_reconnect_card_json', 'string', ['string', 'string']),
    // The choreography walks: room-handle-taking, mutate inside the wasm,
    // answer {"effects":[...]} (+ needDraw on a mode pick).
    restoreRoom: c('ttp_net_restore_room', null, ['number', 'string', 'string']),
    onOpen: c('ttp_net_on_open_json', 'string', ['number']),
    createTimeout: c('ttp_net_create_timeout_json', 'string', ['number']),
    onProtocol: c('ttp_net_on_protocol_json', 'string', ['number', 'string', 'string', 'number']),
    onClose: c('ttp_net_on_close_json', 'string', ['number', 'number']),
    onPeerMessage: c('ttp_net_on_peer_message_json', 'string',
      ['number', 'number', 'string', 'string', 'number', 'number']),
    controllerAction: c('ttp_net_controller_action', 'string',
      ['number', 'number', 'string', 'string']),
    setTrack: c('ttp_net_set_track_json', 'string', ['number', 'string']),
    initPick: c('ttp_net_init_pick', null, ['number', 'string', 'number', 'number']),
    clearPick: c('ttp_net_clear_pick', null, ['number']),
    pickJson: c('ttp_net_pick_json', 'string', ['number']),
    liveness: c('ttp_net_liveness_json', 'string', ['number', 'number', 'number']),
    onSeen: c('ttp_net_on_seen_json', 'string', ['number', 'string', 'number']),
    hostChangeApply: c('ttp_net_host_change_apply_json', 'string', ['number', 'string']),
    stateChangeApply: c('ttp_net_state_change_apply_json', 'string', ['number', 'string', 'number'])
  };
}

const J = JSON.stringify;

// A peer id crosses the ABI as a JSON scalar (numeric 3 vs the string "3" are
// distinct room keys, exactly as in JS).
const idJson = (v) => J(v === undefined ? null : v);

// The chooser content every room snapshot carries — cars and colours always,
// the bulky reduced track schematics lobby-only. Opaque to the snapshot
// composition, set ONCE because it is authored data that changes when the game
// ships, not while it runs. The MODE PICK walk reads `tracks` as its catalogue.
// The walks' whole effect vocabulary — Net.js proves its performer switch
// total at boot, so a missing arm fails the load instead of dropping a step.
export function effectOps() { return JSON.parse(fn.effectOps()); }

export function configure({ cars, colors, tracks, progress }) {
  const ok = fn.configure(J({
    cars: cars || [], colors: colors || [], tracks: tracks || [],
    // The couch's progression rides as a fourth key when the shell composed
    // one (boot.progressChooser); absent, the snapshot simply carries none —
    // the bagless/test surfaces predate progression and stay byte-identical.
    ...(progress ? { progress } : {})
  }));
  if (!ok) throw nativeError('configuring the chooser payload');
}

// ---- the retained room snapshot --------------------------------------------
// THE WHOLE LOBBY_UPDATE, COMPOSED AND FRAMED IN C++. The shell's part is two
// handles and the six fields only the game knows; the answer is the exact frame
 // TEXT for the socket. There is deliberately no parse here — a caller that
// wants to look inside is asking for the snapshot, not the frame, and should
// say so.
//
// KEY ORDER IS NOT THE WIRE'S, whatever the shape of the ABI suggests: the
// frame encoder canonicalizes every outbound frame, so what the relay retains
// is the SORTED object and always has been. The ordered emitter earns its keep
// at the ABI boundary, where abi_check pins bytes against corpora recorded off
// a JS oracle that emitted insertion order.
export function lobbyFrame(roomHandle, sessionHandle, fields) {
  return fn.lobbyFrame(roomHandle | 0, sessionHandle | 0, J(fields));
}

// ---- URLs -------------------------------------------------------------------
// This shell's `cpp` value (CouchPad CONTRACT §6): a browser-based display. It
// is what tells the launcher which box a room is on, and the URL is the only
// place it can say so — so it goes on the QR and on the registered template
// alike, and reaches a typed-code, nearby or rejoin arrival through the relay.
// tvOS and Android TV are sibling shells with their own value; this one is the
// web display's, which is why it lives here and not in the wasm.
const CP_PLATFORM = 'web';

export function joinUrl(base, room, instance) {
  return fn.joinUrl(base, room, instance == null ? '' : instance, CP_PLATFORM);
}
export function claimUrl(url, peerIndex) {
  return fn.claimUrl(url, peerIndex);
}
// null means REGISTER NONE — the relay rejects the whole create on an invalid
// template, so a plain-http origin must send no key at all.
export function controllerUrlTemplate(base) {
  const t = fn.controllerUrlTemplate(base, CP_PLATFORM);
  return t === '' ? null : t;
}

// The dropped-seat card payload {peerIndex,name,colorIndex,url} — the seat as
// the show-reconnect effect carried it, plus the claim URL only this shell can
// compose (D3: it needs the platform's base origin).
export function reconnectCard(seat, url) {
  return JSON.parse(fn.reconnectCard(
    J({ peerIndex: seat.peerIndex, name: seat.name, colorIndex: seat.colorIndex }), url));
}

// ---- the choreography walks -------------------------------------------------
// Raw-string answers, deliberately: Net.js._walk owns the single JSON.parse,
// and the _seen hot path skips it on the shared empty answer. The peer message
// and the current pick cross as the shell's own objects; JSON.stringify keeps
// the absent-vs-null distinction the claim logic turns on (an absent
// rejoinToken drops out of the message text, exactly as the wasm expects).

export function restoreRoom(roomHandle, code, instance) {
  fn.restoreRoom(roomHandle | 0, code || '', instance || '');
}
export function onOpen(roomHandle) { return fn.onOpen(roomHandle | 0); }
export function createTimeout(roomHandle) { return fn.createTimeout(roomHandle | 0); }
export function onProtocol(roomHandle, type, msg, nowMs) {
  return fn.onProtocol(roomHandle | 0, type || '', J(msg || {}), nowMs);
}
export function onClose(roomHandle, roomClosed) {
  return fn.onClose(roomHandle | 0, roomClosed ? 1 : 0);
}
export function onPeerMessage(roomHandle, sessionHandle, from, msg, isSignal, nowMs) {
  return fn.onPeerMessage(roomHandle | 0, sessionHandle | 0, idJson(from), J(msg || {}),
    isSignal ? 1 : 0, nowMs);
}
// The verdict on a game message, gates included (host, all-ready, live race).
// CONTROL never comes through here on this shell — see main.js's short-circuit.
export function controllerAction(roomHandle, sessionHandle, from, type) {
  return fn.controllerAction(roomHandle | 0, sessionHandle | 0, idJson(from), type || '');
}
export function setTrack(roomHandle, trackId) {
  return fn.setTrack(roomHandle | 0, trackId == null ? '' : String(trackId));
}
// The stored pick's lifecycle — the walks write it, these three touch it from
// the shell's edge: the constructor rule, End party's reset, and the read.
export function initPick(roomHandle, defaultTrackId, hasBag, bagSeed) {
  fn.initPick(roomHandle | 0, defaultTrackId == null ? null : String(defaultTrackId),
    hasBag ? 1 : 0, bagSeed >>> 0);
}
export function clearPick(roomHandle) { fn.clearPick(roomHandle | 0); }
export function pick(roomHandle) { return JSON.parse(fn.pickJson(roomHandle | 0)); }
export function liveness(roomHandle, sessionHandle, nowMs) {
  return fn.liveness(roomHandle | 0, sessionHandle | 0, nowMs);
}
export function onSeen(roomHandle, peerIndex, nowMs) {
  return fn.onSeen(roomHandle | 0, idJson(peerIndex), nowMs);
}
export function hostChangeApply(roomHandle, hostPeerIndex) {
  return fn.hostChangeApply(roomHandle | 0, idJson(hostPeerIndex));
}
export function stateChangeApply(roomHandle, to, nowMs) {
  return fn.stateChangeApply(roomHandle | 0, to || '', nowMs);
}
