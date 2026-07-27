'use strict';
// The native track builder, as Node reaches it (scripts/native-track.mjs over
// the shipped wasm) — the ONLY builder now that public/display/TrackBuilder.js
// is gone.
//
// WHY THIS SUITE EXISTS. There are two ways a track descriptor becomes a
// TrackDef, and they are written in different languages at different times:
//
//   BUILD TIME  scripts/gen-track-defs-header.mjs bakes the shipped catalogue
//               into native/libttp-track/generated/track_defs.h.
//   RUN TIME    ttp_track_build_json parses a descriptor the authoring tools
//               hand it, for layouts that are not shipped yet.
//
// Nothing else compares them. If they read one field differently — a missing
// `radius` that means "derive from road width" rather than 0, an `over: false`,
// a `[a,b]` width taper — then a track measures one way in the tool that
// authored it and builds another way in the game, and every gate in the tree
// still passes, because each half is self-consistent. So the first test below
// builds every catalogue track BOTH ways and demands identical bytes.
//
// The second half pins the presence rules themselves, since "identical to the
// other reader" is only worth something if at least one of them is right.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');

const skip = fs.existsSync(MJS) && fs.existsSync(WASM)
  ? false
  : 'ttp_runtime.mjs/.wasm not built — run native/scripts/build-runtime-web.sh';

let buildTrack, TRACKS, DEV_TRACKS;
test.before(async () => {
  if (skip) return;
  const nt = await import('../scripts/native-track.mjs');
  await nt.init();
  buildTrack = nt.buildTrack;
  ({ TRACKS } = await import('../public/shared/tracks.js'));
  ({ DEV_TRACKS } = await import('../public/shared/devTracks.js'));
});

test('every catalogue track builds identically from its ID and from its descriptor',
  { skip }, async () => {
    // The ID path runs the codegen'd TrackDef; the descriptor path runs the
    // runtime parser over the same authored JS. Byte identity is the only thing
    // that proves the two readers agree about every presence rule at once.
    for (const [id, desc] of Object.entries(TRACKS)) {
      const byId = buildTrack(id, { memoize: false });
      const byDesc = buildTrack({ id, ...desc }, { memoize: false });
      assert.equal(JSON.stringify(byDesc), JSON.stringify(byId),
        `${id}: the runtime descriptor parser disagrees with gen-track-defs-header.mjs`);
    }
  });

test('dev tracks build the same way too', { skip }, async () => {
  // ?solo&track=gym is a real surface, and it resolves through the same lookup.
  for (const [id, desc] of Object.entries(DEV_TRACKS)) {
    const byId = buildTrack(id, { memoize: false });
    const byDesc = buildTrack({ id, ...desc }, { memoize: false });
    assert.equal(JSON.stringify(byDesc), JSON.stringify(byId), `${id}`);
  }
});

test('a built track carries the whole race-track contract', { skip }, async () => {
  const t = buildTrack('tidepool');
  const schema = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'docs/native-port/contract/race-track.schema.json'), 'utf8'));
  // `cup` is the host's tag on a built track (which biome to theme it with), not
  // something the builder produces — the frozen corpus does not carry it either.
  const want = Object.keys(schema.properties).filter((k) => k !== 'cup').sort();
  assert.deepEqual(Object.keys(t).sort(), want);
  assert.ok(t.centerline.samples.length > 100, 'a full circuit is finely sampled');
  assert.ok(t.length > 0);
  assert.equal(t.trackId, 'tidepool');
});

test('laps and seed are stamped, and reach no geometry', { skip }, async () => {
  const a = buildTrack('cove', { laps: 3, seed: 1, memoize: false });
  const b = buildTrack('cove', { laps: 9, seed: 12345, memoize: false });
  assert.equal(b.totalLaps, 9);
  assert.equal(b.seed, 12345);
  // Everything else must be untouched: the renderer builds its scene without
  // knowing either, on the strength of exactly this.
  const strip = (t) => { const c = { ...t }; delete c.totalLaps; delete c.seed; return JSON.stringify(c); };
  assert.equal(strip(a), strip(b), 'geometry moved with laps/seed');
});

test('a bare segment array builds, like the JS builder accepted', { skip }, async () => {
  const oval = [
    { kind: 'straight', length: 20 }, { kind: 'arc', radius: 5, angle: 180 },
    { kind: 'straight', length: 20 }, { kind: 'arc', radius: 5, angle: 180 }
  ];
  const fromArray = buildTrack(oval, { memoize: false });
  const fromDesc = buildTrack({ segments: oval }, { memoize: false });
  assert.equal(JSON.stringify(fromArray), JSON.stringify(fromDesc));
  assert.ok(fromArray.length > 0);
});

