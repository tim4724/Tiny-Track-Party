'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// AirConsole is referenced at constructor time for the SCREEN constant; expose
// a minimal global before requiring the adapter.
global.AirConsole = { SCREEN: 0 };

const AirConsoleAdapter = require('../AirConsoleAdapter');

function makeFakeAirConsole(overrides) {
  return Object.assign({
    _master: undefined,
    getMasterControllerDeviceId() { return this._master; },
    getControllerDeviceIds() { return []; },
    getDeviceId() { return 1; },
    message() {},
    broadcast() {},
  }, overrides || {});
}

describe('AirConsoleAdapter PartyConnection interface', () => {
  it('implements the lifecycle no-ops (create/join/pinInstance/reconnectNow) without throwing', () => {
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
    });
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
    });
    assert.deepEqual(seen, []);
    assert.equal(adapter.connected, false);
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
