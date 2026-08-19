// The Android bridge is GENERATED, and this is what makes that true rather than
// aspirational.
//
// `scripts/gen-jni.mjs` reads the TTP_ABI declarations out of the ABI headers
// and emits both halves of the JNI bridge — the C shim and the Kotlin object —
// from one parse. Nothing forces a regeneration after a header edit, and the
// failure mode of forgetting is the worst one available: the Kotlin object still
// declares the old signature, RegisterNatives still matches it, and the call
// marshals the wrong arguments into a live ABI. So the check is byte identity,
// on the same terms as `npm run check:artifact`.
//
// It is deliberately NOT a test that the bridge is CORRECT. What makes a
// generated signature right is that one parse produced both sides of it; what
// makes the ABI right is `abi_check` and the corpora. This only holds the
// committed files to the generator that claims to have written them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('the committed JNI bridge matches the generator', () => {
  try {
    execFileSync('node', [path.join(ROOT, 'scripts/gen-jni.mjs'), '--check'],
      { cwd: ROOT, stdio: 'pipe' });
  } catch (err) {
    assert.fail(
      `${err.stderr?.toString().trim() || err.message}\n\n` +
      'Run: node scripts/gen-jni.mjs');
  }
});
