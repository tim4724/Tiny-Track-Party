'use strict';
// Probe a piece sequence: print the NET transform (where the cursor ends up
// relative to the start) so loops/circuits can be designed to close. Also builds
// the full track and reports closure gap, height range, and whether the ribbon
// inverts (loop-the-loop). Usage: node scripts/probe-track.js
(async () => {
  const THREE = await import('three');
  const { PIECES, buildTrack, TRACKS } = await import('../public/display/TrackBuilder.js');

  // Replicate buildTrack's connector chaining (no scale/overlap) to get the net
  // entry→exit transform of a sub-sequence. NOTE: this mirrors the chaining in
  // TrackBuilder.buildTrack — if that changes (e.g. overlap handling), update here
  // too, or the reported net transforms will silently drift from the real track.
  function net(keys) {
    let cursor = new THREE.Matrix4();
    const tmpInv = new THREE.Matrix4();
    for (const k of keys) {
      const spec = PIECES[k]();
      const place = cursor.clone().multiply(tmpInv.copy(spec.entry).invert());
      cursor = place.clone().multiply(spec.exit);
    }
    const pos = new THREE.Vector3().setFromMatrixPosition(cursor);
    const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
    cursor.extractBasis(x, y, z);
    const r3 = (v) => v.toArray().map((n) => +n.toFixed(2));
    return { pos: r3(pos), fwd: r3(z), up: r3(y), lat: r3(x) };
  }

  const show = (label, keys) => console.log(label.padEnd(22), JSON.stringify(net(keys)));
  console.log('--- net transforms (local connector space, +Z travel, +Y up) ---');
  show('bend x1', ['bend']);
  show('bend x2 (half loop)', ['bend', 'bend']);
  show('bend x4 (planar loop)', ['bend', 'bend', 'bend', 'bend']);
  show('curve@top (2+2)', ['bend', 'bend', 'curve', 'bend', 'bend']);
  show('curve@up (1+3)', ['bend', 'curve', 'bend', 'bend', 'bend']);
  show('curve@down (3+1)', ['bend', 'bend', 'bend', 'curve', 'bend']);
  show('curveR@top (2+2)', ['bend', 'bend', 'curveR', 'bend', 'bend']);
  show('LOOP+straight+curveR', ['bend', 'bend', 'curve', 'bend', 'bend', 'straight', 'curveR']);
  show('hillUp', ['hillUp']);
  show('hillDown', ['hillDown']);
  show('bumpUp', ['bumpUp']);
  show('rampUp+rampDown', ['rampCornerUp', 'rampCornerDown']);
  show('cornerL+cornerR', ['cornerL', 'cornerR']);
  show('curve (flat)', ['curve']);
  show('straight', ['straight']);

  for (const name of Object.keys(TRACKS)) {
    const def = TRACKS[name];
    const t = buildTrack(def);
    let inv = 0;
    for (const s of t.centerline.samples) inv = Math.min(inv, s.up.y);
    console.log(`\nTRACK "${name}" (${def.name}): pieces=${def.pieces.length} closed=${t.closed} gap=${t.gap.toFixed(3)} ` +
      `len=${t.length.toFixed(1)} minUpY=${inv.toFixed(2)} (${inv < -0.5 ? 'INVERTS ✓' : 'no inversion'})`);
  }
})();
