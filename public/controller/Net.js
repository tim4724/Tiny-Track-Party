// ControllerNet — phone-side relay connection. Derives room/instance/clientId
// from the URL, joins the room, and exchanges messages with the display (slot 0).
// M0: WS only (join + lobby). M2 adds the WebRTC fastlane for the CONTROL stream.
//
// Reads globals from classic scripts loaded first: PartyConnection, MSG, RELAY_URL.

const { PartyConnection, MSG, RELAY_URL } = window;
const enc = encodeURIComponent;

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

export class ControllerNet {
  constructor(opts = {}) {
    this.onMessage = opts.onMessage || (() => {});
    this.onJoined = opts.onJoined || (() => {});
    this.onStatus = opts.onStatus || (() => {}); // (state, info)
    this.roomCode = deriveRoomCode();
    this.instance = deriveInstance();
    this.clientId = loadClientId(this.roomCode);
    this.peerIndex = null;
    this.party = null;
    this.playerName = '';
  }

  connect(playerName) {
    this.playerName = playerName || this.playerName;
    if (this.party) this.party.close();
    const url = RELAY_URL + '/' + enc(this.roomCode) + (this.instance ? '?instance=' + enc(this.instance) : '');
    this.party = new PartyConnection(url, { clientId: this.clientId });

    this.party.onOpen = () => this.party.join(this.roomCode);
    this.party.onProtocol = (type, msg) => {
      if (type === 'joined') {
        this.peerIndex = msg.index;
        this.party.sendTo(0, { type: MSG.HELLO, name: this.playerName });
        this.onJoined(this.peerIndex);
      } else if (type === 'error') {
        this.onStatus('error', msg.message);
      } else if (type === 'peer_left' && msg.index === 0) {
        this.onStatus('display_gone');
      }
    };
    this.party.onMessage = (from, data) => { if (from === 0 && data) this.onMessage(data); };
    this.party.onClose = (attempt, max, meta) => {
      if (meta && meta.replaced) { this.onStatus('replaced'); return; }
      this.onStatus('reconnecting', { attempt, max });
    };
    this.party.connect();
  }

  // Reliable WS send to the display. M2 routes CONTROL over the fastlane first.
  send(type, payload) {
    if (!this.party) return;
    const msg = payload || {};
    msg.type = type;
    this.party.sendTo(0, msg);
  }

  isHost(hostPeerIndex) { return this.peerIndex != null && this.peerIndex === hostPeerIndex; }
}
