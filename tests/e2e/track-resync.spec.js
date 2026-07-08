// @ts-check
// Regression: the host's "Start race" button must keep working after the display
// comes back trackless in a room whose phones stayed connected. The display owns
// the live track state (selectedTrackId); the host phone owns the picker. A
// CRASHED display (no pagehide → no close_room → the room survives; a clean
// reload tears the party down instead, see close-room.spec.js) rejoins mid-lobby
// with no track, while the still-connected host keeps its pick — so the host's
// Start button is enabled (canStart = !!selectedTrackId) yet the display's
// startRace() silently bails on its own null track. The host must re-assert its
// pick so the display recovers and the race actually starts.
const { test, expect, openDisplay, joinController, startRace, waitForRacing, visible } = require('./helpers');

const hasTrack = () => window.__net && window.__net.trackId != null;

test('host can still start after the display crash-recovers (lobby track desync repair)', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const alice = await joinController(browser, roomCode, 'Alice'); // first in → host
  const bob = await joinController(browser, roomCode, 'Bob');
  await expect(page.locator('#players')).toContainText('Alice');
  await expect(page.locator('#players')).toContainText('Bob');

  // Host auto-picks a track; the display adopts it for the 3D preview.
  await page.waitForFunction(hasTrack, null, { timeout: 10000 });

  // The display "crashes": suppress the pagehide teardown (a real crash never
  // runs it), so the room survives and the reloaded page rejoins with fresh JS
  // state — no track — while both phones stay connected and keep their selection.
  await page.evaluate(() => { window.__net.shutdown = () => {}; });
  await page.reload();
  await page.waitForFunction(() => window.__net && window.__net.roomCode, null, { timeout: 20000 });
  await page.evaluate(() => window.__sceneReady); // GLBs back in (startRace gates on sceneReady)
  await expect(page.locator('#players')).toContainText('Alice'); // roster re-synced
  await expect(page.locator('#players')).toContainText('Bob');

  // The reloaded display starts with no track; the host must re-assert its pick —
  // the full MODE (cup/random/track), not just a track id, so the repair restores
  // what Start will actually run.
  await page.waitForFunction(hasTrack, null, { timeout: 10000 });
  await page.waitForFunction(() => window.__net.mode != null, null, { timeout: 10000 });

  // The whole point: pressing Start now actually flips the display into the race
  // (before the repair it was enabled here but a silent no-op on the display).
  await startRace(alice, [bob]);
  await page.waitForSelector(visible('#race'));
  await waitForRacing(page);
});
