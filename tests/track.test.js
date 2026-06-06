'use strict';
// Headless verification of the track geometry: a reference oval must close into a
// seamless loop, and the centerline must be a sane, monotonic ribbon.
const test = require('node:test');
const assert = require('node:assert/strict');

// TrackBuilder is an ES module importing 'three'; load it dynamically.
let buildTrack, TRACKS, TRACK_LIST, trackSchematic, TRACK_SCHEMATICS;
test.before(async () => {
  const mod = await import('../public/display/TrackBuilder.js');
  buildTrack = mod.buildTrack;
  TRACKS = mod.TRACKS;
  TRACK_LIST = mod.TRACK_LIST;
  trackSchematic = (await import('../public/display/trackSchematic.js')).trackSchematic;
  TRACK_SCHEMATICS = (await import('../public/shared/trackSchematics.js')).TRACK_SCHEMATICS;
});

// Reference fixtures for the detailed geometry suites — kept here, NOT in the
// shipped catalogue, so the game's track list and these invariants evolve
// independently (cf. engine.test.js's private TEST_OVAL). They exercise properties
// no current catalogue track does: OVAL is the only all-same-hand loop with NO
// chicane, so its curvature never legitimately reverses (the "curvature never
// abruptly reverses" check); GRAND_TOUR is a flat-closing rectangle that is hills
// end-to-end (the elevation / orthonormal-frame / seam-holonomy checks).
// Parametric segment DSL (local, since this CommonJS test can't import the ES-module
// helpers at module-eval time). angle>0 = LEFT turn.
const L = 4.0, RL = 4.185;
const straight = (length, opts = {}) => ({ kind: 'straight', length, ...opts });
const arc = (radius, angle, opts = {}) => ({ kind: 'arc', radius, angle, ...opts });
const run = (n, opts) => Array.from({ length: n }, () => straight(L, opts));
// OVAL: a 12/5/12/5 rectangle, all-LEFT sweeping corners — the only no-chicane loop, so
// its curvature never legitimately reverses (the curvature-reversal check below).
const OVAL = [
  ...run(12), arc(RL, 90), ...run(5), arc(RL, 90),
  ...run(12), arc(RL, 90), ...run(5), arc(RL, 90)
];
// GRAND_TOUR: a flat-closing 9/7/9/7 rectangle that is hills/bumps end-to-end (the
// elevation / orthonormal-frame / seam-holonomy checks). Net-flat (each rise paired).
const GRAND_TOUR = [
  straight(L), straight(L, { rise: 1 }), straight(L, { rise: -1 }), straight(L, { bump: 0.5 }), straight(L, { bump: -0.5 }), straight(L, { rise: 0.5 }), straight(L, { rise: -0.5 }),
  straight(L), straight(L), arc(RL, 90),
  straight(L), straight(L, { rise: 0.5 }), straight(L, { rise: -0.5 }), straight(L, { bump: 0.5 }), straight(L, { bump: -0.5 }), straight(L), straight(L), arc(RL, 90),
  straight(L), straight(L, { rise: 1 }), straight(L, { rise: -1 }), straight(L, { bump: 0.5 }), straight(L, { bump: -0.5 }), straight(L, { rise: 0.5 }), straight(L, { rise: -0.5 }),
  straight(L), straight(L), arc(RL, 90),
  straight(L, { rise: 0.5 }), straight(L, { rise: -0.5 }), straight(L, { bump: 0.5 }), straight(L, { bump: -0.5 }), straight(L), straight(L), straight(L), arc(RL, 90)
];

test('oval closes into a loop', () => {
  const t = buildTrack(OVAL);
  assert.ok(t.closed, `oval should close (gap=${t.gap.toFixed(3)})`);
  assert.ok(t.gap < 0.5, `closure gap too large: ${t.gap}`);
});

test('centerline is a non-trivial closed ribbon', () => {
  const t = buildTrack(OVAL);
  assert.ok(t.length > 30, `track length looks too short: ${t.length}`);
  assert.ok(t.centerline.samples.length > 40, 'too few centerline samples');
  // arclength strictly increasing
  const s = t.centerline.samples.map((p) => p.s);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1], 'arclength not monotonic');
});

test('centerline never steps backward at joints (no hiccup)', () => {
  const t = buildTrack(OVAL);
  const pts = t.centerline.samples.map((p) => p.pos);
  const n = pts.length;
  let worst = 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    const d1 = b.clone().sub(a).normalize();
    const d2 = c.clone().sub(b).normalize();
    worst = Math.min(worst, d1.dot(d2));
  }
  // adjacent segments must point roughly the same way; a back-step would be ~ -1
  assert.ok(worst > 0.3, `centerline reverses at a joint (worst seg dot=${worst.toFixed(2)})`);
});

