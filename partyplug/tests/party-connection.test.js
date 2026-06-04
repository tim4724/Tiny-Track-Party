'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Mock WebSocket for testing PartyConnection without a real server
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    this._sent = [];
    this._closed = false;

    MockWebSocket._instances.push(this);
  }

  send(data) {
    this._sent.push(JSON.parse(data));
  }

  close() {
    this._closed = true;
    this.readyState = 3;
  }

  // Test helpers
  _simulateOpen() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  _simulateClose(event) {
    this.readyState = 3;
    if (this.onclose) this.onclose(event || {});
  }

  _simulateMessage(data) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  _simulateError() {
    if (this.onerror) this.onerror(new Error('simulated'));
  }
}
MockWebSocket._instances = [];

// Inject mock before importing
global.WebSocket = MockWebSocket;

const PartyConnection = require('../PartyConnection');

describe('PartyConnection', () => {
  beforeEach(() => {
    MockWebSocket._instances = [];
  });

  test('connect creates a WebSocket', () => {
    const pc = new PartyConnection('wss://test.example.com', { clientId: 'abc' });
    pc.connect();
    assert.strictEqual(MockWebSocket._instances.length, 1);
    assert.strictEqual(MockWebSocket._instances[0].url, 'wss://test.example.com');
  });

  test('auto-generates a clientId when none is provided', () => {
    const a = new PartyConnection('wss://test.example.com');
    const b = new PartyConnection('wss://test.example.com');
    assert.equal(typeof a.clientId, 'string');
    assert.ok(a.clientId.length > 0);
    assert.notEqual(a.clientId, b.clientId);   // unique per instance
  });

  test('uses a provided clientId verbatim and sends it on create/join', () => {
    const pc = new PartyConnection('wss://test.example.com', { clientId: 'abc' });
    assert.equal(pc.clientId, 'abc');
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.create(4);
    const inst = MockWebSocket._instances[0];
    const sent = inst._sent[inst._sent.length - 1];
    assert.equal(sent.type, 'create');
    assert.equal(sent.clientId, 'abc');
  });

  test('pinInstance assembles the sharded relay URL with encoding', () => {
    const pc = new PartyConnection('wss://relay.example.com', { clientId: 'display' });
    pc.pinInstance('wss://relay.example.com', 'MY-ROOM', 'inst-1');
    assert.equal(pc.relayUrl, 'wss://relay.example.com/MY-ROOM?instance=inst-1');
    // URI-special characters in room/instance are percent-encoded
    pc.pinInstance('wss://relay.example.com', 'a b/c', 'i?d=1');
    assert.equal(pc.relayUrl, 'wss://relay.example.com/a%20b%2Fc?instance=i%3Fd%3D1');
    // a null/empty instance is a no-op (keeps the current URL)
    const before = pc.relayUrl;
    pc.pinInstance('wss://relay.example.com', 'X', null);
    assert.equal(pc.relayUrl, before);
  });

  test('onOpen callback fires on connection', () => {
    const pc = new PartyConnection('wss://test.example.com');
    let opened = false;
    pc.onOpen = () => { opened = true; };
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    assert.strictEqual(opened, true);
  });

  test('onMessage callback fires for relay messages', () => {
    const pc = new PartyConnection('wss://test.example.com');
    let received = null;
    pc.onMessage = (from, data) => { received = { from, data }; };
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    MockWebSocket._instances[0]._simulateMessage({ type: 'message', from: 1, data: { action: 'left' } });
    assert.deepStrictEqual(received, { from: 1, data: { action: 'left' } });
  });

  test('onProtocol callback fires for non-message types', () => {
    const pc = new PartyConnection('wss://test.example.com');
    let received = null;
    pc.onProtocol = (type, msg) => { received = { type, msg }; };
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    MockWebSocket._instances[0]._simulateMessage({ type: 'created', room: 'ABCD' });
    assert.strictEqual(received.type, 'created');
    assert.strictEqual(received.msg.room, 'ABCD');
  });

  test('onError callback fires on WebSocket error', () => {
    const pc = new PartyConnection('wss://test.example.com');
    let errored = false;
    pc.onError = () => { errored = true; };
    pc.connect();
    MockWebSocket._instances[0]._simulateError();
    assert.strictEqual(errored, true);
  });

  test('sendTo sends correctly formatted message', () => {
    const pc = new PartyConnection('wss://test.example.com', { clientId: 'display' });
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.sendTo(1, { type: 'WELCOME', color: 'red' });
    assert.deepStrictEqual(MockWebSocket._instances[0]._sent[0], {
      type: 'send',
      data: { type: 'WELCOME', color: 'red' },
      to: 1
    });
  });

  test('broadcast sends without to field', () => {
    const pc = new PartyConnection('wss://test.example.com');
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.broadcast({ type: 'GAME_START' });
    assert.deepStrictEqual(MockWebSocket._instances[0]._sent[0], {
      type: 'send',
      data: { type: 'GAME_START' }
    });
  });

  test('connected returns true when WebSocket is open', () => {
    const pc = new PartyConnection('wss://test.example.com');
    assert.ok(!pc.connected); // null before connect
    pc.connect();
    assert.ok(!pc.connected); // readyState=0 (CONNECTING)
    MockWebSocket._instances[0]._simulateOpen();
    assert.strictEqual(pc.connected, true);
  });

  test('close stops reconnection and closes WebSocket', () => {
    const pc = new PartyConnection('wss://test.example.com');
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.close();
    assert.ok(!pc.connected);
    assert.strictEqual(MockWebSocket._instances[0]._closed, true);
  });
});

