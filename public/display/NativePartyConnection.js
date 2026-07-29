// NativePartyConnection — partyplug/PartyConnection.js's surface, with every
// DECISION delegated to the native party layer (ttp_party.h framing entry points)
// and only the I/O left in JS.
//
// The split, concretely:
//   JS keeps  : the WebSocket itself, reconnect timers, clientId generation.
//   C++ decides: what JSON goes on the wire (encode_*), what an inbound frame
//                means (classify), what a close code implies (close_outcome),
//                how long to back off (backoff_ms), the sharded URL (pin_url).
//
// Inbound text is handed to the ABI UNPARSED — JS never JSON.parses a relay
// frame here, so the classification (including "not an object, drop it") is the
// ported code's call, not a JS paraphrase of it.
//
// The only implementation. Conformance is the framing corpus, replayed against
// the C++ objects (framing_check) and through this ABI (tests/party-abi.test.js);
// this file's job is wiring parity with the kit's socket lifecycle.

import { loadNativeRuntime } from './nativeRuntime.js';

let M = null;
let fn = null;

export async function init() {
  if (M) return;
  M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    encCreate: c('ttp_framing_encode_create', 'string', ['string', 'number', 'string']),
    encJoin: c('ttp_framing_encode_join', 'string', ['string', 'string']),
    encSendTo: c('ttp_framing_encode_send_to', 'string', ['string', 'string']),
    encBroadcast: c('ttp_framing_encode_broadcast', 'string', ['string']),
    encSetState: c('ttp_framing_encode_set_state', 'string', ['string']),
    encCloseRoom: c('ttp_framing_encode_close_room', 'string', []),
    classify: c('ttp_framing_classify', 'string', ['string']),
    closeOutcome: c('ttp_framing_close_outcome', 'string', ['number', 'number', 'number', 'number', 'number']),
    backoffMs: c('ttp_framing_backoff_ms', 'number', ['number']),
    pinUrl: c('ttp_framing_pin_url', 'string', ['string', 'string', 'string'])
  };
}

// base + '/' + enc(room) + '?instance=' + enc(instance), or `base` unchanged
// when there is no instance — ttp::framing::pin_instance_url, which the
// framing-corpus `pin` cases already gate.
//
// It is exported because DISPLAY BOOT needs it before there is a connection to
// call pinInstance on: reopening a saved room dials the shard directly, and
// display/Net.js used to build that same string by hand eleven lines above the
// call that asks C++ for it. One string, one implementation.
export function pinUrl(base, room, instance) {
  if (!fn) throw new Error('NativePartyConnection: init() not awaited');
  return fn.pinUrl(base, room, instance || '');
}

export class NativePartyConnection {
  constructor(relayUrl, options) {
    if (!fn) throw new Error('NativePartyConnection: init() not awaited');
    this.relayUrl = relayUrl;
    this.clientId = (options && options.clientId) || NativePartyConnection._genClientId();
    this.ws = null;
    this._reconnectTimer = null;
    this._shouldReconnect = true;
    this.maxReconnectAttempts = (options && options.maxReconnectAttempts) || 5;
    this.reconnectAttempt = 0;

    this.onOpen = null;
    this.onClose = null;
    this.onError = null;
    this.onMessage = null;
    this.onProtocol = null;
    this.onState = null;
  }

  // Identity generation is not logic worth porting (no rules, just entropy).
  static _genClientId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return 'pc-' + crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    return 'pc-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }

  connect() {
    this._discardOldWs();
    this._shouldReconnect = true;
    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;             // stale
      if (this.onOpen) this.onOpen();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;             // stale
      // The ABI classifies the RAW text: route + payload, or 'none' to drop.
      const r = JSON.parse(fn.classify(String(event.data)));
      if (r.route === 'message') {
        if (this.onMessage) this.onMessage(r.from, r.data);
      } else if (r.route === 'state') {
        if (this.onState) this.onState(r.data);
      } else if (r.route === 'protocol') {
        if (this.onProtocol) this.onProtocol(r.type ?? undefined, r.msg);
      }
      // 'none' — not a JSON object; dropped, exactly as the kit does.
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;             // stale — replaced by reconnectNow
      const hasCode = !!(event && typeof event.code === 'number');
      this._applyClose(hasCode, hasCode ? event.code : 0);
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      if (this.onError) this.onError();
    };
  }

  // One decision point for every close-ish event: the ABI says whether to stop
  // reconnecting, what to report, and whether to schedule a retry.
  _applyClose(hasCode, code) {
    const o = JSON.parse(fn.closeOutcome(
      hasCode ? 1 : 0, code, this.reconnectAttempt, this.maxReconnectAttempts,
      this._shouldReconnect ? 1 : 0));
    if (o.stopReconnect) this._shouldReconnect = false;
    // closeAttempt/closeMax are 0 for the terminal codes, matching the kit.
    this.reconnectAttempt = o.closeAttempt;
    if (this.onClose) this.onClose(o.closeAttempt, o.closeMax, o.meta ?? undefined);
    if (o.willReconnect) this._scheduleReconnect();
  }

  _discardOldWs() {
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch (_) {}
    }
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    const delay = fn.backoffMs(this.reconnectAttempt);
    this._reconnectTimer = setTimeout(() => { this.connect(); }, delay);
  }

  // The encoders return the exact text to put on the wire.
  _sendText(text) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(text);
  }

  create(maxClients, url) {
    this._sendText(fn.encCreate(this.clientId, maxClients, url || null));
  }

  join(room) {
    this._sendText(fn.encJoin(this.clientId, room));
  }

  pinInstance(baseUrl, room, instance) {
    if (!instance) return;
    this.relayUrl = fn.pinUrl(baseUrl, room, instance);
  }

  sendTo(to, data) {
    this._sendText(fn.encSendTo(JSON.stringify(to ?? null), JSON.stringify(data ?? null)));
  }

  broadcast(data) {
    this._sendText(fn.encBroadcast(JSON.stringify(data ?? null)));
  }

  setState(data) {
    this._sendText(fn.encSetState(JSON.stringify(data ?? null)));
  }

  // The same publish, when the frame was ALREADY built in C++
  // (ttp_net_lobby_frame). Put the bytes on the socket and touch nothing.
  //
  // A SECOND METHOD rather than a smarter setState, because a JSON string is
  // itself a legal set_state payload — there is no way to sniff "already
  // encoded" from "a string to encode", and guessing would silently publish a
  // quoted blob the phones cannot read. setState keeps the kit's exact object
  // contract (wire-compat asserts it against the real kit, undefined-coercion
  // included); this is the display's own path and says so.
  setStateFrame(frameText) {
    if (frameText) this._sendText(frameText);
  }

  closeRoom() {
    this._sendText(fn.encCloseRoom());
  }

  reconnectNow() {
    clearTimeout(this._reconnectTimer);
    this.connect();
  }

  // A socket that opened but never got a create/join answer never fires onclose;
  // this drives the same budgeted-retry decision as a codeless close.
  failAttempt() {
    if (!this._shouldReconnect) return;
    this._discardOldWs();
    this._applyClose(false, 0);
  }

  resetReconnectCount() { this.reconnectAttempt = 0; }

  close() {
    this._shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    this._discardOldWs();
  }

  get connected() { return !!(this.ws && this.ws.readyState === 1); }
}
