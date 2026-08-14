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
//
// LIVE mode (AC_LIVE=1, local only): the REAL SDK through AirConsole's HTTP
// simulator — see the describe block at the bottom. Not part of the default
// suite: it needs the network, a headed Firefox, and ~2 minutes.
const { test, expect, installLevelSensor, startRace, waitForRacing, visible } = require('./helpers');
const { firefox } = require('@playwright/test');
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
  // A DELEGATED frame: the sensors reach it and DeviceOrientation fires. That
  // is the case this spec is about (the tilt assertion below), and it has to be
  // said out loud now, because a frame that gets nothing resolves 'unsupported'
  // and falls back to buttons — which is what real AirConsole does today, and
  // what tests/e2e/no-motion.spec.js covers.
  await installLevelSensor(page);
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

  // The join ticket carries no QR, no URL line and no scan hint in AC —
  // players pair through the platform's own UI.
  await expect(page.locator('#qr')).toBeHidden();
  await expect(page.locator('#joinurl')).toBeHidden();
  await expect(page.locator('#tagline')).toBeHidden();

  // …and no perf HUD: AC is the one surface strangers play, so the frame-cost
  // readout that every dev surface wants pinned to the corner would be a bug
  // they cannot dismiss. ("P" still toggles it on for the simulator.)
  expect(await page.evaluate(() => window.__perf.visible)).toBe(false);

  const ana = await joinAcController(page, 101, 'Ana');   // first in → host
  const ben = await joinAcController(page, 102, 'Ben');
  await expect(page.locator('#players')).toContainText('Ana');
  await expect(page.locator('#players')).toContainText('Ben');
  // The phones joined under their AC profile names with no name screen.
  await expect(ana.locator('#me-name')).toHaveText('Ana');
  await expect(ben.locator('#me-name')).toHaveText('Ben');

  // Ready → start → countdown → racing, the same flow the relay suite drives
  // (startRace knows the host bar is a stepper: Select race → Start race).
  await startRace(ana, [ben]);
  await page.waitForSelector(visible('#race'));
  await ana.waitForSelector(visible('#game'));
  await ben.waitForSelector(visible('#game'));
  await waitForRacing(page);

  // TILT rides plain DeviceOrientation while the SDK's device_motion relay is
  // UNPLUGGED (see controller-airconsole.js) — the AC auto-join attached the
  // listener without a gesture (Chromium has no requestPermission), and
  // joinAcController's feed proved it delivers, so the phone stayed in tilt.
  // Synthesize a 30° right lean — gamma = ROLL_LOCK, full lock — and the
  // steer output must swing right; a few events, because the steer low-pass
  // converges per sample.
  await ana.evaluate(() => {
    for (let i = 0; i < 8; i++) {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 0, gamma: 30 }));
    }
  });
  expect(await ana.evaluate(() => window.__tilt.state.steer)).toBeGreaterThan(0.9);
  await ana.evaluate(() => {
    for (let i = 0; i < 8; i++) {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 0, gamma: 0 }));
    }
  });

  // The latency chip lights over the AC transport (TEMPORARY: the WS ping runs
  // in AC for real-platform readings) — which also proves the display's C++
  // net walk answers PING through the adapter. A digit-anchored match: the
  // pre-sample placeholder is '-- ms' and a dead link reads 'no signal', so
  // only a real round trip satisfies it.
  await expect(ana.locator('#latency')).toContainText(/\d+ ms/, { timeout: 5000 });

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

// The couch's star record is the one durable thing the display owns, and in AC
// it cannot ride the iframe's localStorage — that is shimmed onto AirConsole
// persistent data, which hydrates AFTER main.js's synchronous boot read has
// already loaded a fresh couch. So the re-apply on storage.onLoad is the whole
// mechanism, and without it AC players would silently never keep a cup: no
// stars, and the Playroom locked forever.
//
// Read off the TV's own Cups shelf, which the re-apply rebuilds: its star row
// carries the count in an aria-label, so the assertion is rendered state and
// not an internal.
const beachStars = (page) =>
  page.locator('.cup-shelf__row', { hasText: 'Beach' }).locator('.starrow');

test('AC: a played-before couch keeps its cups (progression hydrates from the platform)', async ({ page }) => {
  await page.addInitScript(() => {
    window.__AC_PERSISTENT = { tinytrack_progress: '{"v":1,"cups":{"beach":{"best":1}}}' };
  });
  await openAcDisplay(page);
  // Hydration lands after boot, so this is a wait, not a read: the shelf shows
  // the fresh couch first and is rebuilt when the platform's record arrives.
  await expect(beachStars(page)).toHaveAttribute('aria-label', '3 of 3 stars');
});

