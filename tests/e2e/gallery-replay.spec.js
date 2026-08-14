// @ts-check
// Every ▶ a gallery card offers must actually replay something.
//
// The button is a DECLARATION on the card (`replayable: true`) pointing at a
// hook the scenario is supposed to install (`window.__TEST__.replay`), and
// nothing tied the two together: the phone's Countdown card carried the flag
// while the controller harness never installed a hook, so its ▶ sat there doing
// nothing. A dead button is worse than no button — it reads as "this preview is
// static" being wrong rather than as a missing feature.
//
// So this walks the REAL gallery pages, takes every card that shows a ▶, and
// follows that card's own "open ↗" href to the scenario behind it. Nothing here
// names a scenario: the list is whatever the gallery declares, so a flag added
// to a card with no hook fails on the commit that adds it.
const { test, expect } = require('./helpers');

// Card chrome renders for every card up front (only the iframes are lazy), so
// the buttons and their hrefs are readable without mounting a single scene.
async function replayableCards(page, galleryUrl) {
  await page.goto(galleryUrl);
  await page.waitForSelector('.card');
  return page.evaluate(() => [...document.querySelectorAll('.card')]
    .filter((c) => c.querySelector('.card-btn'))
    .map((c) => ({
      title: (c.querySelector('.card-title span')?.textContent || '').trim(),
      href: c.querySelector('.open-link')?.getAttribute('href') || ''
    })));
}

// The hook is installed once the harness has applied its scenario, which waits
// on the wasm — the same generous boot budget the other scene specs use.
async function expectReplayWorks(page, href, title) {
  await page.goto(href);
  await page.waitForFunction(
    () => typeof window.__TEST__?.replay === 'function', null, { timeout: 30000 });

  // Installed is not the same as working. A replay has to RESTART the screen's
  // entrance, and a CSS animation only re-runs if the element goes display:none
  // and back with a style recalc between — a hide/show folded into one task is a
  // silent no-op. So wait for the screen to go STILL, then replay, then demand
  // something is running from the top again.
  //
  // "Still" rather than "something finished": the Countdown card idles on a
  // frozen banner carrying no animation at all until ▶ runs the sequence, so
  // there is nothing finished to wait for there. Waiting for quiet covers both
  // that and the boards, whose two-phase turn takes a few seconds to play out.
  await page.waitForFunction(() => ![...document.getElementsByTagName('*')]
    .some((el) => (el.getAnimations?.() || []).some((x) => x.playState === 'running')),
  null, { timeout: 30000 });

  // Identity, not the clock. Restarting a CSS animation REPLACES its Animation
  // object (display:none drops the old one, the repaint creates another), so a
  // new object is exact proof of a restart — where "is it running and young?"
  // is a wall-clock race the suite loses under parallel load. Replay and sample
  // in ONE evaluate so no round trip can sit between them.
  const rewound = await page.evaluate(async () => {
    const all = () => [...document.getElementsByTagName('*')]
      .flatMap((el) => el.getAnimations?.() || []);
    const before = new Set(all());
    window.__TEST__.replay();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return all().some((a) => !before.has(a));
  });
  expect(rewound, `${title}: ▶ repainted but restarted no animation`).toBe(true);
}

test('every ▶ on the display gallery replays its card', async ({ page }) => {
  const cards = await replayableCards(page, '/gallery.html');
  // The gallery is the source of the list, but an EMPTY list would pass this
  // spec vacuously — and the boards are the reason it exists.
  expect(cards.length).toBeGreaterThanOrEqual(4);
  for (const c of cards) await expectReplayWorks(page, c.href, c.title);
});

test('every ▶ on the controller gallery replays its card', async ({ page }) => {
  // Currently none: the phone's only motion is the settings demos, which loop
  // forever and have nothing to restart. The loop is the point — it stays
  // correct whether that stays true or a replayable phone screen shows up.
  const cards = await replayableCards(page, '/gallery-controller.html');
  for (const c of cards) await expectReplayWorks(page, c.href, c.title);
});
