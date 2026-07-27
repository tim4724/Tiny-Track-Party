// Geometry audit for every named track — catches the failure classes the strand
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
//   3. PHANTOM POLES — a collision pole whose (s, lat) doesn't reconstruct to any real
//      post's world position: an invisible mid-lane wall (the radial-intrusion bug
//      shipped one on Sidewinder).
//   node scripts/audit-tracks.mjs
import { buildTrack } from './track-gen.mjs';
import { trackSupports } from './native-track.mjs';

// Audit BOTH catalogues: the shipped tracks (tracks.js) and the dev surfaces
// (devTracks.js — the Gym).
const { TRACKS } = await import(new URL('../public/shared/tracks.js', import.meta.url));
const { DEV_TRACKS } = await import(new URL('../public/shared/devTracks.js', import.meta.url));
const ALL_TRACKS = { ...TRACKS, ...DEV_TRACKS };

const KERB = 0.22 + 0.2;   // kerb width + height margin around the drivable deck
const LEVEL = 0.6;         // |Δy| below this = same level (deck 0.34 + kerb 0.2 + slack)

let issues = 0;
for (const [name, def] of Object.entries(ALL_TRACKS)) {
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
  // The measurement comes from the ENGINE (ttp_track_supports_json): the deepest
  // each pillar/shaft reaches into a drivable corridor, gated on
  // upright/height-band/abeam by the same function that decides whether to plant
  // a ghost collision pole there. A hand-synced copy of that gate is exactly how
  // the radial-intrusion bug once slipped its own regression test.
  const { posts, autoPoles } = trackSupports(def);
  for (const post of posts) {
    if (post.intrusion > 0 && post.intrusion < 0.5) {
      rows.push(`POST GRAZE ${post.kind} intrudes ${post.intrusion.toFixed(2)} @ s=${post.s.toFixed(0)} (invisible-pole zone)`);
    }
  }

  // 3. phantom collision poles — every autoPole's (s, lat) must reconstruct to a REAL
  // post's footprint (the pole IS the post's collision; a pole with no post at its world
  // position is an invisible wall). The engine reconstructs the world position
  // through its own centreline sampler; the "near enough" rule stays here.
  for (const ap of autoPoles) {
    let bd = Infinity;
    for (const post of posts) bd = Math.min(bd, Math.hypot(post.x - ap.x, post.z - ap.z));
    if (bd > ap.radius + 0.4) rows.push(`PHANTOM POLE @ s=${ap.s.toFixed(0)} lat=${ap.lat.toFixed(2)} — nearest post ${bd.toFixed(2)} away`);
  }

  if (rows.length) { issues += rows.length; console.log(`${name}:`); for (const r of rows) console.log('  ' + r); }
}
console.log(issues ? `\n${issues} issue(s) across the catalogue` : 'catalogue clean');
process.exitCode = issues ? 1 : 0;
