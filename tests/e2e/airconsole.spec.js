// @ts-check
// AirConsole mode, end to end: the generated screen.html / controller.html
// entries running the whole session flow over the mocked SDK
// (tests/e2e/airconsole-mock.js, a BroadcastChannel transport) — no relay
// involved, which is the point: the adapter IS the transport here, and this is
// the one place the AC entries, both bootstraps and the retained-state bridge
// (setStateFrame → setCustomDeviceState → onState) are exercised together.
//
// The mock is injected via addInitScript and the real SDK's CDN URL is blocked,
// so window.AirConsole is the mock everywhere the bootstraps look.
const { test, expect, waitForRacing, visible } = require('./helpers');
const path = require('path');

const MOCK_PATH = path.join(__dirname, 'airconsole-mock.js');

const blockSdk = (page) => page.route('**/airconsole-*.js', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: '// blocked: airconsole-mock.js is the SDK' }));

async function openAcDisplay(page) {
  await page.addInitScript(() => { window.__countdownSeconds = 1; });
  await page.addInitScript({ path: MOCK_PATH });
  await blockSdk(page);
  await page.goto('/screen.html');
  // No welcome board in AC — the LOBBY is the boot screen. Asserted HERE,
  // before the engine-boot waits below, so this pins the boot window itself:
  // the welcome is CSS-dead from first paint (display.css) and the bootstrap
  // reveals the lobby's static markup at DOMContentLoaded.
  await expect(page.locator('#welcome')).toBeHidden();
  await expect(page.locator('#lobby')).toBeVisible();
  // …and the room opens through the adapter (roomCode = the SDK ready code).
  await page.waitForFunction(() => {
    const n = window.__net;
    return !!(n && n.flow && n.party && n.roomCode);
  }, null, { timeout: 20000 });
  // The C++ room machine stays; only the transport is the adapter. Asserted
  // like helpers.openDisplay asserts the native pair — a silent fallback to
  // the relay connection would pass every wait above.
  const impls = await page.evaluate(() => ({
    flow: window.__net.flow.constructor.name,
    conn: window.__net.party.constructor.name
  }));
  expect(impls).toEqual({ flow: 'NativeRoomFlow', conn: 'TTPAirConsoleAdapter' });
  await page.evaluate(() => window.__sceneReady);
}

// A phone in AC mode. Unlike the relay suite, controllers open in the
// DISPLAY's context: the mock's transport is a BroadcastChannel, which only
// spans pages sharing a storage partition — an isolated context would be a
// phone on a different planet. (Also why parallel tests can't cross-talk:
// each test's context is its own partition.) Shared localStorage is harmless
// here — the AC storage shim replaces it per page, and clientIds are unused.
async function joinAcController(displayPage, deviceId, nickname) {
  const context = displayPage.context();
  const page = await context.newPage();
  await page.addInitScript(({ deviceId, nickname }) => {
    window.__AC_DEVICE_ID = deviceId;
    window.__AC_NICKNAME = nickname;
  }, { deviceId, nickname });
  await page.addInitScript({ path: MOCK_PATH });
  await blockSdk(page);
  await page.setViewportSize({ width: 844, height: 390 }); // landscape-only controller
  await page.goto('/controller.html');
  // No name form in AC — the profile nickname joins by itself once the mock
  // fires onReady (+250 ms). First lobby entry auto-shows the Settings popup:
  // the AC pref shim starts empty (a real AC device hydrates seen-help from
  // the platform's persistent data; the mock's is always fresh), so dismiss it
  // the way a first-run player would.
  await page.waitForSelector(visible('#lobby'), { timeout: 15000 });
  const done = page.locator('#settings-done');
  if (await done.isVisible()) await done.click();
  return page;
}

test('AC: screen boots to the lobby, profile-named phones join, a race runs', async ({ page }) => {
  await openAcDisplay(page);

  // The join ticket carries no QR and no URL line in AC (players pair through
  // the platform), and the tagline says so.
  await expect(page.locator('#qr')).toBeHidden();
  await expect(page.locator('#joinurl')).toBeHidden();
  await expect(page.locator('#tagline')).toContainText('AirConsole');

  const ana = await joinAcController(page, 101, 'Ana');   // first in → host
  const ben = await joinAcController(page, 102, 'Ben');
  await expect(page.locator('#players')).toContainText('Ana');
  await expect(page.locator('#players')).toContainText('Ben');
  // The phones joined under their AC profile names with no name screen.
  await expect(ana.locator('#me-name')).toHaveText('Ana');
  await expect(ben.locator('#me-name')).toHaveText('Ben');

  // Ready → start → countdown → racing, the same flow the relay suite drives.
  const readyBtn = ben.locator('#ready-btn');
  if (!(await readyBtn.evaluate((b) => b.classList.contains('is-pressed')))) await readyBtn.click();
  await ana.click('#ready-btn');
  await page.waitForSelector(visible('#race'));
  await ana.waitForSelector(visible('#game'));
  await ben.waitForSelector(visible('#game'));
  await waitForRacing(page);

  // Platform pause freezes the race through the same walk the pause button
  // drives (overlay up everywhere), and the platform resume lifts exactly it.
  await page.evaluate(() => window.airconsole.triggerPause());
  await page.waitForSelector(visible('#pause-overlay'));
  await ana.waitForSelector(visible('#pause-overlay'));
  await page.evaluate(() => window.airconsole.triggerResume());
  await page.waitForSelector('#pause-overlay.hidden', { state: 'attached' });

  // A live AC profile rename lands on the display roster (the launcher-rename
  // path, driven from onDeviceProfileChange).
  await ben.evaluate(() => window.airconsole.triggerProfileChange('Benji'));
  await expect(page.locator('#players')).toContainText('Benji');
});

test('AC: a dropped controller frees its lobby seat', async ({ page }) => {
  await openAcDisplay(page);
  const _ana = await joinAcController(page, 111, 'Ana'); // keeps a seat, so the roster change below is a REMOVAL
  const ben = await joinAcController(page, 112, 'Ben');
  await expect(page.locator('#players')).toContainText('Ben');

  // AC's onDisconnect is the liveness authority in this mode (our own expiry
  // is disabled) — the synthesized peer_left must free the seat in the lobby.
  await ben.evaluate(() => window.airconsole.triggerDisconnect());
  await ben.close();
  await expect(page.locator('#players')).not.toContainText('Ben');
  await expect(page.locator('#players')).toContainText('Ana');
});
