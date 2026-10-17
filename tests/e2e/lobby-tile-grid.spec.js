// @ts-check
// The race page is one grid of equal boxes, and it has read as ragged for
// reasons no other test can see — nothing overflows, nothing overlaps, every
// element is where its own rule puts it, and the page still looks unfinished.
//
//   • The names WRAPPED — short ones on one line, long ones on two — so a tile
//     built a taller or shorter block than its neighbour, landing its stars
//     half a line off. Four baselines across the grid, and no alignment could
//     fix it because the tiles were not the same shape. Every name is now ONE
//     line under a band that takes the tile's spare height (controller.css
//     .mode-opt__band), so every tile is the same stack.
//   • The padlock had a grid column of its own, which pinned it to the tile's
//     edge while the count it qualifies centred away from it. It rides inside
//     the trail element now, so the pair centres as one thing.
//
// Both are one declaration away from coming back, and both are invisible to a
// screenshot diff at a single size, so they are measured here at two.
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
      const nameEl = e.querySelector('.mode-opt__name');
      const lines = Math.round(name.height / parseFloat(getComputedStyle(nameEl).lineHeight));
      return {
        lines,
        nameMid: Math.round(name.top + name.height / 2 - tile.top),
        trailOff: Math.round(trail.top - tile.top),
        nameOffCentre: Math.round(name.left + name.right - tile.left - tile.right),
        trailOffCentre: Math.round(trail.left + trail.right - tile.left - tile.right),
        nameLeft: Math.round(name.left - tile.left),
        trailLeft: Math.round(trail.left - tile.left),
        // Short phones lay the tile on its side (controller.css, max-height
        // 320px): band left, name and trail flush left beside it.
        sideways: getComputedStyle(e).display === 'grid'
      };
    }));
    expect(tiles.length).toBeGreaterThan(2);
    // One shape for all of them, which is what the alignment rests on: a name
    // that wraps grows its tile's stack and no centring makes the grid straight.
    for (const t of tiles) expect(t.lines, 'every name is one line').toBe(1);

    // Measured against the tile's OWN box, so this holds down the whole ladder
    // and not merely across one row of two. A 1px allowance is the grid's
    // rounding, not slack: the failure this pins is a whole line, not a pixel.
    const spread = (k) => Math.max(...tiles.map((t) => t[k])) - Math.min(...tiles.map((t) => t[k]));
    expect(spread('nameMid'), 'every name sits at the same height in its tile').toBeLessThanOrEqual(1);
    expect(spread('trailOff'), 'every stars/count row does too').toBeLessThanOrEqual(1);

    // Centred across too — including the locked tile, whose padlock used to
    // take a column of its own and carry the count off with it. On its side,
    // flush left instead, every tile at the same offset beside its band.
    expect(new Set(tiles.map((t) => t.sideways)).size, 'one layout for the whole grid').toBe(1);
    if (tiles[0].sideways) {
      expect(spread('nameLeft'), 'every name starts at the same offset').toBeLessThanOrEqual(1);
      expect(spread('trailLeft'), 'and so does every trail, padlock included').toBeLessThanOrEqual(1);
    } else {
      for (const t of tiles) {
        expect(Math.abs(t.nameOffCentre), 'the name is centred').toBeLessThanOrEqual(1);
        expect(Math.abs(t.trailOffCentre), 'and so is the trail, padlock included').toBeLessThanOrEqual(2);
      }
    }
  });
}
