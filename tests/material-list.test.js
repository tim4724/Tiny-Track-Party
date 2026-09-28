// The material lists the shells stage are MIRRORS, and a divergence is a
// silent visual bug — never an error.
//
// The renderer treats every blob as optional-with-fallback (drop `vpresent`
// and Filament's own post chain steps in; drop `vglb`/`vglbfade` and
// ensureAssetLoader quietly keeps gltfio's PBR ubershader). So a shell whose
// list is missing one renders a complete, plausible picture that is simply
// not the game's: the tvOS shell shipped cars lit by a different shading
// model than the scene around them ("the cars are very dark"), and nothing
// anywhere said a word. Web is the reference list; every other shell must
// stage exactly the same set.
//
// A MISSING SHELL FILE IS A FAILURE, not a skip. Both shells are checked in,
// so the only way one is absent is a broken checkout — and this gate used to
// `return` on that, which is a gate that reports coverage it does not have.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function webMaterials() {
  // Terminated by the `]` that follows the LAST quoted name — never the first
  // `]` outright, which could sit inside a comment (the Kotlin list's `[^)]+`
  // body had exactly that truncation, and the gate passed on 16 of 17 names).
  const m = read('public/display/render/Display.js').match(/const MATERIALS = \[([\s\S]*?')[,\s]*\]/);
  assert.ok(m, 'Display.js MATERIALS has moved');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

// Same list, three spellings. Each shell names its own declaration and the
// quote style it writes the blobs in.
const SHELLS = [
  {
    name: 'tvOS',
    file: 'shells/tvos/TinyTrackParty/Assets/SceneStaging.swift',
    // Same terminator rule as the web list: the `]` after the last quoted
    // name, so a `]` inside a comment cannot truncate the match.
    decl: /materialNames = \[([\s\S]*?")[,\s]*\]/
  },
  {
    name: 'Android TV',
    file: 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/SceneStaging.kt',
    // Terminated by the `)` that CLOSES the call — the one on its own line —
    // never by the first `)` in the body. A `[^)]+` body stopped at the paren
    // inside a comment, so the gate silently compared a truncated list and
    // passed on it.
    decl: /MATERIAL_NAMES = listOf\(([\s\S]*?)^\s*\)/m
  }
];

for (const { name, file, decl } of SHELLS) {
  test(`the ${name} shell stages exactly the web material set`, () => {
    const m = read(file).match(decl);
    assert.ok(m, `${file}: the material list declaration has moved`);
    const staged = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    assert.deepEqual(staged.slice().sort(), webMaterials().slice().sort(),
      `${file}: the two lists must name the same blobs — a missing one falls back `
      + 'SILENTLY (vglb → PBR ubershader cars, vpresent → stock post chain, '
      + 'voverlay → no steer bar)');
  });
}
