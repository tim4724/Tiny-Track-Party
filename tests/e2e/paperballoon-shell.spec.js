// @ts-check
// Paper Balloon launcher contract (CONTRACT.md): the controller, when hosted in the
// launcher's web view (Android WebView / iOS WKWebView — identical here), is
// told it is there by window.PaperBalloonHost, reads the player's name off it (§1),
// renames through the launcher's own sheet (§2), and leaves through it (§3).
// The close button is ours. These specs drive a shell-mode phone against the
// same display + hermetic relay stub the rest of the suite uses, asserting the
// shell touchpoints end to end.
const { test, expect, openDisplay, startRace, waitForRacing, visible } = require('./helpers');

// A phone launched by the shell: a fresh context (own localStorage) with the
// launcher's bridge stubbed in BEFORE any page script runs, the way its
// document-start shim installs it. The stub records every call: `__cpEnded` the
// last gameEnded reason, `__cpLeft` whether leave() ran, `__cpEdits` how many
// times editName() opened the sheet; the sheet resolves to `__cpNextName` (null
// = dismissed). `leave: false` models a launcher without §3's leave();
// `nameProp: false` the old-WebView fallback, which has neither `name` nor
// editName(). Returns the controller page.
async function openShell(browser, room, name, { leave = true, nameProp = true } = {}) {
  // Landscape: the launcher pins the device to landscape (§10) and the page is
  // landscape-only, so the shell context matches what the WebView really shows.
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  await context.addInitScript(({ name, leave, nameProp }) => {
    try { localStorage.setItem('tinytrack_seen_help', '1'); } catch (_) {}
    window.__cpEnded = null;
    window.__cpLeft = false;
    window.__cpEdits = 0;
    window.__cpNextName = null;
    window.__cpOrient = [];      // §10 setOrientation calls, in order
    window.__cpBackCalls = [];   // §9 setBackMode transitions, in order
    let current = name;
    const host = {
      gameEnded: (reason) => { window.__cpEnded = reason; },
      setOrientation: (mode) => { window.__cpOrient.push(mode); },
      setBackMode: (mode) => { window.__cpBackCalls.push(mode); }
    };
    if (nameProp) {
      Object.defineProperty(host, 'name', { get: () => current, enumerable: true });
      host.editName = () => {
        window.__cpEdits++;
        const n = window.__cpNextName;
        if (n) current = n;
        return Promise.resolve(n);
      };
    }
    if (leave) host.leave = () => { window.__cpLeft = true; };
    window.PaperBalloonHost = host;
  }, { name, leave, nameProp });
  const page = await context.newPage();
  await page.goto(`/${room}`);
  return page;
}

test('the display names itself `pbp=web` on the join URL and the registered template (§6)', async ({ page }) => {
  await openDisplay(page);

  // The URL is the ONLY place a display declares which box it is, so the value
  // has to ride the string every arrival route reads: the scanned QR here, and
  // the template below for a typed code, a nearby tap or a rejoin card.
  const joinUrl = await page.evaluate(() => window.__net._joinUrl());
  expect(joinUrl).toContain('?pbp=web');
  // Before the fragment: the instance pins the relay shard and a query arg after
  // '#' is fragment text, not a param.
  expect(joinUrl.indexOf('?pbp=web')).toBeLessThan((joinUrl + '#').indexOf('#'));

  // The template must match what the QR produces, placeholders intact for the
  // relay to substitute. E2E serves plain http, where the relay would reject the
  // whole create, so the display registers none — override the base to reach the
  // shape prod actually sends.
  const template = await page.evaluate(() => {
    window.__net.baseUrlOverride = 'https://tinytrack.paperballoon.games';
    return window.__net._controllerUrlTemplate();
  });
  expect(template).toBe('https://tinytrack.paperballoon.games/{room}?pbp=web#{instance}');

  // The ticket the player reads is untouched: host + path only, no query noise.
  await expect(page.locator('#joinurl')).not.toContainText('pbp');
});

