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
    // wrong way then snaps back (the old jitter spiked to ~0.106). The parametric
    // arc meets a straight with a curvature STEP (0→1/R); the Catmull-Rom rounds it
    // with a tiny ≤~0.03 blip — sub-perceptual (the tangent stays C1, so the car's
    // heading never jolts). Flag only SIGNIFICANT reversals (> 0.04), not that blip.
    if (Math.sign(k) !== Math.sign(prevK) && Math.abs(k) > 0.04 && Math.abs(prevK) > 0.04) flips++;
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

test('buildTrack reports a loop mouth (arclength + width) for every loop segment', () => {
  // The display auto-places a full-width launch strip at each loop mouth (main.js reads
  // these), so every `loop` segment must surface exactly one entry, in-range and sized.
  for (const [name, def] of Object.entries(TRACKS)) {
    const t = buildTrack(def);
    const nLoops = (def.segments || []).filter((s) => s.kind === 'loop').length;
    assert.ok(Array.isArray(t.loopStarts), `track "${name}" should report loopStarts`);
    assert.equal(t.loopStarts.length, nLoops, `track "${name}": one loop mouth per loop segment`);
    for (const ls of t.loopStarts) {
      assert.ok(ls.s >= 0 && ls.s < t.length, `track "${name}" loop mouth s in [0,length) (got ${ls.s})`);
      assert.ok(ls.width > 0, `track "${name}" loop mouth carries a positive road width (got ${ls.width})`);
    }
  }
});

test('a loop-free track reports no loop mouths', () => {
  assert.deepEqual(buildTrack(OVAL).loopStarts, []);
});