test('AC: a first-time couch starts on a fresh record', async ({ page }) => {
  // The other half of the pair: with no platform record the boot load stands,
  // so the test above is proving hydration and not "beach always has stars".
  await openAcDisplay(page);
  await expect(beachStars(page)).toHaveAttribute('aria-label', '0 of 3 stars');
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

// ---------------------------------------------------------------------------
// LIVE mode — the REAL AirConsole SDK, no mock. Opt-in (AC_LIVE=1, never CI):
// it drives AirConsole's HTTP simulator against this suite's own localhost
// server, which is why the AC entries' non-prod CSP admits
// http.airconsole.com as a frame ancestor. Ported from HexStacker's live
// mode: headed Firefox, the pairing code scraped off the simulator's screen
// frame, the controller joining via ?role=controller#!code=, and our frames
// found by body.airconsole — the simulator hosts the game iframe at
// about:blank (it injects the HTML), so URLs identify nothing.
// ---------------------------------------------------------------------------
const USE_LIVE = process.env.AC_LIVE === '1' && !process.env.CI;

// The simulator prompts for a Game ID via a native dialog before routing the
// session; answer it on every page so it can't sit open and re-fire. The game
// is not registered yet, so any well-formed id routes the dev session.
const AC_GAME_ID = 'games.couchpad.tinytrack';
function autoAnswerAcGameId(page) {
  page.on('dialog', (dialog) => {
    if (dialog.type() === 'prompt') dialog.accept(AC_GAME_ID).catch(() => {});
    else dialog.accept().catch(() => {});
  });
}

async function waitForFrame(page, urlSubstring, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const frame = page.frames().find((f) => f.url().includes(urlSubstring));
    if (frame) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error(`Frame "${urlSubstring}" not found within ${timeout}ms`);
}

async function waitForAppFrame(page, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const f of page.frames()) {
      try {
        const isOurs = await f.evaluate(() =>
          document.body && document.body.classList && document.body.classList.contains('airconsole'));
        if (isOurs) return f;
      } catch (_) { /* cross-origin or detached frame */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`App frame (body.airconsole) not found within ${timeout}ms`);
}

// The pairing code, scraped from the simulator's own frame. Its grouping is
// unstable across simulator versions ("1393", "132 084", "131 32"), so accept
// any whitespace pattern and guard on the post-strip length.
async function getPairingCode(screenPage) {
  const acFrame = await waitForFrame(screenPage, 'frontend', 15000);
  const CODE_RE = /\b\d[\d\s]{2,18}\d\b/;
  await acFrame.waitForFunction((reSrc) => {
    const m = document.body.innerText.match(new RegExp(reSrc));
    if (!m) return false;
    const code = m[0].replace(/\s/g, '');
    return code.length >= 4 && code.length <= 10;
  }, CODE_RE.source, { timeout: 30000 });
  return acFrame.evaluate((reSrc) => {
    const m = document.body.innerText.match(new RegExp(reSrc));
    return m ? m[0].replace(/\s/g, '') : null;
  }, CODE_RE.source);
}

test.describe('AC live (real SDK over the HTTP simulator)', () => {
  test.skip(!USE_LIVE, 'opt-in: AC_LIVE=1 npx playwright test tests/e2e/airconsole.spec.js');
  test.setTimeout(300000);

  test('LIVE: screen boots to the lobby, a controller joins, a race starts', async ({ baseURL }) => {
    const browser = await firefox.launch({ headless: false });
    try {
      const screenCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const screenPage = await screenCtx.newPage();
      autoAnswerAcGameId(screenPage);
      await screenPage.goto(`http://http.airconsole.com/?http=1&#${baseURL}/`, { waitUntil: 'domcontentloaded' });
      const code = await getPairingCode(screenPage);
      expect(code).toBeTruthy();

      // Landscape controller viewport — ours is landscape-only, and the CSS
      // rotate overlay keys on the orientation media query.
      const ctrlCtx = await browser.newContext({ viewport: { width: 844, height: 390 } });
      const ctrlPage = await ctrlCtx.newPage();
      autoAnswerAcGameId(ctrlPage);
      await ctrlPage.goto(`http://http.airconsole.com/?http=1&role=controller#!code=${code}`);
      await ctrlPage.waitForTimeout(5000);
      const acCtrl = await waitForFrame(ctrlPage, 'airconsole-controller', 15000);
      await acCtrl.locator('button', { hasText: /ja|yes/i }).first().click({ timeout: 15000 });

      const screenFrame = await waitForAppFrame(screenPage, 60000);
      const ctrlFrame = await waitForAppFrame(ctrlPage, 60000);

      // The REAL SDK drove the adapter to a ready room: the C++ machine over
      // the AC transport, no welcome board, the lobby up.
      await screenFrame.waitForFunction(() => {
        const n = window.__net;
        return !!(n && n.party && n.roomCode);
      }, null, { timeout: 60000 });
      expect(await screenFrame.evaluate(() => window.__net.party.constructor.name)).toBe('TTPAirConsoleAdapter');
      expect(await screenFrame.evaluate(() =>
        getComputedStyle(document.getElementById('welcome')).display)).toBe('none');
      expect(await screenFrame.evaluate(() =>
        getComputedStyle(document.getElementById('lobby')).display)).not.toBe('none');

      // The controller reached the lobby under its AC identity (no name form);
      // first-run auto-shows Settings — dismiss it like a player would.
      await ctrlFrame.waitForFunction(() =>
        document.getElementById('lobby') && !document.getElementById('lobby').classList.contains('hidden'),
        null, { timeout: 60000 });
      const done = ctrlFrame.locator('#settings-done');
      if (await done.isVisible().catch(() => false)) await done.click();

      // The seat landed on the big screen (whatever the sim named the device).
      await screenFrame.waitForFunction(() =>
        window.__net.flow.size >= 1, null, { timeout: 30000 });

      // Host starts the race; the display flips to the race and reaches racing.
      // The host bar is a stepper (Select race → Start race), same as helpers'
      // startRace, which can't be used here — these are frame locators.
      const hostBtn = ctrlFrame.locator('#ready-btn');
      if ((await hostBtn.textContent()) === 'Select race') await hostBtn.click();
      await hostBtn.click();
      await screenFrame.waitForFunction(() =>
        !document.getElementById('race').classList.contains('hidden'), null, { timeout: 30000 });
      await screenFrame.waitForFunction(() =>
        window.__session() && window.__session().racing, null, { timeout: 60000 });
    } finally {
      await browser.close();
    }
  });
});
