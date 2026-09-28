// @ts-check
// A window change landing INSIDE Stage.boot() must still reach the renderer's
// viewport. Why that window exists, and why missing it never heals, is the
// comment on the reconcile in Stage.boot(); this pins the behaviour.
//
// The .filamat delay below is what holds the window open on demand — without it
// the race needs a cold network to lose, which is why it shipped unnoticed.
const { test, expect } = require('./helpers');

// How far down the buffer the black clear runs before the frame starts. 0 is a
// viewport that fills its buffer: the clear colour is pure black, and no sky in
// the game is. The full height means nothing has been presented yet.
async function blackRowsAtTop(page) {
  return page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById('scene-canvas'));
    // preserveDrawingBuffer is on (ttp_display_web.cc), so the presented frame
    // is still readable here.
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const g = /** @type {CanvasRenderingContext2D} */ (
      off.getContext('2d', { willReadFrequently: true }));
    g.drawImage(c, 0, 0);
    const px = g.getImageData(0, 0, off.width, off.height).data;
    let y = 0;
    for (; y < off.height; y++) {
      let lit = false;
      for (let x = 0; x < off.width && !lit; x++) {
        const i = (y * off.width + x) * 4;
        lit = !!(px[i] || px[i + 1] || px[i + 2]);
      }
      if (lit) break;
    }
    return { black: y, height: off.height };
  });
}

const canvasHeight = (page) => page.evaluate(
  () => /** @type {HTMLCanvasElement} */ (document.getElementById('scene-canvas')).height);

test("a window change during the renderer's boot still reaches its viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 660 });
  await page.route('**/*.filamat', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await page.goto('/');
  // The canvas exists from the Stage constructor, which runs BEFORE boot()'s
  // await — so from here the window is open.
  await page.waitForSelector('#scene-canvas', { state: 'attached' });
  const before = await canvasHeight(page);
  // Taller, same width: what leaving the browser's own chrome behind looks like.
  await page.setViewportSize({ width: 1280, height: 800 });

  // Fails loudly with the boot error if the renderer never came up, rather than
  // as a timeout on the poll below.
  await page.waitForFunction(() => window.__sceneReady !== undefined, null, { timeout: 30000 });
  await page.evaluate(() => window.__sceneReady);
  await expect.poll(async () => {
    const s = await blackRowsAtTop(page);
    return s.black < s.height;
  }, { timeout: 30000 }).toBe(true);

  const shot = await blackRowsAtTop(page);
  // The buffer followed the window — asserted as GREW rather than against a
  // number, so the automation render scale stays the one place it is named …
  expect(shot.height).toBeGreaterThan(before);
  // … and the viewport followed it too: no letterbox above the picture.
  expect(shot.black).toBe(0);
});
