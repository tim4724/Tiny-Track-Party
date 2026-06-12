// @ts-check
// Reconnect flows: a reloaded phone reclaims its seat mid-race (same clientId
// → same relay slot → WELCOME with inRace), and a reloaded display rejoins its
// OWN room (sessionStorage) and regathers the party instead of orphaning it.
const { test, expect, openDisplay, joinController, startRace, visible } = require('./helpers');

test('a reloaded phone rejoins straight into its still-running race', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const alice = await joinController(browser, roomCode, 'Alice'); // host
  const bob = await joinController(browser, roomCode, 'Bob');
  await startRace(alice, [bob]);
  await page.waitForFunction(() => window.__session() && window.__session().racing, null, { timeout: 20000 });

  // Bob's phone dies mid-corner. His car keeps running on the display.
  await bob.reload();
  await bob.fill('#name-input', 'Bob');
  await bob.click('#join-btn');
  // Stored clientId reclaims the same seat; WELCOME(inRace) drops him straight
  // back onto the drive screen — not the lobby, not a dead wheel.
  await bob.waitForSelector(visible('#game'), { timeout: 15000 });
});

test('a display reload rejoins its own room and regathers the party', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const alice = await joinController(browser, roomCode, 'Alice');
  await expect(page.locator('#players')).toContainText('Alice');

  await page.reload();
  await page.waitForFunction(() => window.__net && window.__net.roomCode, null, { timeout: 20000 });

  // Same room — the QR/link everyone scanned stays valid.
  expect(await page.evaluate(() => window.__net.roomCode)).toBe(roomCode);
  // The phone re-introduces itself (re-HELLO on peer_joined 0), restoring its
  // name on the display's fresh roster, and lands back in the lobby.
  await expect(page.locator('#players')).toContainText('Alice', { timeout: 15000 });
  await alice.waitForSelector(visible('#lobby'));
});