test('a `pb*` param without the launcher bridge is a plain browser', async ({ page, browser }) => {
  // Every scanned QR carries ?pbp=web — the display naming itself to the
  // launcher, addressed past us. `pb*` is the launcher's reserved namespace and
  // none of it is the gate: only window.PaperBalloonHost is. A param read as the gate
  // would skip this phone's name screen and take its browser exit away.
  const roomCode = await openDisplay(page);

  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  await context.addInitScript(() => {
    try { localStorage.setItem('tinytrack_seen_help', '1'); } catch (_) {}
  });
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}?pbp=web`);

  await phone.waitForSelector(visible('#name'));
  // No room to leave yet, and not fullscreen.
  await expect(phone.locator('#close-btn')).toBeHidden();
  await phone.fill('#name-input', 'Ann');
  await phone.click('#join-btn');
  await phone.waitForSelector(visible('#lobby'));
  // A browser joins with a history entry for its back gesture to pop.
  expect(await phone.evaluate(() => history.state)).not.toBeNull();
});

test('the shell joins under PaperBalloonHost.name with no name screen (§1)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await openShell(browser, roomCode, 'Zoe');
  // Straight to the lobby — the name form was never shown or filled.
  await zoe.waitForSelector(visible('#lobby'));
  await expect(zoe.locator('#name')).toHaveClass(/hidden/);
  await expect(zoe.locator('#me-name')).toHaveText('Zoe');
  await expect(page.locator('#players')).toContainText('Zoe');
  // The launcher owns the name: it does not become this device's default.
  expect(await zoe.evaluate(() => localStorage.getItem('tinytrack_name'))).toBeNull();
  // The launcher owns back (§9) and the close button leaves through it (§3):
  // nothing is pushed onto history for a back gesture of ours to pop.
  expect(await zoe.evaluate(() => history.state)).toBeNull();
});

test('a rename opens the launcher sheet, lobby and race alike (§2)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const zoe = await openShell(browser, roomCode, 'Zoe');
  await zoe.waitForSelector(visible('#lobby'));
  await expect(page.locator('#players')).toContainText('Zoe');

  // Dismissed: the Promise resolves null and nothing changes.
  await zoe.click('#me-name');
  await expect.poll(() => zoe.evaluate(() => window.__cpEdits)).toBe(1);
  await expect(zoe.locator('#me-name')).toHaveText('Zoe');

  // Saved: the resolved name renames the seat on the phone and the display.
  await zoe.evaluate(() => { window.__cpNextName = 'Zephyr'; });
  await zoe.click('#me-name');
  await expect(zoe.locator('#me-name')).toHaveText('Zephyr');
  await expect(page.locator('#players')).toContainText('Zephyr');
  await expect(page.locator('#players')).not.toContainText('Zoe');
  expect(await zoe.evaluate(() => window.__cpEdits)).toBe(2);

  // Racing: the race's sticker opens the same launcher sheet.
  await startRace(zoe, []);
  await waitForRacing(page);
  await zoe.waitForSelector(visible('#drive-hud'));
  await zoe.evaluate(() => { window.__cpNextName = 'Zed'; });
  await zoe.click('#hud-name');
  await expect(zoe.locator('#hud-name')).toHaveText('Zed');
  await expect(page.locator('.cell-label__name')).toHaveText('Zed');
  expect(await zoe.evaluate(() => window.__cpEdits)).toBe(3);
});

test('a launcher without PaperBalloonHost.name gets our name screen and no rename', async ({ page, browser }) => {
  // An Android WebView too old for document-start scripts: the launcher can
  // define neither `name` nor editName(), so the page behaves as a browser.
  const roomCode = await openDisplay(page);
  const ann = await openShell(browser, roomCode, 'Ann', { nameProp: false });
  await ann.waitForSelector(visible('#name'));
  await expect(ann.locator('#close-btn')).toBeVisible();   // leave() still works there
  await ann.fill('#name-input', 'Ann');
  await ann.click('#join-btn');
  await ann.waitForSelector(visible('#lobby'));

  await expect(ann.locator('#me-name')).toBeDisabled();
});

test('the way out leaves through the launcher, racing included (§3)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const zoe = await openShell(browser, roomCode, 'Zoe');
  await zoe.waitForSelector(visible('#lobby'));
  // The lobby's X is the last key of the settings pill, top-RIGHT.
  await expect(zoe.locator('#lobby-close')).toBeVisible();
  await expect(zoe.locator('#close-btn')).toBeHidden();
  const x = await zoe.locator('#lobby-close').boundingBox();
  const gear = await zoe.locator('#settings-btn').boundingBox();
  const vw = zoe.viewportSize()?.width ?? 0;
  expect(vw - ((x?.x ?? 0) + (x?.width ?? 0))).toBeLessThan(40);
  expect(Math.abs((x?.x ?? 0) - ((gear?.x ?? 0) + (gear?.width ?? 0)))).toBeLessThan(2);

  // Racing: the pause button holds the X's slot, and the way out is the
  // pause menu's Leave game, so one stray tap cannot quit a race.
  await startRace(zoe, []);
  await waitForRacing(page);
  await zoe.waitForSelector(visible('#drive-hud'));
  await expect(zoe.locator('#close-btn')).toBeHidden();
  const pause = await zoe.locator('#pause-btn').boundingBox();
  expect(Math.abs(((pause?.x ?? 0) + (pause?.width ?? 0)) - ((x?.x ?? 0) + (x?.width ?? 0)))).toBeLessThan(6);

  // The tap hands over and does not navigate: the launcher closes the web view.
  const url = zoe.url();
  await zoe.click('#pause-btn');
  await zoe.click('#pause-leave');
  expect(await zoe.evaluate(() => window.__cpLeft)).toBe(true);
  expect(zoe.url()).toBe(url);
});

test('a launcher without leave() gets no close button', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const zoe = await openShell(browser, roomCode, 'Zoe', { leave: false });
  await zoe.waitForSelector(visible('#lobby'));
  await expect(zoe.locator('#lobby-close')).toBeHidden();
});

test('a rejected join reports gameEnded(room_not_found) to the launcher', async ({ page, browser }) => {
  await openDisplay(page);   // a real room exists, but we point the phone at a different code

  const lost = await openShell(browser, 'no-such-room', 'Ann');
  // §3: the relay rejects the join ('Room not found') → the game reports the
  // terminal reason and does NOT navigate itself (the launcher tears the WebView
  // down). It never reaches the lobby.
  await lost.waitForFunction(() => window.__cpEnded !== null, null, { timeout: 15000 });
  expect(await lost.evaluate(() => window.__cpEnded)).toBe('room_not_found');
  await expect(lost.locator('#lobby')).toHaveClass(/hidden/);
});

test('the page dresses the launcher sheet (§2, §4) and keeps inside the safe area (§5)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await openShell(browser, roomCode, 'Zoe');
  await zoe.waitForSelector(visible('#lobby'));

  // §4 + §2: the scheme drives the status-bar icons and the name sheet's text,
  // theme-color its surface, and :root's accent-color its Save button — the
  // player's livery (first seat → red #e6492d), read when editName() is called.
  const look = await zoe.evaluate(() => {
    const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content');
    return { scheme: meta('color-scheme'), surface: meta('theme-color') };
  });
  expect(look.scheme).toBe('light');
  expect(look.surface).toBe('#F3F5FA');
  await expect.poll(() => zoe.evaluate(() => getComputedStyle(document.documentElement).accentColor))
    .toBe('rgb(230, 73, 45)');

  // §5: env(safe-area-inset-*) is the whole source. CDP sets the insets the
  // platform would report.
  const cdp = await zoe.context().newCDPSession(zoe);
  const insets = (i) => cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0, ...i } });
  const pads = () => zoe.evaluate(() => {
    const s = getComputedStyle(document.getElementById('lobby'));
    return { top: parseFloat(s.paddingTop), left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight) };
  });
  await insets({ top: 48 });
  expect((await pads()).top).toBeGreaterThanOrEqual(48);

  // Each side's ACTUAL inset arrives. A one-sided cutout is levelled onto both
  // sides on a regular phone, and taken as-is on a small one.
  await insets({ left: 48, right: 20 });
  const big = await pads();
  expect(big.left).toBeGreaterThanOrEqual(48);
  expect(big.right).toBe(big.left);
  await zoe.setViewportSize({ width: 667, height: 375 });
  const small = await pads();
  expect(small.left).toBeGreaterThanOrEqual(48);
  expect(small.right).toBeGreaterThanOrEqual(20);
  expect(small.right).toBeLessThan(small.left);
});

test('the shell asks for landscape before first paint (§10)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await openShell(browser, roomCode, 'Zoe');
  // The head script fires before any body script — by lobby time the request
  // must be there, exactly once, and be the literal 'landscape'.
  await zoe.waitForSelector(visible('#lobby'));
  expect(await zoe.evaluate(() => window.__cpOrient)).toEqual(['landscape']);
});

test('back leaves from the lobby, is off for the race, and closes an open dialog or pause (§9)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await openShell(browser, roomCode, 'Zoe');
  await zoe.waitForSelector(visible('#lobby'));
  // Lobby: back leaves through the launcher. Transitions only, no chatter.
  await expect.poll(() => zoe.evaluate(() => window.__cpBackCalls)).toEqual(['leave']);

  await startRace(zoe, []);
  await waitForRacing(page);
  // Racing: the screen edges belong to steering — off.
  await expect.poll(() => zoe.evaluate(() => window.__cpBackCalls)).toEqual(['leave', 'off']);

  // Opening the settings dialog mid-race hands back to the page; the back closes
  // it (consumed → true) and 'off' follows.
  await zoe.click('#settings-btn-game');
  await expect.poll(() => zoe.evaluate(() => window.__cpBackCalls)).toEqual(['leave', 'off', 'page']);
  expect(await zoe.evaluate(() => window.PaperBalloon.back())).toBe(true);
  await expect(zoe.locator('#settings-overlay')).toBeHidden();
  await expect.poll(() => zoe.evaluate(() => window.__cpBackCalls)).toEqual(['leave', 'off', 'page', 'off']);

  // With nothing open the hook consumes nothing: a stray call leaves.
  expect(await zoe.evaluate(() => window.PaperBalloon.back())).toBe(false);

  // A paused race is the page's too: the back continues it.
  await zoe.click('#pause-btn');
  await expect.poll(() => zoe.evaluate(() => window.__cpBackCalls)).toEqual(['leave', 'off', 'page', 'off', 'page']);
  expect(await zoe.evaluate(() => window.PaperBalloon.back())).toBe(true);
  await expect(zoe.locator('#pause-overlay')).toBeHidden();
  await expect.poll(() => zoe.evaluate(() => window.__cpBackCalls)).toEqual(['leave', 'off', 'page', 'off', 'page', 'off']);
});

test('backgrounding the app drops the seat at once; returning takes it back (§7)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await openShell(browser, roomCode, 'Zoe');
  await zoe.waitForSelector(visible('#lobby'));
  await expect(page.locator('#players')).toContainText('Zoe');

  // §7: exactly what the launcher synthesizes when the player hits home, switches
  // apps or locks the phone. Nothing navigates — the page is still here — so
  // everything below is our own handler's doing.
  await zoe.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });

  // The relay link is down on our side...
  expect(await zoe.evaluate(() => window.__net.party === null)).toBe(true);
  // ...so peer_left reaches the display NOW. Without this the socket outlives the
  // running page and keeps answering the relay, and the seat sits on the big
  // screen for as long as the app stays suspended — indefinitely on iOS.
  await expect(page.locator('#players')).not.toContainText('Zoe');

  // Coming back has no synthetic counterpart: the engine fires the standard
  // visibilitychange, and we redial there. Same clientId → same relay slot → the
  // HELLO restores the same seat, under the same name.
  await zoe.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#players')).toContainText('Zoe');
  await zoe.waitForSelector(visible('#lobby'));
});
