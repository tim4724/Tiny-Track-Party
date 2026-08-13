// ControllerNet — phone-side relay connection. Derives room/instance/clientId
// from the URL, joins the room, and exchanges messages with the display (slot 0).
// CONTROL messages ride the WebRTC fastlane (PartyFastlane) when the DataChannel
// is open; all other traffic and fallback go over the WebSocket relay.
//
// Reads globals from classic scripts loaded first:
// PartyConnection, PartyFastlane, MSG, RELAY_URL, FASTLANE_TYPES.
import { GameNet } from '../shared/GameNet.js';
import { InputGate } from './InputGate.js';

const { PartyConnection, MSG, RELAY_URL, FASTLANE_TYPES, LIVENESS } = window;
const enc = encodeURIComponent;

// Relay-liveness ping cadence and the overdue-PONG threshold after which we
// surface a "no signal" reading (only when the fastlane isn't carrying its own
// live RTT). Both come from the shared presence contract (protocol.js LIVENESS)
// rather than being restated here: this cadence is the thing the display's
// 3 s drop window is budgeted against, and the two files used to name their own
// numbers with only a comment between them.
const PING_INTERVAL_MS = LIVENESS.PING_INTERVAL_MS;
const PONG_TIMEOUT_MS = LIVENESS.TIMEOUT_MS;

