'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// AirConsole is referenced at constructor time for the SCREEN constant; expose
// a minimal global before requiring the adapter.
global.AirConsole = { SCREEN: 0 };

const AirConsoleAdapter = require('../AirConsoleAdapter');
const PartyConnection = require('../PartyConnection');

function makeFakeAirConsole(overrides) {
  return Object.assign({
    _master: undefined,
    _screenState: undefined,
    getMasterControllerDeviceId() { return this._master; },
    getControllerDeviceIds() { return []; },
    getDeviceId() { return 1; },
    message() {},
    broadcast() {},
    setCustomDeviceState(data) { this._screenState = data; },
    getCustomDeviceState(id) { return id === global.AirConsole.SCREEN ? this._screenState : undefined; },
  }, overrides || {});
}

describe('AirConsoleAdapter PartyConnection interface', () => {
  it('implements the lifecycle no-ops (create/join/pinInstance/reconnectNow/closeRoom/failAttempt) without throwing', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    // The SDK owns the connection lifecycle; these must exist as safe no-ops so
    // game code written against PartyConnection (e.g. onRoomCreated's
    // pinInstance call) never throws when the adapter is swapped in.
    assert.equal(typeof adapter.pinInstance, 'function');
    assert.doesNotThrow(() => {
      adapter.create();
      adapter.join();
      adapter.pinInstance('wss://x', 'ROOM', 'inst');
      adapter.reconnectNow();
      adapter.closeRoom();
      adapter.failAttempt();
    });
  });

  // Drift guard: the adapter documents itself as PartyConnection-shaped, and
  // call sites (DisplayConnection / ControllerConnection) are written against
  // that surface with no transport branching. A method added to PartyConnection
  // and not mirrored here is a TypeError waiting on the AirConsole build.
  it('covers the whole public PartyConnection method surface', () => {
    const publicMethods = Object.getOwnPropertyNames(PartyConnection.prototype)
      .filter((k) => k !== 'constructor' && !k.startsWith('_'))
      .filter((k) => typeof Object.getOwnPropertyDescriptor(PartyConnection.prototype, k).value === 'function');
    const adapter = new AirConsoleAdapter(makeFakeAirConsole(), { role: 'display' });
    const missing = publicMethods.filter((k) => typeof adapter[k] !== 'function');
    assert.deepEqual(missing, [], `AirConsoleAdapter is missing: ${missing.join(', ')}`);
    // `connected` is a getter on both, so it falls outside the method sweep.
    assert.equal(typeof adapter.connected, 'boolean');
  });

  it('synthesizes created for display after connect and AirConsole ready', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    const seen = [];
    adapter.onProtocol = function(type, msg) { seen.push({ type, msg }); };

    adapter.connect();
    ac.onReady('ROOM42');

    assert.deepEqual(seen, [
      { type: 'created', msg: { room: 'ROOM42', index: 0 } },
    ]);
    assert.equal(adapter.connected, true);
  });

  it('synthesizes joined for controller after connect and AirConsole ready', () => {
    const ac = makeFakeAirConsole({ getDeviceId() { return 7; } });
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    const seen = [];
    adapter.onProtocol = function(type, msg) { seen.push({ type, msg }); };

    adapter.connect();
    ac.onReady('ROOM42');

    assert.deepEqual(seen, [
      { type: 'joined', msg: { room: 'ROOM42', index: 7, peers: [0] } },
    ]);
  });

  it('re-synthesizes peer_joined for controllers already connected when display becomes ready', () => {
    const ac = makeFakeAirConsole({ getControllerDeviceIds() { return [2, 5]; } });
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    const seen = [];
    adapter.onProtocol = function(type, msg) { seen.push({ type, msg }); };

    adapter.connect();
    ac.onReady('ROOM42');

    assert.deepEqual(seen, [
      { type: 'created', msg: { room: 'ROOM42', index: 0 } },
      { type: 'peer_joined', msg: { index: 2 } },
      { type: 'peer_joined', msg: { index: 5 } },
    ]);
  });

  it('runs onReady hook before synthesized protocol events', () => {
    const ac = makeFakeAirConsole();
    const calls = [];
    const adapter = new AirConsoleAdapter(ac, {
      role: 'display',
      onReady(code, readyAc) { calls.push(['hook', code, readyAc === ac]); },
    });
    adapter.onProtocol = function(type) { calls.push(['protocol', type]); };

    adapter.connect();
    ac.onReady('ROOM42');

    assert.deepEqual(calls, [
      ['hook', 'ROOM42', true],
      ['protocol', 'created'],
    ]);
  });

  it('neutralizes SDK callbacks on close', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    const seen = [];
    adapter.onProtocol = function(type) { seen.push(type); };

    adapter.close();

    assert.doesNotThrow(() => {
      ac.onReady('ROOM42');
      ac.onConnect(2);
      ac.onDisconnect(2);
      ac.onMessage(2, { type: 'PING' });
      ac.onPremium();
      ac.onCustomDeviceStateChange(0);
    });
    assert.deepEqual(seen, []);
    assert.equal(adapter.connected, false);
  });
});

