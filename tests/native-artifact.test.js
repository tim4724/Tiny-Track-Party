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
//
// The hash is over BYTES, so a comment-only edit under native/ invalidates it as
// surely as a code change does. That is deliberate — a hash that tried to see
// through comments would need a C++ lexer, and "which edits are semantically
// free" is not a question a build stamp gets to answer — but it is a surprise
// worth paying for ONCE, not once per round trip. Hence `npm run check:artifact`
// (this file alone, well under a second) and the note in the failure below:
// batch the whole native/ edit, then rebuild.

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

test('the checked-in native runtime was built against the pinned Filament', () => {
  const stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  const pin = fs.readFileSync(path.join(ROOT, 'native/filament.pin'), 'utf8')
    .match(/^FILAMENT_COMMIT=([0-9a-f]{40})$/m)?.[1];
  assert.ok(pin, 'native/filament.pin has no FILAMENT_COMMIT line');
  assert.strictEqual(
    stamp.filament, pin,
    `MIXED-TOOLCHAIN artifact: native/filament.pin pins Filament ${pin}\n` +
    `but the checked-in wasm + .filamat blobs were built against ` +
    `${stamp.filament}.\n` +
    `The .filamat blobs are MATERIAL_VERSION-locked to the Filament tree, so a ` +
    `runtime/materials mismatch fails at load time in the browser — sourceHash ` +
    `cannot see this, it only covers native/. Fix: ${REBUILD} (the script ` +
    `resolves the pinned checkout itself).`
  );
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
    `suite never ran. Fix: ${REBUILD}.\n` +
    `The hash is over source BYTES: a COMMENT-ONLY edit under native/ lands here ` +
    `too. Finish the native/ edits first, rebuild once, and re-check with ` +
    `\`npm run check:artifact\` (this file alone) rather than a full \`npm test\`.\n` +
    `What hashes: \`node native/scripts/runtime-source-hash.mjs --files\`.`
  );
});
