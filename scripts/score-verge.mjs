// THE CONNECTION SCORE: how much of a lap the world comes up to the road, and
// how much of it the road runs across empty ground. A lap film shows it; this
// counts it, so an idea or a prototype can be compared with today's track by
// numbers that agree with the film.
//
// Every unit of the lap and on each side, a march out from the kerb (0.5 u
// steps to 30 u) records the nearest
//   PIECE  a set piece's own geometry (MEASURE has how)
//   WATER  the sea (spotIssue's 'sea', which starts 1 u landward of the
//          waterline)
//   LAND   ground standing LAND_RISE over the verge's own (0.5 u past the
//          kerb): a bank, a mound, a ridge, a cut face
//   TREE   a scatter tree or boulder
// and the SKIRT, the deck's top over that verge ground: the slab a racer sees
// standing on the plain. A later 'road' from spotIssue is another strand and
// the march goes on past it.
//
// Per track: reach6 / both6, the share of the lap with a piece, water or land
// within NEAR of the kerb on at least one side / on both (reach6Trees counts
// trees too); longestEmpty, the longest stretch with none of them within NEAR
// on either side, in units and in seconds at the autopiloted racer's own pace
// (its second lap, window.__landmarks.see); skirtMedian over the low road
// (skirt under LOW); and skyline, the share of bearings within 40 degrees of
// the road ahead, from the race's chase eye every 5 u, where terrain or a set
// piece stands at least 3 degrees over the eye's horizon inside the race fog's
// readable distance (0.8 of its far end, read off the tree's own C++).
//
// Output, in --out (default scratch/eval/scores): <track>-<tag>.json with the
// metrics and the per-unit profile (columns named in it), so a board can draw
// a strip beside a film (sync by s; the film's json carries s per frame);
// --all writes every catalogue track and summary-<tag>.json; --map draws a
// top-down map per track into <out>/../maps/<track>-<tag>.png: the road's
// halves green (something within 3 u), yellow (6 u) or red, set pieces
// magenta, sea blue, rising land shaded, trees green.
//
// --tree scores another worktree's build, like film:laps.
//
// Usage: npm run score:verge -- --track a,b|--all [--tree path] [--tag name] [--out dir] [--map]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, ROOT } from './lib/capture.mjs';

const NEAR = 6;
const REACH = 30;
const STEP = 0.5;
const LAND_RISE = 0.8;
const LOW = 1.2;
const SKY = { every: 5, half: 40, step: 5, rise: 3, share: 0.8 };

const a = args();
const TREE = path.resolve(typeof a.tree === 'string' ? a.tree : ROOT);
const TAG = typeof a.tag === 'string' ? a.tag : path.basename(TREE);
const OUT = path.resolve(typeof a.out === 'string' ? a.out : path.join(ROOT, 'scratch', 'eval', 'scores'));
const MAPS = path.join(OUT, '..', 'maps');
const { serveApp, launchBrowser, displayURL, waitForScene } = await import(pathToFileURL(path.join(TREE, 'scripts/lib/capture.mjs')));
const { TRACK_LIST } = await import(pathToFileURL(path.join(TREE, 'public/shared/tracks.js')));
const all = TRACK_LIST.map((t) => t.id);
const ids = a.all ? all : String(a.track || '').split(',').filter(Boolean);
if (!ids.length) throw new Error('--track a,b or --all');
for (const id of ids) if (!all.includes(id)) throw new Error(`unknown track ${id}`);

// The race fog's far end per biome, from the tree's own source: neither
// number crosses the ABI (biomes.js says why no palette value does).
const src = (f) => fs.readFileSync(path.join(TREE, 'native/libttp-runtime/ttp', f), 'utf8');
const FOG_FAR = Number(src('framing.h').match(/RACE_FOG_FAR = ([\d.]+)f/)[1]);
const TUNE_DEFAULT = Number(src('theme.h').match(/float fogTune = ([\d.]+)/)[1]);
const themes = src('theme.cc');
function fogTune(biome) {
  const at = themes.indexOf(`Theme ${biome}Theme() {`);
  if (at < 0) throw new Error(`no ${biome}Theme() in theme.cc`);
  const body = themes.slice(at, themes.indexOf('\n}\n', at));
  const m = body.match(/t\.fogTune = ([\d.]+)f/);
  return m ? Number(m[1]) : TUNE_DEFAULT;
}

