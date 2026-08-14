// @ts-check
// The gallery's results previews render through the LIVE board renderer
// (raceOverlays.renderResults) fed by the LIVE ui model (resultsView) — the
// harness supplies only a synthesized standings board and the model decides
// every dressing from there. That is what stops these cards drifting, the way
// the lobby cards once drifted to a screen that no longer existed.
//
// It also puts a shape contract in the harness: the board it synthesizes has to
// keep matching what standingsPayload emits. A field renamed on the C++ side
// (`series`, `order`, `final`, `gained`, `racePlace`…) would not throw — it
// would quietly answer a PLAINER dressing, so a cup board would silently render
// as a single race. Each case below pins the dressing to something only the
// right board can produce.
//
// A CUP BOARD IS TWO PHASES (see raceOverlays): the race that just ended, then
// the cup table it rewrote. The cases below step through the transition rather
// than only inspecting where it lands, because the phases share every element —
// a board stuck on phase 1, or one that skipped straight to phase 2, differs
// from a correct one only in TIME.
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

// Phase 2 arrives on the model's own racePhaseMs, and the wasm boot can eat most
// of that window on a cold page — so wait for the state, never for a duration.
const settled = (page, title) => page.waitForFunction(
  (t) => document.getElementById('results-title')?.textContent === t, title, { timeout: 30000 });

// Phase 1 cannot be sampled by asking the page later: a cold wasm compile can
// blow the whole race phase before the first assertion round-trips, which is a
// flaky test rather than a real one. So record the board's state IN THE PAGE the
// moment it is first revealed, and assert against that snapshot afterwards.
async function recordFirstPaint(page) {
  await page.addInitScript(() => {
    window.__firstBoard = null;
    const grab = () => {
      const r = document.getElementById('results');
      if (window.__firstBoard || !r || r.classList.contains('hidden')) return;
      window.__firstBoard = {
        title: document.getElementById('results-title').textContent,
        subHidden: document.getElementById('results-sub').classList.contains('hidden'),
        nextHidden: document.getElementById('results-next').classList.contains('hidden'),
        nextHeld: document.getElementById('results-next').classList.contains('is-held'),
        listBox: JSON.stringify(document.getElementById('results-list').getBoundingClientRect()),
        podium: r.classList.contains('is-podium'),
        rows: [...document.querySelectorAll('#results-list li')].map((li) => li.textContent)
      };
    };
    addEventListener('DOMContentLoaded', () => new MutationObserver(grab)
      .observe(document.body, { attributes: true, childList: true, subtree: true }));
  });
}
const firstBoard = async (page) => {
  await page.waitForFunction(() => window.__firstBoard, null, { timeout: 30000 });
  return page.evaluate(() => window.__firstBoard);
};

test('gallery results board: plain finishes plus the joining row, in two columns', async ({ page }) => {
  await page.goto('/?scenario=results&players=3');
  expect(await boardText(page, 'results-title')).toBe('Results');
  // 3 humans + the CPU fill to the live 8-car field, plus the late joiner
  // riding along underneath.
  expect(await page.locator('#results-list li').count()).toBe(9);
  // The joining row is a DIFFERENT shape, not a racer with empty fields: no
  // time, the "Next race" cell instead.
  await expect(page.locator('#results-list li.is-joining')).toHaveCount(1);
  await expect(page.locator('#results-list li.is-joining .res-time')).toHaveText('Next race');
  // Nine rows do not fit a 720p TV in one column — the title and the button used
  // to be pushed off the screen edges.
  await expect(page.locator('#results-list')).toHaveClass(/is-two-col/);
  // A single race has ONE phase: it is already what it will be.
  await expect(page.locator('#results-list li .res-time').first()).toBeVisible();
  await expect(page.locator('#results-list li .res-pts')).toHaveCount(0);
  await expect(page.locator('#results-sub')).toBeHidden();
});

