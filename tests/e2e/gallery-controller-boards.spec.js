// @ts-check
// The PHONE's results previews render through the live board renderer
// (controller/resultsBoard.js) fed a synthesized STANDINGS payload — the same
// no-drift arrangement the display's boards use (see gallery-boards.spec.js).
// The harness used to hand-roll its own twin of this markup and had already
// drifted: the race board never set #results-title, and the cup board hardcoded
// "Race 2 of 4" instead of deriving it from the series.
//
// The shape contract is the thing to gate. A field renamed on the payload
// (`series`, `final`, `finished`, `gained`…) does not throw — it quietly answers
// a PLAINER dressing, so a finished cup board renders as if everyone were still
// out on track. That exact bug shipped in the first draft of the synthesized
// payload: rows without `finished` all came back marked `is-racing`. Each case
// below pins something only the right payload can produce.
const { test, expect } = require('./helpers');

const CONTROLLER = '/controller/index.html?scenario=';

// Pure DOM, no relay and no scene — the board is painted as soon as the module
// graph lands, so a non-empty title is enough to know the scenario ran.
async function boardReady(page) {
  await page.waitForFunction(() => {
    const t = document.getElementById('results-title');
    return t && t.textContent && t.textContent.length > 0;
  }, null, { timeout: 30000 });
}

test('phone results board: finish times, the joining row, host gets New game', async ({ page }) => {
  await page.goto(`${CONTROLLER}results&color=1`);
  await boardReady(page);
  // A single race has no series, which is the only way to reach this title.
  await expect(page.locator('#results-title')).toHaveText('Results');
  await expect(page.locator('#result-list li')).toHaveCount(5);
  // The joining row is a DIFFERENT shape, not a racer with blank fields.
  await expect(page.locator('#result-list li.is-joining')).toHaveCount(1);
  await expect(page.locator('#result-list li.is-joining .res-time')).toHaveText('Next race');
  // Race board ⇒ times, never points.
  await expect(page.locator('#result-list li .res-pts')).toHaveCount(0);
  // The board is over and viewed as the host.
  await expect(page.locator('#newgame-btn')).toHaveText('New game');
  await expect(page.locator('#result-wait')).toBeHidden();
});

test('phone results board mid-race: my time, everyone else still racing', async ({ page }) => {
  await page.goto(`${CONTROLLER}finished&color=1`);
  await boardReady(page);
  await expect(page.locator('#results-title')).toHaveText('Results');
  // The point of this screen: I am home, the others are not. `over:false` plus
  // per-row `finished` is what separates them — a payload that lost either would
  // mark every row the same.
  await expect(page.locator('#result-list li.is-me .res-time')).toHaveText('31.2s');
  await expect(page.locator('#result-list li.is-racing')).toHaveCount(3);
  await expect(page.locator('#result-list li.is-racing .res-time').first()).toHaveText('Racing…');
  // Nobody may start anything while cars are still out.
  await expect(page.locator('#newgame-btn')).toBeHidden();
  await expect(page.locator('#result-wait')).toHaveText('Waiting for the other racers to finish…');
});

test('phone cup intermission: points board, race counter, both host buttons', async ({ page }) => {
  await page.goto(`${CONTROLLER}intermission&color=1`);
  await boardReady(page);
  // Derived from series.raceIndex/raceCount — the harness used to hardcode this.
  await expect(page.locator('#results-title')).toHaveText('Race 2 of 4');
  // Cup dressing: points columns replace the lap clock.
  await expect(page.locator('#result-list li .res-pts').first()).toBeVisible();
  await expect(page.locator('#result-list li .res-time')).toHaveCount(0);
  // A finished cup board must NOT mark its rows as still out on track.
  await expect(page.locator('#result-list li.is-racing')).toHaveCount(0);
  // Mid-series ⇒ advance, plus the only escape hatch out of a cup.
  await expect(page.locator('#newgame-btn')).toHaveText('Next race ▸');
  await expect(page.locator('#quitcup-btn')).toHaveText('End cup early');
});

test('phone cup podium: cup-named final header, no quit hatch', async ({ page }) => {
  await page.goto(`${CONTROLLER}cup-podium&color=1`);
  await boardReady(page);
  // series.final is the flag the harness has to spell right; without it this
  // silently falls back to the plain race counter.
  await expect(page.locator('#results-title')).toHaveText(/ — Final$/);
  await expect(page.locator('#result-list li .res-pts').first()).toBeVisible();
  await expect(page.locator('#result-list li.is-racing')).toHaveCount(0);
  // The cup is done: back to the lobby, and nothing left to abandon.
  await expect(page.locator('#newgame-btn')).toHaveText('New game');
  await expect(page.locator('#quitcup-btn')).toBeHidden();
});