// IN THE PAGE: the per-unit profile and the skyline. A set piece is its own
// triangles, not its boxes (one mesh can be a whole reef): each model is
// rasterized top-down into the height of its geometry per SHAPE cell, a draped
// part's apart (it lies on the ground as drawn), and placed by its anchor,
// axes and the scale its footprint says, as the landmark gallery's sight lines
// place it (TestHarness.js inShape). Pieces and trees are binned on a coarse
// grid so each probe point tests only its own cell's.
const MEASURE = async ([id, o]) => {
  const d = window.__scene.display;
  const lay = window.__landmarks.layout();
  const len = lay.length;
  const frames = [];
  for (let s0 = 0; s0 < len; s0 += 64) {
    const list = [];
    for (let s = s0; s < Math.min(s0 + 64, len); s += 1) list.push(s);
    frames.push(...d.trackFrames(id, list));
  }
  const { glbTriangles } = await import('/display/glbTriangles.js');
  const SHAPE = 0.5;
  const shapes = new Map();
  await Promise.all([...new Set(lay.pieces.map((p) => p.model))].map(async (m) => {
    const tris = glbTriangles(new Uint8Array(await (await fetch(`/assets/toycar/${m}.glb`)).arrayBuffer()));
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const t of tris) for (const [x, , z] of t) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const nx = Math.max(1, Math.ceil((x1 - x0) / SHAPE)), nz = Math.max(1, Math.ceil((z1 - z0) / SHAPE));
    const hi = new Float32Array(nx * nz).fill(-Infinity), draped = new Float32Array(nx * nz).fill(-Infinity);
    for (const t of tris) {
      const [a, b, c] = t;
      const edge = Math.max(Math.hypot(b[0] - a[0], b[2] - a[2]), Math.hypot(c[0] - b[0], c[2] - b[2]), Math.hypot(a[0] - c[0], a[2] - c[2]));
      const n = Math.max(1, Math.ceil(edge / (SHAPE / 2)));
      const into = t.drape ? draped : hi;
      for (let i = 0; i <= n; i++) {
        for (let j = 0; i + j <= n; j++) {
          const u = i / n, v = j / n, w = 1 - u - v;
          const k = Math.min(nz - 1, Math.floor((a[2] * w + b[2] * u + c[2] * v - z0) / SHAPE)) * nx
                  + Math.min(nx - 1, Math.floor((a[0] * w + b[0] * u + c[0] * v - x0) / SHAPE));
          into[k] = Math.max(into[k], a[1] * w + b[1] * u + c[1] * v);
        }
      }
    }
    shapes.set(m, { x0, z0, nx, nz, w: x1 - x0, d: z1 - z0, hi, draped });
  }));
  const CELL = 4;
  const bin = () => new Map();
  const put = (g, item, x, z, r) => {
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
      for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
        const k = i * 100003 + j;
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(item);
      }
    }
  };
  const at = (g, x, z) => g.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) || [];
  const pieces = bin(), trees = bin();
  for (const p of lay.pieces) put(pieces, p, p.cx, p.cz, Math.hypot(p.hx, p.hz) + 1);
  for (const [x, z, r] of d.scatterLayout()) put(trees, { x, z, r }, x, z, r);
  // The top of whatever set piece geometry stands over (x, z), ground `g`
  // there, or -Infinity.
  const pieceTop = (x, z, g) => {
    let top = -Infinity;
    for (const q of at(pieces, x, z)) {
      const sh = shapes.get(q.model);
      const sc = sh.w >= sh.d ? (2 * q.hx) / sh.w : (2 * q.hz) / sh.d;
      const dx = x - q.x, dz = z - q.z;
      const i = Math.floor(((dx * q.ax + dz * q.az) / sc - sh.x0) / SHAPE);
      const k = Math.floor(((dz * q.ax - dx * q.az) / sc - sh.z0) / SHAPE);
      if (i < 0 || k < 0 || i >= sh.nx || k >= sh.nz) continue;
      top = Math.max(top, q.y + sh.hi[k * sh.nx + i] * sc, g + sh.draped[k * sh.nx + i] * sc);
    }
    return top;
  };
  const isPiece = (x, z, g) => pieceTop(x, z, g) > g + 0.05;
  const inTree = (x, z) => at(trees, x, z).some((t) => Math.hypot(x - t.x, z - t.z) <= t.r);
  // The layout row whose foot (spotIssue's, PIECE_MARGIN 0.5 round it) holds (x, z).
  const footRow = (x, z) => lay.pieces.findIndex((p) => {
    const dx = x - p.cx, dz = z - p.cz;
    return Math.abs(dx * p.ax + dz * p.az) < p.hx + 0.5 && Math.abs(-dx * p.az + dz * p.ax) < p.hz + 0.5;
  });

  const profile = frames.map((f) => {
    const row = { s: f.s, upright: f.up.y >= 0.7, sides: [] };
    const fl = Math.hypot(f.lateral.x, f.lateral.z) || 1;
    for (const side of [-1, 1]) {   // left, right (lateral points right)
      const ox = side * f.lateral.x / fl, oz = side * f.lateral.z / fl;
      const kx = f.pos.x + side * f.lateral.x * f.width / 2;
      const kz = f.pos.z + side * f.lateral.z * f.width / 2;
      const ky = f.pos.y + side * f.lateral.y * f.width / 2;
      const verge = d.groundY(kx + ox * 0.5, kz + oz * 0.5);
      const near = { piece: null, water: null, land: null, tree: null };
      let own = true;
      for (let k = 1; k * o.step <= o.reach; k++) {
        const r = k * o.step, x = kx + ox * r, z = kz + oz * r;
        const g = d.groundY(x, z);
        let issue = d.spotIssue(x, z, g, g);
        // A piece's foot outranks the sea, and a reef stands in the surf:
        // ask again past that piece.
        if (issue === 'piece') issue = d.spotIssue(x, z, g, g, footRow(x, z));
        if (issue !== 'road') own = false;
        if (near.water === null && issue === 'sea' && !own) near.water = r;
        if (near.piece === null && isPiece(x, z, g)) near.piece = r;
        if (near.land === null && g - verge >= o.landRise) near.land = r;
        if (near.tree === null && inTree(x, z)) near.tree = r;
        if (near.piece !== null && near.water !== null && near.land !== null && near.tree !== null) break;
      }
      row.sides.push({ ...near, skirt: Math.round((ky - verge) * 100) / 100 });
    }
    return row;
  });

  // The skyline: a bearing is closed where terrain or a piece rises o.sky.rise
  // degrees over the chase eye's horizon inside the readable fog distance.
  const tanRise = Math.tan(o.sky.rise * Math.PI / 180);
  const skyline = [];
  for (const f of frames) {
    if (f.s % o.sky.every || f.up.y < 0.7) continue;
    const tl = Math.hypot(f.tangent.x, f.tangent.z) || 1;
    const eye = d.chaseRig(f.pos.x, f.pos.y, f.pos.z, f.tangent.x / tl, f.tangent.z / tl, 1).eye;
    const head = Math.atan2(f.tangent.z, f.tangent.x);
    let closed = 0, n = 0;
    for (let b = -o.sky.half; b <= o.sky.half; b += o.sky.step, n++) {
      const h = head + b * Math.PI / 180, cx = Math.cos(h), cz = Math.sin(h);
      for (let r = 2; r <= o.readable; r += 2) {
        const x = eye[0] + cx * r, z = eye[2] + cz * r;
        const g = d.groundY(x, z);
        if (Math.max(g, pieceTop(x, z, g)) - eye[1] >= r * tanRise) { closed++; break; }
      }
    }
    skyline.push([f.s, Math.round((closed / n) * 1000) / 1000]);
  }
  window.__verge = { frames, footRow, isPiece };   // what MAP draws over
  return { len, profile, skyline };
};

