'use strict';
// public/shared/wakeLock.js against a Screen Wake Lock whose grant is async.
//
// The display calls enable() or disable() on every roster render, so calls
// overlap the grant. A sentinel granted after a disable(), or a second one
// requested while the first was pending, is held by nothing and keeps the
// screen on for good; this pins that none survives.
const test = require('node:test');
const assert = require('node:assert/strict');

async function harness() {
  const state = { live: 0, requests: 0 };
  globalThis.document = { visibilityState: 'visible', addEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      wakeLock: {
        request: async () => {
          state.requests++;
          await new Promise((r) => setTimeout(r, 5));
          state.live++;
          const s = new EventTarget();
          s.release = async () => { state.live--; s.dispatchEvent(new Event('release')); };
          return s;
        }
      }
    }
  });
  const { createWakeLock } = await import('../public/shared/wakeLock.js');
  return { state, lock: createWakeLock() };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('two enables while the grant is pending take one lock', async () => {
  const { state, lock } = await harness();
  lock.enable();
  lock.enable();
  await settle();
  assert.equal(state.requests, 1);
  assert.equal(state.live, 1);
  lock.disable();
  await settle();
  assert.equal(state.live, 0);
});

test('a grant that lands after disable() is handed back', async () => {
  const { state, lock } = await harness();
  lock.enable();
  lock.disable();
  await settle();
  assert.equal(state.live, 0);
  assert.equal(lock.active, false);
});

test('enable() again before the grant keeps it', async () => {
  const { state, lock } = await harness();
  lock.enable();
  lock.disable();
  lock.enable();
  await settle();
  assert.equal(state.live, 1);
  assert.equal(lock.active, true);
});
