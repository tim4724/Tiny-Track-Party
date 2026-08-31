// @ts-check
// The race page is two grids of equal boxes, and both have read as ragged for
// reasons no other test can see — nothing overflows, nothing overlaps, every
// element is where its own rule puts it, and the page still looks unfinished.
//
//   • The cup tiles centre their content, so a one-line name ("Snow Cup") built
//     a shorter block than the two-line tile beside it and centred THAT — its
//     name and its stars each landing half a line off its neighbour's. Six
//     tiles, four different baselines. The cure is that the name reserves both
//     of its lines whether or not it uses them (.mode-opt__name min-height).
//   • The four track tiles were stretched to their share of the card while the
//     schematic inside them was capped, so the slack piled up INSIDE each tile
//     as side gutters four times its top padding. The cure is that the cap sits
//     on the TILE (--track-tile) and the row spreads what is left over.
//
// Both are one declaration away from coming back, and both are invisible to a
// screenshot diff at a single size, so they are measured here at two: one where
// the width cap binds and one where the height term does.
const { test, expect } = require('./helpers');

const AT = [{ width: 932, height: 430 }, { width: 844, height: 300 }];

for (const vp of AT) {
  const at = `${vp.width}x${vp.height}`;

  test(`cup tiles ${at}: names and trails line up right across the grid`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/controller/index.html?scenario=lobby-race&color=0');
    await page.waitForSelector('.mode-opt');

    const tiles = await page.$$eval('.mode-opt', (els) => els.map((e) => {
      const tile = e.getBoundingClientRect();
      const name = e.querySelector('.mode-opt__name').getBoundingClientRect();
      const trail = e.querySelector('.mode-opt__sub, .starrow').getBoundingClientRect();
      return {
        nameH: Math.round(name.height),
        nameOff: Math.round(name.top - tile.top),
        trailOff: Math.round(trail.top - tile.top)
      };
    }));
    expect(tiles.length).toBeGreaterThan(2);

    // Measured against the tile's OWN top, so this holds down the whole ladder
    // and not merely across one row of two. A 1px allowance is the grid's
    // rounding, not slack: the failure this pins is a whole line, not a pixel.
    const spread = (k) => Math.max(...tiles.map((t) => t[k])) - Math.min(...tiles.map((t) => t[k]));
    expect(spread('nameH'), 'every name block is the same height').toBeLessThanOrEqual(1);
    expect(spread('nameOff'), 'every name starts at the same place in its tile').toBeLessThanOrEqual(1);
    expect(spread('trailOff'), 'every stars/count row does too').toBeLessThanOrEqual(1);
  });

  test(`track tiles ${at}: the schematic sits in even padding`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/controller/index.html?scenario=lobby-race&color=0');
    await page.waitForSelector('.racedetail .track-map');

    const tiles = await page.$$eval('.modepick__tracks .track-opt', (els) => els.map((e) => {
      const t = e.getBoundingClientRect();
      const m = e.querySelector('.track-map').getBoundingClientRect();
      return { l: m.left - t.left, r: t.right - m.right, top: m.top - t.top, w: Math.round(m.width) };
    }));
    expect(tiles).toHaveLength(4);

    for (const t of tiles) {
      expect(Math.abs(t.l - t.r), 'the schematic is centred in its tile').toBeLessThanOrEqual(1);
      // The side gutter is the one that ran away: 26px against a 6px top.
      expect(Math.abs(t.l - t.top), 'and its sides match its top').toBeLessThanOrEqual(2);
    }
    // One cap for all four, so the row cannot go ragged the other way either.
    expect(new Set(tiles.map((t) => t.w)).size, 'four maps of one size').toBe(1);
  });
}