// IN THE PAGE, after MEASURE: the top-down map, as a PNG data URL.
const MAP = ([rows, title]) => {
  const d = window.__scene.display;
  const lay = window.__landmarks.layout();
  const { frames: fr, footRow, isPiece } = window.__verge;
  const M = 34;
  const xs = fr.map((f) => f.pos.x), zs = fr.map((f) => f.pos.z);
  const x0 = Math.min(...xs) - M, x1 = Math.max(...xs) + M, z0 = Math.min(...zs) - M, z1 = Math.max(...zs) + M;
  const px = Math.min(5, 1600 / Math.max(x1 - x0, z1 - z0));
  const cv = document.createElement('canvas');
  cv.width = Math.ceil((x1 - x0) * px);
  cv.height = Math.ceil((z1 - z0) * px) + 28;
  const g = cv.getContext('2d');
  const X = (x) => (x - x0) * px, Z = (z) => (z - z0) * px + 28;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, cv.width, cv.height);
  for (let x = x0; x < x1; x += 1) {
    for (let z = z0; z < z1; z += 1) {
      const gy = d.groundY(x + 0.5, z + 0.5);
      const issue = d.spotIssue(x + 0.5, z + 0.5, gy, gy);
      const sea = (issue === 'piece' ? d.spotIssue(x + 0.5, z + 0.5, gy, gy, footRow(x + 0.5, z + 0.5)) : issue) === 'sea';
      const k = Math.min(Math.max(gy - lay.groundY, 0) / 8, 1);
      g.fillStyle = isPiece(x + 0.5, z + 0.5, gy) ? '#c04bb0' : sea ? '#7fb8dc' : `rgb(${236 - 110 * k},${230 - 120 * k},${214 - 130 * k})`;
      g.fillRect(X(x), Z(z), px + 0.5, px + 0.5);
    }
  }
  g.fillStyle = '#4f7d4a';
  for (const [x, z, r] of d.scatterLayout()) { g.beginPath(); g.arc(X(x), Z(z), Math.max(r * px, 1.5), 0, 7); g.fill(); }
  const tone = (dist) => (dist !== null && dist <= 3 ? '#2e9d4f' : dist !== null && dist <= 6 ? '#e2b100' : '#d33c2c');
  g.lineCap = 'butt';
  fr.forEach((f, i) => {
    const n = fr[(i + 1) % fr.length];
    if (Math.hypot(n.pos.x - f.pos.x, n.pos.z - f.pos.z) > 3) return;
    [-1, 1].forEach((side, j) => {
      const off = side * f.width / 4;
      g.strokeStyle = tone(rows[i] ? rows[i][j] : null);
      g.lineWidth = (f.width / 2) * px;
      g.beginPath();
      g.moveTo(X(f.pos.x + f.lateral.x * off), Z(f.pos.z + f.lateral.z * off));
      g.lineTo(X(n.pos.x + n.lateral.x * off), Z(n.pos.z + n.lateral.z * off));
      g.stroke();
    });
  });
  g.fillStyle = '#111';
  g.font = `${Math.max(11, Math.round(px * 2.4))}px sans-serif`;
  for (let u = 0; u < 1; u += 0.05) {
    const f = fr[Math.floor(u * lay.length)];
    g.fillText(u.toFixed(2), X(f.pos.x - f.lateral.x * (f.width / 2 + 3)) - 12, Z(f.pos.z - f.lateral.z * (f.width / 2 + 3)) + 4);
  }
  g.font = '15px sans-serif';
  g.fillText(title, 8, 19);
  return cv.toDataURL('image/png');
};

