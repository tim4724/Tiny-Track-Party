// @ts-check
// Couch Games launcher contract (CONTRACT.md): the controller, when hosted in the
// launcher WebView, is handed its identity via ?cgv=1&cgName=… and talks back over
// window.CouchGames.setName (§2) / window.CouchGamesHost.gameEnded (§3). These specs
// drive a shell-mode phone against the same display + hermetic relay stub the rest
// of the suite uses, asserting the shell touchpoints end to end.
const { test, expect, openDisplay, visible } = require('./helpers');

// A phone launched by the shell: a fresh context (own localStorage) with the
// launcher's JS interface stubbed in BEFORE any page script runs, joined via the
// cgv/cgName URL params (no name form). `__cgEnded` records the last gameEnded
// reason the game reported. Returns the controller page.
async function shellJoin(browser, roomCode, name, { room = roomCode } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    try { localStorage.setItem('tinytrack_seen_help', '1'); } catch (_) {}
    window.__cgEnded = null;
    // Mirrors the launcher's addJavascriptInterface host (§3).
    window.CouchGamesHost = { gameEnded: (reason) => { window.__cgEnded = reason; } };
  });
  const page = await context.newPage();
  await page.goto(`/${room}?cgv=1&cgName=${encodeURIComponent(name)}`);
  return page;
}

test('shell join skips the name screen, seats the injected name, never persists it', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await shellJoin(browser, roomCode, 'Zoe');
  // Straight to the lobby — the name form was never shown or filled.
  await zoe.waitForSelector(visible('#lobby'));
  await expect(zoe.locator('#name')).toHaveClass(/hidden/);
  await expect(zoe.locator('#me-name')).toHaveText('Zoe');
  await expect(page.locator('#players')).toContainText('Zoe');

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
  await zoe.evaluate(() => window.CouchGames.setName('Zephyr'));

  await expect(zoe.locator('#me-name')).toHaveText('Zephyr');
  await expect(page.locator('#players')).toContainText('Zephyr');
  await expect(page.locator('#players')).not.toContainText('Zoe');
  // Still not persisted — a live rename is launcher identity, same as the join name.
  expect(await zoe.evaluate(() => localStorage.getItem('tinytrack_name'))).toBeNull();
});

test('a rejected join reports gameEnded(room_not_found) to the launcher', async ({ page, browser }) => {
  await openDisplay(page);   // a real room exists, but we point the phone at a different code

  const lost = await shellJoin(browser, 'no-such-room', 'Ann', { room: 'no-such-room' });
  // §3: the relay rejects the join ('Room not found') → the game reports the
  // terminal reason and does NOT navigate itself (the launcher tears the WebView
  // down). It never reaches the lobby.
  await lost.waitForFunction(() => window.__cgEnded !== null, null, { timeout: 15000 });
  expect(await lost.evaluate(() => window.__cgEnded)).toBe('room_not_found');
  await expect(lost.locator('#lobby')).toHaveClass(/hidden/);
});

test('theming metas ship and the accent retints to the player livery (§4); safe-zone vars are honored (§5)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const zoe = await shellJoin(browser, roomCode, 'Zoe');
  await zoe.waitForSelector(visible('#lobby'));

  // §4: both hint metas are present. theme-color is the static sunny-sky top…
  expect(await zoe.evaluate(() => {
    const m = document.querySelector('meta[name="theme-color"]');
    return m && m.getAttribute('content');
  })).toBe('#a8e2ff');
  // …and cg-accent-color has been retinted live to this player's livery colour
  // (first seat → red #e6492d), no longer the static default.
  await expect.poll(() => zoe.evaluate(() => {
    const m = document.querySelector('meta[name="cg-accent-color"]');
    return (m && m.getAttribute('content') || '').toLowerCase();
  })).toBe('#e6492d');

  // §5: the authoritative --cg-safe-* vars feed the page's edge padding via
  // max(var, env). Injecting a top inset must push the lobby's content down.
  const padTop = await zoe.evaluate(() => {
    document.documentElement.style.setProperty('--cg-safe-top', '48px');
    return parseFloat(getComputedStyle(document.getElementById('lobby')).paddingTop);
  });
  expect(padTop).toBeGreaterThanOrEqual(48);
});
