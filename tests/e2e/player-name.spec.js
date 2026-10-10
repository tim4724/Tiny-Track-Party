// @ts-check
// The player's name on the phone. A browser player names themselves on the name
// screen and renames by going back to it (the X): in the room the stickers are
// plain labels. Inside the CouchPad launcher a sticker opens the launcher's own
// name sheet instead — couchpad-shell.spec.js covers that half.
const { test, expect, openDisplay, joinController, startRace, waitForRacing, visible } = require('./helpers');

test('in a browser the name stickers are labels, not a way to rename', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const zoe = await joinController(browser, roomCode, 'Zoe');
  await zoe.waitForSelector(visible('#lobby'));
  await expect(zoe.locator('#me-name')).toHaveText('Zoe');
  await expect(zoe.locator('#me-name')).toBeDisabled();

  await startRace(zoe, []);
  await waitForRacing(page);
  await zoe.waitForSelector(visible('#drive-hud'));
  await expect(zoe.locator('#hud-name')).toHaveText('Zoe');
  await expect(zoe.locator('#hud-name')).toBeDisabled();
  // Nothing in the page offers a field to type into.
  await expect(zoe.locator('input:visible')).toHaveCount(0);
});

test('joining shows the entered name from the first frame, never the placeholder', async ({ page, browser }) => {
  // The display seats a new phone as "Player N" until its HELLO lands, and the
  // first snapshot carries that. The phone holds its own name and must not
  // adopt it: every text the sticker ever shows is recorded from page load.
  const roomCode = await openDisplay(page);
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  await context.addInitScript(() => {
    try { localStorage.setItem('tinytrack_seen_help', '1'); } catch (_) {}
    window.__names = [];
    addEventListener('DOMContentLoaded', () => {
      const n = document.getElementById('me-name');
      new MutationObserver(() => window.__names.push(n.textContent))
        .observe(n, { childList: true, characterData: true, subtree: true });
    });
  });
  const zoe = await context.newPage();
  await zoe.goto(`/${roomCode}`);
  await zoe.fill('#name-input', 'Zoe');
  await zoe.click('#join-btn');
  await zoe.waitForSelector(visible('#lobby'));
  await expect(page.locator('#players')).toContainText('Zoe');
  const names = await zoe.evaluate(() => window.__names);
  expect(names.length).toBeGreaterThan(0);
  expect(new Set(names)).toEqual(new Set(['Zoe']));
});
