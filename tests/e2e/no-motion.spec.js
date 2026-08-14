// @ts-check
// A phone that cannot steer by tilt, by either of the two routes there.
//
// There is no dedicated "tilt isn't available" popup for this: startup forces
// button steering (main.js) and the normal Settings card explains — its Tilt
// row disabled with the badge flipped to "Not available"
// (refreshSettingsCard). This file is the only real-app gate on that path.
// Every other spec's phone is handed a level sensor by helpers.joinController,
// so it resolves 'granted', and the unit side (tiltinput.test.js) only covers
// motionState resolution, not what the phone shows.
const { test, expect, openDisplay } = require('./helpers');

// Both cases end in the same place, so assert it once.
async function expectButtonsForcedWithReason(phone) {
  // Lobby entry: the Settings card is up (the first-run tutorial); the old
  // dead-end "tilt isn't available" popup is not.
  await expect(phone.locator('#settings-overlay')).toBeVisible();
  await expect(phone.locator('#motion-overlay')).toBeHidden();

  // The Tilt row survives as the explanation — disabled, badge flipped.
  await expect(phone.locator('#input-tilt')).toBeDisabled();
  await expect(phone.locator('#input-tilt .mode-card__badge')).toHaveText('Not available');

  // Startup forced the mode that works here, and the card shows it.
  await expect(phone.locator('#input-buttons')).toHaveAttribute('aria-checked', 'true');
  await expect(phone.locator('#settings-card')).toHaveClass(/is-buttons/);
}

test('no DeviceOrientationEvent at all: buttons forced, Settings shows Tilt as Not available, no popup', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  // Hand-rolled join (vs helpers.joinController): this phone must lose its
  // sensor before any page script runs, and the seen-help flag stays UNSET so
  // the first-run Settings auto-show — the beat where this player learns tilt
  // exists but not for them — is the thing pinned.
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  await context.addInitScript(() => {
    // @ts-ignore — the deletion is the point
    delete window.DeviceOrientationEvent;
  });
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}`);
  await phone.fill('#name-input', 'NoTilt');
  await phone.click('#join-btn');

  await expectButtonsForcedWithReason(phone);

  // Dismiss; reopening the card keeps the row unavailable (it re-renders from
  // motionState on every open, not from the first-run beat).
  await phone.click('#settings-done');
  await expect(phone.locator('#settings-overlay')).toBeHidden();
  await phone.click('#settings-btn');
  await expect(phone.locator('#input-tilt')).toBeDisabled();
  await expect(phone.locator('#input-tilt .mode-card__badge')).toHaveText('Not available');
});

test('a sensor that is granted but silent lands in the same place', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  // Nothing is faked here: a plain headless Chromium HAS DeviceOrientationEvent
  // and simply never fires it, which is the real shape of an embedder that
  // withholds the sensors from its frame, and of a phone with no gyroscope.
  // Permission resolves 'granted' and the wheel would sit dead, so this is the
  // case the constructor check alone could never catch. joinController is
  // bypassed precisely because it installs the level-sensor feed.
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}`);
  await phone.fill('#name-input', 'Silent');
  await phone.click('#join-btn');

  await expectButtonsForcedWithReason(phone);
});
