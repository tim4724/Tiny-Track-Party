// @ts-check
// The close button in a plain browser (closeButton.js + orientation.js): any tap
// asks for fullscreen, and the X is the way out of it. In a room it also backs
// out to the name screen; on the name screen, where there is no room to leave,
// it shows only while fullscreen. The auto-enter always stays on, so the next
// tap goes fullscreen again; the tap on the X itself must not, or the X would
// do nothing.
const { test, expect, openDisplay, visible } = require('./helpers');

test('on the name screen the X shows only while fullscreen, and leaves it', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  // The touch gate keeps desktops out, so this phone has to be a touch device.
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}`);
  const isFullscreen = () => phone.evaluate(() => !!document.fullscreenElement);

  await expect(phone.locator('#close-btn')).toBeHidden();
  await phone.locator('.name-wordmark').tap();
  await expect.poll(isFullscreen).toBe(true);
  await expect(phone.locator('#close-btn')).toBeVisible();

  await phone.locator('#close-btn').tap();
  await expect.poll(isFullscreen).toBe(false);
  await expect(phone.locator('#close-btn')).toBeHidden();
  // The exit holds: nothing re-enters on its own, only a later tap.
  await phone.waitForTimeout(300);
  expect(await isFullscreen()).toBe(false);

  await phone.locator('.name-wordmark').tap();
  await expect.poll(isFullscreen).toBe(true);
  await context.close();
});

test('in a room the X backs out to the name screen and leaves fullscreen', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  await context.addInitScript(() => {
    try { localStorage.setItem('tinytrack_seen_help', '1'); } catch (_) {}
  });
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}`);
  const isFullscreen = () => phone.evaluate(() => !!document.fullscreenElement);

  await phone.fill('#name-input', 'Ann');
  await phone.locator('#join-btn').tap();   // the join tap goes fullscreen too
  await phone.waitForSelector(visible('#lobby'));
  await expect(page.locator('#players')).toContainText('Ann');
  await expect.poll(isFullscreen).toBe(true);
  await expect(phone.locator('#close-btn')).toBeVisible();

  // No X while a dialog is up: a player reaching for it to close the dialog
  // would leave the game.
  await phone.locator('#settings-btn').tap();
  await expect(phone.locator('#settings-overlay')).toBeVisible();
  await expect(phone.locator('#close-btn')).toBeHidden();
  await phone.locator('#settings-done').tap();
  await expect(phone.locator('#close-btn')).toBeVisible();

  await phone.locator('#close-btn').tap();
  await phone.waitForSelector(visible('#name'));
  await expect.poll(isFullscreen).toBe(false);
  await expect(page.locator('#players')).not.toContainText('Ann');
  await expect(phone.locator('#close-btn')).toBeHidden();
  // The field is left unfocused: on a phone a focus raises the keyboard.
  await expect(phone.locator('#name-input')).not.toBeFocused();
  await context.close();
});
