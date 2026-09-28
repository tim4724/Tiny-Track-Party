// The deck's per-chunk decal caps are declared TWICE — once as a uniform array
// size in vroad.mat and once as a C++ constant that sizes the fold buffer and
// the setParameter count — and the two must agree.
//
// WHY IT IS WORTH A GATE. The failure is silent in the direction that matters.
// Raise the C++ constant alone and `setParameter(name, ptr, n)` hands Filament
// more entries than the declared array holds; lower it alone and the shader
// declares uniforms nothing ever writes, which on the weakest shell is not free
// — a dynamically-indexed uniform array on a PowerVR costs by DECLARED SIZE
// whether or not the loop runs. That is not a micro-effect: measured on a
// GE9215 over a frozen single-player race at 1280x720, one mixed 32-entry list
// cost 25.9 ms of GPU against 17.6 for the split 8+8 that ships. Nothing else
// in the tree would notice the drift — the renderer compiles on one machine
// configuration and no ctest goes near it.
//
// It checks the RULE, not two numbers: every dynamically-indexed array in
// vroad.mat has to name a C++ constant that carries its size.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAT = readFileSync(
  path.join(ROOT, 'native/renderer/materials/vroad.mat'), 'utf8');
const HDR = readFileSync(
  path.join(ROOT, 'native/renderer/src/TtpRenderer.h'), 'utf8');

/** `static constexpr int <name> = <n>;` out of the renderer header. */
const cppConst = (name) => {
  const m = HDR.match(new RegExp(`static constexpr int ${name}\\s*=\\s*(\\d+)\\s*;`));
  assert.ok(m, `TtpRenderer.h declares no ${name}`);
  return Number(m[1]);
};

/** Every `{ type : float4[N], name : X }` in vroad's parameter block. */
const matArrays = () => {
  const out = new Map();
  for (const m of MAT.matchAll(/\{\s*type\s*:\s*float4\[(\d+)\]\s*,\s*name\s*:\s*(\w+)/g)) {
    out.set(m[2], Number(m[1]));
  }
  return out;
};

// Each array in vroad, and the constant that has to size it. A new array
// belongs in this table — that is the point of the test.
// (The mask* arrays came BACK at [4] with the hybrid shadow LOD: near cars
// keep the true masked silhouette, far cars ride the carShadow texture tap.)
const OWNERS = {
  maskRect: 'kMaxMaskedDeckDecals',
  maskWPos: 'kMaxMaskedDeckDecals',
  maskWFwd: 'kMaxMaskedDeckDecals',
  maskWRight: 'kMaxMaskedDeckDecals',
  profRect: 'kMaxProfileDeckDecals',
  profColor: 'kMaxProfileDeckDecals',
  profShape: 'kMaxProfileDeckDecals',
  paintRect: 'kMaxChunkPaint',
  paintColor: 'kMaxChunkPaint',
  paintShape: 'kMaxChunkPaint',
};

test('every vroad uniform array is sized by a C++ constant', () => {
  const arrays = matArrays();
  assert.ok(arrays.size > 0, 'vroad.mat declares no float4[] parameters');
  for (const [name, size] of arrays) {
    const owner = OWNERS[name];
    assert.ok(owner,
      `vroad.mat declares float4[${size}] ${name} with no constant in this test's`
      + ' OWNERS table — add it, and make sure the C++ writes it with that bound');
    assert.equal(size, cppConst(owner),
      `vroad.mat's ${name}[${size}] disagrees with ${owner} = ${cppConst(owner)}`);
  }
});

test('the shader clamps each loop to its own declared size', () => {
  // The `min(count, N)` in each loop is what keeps a stale or hostile count
  // from indexing past the array. It has to be the DECLARED size, not a
  // number that merely happened to match when it was typed.
  const loops = [
    [/min\(materialParams\.maskCount,\s*(\d+)\)/, 'kMaxMaskedDeckDecals'],
    [/min\(materialParams\.profCount,\s*(\d+)\)/, 'kMaxProfileDeckDecals'],
    [/min\(materialParams\.paintCount,\s*(\d+)\)/, 'kMaxChunkPaint'],
  ];
  for (const [re, owner] of loops) {
    const m = MAT.match(re);
    assert.ok(m, `vroad.mat has no loop bound matching ${re}`);
    assert.equal(Number(m[1]), cppConst(owner),
      `the loop bound ${m[1]} disagrees with ${owner} = ${cppConst(owner)}`);
  }
});

test('the per-frame gather is at least as large as one chunk can take', () => {
  // mDeckDecals is the whole scene's list before any chunk sees it, and the
  // fold selects from it — so a gather smaller than a chunk's caps would drop
  // entries before the caps ever applied. It is CPU-side and costs nothing, so
  // it is simply held above the sum.
  const gather = cppConst('kMaxDeckDecals');
  const perChunk = cppConst('kMaxMaskedDeckDecals') + cppConst('kMaxProfileDeckDecals');
  assert.ok(gather >= perChunk,
    `kMaxDeckDecals ${gather} is below one chunk's ${perChunk}`);
});
