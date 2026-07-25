// The shipped wasm must be the CURRENT wasm.
//
// public/display/engine/native/ttp_runtime.{mjs,wasm} are checked in and the game
// is native-only, so those bytes ARE the engine in every browser and in the
// no-build preview deploy. Nothing about editing native/ forces a rebuild, and the
// two suites that could have noticed look the other way: native ctest replays the
// C++ SOURCES, tests/{runtime,party}-abi.test.js exercise the ARTIFACT. Green on
// both is compatible with shipping an engine that conformance never saw.
//
// So the build script stamps which sources it built from, and this test checks it.
// Failure means: run native/scripts/build-runtime-web.sh and commit the result.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NATIVE_DIR = path.join(ROOT, 'public/display/engine/native');
const STAMP = path.join(NATIVE_DIR, 'BUILD_STAMP.json');
const REBUILD = 'run native/scripts/build-runtime-web.sh and commit the artifacts';

test('the checked-in native runtime artifacts exist', () => {
  for (const f of ['ttp_runtime.mjs', 'ttp_runtime.wasm', 'BUILD_STAMP.json']) {
    assert.ok(fs.existsSync(path.join(NATIVE_DIR, f)), `missing ${f} — ${REBUILD}`);
  }
});

test('the checked-in native runtime was built from the current native/ sources', async () => {
  const { runtimeSourceHash } = await import('../native/scripts/runtime-source-hash.mjs');
  const stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  const actual = runtimeSourceHash(ROOT);
  assert.strictEqual(
    stamp.sourceHash, actual,
    `public/display/engine/native/ttp_runtime.wasm is STALE: native/ sources hash to\n` +
    `  ${actual}\nbut the artifacts were built from\n  ${stamp.sourceHash}\n` +
    `The game loads the artifact, so this is shipping an engine the conformance ` +
    `suite never ran. Fix: ${REBUILD}.`
  );
});