function deriveRoomCode() {
  const seg = (location.pathname || '/').split('/').filter(Boolean)[0];
  return seg || '';
}
function deriveInstance() {
  const raw = (location.hash || '').slice(1);
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}
// Reconnect claim from the display's per-seat QR (…/ROOM?claim=<peerIndex>). When
// a player rejoins on a DIFFERENT device (the original phone's clientId is gone),
// this token tells the display which dropped seat to hand this fresh connection —
// see DisplayNet._claimReconnect. A same-device reconnect keeps its relay slot by
// clientId and never needs it. Null on a normal first-time join.
function deriveClaim() {
  const raw = new URLSearchParams(location.search).get('claim');
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function loadClientId(roomCode) {
  const key = 'clientId_' + roomCode;
  try {
    let id = localStorage.getItem(key);
    if (!id) { id = 'tc-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(key, id); }
    return id;
  } catch (_) {
    return 'tc-' + Math.random().toString(36).slice(2);
  }
}

export class ControllerNet extends GameNet {
  constructor(opts = {}) {
    super();
    this.onMessage = opts.onMessage || (() => {});
    this.onJoined = opts.onJoined || (() => {});
    this.onStatus = opts.onStatus || (() => {}); // (state, info)
    this.onRtt = opts.onRtt || (() => {});       // (halfMs, viaFastlane); halfMs < 0 = no signal
    this.roomCode = deriveRoomCode();
    this.instance = deriveInstance();
    this.clientId = loadClientId(this.roomCode);
    this.rejoinToken = deriveClaim();
    this.peerIndex = null;
    this.playerName = '';
    this._pingTimer = null;
    this._lastPong = 0;
    // Gates the sensor-rate CONTROL stream down to what the display doesn't already
    // hold (see InputGate). opts.gate lets tests/measurement pass a configured
    // one; the default is the shipping policy.
    //
    // TEMPORARY (with the AC ping below): while the WS ping runs on AirConsole,
    // the 1 ping/s rides on top of the CONTROL stream in the controller's own
    // send budget, so the gate floor gives that message its headroom:
    // 42 ms ⇒ ≤23.8 CONTROL/s, +1 ping/s < the platform's 25 msg/s. Revert to
    // the plain default when the ping gate below goes back in.
    this.gate = opts.gate || new InputGate(window.airconsole ? { sendMinIntervalMs: 42 } : {});
    this._srtt = 0;
    // §7 lifecycle state. _suspended: the link was dropped by suspend() and is
    // ours to rebuild on return. _terminal: the relay finished this session for
    // good (4000/4001) — redialling would only bounce, so suspend/resume stay out
    // of it. Set where onClose already classifies those two, so the rule isn't
    // written down twice.
    this._suspended = false;
    this._terminal = false;
  }

  connect(playerName) {
    this.playerName = playerName || this.playerName;
    this._suspended = false;
    this._terminal = false;   // a fresh dial: whatever finished the last socket no longer applies
    if (this.party) this.party.close();
    if (this.fastlane) this.fastlane.closeAll();
    const url = RELAY_URL + '/' + enc(this.roomCode) + (this.instance ? '?instance=' + enc(this.instance) : '');
    this.party = new PartyConnection(url, { clientId: this.clientId });

    this.party.onOpen = () => this.party.join(this.roomCode);
    this.party.onProtocol = (type, msg) => {
      if (type === 'joined') {
        this.peerIndex = msg.index;
        this.party.resetReconnectCount(); // fresh retry budget — each clean (re)join starts over
        this._openFastlane();
        // rejoinToken claims a dropped seat when this is a cross-device rejoin
        // (harmless otherwise — the display ignores a token that matches our own
        // fresh slot or names a seat that's no longer waiting).
        this.party.sendTo(0, { type: MSG.HELLO, name: this.playerName, rejoinToken: this.rejoinToken });
        // TEMPORARILY also on AirConsole, to measure real-platform latency
        // (the chip was dark there): the controller's budget headroom for this
        // 1 ping/s comes from the AC gate floor set in the constructor, and
        // the PONG answers ride the DISPLAY's near-idle send budget. The
        // steady state this reverts to: no WS ping on AC — steering alone is
        // sized to fill the 25 msg/s budget, and AC's own connect/disconnect
        // events carry liveness.
        this._startPing();
        this.onJoined(this.peerIndex);
      } else if (type === 'error') {
        this.onStatus('error', msg.message);
      } else if (type === 'peer_left' && msg.index === 0) {
        this.onStatus('display_gone');
      } else if (type === 'peer_joined' && msg.index === 0) {
        // The display came back (reconnect — or a RELOAD that wiped its
        // roster): re-introduce ourselves so a fresh display restores this
        // seat's name, and re-open the fastlane right away instead of waiting
        // for the retry tick. The WELCOME it answers with clears any
        // "waiting for the big screen" overlay.
        this.party.sendTo(0, { type: MSG.HELLO, name: this.playerName, rejoinToken: this.rejoinToken });
        if (this.fastlane) this.fastlane.open(0);
      }
    };
    this.party.onMessage = (from, data) => {
      if (from !== 0 || !data) return;
      if (this._isSignal(from, data)) return;
      if (data.type === MSG.PONG) { this._handlePong(data); return; }
      this.onMessage(data);
    };
    // Retained host snapshot (the display's set_state): the lobby roster, pushed
    // live on each change and replayed by the relay right after our `joined` —
    // so a (re)join catches up on roster/track before WELCOME round-trips. The
    // payload carries the same type tag a relayed message would (LOBBY_UPDATE),
    // so it funnels into the one handler.
    this.party.onState = (data) => { if (data && data.type) this.onMessage(data); };
    this.party.onClose = (attempt, max, meta) => {
      this._stopPing();
      this.gate.reset(); // link down: what the display holds is no longer knowable
      if (meta && meta.replaced) { this._terminal = true; this.onStatus('replaced'); return; }
      // The room itself is gone (the display closed it, or the relay's hostless
      // grace expired after the big screen vanished). Terminal — a retry would
      // only bounce off "Room not found" — so it gets its own status, distinct
      // from 'lost' whose seat may still be reclaimable on the big screen.
      if (meta && meta.roomClosed) { this._terminal = true; this.onStatus('room_closed'); return; }
      // attempt > max: PartyConnection has stopped retrying — the link is down for
      // good until the player acts. Surface a distinct 'lost' so the UI can offer a
      // retry (and point at the big screen's reconnect QR).
      if (attempt > max) { this.onStatus('lost'); return; }
      this.onStatus('reconnecting', { attempt, max });
    };
    this.party.connect();
  }

  // Tear down the connection for good (no reconnect). Sends LEAVE first so the
  // display frees our seat outright instead of holding it open with a reconnect
  // QR — a back-out is intentional, not a drop. (peer_left follows when the
  // socket closes; the display no-ops it once the seat's already gone.) Used when
  // the player backs out of the room to the name screen.
  disconnect() {
    this._suspended = false;   // an intentional back-out is never resumed
    try { if (this.party) this.party.sendTo(0, { type: MSG.LEAVE }); } catch (_) {}
    this._dropLink();
  }

  // Everything the two INTENTIONAL endings have in common: stop the ping, drop
  // the fastlane, close the socket, forget the slot. What differs is only what
  // each says on the way out — disconnect() announces LEAVE, suspend() goes quiet
  // — and whether it expects to come back.
  _dropLink() {
    this._stopPing();
    if (this.fastlane) { this.fastlane.closeAll(); this.fastlane = null; }
    if (this.party) { this.party.close(); this.party = null; }
    this.peerIndex = null;
  }

  // Drop the link while the page is backgrounded (CONTRACT §7, and any real
  // pagehide). Without this the display keeps a ZOMBIE SEAT: the socket outlives
  // the running page and keeps answering the relay, so no peer_left fires and the
  // display's 1 Hz liveness never expires us — on iOS indefinitely (WKWebView's
  // network stack is out-of-process and survives suspension), on Android whenever
  // the OS gets round to freezing the cached process.
  //
  // Deliberately NOT disconnect(): backgrounding is not a back-out, so no LEAVE
  // goes out and the display holds the seat as a droppable one (reconnect QR)
  // rather than freeing it outright. party.close() detaches the socket handlers,
  // so our own close can't come back through onClose and flash 'Reconnecting…'
  // over a page nobody is looking at.
  suspend() {
    // AirConsole owns the app lifecycle: the platform pauses the iframe and
    // reconnects devices itself, and tearing the adapter down here would
    // orphan it — the SDK's onReady never re-fires into a replacement.
    if (window.airconsole) return;
    if (!this.party || this._terminal) return;
    this.gate.reset();   // link down: what the display holds is no longer knowable
    this._dropLink();
    this._suspended = true;
  }

  // Back in the foreground. §7 has no synthetic counterpart to pagehide — the
  // engine fires the standard visibilitychange, and we redial there. Same
  // clientId, so the relay returns the same slot and our HELLO restores the seat:
  // exactly the path the reconnect button takes. No-op unless suspend() ran, so a
  // tab merely being hidden and shown again costs nothing.
  resume() {
    if (this._suspended) this.connect();   // connect() clears _suspended
  }

  // Live rename: adopt the new name and re-introduce ourselves to the display so
  // it updates our seat and re-broadcasts the roster (LOBBY_UPDATE) to everyone —
  // the same HELLO path used on join and on display-return, so a fresh display
  // also restores the new name. No-op until we've joined (peerIndex set); the name
  // still rides the next HELLO. Used by the CouchPad launcher's setName (§2).
  rename(name) {
    this.playerName = name || this.playerName;
    if (this.party && this.peerIndex != null) {
      this.party.sendTo(0, { type: MSG.HELLO, name: this.playerName, rejoinToken: this.rejoinToken });
    }
  }

  // Send to the display. FASTLANE_TYPES messages ride the WebRTC DataChannel
  // when it's open; everything else (and fallback) goes over the WS relay.
  send(type, payload) {
    if (!this.party) return;
    const msg = payload || {};
    msg.type = type;
    if (FASTLANE_TYPES[type] && this.fastlane && this.fastlane.enqueue(0, msg) === 'p2p') return;
    this.party.sendTo(0, msg);
  }

  // Hot-path CONTROL send. Unlike send(), this is GATED: a sample the display
  // already holds never reaches the wire (see InputGate). Returns true when it
  // was transmitted. `nowMs` is injectable so tests drive the clock.
  sendControl(sample, nowMs = Date.now()) {
    if (!this.party) return false;
    const why = this.gate.decide(sample, nowMs, this._srtt);
    if (!why) return false;
    const msg = { s: sample.s, b: sample.b, u: sample.u, type: MSG.CONTROL };
    // Routed through FASTLANE_TYPES exactly like send() does, so protocol.js
    // stays the one place that decides what rides P2P — this path must not
    // quietly keep using the fastlane if CONTROL is ever taken off it.
    const viaP2p = !!(FASTLANE_TYPES[MSG.CONTROL] && this.fastlane
      && this.fastlane.enqueue(0, msg) === 'p2p');
    if (!viaP2p) this.party.sendTo(0, msg);
    this.gate.markSent(sample, nowMs);
    // The relay path carries no acks — WS is reliable and ordered, so handing
    // the message over IS the confirmation. Only the fastlane (unreliable,
    // unordered) has to wait for a real one via onAcked.
    if (!viaP2p) this.gate.markAcked(sample);
    return true;
  }

  _openFastlane() {
    // Fresh (re)join: the display may be a brand new one with no memory of us,
    // so nothing previously confirmed still counts.
    this.gate.reset();
    this._initFastlane(this.peerIndex, {
      emitIdleHeartbeat: true,
      // Latest-only: CONTROL is absolute state ({s,b,u}) resampled at sensor rate,
      // not a stream of discrete events, so the kit's resend window can't help.
      // The display applies inputs on arrival, straight into the sim's car
      // fields, and only steps physics from rAF — so a recovered older event's
      // steer/brake write is overwritten by the newer one in the same task,
      // before any frame observes it, and `u` (a level-triggered use-counter)
      // collapses the same way. Carrying the window would inflate every packet
      // ~5x to restore values that provably can't change the outcome.
      maxRing: 1,
      // Idle heartbeats keep acks flowing even with no inputs, so this fires
      // ~continuously while the P2P channel is up — smoothed half-RTT (srtt/2),
      // lower than the WS path. viaFastlane=true so the UI lights the bolt.
      onRtt: (peerIdx, halfMs) => {
        if (peerIdx !== 0) return;
        this._srtt = halfMs * 2; // halfMs is srtt/2; the gate's resend cadence wants the round trip
        this.onRtt(Math.round(halfMs), true);
      },
      // The display confirmed applying this payload — the only truth about what
      // it actually holds, and what the gate compares against.
      onAcked: (peerIdx, ev) => { if (peerIdx === 0) this.gate.markAcked(ev); },
      onPeerClosed: () => {
        // Display-side fastlane closed (watchdog or display reconnect); retry.
        // Its state is now unknowable, so drop the gate's confirmed value: the
        // next sample re-establishes ground truth instead of being filtered
        // against a belief formed before the channel died.
        this.gate.reset();
        setTimeout(() => { if (this.fastlane && this.peerIndex != null) this.fastlane.open(0); }, 2000);
      },
    });
    if (this.fastlane) this.fastlane.open(0); // null with no WebRTC: relay only
  }

  // ---- ping / pong (WS relay-liveness + WS-path latency) ----
  // The fastlane reports its own (lower) RTT via onRtt; this WS ping is the
  // fallback latency source and the liveness check. When the fastlane is open
  // its samples win — we don't let the 1 Hz WS reading clobber the live P2P
  // chip (the gate in _handlePong / the timeout below).
  _startPing() {
    this._stopPing();
    this._lastPong = Date.now();
    this._pingTimer = setInterval(() => {
      if (!this.party) return;
      this.send(MSG.PING, { t: Date.now() });
      if (Date.now() - this._lastPong > PONG_TIMEOUT_MS && !this._fastlaneUp()) {
        this.onRtt(-1, false);
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _handlePong(data) {
    this._lastPong = Date.now();
    // Only drive the chip from the WS reading when the fastlane isn't already
    // feeding higher-fidelity P2P samples — otherwise the 1 Hz relay RTT would
    // stomp the live bolt reading once a second.
    if (typeof data.t === 'number' && !this._fastlaneUp()) {
      this.onRtt(Math.round((Date.now() - data.t) / 2), false);
    }
  }

  _fastlaneUp() { return !!(this.fastlane && this.fastlane.isOpen(0)); }

  isHost(hostPeerIndex) { return this.peerIndex != null && this.peerIndex === hostPeerIndex; }
}
