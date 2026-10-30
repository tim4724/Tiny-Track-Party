// @ts-check
// The renderer's raised ground against the road and the set pieces, read off
// the ground it actually draws (display.groundY: the grid, the deck cap, the
// clearings, the berms). Per cup, track by track:
//   - under every deck point, kerb to kerb, the ground stays under the slab
//     (or at the plain, where the slab itself is sunk into it);
//   - beside raised road, 1 to 4 u off either edge, no bank comes above the
//     slab's underside (a crossing's lower road, the far side of a hairpin);
//   - every part of a piece modelled on terrain (SET_GROUND) that stands on
//     that terrain touches the ground drawn under it: nothing floats.
// Berms are drawn over the ground and answer groundY too, so the points
// beside one are left out; so is a SET_GROUND mound beside the road (a
// mountain's foot may meet the road). A cup on a flat biome stops after its
// first track, which shows the plain everywhere.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./helpers');

const ROOT = path.resolve(__dirname, '../..');
const HEADER = fs.readFileSync(path.join(ROOT, 'native/renderer/src/TtpRenderer.h'), 'utf8');
const constant = (name) => Number(new RegExp(`${name} = ([\\d.]+)f`).exec(HEADER)[1]);
const DEPTH = constant('kDeckDepth');   // the slab under the deck's top
const CLEAR = constant('kDeckClear');   // what the cap keeps under it
const TOUCH = 0.1;                      // scripts/set-check.mjs: a part held up
const SLACK = 1e-3;

const loadTrack = async (page, id) => {
  await page.goto(`/?scenario=track&track=${id}&dpr=0.5`);
  await page.waitForFunction(() => window.__scene && window.__scene.display
    && window.__scene.display.setLayout().length > 0, null, { timeout: 90000, polling: 200 });
  return page.evaluate(() => window.__scene.display.setLayout());
};

test('the raised ground stays under every road and holds up the terrain pieces', async ({ page }) => {
  test.setTimeout(600000);
  const { CUPS, TRACKS, TRACK_LIST, SET_GROUND, setGroundY } = await import(path.join(ROOT, 'public/shared/tracks.js'));
  const { init, buildTrack } = await import(path.join(ROOT, 'scripts/native-track.mjs'));
  const { checkPiece, SET_DIR } = await import(path.join(ROOT, 'scripts/set-check.mjs'));
  await init();
  const standing = new Map();
  for (const cup of CUPS) {
    for (const id of cup.tracks) {
      const b = buildTrack(TRACK_LIST.find((t) => t.id === id));
      const S = b.centerline.samples, gy = b.groundY;
      const layout = await loadTrack(page, id);
      const set = TRACKS[id].set || [];
      const own = layout.pieces.map((r, i) => ({ r, k: set[i]?.scale ?? 1 })).filter(({ r }) => SET_GROUND[r.model]);
      const local = ({ r, k }, x, z) => {
        const dx = (x - r.x) / k, dz = (z - r.z) / k, c = Math.cos(r.heading), s = Math.sin(r.heading);
        return [c * dx - s * dz, s * dx + c * dz];
      };
      const inMound = (x, z) => own.some((o) => setGroundY(o.r.model, ...local(o, x, z)) > 0);
      const berms = S.filter((q) => q.hillable && !q.pillars);
      const nearBerm = (x, z) => berms.some((q) => Math.hypot(q.pos.x - x, q.pos.z - z) < q.width / 2 + 7);

      // [x, z, highest allowed ground]
      const under = [], beside = [];
      for (let i = 0; i < S.length; i++) {
        const a = S[i], c = S[(i + 1) % S.length];
        if (a.hillable && !a.pillars) continue;
        for (const f of [0, 0.5]) {
          const lerp = (key) => ({ x: a[key].x + (c[key].x - a[key].x) * f, y: a[key].y + (c[key].y - a[key].y) * f,
                                   z: a[key].z + (c[key].z - a[key].z) * f });
          const pos = lerp('pos'), lat = lerp('lateral'), up = lerp('up');
          const half = (a.width + (c.width - a.width) * f) / 2;
          for (let k = -4; k <= 4; k++) {
            const l = half * k / 4, x = pos.x + lat.x * l, z = pos.z + lat.z * l;
            if (!nearBerm(x, z)) under.push([x, z, Math.max(pos.y + lat.y * l - DEPTH * up.y, gy) + SLACK]);
          }
          const top = Math.min(pos.y + lat.y * half, pos.y - lat.y * half);
          if (top - DEPTH - CLEAR <= gy) continue;   // raised road only
          for (const side of [-1, 1]) {
            for (const o of [1, 2.5, 4]) {
              const x = pos.x + lat.x * side * (half + o), z = pos.z + lat.z * side * (half + o);
              if (!inMound(x, z) && !nearBerm(x, z)) beside.push([x, z, top - DEPTH + SLACK]);
            }
          }
        }
      }
      // Each standing part as its feet in the world.
      const parts = [];
      for (const o of own) {
        if (!standing.has(o.r.model)) standing.set(o.r.model, checkPiece(path.join(SET_DIR, `${o.r.model}.glb`)).standing);
        const c = Math.cos(o.r.heading), s = Math.sin(o.r.heading);
        for (const isl of standing.get(o.r.model)) {
          parts.push({ at: `${o.r.model} [${isl.lo.map((v) => v.toFixed(1))}]`,
            feet: isl.feet.map(([x, y, z]) => [o.r.x + (c * x + s * z) * o.k, o.r.y + y * o.k, o.r.z + (-s * x + c * z) * o.k]) });
        }
      }
      const r = await page.evaluate(({ under, beside, parts, gy, touch }) => {
        const d = window.__scene.display;
        const over = (pts) => pts.filter(([x, z, lim]) => d.groundY(x, z) > lim)
          .map(([x, z, lim]) => `(${x.toFixed(1)}, ${z.toFixed(1)}) ${(d.groundY(x, z) - lim).toFixed(2)} over`);
        return {
          relief: under.some(([x, z]) => Math.abs(d.groundY(x, z) - gy) > 1e-3),
          under: over(under),
          beside: over(beside),
          floating: parts.filter((q) => q.feet.every(([x, y, z]) => y > d.groundY(x, z) + touch)).map((q) => q.at)
        };
      }, { under, beside, parts, gy, touch: TOUCH });
      expect.soft(r.under.slice(0, 5), `${id}: ground through a deck`).toEqual([]);
      expect.soft(r.beside.slice(0, 5), `${id}: a bank above the slab beside raised road`).toEqual([]);
      expect.soft(r.floating, `${id}: SET_GROUND parts floating over the drawn ground`).toEqual([]);
      if (!r.relief) break;   // a flat biome: the rest of the cup shows the same plain
    }
  }
});
