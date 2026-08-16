// A HEADLESS PHONE: the controller's half of the wire, as a Node client.
//
// It exists because the tvOS shell has a gap nothing else in the tree can see.
// `tests/wire-compat/` drives the SHIPPED WASM through the display's own JS
// adapters against the real JS controller — that covers the C++ and the phone,
// and it is the permanent gate for both. What it cannot cover is a SWIFT shell:
// PartyNet, the room lifecycle it performs, and the payloads it composes are not
// on that path at all, and the frozen session corpus replays recorded JS rather
// than a live peer.
//
// So this is deliberately NOT a second implementation of the controller. It
// speaks the vocabulary out of the protocol manifest (never a literal), sends
// what `public/controller/Net.js` sends, and reads only what
// `public/controller/main.js` reads. Everything it asserts is a fact about the
// DISPLAY under test, never about itself.
//
// It talks to a REAL relay, because the thing being tested is a real socket
// against a real room machine on real hardware. The stub in `tests/e2e/` is
// deliberately permissive and would not reproduce the frames that break a party.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/// The message vocabulary, read from the same manifest the shells read. A
/// literal here would be a fourth copy of the fact `protocol.js` exists to be
/// the only source of.
export async function loadProtocol() {
  const mod = await import(join(ROOT, 'public/display/engine/native/ttp_runtime.mjs'));
  const M = await mod.default();
  return JSON.parse(M.cwrap('ttp_protocol_manifest_json', 'string', [])());
}

export class Phone {
  constructor(proto, { name = 'Probe', relay = null } = {}) {
    this.proto = proto;
    this.name = name;
    this.relayURL = relay || proto.RELAY_URL;
    this.clientId = 'phone-' + Math.random().toString(36).slice(2);
    this.peerIndex = null;
    this.snapshot = null;        // the retained host snapshot (LOBBY_UPDATE)
    this.fromDisplay = [];       // every direct message the display sent us
    this.relayErrors = [];
    this.closed = null;          // {code} once the socket closes
    this._waiters = [];
  }

  async join(room, { timeout = 10000 } = {}) {
    this.room = room;
    this.ws = new WebSocket(this.relayURL);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error(`cannot reach ${this.relayURL}`));
      setTimeout(() => rej(new Error('relay connect timed out')), timeout);
    });
    this.ws.onclose = (ev) => { this.closed = { code: ev.code }; this._pump(); };
    this.ws.onmessage = (ev) => this._onText(ev.data);
    this._send({ type: 'join', clientId: this.clientId, room });
    return this.waitFor(() => this.peerIndex != null || this.relayErrors.length,
      'join to be answered', timeout);
  }

  /// The HELLO handshake. `rejoinToken` is deliberately passed through as given
  /// (including `undefined`) — absent and null are DIFFERENT on the wire, and
  /// `session.h`'s norm_index freezes that asymmetry on purpose.
  hello(rejoinToken) {
    const msg = { type: this.proto.MSG.HELLO, name: this.name };
    if (rejoinToken !== undefined) msg.rejoinToken = rejoinToken;
    this.sendToDisplay(msg);
  }

  setCar(carIndex, colorIndex) {
    this.sendToDisplay({ type: this.proto.MSG.SET_CAR, carIndex, colorIndex });
  }

  setReady(ready) {
    this.sendToDisplay({ type: this.proto.MSG.SET_READY, ready });
  }

  selectMode(payload) {
    this.sendToDisplay({ type: this.proto.MSG.SELECT_MODE, ...payload });
  }

  startGame() {
    this.sendToDisplay({ type: this.proto.MSG.START_GAME });
  }

  leave() {
    this.sendToDisplay({ type: this.proto.MSG.LEAVE });
  }

  /// One steering sample: `s` steer (-1..1), `b` brake, `u` a rising counter the
  /// display's gate reads. The real controller sends these through `InputGate`,
  /// which drops samples the display already holds — that gating is the PHONE's
  /// and is covered by `tests/wire-fastlane.test.js`, so nothing here reproduces
  /// it. This is the raw wire shape, sent every time.
  control({ s = 0, b = 0 } = {}) {
    this._u = (this._u ?? 0) + 1;
    this.sendToDisplay({ type: this.proto.MSG.CONTROL, s, b, u: this._u });
  }

  /// Hold the wheel for `ms`, sampling at roughly the controller's own rate.
  /// `steer` may be a function of elapsed time, so a caller can weave.
  async drive(ms, steer = () => 0) {
    const started = Date.now();
    this._driving = true;
    while (this._driving && Date.now() - started < ms) {
      this.control({ s: steer(Date.now() - started) });
      await new Promise((r) => setTimeout(r, 40));   // ~25 Hz, the real cadence
    }
  }

  stopDriving() { this._driving = false; }

  sendToDisplay(data) { this._send({ type: 'send', to: 0, data }); }

  /// Our own seat in the display's roster, or null while unseated.
  get seat() {
    return (this.snapshot?.players || []).find((p) => p.peerIndex === this.peerIndex) || null;
  }

  /// Every direct message of one type the display has sent us.
  received(type) { return this.fromDisplay.filter((m) => m?.type === type); }

  /// Resolve once `pred()` is true, else throw. Every wait in a check should go
  /// through this rather than a sleep: a fixed delay either flakes on a cold
  /// Metal shader compile or pads every run to the worst case.
  waitFor(pred, what, timeout = 10000) {
    return new Promise((res, rej) => {
      const w = { pred, res, rej, what };
      w.timer = setTimeout(() => {
        this._waiters = this._waiters.filter((x) => x !== w);
        rej(new Error(`timed out waiting for ${what}`));
      }, timeout);
      this._waiters.push(w);
      this._pump();
    });
  }

  close() { try { this.ws?.close(); } catch { /* already gone */ } }

  _send(obj) { this.ws.send(JSON.stringify(obj)); }

  _onText(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    switch (m.type) {
      case 'joined':
        this.peerIndex = m.index;
        this.url = m.url;
        break;
      case 'state':
        // The retained host snapshot: replayed right after `joined` and pushed
        // live on every change. It is the ONLY roster message a phone gets.
        this.snapshot = m.data;
        break;
      case 'message':
        if (m.from === 0) this.fromDisplay.push(m.data);
        break;
      case 'error':
        this.relayErrors.push(m.message);
        break;
      default:
        break;
    }
    this._pump();
  }

  _pump() {
    for (const w of [...this._waiters]) {
      let ok = false;
      try { ok = w.pred(); } catch { /* a predicate that throws is simply not ready yet */ }
      if (!ok) continue;
      clearTimeout(w.timer);
      this._waiters = this._waiters.filter((x) => x !== w);
      w.res();
    }
  }
}
