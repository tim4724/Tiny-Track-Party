// @ts-check
// Shared helpers for the E2E suite. Every page is pointed at the local relay
// stub via the ?relay= override (shared/protocol.js); each controller gets its
// OWN browser context so per-room clientIds (localStorage) don't collide —
// two pages in one context would evict each other's relay slot.
//
// Import `test`/`expect` from HERE, not @playwright/test: the extended test
// closes every context a spec opened, so leaked phone pages (rAF loops, 25 Hz
// CONTROL streams) can't starve the single worker across tests.

const base = require('@playwright/test');

const RELAY = `ws://127.0.0.1:${process.env.PW_RELAY_PORT || 4201}`;
const relayQuery = `relay=${encodeURIComponent(RELAY)}`;

const test = base.test.extend({
  // Auto fixture: after each test, reap every context the spec opened
  // (closing the built-in page's context twice is a safe no-op).
  _reapContexts: [async ({ browser }, use) => {
    await use(undefined);
    for (const ctx of browser.contexts()) await ctx.close();
  }, { auto: true }],
});

// Open the display, wait for its room + the 3D scene (startRace gates on
// sceneReady, so tests must not press Start before the GLBs are in).
async function openDisplay(page) {
  await page.goto(`/?${relayQuery}`);
  await page.waitForFunction(() => window.__net && window.__net.roomCode, null, { timeout: 20000 });
  await page.evaluate(() => window.__sceneReady);
  return page.evaluate(() => window.__net.roomCode);
}

// New phone: fresh context (own localStorage) + join through the name form.
// Returns the controller page. Does NOT assert which screen it lands on —
// a mid-race joiner lands on the waiting lobby, others on the normal lobby.
async function joinController(browser, roomCode, name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`/${roomCode}?${relayQuery}`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#name.hidden', { state: 'attached', timeout: 15000 });
  return page;
}

// Ready up every non-host phone, then the host presses "Start race" (the
// button enables itself once everyone else is ready — Playwright's click
// auto-waits on that).
async function startRace(host, others) {
  for (const p of others) await p.click('#ready-btn');
  await host.click('#ready-btn');
}

const visible = (sel) => `${sel}:not(.hidden)`;

module.exports = { test, expect: base.expect, RELAY, relayQuery, openDisplay, joinController, startRace, visible };