test('centerline has no degenerate-short segments (no twitch entering curves)', () => {
  const t = buildTrack(OVAL);
  const pts = t.centerline.samples.map((p) => p.pos);
  const n = pts.length;
  let minSeg = Infinity;
  for (let i = 0; i < n; i++) minSeg = Math.min(minSeg, pts[i].distanceTo(pts[(i + 1) % n]));
  // A few-cm stub at a joint or the closure seam gets crossed in one frame and
  // snaps the car's tangent — the twitch. Every intended spacing is >= ~0.43.
  assert.ok(minSeg > 0.2, `centerline has a degenerate-short segment (min=${minSeg.toFixed(3)})`);
});

test('centerline tangent turns smoothly (bounded per-unit heading change)', () => {
  const t = buildTrack(OVAL);
  const cl = t.centerline;
  const STEP = 0.1;
  let prev = Math.atan2(cl.sampleAt(0).tangent.x, cl.sampleAt(0).tangent.z);
  let worst = 0;
  for (let s = STEP; s <= cl.length; s += STEP) {
    const f = cl.sampleAt(s);
    const h = Math.atan2(f.tangent.x, f.tangent.z);
    let dh = h - prev;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    worst = Math.max(worst, Math.abs(dh));
    prev = h;
  }
  // Steady large-corner turn is ~0.012 rad / 0.1 unit; the old joint stub spiked
  // to ~0.106 (a visible snap). Bound it well under that.
  assert.ok(worst < 0.08, `tangent turns too sharply in one step (worst=${worst.toFixed(4)} rad)`);
});

test('curvature never abruptly reverses (no jitter entering curves)', () => {
  const t = buildTrack(OVAL);
  const cl = t.centerline;
  const ds = 0.1;
  let prevH = Math.atan2(cl.sampleAt(0).tangent.x, cl.sampleAt(0).tangent.z);
  let prevK = 0, flips = 0;
  for (let s = ds; s <= cl.length; s += ds) {
    const f = cl.sampleAt(s);
    const h = Math.atan2(f.tangent.x, f.tangent.z);
    let dh = h - prevH;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const k = dh / ds; // signed curvature (rad / unit)
    // A spline overshooting the curvature step at a joint flips from a clear turn
    // one way to a clear turn the other within a step — the car gets nudged the
    // wrong way then snaps back. On a smooth path curvature only crosses zero
    // gradually (through ~0), never between two significant opposite magnitudes.
    if (Math.sign(k) !== Math.sign(prevK) && Math.abs(k) > 0.01 && Math.abs(prevK) > 0.01) flips++;
    prevK = k;
    prevH = h;
  }
  assert.equal(flips, 0, `curvature reverses abruptly ${flips}x (overshoot at a joint)`);
});

test('position interpolation matches the tangent (no shimmy in curves)', () => {
  const t = buildTrack(OVAL);
  const cl = t.centerline;
  const ds = 0.05;
  let worst = 0, prev = cl.sampleAt(0).pos;
  for (let s = ds; s <= cl.length; s += ds) {
    const f = cl.sampleAt(s);
    const move = f.pos.clone().sub(prev);
    if (move.length() > 1e-6) {
      // angle between the actual direction of travel and the reported tangent
      const cos = move.normalize().dot(f.tangent);
      worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, cos))));
    }
    prev = f.pos;
  }
  // Linear interpolation made the path facet, so travel direction diverged from
  // the (smooth) facing by ~1-2° between vertices. The spline path keeps them
  // aligned to well under a degree.
  assert.ok(worst < 0.02, `path direction diverges from tangent (worst=${(worst * 180 / Math.PI).toFixed(2)}deg)`);
});

test('sampleAt wraps and returns oriented frames', () => {
  const t = buildTrack(OVAL);
  const a = t.centerline.sampleAt(0);
  const b = t.centerline.sampleAt(t.length + 5); // wraps
  const c = t.centerline.sampleAt(5);
  assert.ok(Math.abs(b.pos.x - c.pos.x) < 1e-6 && Math.abs(b.pos.z - c.pos.z) < 1e-6, 'wrap mismatch');
  // tangent and lateral roughly perpendicular, both ~horizontal
  assert.ok(Math.abs(a.tangent.dot(a.lateral)) < 1e-3, 'tangent/lateral not perpendicular');
  assert.ok(Math.abs(a.tangent.y) < 0.2, 'flat track tangent should be ~horizontal');
});