const pct = (n, of) => (of ? Math.round((n / of) * 1000) / 10 : 0);
const median = (v) => (v.length ? v.slice().sort((x, y) => x - y)[v.length >> 1] : null);

// The metrics, off the page's profile and the racer's lap (s -> seconds).
function fold(id, m, lap, tune) {
  const rows = m.profile.filter((r) => r.upright);
  const nearOf = (side, trees) => {
    const ds = [side.piece, side.water, side.land, ...(trees ? [side.tree] : [])].filter((v) => v !== null);
    return ds.length ? Math.min(...ds) : null;
  };
  const within = (v) => v !== null && v <= NEAR;
  const reached = (r, trees) => r.sides.some((sd) => within(nearOf(sd, trees)));
  const kinds = {};
  for (const k of ['piece', 'water', 'land', 'tree']) kinds[k] = pct(rows.filter((r) => r.sides.some((sd) => within(sd[k]))).length, rows.length);
  // s -> seconds into the racer's lap 2, off its samples, from the line (the
  // first sample lands a little past it): the film's clock.
  const at = (s) => {
    const f = lap.frames;
    let k = 0;
    while (k < f.length - 1 && f[k + 1].s <= s) k++;
    const a0 = f[k], b0 = f[k + 1];
    if (!b0 || b0.s === a0.s) return k * lap.every;
    return (k + Math.min((s - a0.s) / (b0.s - a0.s), 1)) * lap.every;
  };
  const t = (s) => at(s) - at(0);
  const lapSeconds = lap.frames.length * lap.every;
  // The longest run of empty upright units round the lap, across the line.
  const empty = m.profile.map((r) => r.upright && !reached(r, false));
  let best = null;
  const n = empty.length;
  const start = empty.indexOf(false);
  if (start < 0) best = { from: 0, to: n, len: n };
  else {
    for (let k = 1, run = 0; k <= n; k++) {
      const j = (start + k) % n;
      if (k < n && empty[j]) { run++; continue; }
      if (run && (!best || run > best.len)) best = { from: (j - run + n) % n, to: j, len: run };
      run = 0;
    }
  }
  const longestEmpty = best && {
    u: [+(best.from / m.len).toFixed(3), +(best.to / m.len).toFixed(3)],
    len: best.len,
    secs: +(best.to >= best.from ? t(best.to) - t(best.from) : lapSeconds - t(best.from) + t(best.to)).toFixed(1)
  };
  const skirts = rows.flatMap((r) => r.sides.map((sd) => sd.skirt)).filter((v) => v < LOW);
  const sky = m.skyline.length ? m.skyline.reduce((x, [, c]) => x + c, 0) / m.skyline.length : 0;
  const fogFar = FOG_FAR * tune;
  return {
    track: id, tag: TAG, tree: TREE, biome: lap.biome, len: m.len, lapSeconds: +lapSeconds.toFixed(1),
    fog: { far: fogFar, readable: +(fogFar * SKY.share).toFixed(1) },
    metrics: {
      reach6: pct(rows.filter((r) => reached(r, false)).length, rows.length),
      both6: pct(rows.filter((r) => r.sides.every((sd) => within(nearOf(sd, false)))).length, rows.length),
      reach6Trees: pct(rows.filter((r) => reached(r, true)).length, rows.length),
      longestEmpty,
      skirtMedian: median(skirts),
      skyline: +(sky * 100).toFixed(1),
      kinds
    },
    columns: ['u', 's', 't', 'Lpiece', 'Lwater', 'Lland', 'Ltree', 'Rpiece', 'Rwater', 'Rland', 'Rtree', 'Lskirt', 'Rskirt', 'upright'],
    profile: m.profile.map((r) => {
      const [L, R] = r.sides;
      return [+(r.s / m.len).toFixed(4), r.s, +t(r.s).toFixed(2), L.piece, L.water, L.land, L.tree, R.piece, R.water, R.land, R.tree, L.skirt, R.skirt, r.upright ? 1 : 0];
    }),
    skyline: m.skyline
  };
}

