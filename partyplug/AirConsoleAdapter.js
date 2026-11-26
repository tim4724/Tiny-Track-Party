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
    this.onState = null;     // (data: any) => void, retained screen snapshot

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

    // Deliberately one-way for the screen: a controller gets peer_left(0) but never
    // a matching peer_joined(0) (onConnect returns early for SCREEN below). On the
    // relay, peer_joined(0) re-arms the display-gone bail and reopens the fastlane;
    // in AirConsole there is no fastlane, and a screen that leaves has ended the
    // session, so the controller's bail timer running out IS the correct outcome.
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

    // Retained snapshot: the display (SCREEN) authors it via setState ->
    // setCustomDeviceState; controllers read the screen's state and re-read on
    // each change. The platform analogue of the relay's set_state/state, so the
    // kit's setState/onState interface is uniform across both transports.
    ac.onCustomDeviceStateChange = function(device_id) {
      if (self.role !== 'controller') return;       // the display authors, never consumes
      if (device_id !== AirConsole.SCREEN) return;  // only the screen's state is the snapshot
      self._replayScreenState();
    };
  }

  // Deliver the screen's current retained state to onState (shared by the
  // change handler above and the post-`joined` replay in _fireReady).
  _replayScreenState() {
    if (!this.onState) return;
    try {
      var st = this.airconsole.getCustomDeviceState(AirConsole.SCREEN);
      if (st !== undefined) this.onState(st);
    } catch (e) { /* SDK not ready / no state yet */ }
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
      // Replay the screen's retained state right after `joined`, mirroring the
      // relay replaying `state` after `joined`. Covers state the display set
      // before this controller connected (the SDK may not fire
      // onCustomDeviceStateChange for pre-existing state on a fresh join).
      this._replayScreenState();
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
      // Peer 0 is the screen, so this is a controller talking to the display.
      // A display addressing itself has no meaning on this transport, and the one
      // caller that did it on the relay (the display's own link check) does not
      // run in AC mode, so there is nothing to route (DisplayLiveness.selfLinkDead).
      if (this.role === 'display') return;
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

  // Publish a retained snapshot. Display-only: maps to the SDK's custom device
  // state on the screen device, which AirConsole retains and replays to
  // (re)joining controllers: the platform analogue of the relay's set_state.
  // A controller calling this is a silent no-op (it owns no screen state).
  setState(data) {
    if (this.role !== 'display') return;
    try {
      this.airconsole.setCustomDeviceState(data);
    } catch (e) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[AirConsoleAdapter] setCustomDeviceState failed', e);
      }
    }
  }

  // No-ops — AirConsole owns room creation and connection lifecycle.
  create() {}
  join() {}
  pinInstance() {}
  reconnectNow() {}
  // The AC session IS the room: it ends when the screen unloads, and there is no
  // relay to tell. Present so callers can invoke the full PartyConnection surface
  // without branching on the transport.
  closeRoom() {}
  // Relay-only retry bookkeeping. AirConsole owns reconnection, so there is no
  // attempt to fail and no backoff to drive; onClose is likewise never fired.
  failAttempt() {}
  resetReconnectCount() { this.reconnectAttempt = 0; }

  close() {
    this._ready = false;
    // Drop this adapter's references to the app's callbacks: close() is followed
    // by the app wiring up a fresh adapter, and a stale one must not be able to
    // drive it. The SDK's own callbacks are handled separately below, and
    // deliberately differently.
    this.onOpen = this.onClose = this.onError = this.onMessage = this.onProtocol = this.onState = null;
    // Neutralize SDK callbacks without nulling them — the AirConsole SDK
    // invokes these on its own schedule (e.g. queued postMessage events that
    // arrive between our close() and the next adapter's _wireAirConsole), and
    // nulling `ac.onMessage` crashes the SDK with
    // "TypeError: me.onMessage is not a function". No-op functions keep the
    // SDK safe while still preventing this adapter's stale state from
    // receiving events; the next adapter will overwrite them in turn.
    var ac = this.airconsole;
    var noop = function() {};
    ac.onReady = ac.onConnect = ac.onDisconnect = ac.onMessage = ac.onPremium = ac.onCustomDeviceStateChange = noop;
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
