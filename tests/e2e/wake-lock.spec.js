// @ts-check
// The display holds the Screen Wake Lock while a party exists and only then
// (ttp_net_keep_awake, the rule the TV shells perform too): an empty lobby lets
// the screen sleep, a seated phone keeps it on, and the last phone leaving the
// lobby lets it sleep again. Headless Chromium refuses a real lock, so the API
// is stubbed with one that always grants.
const { test, expect, openDisplay, joinController } = require('./helpers');

test('the display holds its wake lock only while a phone is seated', async ({ page, browser }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          const s = new EventTarget();
          s.release = async () => { s.dispatchEvent(new Event('release')); };
          return s;
        }
      }
    });
  });
  const roomCode = await openDisplay(page);
  const held = () => page.evaluate(() => window.__wakeLock.active);

  expect(await held()).toBe(false);

  const alice = await joinController(browser, roomCode, 'Alice');
  await expect(page.locator('#players')).toContainText('Alice');
  await expect.poll(held).toBe(true);

  // In the lobby a phone that leaves frees its seat, and the party is over.
  await alice.context().close();
  await expect(page.locator('#players')).not.toContainText('Alice');
  await expect.poll(held).toBe(false);
});
