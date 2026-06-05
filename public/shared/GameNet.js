// GameNet — shared base for DisplayNet and ControllerNet.
// Owns the party (PartyConnection) and fastlane (PartyFastlane) references and
// centralises the STUN config and the helpers both sides need: _initFastlane and
// _isSignal. The page-specific subclasses handle everything else (room creation
// vs join, roster, game message routing).
//
// Relies on classic scripts having loaded PartyFastlane and protocol.js before
// any ES module runs (guaranteed by the HTML <head> load order).

export class GameNet {
  constructor() {
    this.party = null;
    this.fastlane = null;
  }

  // Create/replace the fastlane for `selfIndex`. Tears down any existing one.
  // All PartyFastlane constructor options (onInput, onPeerReady, onPeerClosed,
  // emitIdleHeartbeat, …) can be passed through `opts`.
  _initFastlane(selfIndex, opts = {}) {
    const { PartyFastlane, STUN_URL } = window;
    if (this.fastlane) { this.fastlane.closeAll(); this.fastlane = null; }
    this.fastlane = new PartyFastlane({
      selfIndex,
      iceServers: [{ urls: STUN_URL }, { urls: 'stun:stun.l.google.com:19302' }],
      sendSignal: (peerIdx, sig) => { if (this.party) this.party.sendTo(peerIdx, sig); },
      ...opts,
    });
  }

  // Returns true if `data` was an RTC signal consumed by the fastlane.
  _isSignal(from, data) {
    return !!(this.fastlane && this.fastlane.handleSignal(from, data));
  }
}