describe('PartyConnection - reconnect with exponential backoff', () => {
  beforeEach(() => {
    MockWebSocket._instances = [];
  });

  test('onClose increments reconnectAttempt', () => {
    const pc = new PartyConnection('wss://test.example.com');
    assert.strictEqual(pc.reconnectAttempt, 0);
    pc.connect();
    MockWebSocket._instances[0]._simulateClose();
    assert.strictEqual(pc.reconnectAttempt, 1);
  });

  test('onClose calls callback with attempt count', () => {
    const pc = new PartyConnection('wss://test.example.com', { maxReconnectAttempts: 3 });
    let closeArgs = null;
    pc.onClose = (attempt, max) => { closeArgs = { attempt, max }; };
    pc.connect();
    MockWebSocket._instances[0]._simulateClose();
    assert.deepStrictEqual(closeArgs, { attempt: 1, max: 3 });
  });

  test('relay eviction close stops reconnecting and reports replacement', () => {
    const pc = new PartyConnection('wss://test.example.com', { maxReconnectAttempts: 3 });
    let closeArgs = null;
    pc.onClose = (attempt, max, meta) => { closeArgs = { attempt, max, meta }; };
    pc.connect();

    MockWebSocket._instances[0]._simulateClose({ code: 4000 });

    assert.strictEqual(pc._shouldReconnect, false);
    assert.strictEqual(pc.reconnectAttempt, 0);
    assert.deepStrictEqual(closeArgs, {
      attempt: 0,
      max: 0,
      meta: { replaced: true },
    });
    assert.strictEqual(MockWebSocket._instances.length, 1);
  });

  test('reconnect stops after maxReconnectAttempts', () => {
    const pc = new PartyConnection('wss://test.example.com', { maxReconnectAttempts: 2 });
    pc.connect();
    // First close (attempt=1) — schedules reconnect
    MockWebSocket._instances[0]._simulateClose();
    assert.strictEqual(pc.reconnectAttempt, 1);
    // Manually trigger second connect (simulating the timer firing)
    pc.connect();
    // Second close (attempt=2) — still schedules reconnect (2 <= 2)
    MockWebSocket._instances[MockWebSocket._instances.length - 1]._simulateClose();
    assert.strictEqual(pc.reconnectAttempt, 2);
    // Manually trigger third connect
    pc.connect();
    // Third close (attempt=3) — exceeds max, no more reconnects
    const instanceCountBefore = MockWebSocket._instances.length;
    MockWebSocket._instances[MockWebSocket._instances.length - 1]._simulateClose();
    assert.strictEqual(pc.reconnectAttempt, 3);
    assert.strictEqual(MockWebSocket._instances.length, instanceCountBefore);
  });

  test('resetReconnectCount resets attempt counter', () => {
    const pc = new PartyConnection('wss://test.example.com');
    pc.connect();
    MockWebSocket._instances[0]._simulateClose();
    assert.strictEqual(pc.reconnectAttempt, 1);
    pc.resetReconnectCount();
    assert.strictEqual(pc.reconnectAttempt, 0);
  });

  test('reconnectNow creates a fresh connection', () => {
    const pc = new PartyConnection('wss://test.example.com');
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    const firstWs = MockWebSocket._instances[0];
    pc.reconnectNow();
    assert.strictEqual(MockWebSocket._instances.length, 2);
    assert.strictEqual(firstWs._closed, true);
    assert.notStrictEqual(pc.ws, firstWs);
  });

  test('relayUrl mutation is picked up by subsequent reconnect', () => {
    // DisplayConnection rewrites party.relayUrl after `created` so the
    // PartyConnection auto-reconnect path lands back on the same instance
    // shard. Lock that contract in.
    const pc = new PartyConnection('wss://test.example.com');
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.relayUrl = 'wss://test.example.com/ROOM?instance=xyz';
    pc.reconnectNow();
    assert.strictEqual(MockWebSocket._instances.length, 2);
    assert.strictEqual(MockWebSocket._instances[1].url, 'wss://test.example.com/ROOM?instance=xyz');
  });

  test('stale WebSocket events are ignored after reconnect', () => {
    const pc = new PartyConnection('wss://test.example.com');
    let openCount = 0;
    pc.onOpen = () => { openCount++; };
    pc.connect();
    const staleWs = MockWebSocket._instances[0];
    pc.reconnectNow();
    // Stale WS fires open — should be ignored
    staleWs.readyState = 1;
    if (staleWs.onopen) staleWs.onopen();
    // New WS fires open — should be counted
    MockWebSocket._instances[1]._simulateOpen();
    assert.strictEqual(openCount, 1);
  });

  test('_scheduleReconnect uses exponential backoff capped at 5s', () => {
    // delay = min(1000 * 1.5^(attempt-1), 5000): 1000, 1500, 2250, 3375,
    // then 5000 (capped) from attempt 5 on.
    const pc = new PartyConnection('wss://test.example.com');
    const delays = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, delay) => { delays.push(delay); return 0; };
    try {
      for (const attempt of [1, 2, 3, 4, 5, 10]) {
        pc.reconnectAttempt = attempt;
        pc._scheduleReconnect();
      }
    } finally {
      global.setTimeout = realSetTimeout;
    }
    assert.deepStrictEqual(delays, [1000, 1500, 2250, 3375, 5000, 5000]);
  });

  test('create sends correct relay message', () => {
    const pc = new PartyConnection('wss://test.example.com', { clientId: 'display' });
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.create(5);
    assert.deepStrictEqual(MockWebSocket._instances[0]._sent[0], {
      type: 'create',
      clientId: 'display',
      maxClients: 5
    });
  });

  test('join sends correct relay message', () => {
    const pc = new PartyConnection('wss://test.example.com', { clientId: 'player1' });
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.join('ABCD');
    assert.deepStrictEqual(MockWebSocket._instances[0]._sent[0], {
      type: 'join',
      clientId: 'player1',
      room: 'ABCD'
    });
  });
});
