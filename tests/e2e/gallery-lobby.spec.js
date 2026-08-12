// @ts-check
// The gallery's lobby previews must keep tracking the LIVE lobby. Since the
// boot-time attract shipped, the lobby floats over the 3D track preview with
// the attract race running from its first frame — and the gallery once kept
// showing the retired 2D diorama backdrop, a screen that no longer exists.
//
// One predicate, asserted against BOTH surfaces: the live lobby (relay, real
// room) and every gallery lobby scenario (?scenario=…, no relay). They share
// the same observables by construction — #scene revealed by opacity, and the
// attract demo on the window.__lobbyDemo hook — so if the live lobby's look
// changes again, the gallery legs of this spec are what goes red.
const { test, expect, openDisplay, visible } = require('./helpers');

// Attract race up: 3D backdrop revealed (not the 2D diorama) and the demo's
// sim built its field. The demo builds after the scene + wasm are ready, so
// give it the same generous boot timeout the race specs use.
async function expectAttractLobby(page) {
  await page.waitForSelector(visible('#lobby'));
  await page.waitForFunction(() => {
    const sc = document.getElementById('scene');
    return sc && !sc.classList.contains('hidden') && !sc.classList.contains('is-dim');
  }, null, { timeout: 30000 });
  await page.waitForFunction(
    () => window.__lobbyDemo && window.__lobbyDemo.active,
    null, { timeout: 30000 }
  );
  expect(await page.evaluate(() => window.__lobbyDemo.engine.carIds().length)).toBeGreaterThan(0);
  // Settled, not just transiently revealed: main.js schedules updateBackdrop two
  // frames after the scene boots, and a re-dim there once blanked every 3D
  // scenario while the transient check above stayed green by winning the race.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await page.evaluate(() => document.getElementById('scene').className)).not.toContain('is-dim');
}

test('live lobby attracts in 3D from its first frame', async ({ page }) => {
  await openDisplay(page); // welcome → NEW GAME → lobby, room live
  await expectAttractLobby(page);
});

// The lobby scenarios the harness serves, by the gallery's own URL scheme
// (gallery-common's displayURL: the display page at `/` with ?scenario=…).
// The bare `scenario=lobby` has no card of its own any more, but it is the
// base the picked variants build on, so it stays covered.
for (const q of [
  'scenario=lobby-empty',
  'scenario=lobby&players=2',
  'scenario=lobby&picked=track&track=driftwood',
  'scenario=lobby&picked=tour',
]) {
  test(`gallery ${q} attracts like the live lobby`, async ({ page }) => {
    await page.goto('/?' + q);
    await expectAttractLobby(page);
  });
}

// The progression dressings — pinned against the synthesized mid-game payload
// (three cups starred, the Playroom locked 3/4). Only the right shape produces
// these: a renamed progress field degrades to a starless shelf, not a throw.
test('gallery lobby: the cup shelf and the pick card carry the couch stars', async ({ page }) => {
  await page.goto('/?scenario=lobby&players=2&picked=cup');
  await expectAttractLobby(page);
  // The shelf: one row per cup, the locked Playroom trailing its progress.
  await expect(page.locator('.cup-shelf__row')).toHaveCount(5);
  await expect(page.locator('.cup-shelf__row', { hasText: 'Beach' })
    .locator('.star:not(.star--off)')).toHaveCount(3);
  await expect(page.locator('.cup-shelf__row--locked')).toContainText('3/4');
  // The pick card wears the picked cup's stars (Beach = 3 in the synthesis).
  await expect(page.locator('.cup-stars .star:not(.star--off)')).toHaveCount(3);
});