// ---- Grand Tour fixture: a flat-closing rectangle that is hills end-to-end ----

test('grand tour closes into a loop', () => {
  const t = buildTrack(GRAND_TOUR);
  assert.ok(t.closed, `grand tour should close (gap=${t.gap.toFixed(3)})`);
});

test('grand tour has elevation (hills) but stays upright (no inversion)', () => {
  const t = buildTrack(GRAND_TOUR);
  let minUpY = 1, maxY = -Infinity, minY = Infinity;
  for (const s of t.centerline.samples) {
    minUpY = Math.min(minUpY, s.up.y);
    maxY = Math.max(maxY, s.pos.y); minY = Math.min(minY, s.pos.y);
  }
  assert.ok(minUpY > 0.5, `track should stay upright (minUpY=${minUpY.toFixed(2)})`);
  assert.ok(maxY - minY > 1.5, `track should have real elevation change (range=${(maxY - minY).toFixed(1)})`);
});

test('grand tour frames stay orthonormal (up ⟂ tangent everywhere)', () => {
  const t = buildTrack(GRAND_TOUR);
  let worstDot = 0, worstLen = 0;
  for (const sm of t.centerline.samples) {
    worstDot = Math.max(worstDot, Math.abs(sm.tangent.dot(sm.up)));
    worstLen = Math.max(worstLen, Math.abs(sm.up.length() - 1));
  }
  assert.ok(worstDot < 1e-3, `up not perpendicular to tangent (worst dot=${worstDot.toFixed(4)})`);
  assert.ok(worstLen < 1e-3, `up not unit length (worst=${worstLen.toFixed(4)})`);
});

test('grand tour up returns to vertical at the start/finish seam (no twist jump)', () => {
  const t = buildTrack(GRAND_TOUR);
  // The lap should resolve the rotation-minimizing frame's holonomy: the up at
  // the seam (sample 0) and just before it must agree, both ~vertical on the
  // flat start straight.
  const s0 = t.centerline.samples[0];
  const sN = t.centerline.samples[t.centerline.samples.length - 1];
  assert.ok(s0.up.y > 0.95, `start/finish up should be ~vertical (got ${s0.up.y.toFixed(2)})`);
  assert.ok(sN.up.dot(s0.up) > 0.9, `up jumps across the seam (dot=${sN.up.dot(s0.up).toFixed(2)})`);
});

test('grand tour centerline never steps backward (continuous through the loop)', () => {
  const t = buildTrack(GRAND_TOUR);
  const pts = t.centerline.samples.map((p) => p.pos);
  const n = pts.length;
  let worst = 1, minSeg = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    worst = Math.min(worst, b.clone().sub(a).normalize().dot(c.clone().sub(b).normalize()));
    minSeg = Math.min(minSeg, a.distanceTo(b));
  }
  assert.ok(worst > 0, `centerline reverses somewhere (worst seg dot=${worst.toFixed(2)})`);
  assert.ok(minSeg > 0.2, `degenerate-short segment (min=${minSeg.toFixed(3)})`);
});

test('every named track closes and includes a start gate', () => {
  for (const [name, def] of Object.entries(TRACKS)) {
    const t = buildTrack(def);
    assert.ok(t.closed, `track "${name}" should close (gap=${t.gap.toFixed(3)})`);
    assert.ok(t.instances.some((i) => i.glb === 'gate-finish'), `track "${name}" missing start gate`);
  }
});

test('every named track has a display name and segments', () => {
  for (const [name, def] of Object.entries(TRACKS)) {
    assert.ok(typeof def.name === 'string' && def.name.length, `track "${name}" missing name`);
    assert.ok(Array.isArray(def.segments) && def.segments.length, `track "${name}" missing segments`);
  }
});

// The precomputed schematics (shared/trackSchematics.js — used by the no-relay
// gallery preview) must match what the live geometry produces, or the preview
// shows stale maps. trackSchematic is deterministic, so a freshly-built track
// reproduces the committed SVG exactly; if it doesn't, the generator wasn't re-run.
test('TRACK_SCHEMATICS is in sync with the track geometry', () => {
  assert.equal(Object.keys(TRACK_SCHEMATICS).length, TRACK_LIST.length,
    'TRACK_SCHEMATICS has a different track count than the catalogue — regenerate: node scripts/gen-track-schematics.js');
  for (const t of TRACK_LIST) {
    assert.deepEqual(TRACK_SCHEMATICS[t.id], trackSchematic(buildTrack(t.segments)),
      `schematic for "${t.id}" is stale — regenerate: node scripts/gen-track-schematics.js`);
  }
});

