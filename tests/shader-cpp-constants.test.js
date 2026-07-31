// A number written down in BOTH a shader and the renderer's C++ has to agree,
// and nothing else in the build can notice when it stops.
//
// The renderer is the one layer with no ctest and no corpus: it needs the
// Filament SDK, so it compiles on one machine configuration and every other leg
// skips it entirely. Its materials are compiled by matc from GLSL, which can
// include neither a C++ header nor anything generated from one — so where a
// constant genuinely has to exist on both sides, the ONLY thing holding the two
// copies together is a comment pointing each at the other. That is the shape
// this tree has been bitten by before (see the boost shades in CLAUDE.md: the
// renderer kept its own float copy of four coefficients, and the one shade with
// no pad beside it to keep it honest had quietly drifted to a colour that
// matched no biome at all).
//
// So: check the pair by reading both files. A pair here is a LAST RESORT, not a
// pattern to reach for — prefer passing the number in as a material parameter
// (kShadowEsmK does this) so there is only ever one of it. Add an entry only
// when that is impossible, and say in the entry WHY it is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'native', 'renderer');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAIRS = [
  {
    what: 'the grade exposure',
    // Cannot be a material parameter: the two things C++ grades for itself are
    // the SKYBOX colour and the FOG colour, and both are consumed by Filament's
    // OWN shaders (Skybox's constant colour, and the fog composite inside
    // surface_main.fs). Neither can be handed one of our uniforms.
    shader: { file: 'materials/ttp_grade.inc', re: /const float TTP_GRADE_EXPOSURE = ([\d.]+);/ },
    cpp: { file: 'src/TtpRendererImpl.h', re: /constexpr float kGradeExposure = ([\d.]+)f;/ }
  }
];

test('a constant spelled in both a shader and the C++ agrees', () => {
  for (const p of PAIRS) {
    const s = p.shader.re.exec(read(p.shader.file));
    const c = p.cpp.re.exec(read(p.cpp.file));
    assert.ok(s, `${p.what}: not found in ${p.shader.file} — did the spelling move?`);
    assert.ok(c, `${p.what}: not found in ${p.cpp.file} — did the spelling move?`);
    assert.equal(Number(s[1]), Number(c[1]),
      `${p.what} disagrees: ${p.shader.file} says ${s[1]}, ${p.cpp.file} says ${c[1]}. `
      + 'The shader half grades every scene material; the C++ half grades the skybox '
      + 'and fog colours Filament\'s own shaders consume. A split between them tilts '
      + 'those two against the whole rest of the frame.');
  }
});
