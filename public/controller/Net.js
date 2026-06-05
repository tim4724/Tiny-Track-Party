// ControllerNet — phone-side relay connection. Derives room/instance/clientId
// from the URL, joins the room, and exchanges messages with the display (slot 0).
// CONTROL messages ride the WebRTC fastlane (PartyFastlane) when the DataChannel
// is open; all other traffic and fallback go over the WebSocket relay.
//
// Reads globals from classic scripts loaded first:
// PartyConnection, PartyFastlane, MSG, RELAY_URL, FASTLANE_TYPES.
import { GameNet } from '../shared/GameNet.js';

const { PartyConnection, MSG, RELAY_URL, FASTLANE_TYPES } = window;
const enc = encodeURIComponent;

// Relay-liveness ping cadence and the overdue-PONG threshold after which we
// surface a "no signal" reading (only when the fastlane isn't carrying its own
// live RTT). 1 Hz is plenty for a latency readout and matches the display's
// per-controller liveness expectations.
const PING_INTERVAL_MS = 1000;
const PONG_TIMEOUT_MS = 3000;

function deriveRoomCode() {
  const seg = (location.pathname || '/').split('/').filter(Boolean)[0];
  return seg || '';
}
function deriveInstance() {
  const raw = (location.hash || '').slice(1);
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
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
    this.peerIndex = null;
    this.playerName = '';
    this._pingTimer = null;
    this._lastPong = 0;
  }

  connect(playerName) {
    this.playerName = playerName || this.playerName;
    if (this.party) this.party.close();
    if (this.fastlane) this.fastlane.closeAll();
    const url = RELAY_URL + '/' + enc(this.roomCode) + (this.instance ? '?instance=' + enc(this.instance) : '');
    this.party = new PartyConnection(url, { clientId: this.clientId });

    this.party.onOpen = () => this.party.join(this.roomCode);
    this.party.onProtocol = (type, msg) => {
      if (type === 'joined') {
        this.peerIndex = msg.index;
        this._openFastlane();
        this.party.sendTo(0, { type: MSG.HELLO, name: this.playerName });
        this._startPing();
        this.onJoined(this.peerIndex);
      } else if (type === 'error') {
        this.onStatus('error', msg.message);
      } else if (type === 'peer_left' && msg.index === 0) {
        this.onStatus('display_gone');
      }
    };
    this.party.onMessage = (from, data) => {
      if (from !== 0 || !data) return;
      if (this._isSignal(from, data)) return;
      if (data.type === MSG.PONG) { this._handlePong(data); return; }
      this.onMessage(data);
    };
    this.party.onClose = (attempt, max, meta) => {
      this._stopPing();
      if (meta && meta.replaced) { this.onStatus('replaced'); return; }
      this.onStatus('reconnecting', { attempt, max });
    };
    this.party.connect();
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

  _openFastlane() {
    this._initFastlane(this.peerIndex, {
      emitIdleHeartbeat: true,
      // Idle heartbeats keep acks flowing even with no inputs, so this fires
      // ~continuously while the P2P channel is up — smoothed half-RTT (srtt/2),
      // lower than the WS path. viaFastlane=true so the UI lights the bolt.
      onRtt: (peerIdx, halfMs) => { if (peerIdx === 0) this.onRtt(Math.round(halfMs), true); },
      onPeerClosed: () => {
        // Display-side fastlane closed (watchdog or display reconnect); retry.
        setTimeout(() => { if (this.fastlane && this.peerIndex != null) this.fastlane.open(0); }, 2000);
      },
    });
    this.fastlane.open(0);
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
