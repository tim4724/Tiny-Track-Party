'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const AirConsoleStorage = require('../AirConsoleStorage');

describe('AirConsoleStorage.install', () => {
  let prevWindow;
  beforeEach(() => { prevWindow = global.window; });
  afterEach(() => {
    if (prevWindow === undefined) delete global.window;
    else global.window = prevWindow;
  });

  function installShim(persistentDataByUid) {
    const writes = [];
    const ac = {
      _deviceId: 1,
      getDeviceId() { return this._deviceId; },
      getUID(id) { return 'uid_' + id; },
      storePersistentData(key, value) { writes.push({ key, value }); },
      requestPersistentData(uids) {
        const data = {};
        for (const u of uids) data[u] = persistentDataByUid[u] || {};
        setTimeout(() => {
          if (this.onPersistentDataLoaded) this.onPersistentDataLoaded(data);
        }, 0);
      },
    };
    global.window = { localStorage: undefined };
    const shim = AirConsoleStorage.install(ac, {
      allowlist: [
        'stacker_haptic_strength',
        'stacker_touch_sensitivity',
        'stacker_touch_sounds',
        'stacker_color_index'
      ]
    });
    return { ac, shim, writes };
  }

  it('drops non-allowlisted keys on read and write', () => {
    const { shim, writes } = installShim({ uid_1: { stacker_player_name: 'Alice', clientId_ABC: 'x' } });
    shim.setItem('stacker_player_name', 'Bob');
    shim.setItem('clientId_ABC', 'y');
    shim.setItem('stacker_muted', '1');
    assert.deepEqual(writes, []);
    assert.equal(shim.getItem('stacker_player_name'), null);
    assert.equal(shim.getItem('clientId_ABC'), null);
    assert.equal(shim.getItem('stacker_muted'), null);
  });

  it('round-trips allowlisted keys via cache + storePersistentData', () => {
    const { shim, writes } = installShim({});
    shim.setItem('stacker_haptic_strength', 'strong');
    shim.setItem('stacker_touch_sensitivity', '60');
    shim.setItem('stacker_touch_sounds', '1');
    shim.setItem('stacker_color_index', '5');
    assert.deepEqual(writes, [
      { key: 'stacker_haptic_strength', value: 'strong' },
      { key: 'stacker_touch_sensitivity', value: '60' },
      { key: 'stacker_touch_sounds', value: '1' },
      { key: 'stacker_color_index', value: '5' },
    ]);
    assert.equal(shim.getItem('stacker_haptic_strength'), 'strong');
    assert.equal(shim.getItem('stacker_touch_sensitivity'), '60');
    assert.equal(shim.getItem('stacker_touch_sounds'), '1');
    assert.equal(shim.getItem('stacker_color_index'), '5');
  });

  it('writes immediately for changed values and skips redundant writes', () => {
    const { shim, writes } = installShim({});
    shim.setItem('stacker_touch_sensitivity', '60');
    shim.setItem('stacker_touch_sensitivity', '60');
    shim.setItem('stacker_touch_sensitivity', '61');
    assert.deepEqual(writes, [
      { key: 'stacker_touch_sensitivity', value: '60' },
      { key: 'stacker_touch_sensitivity', value: '61' },
    ]);
  });

  it('hydrates cache from onPersistentDataLoaded, allowlist-filtered', () => {
    const { ac, shim } = installShim({});
    ac.onPersistentDataLoaded({
      uid_1: {
        stacker_haptic_strength: 'light',
        stacker_touch_sensitivity: '72',
        stacker_player_name: 'Alice',
      },
    });
    assert.equal(shim.getItem('stacker_haptic_strength'), 'light');
    assert.equal(shim.getItem('stacker_touch_sensitivity'), '72');
    assert.equal(shim.getItem('stacker_player_name'), null);
  });

  it('onLoad fires after first hydration and immediately when already loaded', () => {
    const { ac, shim } = installShim({});
    let calls = 0;
    shim.onLoad(() => { calls++; });
    assert.equal(calls, 0);
    ac.onPersistentDataLoaded({ uid_1: { stacker_haptic_strength: 'medium' } });
    assert.equal(calls, 1);
    shim.onLoad(() => { calls++; });
    assert.equal(calls, 2);
  });

  it('removeItem and clear write null through to AirConsole', () => {
    const { shim, writes } = installShim({});
    shim.setItem('stacker_haptic_strength', 'strong');
    shim.setItem('stacker_touch_sensitivity', '60');
    shim.removeItem('stacker_haptic_strength');
    shim.clear();
    assert.equal(shim.length, 0);
    assert.equal(shim.getItem('stacker_haptic_strength'), null);
    assert.equal(shim.getItem('stacker_touch_sensitivity'), null);
    assert.deepEqual(writes.slice(2), [
      { key: 'stacker_haptic_strength', value: null },
      { key: 'stacker_haptic_strength', value: null },
      { key: 'stacker_touch_sensitivity', value: null },
      { key: 'stacker_touch_sounds', value: null },
      { key: 'stacker_color_index', value: null },
    ]);
  });

  it('clear nulls every allowlisted key even before hydration', () => {
    const { shim, writes } = installShim({ uid_1: { stacker_color_index: '5' } });
    shim.clear();
    assert.deepEqual(writes, [
      { key: 'stacker_haptic_strength', value: null },
      { key: 'stacker_touch_sensitivity', value: null },
      { key: 'stacker_touch_sounds', value: null },
      { key: 'stacker_color_index', value: null },
    ]);
  });

  it('hydration does not clobber a local setItem made before the load resolves', () => {
    const { ac, shim } = installShim({ uid_1: { stacker_haptic_strength: 'light' } });
    shim.setItem('stacker_haptic_strength', 'strong');
    ac.onPersistentDataLoaded({ uid_1: { stacker_haptic_strength: 'light' } });
    assert.equal(shim.getItem('stacker_haptic_strength'), 'strong');
  });

  it('requestLoad triggers AC fetch and chains existing onPersistentDataLoaded', async () => {
    const { ac, shim } = installShim({ uid_1: { stacker_touch_sensitivity: '88' } });
    let prevHandlerCalled = false;
    ac.onPersistentDataLoaded = (function (prev) {
      return function (data) {
        prevHandlerCalled = true;
        if (prev) prev.call(ac, data);
      };
    })(ac.onPersistentDataLoaded);
    let loaded = false;
    shim.onLoad(() => { loaded = true; });
    shim.requestLoad();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(loaded, true);
    assert.equal(shim.getItem('stacker_touch_sensitivity'), '88');
    assert.equal(prevHandlerCalled, true);
  });
});
