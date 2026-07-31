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