test('every named track has a display name and a geometry source', () => {
  for (const [name, def] of Object.entries(TRACKS)) {
    assert.ok(typeof def.name === 'string' && def.name.length, `track "${name}" missing name`);
    const seg = Array.isArray(def.segments) && def.segments.length;
    const wp = Array.isArray(def.waypoints) && def.waypoints.length;
    assert.ok(seg || wp, `track "${name}" needs either .segments or .waypoints`);
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
    assert.deepEqual(TRACK_SCHEMATICS[t.id], trackSchematic(buildTrack(t)),
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

    // Bounded per-unit heading change, sampled along the smooth centerline. PLAN
    // heading is meaningless through the 3D stunts: near-vertical tangents (a loop
    // flips heading 180° at the apex), banked decks, high-altitude skyways, and the
    // corkscrew's flared deck — the helix legitimately swings plan heading fast even
    // where it is level (its eased entry/exit transitions). Skip near-vertical,
    // well-banked, high-altitude and flared-stunt samples and re-seed — every
    // ground-level near-flat default-width stretch (including hills/bridges, which
    // top out at 2.0) is still covered. (Flares on plain straights — Crossover,
    // Switchback — are also skipped; their heading is trivially constant anyway.)
    const STEP = 0.1;
    let prev = null, worstStep = 0;
    for (let s = 0; s <= cl.length; s += STEP) {
      const f = cl.sampleAt(s);
      if (Math.hypot(f.tangent.x, f.tangent.z) < 0.5 || f.up.y < 0.9 || f.pos.y > 2.05
        || (cl.widthAt && cl.widthAt(s) > 5.4)) { prev = null; continue; }
      const h = Math.atan2(f.tangent.x, f.tangent.z);
      if (prev != null) {
        let dh = h - prev;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        worstStep = Math.max(worstStep, Math.abs(dh));
      }
      prev = h;
    }
    assert.ok(worstStep < 0.08, `track "${name}" tangent turns too sharply in one step (worst=${worstStep.toFixed(4)} rad)`);
  }
});

test('banking: corners lean INTO the turn and stay upright', () => {
  // An all-LEFT banked oval: every corner turns the same way, so the road normal should
  // tilt consistently toward the inside. We test against the FLAT lateral (tangent × world-up)
  // rather than a per-sample curvature estimate, which is noisy at smoothed joints.
  const BANKED_OVAL = [
    ...run(8), arc(RL, 90, { bank: 10 }), ...run(4), arc(RL, 90, { bank: 10 }),
    ...run(8), arc(RL, 90, { bank: 10 }), ...run(4), arc(RL, 90, { bank: 10 })
  ];
  const t = buildTrack(BANKED_OVAL);
  assert.ok(t.closed, `banked oval should close (gap=${t.gap.toFixed(3)})`);
  const ss = t.centerline.samples;
  let minUpY = 1, checked = 0, intoTurn = 0;
  for (const s of ss) {
    minUpY = Math.min(minUpY, s.up.y);
    if (s.up.y > 0.99) continue; // only the well-banked corner samples
    // flat lateral-LEFT = tangent × world-up; for a left turn the inside is to the left,
    // so a road banked into the turn tilts `up` toward it (positive dot).
    const flx = -s.tangent.z, flz = s.tangent.x;       // (tangent × (0,1,0)).xz
    const lean = s.up.x * flx + s.up.z * flz;
    checked++;
    if (lean > 0) intoTurn++;
  }
  assert.ok(minUpY > 0.5, `banked corners stay upright (minUpY=${minUpY.toFixed(2)})`);
  assert.ok(minUpY < 0.99, 'corners should actually be banked (up tilts off vertical)');
  assert.ok(checked > 0 && intoTurn === checked, `every banked sample leans into the (left) turn (${intoTurn}/${checked})`);
});

test('variable width: a flared track widens past the default and eases back', () => {
  const t = buildTrack(TRACKS.crossover); // its spine is flared via flare(6, 3.4)
  let maxW = 0, minW = Infinity;
  for (let s = 0; s < t.length; s += 0.5) {
    const w = t.centerline.widthAt(s);
    maxW = Math.max(maxW, w); minW = Math.min(minW, w);
  }
  assert.ok(maxW > t.roadWidth + 0.5, `flare should exceed the default road width (max=${maxW.toFixed(2)}, default=${t.roadWidth})`);
  assert.ok(minW > t.roadWidth - 0.2 && minW <= t.roadWidth + 0.01, `non-flared sections stay ~default (min=${minW.toFixed(2)}, default=${t.roadWidth})`);
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

// ---- Twister: the stunt track (the segments that go 3D) — a raised bridge, the
// 450° climbing spiral, and two tilted toy loops. The loops/spiral roll the car via
// the centerline curving through space. (The bridge once corkscrewed the ribbon — a
// `roll: 360` barrel roll — removed for motion sickness; the engine handled it fine.)
// Each geometric element carries a probe-measured `roll` trim cancelling its
// transported holonomy. ----

test('twister closes and the loops genuinely invert the frame', () => {
  const t = buildTrack(TRACKS.twister);
  assert.ok(t.closed, `twister should close (gap=${t.gap.toFixed(3)})`);
  let maxY = -Infinity, inverted = 0;
  for (const sm of t.centerline.samples) {
    maxY = Math.max(maxY, sm.pos.y);
    if (sm.up.y < -0.9) inverted++; // loop tops: road faces the ground over the crest
  }
  assert.ok(maxY > 8, `loop apex should tower over the hills (maxY=${maxY.toFixed(1)} world)`);
  assert.ok(inverted > 0, 'no inverted frames found — the loop is not looping');
});

test('twister stunts carry the road sideways and over the top, edges clear of the grass', () => {
  const t = buildTrack(TRACKS.twister);
  const ss = t.centerline.samples;
  // The loops/spiral/roll all put the deck sideways somewhere; assert sideways
  // decks exist at all, and separately that the tilted loops crest at 2·radius
  // and are INVERTED over the top (a full circle, not a hop).
  let sideways = 0, top = ss[0];
  for (const sm of ss) {
    if (Math.abs(sm.up.y) < 0.2) sideways++;
    if (sm.pos.y > top.pos.y) top = sm;
  }
  assert.ok(sideways > 8, `stunts should carry the road through sideways (found ${sideways} samples)`);
  assert.ok(top.pos.y > 8, `the loop apex should crest ~8.8 world (got ${top.pos.y.toFixed(1)})`);
  assert.ok(top.up.y < -0.9, `the crest is passed inverted (up.y=${top.up.y.toFixed(2)})`);
  // Wherever the deck banks, the low road edge (pos ± lateral·half-width) must stay
  // out of the lawn. A banked ground corner's inside kerb may EMBED a few cm into
  // the grass plane (real kerbs sit in turf; groundY is 0.3 under the lowest
  // centreline point) — what this catches is a tilted deck whose edge stabs
  // genuinely UNDER the lawn, like an unraised heartline roll would (−2.5).
  for (const sm of ss) {
    const dip = Math.abs(sm.lateral.y) * sm.width / 2;
    assert.ok(sm.pos.y - dip > t.groundY - 0.15,
      `road edge dips to ${(sm.pos.y - dip).toFixed(2)} at s=${sm.s.toFixed(1)} — buried under the grass (${t.groundY.toFixed(2)})`);
  }
});

test('twister deck twist rate stays shallow everywhere (no helicoid corkscrews)', () => {
  // The signature regression test: the original heartline corkscrew twisted the
  // ribbon at ~0.31 rad/world — a rigid car could only chord it (≈36° of misfit
  // across a wheelbase, the "flat car floats on the screwed road" bug), and that
  // predated the engine's local-surface pose (cars now tilt to the helicoid under
  // them). The shipped track now peaks at ~0.085 (the loop/spiral roll trims) since
  // the barrel-roll bridge was removed; the 0.21 bound still guards the bad-old
  // corkscrew while leaving room to restore the barrel roll (~0.18 peak, flush
  // within ~10° across a wheelbase with the pose conforming).
  const t = buildTrack(TRACKS.twister);
  const ss = t.centerline.samples;
  let worst = 0, at = 0;
  for (let i = 1; i < ss.length; i++) {
    const a = ss[i - 1], b = ss[i], ds = b.s - a.s;
    if (ds <= 1e-6) continue;
    const tg = a.tangent;
    const ua = a.up.clone().addScaledVector(tg, -a.up.dot(tg)).normalize();
    const ub = b.up.clone().addScaledVector(tg, -b.up.dot(tg)).normalize();
    const ang = Math.abs(Math.atan2(ua.clone().cross(ub).dot(tg), ua.dot(ub)));
    if (ang / ds > worst) { worst = ang / ds; at = a.s; }
  }
  assert.ok(worst < 0.21, `deck twists at ${worst.toFixed(3)} rad/world near s=${at.toFixed(1)} — helicoid territory (bound 0.21)`);
});

test('twister frames stay orthonormal and resolve upright at the seam', () => {
  const t = buildTrack(TRACKS.twister);
  let worstDot = 0, worstLen = 0;
  for (const sm of t.centerline.samples) {
    worstDot = Math.max(worstDot, Math.abs(sm.tangent.dot(sm.up)));
    worstLen = Math.max(worstLen, Math.abs(sm.up.length() - 1));
  }
  assert.ok(worstDot < 1e-3, `up not perpendicular to tangent (worst dot=${worstDot.toFixed(4)})`);
  assert.ok(worstLen < 1e-3, `up not unit length (worst=${worstLen.toFixed(4)})`);
  // Every element's transported holonomy (tilted loops ±75.5°, the climbing spiral
  // ~35°) must be cancelled by its own roll trim: if the lap's twist didn't net out,
  // the seam unwind would smear the residual around the whole track and tilt the
  // grid straight.
  const ss = t.centerline.samples;
  assert.ok(ss[0].up.y > 0.95, `seam up should be ~vertical (got ${ss[0].up.y.toFixed(2)})`);
  assert.ok(ss[ss.length - 1].up.dot(ss[0].up) > 0.9, 'up twists across the seam');
});

test('twister spiral bridges over its own entrance with real clearance', () => {
  const t = buildTrack(TRACKS.twister);
  // The spiral's elevated final quarter crosses directly over its own entrance.
  // Find sample pairs sharing a plan footprint but far apart along the lap — there
  // must be a genuinely stacked stretch, and it must clear like a (tall) bridge.
  const ss = t.centerline.samples, L = t.length;
  let stacked = 0, minGap = Infinity;
  for (const a of ss) {
    if (a.pos.y > 0.01) continue; // ground strand only
    for (const b of ss) {
      const arc = Math.min(Math.abs(a.s - b.s), L - Math.abs(a.s - b.s));
      if (arc < 6) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      if (dx * dx + dz * dz > 1.0) continue; // same plan footprint
      stacked++;
      minGap = Math.min(minGap, b.pos.y - a.pos.y);
    }
  }
  assert.ok(stacked > 10, `expected a stacked crossing stretch (found ${stacked} stacked pairs)`);
  assert.ok(minGap > 3.0, `the crossing should clear the road below like a bridge (min gap=${minGap.toFixed(2)})`);
});

test('an off-centre car mid-corkscrew sits flush on the local (helicoid) surface', async () => {
  // A twisted road is a helicoid: away from the centreline the surface normal
  // pitches by atan(lat·twistRate) off the frame up. The engine's pose.up must be
  // that LOCAL normal, or a curb-running car visibly floats off / digs into the
  // twisting road (oriented to the centre frame alone it was ~50° off). No shipped
  // track sustains a heartline roll any more (Twister's stunts are geometric), so
  // exercise the engine against a private rolled fixture.
  const { Game } = await import('../public/display/engine/Game.js');
  const ROLLED = [
    ...run(4), arc(RL, 90), ...run(2), arc(RL, 90),
    straight(2), straight(12, { roll: 360 }), straight(2), arc(RL, 90), ...run(2), arc(RL, 90)
  ];
  const t = buildTrack(ROLLED, { startGate: false });
  const cl = t.centerline;
  // find a mid-roll sample: road sideways (|up.y| small) on a near-level path
  const mid = cl.samples.find((sm) => Math.abs(sm.up.y) < 0.1 && Math.abs(sm.tangent.y) < 0.35);
  assert.ok(mid, 'no mid-corkscrew sample found');
  const game = new Game(['p1'], { centerline: cl, length: t.length, roadWidth: t.roadWidth });
  const car = game.cars.get('p1');
  car.totalS = mid.s; car.lat = 1.5;
  game._recomputePoses();
  // numeric local surface normal at (s, lat): finite-difference the swept surface
  // S(s, l) = pos(s) + l·lateral(s) along s, crossed with the lateral direction
  const d = 0.4, l = 1.5;
  const at = (s) => { const f = cl.sampleAt(s); return f.pos.clone().addScaledVector(f.lateral, l); };
  const alongS = at(mid.s + d).sub(at(mid.s - d));
  const normal = cl.sampleAt(mid.s).lateral.clone().cross(alongS).normalize();
  const dot = Math.abs(normal.dot(car.pose.up));
  assert.ok(dot > 0.98, `pose.up should match the local surface normal (|dot|=${dot.toFixed(3)} ≈ ${(Math.acos(Math.min(1, dot)) * 180 / Math.PI).toFixed(1)}° off)`);
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

// ---- Grass hills (berms): raised, non-pillared road floats over the flat lawn unless
// terrain rises to meet it. buildTrack marks hill runs and lofts cross-section rings;
// bridges (pillars) and loops/banked stunts must NOT be mistaken for hills (a berm there
// would put a grass mound under a stunt or bury the road a bridge flies over). ----
test('grass hills berm raised non-pillared road, never bridges or loops', () => {
  const hillsOf = (name) => buildTrack(TRACKS[name]).hills;
  assert.ok(hillsOf('switchback').length > 0, 'switchback hills should berm');
  assert.ok(hillsOf('riverside').length > 0, 'riverside hills should berm');
  assert.equal(hillsOf('twister').length, 0, 'twister: all raised road is bridge/loop/spiral — no berms');
  assert.equal(hillsOf('crossover').length, 0, 'crossover: its only rise is a pillared bridge — no berms');
});

test('hill berms feather to the lawn at both ends and rise under the road between', () => {
  const t = buildTrack(TRACKS.riverside);
  const gy = t.groundY;
  assert.ok(t.hills.length > 0);
  for (const rings of t.hills) {
    assert.ok(rings.length >= 4, 'a hill run lofts several rings');
    // The end rings sit at lawn level so the berm emerges smoothly from flat ground. Each
    // ring carries two top corners (topL/topR) that follow the road's bank.
    const top = (r) => Math.max(r.topL, r.topR);
    assert.ok(Math.abs(rings[0].topL - gy) < 1e-9 && Math.abs(rings[0].topR - gy) < 1e-9, 'first ring feathers to the lawn');
    assert.ok(Math.abs(rings[rings.length - 1].topL - gy) < 1e-9 && Math.abs(rings[rings.length - 1].topR - gy) < 1e-9, 'last ring feathers to the lawn');
    // No corner ever dips below the lawn (clamped at groundY), and the run reaches real
    // height somewhere between its feathered ends.
    let peak = 0;
    for (const r of rings) {
      assert.ok(r.topL >= gy - 1e-9 && r.topR >= gy - 1e-9, 'berm never dips below the lawn');
      peak = Math.max(peak, top(r) - gy);
    }
    assert.ok(peak > 0.5, `berm carries real height (peak ${peak.toFixed(2)} above lawn)`);
  }
});
