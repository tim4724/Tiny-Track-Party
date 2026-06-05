'use strict';
// Self-crossing analyser for designing OVERPASS / figure-8 tracks. Builds a
// candidate piece sequence and reports:
//   • closure (gap) + length
//   • per-piece waypoints (x, z, y, heading°) so you can read the plan shape
//   • every XZ self-intersection of the centerline, with the VERTICAL CLEARANCE
//     (|Δy|) between the two strands there — so an overpass can be tuned to clear.
//
// Usage: node scripts/probe-cross.js [candidateName]
// Candidates are defined inline below; tweak them and re-run while designing.
(async () => {
  const THREE = await import('three');
  const { PIECES, buildTrack } = await import('../public/display/TrackBuilder.js');

  const S = 'straight', L = 'cornerLargeL', R = 'cornerLargeR';

  // ---- geometry helpers (shared by analyse + search) ----
  function selfCrossings(t) {
    const pts = t.centerline.samples.map((s) => s.pos);
    const tan = t.centerline.samples.map((s) => s.tangent);
    const n = pts.length;
    function cross(a, b, c, d) {
      const r = { x: b.x - a.x, z: b.z - a.z }, s = { x: d.x - c.x, z: d.z - c.z };
      const den = r.x * s.z - r.z * s.x;
      if (Math.abs(den) < 1e-9) return null;
      const tt = ((c.x - a.x) * s.z - (c.z - a.z) * s.x) / den;
      const uu = ((c.x - a.x) * r.z - (c.z - a.z) * r.x) / den;
      if (tt < 0 || tt > 1 || uu < 0 || uu > 1) return null;
      return { tt, uu };
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = pts[j], d = pts[(j + 1) % n];
        const hit = cross(a, b, c, d);
        if (!hit) continue;
        const y1 = a.y + (b.y - a.y) * hit.tt, y2 = c.y + (d.y - c.y) * hit.uu;
        const x = a.x + (b.x - a.x) * hit.tt, z = a.z + (b.z - a.z) * hit.tt;
        // angle between the two strands' tangents (transverse vs shared-edge)
        const ang = Math.abs(Math.acos(Math.max(-1, Math.min(1,
          (tan[i].x * tan[j].x + tan[i].z * tan[j].z) /
          (Math.hypot(tan[i].x, tan[i].z) * Math.hypot(tan[j].x, tan[j].z) || 1)))) * 180 / Math.PI);
        out.push({ i, j, x, z, dy: Math.abs(y1 - y2), y1, y2, angle: Math.min(ang, 180 - ang) });
      }
    }
    return out;
  }

  // ---- SEARCH mode: find closing figure-8s with one TRANSVERSE crossing ----
  // Skeleton: T turns, half CW (R) half CCW (L) → net 0°, with k straights
  // between every turn. We scan turn orderings × straight count for a layout that
  // closes and crosses itself once at a near-perpendicular point (not a shared edge).
  if (process.argv[2] === 'search') {
    const perms = (arr) => arr.length <= 1 ? [arr] :
      arr.flatMap((x, i) => perms(arr.slice(0, i).concat(arr.slice(i + 1))).map((p) => [x, ...p]));
    const uniq = (xss) => [...new Map(xss.map((x) => [x.join(''), x])).values()];
    const results = [];
    const MAXS = 4; // per-slot straights 0..MAXS
    for (const T of [6, 8]) {
      const turnSets = uniq(perms(Array(T / 2).fill('R').concat(Array(T / 2).fill('L'))));
      const slots = T + 1; // straight slots: before, between every turn, after
      const combos = Math.pow(MAXS + 1, slots);
      for (const turns of turnSets) {
        for (let code = 0; code < combos; code++) {
          // decode per-slot straight counts (base MAXS+1)
          const cnt = []; let c = code;
          for (let s = 0; s < slots; s++) { cnt.push(c % (MAXS + 1)); c = Math.floor(c / (MAXS + 1)); }
          const seq = [];
          for (let ti = 0; ti < T; ti++) {
            for (let s = 0; s < cnt[ti]; s++) seq.push(S);
            seq.push(turns[ti] === 'R' ? R : L);
          }
          for (let s = 0; s < cnt[T]; s++) seq.push(S);
          let t; try { t = buildTrack(seq, { startGate: false }); } catch { continue; }
          if (!t.closed) continue;
          const cr = selfCrossings(t);
          const transverse = cr.filter((c) => c.angle > 40);
          if (cr.length === 1 && transverse.length === 1) {
            results.push({ seq, T, turns: turns.join(''), len: t.length, angle: transverse[0].angle });
          }
        }
      }
      if (T === 6 && results.length) break; // prefer the simpler 6-corner ∞ if found
    }
    // de-dup identical sequences, prefer longer + more perpendicular
    const seen = new Set();
    const uniqRes = results.filter((r) => { const k = r.seq.join(); if (seen.has(k)) return false; seen.add(k); return true; });
    uniqRes.sort((a, b) => (b.angle - a.angle) || (b.len - a.len));
    console.log(`found ${uniqRes.length} closing single-transverse-crossing layouts:\n`);
    for (const r of uniqRes.slice(0, 16)) {
      console.log(`  T=${r.T} turns=${r.turns} len=${r.len.toFixed(1)} angle=${r.angle.toFixed(0)}°  seq=[${r.seq.map((s) => s.replace('cornerLargeL', 'L').replace('cornerLargeR', 'R').replace('straight', 'S')).join(',')}]`);
    }
    return;
  }

  // ---- candidate layouts under design (flat first, then elevated) ----
  const parseSeq = (str) => str.split(',').map((s) => s === 'S' ? S : s === 'R' ? R : L);
  const C = {};
  // figure-8 attempts (flat). net rotation must be 0 (one lobe CW, one CCW).
  C.fig8a = [S, R, S, R, S, R, S, L, S, L, S, L];                 // 3+3 corners, 270°/lobe
  C.fig8c = [S, R, R, S, R, R, S, L, L, S, L, L];                 // tighter
  // top hits from `search` (closing, single 90° crossing):
  C.fig8d = parseSeq('S,S,S,S,R,S,R,S,S,S,S,R,S,S,S,S,L,S,S,L,S,L,S,S,S,S');
  C.fig8e = parseSeq('S,S,S,S,R,R,S,S,S,S,R,S,S,S,S,L,S,S,L,S,S,L,S,S,S,S');
  // OVERPASS: fig8d with the west-bound strand (pieces 12 & 15) climbed up & back
  // down so it bridges OVER the closing north-bound strand at the crossing.
  C.overpass = (() => { const s = C.fig8d.slice(); s[12] = 'hillUp'; s[15] = 'hillDown'; return s; })();
  // taller variant: climb across two pieces (12,13 up / 14,15 down) for more clearance
  C.overpass2 = (() => { const s = C.fig8d.slice(); s[12] = 'hillUp'; s[13] = 'hillUp'; s[14] = 'hillDown'; s[15] = 'hillDown'; return s; })();

  const name = process.argv[2] || 'fig8a';
  const seq = C[name];
  if (!seq) { console.log('unknown candidate; have:', Object.keys(C).join(', ')); return; }

  // Net per-piece waypoints (connector space, no scale/overlap) — mirrors
  // buildTrack's chaining so the plan shape matches the real track.
  const tmp = new THREE.Matrix4();
  let cursor = new THREE.Matrix4();
  const r2 = (n) => Math.round(n * 100) / 100;
  console.log(`\n=== candidate "${name}" (${seq.length} pieces) ===`);
  console.log('  #  piece            x      z      y     head°');
  const waypt = (i, label) => {
    const p = new THREE.Vector3().setFromMatrixPosition(cursor);
    const z = new THREE.Vector3(); cursor.extractBasis(new THREE.Vector3(), new THREE.Vector3(), z);
    const head = Math.round(Math.atan2(z.x, z.z) * 180 / Math.PI);
    console.log(`  ${String(i).padStart(2)} ${label.padEnd(14)} ${String(r2(p.x)).padStart(6)} ${String(r2(p.z)).padStart(6)} ${String(r2(p.y)).padStart(6)} ${String(head).padStart(6)}`);
  };
  waypt(-1, 'start');
  seq.forEach((k, i) => {
    const spec = PIECES[k]();
    const place = cursor.clone().multiply(tmp.copy(spec.entry).invert());
    cursor = place.clone().multiply(spec.exit);
    waypt(i, k);
  });

  // ---- full build: closure + crossings on the real (scaled) centerline ----
  const t = buildTrack(seq, { startGate: false });
  console.log(`\nclosed=${t.closed} gap=${t.gap.toFixed(3)} length=${t.length.toFixed(1)}`);

  const found = selfCrossings(t);
  console.log(`\nself-crossings (XZ): ${found.length}`);
  for (const f of found) {
    console.log(`  segs ${f.i}↔${f.j} at (${r2(f.x)}, ${r2(f.z)})  Δy=${r2(f.dy)} angle=${Math.round(f.angle)}°  (y1=${r2(f.y1)}, y2=${r2(f.y2)})`);
  }
  // World clearance hint: road slab ≈ 0.6 world thick; a toy car ≈ 0.8 world tall.
  console.log('\n(target Δy for an overpass: > ~1.4 world so a car clears under the deck)');
})();