// ---- the presence rules, pinned -------------------------------------------
// Each of these is a case where ABSENT and ZERO mean different things. They are
// the rules gen-track-defs-header.mjs documents; this is the run-time reader
// being held to them directly rather than only relative to the codegen.

test('an absent furniture radius is DERIVED, not zero', { skip }, async () => {
  const segs = [{ kind: 'straight', length: 20 }, { kind: 'arc', radius: 5, angle: 180 },
                { kind: 'straight', length: 20 }, { kind: 'arc', radius: 5, angle: 180 }];
  const bare = buildTrack({ segments: segs, boxes: [{ u: 0.5 }] }, { memoize: false });
  const zero = buildTrack({ segments: segs, boxes: [{ u: 0.5, radius: 0 }] }, { memoize: false });
  assert.ok(bare.boxes[0].radius > 0, 'an omitted radius falls back to a fraction of the road width');
  assert.equal(zero.boxes[0].radius, 0, 'an explicit 0 radius stays 0');
});

test('a [a,b] segment width tapers, a number is flat, absent is the track width',
  { skip }, async () => {
    // Judged over the WHOLE ring, not a prefix: finalizeTrack rotates the samples
    // so s=0 lands on the start line, so samples[0] is not the first segment.
    const close = [{ kind: 'arc', radius: 5, angle: 180 }, { kind: 'straight', length: 20 },
                   { kind: 'arc', radius: 5, angle: 180 }];
    const widths = async (first) => {
      const t = buildTrack({ segments: [first, ...close] }, { memoize: false });
      return [...new Set(t.centerline.samples.map((s) => s.width))].sort((a, b) => a - b);
    };
    // Authored widths are PLAN units; the builder scales plan→world by 2.
    const dflt = await widths({ kind: 'straight', length: 20 });
    assert.deepEqual(dflt, [5], 'no authored width anywhere == one width, the track default');

    const flat = await widths({ kind: 'straight', length: 20, width: 2 });
    assert.equal(flat[0], 4, 'a scalar width: the segment sits at exactly 2×2');
    assert.equal(flat[flat.length - 1], 5, '…and the rest of the ring at the default');

    const taper = await widths({ kind: 'straight', length: 20, width: [2, 3] });
    // Near 2×2 rather than exactly it: no sample lands precisely on the ramp's
    // first point, unlike the scalar case where the whole segment is one value.
    assert.ok(taper[0] > 4 && taper[0] < 4.2, `a taper starts near its first endpoint (${taper[0]})`);
    // A ramp between 4 and 6 with the default 5 in the middle — many distinct
    // widths, where a scalar produces only the handful the blend to its
    // neighbours needs.
    assert.ok(taper.length > flat.length * 4,
      `a [a,b] width sweeps continuously (${taper.length} widths vs ${flat.length} for a scalar)`);
    assert.ok(taper[taper.length - 1] > 5, 'and reaches past the default toward 2×3');
  });

test('segment `over` defaults to true and only an explicit false flips it', { skip }, async () => {
  const loop = (over) => ({
    segments: [{ kind: 'straight', length: 20 },
               { kind: 'loop', radius: 2.2, roll: 52, ...(over === undefined ? {} : { over }) },
               { kind: 'arc', radius: 5, angle: 180 }, { kind: 'straight', length: 20 },
               { kind: 'arc', radius: 5, angle: 180 }]
  });
  const dflt = buildTrack(loop(undefined), { memoize: false });
  const yes = buildTrack(loop(true), { memoize: false });
  const no = buildTrack(loop(false), { memoize: false });
  assert.equal(JSON.stringify(dflt), JSON.stringify(yes), 'absent `over` == over: true');
  assert.notEqual(JSON.stringify(no), JSON.stringify(yes), 'over: false builds a different loop');
});

test('a malformed descriptor is refused, not half-read', { skip }, async () => {
  const bad = [
    [{}, 'neither segments nor waypoints'],
    [{ segments: [], waypoints: [] }, 'both, and both empty'],
    [{ segments: [{ kind: 'straight', length: 5 }], waypoints: [{ x: 0, z: 0 }] }, 'both'],
    [{ segments: [{ kind: 'corkscrew', length: 5 }] }, 'unknown segment kind'],
    [{ waypoints: [{ x: 1 }] }, 'waypoint missing z'],
    [{ segments: [{ kind: 'straight', length: 5 }], boxes: [{ lat: 0 }] }, 'furniture missing u']
  ];
  for (const [desc, why] of bad) {
    assert.throws(() => buildTrack(desc, { memoize: false }),
      /refused this descriptor|expected a descriptor/, `should refuse: ${why}`);
  }
});