fs.mkdirSync(OUT, { recursive: true });
const app = await serveApp();
const browser = await launchBrowser();
const results = [];
try {
  const page = await browser.page({ viewport: { width: 960, height: 540 } });
  await page.goto(displayURL(app.port, { scenario: 'landmarks', track: ids[0], players: 1, dpr: 1 }));
  await waitForScene(page, { timeout: 180000 });
  await page.waitForFunction(() => window.__landmarks && window.__landmarks.ready(), null, { timeout: 180000, polling: 250 });
  await page.evaluate(() => window.__landmarks.ready());
  for (const id of ids) {
    const lap = await page.evaluate(async (t) => {
      const l = window.__landmarks;
      if (l.seats() !== 1) await l.players(1);
      if (l.trackId() !== t) await l.track(t);
      const r = await l.see({ every: 0.25 });
      const { forTrack } = await (await import('/shared/biomes.js')).loadBiomes();
      return { every: r.every, frames: r.frames.map((f) => ({ s: f.s })), biome: forTrack(t) };
    }, id);
    const tune = fogTune(lap.biome);
    const m = await page.evaluate(MEASURE, [id, { step: STEP, reach: REACH, landRise: LAND_RISE, sky: SKY, readable: FOG_FAR * tune * SKY.share }]);
    const r = fold(id, m, lap, tune);
    results.push(r);
    fs.writeFileSync(path.join(OUT, `${id}-${TAG}.json`), JSON.stringify(r));
    if (a.map) {
      fs.mkdirSync(MAPS, { recursive: true });
      const near = r.profile.map((p) => [[p[3], p[4], p[5]], [p[7], p[8], p[9]]].map((ds) => {
        const v = ds.filter((x) => x !== null);
        return v.length ? Math.min(...v) : null;
      }));
      const title = `${id}  ${TAG}  reach6 ${r.metrics.reach6}%  both6 ${r.metrics.both6}%  skyline ${r.metrics.skyline}%`;
      const png = await page.evaluate(MAP, [near, title]);
      fs.writeFileSync(path.join(MAPS, `${id}-${TAG}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    const e = r.metrics.longestEmpty;
    console.log(`${id.padEnd(11)} reach6 ${String(r.metrics.reach6).padStart(5)}  both6 ${String(r.metrics.both6).padStart(5)}  +trees ${String(r.metrics.reach6Trees).padStart(5)}`
      + `  empty ${e ? `${e.len}u/${e.secs}s @${e.u[0]}` : '-'}  skirt ${r.metrics.skirtMedian}  skyline ${r.metrics.skyline}`
      + `  piece ${r.metrics.kinds.piece} water ${r.metrics.kinds.water} land ${r.metrics.kinds.land} tree ${r.metrics.kinds.tree}`);
  }
} finally {
  await browser.close();
  app.close();
}
if (a.all) {
  fs.writeFileSync(path.join(OUT, `summary-${TAG}.json`), JSON.stringify(results.map((r) => ({ track: r.track, biome: r.biome, lapSeconds: r.lapSeconds, ...r.metrics }))));
}
