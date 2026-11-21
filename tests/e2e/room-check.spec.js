// @ts-check
// The controller asks the relay up front whether the room is there
// (ControllerNet.checkRoom): a gone or full room says so on the name screen
// before the player types a name, and a gone one is never dialled. In the
// launcher the same answer ends the session (§3).
const { test, expect } = require('./helpers');

const GONE = 'That race has ended. Scan a fresh QR code on the big screen.';
const FULL = 'This race is full. Wait for a free seat, then try again.';
// A link pinned (#<instance>) to a relay machine that's gone: Fly answers the
// pinned room check with a 400 that lacks CORS headers, which the page only
// sees as a network error. The unpinned check reaches the relay (the stub).
const goneMachine = (route) => (route.request().url().includes('instance=') ? route.abort() : route.fallback());
const noNetwork = (route) => route.abort();

async function openPhone(browser, path, { room, shell = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  if (room) await context.route(/\/room\//, room);
  if (shell) {
    // A gone machine's socket never answers either, so only the room check can
    // end this session in time.
    await context.routeWebSocket(/127\.0\.0\.1/, () => {});
    await context.addInitScript(() => {
      window.__cpEnded = null;
      window.PaperBalloonHost = { name: 'Ann', gameEnded: (reason) => { window.__cpEnded = reason; } };
    });
  }
  const page = await context.newPage();
  await page.goto(path);
  return page;
}

test('an unknown room says so before the player joins, and is never dialled', async ({ browser }) => {
  const phone = await openPhone(browser, '/ZZZZ');
  await expect(phone.locator('#name-status')).toHaveText(GONE);
  await phone.evaluate(() => window.__net.connect('Ann'));
  expect(await phone.evaluate(() => window.__net.party)).toBeNull();
  await expect(phone.locator('#name-status')).toHaveText(GONE);
});

test('a pin to a gone relay machine reads as a gone room', async ({ browser }) => {
  const phone = await openPhone(browser, '/ZZZZ#d8901edb095111', { room: goneMachine });
  await expect(phone.locator('#name-status')).toHaveText(GONE);
});

test('a check the relay never answers leaves the verdict to the join', async ({ browser }) => {
  const phone = await openPhone(browser, '/ZZZZ#d8901edb095111', { room: noNetwork });
  await phone.evaluate(() => window.__net.checkRoom());
  await expect(phone.locator('#name-status')).toHaveText('');
  expect(await phone.evaluate(() => window.__net._roomGone)).toBe(false);
});

test('a full room tells a newcomer before they join', async ({ browser }) => {
  const full = (route) => route.fulfill({
    status: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    contentType: 'application/json',
    body: JSON.stringify({ clients: 4, maxClients: 4 }),
  });
  const phone = await openPhone(browser, '/ZZZZ', { room: full });
  await expect(phone.locator('#name-status')).toHaveText(FULL);
});

test('in the launcher, a pin to a gone relay machine ends the session as room_not_found', async ({ browser }) => {
  const phone = await openPhone(browser, '/ZZZZ#d8901edb095111', { room: goneMachine, shell: true });
  await phone.waitForFunction(() => window.__cpEnded !== null, null, { timeout: 5000 });
  expect(await phone.evaluate(() => window.__cpEnded)).toBe('room_not_found');
});
