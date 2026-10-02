// @ts-check
// A phone that cannot steer by tilt, by either of the two routes there.
//
// There is no dedicated "tilt isn't available" popup for this: the phone is put
// on button steering (main.js onMotionState) and the normal Settings card
// explains — its Tilt row disabled with the badge flipped to "Not available"
// (refreshSettingsCard). This file is the only real-app gate on that path, and
// on its reverse: a sensor that was only slow takes the open card back to Tilt.
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

  // The Tilt row survives as the explanation — disabled, badge flipped. A
  // granted-but-silent sensor only gets there once the no-sample window ends.
  const { SENSOR_SETTLE_MS } = await import('../../public/controller/TiltInput.js');
  await expect(phone.locator('#input-tilt')).toBeDisabled({ timeout: SENSOR_SETTLE_MS + 5000 });
  await expect(phone.locator('#input-tilt .mode-card__badge')).toHaveText('Not available');

  // The phone was put on the mode that works here, and the card shows it.
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

test('a sensor that is granted but silent lands in the same place, on the card already open', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  // No feed is faked here: a headless Chromium HAS DeviceOrientationEvent and,
  // once the sensor permission is GRANTED, simply never fires it — the real
  // shape of an embedder that withholds the sensors from its frame, and of a
  // phone with no gyroscope. The wheel would sit dead, so this is the case the
  // constructor check alone could never catch. joinController is bypassed
  // precisely because it installs the level-sensor feed; the grant is kept,
  // because without it Chromium answers 'prompt' and that is a different
  // state (unknown, re-asked on the next tap), not this one. The phone joins on
  // tilt and falls back in the background, so the first-run card is open when
  // the verdict lands: the assertions below are the card redrawing in place.
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  await context.grantPermissions(['accelerometer', 'gyroscope', 'magnetometer']);
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}`);
  await phone.fill('#name-input', 'Silent');
  await phone.click('#join-btn');

  await expectButtonsForcedWithReason(phone);
});

test('a sensor that answers late takes the open card back to Tilt', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  // The first-run shape from a cold launcher WebView: granted, but the first
  // sample lands after the no-sample window. The phone falls back to buttons,
  // then the late sample must restore tilt on the card that is still open —
  // not only on the next open.
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  await context.grantPermissions(['accelerometer', 'gyroscope', 'magnetometer']);
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}`);
  await phone.fill('#name-input', 'Slow');
  await phone.click('#join-btn');

  await expectButtonsForcedWithReason(phone);

  await phone.evaluate(() => window.dispatchEvent(
    new DeviceOrientationEvent('deviceorientation', { beta: 0, gamma: 0 })));
  await expect(phone.locator('#input-tilt')).toBeEnabled();
  await expect(phone.locator('#input-tilt .mode-card__badge')).toHaveText('Recommended');
  await expect(phone.locator('#input-tilt')).toHaveAttribute('aria-checked', 'true');
  await expect(phone.locator('#settings-card')).not.toHaveClass(/is-buttons/);
});
