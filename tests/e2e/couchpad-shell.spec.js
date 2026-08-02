// @ts-check
// CouchPad launcher contract (CONTRACT.md): the controller, when hosted in the
// launcher's web view (Android WebView / iOS WKWebView — identical here), is
// handed its identity via ?cpName=… and talks back over
// window.CouchPad.setName (§2) / window.CouchPadHost.gameEnded (§3). These specs
// drive a shell-mode phone against the same display + hermetic relay stub the rest
// of the suite uses, asserting the shell touchpoints end to end.
const { test, expect, openDisplay, startRace, waitForRacing, visible } = require('./helpers');

// A phone launched by the shell: a fresh context (own localStorage) with the
// launcher's JS interface stubbed in BEFORE any page script runs, joined via the
// cpName URL param — its presence is the whole shell gate, so there is no name
// form. `__cpEnded` records the last gameEnded reason the game reported. Returns
// the controller page.
async function shellJoin(browser, roomCode, name, { room = roomCode } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    try { localStorage.setItem('tinytrack_seen_help', '1'); } catch (_) {}
    window.__cpEnded = null;
    // Mirrors the launcher's addJavascriptInterface host (§3).
    window.CouchPadHost = { gameEnded: (reason) => { window.__cpEnded = reason; } };
  });
  const page = await context.newPage();
  await page.goto(`/${room}?cpName=${encodeURIComponent(name)}`);
  return page;
}

test('the display names itself `cpp=web` on the join URL and the registered template (§6)', async ({ page }) => {
  await openDisplay(page);

  // The URL is the ONLY place a display declares which box it is, so the value
  // has to ride the string every arrival route reads: the scanned QR here, and
  // the template below for a typed code, a nearby tap or a rejoin card.
  const joinUrl = await page.evaluate(() => window.__net._joinUrl());
  expect(joinUrl).toContain('?cpp=web');
  // Before the fragment: the instance pins the relay shard and a query arg after
  // '#' is fragment text, not a param.
  expect(joinUrl.indexOf('?cpp=web')).toBeLessThan((joinUrl + '#').indexOf('#'));

  // The template must match what the QR produces, placeholders intact for the
  // relay to substitute. E2E serves plain http, where the relay would reject the
  // whole create, so the display registers none — override the base to reach the
  // shape prod actually sends.
  const template = await page.evaluate(() => {
    window.__net.baseUrlOverride = 'https://tinytrack.couchpad.games';
    return window.__net._controllerUrlTemplate();
  });
  expect(template).toBe('https://tinytrack.couchpad.games/{room}?cpp=web#{instance}');

  // The ticket the player reads is untouched: host + path only, no query noise.
  await expect(page.locator('#joinurl')).not.toContainText('cpp');
});

