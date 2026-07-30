'use strict';
// Every flat decal painted on the deck must stay UNDER the deck's own mesh.
//
// The road is swept as rings ~0.24u apart and is a CHORD between them; each
// decal is likewise a chord mesh at its own vertex spacing, and where a decal
// sags further from the true surface than the road does, the road stands above
// it and pokes through. The decal's small lift is the whole budget for that.
//
// WHY THIS TEST EXISTS. buildOils built a 2u slick from ONE hoisted frameAt, so
// it was a flat plane on a bending deck — 0.175u out on a loop against a 0.012
// lift. Every existing gate passed: the shipped furniture happens to sit on flat
// ground, so nothing rendered wrong, and 11.3% of lap positions were one
// furniture reshuffle away from showing asphalt through the middle of a slick.
// That is the shape of bug this catches — latent, invisible, and armed.
//
// WHAT IT COSTS AND WHY IT IS CHEAP. Sweeping every metre of the catalogue is
// ~17 s of CPU. Failure only happens at curvature extremes, so this tests the
// most convex and most concave features of each track instead: conformed decals
// fail on CONVEX ground (chords sagging below a crest), flat ones on CONCAVE
// (ground rising above their plane). Both signs, ~2 s.
//
// THE MODEL IS MIRRORED, NOT READ. TtpRenderer.cpp needs the Filament SDK, so no
// ctest can reach the real geometry and scripts/decal-conform-audit.mjs rebuilds
// each decal's tessellation in JS. The first test is what keeps that honest: the
// renderer constants the audit copied are pinned back to the lines they came
// from, so changing a lift or a segment count in C++ fails here rather than
// silently invalidating the audit. If that test fails after a renderer edit,
// update the audit script in the same commit.

const test = require('node:test');
const assert = require('node:assert/strict');

let A, buildTrack, CONFORMED;
test.before(async () => {
  A = await import('../scripts/decal-conform-audit.mjs');
  const nt = await import('../scripts/native-track.mjs');
  await nt.init();
  buildTrack = nt.buildTrack;
  // Every conformed on-deck decal. The boost disk is sized at FULL boost, which
  // is its worst case: outerR grows with boostMul and reaches ~1.56u at k=0.6.
  CONFORMED = {
    'pad-disc': A.DECALS.padDisc,
    oil: A.DECALS.oil,
    'box-blob': A.DECALS.boxBlob,
    'boost-disk': (s, lat) => A.DECALS.boostDisk(s, lat, A.diskOuterR(0.6)),
    'car-blob': A.DECALS.carBlob,
  };
});

test('the audit still describes the renderer it mirrors', () => {
  const { ok, missing } = A.verifyMirrors();
  assert.ok(ok, 'these constants moved in TtpRenderer.cpp but not in '
    + `scripts/decal-conform-audit.mjs:\n  ${missing.map((m) => `${m.name}: ${m.find}`).join('\n  ')}`);
  assert.ok(A.MIRRORED.length >= 19, 'the mirror lost entries');
});

test('shipped furniture clears the deck on every catalogue track', () => {
  for (const id of A.TRACKS) {
    const t = buildTrack(id);
    for (const d of A.measure(id, t.length, A.shippedDecals(t))) {
      assert.ok(d.pen < 0,
        `${id}: ${d.kind} at s=${d.penAt.toFixed(1)} has the deck ${d.pen.toFixed(4)}u `
        + `above it (lift ${d.lift})`);
      // A decal eating most of its lift is not yet wrong but is one furniture
      // move from it — that is exactly how the flat oil slick hid for so long.
      assert.ok(-d.pen > d.lift * 0.35,
        `${id}: ${d.kind} at s=${d.penAt.toFixed(1)} clears by only ${(-d.pen).toFixed(4)}u `
        + `of its ${d.lift} lift — too little headroom, check its tessellation`);
    }
  }
});

// One measure() per TRACK, not per (track, kind): every kind is probed at the
// same arclengths, so they share almost all of their frame lookups. Lateral
// offset is 0.7 (where the furniture actually sits); sweeping lat 0 as well
// shifts the worst case by at most 0.0013u, with neither offset consistently
// worse, so it is not worth doubling the run.
test('every decal kind clears the deck at each track\'s curvature extremes', () => {
  for (const id of A.TRACKS) {
    const t = buildTrack(id);
    const { convex, concave } = A.extremeCurvaturePositions(id, 6);
    const items = [];
    for (const make of Object.values(CONFORMED)) {
      for (const s of [...convex, ...concave]) items.push(make(s, 0.7));
    }
    for (const d of A.measure(id, t.length, items, A.COARSE)) {
      assert.ok(d.pen < 0,
        `${id}: a ${d.kind} at s=${d.penAt.toFixed(1)} would have the deck `
        + `${d.pen.toFixed(4)}u above it (lift ${d.lift}) — its chords are too `
        + 'long for this curvature');
    }
  }
});

// The negative control, and the reason to trust the two tests above: the exact
// pre-2026-07-30 slick — one hoisted frame, flat in its tangent plane — must
// still be caught. A gate that cannot go red has proved nothing by staying green.
test('the retired flat slick is still detected as broken', () => {
  let worst = -Infinity, caught = 0, tried = 0;
  for (const id of A.TRACKS) {
    const t = buildTrack(id);
    const { concave } = A.extremeCurvaturePositions(id, 6);
    const items = concave.map((s) => A.DECALS.oilFlat(s, 0.7));
    tried += items.length;
    for (const d of A.measure(id, t.length, items, A.COARSE)) {
      if (d.pen > 0) caught++;
      worst = Math.max(worst, d.pen);
    }
  }
  assert.ok(caught > tried * 0.5,
    `the flat slick should fail at most concave extremes, caught only ${caught}/${tried}`);
  assert.ok(worst > 0.05,
    `the flat slick's worst penetration should be severe, got ${worst.toFixed(4)}`);
});
