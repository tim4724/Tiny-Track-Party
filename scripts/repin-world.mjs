// REPIN THE WORLD after the road moves under it. A set piece or a free
// landform is authored at (u, lat, yaw) off the road, so anything that changes
// the road's centre line or lap length (the strip's rules or widths, a re-baked
// layout) slides every row along the lap and turns it with the road there:
// a far ridge swings metres, and pieces laid to meet each other (a railway's
// lengths, a marble run, a cirque) part. Record the world first, change the
// road, then solve each row back onto its pose:
//
//   npm run repin:world -- ref [file]                 every row's world pose, now (default scratch/world-pins.json)
//   (change the road, rebuild the wasm)
//   npm run repin:world -- solve [file] [ids...]      what would move, and by how much along the road
//   npm run repin:world -- solve [file] --write       ...rewritten in tracks.js; regenerate the defs and rebuild
//
// The forward model is the renderer's placement, and must change with it
// (TtpRendererTrack.cpp, THE WORLD KEEPS ITS DISTANCE FROM THE KERB):
//   lat' = asphaltMid + lat (+ that side's strip when |lat| is past the asphalt)
//   anchor = frame(u).pos + lateral * lat', heading = road heading + yaw
// Free landforms only: not shore or the road-span kinds (street, snake, ladder,
// shed), and not anchored on a piece. Rows are single-line literals.
import fs from 'node:fs';
import path from 'node:path';
import { init, buildTrack, trackFrames } from './native-track.mjs';
const { TRACKS } = await import('../public/shared/tracks.js');
const DEFAULT_PINS = 'scratch/world-pins.json';
await init();

const [mode, ...args] = process.argv.slice(2);
const file = args[0] && args[0].endsWith('.json') ? args.shift() : DEFAULT_PINS;
const rest = args;
const write = rest.includes('--write');
const pick = rest.filter((a) => !a.startsWith('--'));
const ROAD_KINDS = new Set(['shore', 'street', 'snake', 'ladder', 'shed']);
const DEG = Math.PI / 180;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const lengthOf = new Map();
const len = (id) => { if (!lengthOf.has(id)) lengthOf.set(id, buildTrack(id).centerline.length); return lengthOf.get(id); };
const frames = (id, ss) => trackFrames(id, ss.map((s) => ((s % len(id)) + len(id)) % len(id)));

const pushed = (f, lat) => {
  const half = f.width / 2 - (f.sandL + f.sandR) / 2;
  const strip = Math.abs(lat) > half ? (lat < 0 ? f.sandL : f.sandR) : 0;
  return (f.sandL - f.sandR) / 2 + lat + (lat < 0 ? -strip : strip);
};
const forward = (f, lat, yawDeg) => {
  const l = pushed(f, lat);
  return { x: f.pos.x + f.lateral.x * l, z: f.pos.z + f.lateral.z * l,
           h: wrap(Math.atan2(f.tangent.x, f.tangent.z) + (yawDeg || 0) * DEG) };
};
const freeLand = (r) => r.piece == null && !ROAD_KINDS.has(r.kind);
const rowsOf = (id) => ({
  set: (TRACKS[id].set || []).map((r, i) => ({ r, i })),
  land: (TRACKS[id].land || []).map((r, i) => ({ r, i })).filter(({ r }) => freeLand(r)),
});
const poseOf = (id, r) => { const [f] = frames(id, [(r.u ?? 0) * len(id)]); return forward(f, r.lat ?? 0, r.yaw ?? 0); };

const ids = pick.length ? pick : Object.keys(TRACKS).filter((id) => TRACKS[id].set || TRACKS[id].land);