// The detailed quality suite (above) runs on the oval; re-check the things most
// likely to break when a NEW track combines pieces in a new way — a centerline
// that steps backward at a joint, a degenerate-short stub that snaps the car's
// tangent, or a too-sharp joint — across every named track.
//
// NB: the oval-only "curvature never abruptly reverses" check is deliberately NOT
// generalised here. A chicane (curve→curveR) is an S-bend: its curvature reverses
// sign by design, so slalom/switchback/riverside legitimately "flip". The bounded
// per-unit tangent step below is shape-agnostic — it catches a sharp joint without
// flagging an intentional weave (steady tight corner ≈ 0.023 rad/0.1u, chicane
// transitions peak ≈ 0.056, all well under the 0.08 bound).
test('every named track has a clean centerline (no backstep, no stubs, no sharp joints)', () => {
  for (const [name, def] of Object.entries(TRACKS)) {
    const cl = buildTrack(def).centerline;
    const pts = cl.samples.map((p) => p.pos);
    const n = pts.length;
    let worst = 1, minSeg = Infinity;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
      worst = Math.min(worst, b.clone().sub(a).normalize().dot(c.clone().sub(b).normalize()));
      minSeg = Math.min(minSeg, a.distanceTo(b));
    }
    assert.ok(worst > 0, `track "${name}" centerline reverses at a joint (worst seg dot=${worst.toFixed(2)})`);
    assert.ok(minSeg > 0.2, `track "${name}" has a degenerate-short segment (min=${minSeg.toFixed(3)})`);

    // Bounded per-unit heading change, sampled along the smooth centerline.
    const STEP = 0.1;
    let prev = Math.atan2(cl.sampleAt(0).tangent.x, cl.sampleAt(0).tangent.z), worstStep = 0;
    for (let s = STEP; s <= cl.length; s += STEP) {
      const f = cl.sampleAt(s);
      const h = Math.atan2(f.tangent.x, f.tangent.z);
      let dh = h - prev;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      worstStep = Math.max(worstStep, Math.abs(dh));
      prev = h;
    }
    assert.ok(worstStep < 0.08, `track "${name}" tangent turns too sharply in one step (worst=${worstStep.toFixed(4)} rad)`);
  }
});

test('buildTrack accepts a bare segment array and a descriptor alike', () => {
  const fromArray = buildTrack(TRACKS.switchback.segments);
  const fromDef = buildTrack(TRACKS.switchback);
  assert.equal(fromArray.centerline.samples.length, fromDef.centerline.samples.length);
  assert.throws(() => buildTrack({ name: 'bad' }), /descriptor with a \.segments array/);
});

test('startGate:false omits the gate', () => {
  const t = buildTrack(OVAL, { startGate: false });
  assert.ok(!t.instances.some((i) => i.glb === 'gate-finish'), 'gate should be omitted');
});

test('an unknown segment kind throws a clear error', () => {
  assert.throws(() => buildTrack([straight(L), { kind: 'definitely-not-a-kind' }]), /Unknown segment kind "definitely-not-a-kind"/);
});

// COLLISION SAFETY. A self-crossing track (e.g. Crossover) is only valid if the
// strands that meet in plan are far apart in HEIGHT — a bridge. Any two bits of
// road that are close in 3D but distant along the lap means cars from two places
// share the same space: a crash/merge, not a crossing. (This is exactly the bug
// that sank an early double-bridge "pretzel": two strands grazed at ground level,
// 0.09 apart.) Bridged crossings sit ~2.0 apart; flat tracks keep strands ≥5 apart.
test('no track has overlapping strands (every crossing is bridged)', () => {
  for (const [name, def] of Object.entries(TRACKS)) {
    const t = buildTrack(def);
    const Sm = t.centerline.samples, N = Sm.length, L = t.length;
    let min3d = Infinity, atZ = 0;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const arc = Math.min(Math.abs(Sm[i].s - Sm[j].s), L - Math.abs(Sm[i].s - Sm[j].s));
        if (arc < 6) continue; // same local stretch of road — expected to be close
        const d = Sm[i].pos.distanceTo(Sm[j].pos);
        if (d < min3d) { min3d = d; atZ = Sm[i].pos.z; }
      }
    }
    assert.ok(min3d >= 1.5, `track "${name}" has strands ${min3d.toFixed(2)} apart in 3D (overlap/unbridged crossing near z=${atZ.toFixed(0)})`);
  }
});
