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

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function webMaterials() {
  const src = readFileSync(path.join(ROOT, 'public/display/render/Display.js'), 'utf8');
  const m = src.match(/const MATERIALS = \[([^\]]+)\]/);
  assert.ok(m, 'Display.js MATERIALS has moved');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

test('the tvOS shell stages exactly the web material set', () => {
  const file = path.join(ROOT, 'shells/tvos/TinyTrackParty/Assets/SceneStaging.swift');
  if (!existsSync(file)) return; // a tree without the shell has nothing to check
  const src = readFileSync(file, 'utf8');
  const m = src.match(/materialNames = \[([^\]]+)\]/);
  assert.ok(m, 'SceneStaging.materialNames has moved');
  const swift = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  assert.deepEqual(swift.slice().sort(), webMaterials().slice().sort(),
    'the two lists must name the same blobs — a missing one falls back SILENTLY '
    + '(vglb → PBR ubershader cars, vpresent → stock post chain, voverlay → no steer bar)');
});
