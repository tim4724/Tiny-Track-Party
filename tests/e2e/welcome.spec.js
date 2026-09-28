// @ts-check
// Welcome board + back-stack navigation. Boot lands on the title board while
// the room warms invisibly behind it (net.start() runs at boot); NEW GAME
// reveals the lobby (and carries the fullscreen/audio unlock gesture). The
// browser back button walks the SCREEN_ORDER stack, except where the model says
// it does not navigate at all: a LIVE race freezes behind the pause overlay
// (and thaws on the next press) rather than being thrown away by one gesture,
// a FINISHED one retreats to the lobby, and lobby → welcome is endParty (every
// phone bails terminally, the display self-heals into a FRESH room with a CLEAN
// roster for the next party).
const { test, expect, openDisplay, joinController, startRace, waitForRacing, visible } = require('./helpers');

test('boot shows the welcome board with the room pre-warmed; NEW GAME reveals the lobby', async ({ page }) => {
  await page.goto('/');

  await page.waitForSelector(visible('#welcome'));
  await expect(page.locator('#lobby')).toBeHidden();

  // The room is created eagerly BEHIND the welcome board (HexStacker pattern):
  // by the time NEW GAME is pressed the lobby's QR is already live.
  await page.waitForFunction(() => window.__net && window.__net.roomCode, null, { timeout: 20000 });
  const roomCode = await page.evaluate(() => window.__net.roomCode);

  await page.click('#newgame-btn');
  await page.waitForSelector(visible('#lobby'));
  await expect(page.locator('#welcome')).toBeHidden();
  // Same room — the click revealed the pre-warmed lobby, it didn't create anything.
  expect(await page.evaluate(() => window.__net.roomCode)).toBe(roomCode);
  await expect(page.locator('#joinurl')).toContainText(roomCode);

  // The lobby attracts from its first frame: the 3D preview (the remembered
  // last pick, or the first track on a fresh display) reveals BEFORE any phone
  // joins. No pick exists yet — it's a preview, and Start stays gated.
  expect(await page.evaluate(() => window.__net.mode)).toBe(null);
  await page.waitForFunction(
    () => !document.getElementById('scene').classList.contains('is-dim'),
    null, { timeout: 20000 }
  );
});

test('back from the lobby ends the party: phones bail, a fresh room with a clean roster warms', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await expect(page.locator('#players')).toContainText('Alice');

  await page.goBack();

  await page.waitForSelector(visible('#welcome'));
  await expect(page.locator('#lobby')).toBeHidden();
  // The phone got the terminal room-closed overlay (no retry — the room is gone).
  await alice.waitForSelector(visible('#conn'), { timeout: 15000 });
  await expect(alice.locator('#conn-title')).toHaveText('Race over');
  // A fresh room self-heals behind the welcome board, with Alice's seat cleared.
  await page.waitForFunction(
    (old) => window.__net.roomCode && window.__net.roomCode !== old,
    roomCode, { timeout: 15000 }
  );
  expect(await page.evaluate(() => window.__net.flow.list().length)).toBe(0);

  // NEW GAME again: the next party is one click away and joinable.
  await page.click('#newgame-btn');
  await page.waitForSelector(visible('#lobby'));
  await expect(page.locator('#players')).not.toContainText('Alice');
  const newCode = await page.evaluate(() => window.__net.roomCode);
  const bob = await joinController(browser, newCode, 'Bob');
  await expect(page.locator('#players')).toContainText('Bob');
  await bob.waitForSelector(visible('#lobby'));
});

test('back from a live race FREEZES it; the overlay is the only way out, and the stack survives', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await startRace(alice, []);
  await waitForRacing(page);

  // BACK DOES NOT NAVIGATE HERE. A race is minutes of play and back is one
  // press: it raises the pause overlay (on the phones too — the same freeze any
  // pause takes) and the race is still there behind it.
  await page.goBack();

  await page.waitForSelector(visible('#pause-overlay'));
  await alice.waitForSelector(visible('#pause-overlay'));
  await expect(page.locator('#race')).toBeVisible();
  await expect(page.locator('#lobby')).toBeHidden();

  // And back again thaws it, so no press on this board is a dead one.
  await page.goBack();
  await expect(page.locator('#pause-overlay')).toBeHidden();
  await expect(alice.locator('#pause-overlay')).toBeHidden();
  await expect(page.locator('#race')).toBeVisible();

  // THE ENTRY IS PUT BACK BOTH TIMES. Freezing is not navigating, so the stack
  // has to still sit at the race level — if it did not, this next back would
  // leave the party from a running race instead of pausing it again.
  await page.goBack();
  await page.waitForSelector(visible('#pause-overlay'));

  // Leaving is the overlay's own "New game": the full race teardown, display
  // back on the lobby, phone back in ITS lobby (GAME_END), seats intact — it
  // quits the race, not the party.
  await page.click('#pause-newgame');
  await page.waitForSelector(visible('#lobby'));
  await expect(page.locator('#welcome')).toBeHidden();
  await alice.waitForSelector(visible('#lobby'));
  await expect(page.locator('#players')).toContainText('Alice');

  // One more back now leaves the party from the lobby level.
  await page.goBack();
  await page.waitForSelector(visible('#welcome'));
  await alice.waitForSelector(visible('#conn'), { timeout: 15000 });

  // Ending the party also resets the PICK (mode/track null again): the title
  // board sits on the 2D diorama. The 3D preview itself deliberately survives
  // for the next lobby's attract race — only the welcome screen dims it.
  expect(await page.evaluate(() => ({
    mode: window.__net.mode, track: window.__net.trackId,
    dioramaShowing: document.getElementById('scene').classList.contains('is-dim')
  }))).toEqual({ mode: null, track: null, dioramaShowing: true });
});
