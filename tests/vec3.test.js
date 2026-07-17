'use strict';
// Bit-identity gate for the vendored Vec3 (public/display/engine/Vec3.js): the
// sim's own vector must produce EXACTLY the same floats as THREE.Vector3 on
// every method it implements, or the future native port would be conformance-
// tested against drifted reference numbers. THREE is imported HERE ONLY (the
// npm copy is the same r184 as vendor/three) — the sim path itself is
// three-free, which is the point. Every assertion is exact (Object.is via
// assert.strictEqual), never approximate: if a rounding difference shows up,
// fix Vec3's operation order, do not loosen the test.
const test = require('node:test');
const assert = require('node:assert/strict');

let Vec3, THREE, mulberry32;
test.before(async () => {
  ({ Vec3 } = await import('../public/display/engine/Vec3.js'));
  THREE = await import('three');
  ({ mulberry32 } = await import('../public/display/engine/util.js'));
});

// One seeded case: the same raw floats fed to both classes.
function makeCase(rand) {
  const t = () => [
    (rand() * 2 - 1) * 20,
    (rand() * 2 - 1) * 20,
    (rand() * 2 - 1) * 20
  ];
  return { a: t(), b: t(), axis: t(), s: (rand() * 2 - 1) * 8, alpha: rand(), angle: (rand() * 2 - 1) * 2 * Math.PI };
}
const pair = (t) => [new Vec3(t[0], t[1], t[2]), new THREE.Vector3(t[0], t[1], t[2])];
function sameVec(ours, theirs, label) {
  assert.strictEqual(ours.x, theirs.x, `${label}: x`);
  assert.strictEqual(ours.y, theirs.y, `${label}: y`);
  assert.strictEqual(ours.z, theirs.z, `${label}: z`);
}

test('Vec3 matches THREE.Vector3 bit-for-bit on the whole implemented surface', () => {
  const rand = mulberry32(0xC0FFEE);
  for (let i = 0; i < 100; i++) {
    const c = makeCase(rand);
    const [vb, tb] = pair(c.b);
    const tag = (m) => `case ${i} ${m}`;

    // clone: fresh instance, same class, same components
    {
      const [va, ta] = pair(c.a);
      const vc = va.clone(), tc = ta.clone();
      assert.notStrictEqual(vc, va, tag('clone identity'));
      assert.ok(vc instanceof Vec3, tag('clone class'));
      sameVec(vc, tc, tag('clone'));
    }
    // copy: mutates in place and returns this
    {
      const [va, ta] = pair(c.a);
      assert.strictEqual(va.copy(vb), va, tag('copy returns this'));
      sameVec(va, ta.copy(tb), tag('copy'));
    }
    // simple mutators
    for (const [name, ours, theirs] of [
      ['sub', (v) => v.sub(vb), (v) => v.sub(tb)],
      ['addScaledVector', (v) => v.addScaledVector(vb, c.s), (v) => v.addScaledVector(tb, c.s)],
      ['multiplyScalar', (v) => v.multiplyScalar(c.s), (v) => v.multiplyScalar(c.s)],
      ['lerp', (v) => v.lerp(vb, c.alpha), (v) => v.lerp(tb, c.alpha)],
      ['cross', (v) => v.cross(vb), (v) => v.cross(tb)],
      ['normalize', (v) => v.normalize(), (v) => v.normalize()]
    ]) {
      const [va, ta] = pair(c.a);
      assert.strictEqual(ours(va), va, tag(`${name} returns this`));
      theirs(ta);
      sameVec(va, ta, tag(name));
    }
    // scalar-returning methods
    {
      const [va, ta] = pair(c.a);
      assert.strictEqual(va.dot(vb), ta.dot(tb), tag('dot'));
      assert.strictEqual(va.length(), ta.length(), tag('length'));
      assert.strictEqual(va.lengthSq(), ta.lengthSq(), tag('lengthSq'));
      assert.strictEqual(va.distanceTo(vb), ta.distanceTo(tb), tag('distanceTo'));
      sameVec(va, ta, tag('scalar methods must not mutate'));
    }
    // applyAxisAngle — the quaternion-composition hotspot. The axis is normalized
    // through each class's OWN normalize (parity of normalize is asserted above),
    // so both sides rotate about bit-identical unit axes.
    {
      const [va, ta] = pair(c.a);
      const [vax, tax] = pair(c.axis);
      vax.normalize(); tax.normalize();
      assert.strictEqual(va.applyAxisAngle(vax, c.angle), va, tag('applyAxisAngle returns this'));
      ta.applyAxisAngle(tax, c.angle);
      sameVec(va, ta, tag('applyAxisAngle'));
    }
    // a chained expression, exactly how the sim composes them
    {
      const [va, ta] = pair(c.a);
      const [vax, tax] = pair(c.axis);
      const vr = va.clone().sub(vb).normalize().multiplyScalar(c.s)
        .addScaledVector(vb, c.alpha).applyAxisAngle(vax.normalize(), c.angle)
        .cross(vb).lerp(vb, c.alpha);
      const tr = ta.clone().sub(tb).normalize().multiplyScalar(c.s)
        .addScaledVector(tb, c.alpha).applyAxisAngle(tax.normalize(), c.angle)
        .cross(tb).lerp(tb, c.alpha);
      sameVec(vr, tr, tag('chained'));
      sameVec(va, ta, tag('chained must not mutate the source'));
    }
  }
});

test('Vec3 edge cases: defaults, zero-length normalize guard, interop flag', () => {
  const zero = new Vec3();
  assert.deepStrictEqual({ x: zero.x, y: zero.y, z: zero.z }, { x: 0, y: 0, z: 0 }, 'default constructor is the origin');
  // THREE guards normalize with (length() || 1) — the zero vector stays zero
  sameVec(new Vec3(0, 0, 0).normalize(), new THREE.Vector3(0, 0, 0).normalize(), 'zero-vector normalize');
  // Interop flag: render-side three APIs (Matrix4.setPosition in FinishGate)
  // branch on isVector3 to read components off a frame vector.
  assert.strictEqual(Vec3.prototype.isVector3, true, 'isVector3 interop flag');
});
