// Geometry audit for every named track — catches the two failure classes the strand
// gate (3D centreline distance ≥ 1.5) is blind to:
//   1. SURFACE OVERLAP — two strands far apart along the lap but side-by-side at the
//      SAME level: centrelines 1.6 apart pass the 3D gate while the 5-wide road decks
//      visibly merge. Roads only clear each other when either the vertical gap exceeds
//      the deck+kerb thickness (a bridge) or the horizontal gap exceeds the half-width
//      sum (side by side).
//   2. INVISIBLE-POLE GRAZES — a support post (bridge pillar / loop shaft) intruding
//      only a few cm into a corridor: the ghost collision pole bonks rail-riding cars
//      while the visible sliver hides behind the kerb. Posts should be clearly OUT
//      (with margin) or clearly IN (a visible obstacle).
//   node scripts/audit-tracks.mjs
import { buildTrack } from './track-gen.mjs';

const { TRACKS } = await import(new URL('../public/shared/tracks.js', import.meta.url));

const KERB = 0.22 + 0.2;   // kerb width + height margin around the drivable deck
const LEVEL = 0.6;         // |Δy| below this = same level (deck 0.34 + kerb 0.2 + slack)

let issues = 0;
for (const [name, def] of Object.entries(TRACKS)) {
  const t = buildTrack(def);
  const ss = t.centerline.samples, n = ss.length, L = t.length;
  const rows = [];

  // 1. surface overlap between arc-distant strands. Upright decks only: a tilted stunt
  // flank's width does NOT span horizontally (a ring's side wall extends along the ring
  // axis), so the width-sum test would false-positive on the by-design thread-the-ring
  // clearance — tilted geometry stays under the 3D centreline gate.
  let worst = null;
  for (let i = 0; i < n; i += 2) for (let j = i + 2; j < n; j += 2) {
    if (ss[i].up.y < 0.9 || ss[j].up.y < 0.9) continue;
    const arc = Math.min(Math.abs(ss[i].s - ss[j].s), L - Math.abs(ss[i].s - ss[j].s));
    if (arc < 8) continue;
    const dy = Math.abs(ss[i].pos.y - ss[j].pos.y);
    if (dy >= LEVEL) continue;                       // vertically clear (bridge) — 3D gate governs
    const dx = ss[i].pos.x - ss[j].pos.x, dz = ss[i].pos.z - ss[j].pos.z;
    const h = Math.hypot(dx, dz);
    const need = ss[i].width / 2 + ss[j].width / 2 + KERB;
    if (h < need) {
      const depth = need - h;
      if (!worst || depth > worst.depth) worst = { depth, s1: ss[i].s, s2: ss[j].s, h, need, dy };
    }
  }
  if (worst) {
    rows.push(`SURFACE OVERLAP ${worst.depth.toFixed(2)} deep @ s=${worst.s1.toFixed(0)}↔${worst.s2.toFixed(0)} (horiz ${worst.h.toFixed(2)} < ${worst.need.toFixed(2)}, Δy ${worst.dy.toFixed(2)})`);
  }

  // 2. support-post corridor grazes (0 < intrusion < 0.5 → invisible-pole zone).
  // Intrusion is LATERAL, measured only at samples the post is ABEAM of (tangential
  // offset within its footprint + slack) — the radial distance a climbing strand
  // measures to a post two units down the road says nothing about the corridor at
  // that sample (mirrors TrackBuilder's postAtSample).
  const abeam = (sm, post) => {
    const dx = post.x - sm.pos.x, dz = post.z - sm.pos.z;
    const tl = Math.hypot(sm.tangent.x, sm.tangent.z) || 1;
    if (Math.abs((dx * sm.tangent.x + dz * sm.tangent.z) / tl) > post.radius + 0.35) return null;
    const ll = Math.hypot(sm.lateral.x, sm.lateral.z) || 1;
    const lat = (dx * sm.lateral.x + dz * sm.lateral.z) / ll;
    return { lat, intrusion: sm.width / 2 + post.radius - Math.abs(lat) };
  };
  const posts = [
    ...t.pillars.map((p) => ({ x: p.x, z: p.z, radius: p.radius, baseY: p.baseY, topY: p.topY, kind: 'pillar' })),
    ...(t.supportPosts || []).map((p) => ({ x: p.x, z: p.z, radius: p.radius, baseY: p.baseY, topY: p.contact.pos.y, kind: 'shaft' }))
  ];
  for (const post of posts) {
    let deepest = 0, at = 0;
    for (const sm of ss) {
      if (sm.up.y < 0.9) continue;
      if (sm.pos.y < post.baseY - 0.5 || sm.pos.y > post.topY - 0.5) continue;
      const hit = abeam(sm, post);
      if (hit && hit.intrusion > deepest) { deepest = hit.intrusion; at = sm.s; }
    }
    if (deepest > 0 && deepest < 0.5) rows.push(`POST GRAZE ${post.kind} intrudes ${deepest.toFixed(2)} @ s=${at.toFixed(0)} (invisible-pole zone)`);
  }

  // 3. phantom collision poles — every autoPole's (s, lat) must reconstruct to a REAL
  // post's footprint (the pole IS the post's collision; a pole with no post at its world
  // position is an invisible wall).
  for (const ap of (t.autoPoles || [])) {
    const f = t.centerline.sampleAt(ap.s);
    const px = f.pos.x + f.lateral.x * ap.lat, pz = f.pos.z + f.lateral.z * ap.lat;
    let bd = Infinity;
    for (const post of posts) bd = Math.min(bd, Math.hypot(post.x - px, post.z - pz));
    if (bd > ap.radius + 0.4) rows.push(`PHANTOM POLE @ s=${ap.s.toFixed(0)} lat=${ap.lat.toFixed(2)} — nearest post ${bd.toFixed(2)} away`);
  }

  if (rows.length) { issues += rows.length; console.log(`${name}:`); for (const r of rows) console.log('  ' + r); }
}
console.log(issues ? `\n${issues} issue(s) across the catalogue` : 'catalogue clean');
process.exitCode = issues ? 1 : 0;
