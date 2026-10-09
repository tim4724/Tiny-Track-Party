// @ts-check
// Plain-browser fullscreen (orientation.js): any tap asks for fullscreen, and
// while the page is fullscreen a corner button leaves it. The auto-enter always
// stays on, so the next tap goes fullscreen again; the tap on the button itself
// must not, or the button would do nothing.
const { test, expect, openDisplay } = require('./helpers');

test('a tap enters fullscreen; the corner button leaves it; the next tap re-enters', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  // The touch gate keeps desktops out, so this phone has to be a touch device.
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}`);
  const isFullscreen = () => phone.evaluate(() => !!document.fullscreenElement);

  await expect(phone.locator('#fs-exit')).toBeHidden();
  await phone.locator('.name-wordmark').tap();
  await expect.poll(isFullscreen).toBe(true);
  await expect(phone.locator('#fs-exit')).toBeVisible();

  await phone.locator('#fs-exit').tap();
  await expect.poll(isFullscreen).toBe(false);
  await expect(phone.locator('#fs-exit')).toBeHidden();
  // The exit holds: nothing re-enters on its own, only a later tap.
  await phone.waitForTimeout(300);
  expect(await isFullscreen()).toBe(false);

  await phone.locator('.name-wordmark').tap();
  await expect.poll(isFullscreen).toBe(true);
  await expect(phone.locator('#fs-exit')).toBeVisible();
  await context.close();
});
