// @ts-check
// The legal footer and the page behind it. tests/credits.test.js already pins
// the DATA and the footer markup; what only a browser can prove is that the
// page still RENDERS — every row of it is built by /licenses.js at load, so a
// throw there leaves a styled, empty, silently uncredited page. And that the
// notice links, which are what actually discharge the permissive licenses,
// resolve instead of 404ing.
const { test, expect, visible } = require('./helpers');

test('the welcome board footer leads to a licenses page that renders its credits', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.waitForSelector(visible('#welcome'));

  const foot = page.locator('.welcome__foot');
  await expect(foot).toBeVisible();
  // Three of the four leave the site (the repo, and the two couchpad.games
  // legal pages), so follow none of them here — only assert they are offered.
  await expect(foot.locator('a[href="https://github.com/tim4724/Tiny-Track-Party"]'))
    .toHaveText('Developed by Tim');
  await expect(foot.locator('a[href="https://couchpad.games/en/privacy"]')).toBeVisible();
  await expect(foot.locator('a[href="https://couchpad.games/en/imprint"]')).toBeVisible();

  await foot.locator('a[href="/licenses.html"]').click();
  await page.waitForURL('**/licenses.html');

  // One card per type, in SECTION_ORDER, and the CC-BY line CC-BY itself
  // demands sits in the section holding the music.
  const sections = page.locator('#sections .sec');
  await expect(sections.locator('.sec__badge'))
    .toHaveText(['Music', '3D models', 'Sound effects', 'Fonts', 'Software']);
  await expect(sections.first()).toContainText('Kevin MacLeod');

  // A song from the live catalogue, and a work from each of the other types —
  // proof the page is rendering the real data rather than its own markup. Every
  // section is the same row form, so a song is an .entry like anything else.
  await expect(page.locator('.entry__title', { hasText: 'Beachfront Celebration' })).toBeVisible();
  await expect(page.locator('.entry__title', { hasText: 'Toy Car Kit' })).toBeVisible();
  await expect(page.locator('.entry__title', { hasText: 'Filament' })).toBeVisible();
  expect(errors).toEqual([]);
});

// The license chip links our own served copy wherever the license demands its
// text ship with the build, so those are the hrefs that carry the compliance.
test('every license notice the page links is actually served', async ({ page, request }) => {
  await page.goto('/licenses.html');
  // assetUrl() resolves to an absolute same-origin href, so that is what marks
  // a chip as pointing at a text WE serve rather than at a canonical one.
  const hrefs = await page.locator('.entry__license').evaluateAll(
    (as) => as.map((a) => a.href).filter((h) => h.startsWith(location.origin)));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
    const res = await request.get(href);
    expect(res.status(), `${href} must be served`).toBe(200);
    // A notice the browser downloads instead of opening is not a notice.
    expect(res.headers()['content-type']).toContain('text/plain');
  }
});
