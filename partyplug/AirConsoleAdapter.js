'use strict';

/**
 * AirConsoleAdapter — wraps the AirConsole API behind the PartyConnection
 * interface so existing display/controller code can run in AirConsole.
 */
class AirConsoleAdapter {
  constructor(airconsole, options) {
    this.airconsole = airconsole;
    this.role = (options && options.role) || 'display';
    this._ready = false;
    this._acReady = false;
    this._acReadyCode = null;
    this._connectCalled = false;
    this.reconnectAttempt = 0;
    this.maxReconnectAttempts = 5;
    // Runs before 'created'/'joined' is synthesized.
    this.onReadyHook = (options && options.onReady) || null;

    // Callbacks (same signature as PartyConnection)
    this.onOpen = null;
    this.onClose = null;
    this.onError = null;     // no-op — AirConsole SDK has no error callback equivalent
    this.onMessage = null;
    this.onProtocol = null;

    this._wireAirConsole();
  }

  _wireAirConsole() {
    var self = this;
    var ac = this.airconsole;

    ac.onReady = function(code) {
      if (self.onReadyHook) self.onReadyHook(code, ac);
      self._acReady = true;
      self._acReadyCode = code;
      if (self._connectCalled) {
        self._fireReady();
      }
    };

    ac.onConnect = function(device_id) {
      if (device_id === AirConsole.SCREEN) return;
      if (self.role === 'display') {
        if (self.onProtocol) self.onProtocol('peer_joined', { index: device_id });
      }
    };

    ac.onDisconnect = function(device_id) {
      if (device_id === AirConsole.SCREEN) {
        if (self.role === 'controller') {
          if (self.onProtocol) self.onProtocol('peer_left', { index: 0 });
        }
        return;
      }
      if (self.role === 'display') {
        if (self.onProtocol) self.onProtocol('peer_left', { index: device_id });
      }
    };

    ac.onMessage = function(device_id, data) {
      if (self.role === 'display') {
        if (device_id === AirConsole.SCREEN) return; // ignore own broadcasts echoed back
        if (self.onMessage) self.onMessage(device_id, data);
      } else {
        if (device_id === AirConsole.SCREEN) {
          if (self.onMessage) self.onMessage(0, data);
        }
      }
    };

    // A premium upgrade can change which controller AirConsole considers the
    // master (premium devices get priority). Signal the display so it can
    // re-broadcast host info. onConnect / onDisconnect already do this via
    // peer_joined / peer_left.
    ac.onPremium = function() {
      if (self.role === 'display' && self.onProtocol) {
        self.onProtocol('master_changed', {});
      }
    };
  }

  /**
   * Display-only: returns the AirConsole master controller device id as a
   * numeric peer index, or null when no controller is connected or we're not
   * in AirConsole mode. Premium devices are prioritized by AirConsole itself.
   */
  getMasterPeerIndex() {
    if (this.role !== 'display') return null;
    var id = this.airconsole.getMasterControllerDeviceId();
    return (id === undefined || id === null) ? null : id;
  }

  _fireReady() {
    if (this._ready) return;
    this._ready = true;
    var code = this._acReadyCode || 'airconsole';
    if (this.onOpen) this.onOpen();

    if (this.role === 'display') {
      if (this.onProtocol) this.onProtocol('created', { room: code, index: 0 });
      // Re-synthesize peer_joined for already-connected controllers.
      // When Play Again / New Game recreates the adapter, AirConsole won't
      // re-fire onConnect for controllers that are already connected.
      var self = this;
      var ids = this.airconsole.getControllerDeviceIds();
      for (var i = 0; i < ids.length; i++) {
        if (self.onProtocol) self.onProtocol('peer_joined', { index: ids[i] });
      }
    } else {
      // Controllers' index is their AirConsole device id; the only "peer" they
      // care about is the display (always 0). Other controllers don't talk to
      // each other, so peers stays empty.
      var myIndex = this.airconsole.getDeviceId();
      if (this.onProtocol) this.onProtocol('joined', { room: code, index: myIndex, peers: [0] });
    }
  }

  // --- PartyConnection-compatible interface ---

  /**
   * connect() is called by DisplayConnection / ControllerConnection after
   * setting up all the callbacks. This triggers the onReady synthesis.
   */
  connect() {
    this._connectCalled = true;
    // If AirConsole already fired onReady, synthesize protocol events now
    if (this._acReady) {
      this._fireReady();
    }
  }

  sendTo(to, data) {
    if (typeof to !== 'number') {
      console.warn('[AirConsoleAdapter] sendTo: expected numeric peer index, got', to);
      return;
    }
    if (to === 0) {
      if (this.role === 'display') {
        // Async self-echo for heartbeat compatibility.
        var self = this;
        setTimeout(function() { if (self.onMessage) self.onMessage(0, data); }, 0);
        return;
      }
      this.airconsole.message(AirConsole.SCREEN, data);
    } else {
      this.airconsole.message(to, data);
    }
  }

  broadcast(data) {
    // Role-neutral SDK call by design. Displays use this to fan out game
    // messages; controllers should prefer sendTo(0, data) unless they
    // intentionally want AirConsole's all-devices broadcast behavior.
    this.airconsole.broadcast(data);
  }

  // No-ops — AirConsole owns room creation and connection lifecycle.
  create() {}
  join() {}
  pinInstance() {}
  reconnectNow() {}
  resetReconnectCount() { this.reconnectAttempt = 0; }

  close() {
    this._ready = false;
    // Clear adapter callbacks (prevents stale setTimeout self-echo from firing)
    this.onOpen = this.onClose = this.onError = this.onMessage = this.onProtocol = null;
    // Neutralize SDK callbacks without nulling them — the AirConsole SDK
    // invokes these on its own schedule (e.g. queued postMessage events that
    // arrive between our close() and the next adapter's _wireAirConsole), and
    // nulling `ac.onMessage` crashes the SDK with
    // "TypeError: me.onMessage is not a function". No-op functions keep the
    // SDK safe while still preventing this adapter's stale state from
    // receiving events; the next adapter will overwrite them in turn.
    var ac = this.airconsole;
    var noop = function() {};
    ac.onReady = ac.onConnect = ac.onDisconnect = ac.onMessage = ac.onPremium = noop;
  }

  get connected() {
    return this._ready;
  }

  // Capture an early onReady callback from the SDK so we can replay it once
  // the adapter has wired up its own onReady. The SDK fires onReady at most
  // once per session; bootstraps that construct the adapter lazily (e.g. in
  // response to controller.js init) miss the live fire and rely on this
  // replay. Returns a one-shot `replay()` function — call it once after
  // wrapping airconsole.onReady to bring a fresh adapter to ready. Later calls
  // are harmless no-ops.
  static captureEarlyReady(airconsole) {
    var capturedCode;
    airconsole.onReady = function(code) { capturedCode = code; };
    return function replay() {
      if (capturedCode === undefined) return;
      var code = capturedCode;
      capturedCode = undefined;
      airconsole.onReady(code);
    };
  }

}

if (typeof window !== 'undefined') {
  window.AirConsoleAdapter = AirConsoleAdapter;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AirConsoleAdapter;
}