test('gallery cup intermission: the race board becomes the cup table', async ({ page }) => {
  await recordFirstPaint(page);
  await page.goto('/?scenario=intermission&players=4');

  // PHASE 1 — the race that just ended. "Results" over a cup board is only
  // reachable from raceTitleKey, and the rows carry the lap time, the score for
  // the place, and the cup total this row held COMING IN.
  const p1 = await firstBoard(page);
  expect(p1.title).toBe('Results');
  expect(p1.subHidden).toBe(false);
  expect(p1.rows.length).toBe(8);
  // Lap time, the place's score, AND the cup total coming in — all three, so the
  // standings phase changes one VALUE rather than materialising a column, and
  // the climb has a before state that was on screen long enough to read.
  // (row.textContent runs the cells together: "1Mia28.4s+915 pts")
  expect(p1.rows.every((r) => /\d\.\ds/.test(r)), 'every row shows a lap time').toBe(true);
  expect(p1.rows.every((r) => /\+\d/.test(r)), 'every row shows its score').toBe(true);
  expect(p1.rows.every((r) => / pts$/.test(r)), 'every row shows a cup total').toBe(true);
  // The next-up footer belongs to the standings; announcing the next circuit
  // over the finishing order would step on the result being read. But it is
  // HELD, not removed — its box stays reserved so its arrival in phase 2 cannot
  // shove the title, the list and the button up by its own height. Those three
  // are not what the FLIP animates, so they would jump while the rows slid.
  expect(p1.nextHeld).toBe(true);
  expect(p1.nextHidden).toBe(false);

  // PHASE 2 — the cup table. "Standings" is only reachable with a series.
  await settled(page, 'Standings');
  await expect(page.locator('#results-list li .res-pts').first()).toHaveText(/\d+ pts/);
  // Both race columns RETIRE once the last point has landed: a settled board is
  // the cup's, and a lap time between a cup rank and a cup total is the only
  // number still talking about the race. They fade rather than being removed, so
  // the cells are still there holding the layout — which is why this asserts the
  // state and not the count.
  await expect(page.locator('#results-list li .res-time')).toHaveCount(8);
  await expect(page.locator('#results-list li .res-time.is-spent')).toHaveCount(8);
  await expect(page.locator('#results-list li .res-gain.is-spent')).toHaveCount(8);
  // The footer names the next circuit and counts down to the auto-advance. The
  // seconds come from the engine's own intermission budget, so pin the shape
  // rather than the number.
  expect(await boardText(page, 'results-next')).toMatch(/Next up:.+starting in \d+…/);
  await expect(page.locator('#results-newgame')).toHaveText('Next race ▸');
  // Every racer is still on the board — the phases re-order the SAME rows.
  await expect(page.locator('#results-list li')).toHaveCount(8);
  // AND THE BOARD NEVER RESIZED. The two phases lay out the same cells at the
  // same widths, so the only thing that moved is the rows — which is what the
  // shell animates. The first cut swapped the trailing cell instead and the list
  // jumped 48px sideways and grew 130px mid-slide.
  const listBox = await page.evaluate(
    () => JSON.stringify(document.getElementById('results-list').getBoundingClientRect()));
  expect(listBox).toBe(p1.listBox);
});

test('gallery cup podium: the champs header lands on the full standings', async ({ page }) => {
  await recordFirstPaint(page);
  await page.goto('/?scenario=podium&players=4');
  // A podium opens on its race like any other cup board; only phase 2 celebrates.
  const p1 = await firstBoard(page);
  expect(p1.title).toBe('Results');
  expect(p1.podium).toBe(false);

  // The CHAMPS header needs series.final — the flag the harness has to spell right.
  await page.waitForFunction(
    () => /CHAMPS!$/.test(document.getElementById('results-title')?.textContent || ''),
    null, { timeout: 30000 });
  await expect(page.locator('#results')).toHaveClass(/is-podium/);
  // The WHOLE field stands on the podium board. The old shape lifted the top
  // three onto steps and started the list at index 3 of the raw order, which
  // dropped a racer off both whenever a joining row sat in the first three.
  await expect(page.locator('#results-list li')).toHaveCount(8);
  // The cup's top three are medalled in place, champion first.
  await expect(page.locator('#results-list li.is-medal-1')).toHaveCount(1);
  await expect(page.locator('#results-list li').first()).toHaveClass(/is-medal-1/);
  await expect(page.locator('#results-list li.is-medal-2')).toHaveCount(1);
  await expect(page.locator('#results-list li.is-medal-3')).toHaveCount(1);
  // A finished cup queues nothing.
  await expect(page.locator('#results-next')).toBeHidden();
  await expect(page.locator('#results-newgame')).toHaveText('New Game');
});
