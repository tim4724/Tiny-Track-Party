// @ts-check
// The controller is LANDSCAPE-ONLY: a portrait viewport gets the full-screen
// rotate overlay (pure CSS on the orientation media query) over every screen,
// and turning the phone sideways clears it without a reload. The overlay is the
// plain-browser fallback — the CouchPad shell pins landscape via §10 instead.
const { test, expect, openDisplay } = require('./helpers');

test('portrait shows the rotate overlay; landscape hides it', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}`);

  // Portrait: the overlay covers the name screen (its card is what you see).
  await expect(phone.locator('#rotate')).toBeVisible();
  await expect(phone.locator('.rotate__title')).toHaveText('Turn your phone sideways');

  // "Rotate" the phone: the overlay leaves and the name form is usable.
  await phone.setViewportSize({ width: 844, height: 390 });
  await expect(phone.locator('#rotate')).toBeHidden();
  await expect(phone.locator('#name-input')).toBeVisible();
  await context.close();
});
