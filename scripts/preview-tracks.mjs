// Render top-down ELEVATION-COLORED schematics for any mix of candidate tracks into one
// HTML page — the fast way to eyeball a whole scan's worth of layouts before committing
// seeds (the 3D gallery stays the final judge; this is for shape triage and collision
// debugging: strands colour by height, so an unbridged graze or a floating knot pops).
//
//   node scripts/preview-tracks.mjs easy:14,15,19 hard:18,62 stunt:helix,skyline catalog:twister
//   node scripts/preview-tracks.mjs easy:14 --out /tmp/preview.html
//
// Sources: <profile>:<seeds> bakes seeds through that generator profile; stunt:<names>
// composes designs from compose-stunt.mjs (rendered even when closure fails — the gap
// is exactly what you want to see); catalog:<ids> reads shipped tracks.
import fs from 'fs';
import { bakeSeed, buildTrack } from './track-gen.mjs';
import { DESIGNS, compose } from './compose-stunt.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : 'scripts/.preview-tracks.html';

// elevation → colour: lawn-level roads stay cool, decks/stunts run hot
const heightColor = (y, maxY) => {
  const f = Math.max(0, Math.min(1, y / Math.max(4, maxY)));
  const hue = 210 - 180 * f; // blue → red
  return `hsl(${hue.toFixed(0)} 80% ${45 + 15 * f}%)`;
};

function svgFor(t, label, note) {
  const ss = t.centerline.samples;
  const xs = ss.map((s) => s.pos.x), zs = ss.map((s) => s.pos.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const V = 240, P = 16, k = (V - 2 * P) / span;
  const px = (x) => P + (V - 2 * P - (maxX - minX) * k) / 2 + (x - minX) * k;
  const pz = (z) => P + (V - 2 * P - (maxZ - minZ) * k) / 2 + (z - minZ) * k;
  const maxY = Math.max(...ss.map((s) => s.pos.y));
  // draw low strands first so bridges paint over what they fly over
  const order = ss.map((_, i) => i).sort((a, b) => ss[a].pos.y - ss[b].pos.y);
  let lines = '';
  for (const i of order) {
    const a = ss[i], b = ss[(i + 1) % ss.length];
    if (a.pos.distanceTo(b.pos) > 6) continue; // skip the seam jump on an unclosed track
    lines += `<line x1="${px(a.pos.x).toFixed(1)}" y1="${pz(a.pos.z).toFixed(1)}" x2="${px(b.pos.x).toFixed(1)}" y2="${pz(b.pos.z).toFixed(1)}" stroke="${heightColor(a.pos.y, maxY)}" stroke-width="${(a.width * k).toFixed(1)}" stroke-linecap="round"/>`;
  }
  const s0 = ss[0];
  return `<figure><svg viewBox="0 0 ${V} ${V}">${lines}` +
    `<circle cx="${px(s0.pos.x).toFixed(1)}" cy="${pz(s0.pos.z).toFixed(1)}" r="4" fill="#fff" stroke="#000"/></svg>` +
    `<figcaption><b>${label}</b><br>${note}</figcaption></figure>`;
}

const cards = [];
for (const arg of args) {
  const [kind, list] = arg.split(':');
  for (const item of (list || '').split(',').filter(Boolean)) {
    try {
      if (kind === 'stunt') {
        const design = DESIGNS[item]();
        let note;
        try {
          const r = await compose(design);
          note = `len ${r.grade.len} · lap ${r.ai.lapSec}s · strand ${r.grade.minStrand} @ ${r.grade.strandAt} · twist ${r.grade.twistRate}`;
        } catch (e) {
          for (const s of design.segs) { delete s._sweep; delete s._leg; }
          note = `UNSOLVED: ${e.message}`;
        }
        cards.push(svgFor(buildTrack(design.segs), `stunt ${item}`, note));
      } else if (kind === 'catalog') {
        const { TRACKS } = await import(new URL('../public/shared/tracks.js', import.meta.url));
        const t = buildTrack(TRACKS[item]);
        cards.push(svgFor(t, item, `len ${Math.round(t.length)}`));
      } else {
        const wp = bakeSeed(+item, kind);
        const t = buildTrack({ waypoints: wp });
        cards.push(svgFor(t, `${kind} ${item}`, `len ${Math.round(t.length)} · gap ${t.gap.toFixed(2)} · pillars ${t.pillars.length} · hills ${t.hills.length}`));
      }
    } catch (e) {
      cards.push(`<figure><figcaption><b>${kind} ${item}</b><br>FAILED: ${e.message}</figcaption></figure>`);
    }
  }
}
fs.writeFileSync(OUT,
  `<!doctype html><meta charset="utf-8"><title>track candidates</title><style>
  body{background:#20242c;color:#dde;font:13px system-ui;margin:16px}
  main{display:flex;flex-wrap:wrap;gap:12px}
  figure{margin:0;background:#2a2f3a;border-radius:10px;padding:8px;width:256px}
  svg{width:240px;height:240px;background:#39415a;border-radius:6px}
  figcaption{padding:6px 2px 2px;line-height:1.5}</style><main>${cards.join('\n')}</main>`);
console.log(`wrote ${OUT} (${cards.length} cards)`);
