// @ts-check
// The gallery's results previews render through the LIVE board renderer
// (raceOverlays.renderResults) fed by the LIVE ui model (resultsView) — the
// harness supplies only a synthesized standings board and the model decides
// every dressing from there. That is what stops these cards drifting, the way
// the lobby cards once drifted to a screen that no longer existed.
//
// It also puts a shape contract in the harness: the board it synthesizes has to
// keep matching what standingsPayload emits. A field renamed on the C++ side
// (`series`, `order`, `final`, `gained`…) would not throw — it would quietly
// answer a PLAINER dressing, so a cup board would silently render as a single
// race. Each case below pins the dressing to something only the right board can
// produce.
const { test, expect } = require('./helpers');

// The overlay is painted synchronously once the wasm is up, so waiting for the
// title to be non-empty is enough — no scene boot involved.
async function boardText(page, id) {
  await page.waitForFunction(() => {
    const r = document.getElementById('results');
    const t = document.getElementById('results-title');
    return r && !r.classList.contains('hidden') && t && t.textContent.length > 0;
  }, null, { timeout: 30000 });
  return page.evaluate((sel) => document.getElementById(sel)?.textContent || '', id);
}

test('gallery results board: plain finishes plus the joining row', async ({ page }) => {
  await page.goto('/?scenario=results&players=3');
  expect(await boardText(page, 'results-title')).toBe('Results');
  // 3 racers + the late joiner riding along underneath.
  expect(await page.locator('#results-list li').count()).toBe(4);
  // The joining row is a DIFFERENT shape, not a racer with empty fields: no
  // time, the "Next race" cell instead.
  await expect(page.locator('#results-list li.is-joining')).toHaveCount(1);
  await expect(page.locator('#results-list li.is-joining .res-time')).toHaveText('Next race');
  // A single race has no cup furniture.
  await expect(page.locator('#results-sub')).toBeHidden();
  await expect(page.locator('#results-podium')).toBeHidden();
});

test('gallery cup intermission: points board, sub-heading and the next-up footer', async ({ page }) => {
  await page.goto('/?scenario=intermission&players=4');
  // "Standings" (not "Results") is only reachable with a series on the board.
  expect(await boardText(page, 'results-title')).toBe('Standings');
  expect(await boardText(page, 'results-sub')).toMatch(/Race \d+ of \d+/);
  // Points rows, not time rows — the cup dressing.
  await expect(page.locator('#results-list li .res-pts').first()).toBeVisible();
  await expect(page.locator('#results-list li .res-time')).toHaveCount(0);
  // The footer names the next circuit and counts down to the auto-advance. The
  // seconds come from the engine's own intermission budget, so pin the shape
  // rather than the number.
  expect(await boardText(page, 'results-next')).toMatch(/Next up:.+starting in \d+…/);
  await expect(page.locator('#results-newgame')).toHaveText('Next race ▸');
  await expect(page.locator('#results-podium')).toBeHidden();
});

test('gallery cup podium: champs header, three steps, list from 4th', async ({ page }) => {
  await page.goto('/?scenario=podium&players=4');
  // The CHAMPS header needs series.final — the flag the harness has to spell right.
  expect(await boardText(page, 'results-title')).toMatch(/CHAMPS!$/);
  await expect(page.locator('#results-podium .podium__col')).toHaveCount(3);
  // Steps read 2nd | 1st | 3rd left-to-right.
  expect(await page.locator('#results-podium .podium__col').evaluateAll(
    (cols) => cols.map((c) => c.dataset.place)
  )).toEqual(['2', '1', '3']);
  // The top three are ON the steps, so the list holds only 4th and below.
  await expect(page.locator('#results-list li')).toHaveCount(1);
  await expect(page.locator('#results')).toHaveClass(/is-podium/);
  await expect(page.locator('#results-sub')).toBeHidden();
});