test('a `cp*` param the launcher did not send is not mistaken for the shell', async ({ page, browser }) => {
  // Every scanned QR now carries ?cpp=web — the display naming itself to the
  // launcher, addressed past us. `cp*` is the launcher's reserved namespace, and
  // the shell gate is cpName ALONE: read the prefix instead and every plain-browser
  // player loses the name screen and gets seated as an empty name.
  const roomCode = await openDisplay(page);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    try { localStorage.setItem('tinytrack_seen_help', '1'); } catch (_) {}
  });
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}?cpp=web`);

  await phone.waitForSelector(visible('#name'));
  expect(await phone.evaluate(() => document.documentElement.classList.contains('cp-shell'))).toBe(false);
});

test('shell join skips the name screen, seats the injected name, never persists it', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await shellJoin(browser, roomCode, 'Zoe');
  // Straight to the lobby — the name form was never shown or filled.
  await zoe.waitForSelector(visible('#lobby'));
  await expect(zoe.locator('#name')).toHaveClass(/hidden/);
  // The name still seats the display roster and feeds our labels…
  await expect(zoe.locator('#me-name')).toHaveText('Zoe');
  await expect(page.locator('#players')).toContainText('Zoe');
  // …but in the shell those labels are hidden: the launcher's native top-bar chip
  // already shows the name, so the in-game copies would be a redundant duplicate.
  await expect(zoe.locator('#me-name')).toBeHidden();
  await expect(zoe.locator('.cp-shell')).toHaveCount(1);

  // §1: the injected identity must not leak into the game's own name storage.
  expect(await zoe.evaluate(() => localStorage.getItem('tinytrack_name'))).toBeNull();

  // §1: the shell owns leaving — our own back handling is neutralized (nothing
  // pushed onto history) so the launcher's back gesture / LEAVE bar is unopposed.
  expect(await zoe.evaluate(() => history.state)).toBeNull();
});

test('launcher setName renames the player live on the phone and the display', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await shellJoin(browser, roomCode, 'Zoe');
  await zoe.waitForSelector(visible('#lobby'));
  await expect(page.locator('#players')).toContainText('Zoe');

  // §2: the launcher calls this when the player edits their name in the in-game bar.
  await zoe.evaluate(() => window.CouchPad.setName('Zephyr'));

  await expect(zoe.locator('#me-name')).toHaveText('Zephyr');
  await expect(page.locator('#players')).toContainText('Zephyr');
  await expect(page.locator('#players')).not.toContainText('Zoe');
  // Still not persisted — a live rename is launcher identity, same as the join name.
  expect(await zoe.evaluate(() => localStorage.getItem('tinytrack_name'))).toBeNull();
});

test('a setName MID-RACE moves the display cell chip, not just the lobby seat', async ({ page, browser }) => {
  // The lobby case above is the easy half: its seat grid is re-read off the room
  // handle on every announce, so it cannot go stale. A RACE is where a name gets
  // COPIED — the cell chip is written once when the car is added — and the launcher
  // can be used to rename at any moment, not only before the flag.
  const roomCode = await openDisplay(page);
  const zoe = await shellJoin(browser, roomCode, 'Zoe');
  await zoe.waitForSelector(visible('#lobby'));

  await startRace(zoe, []);
  await waitForRacing(page);
  const chip = page.locator('.cell-label__name');   // one human, so one cell
  await expect(chip).toHaveText('Zoe');

  await zoe.evaluate(() => window.CouchPad.setName('Zephyr'));
  await expect(chip).toHaveText('Zephyr');
  // The car's REAR NAME PLATE is not asserted and does not follow: it is baked
  // into the scene's geometry at build time, so it keeps the name the car
  // launched under until the next build (Stage.setCarName says why).
});

test('a rejected join reports gameEnded(room_not_found) to the launcher', async ({ page, browser }) => {
  await openDisplay(page);   // a real room exists, but we point the phone at a different code

  const lost = await shellJoin(browser, 'no-such-room', 'Ann', { room: 'no-such-room' });
  // §3: the relay rejects the join ('Room not found') → the game reports the
  // terminal reason and does NOT navigate itself (the launcher tears the WebView
  // down). It never reaches the lobby.
  await lost.waitForFunction(() => window.__cpEnded !== null, null, { timeout: 15000 });
  expect(await lost.evaluate(() => window.__cpEnded)).toBe('room_not_found');
  await expect(lost.locator('#lobby')).toHaveClass(/hidden/);
});

test('theming metas ship and the accent retints to the player livery (§4); safe-zone vars are honored (§5)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await shellJoin(browser, roomCode, 'Zoe');
  await zoe.waitForSelector(visible('#lobby'));

  // §4: both hint metas are present. theme-color is the static warm paper…
  expect(await zoe.evaluate(() => {
    const m = document.querySelector('meta[name="theme-color"]');
    return m && m.getAttribute('content');
  })).toBe('#FFF6EB');
  // …and cp-accent-color has been retinted live to this player's livery colour
  // (first seat → red #e6492d), no longer the static default.
  await expect.poll(() => zoe.evaluate(() => {
    const m = document.querySelector('meta[name="cp-accent-color"]');
    return (m && m.getAttribute('content') || '').toLowerCase();
  })).toBe('#e6492d');

  // §5: the authoritative --cp-safe-* vars feed the page's edge padding via
  // max(var, env). Injecting a top inset must push the lobby's content down.
  const padTop = await zoe.evaluate(() => {
    document.documentElement.style.setProperty('--cp-safe-top', '48px');
    return parseFloat(getComputedStyle(document.getElementById('lobby')).paddingTop);
  });
  expect(padTop).toBeGreaterThanOrEqual(48);
});

test('backgrounding the app drops the seat at once; returning takes it back (§7)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await shellJoin(browser, roomCode, 'Zoe');
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
