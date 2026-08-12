// @ts-check

/**
 * Mock AirConsole SDK for E2E testing.
 *
 * Simulates the AirConsole messaging layer using a shared BroadcastChannel
 * so that separate browser pages (screen + controllers) can communicate
 * without the real AirConsole iframe infrastructure.
 *
 * Injected via page.addInitScript() BEFORE the real AirConsole SDK loads.
 * The AirConsole SDK script in screen.html / controller.html
 * is intercepted (blocked) so this mock takes its place.
 */

// @ts-ignore - this runs in the browser context
(function() {
  'use strict';

  var CHANNEL_NAME = '__airconsole_mock__';

  /**
   * @param {object} [opts]
   */
  function AirConsole(opts) {
    this._opts = opts || {};
    this._deviceId = null;
    this._ready = false;
    this._channel = new BroadcastChannel(CHANNEL_NAME);
    this._nicknames = {};
    this._connectedDevices = new Set();

    // Per-device persistent-data store (in-memory; per-tab — sufficient
    // for the existing e2e suite which doesn't exercise reload persistence).
    this._persistentData = {};

    // Per-device custom device state (the SDK's retained per-device blob).
    // Keyed by deviceId and replicated across pages over the channel so a
    // controller can read the screen's state. Faithfully mirrors
    // setCustomDeviceState / getCustomDeviceState / onCustomDeviceStateChange,
    // including replay of the screen's state to a newly-joined device.
    this._customDeviceStates = {};

    // Callbacks
    this.onReady = null;
    this.onConnect = null;
    this.onDisconnect = null;
    this.onMessage = null;
    this.onPause = null;
    this.onResume = null;
    this.onPersistentDataLoaded = null;
    this.onDeviceProfileChange = null;
    this.onCustomDeviceStateChange = null;

    var self = this;

    // Determine role from URL or opts
    // screen.html → device 0, controller.html → random device ID > 0
    var isScreen = window.location.pathname.indexOf('screen') !== -1;
    this._deviceId = isScreen ? 0 : (window.__AC_DEVICE_ID || (window.__AC_NEXT_ID = (window.__AC_NEXT_ID || 100) + 1));
    window.__AC_DEVICE_ID = this._deviceId;

    this._channel.onmessage = function(event) {
      var msg = event.data;
      if (!msg || !msg._ac_type) return;

      switch (msg._ac_type) {
        case 'connect':
          if (msg.deviceId !== self._deviceId) {
            if (msg.nickname) self._nicknames[msg.deviceId] = msg.nickname;
            if (msg.deviceId !== 0) self._connectedDevices.add(msg.deviceId);
            if (self.onConnect) self.onConnect(msg.deviceId);
            // Replay our retained custom device state to the newcomer, the way
            // the platform syncs existing device states to a joining device.
            // (onConnect above may also have set fresh state synchronously; a
            // duplicate replay is harmless, the consumer re-derives the same.)
            if (self._customDeviceStates[self._deviceId] !== undefined) {
              self._channel.postMessage({
                _ac_type: 'custom_device_state',
                deviceId: self._deviceId,
                state: self._customDeviceStates[self._deviceId]
              });
            }
          }
          break;
        case 'disconnect':
          if (msg.deviceId !== self._deviceId) {
            self._connectedDevices.delete(msg.deviceId);
            if (self.onDisconnect) self.onDisconnect(msg.deviceId);
          }
          break;
        case 'message':
          if (msg.to === self._deviceId || msg.to === undefined) {
            if (msg.from !== self._deviceId) {
              if (self.onMessage) self.onMessage(msg.from, msg.data);
            }
          }
          break;
        case 'custom_device_state':
          // Another device updated its retained state: store it and notify,
          // matching onCustomDeviceStateChange(device_id) on the real SDK.
          if (msg.deviceId !== self._deviceId) {
            self._customDeviceStates[msg.deviceId] = msg.state;
            if (self.onCustomDeviceStateChange) self.onCustomDeviceStateChange(msg.deviceId);
          }
          break;
      }
    };

    // Fire onReady asynchronously
    setTimeout(function() {
      if (isScreen) {
        self._ready = true;
        if (self.onReady) self.onReady('MOCK');
      }
      // Announce presence
      self._channel.postMessage({
        _ac_type: 'connect',
        deviceId: self._deviceId,
        nickname: window.__AC_NICKNAME || null
      });
      // Controllers self-fire onReady after a short delay to simulate
      // the AirConsole platform handshake completing.
      if (!isScreen) {
        setTimeout(function() {
          if (!self._ready) {
            self._ready = true;
            if (self.onReady) self.onReady('MOCK');
          }
        }, 200);
      }
    }, 50);
  }

  AirConsole.SCREEN = 0;
  AirConsole.ORIENTATION_PORTRAIT = 'portrait';
  AirConsole.ORIENTATION_LANDSCAPE = 'landscape';

  AirConsole.prototype.getDeviceId = function() {
    return this._deviceId;
  };

  AirConsole.prototype.getNickname = function(deviceId) {
    if (deviceId === this._deviceId) return window.__AC_NICKNAME || 'Player';
    return this._nicknames[deviceId] || 'Player';
  };

  AirConsole.prototype.getControllerDeviceIds = function() {
    return Array.from(this._connectedDevices);
  };

  AirConsole.prototype.getMasterControllerDeviceId = function() {
    return undefined;
  };

  AirConsole.prototype.message = function(deviceId, data) {
    this._channel.postMessage({
      _ac_type: 'message',
      from: this._deviceId,
      to: deviceId,
      data: data
    });
  };

  AirConsole.prototype.broadcast = function(data) {
    this._channel.postMessage({
      _ac_type: 'message',
      from: this._deviceId,
      to: undefined,
      data: data
    });
  };

  AirConsole.prototype.setCustomDeviceState = function(data) {
    this._customDeviceStates[this._deviceId] = data;
    this._channel.postMessage({
      _ac_type: 'custom_device_state',
      deviceId: this._deviceId,
      state: data
    });
  };
  AirConsole.prototype.getCustomDeviceState = function(deviceId) {
    return this._customDeviceStates[deviceId];
  };
  AirConsole.prototype.setOrientation = function() {};
  AirConsole.prototype.vibrate = function() {};

  AirConsole.prototype.getUID = function(deviceId) {
    return 'uid_' + deviceId;
  };

  AirConsole.prototype.storePersistentData = function(key, value /*, uid */) {
    if (value === null || value === undefined) {
      delete this._persistentData[key];
    } else {
      this._persistentData[key] = value;
    }
  };

  AirConsole.prototype.requestPersistentData = function(uids) {
    var self = this;
    var data = {};
    var ownUid = this.getUID(this._deviceId);
    for (var i = 0; i < (uids || []).length; i++) {
      data[uids[i]] = (uids[i] === ownUid) ? Object.assign({}, this._persistentData) : {};
    }
    setTimeout(function() {
      if (self.onPersistentDataLoaded) self.onPersistentDataLoaded(data);
    }, 0);
  };

  // Test helpers — trigger SDK lifecycle events
  AirConsole.prototype.triggerPause = function() { if (this.onPause) this.onPause(); };
  AirConsole.prototype.triggerResume = function() { if (this.onResume) this.onResume(); };
  AirConsole.prototype.triggerAdShow = function() { if (this.onAdShow) this.onAdShow(); };
  AirConsole.prototype.triggerAdComplete = function() { if (this.onAdComplete) this.onAdComplete(); };
  AirConsole.prototype.triggerDisconnect = function() {
    this._channel.postMessage({ _ac_type: 'disconnect', deviceId: this._deviceId });
  };
  // Simulate the player editing their AirConsole nickname: update this device's
  // own nickname and fire onDeviceProfileChange for it, matching the real SDK.
  AirConsole.prototype.triggerProfileChange = function(nickname) {
    if (nickname != null) window.__AC_NICKNAME = nickname;
    if (this.onDeviceProfileChange) this.onDeviceProfileChange(this._deviceId);
  };

  window.AirConsole = AirConsole;
})();