describe('AirConsoleAdapter retained state (setState/onState)', () => {
  it('display setState maps to the SDK custom device state on the screen', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    adapter.setState({ hostPeerIndex: 2, players: { 2: { name: 'A', color: 1 } } });
    assert.deepEqual(ac.getCustomDeviceState(global.AirConsole.SCREEN), {
      hostPeerIndex: 2, players: { 2: { name: 'A', color: 1 } },
    });
  });

  it('controller setState is a no-op (controllers do not author screen state)', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    adapter.setState({ x: 1 });
    assert.equal(ac.getCustomDeviceState(global.AirConsole.SCREEN), undefined);
  });

  it('controller onState fires when the screen state changes', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    const seen = [];
    adapter.onState = function(data) { seen.push(data); };
    ac._screenState = { hostPeerIndex: 0, players: {} };
    ac.onCustomDeviceStateChange(global.AirConsole.SCREEN);
    assert.deepEqual(seen, [{ hostPeerIndex: 0, players: {} }]);
  });

  it('controller onState ignores non-screen device state changes', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    const seen = [];
    adapter.onState = function(data) { seen.push(data); };
    ac.onCustomDeviceStateChange(3); // another controller's device state
    assert.deepEqual(seen, []);
  });

  it('display does not consume its own custom device state', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    const seen = [];
    adapter.onState = function(data) { seen.push(data); };
    ac._screenState = { hostPeerIndex: 0, players: {} };
    ac.onCustomDeviceStateChange(global.AirConsole.SCREEN);
    assert.deepEqual(seen, []);
  });

  it('replays existing screen state to a controller right after joined', () => {
    const ac = makeFakeAirConsole({ getDeviceId() { return 7; } });
    ac._screenState = { hostPeerIndex: 1, players: { 1: { name: 'A', color: 0 } } };
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    const order = [];
    adapter.onProtocol = function(type) { order.push(['protocol', type]); };
    adapter.onState = function(data) { order.push(['state', data]); };

    adapter.connect();
    ac.onReady('ROOM42');

    // joined first, then the retained state replay, mirroring the relay ordering
    assert.deepEqual(order, [
      ['protocol', 'joined'],
      ['state', { hostPeerIndex: 1, players: { 1: { name: 'A', color: 0 } } }],
    ]);
  });

  it('does not replay when the screen has no state yet', () => {
    const ac = makeFakeAirConsole({ getDeviceId() { return 7; } });
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    const seen = [];
    adapter.onState = function(data) { seen.push(data); };
    adapter.connect();
    ac.onReady('ROOM42');
    assert.deepEqual(seen, []);
  });
});

describe('AirConsoleAdapter.getMasterPeerIndex', () => {
  it('returns null when no controller is connected', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    assert.equal(adapter.getMasterPeerIndex(), null);
  });

  it('returns the numeric master device id when present', () => {
    const ac = makeFakeAirConsole({ _master: 7 });
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    assert.equal(adapter.getMasterPeerIndex(), 7);
  });

  it('returns null from the controller role', () => {
    const ac = makeFakeAirConsole({ _master: 7 });
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    assert.equal(adapter.getMasterPeerIndex(), null);
  });
});

describe('AirConsoleAdapter onPremium', () => {
  it('fires master_changed protocol event on display', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    const seen = [];
    adapter.onProtocol = function(type, msg) { seen.push({ type, msg }); };
    ac.onPremium();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'master_changed');
  });

  it('does not fire master_changed from the controller role', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    const seen = [];
    adapter.onProtocol = function(type) { seen.push(type); };
    ac.onPremium();
    assert.deepEqual(seen, []);
  });
});