if (mode === 'ref') {
  const out = {};
  for (const id of ids) {
    const { set, land } = rowsOf(id);
    out[id] = { set: set.map(({ r, i }) => ({ i, model: r.model, ...poseOf(id, r) })),
                land: land.map(({ r, i }) => ({ i, kind: r.kind, ...poseOf(id, r) })) };
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  console.log('wrote', file, Object.keys(out).length, 'tracks');
} else if (mode === 'solve') {
  const ref = JSON.parse(fs.readFileSync(file, 'utf8'));
  let src = fs.readFileSync('public/shared/tracks.js', 'utf8');
  for (const id of ids) {
    if (!ref[id]) continue;
    const L = len(id);
    const { set, land } = rowsOf(id);
    // Newton on the forward model from the row as it stands: unknowns the
    // arclength s and the pushed lateral offset, so a row already on its pose
    // stays exactly where it is (the inverse is not unique on sloped or banked
    // road, and a projection picks a different, equivalent row).
    const solveRow = (r, want) => {
      let s = (r.u ?? 0) * L;
      let lp = pushed(frames(id, [s])[0], r.lat ?? 0);
      const H = 0.05;
      for (let it = 0; it < 30; it++) {
        const [f, g] = frames(id, [s, s + H]);
        const px = f.pos.x + f.lateral.x * lp, pz = f.pos.z + f.lateral.z * lp;
        const ex = want.x - px, ez = want.z - pz;
        if (Math.hypot(ex, ez) < 1e-5) break;
        const ax = (g.pos.x + g.lateral.x * lp - px) / H, az = (g.pos.z + g.lateral.z * lp - pz) / H;
        const bx = f.lateral.x, bz = f.lateral.z;
        const det = ax * bz - az * bx;
        if (Math.abs(det) < 1e-9) return null;
        let ds = (ex * bz - ez * bx) / det, dl = (ax * ez - az * ex) / det;
        const step = Math.hypot(ds, dl);
        if (step > 5) { ds *= 5 / step; dl *= 5 / step; }
        s += ds; lp += dl;
      }
      const f = frames(id, [s])[0];
      const resid = Math.hypot(want.x - (f.pos.x + f.lateral.x * lp), want.z - (f.pos.z + f.lateral.z * lp));
      if (resid > 0.01) return null;
      const mid = (f.sandL - f.sandR) / 2, half = f.width / 2 - (f.sandL + f.sandR) / 2;
      let lat = lp - mid;
      const strip = lat < 0 ? f.sandL : f.sandR;
      if (Math.abs(lat) - strip > half) lat -= Math.sign(lat) * strip;
      else if (Math.abs(lat) > half) console.log(`  ${id} ${r.model || r.kind}: lands inside a strip of the asphalt; check by hand`);
      const u = ((s / L) % 1 + 1) % 1;
      const yaw = wrap(want.h - Math.atan2(f.tangent.x, f.tangent.z)) / DEG;
      return { u, lat, yaw };
    };
    // the text of this track's block, and its rows in order
    const head = src.search(new RegExp(`\\n  ${id}: \\{`));
    if (head < 0) { console.log(`${id}: block not found`); continue; }
    const next = src.slice(head + 1).search(/\n {2}[a-zA-Z0-9_]+: \{/);
    const end = next < 0 ? src.length : head + 1 + next;
    let block = src.slice(head, end);
    const listRows = (key, re) => {
      const at = block.indexOf(`\n    ${key}: [`);
      if (at < 0) return [];
      const close = block.indexOf('\n    ]', at);
      const out = [];
      const rx = new RegExp(re, 'g');
      let m;
      const sub = block.slice(at, close);
      while ((m = rx.exec(sub))) out.push({ start: at + m.index, text: m[0] });
      return out;
    };
    const setLines = listRows('set', String.raw`\n\s*\{ model: [^\n]*\}`);
    const landLines = listRows('land', String.raw`\n\s*\{ kind: [^\n]*\}`);
    if (setLines.length !== (TRACKS[id].set || []).length || landLines.length !== (TRACKS[id].land || []).length) {
      console.log(`${id}: row count mismatch (set ${setLines.length}/${(TRACKS[id].set || []).length}, land ${landLines.length}/${(TRACKS[id].land || []).length}); skipped`);
      continue;
    }
    const edits = [];
    const fmt = (v, n) => Number(v.toFixed(n)).toString();
    const consider = (kind, rows, lines, refs) => {
      rows.forEach(({ r, i }, k) => {
        const want = refs[k];
        const got = solveRow(r, want);
        if (!got) { console.log(`  ${id} ${kind}[${i}] ${r.model || r.kind}: no foot found`); return; }
        const du = Math.abs(wrap((got.u - (r.u ?? 0)) * 2 * Math.PI)) / (2 * Math.PI) * L;
        const dl = Math.abs(got.lat - (r.lat ?? 0)), dy = Math.abs(wrap((got.yaw - (r.yaw ?? 0)) * DEG)) / DEG;
        if (du < 0.02 && dl < 0.01 && dy < 0.1) return;
        console.log(`  ${id} ${kind}[${i}] ${(r.model || r.kind).padEnd(26)} u ${r.u}->${fmt(got.u, 5)} lat ${r.lat ?? 0}->${fmt(got.lat, 3)} yaw ${r.yaw ?? 0}->${fmt(got.yaw, 2)}  (along ${du.toFixed(2)})`);
        let t = lines[i].text;
        const setKey = (key, val, after) => {
          const re = new RegExp(`(\\b${key}: )(-?[0-9.eE+-]+)`);
          if (re.test(t)) t = t.replace(re, `$1${val}`);
          else t = t.replace(new RegExp(`(\\b${after}: -?[0-9.eE+-]+)`), `$1, ${key}: ${val}`);
        };
        setKey('u', fmt(got.u, 5), 'model');
        setKey('lat', fmt(got.lat, 3), 'u');
        if (Math.abs(got.yaw) > 0.005 || /\byaw: /.test(t)) setKey('yaw', fmt(got.yaw, 2), 'lat');
        edits.push({ start: lines[i].start, old: lines[i].text, text: t });
      });
    };
    consider('set', set, setLines, ref[id].set);
    consider('land', land, landLines, ref[id].land);
    // apply from the back so the offsets hold
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) block = block.slice(0, e.start) + e.text + block.slice(e.start + e.old.length);
    if (write && edits.length) src = src.slice(0, head) + block + src.slice(end);
    console.log(`${id}: ${edits.length} row(s) ${write ? 'rewritten' : 'would move'}`);
  }
  if (write) fs.writeFileSync('public/shared/tracks.js', src);
} else {
  console.error('usage: repin-world.mjs ref|solve [pins.json] [--write] [ids...]');
  process.exit(1);
}
