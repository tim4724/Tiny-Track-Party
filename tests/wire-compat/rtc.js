'use strict';

// A DataChannel PAIR with a controllable medium, plus the smallest
// RTCPeerConnection that lets partyplug/PartyFastlane.js construct a peer.
//
// The handshake is NOT modelled — offer/answer/glare/ICE is browser code with no
// C++ twin, and faking it would only test the fake. What IS modelled is the one
// thing the netcode contract rests on: an UNRELIABLE, UNORDERED byte pipe. Every
// frame goes through `medium`, which can drop it, duplicate it, hold it for later
// release, or reorder it. That is what turns "both sides implement a resend ring"
// into an actual claim.

// A real RTCDataChannel throws InvalidStateError on send() when not open, and
// PartyFastlane._writeRaw swallows exactly that (so a failed write must not count
// toward stats.out). Getting this wrong makes the closed-channel paths lie.
class FakeDataChannel {
  constructor(label) {
    this.label = label || 'party';
    this.readyState = 'connecting';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._peer = null;
    this.sent = [];        // raw text handed to send(), including dropped frames
    this.delivered = [];   // raw text that actually reached the peer
    this._held = [];
    // (text) => 'deliver' | 'drop' | 'dup' | 'hold'
    this.medium = () => 'deliver';
  }

  send(text) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError');
    this.sent.push(text);
    const verdict = this.medium(text);
    if (verdict === 'drop') return;
    if (verdict === 'hold') { this._held.push(text); return; }
    this._push(text);
    if (verdict === 'dup') this._push(text);
  }

  // Delivery is DEFERRED by one zero-delay timer, never synchronous inside the
  // sender's own send() call. That is not a detail: a synchronous pipe makes the
  // peer's ack arrive BEFORE send() returns, which reverses the real order of
  // PartyFastlane's _handleAck and _sendDataPacket and quietly rewrites the
  // netcode's timer state. Under the fake clock a zero-delay timer fires on the
  // next advance (including advance(0)), so this stays fully deterministic.
  _push(text) {
    this.delivered.push(text);
    setTimeout(() => {
      const p = this._peer;
      if (p && p.readyState === 'open' && p.onmessage) p.onmessage({ data: text });
    }, 0);
  }

  // Release held frames, optionally reordered (newest first mimics a link that
  // delivered the later packet first — the case implicit-seq dedup must survive).
  releaseHeld({ reverse = false } = {}) {
    const frames = reverse ? this._held.slice().reverse() : this._held.slice();
    this._held.length = 0;
    for (const f of frames) this._push(f);
  }

  open() {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    if (this.onopen) this.onopen();
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    if (this.onclose) this.onclose();
  }
}

function channelPair() {
  const a = new FakeDataChannel('party');
  const b = new FakeDataChannel('party');
  a._peer = b;
  b._peer = a;
  return [a, b];
}

// Enough RTCPeerConnection for PartyFastlane._ensurePeer to construct one and for
// _teardownPeer to close it. open() is never driven through this in the suite —
// channels are paired explicitly by connectPair() below.
class FakeRTCPeerConnection {
  constructor() {
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.onconnectionstatechange = null;
    this._channels = [];
  }
  createDataChannel(label) {
    const ch = new FakeDataChannel(label);
    this._channels.push(ch);
    return ch;
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
}

function installFakeWebRTC() {
  const prev = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakeRTCPeerConnection;
  return () => { globalThis.RTCPeerConnection = prev; };
}

// Wire two live PartyFastlane instances (of any implementation) to each other over
// one channel pair, through their REAL _wireChannel + onopen paths. Returns the
// two channels so a test can drive the medium.
function connectPair(flA, peerIdxForA, flB, peerIdxForB) {
  const [chA, chB] = channelPair();
  const peerA = flA._ensurePeer(peerIdxForA);
  const peerB = flB._ensurePeer(peerIdxForB);
  flA._wireChannel(peerA, peerIdxForA, chA);
  flB._wireChannel(peerB, peerIdxForB, chB);
  chA.open();
  chB.open();
  return { chA, chB, peerA, peerB };
}

module.exports = { FakeDataChannel, FakeRTCPeerConnection, channelPair, installFakeWebRTC, connectPair };
